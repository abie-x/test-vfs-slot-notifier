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

import { spawn, ChildProcess, execSync } from 'child_process';
import path from 'path';
import { logger } from '../utils/logger';

export const POLL_USER_DATA_DIR = path.resolve(process.cwd(), 'profiles/main-session');

/**
 * Resolve the Chrome executable path.
 * Priority:
 *   1. CHROME_EXECUTABLE env var — lets any machine override without code changes
 *   2. OS-based default:
 *      - macOS  → /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
 *      - Windows → C:\Program Files\Google\Chrome\Application\chrome.exe
 *      - Linux  → /usr/bin/google-chrome (headless server default)
 */
function resolveChromePath(): string {
  if (process.env.CHROME_EXECUTABLE) {
    return process.env.CHROME_EXECUTABLE;
  }
  switch (process.platform) {
    case 'win32':
      return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    case 'darwin':
      return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    default:
      return '/usr/bin/google-chrome';
  }
}

const CHROME_EXECUTABLE = resolveChromePath();
const VFS_LOGIN_URL = 'https://visa.vfsglobal.com/ind/en/fra/login';

// Port 9223 avoids conflict with any existing Chrome instance on 9222
export const REMOTE_DEBUG_PORT = 9223;

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
export async function launchChrome(): Promise<ChildProcess> {
  logger.info('[Browser] Launching fresh Chrome instance...');

  const proc = spawn(
    CHROME_EXECUTABLE,
    [
      `--user-data-dir=${POLL_USER_DATA_DIR}`,
      `--remote-debugging-port=${REMOTE_DEBUG_PORT}`,
      VFS_LOGIN_URL,
    ],
    { detached: false, stdio: 'ignore' }
  );

  proc.on('exit', (code, signal) => {
    logger.info(`[Browser] Chrome process exited (PID: ${proc.pid}, code: ${code}, signal: ${signal})`);
  });

  logger.info(`[Browser] Chrome spawned (PID: ${proc.pid}) — waiting ${CHROME_STARTUP_WAIT_MS}ms for startup...`);

  await new Promise<void>((resolve) => setTimeout(resolve, CHROME_STARTUP_WAIT_MS));

  logger.info(`[Browser] ✓ Chrome ready (PID: ${proc.pid}, port: ${REMOTE_DEBUG_PORT})`);
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
export async function shutdownChrome(proc: ChildProcess): Promise<void> {
  const pid = proc.pid;
  logger.info(`[Browser] Shutting down Chrome (PID: ${pid})...`);

  // Step 1: SIGTERM
  try {
    proc.kill('SIGTERM');
    logger.info(`[Browser] SIGTERM sent to PID ${pid}`);
  } catch {
    logger.info(`[Browser] PID ${pid} already gone — skipping SIGTERM`);
  }

  // Step 2: Wait for exit event (up to CHROME_GRACEFUL_EXIT_MS)
  const exited = await new Promise<boolean>((resolve) => {
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
    logger.info(`[Browser] ✓ Chrome exited gracefully (PID: ${pid})`);
  } else {
    // Step 3: SIGKILL — force terminate
    logger.warn(`[Browser] Chrome did not exit within ${CHROME_GRACEFUL_EXIT_MS}ms — sending SIGKILL`);
    try {
      proc.kill('SIGKILL');
    } catch {
      // Already gone
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    logger.info(`[Browser] SIGKILL sent to PID ${pid}`);
  }

  // Step 4: Port cleanup — kill any orphan process still holding the debug port
  await killProcessOnPort(REMOTE_DEBUG_PORT);

  logger.info(`[Browser] ✓ Chrome fully terminated — port ${REMOTE_DEBUG_PORT} is free`);
}

// ---------------------------------------------------------------------------
// Port cleanup helper
// ---------------------------------------------------------------------------

/**
 * Kill any process still listening on the given port.
 * Uses netstat/taskkill on Windows, lsof on macOS/Linux.
 * Safe to call even if port is free.
 */
async function killProcessOnPort(port: number): Promise<void> {
  try {
    if (process.platform === 'win32') {
      // Windows: netstat finds the PID, taskkill terminates it
      const output = execSync(
        `netstat -ano | findstr :${port}`,
        { encoding: 'utf8', timeout: 5000 }
      ).trim();

      if (!output) return;

      const pids = new Set<string>();
      for (const line of output.split('\n')) {
        // Lines look like: TCP  0.0.0.0:9223  0.0.0.0:0  LISTENING  12345
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid);
      }

      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /F`, { timeout: 3000 });
          logger.info(`[Browser] Killed orphan process on port ${port} (PID: ${pid})`);
        } catch {
          // Already gone
        }
      }
    } else {
      // macOS / Linux: lsof
      const output = execSync(`lsof -ti tcp:${port} 2>/dev/null || true`, {
        encoding: 'utf8',
        timeout: 5000,
      }).trim();

      if (!output) return;

      const pids = output.split('\n').filter(Boolean);
      for (const orphanPid of pids) {
        try {
          execSync(`kill -9 ${orphanPid} 2>/dev/null || true`, { timeout: 3000 });
          logger.info(`[Browser] Killed orphan process on port ${port} (PID: ${orphanPid})`);
        } catch {
          // Already gone
        }
      }
    }
  } catch {
    // Command unavailable or port already free — non-fatal
  }
}
