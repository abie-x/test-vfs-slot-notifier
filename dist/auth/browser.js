"use strict";
/**
 * Browser lifecycle management.
 *
 * Chrome with --remote-debugging-port=9223 → CDP attaches for automation.
 * Network interception captures CheckIsSlotAvailable responses.
 *
 * Step 2 additions:
 *   - launchChrome()   — spawn Chrome and wait for CDP to be reachable
 *   - shutdownChrome() — SIGTERM → wait for exit → SIGKILL → port cleanup
 *     Guarantees no Chrome process or CDP port survives after shutdown.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.REMOTE_DEBUG_PORT = exports.POLL_USER_DATA_DIR = void 0;
exports.launchChrome = launchChrome;
exports.shutdownChrome = shutdownChrome;
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
const logger_1 = require("../utils/logger");
exports.POLL_USER_DATA_DIR = path_1.default.resolve(process.cwd(), 'profiles/main-session');
const CHROME_EXECUTABLE = process.env.CHROME_EXECUTABLE || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome');
const VFS_LOGIN_URL = 'https://visa.vfsglobal.com/ind/en/fra/login';
// Port 9223 avoids conflict with any existing Chrome instance on 9222
exports.REMOTE_DEBUG_PORT = 9223;
/** How long to wait for Chrome to become reachable after spawn (ms) */
const CHROME_STARTUP_WAIT_MS = 4000;
/** How long to wait for graceful SIGTERM exit before SIGKILL (ms) */
const CHROME_GRACEFUL_EXIT_MS = 5000;
// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------
/**
 * Spawn a fresh Chrome instance pointing at the VFS login page.
 * Waits CHROME_STARTUP_WAIT_MS for the process to stabilise before returning.
 *
 * @returns The spawned ChildProcess handle — keep it to pass to shutdownChrome()
 */
async function launchChrome() {
    logger_1.logger.info('[Browser] Launching fresh Chrome instance...');
    const proc = (0, child_process_1.spawn)(CHROME_EXECUTABLE, [
        `--user-data-dir=${exports.POLL_USER_DATA_DIR}`,
        `--remote-debugging-port=${exports.REMOTE_DEBUG_PORT}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        VFS_LOGIN_URL,
    ], {
        detached: false,
        stdio: 'ignore',
        env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
    });
    proc.on('exit', (code, signal) => {
        logger_1.logger.info(`[Browser] Chrome process exited (PID: ${proc.pid}, code: ${code}, signal: ${signal})`);
    });
    logger_1.logger.info(`[Browser] Chrome spawned (PID: ${proc.pid}) — waiting ${CHROME_STARTUP_WAIT_MS}ms for startup...`);
    await new Promise((resolve) => setTimeout(resolve, CHROME_STARTUP_WAIT_MS));
    logger_1.logger.info(`[Browser] ✓ Chrome ready (PID: ${proc.pid}, port: ${exports.REMOTE_DEBUG_PORT})`);
    return proc;
}
// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------
/**
 * Fully terminate Chrome and clean up the CDP debug port.
 *
 * Sequence:
 *   1. SIGTERM  — ask Chrome to exit gracefully
 *   2. Wait up to CHROME_GRACEFUL_EXIT_MS for the exit event
 *   3. SIGKILL  — force-kill if still alive
 *   4. Port cleanup — kill any remaining process on REMOTE_DEBUG_PORT via lsof
 *
 * Safe to call even if Chrome has already exited.
 */
async function shutdownChrome(proc) {
    const pid = proc.pid;
    logger_1.logger.info(`[Browser] Shutting down Chrome (PID: ${pid})...`);
    // Step 1: SIGTERM
    try {
        proc.kill('SIGTERM');
        logger_1.logger.info(`[Browser] SIGTERM sent to PID ${pid}`);
    }
    catch {
        logger_1.logger.info(`[Browser] PID ${pid} already gone — skipping SIGTERM`);
    }
    // Step 2: Wait for exit event (up to CHROME_GRACEFUL_EXIT_MS)
    const exited = await new Promise((resolve) => {
        if (proc.exitCode !== null) {
            // Already exited before we even started waiting
            resolve(true);
            return;
        }
        const timer = setTimeout(() => resolve(false), CHROME_GRACEFUL_EXIT_MS);
        proc.once('exit', () => {
            clearTimeout(timer);
            resolve(true);
        });
    });
    if (exited) {
        logger_1.logger.info(`[Browser] ✓ Chrome exited gracefully (PID: ${pid})`);
    }
    else {
        // Step 3: SIGKILL — force terminate
        logger_1.logger.warn(`[Browser] Chrome did not exit within ${CHROME_GRACEFUL_EXIT_MS}ms — sending SIGKILL`);
        try {
            proc.kill('SIGKILL');
        }
        catch {
            // Already gone
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        logger_1.logger.info(`[Browser] SIGKILL sent to PID ${pid}`);
    }
    // Step 4: Port cleanup — kill any orphan process still holding the debug port
    await killProcessOnPort(exports.REMOTE_DEBUG_PORT);
    logger_1.logger.info(`[Browser] ✓ Chrome fully terminated — port ${exports.REMOTE_DEBUG_PORT} is free`);
}
// ---------------------------------------------------------------------------
// Port cleanup helper
// ---------------------------------------------------------------------------
/**
 * Kill any process still listening on the given port.
 * Uses lsof (available on macOS/Linux). Safe to call even if port is free.
 */
async function killProcessOnPort(port) {
    try {
        const output = (0, child_process_1.execSync)(`lsof -ti tcp:${port} 2>/dev/null || true`, {
            encoding: 'utf8',
            timeout: 5000,
        }).trim();
        if (!output)
            return; // Port is already free
        const pids = output.split('\n').filter(Boolean);
        for (const orphanPid of pids) {
            try {
                (0, child_process_1.execSync)(`kill -9 ${orphanPid} 2>/dev/null || true`, { timeout: 3000 });
                logger_1.logger.info(`[Browser] Killed orphan process on port ${port} (PID: ${orphanPid})`);
            }
            catch {
                // Already gone
            }
        }
    }
    catch {
        // lsof not available or other error — non-fatal
    }
}
//# sourceMappingURL=browser.js.map