"use strict";
/**
 * Session Orchestrator — Experiment 1 (Session Segmentation Without Proxies)
 *
 * Manages the autonomous SESSION_A → cooldown → SESSION_B → cooldown →
 * SESSION_C → cooldown → SESSION_A loop.
 * Only ONE session and ONE Chrome instance may exist at any time.
 *
 * Redis keys:
 *   session:phase               — "SESSION_A" | "SESSION_B" | "SESSION_C"
 *   session:cooldown_until      — epoch ms (number stored as string)
 *   session:consecutive_failures — integer; resets to 0 on success
 *
 * Session batches (6 centres each — stays well under VFS 30-min booking timeout):
 *   SESSION_A → centres index 0–5  (centres 1–6)
 *   SESSION_B → centres index 6–11 (centres 7–12)
 *   SESSION_C → centres index 12–17 (centres 13–18)
 *
 * Why 6 per session:
 *   6 centres × ~3.5 min avg delay = ~21 min — 9 min buffer before the
 *   VFS booking journey 30-min inactivity timeout.
 *
 * Cooldown between sessions: COOLDOWN_MS (default 10 minutes)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PHASE_CENTRE_SLICES = void 0;
exports.startOrchestrationLoop = startOrchestrationLoop;
const ioredis_1 = __importDefault(require("ioredis"));
const child_process_1 = require("child_process");
const logger_1 = require("../utils/logger");
const cdp_helpers_1 = require("../automation/cdp-helpers");
const browser_1 = require("../auth/browser");
const account_manager_1 = require("../auth/account-manager");
const telegram_notifier_1 = require("../services/telegram-notifier");
const login_flow_1 = require("../automation/login-flow");
// ---------------------------------------------------------------------------
// Timestamp helper — IST [HH:MM:SS]
// ---------------------------------------------------------------------------
function ts() {
    return new Date().toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: 'Asia/Kolkata',
    });
}
const REDIS_KEY_PHASE = 'session:phase';
const REDIS_KEY_COOLDOWN_UNTIL = 'session:cooldown_until';
const REDIS_KEY_CONSECUTIVE_FAILURES = 'session:consecutive_failures';
/** 10-minute cooldown between sessions */
const COOLDOWN_MS = parseInt(process.env.SESSION_COOLDOWN_MS ?? '600000', 10);
/**
 * Extended cooldown applied when consecutive failures reach the threshold.
 * Default: 20 minutes (double the normal cooldown).
 */
const EXTENDED_COOLDOWN_MS = parseInt(process.env.SESSION_EXTENDED_COOLDOWN_MS ?? '1200000', 10);
/** How many consecutive failures before switching to extended cooldown */
const FAILURE_THRESHOLD = 3;
/** Cooldown applied when an account is blocked (429001 Access Restricted) — 30 minutes */
const ACCOUNT_BLOCK_COOLDOWN_MS = parseInt(process.env.ACCOUNT_BLOCK_COOLDOWN_MS ?? '1800000', 10);
/** How long to wait between the first attempt and the retry (ms) */
const RETRY_DELAY_MS = 30_000; // 30 seconds
// ---------------------------------------------------------------------------
// Redis client
// ---------------------------------------------------------------------------
const redis = new ioredis_1.default(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
});
redis.on('error', (err) => {
    logger_1.logger.warn({ err: err.message }, '[Orchestrator] Redis error — session state will not persist across restarts');
});
redis.connect().catch(() => {
    // Error already logged by the 'error' event above
});
/**
 * Wait for the Redis connection to be ready before proceeding.
 * Retries up to 10 times with 300ms gaps (3s total max wait).
 * Falls through silently if Redis is unavailable — bot continues without persistence.
 */
async function waitForRedisReady() {
    for (let i = 0; i < 10; i++) {
        if (redis.status === 'ready')
            return;
        await (0, cdp_helpers_1.sleep)(300);
    }
    if (redis.status !== 'ready') {
        logger_1.logger.warn('[Orchestrator] Redis not ready after 3s — continuing without guaranteed state persistence');
    }
}
// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------
async function getPhase() {
    try {
        const raw = await redis.get(REDIS_KEY_PHASE);
        if (raw === 'SESSION_A' || raw === 'SESSION_B' || raw === 'SESSION_C')
            return raw;
    }
    catch {
        // Redis unavailable — default to SESSION_A
    }
    return 'SESSION_A';
}
async function setPhase(phase) {
    try {
        await redis.set(REDIS_KEY_PHASE, phase);
        logger_1.logger.info(`[Orchestrator] Phase persisted → ${phase}`);
    }
    catch (err) {
        logger_1.logger.warn({ err: err.message }, '[Orchestrator] Could not persist phase to Redis');
    }
}
async function getCooldownUntil() {
    try {
        const raw = await redis.get(REDIS_KEY_COOLDOWN_UNTIL);
        if (raw)
            return parseInt(raw, 10);
    }
    catch {
        // Redis unavailable
    }
    return 0;
}
async function setCooldownUntil(epochMs) {
    try {
        await redis.set(REDIS_KEY_COOLDOWN_UNTIL, String(epochMs));
    }
    catch (err) {
        logger_1.logger.warn({ err: err.message }, '[Orchestrator] Could not persist cooldown_until to Redis');
    }
}
async function getConsecutiveFailures() {
    try {
        const raw = await redis.get(REDIS_KEY_CONSECUTIVE_FAILURES);
        if (raw)
            return parseInt(raw, 10);
    }
    catch {
        // Redis unavailable
    }
    return 0;
}
async function incrementConsecutiveFailures() {
    try {
        const count = await redis.incr(REDIS_KEY_CONSECUTIVE_FAILURES);
        logger_1.logger.warn(`[Orchestrator] Consecutive failures: ${count}`);
        return count;
    }
    catch (err) {
        logger_1.logger.warn({ err: err.message }, '[Orchestrator] Could not increment failure counter');
        return 0;
    }
}
async function resetConsecutiveFailures() {
    try {
        await redis.set(REDIS_KEY_CONSECUTIVE_FAILURES, '0');
    }
    catch {
        // Non-fatal
    }
}
// ---------------------------------------------------------------------------
// Cooldown logic
// ---------------------------------------------------------------------------
/**
 * Wait out any remaining cooldown period.
 * Logs progress every 30 seconds.
 */
async function waitForCooldown() {
    const cooldownUntil = await getCooldownUntil();
    const now = Date.now();
    if (now >= cooldownUntil)
        return; // No cooldown active
    const remaining = cooldownUntil - now;
    const remainingMin = (remaining / 60000).toFixed(1);
    logger_1.logger.info('');
    logger_1.logger.info('═══════════════════════════════════════════════════════');
    logger_1.logger.info(`  [${ts()}] [Orchestrator] COOLDOWN START — ${remainingMin} min remaining`);
    logger_1.logger.info(`  [${ts()}] [Orchestrator] No browser active during cooldown`);
    logger_1.logger.info('═══════════════════════════════════════════════════════');
    const TICK_MS = 30_000; // Log every 30 seconds
    while (Date.now() < cooldownUntil) {
        const left = cooldownUntil - Date.now();
        if (left <= 0)
            break;
        const sleepFor = Math.min(TICK_MS, left);
        await (0, cdp_helpers_1.sleep)(sleepFor);
        const stillLeft = cooldownUntil - Date.now();
        if (stillLeft > 0) {
            logger_1.logger.info(`  [${ts()}] [Orchestrator] Cooldown — ${(stillLeft / 60000).toFixed(1)} min remaining...`);
        }
    }
    logger_1.logger.info(`  [${ts()}] [Orchestrator] ✓ COOLDOWN END`);
    logger_1.logger.info('═══════════════════════════════════════════════════════');
}
/**
 * Start a new cooldown period from now.
 * Uses extended cooldown if consecutive failures have reached the threshold.
 */
async function startCooldown() {
    const failures = await getConsecutiveFailures();
    const useExtended = failures >= FAILURE_THRESHOLD;
    const durationMs = useExtended ? EXTENDED_COOLDOWN_MS : COOLDOWN_MS;
    const cooldownUntil = Date.now() + durationMs;
    await setCooldownUntil(cooldownUntil);
    const endTime = new Date(cooldownUntil).toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: 'Asia/Kolkata',
    });
    logger_1.logger.info('');
    logger_1.logger.info('═══════════════════════════════════════════════════════');
    if (useExtended) {
        logger_1.logger.warn(`  [${ts()}] [Orchestrator] EXTENDED COOLDOWN — ${durationMs / 60000} min (${failures} consecutive failures)`);
    }
    else {
        logger_1.logger.info(`  [${ts()}] [Orchestrator] COOLDOWN — ${durationMs / 60000} min`);
    }
    logger_1.logger.info(`  [${ts()}] [Orchestrator] Next session launches at: ${endTime}`);
    logger_1.logger.info(`  [${ts()}] [Orchestrator] Chrome is fully shut down`);
    logger_1.logger.info('═══════════════════════════════════════════════════════');
}
/**
 * Start a fixed 30-minute cooldown specifically for account block events.
 * Independent of the normal consecutive-failure cooldown logic.
 */
async function startAccountBlockCooldown() {
    const cooldownUntil = Date.now() + ACCOUNT_BLOCK_COOLDOWN_MS;
    await setCooldownUntil(cooldownUntil);
    const endTime = new Date(cooldownUntil).toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: 'Asia/Kolkata',
    });
    logger_1.logger.warn('');
    logger_1.logger.warn('═══════════════════════════════════════════════════════');
    logger_1.logger.warn(`  [${ts()}] [Orchestrator] ACCOUNT BLOCK COOLDOWN — ${ACCOUNT_BLOCK_COOLDOWN_MS / 60000} min`);
    logger_1.logger.warn(`  [${ts()}] [Orchestrator] Next session launches at: ${endTime}`);
    logger_1.logger.warn(`  [${ts()}] [Orchestrator] Chrome is fully shut down`);
    logger_1.logger.warn('═══════════════════════════════════════════════════════');
}
// ---------------------------------------------------------------------------
// Phase transition
// ---------------------------------------------------------------------------
function nextPhase(current) {
    if (current === 'SESSION_A')
        return 'SESSION_B';
    if (current === 'SESSION_B')
        return 'SESSION_C';
    return 'SESSION_A';
}
// ---------------------------------------------------------------------------
// Startup: stale Chrome cleanup
// ---------------------------------------------------------------------------
/**
 * Kill any process still holding the CDP debug port from a previous crash.
 * Called once at startup before the first session launches.
 */
async function cleanupStaleChrome() {
    logger_1.logger.info(`[${ts()}] [Orchestrator] Checking for stale Chrome on port ${browser_1.REMOTE_DEBUG_PORT}...`);
    try {
        const output = (0, child_process_1.execSync)(`lsof -ti tcp:${browser_1.REMOTE_DEBUG_PORT} 2>/dev/null || true`, {
            encoding: 'utf8',
            timeout: 5000,
        }).trim();
        if (!output) {
            logger_1.logger.info(`[${ts()}] [Orchestrator] ✓ Port ${browser_1.REMOTE_DEBUG_PORT} is free — no stale Chrome`);
            return;
        }
        const pids = output.split('\n').filter(Boolean);
        logger_1.logger.warn(`[${ts()}] [Orchestrator] Stale process(es) on port ${browser_1.REMOTE_DEBUG_PORT}: ${pids.join(', ')} — killing`);
        for (const pid of pids) {
            try {
                (0, child_process_1.execSync)(`kill -9 ${pid} 2>/dev/null || true`, { timeout: 3000 });
                logger_1.logger.info(`[${ts()}] [Orchestrator] Killed stale PID ${pid}`);
            }
            catch {
                // Already gone
            }
        }
        await (0, cdp_helpers_1.sleep)(1500);
        logger_1.logger.info(`[${ts()}] [Orchestrator] ✓ Stale Chrome cleanup complete`);
    }
    catch {
        logger_1.logger.info(`[${ts()}] [Orchestrator] Could not check for stale Chrome (lsof unavailable) — continuing`);
    }
}
// ---------------------------------------------------------------------------
// Session runner with retry
// ---------------------------------------------------------------------------
/**
 * Run a session with one automatic retry on failure.
 *
 * Attempt 1: run session
 *   → success: reset failure counter, return
 *   → failure: log error, wait RETRY_DELAY_MS, attempt 2
 * Attempt 2: run session
 *   → success: reset failure counter, return
 *   → failure: increment failure counter, throw (caller handles cooldown)
 *
 * Between attempts, stale Chrome is cleaned up so the retry starts fresh.
 */
async function runSessionWithRetry(phase, slice, runSession) {
    // Attempt 1
    try {
        logger_1.logger.info(`[${ts()}] [Orchestrator] ${phase} — attempt 1`);
        await runSession(phase, slice);
        await resetConsecutiveFailures();
        logger_1.logger.info(`[${ts()}] [Orchestrator] ${phase} — attempt 1 succeeded`);
        return;
    }
    catch (err) {
        // Account blocked — no retry, rotate immediately and hand off to caller
        if (err instanceof login_flow_1.AccountBlockedError) {
            logger_1.logger.warn(`[${ts()}] [Orchestrator] ${phase} — account blocked (429001), skipping retry`);
            throw err;
        }
        // OTP timeout — no retry, rotate and hand off to caller
        if (err instanceof login_flow_1.OtpTimeoutError) {
            logger_1.logger.warn(`[${ts()}] [Orchestrator] ${phase} — OTP timeout, skipping retry`);
            throw err;
        }
        // Unauthorised activity — no retry, rotate and hand off to caller
        if (err instanceof login_flow_1.UnauthorisedActivityError) {
            logger_1.logger.warn(`[${ts()}] [Orchestrator] ${phase} — unauthorised activity (429002), skipping retry`);
            throw err;
        }
        logger_1.logger.error({ err: err.message }, `[${ts()}] [Orchestrator] ${phase} attempt 1 FAILED — waiting ${RETRY_DELAY_MS / 1000}s then retrying`);
    }
    // Clean up any Chrome remnants before retry
    await cleanupStaleChrome();
    logger_1.logger.info(`[${ts()}] [Orchestrator] Retry delay: ${RETRY_DELAY_MS / 1000}s...`);
    await (0, cdp_helpers_1.sleep)(RETRY_DELAY_MS);
    // Attempt 2
    try {
        logger_1.logger.info(`[${ts()}] [Orchestrator] ${phase} — attempt 2 (retry)`);
        await runSession(phase, slice);
        await resetConsecutiveFailures();
        logger_1.logger.info(`[${ts()}] [Orchestrator] ${phase} — attempt 2 succeeded`);
        return;
    }
    catch (err) {
        // Account blocked on retry too — rotate and hand off
        if (err instanceof login_flow_1.AccountBlockedError) {
            logger_1.logger.warn(`[${ts()}] [Orchestrator] ${phase} — account blocked (429001) on retry`);
            throw err;
        }
        // OTP timeout on retry — rotate and hand off
        if (err instanceof login_flow_1.OtpTimeoutError) {
            logger_1.logger.warn(`[${ts()}] [Orchestrator] ${phase} — OTP timeout on retry`);
            throw err;
        }
        // Unauthorised activity on retry — rotate and hand off
        if (err instanceof login_flow_1.UnauthorisedActivityError) {
            logger_1.logger.warn(`[${ts()}] [Orchestrator] ${phase} — unauthorised activity (429002) on retry`);
            throw err;
        }
        const failures = await incrementConsecutiveFailures();
        logger_1.logger.error({ err: err.message, consecutiveFailures: failures }, `[${ts()}] [Orchestrator] ${phase} attempt 2 FAILED — proceeding to cooldown`);
        throw err;
    }
}
// ---------------------------------------------------------------------------
// Process-level safety net
// ---------------------------------------------------------------------------
/**
 * Register handlers for uncaught exceptions and unhandled promise rejections.
 * These should never fire in normal operation — they are a last-resort guard
 * to ensure the process logs the error and does NOT silently die.
 *
 * We do NOT call process.exit() here — the orchestration loop's own
 * try/catch will handle recovery. Exiting would require a manual restart.
 */
function installProcessSafetyNet() {
    process.on('uncaughtException', (err) => {
        logger_1.logger.error({ err: err.message, stack: err.stack }, `[${ts()}] [Orchestrator] UNCAUGHT EXCEPTION — loop will attempt to continue`);
    });
    process.on('unhandledRejection', (reason) => {
        const msg = reason instanceof Error ? reason.message : String(reason);
        logger_1.logger.error({ reason: msg }, `[${ts()}] [Orchestrator] UNHANDLED REJECTION — loop will attempt to continue`);
    });
}
/**
 * Centre index slices for each phase (6 centres each).
 * SESSION_A: centres 1–6   (index 0–5)
 * SESSION_B: centres 7–12  (index 6–11)
 * SESSION_C: centres 13–18 (index 12–17)
 *
 * 6 per session keeps total booking page time ~21 min,
 * safely under VFS's 30-min inactivity timeout.
 */
exports.PHASE_CENTRE_SLICES = {
    SESSION_A: [0, 6],
    SESSION_B: [6, 12],
    SESSION_C: [12, 18],
};
/**
 * Start the autonomous orchestration loop.
 * Runs forever: SESSION_A → cooldown → SESSION_B → cooldown → SESSION_C → cooldown → SESSION_A → ...
 *
 * Recovery behaviour:
 *   - Startup: kills any stale Chrome on port 9223 from a previous crash
 *   - Startup: resumes any in-progress cooldown from Redis
 *   - Startup: reads last persisted phase from Redis
 *   - Per session: one automatic retry before accepting failure
 *   - Per failure: increments consecutive failure counter
 *   - After 3+ consecutive failures: switches to extended (20 min) cooldown
 *   - Process level: uncaughtException / unhandledRejection never kill the loop
 */
async function startOrchestrationLoop(callbacks) {
    logger_1.logger.info('');
    logger_1.logger.info('╔═══════════════════════════════════════════════════════╗');
    logger_1.logger.info('║  Campus Slot Notifier — Session Orchestrator          ║');
    logger_1.logger.info('║  Experiment 1: Session Segmentation (No Proxies)      ║');
    logger_1.logger.info('╚═══════════════════════════════════════════════════════╝');
    logger_1.logger.info('');
    // Install process-level safety net (never silently die)
    installProcessSafetyNet();
    // Wait for Redis to be ready before reading persisted state
    await waitForRedisReady();
    logger_1.logger.info(`[${ts()}] [Orchestrator] Redis status: ${redis.status}`);
    // Kill any stale Chrome from a previous crash
    await cleanupStaleChrome();
    // Resume any in-progress cooldown
    await waitForCooldown();
    // Read persisted phase (crash recovery)
    let phase = await getPhase();
    const failures = await getConsecutiveFailures();
    const rotationStatus = await (0, account_manager_1.getRotationStatus)();
    logger_1.logger.info(`[${ts()}] [Orchestrator] Resuming — phase: ${phase} | consecutive failures: ${failures}`);
    logger_1.logger.info(`[${ts()}] [Orchestrator] Account status — ${rotationStatus.currentEmail} (Account ${rotationStatus.currentAccountIndex + 1}) | sweep: ${rotationStatus.sweepProgress}`);
    let cycleCount = 0;
    while (true) {
        cycleCount++;
        const slice = exports.PHASE_CENTRE_SLICES[phase];
        const centreRange = `centres ${slice[0] + 1}–${slice[1]}`;
        logger_1.logger.info('');
        logger_1.logger.info('╔═══════════════════════════════════════════════════════╗');
        logger_1.logger.info(`║  [${ts()}] Cycle #${String(cycleCount).padEnd(3)} — ${phase} (${centreRange})`);
        logger_1.logger.info('╚═══════════════════════════════════════════════════════╝');
        // Persist phase before running (crash recovery: we know what was running)
        await setPhase(phase);
        let sessionSucceeded = false;
        try {
            await runSessionWithRetry(phase, slice, callbacks.runSession);
            sessionSucceeded = true;
            logger_1.logger.info(`[${ts()}] [Orchestrator] ✓ ${phase} completed (cycle #${cycleCount})`);
            // Check if we should rotate accounts after this session
            const rotated = await (0, account_manager_1.incrementSessionAndCheckRotation)();
            if (rotated) {
                logger_1.logger.info(`[${ts()}] [Orchestrator] Account rotation triggered — next session will use new account`);
            }
        }
        catch (err) {
            // ── Account blocked (429001) ─────────────────────────────────────────
            if (err instanceof login_flow_1.AccountBlockedError) {
                const blockedEmail = err.message.replace('ACCOUNT_BLOCKED_429001: ', '');
                logger_1.logger.warn(`[${ts()}] [Orchestrator] Account blocked — force-rotating and entering 30-min cooldown`);
                const nextEmail = await (0, account_manager_1.forceRotateOnBlock)(blockedEmail);
                // Notify owner via personal DM
                (0, telegram_notifier_1.notifyOwnerAccountBlocked)(blockedEmail, nextEmail, ACCOUNT_BLOCK_COOLDOWN_MS / 60000).catch((e) => {
                    logger_1.logger.warn({ err: e.message }, '[Orchestrator] Owner DM failed — non-fatal');
                });
                // Transition phase normally (continue from current phase with new account)
                const next = nextPhase(phase);
                await setPhase(next);
                logger_1.logger.info(`[${ts()}] [Orchestrator] PHASE TRANSITION: ${phase} → ${next}`);
                // Enter 30-min account-block cooldown
                await startAccountBlockCooldown();
                await waitForCooldown();
                logger_1.logger.info(`[${ts()}] [Orchestrator] NEXT SESSION LAUNCH — ${next} (new account)`);
                phase = next;
                continue;
            }
            // ── OTP timeout ───────────────────────────────────────────────────────
            if (err instanceof login_flow_1.OtpTimeoutError) {
                const timedOutEmail = err.message.replace('OTP_TIMEOUT: ', '');
                logger_1.logger.warn(`[${ts()}] [Orchestrator] OTP timeout — force-rotating and entering 30-min cooldown`);
                const nextEmail = await (0, account_manager_1.forceRotateOnBlock)(timedOutEmail);
                // Notify owner via personal DM
                (0, telegram_notifier_1.notifyOwnerOtpTimeout)(timedOutEmail, nextEmail, ACCOUNT_BLOCK_COOLDOWN_MS / 60000).catch((e) => {
                    logger_1.logger.warn({ err: e.message }, '[Orchestrator] Owner DM failed — non-fatal');
                });
                // Transition phase normally
                const next = nextPhase(phase);
                await setPhase(next);
                logger_1.logger.info(`[${ts()}] [Orchestrator] PHASE TRANSITION: ${phase} → ${next}`);
                // Enter 30-min cooldown (same as account block)
                await startAccountBlockCooldown();
                await waitForCooldown();
                logger_1.logger.info(`[${ts()}] [Orchestrator] NEXT SESSION LAUNCH — ${next} (new account)`);
                phase = next;
                continue;
            }
            // ── Unauthorised activity (429002) ────────────────────────────────────
            if (err instanceof login_flow_1.UnauthorisedActivityError) {
                const blockedEmail = err.message.replace('UNAUTHORISED_ACTIVITY_429002: ', '');
                logger_1.logger.warn(`[${ts()}] [Orchestrator] Unauthorised activity (429002) — force-rotating and entering 30-min cooldown`);
                const nextEmail = await (0, account_manager_1.forceRotateOnBlock)(blockedEmail);
                // Notify owner via personal DM
                (0, telegram_notifier_1.notifyOwnerUnauthorisedActivity)(blockedEmail, nextEmail, ACCOUNT_BLOCK_COOLDOWN_MS / 60000).catch((e) => {
                    logger_1.logger.warn({ err: e.message }, '[Orchestrator] Owner DM failed — non-fatal');
                });
                // Transition phase normally
                const next = nextPhase(phase);
                await setPhase(next);
                logger_1.logger.info(`[${ts()}] [Orchestrator] PHASE TRANSITION: ${phase} → ${next}`);
                // Enter 30-min cooldown
                await startAccountBlockCooldown();
                await waitForCooldown();
                logger_1.logger.info(`[${ts()}] [Orchestrator] NEXT SESSION LAUNCH — ${next} (new account)`);
                phase = next;
                continue;
            }
            // ── Normal failure ────────────────────────────────────────────────────
            logger_1.logger.error({ err: err.message, cycle: cycleCount }, `[${ts()}] [Orchestrator] ${phase} failed after retry — entering cooldown`);
        }
        // Transition to next phase
        const next = nextPhase(phase);
        await setPhase(next);
        logger_1.logger.info(`[${ts()}] [Orchestrator] PHASE TRANSITION: ${phase} → ${next}`);
        if (sessionSucceeded) {
            logger_1.logger.info(`[${ts()}] [Orchestrator] Cycle #${cycleCount} success → normal cooldown`);
        }
        else {
            logger_1.logger.warn(`[${ts()}] [Orchestrator] Cycle #${cycleCount} failure → cooldown (may be extended)`);
        }
        // Start cooldown (extended if too many consecutive failures)
        await startCooldown();
        await waitForCooldown();
        logger_1.logger.info(`[${ts()}] [Orchestrator] NEXT SESSION LAUNCH — ${next}`);
        phase = next;
    }
}
//# sourceMappingURL=session-orchestrator.js.map