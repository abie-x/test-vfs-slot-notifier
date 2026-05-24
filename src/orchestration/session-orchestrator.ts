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

import Redis from 'ioredis';
import { execSync } from 'child_process';
import { logger } from '../utils/logger';
import { sleep } from '../automation/cdp-helpers';
import { REMOTE_DEBUG_PORT } from '../auth/browser';

// ---------------------------------------------------------------------------
// Timestamp helper — IST [HH:MM:SS]
// ---------------------------------------------------------------------------
function ts(): string {
  return new Date().toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Asia/Kolkata',
  });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export type SessionPhase = 'SESSION_A' | 'SESSION_B' | 'SESSION_C';

const REDIS_KEY_PHASE               = 'session:phase';
const REDIS_KEY_COOLDOWN_UNTIL      = 'session:cooldown_until';
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

/** How long to wait between the first attempt and the retry (ms) */
const RETRY_DELAY_MS = 30_000; // 30 seconds

// ---------------------------------------------------------------------------
// Redis client
// ---------------------------------------------------------------------------

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});

redis.on('error', (err) => {
  logger.warn({ err: err.message }, '[Orchestrator] Redis error — session state will not persist across restarts');
});

redis.connect().catch(() => {
  // Error already logged by the 'error' event above
});

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

async function getPhase(): Promise<SessionPhase> {
  try {
    const raw = await redis.get(REDIS_KEY_PHASE);
    if (raw === 'SESSION_A' || raw === 'SESSION_B' || raw === 'SESSION_C') return raw;
  } catch {
    // Redis unavailable — default to SESSION_A
  }
  return 'SESSION_A';
}

async function setPhase(phase: SessionPhase): Promise<void> {
  try {
    await redis.set(REDIS_KEY_PHASE, phase);
    logger.info(`[Orchestrator] Phase persisted → ${phase}`);
  } catch (err: any) {
    logger.warn({ err: err.message }, '[Orchestrator] Could not persist phase to Redis');
  }
}

async function getCooldownUntil(): Promise<number> {
  try {
    const raw = await redis.get(REDIS_KEY_COOLDOWN_UNTIL);
    if (raw) return parseInt(raw, 10);
  } catch {
    // Redis unavailable
  }
  return 0;
}

async function setCooldownUntil(epochMs: number): Promise<void> {
  try {
    await redis.set(REDIS_KEY_COOLDOWN_UNTIL, String(epochMs));
  } catch (err: any) {
    logger.warn({ err: err.message }, '[Orchestrator] Could not persist cooldown_until to Redis');
  }
}

async function getConsecutiveFailures(): Promise<number> {
  try {
    const raw = await redis.get(REDIS_KEY_CONSECUTIVE_FAILURES);
    if (raw) return parseInt(raw, 10);
  } catch {
    // Redis unavailable
  }
  return 0;
}

async function incrementConsecutiveFailures(): Promise<number> {
  try {
    const count = await redis.incr(REDIS_KEY_CONSECUTIVE_FAILURES);
    logger.warn(`[Orchestrator] Consecutive failures: ${count}`);
    return count;
  } catch (err: any) {
    logger.warn({ err: err.message }, '[Orchestrator] Could not increment failure counter');
    return 0;
  }
}

async function resetConsecutiveFailures(): Promise<void> {
  try {
    await redis.set(REDIS_KEY_CONSECUTIVE_FAILURES, '0');
  } catch {
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
async function waitForCooldown(): Promise<void> {
  const cooldownUntil = await getCooldownUntil();
  const now = Date.now();

  if (now >= cooldownUntil) return; // No cooldown active

  const remaining = cooldownUntil - now;
  const remainingMin = (remaining / 60000).toFixed(1);

  logger.info('');
  logger.info('═══════════════════════════════════════════════════════');
  logger.info(`  [${ts()}] [Orchestrator] COOLDOWN START — ${remainingMin} min remaining`);
  logger.info(`  [${ts()}] [Orchestrator] No browser active during cooldown`);
  logger.info('═══════════════════════════════════════════════════════');

  const TICK_MS = 30_000; // Log every 30 seconds

  while (Date.now() < cooldownUntil) {
    const left = cooldownUntil - Date.now();
    if (left <= 0) break;

    const sleepFor = Math.min(TICK_MS, left);
    await sleep(sleepFor);

    const stillLeft = cooldownUntil - Date.now();
    if (stillLeft > 0) {
      logger.info(`  [${ts()}] [Orchestrator] Cooldown — ${(stillLeft / 60000).toFixed(1)} min remaining...`);
    }
  }

  logger.info(`  [${ts()}] [Orchestrator] ✓ COOLDOWN END`);
  logger.info('═══════════════════════════════════════════════════════');
}

/**
 * Start a new cooldown period from now.
 * Uses extended cooldown if consecutive failures have reached the threshold.
 */
async function startCooldown(): Promise<void> {
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

  logger.info('');
  logger.info('═══════════════════════════════════════════════════════');
  if (useExtended) {
    logger.warn(`  [${ts()}] [Orchestrator] EXTENDED COOLDOWN — ${durationMs / 60000} min (${failures} consecutive failures)`);
  } else {
    logger.info(`  [${ts()}] [Orchestrator] COOLDOWN — ${durationMs / 60000} min`);
  }
  logger.info(`  [${ts()}] [Orchestrator] Next session launches at: ${endTime}`);
  logger.info(`  [${ts()}] [Orchestrator] Chrome is fully shut down`);
  logger.info('═══════════════════════════════════════════════════════');
}

// ---------------------------------------------------------------------------
// Phase transition
// ---------------------------------------------------------------------------

function nextPhase(current: SessionPhase): SessionPhase {
  if (current === 'SESSION_A') return 'SESSION_B';
  if (current === 'SESSION_B') return 'SESSION_C';
  return 'SESSION_A';
}

// ---------------------------------------------------------------------------
// Startup: stale Chrome cleanup
// ---------------------------------------------------------------------------

/**
 * Kill any process still holding the CDP debug port from a previous crash.
 * Called once at startup before the first session launches.
 */
async function cleanupStaleChrome(): Promise<void> {
  logger.info(`[${ts()}] [Orchestrator] Checking for stale Chrome on port ${REMOTE_DEBUG_PORT}...`);
  try {
    const output = execSync(`lsof -ti tcp:${REMOTE_DEBUG_PORT} 2>/dev/null || true`, {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();

    if (!output) {
      logger.info(`[${ts()}] [Orchestrator] ✓ Port ${REMOTE_DEBUG_PORT} is free — no stale Chrome`);
      return;
    }

    const pids = output.split('\n').filter(Boolean);
    logger.warn(`[${ts()}] [Orchestrator] Stale process(es) on port ${REMOTE_DEBUG_PORT}: ${pids.join(', ')} — killing`);

    for (const pid of pids) {
      try {
        execSync(`kill -9 ${pid} 2>/dev/null || true`, { timeout: 3000 });
        logger.info(`[${ts()}] [Orchestrator] Killed stale PID ${pid}`);
      } catch {
        // Already gone
      }
    }

    await sleep(1500);
    logger.info(`[${ts()}] [Orchestrator] ✓ Stale Chrome cleanup complete`);
  } catch {
    logger.info(`[${ts()}] [Orchestrator] Could not check for stale Chrome (lsof unavailable) — continuing`);
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
async function runSessionWithRetry(
  phase: SessionPhase,
  slice: [number, number],
  runSession: (phase: SessionPhase, centreSlice: [number, number]) => Promise<void>
): Promise<void> {
  // Attempt 1
  try {
    logger.info(`[${ts()}] [Orchestrator] ${phase} — attempt 1`);
    await runSession(phase, slice);
    await resetConsecutiveFailures();
    logger.info(`[${ts()}] [Orchestrator] ${phase} — attempt 1 succeeded`);
    return;
  } catch (err: any) {
    logger.error(
      { err: err.message },
      `[${ts()}] [Orchestrator] ${phase} attempt 1 FAILED — waiting ${RETRY_DELAY_MS / 1000}s then retrying`
    );
  }

  // Clean up any Chrome remnants before retry
  await cleanupStaleChrome();
  logger.info(`[${ts()}] [Orchestrator] Retry delay: ${RETRY_DELAY_MS / 1000}s...`);
  await sleep(RETRY_DELAY_MS);

  // Attempt 2
  try {
    logger.info(`[${ts()}] [Orchestrator] ${phase} — attempt 2 (retry)`);
    await runSession(phase, slice);
    await resetConsecutiveFailures();
    logger.info(`[${ts()}] [Orchestrator] ${phase} — attempt 2 succeeded`);
    return;
  } catch (err: any) {
    const failures = await incrementConsecutiveFailures();
    logger.error(
      { err: err.message, consecutiveFailures: failures },
      `[${ts()}] [Orchestrator] ${phase} attempt 2 FAILED — proceeding to cooldown`
    );
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
function installProcessSafetyNet(): void {
  process.on('uncaughtException', (err) => {
    logger.error(
      { err: err.message, stack: err.stack },
      `[${ts()}] [Orchestrator] UNCAUGHT EXCEPTION — loop will attempt to continue`
    );
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logger.error({ reason: msg }, `[${ts()}] [Orchestrator] UNHANDLED REJECTION — loop will attempt to continue`);
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface OrchestratorCallbacks {
  /**
   * Called once per session cycle with the phase and centre slice to poll.
   * The callback is responsible for launching Chrome, logging in, polling,
   * and fully shutting down Chrome before returning.
   *
   * @param phase       Current session phase
   * @param centreSlice Indices [start, end) into the CENTRES array
   */
  runSession: (phase: SessionPhase, centreSlice: [number, number]) => Promise<void>;
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
export const PHASE_CENTRE_SLICES: Record<SessionPhase, [number, number]> = {
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
export async function startOrchestrationLoop(callbacks: OrchestratorCallbacks): Promise<void> {
  logger.info('');
  logger.info('╔═══════════════════════════════════════════════════════╗');
  logger.info('║  Campus Slot Notifier — Session Orchestrator          ║');
  logger.info('║  Experiment 1: Session Segmentation (No Proxies)      ║');
  logger.info('╚═══════════════════════════════════════════════════════╝');
  logger.info('');

  // Install process-level safety net (never silently die)
  installProcessSafetyNet();

  // Kill any stale Chrome from a previous crash
  await cleanupStaleChrome();

  // Resume any in-progress cooldown
  await waitForCooldown();

  // Read persisted phase (crash recovery)
  let phase = await getPhase();
  const failures = await getConsecutiveFailures();
  logger.info(`[${ts()}] [Orchestrator] Resuming — phase: ${phase} | consecutive failures: ${failures}`);

  let cycleCount = 0;

  while (true) {
    cycleCount++;
    const slice = PHASE_CENTRE_SLICES[phase];
    const centreRange = `centres ${slice[0] + 1}–${slice[1]}`;

    logger.info('');
    logger.info('╔═══════════════════════════════════════════════════════╗');
    logger.info(`║  [${ts()}] Cycle #${String(cycleCount).padEnd(3)} — ${phase} (${centreRange})`);
    logger.info('╚═══════════════════════════════════════════════════════╝');

    // Persist phase before running (crash recovery: we know what was running)
    await setPhase(phase);

    let sessionSucceeded = false;

    try {
      await runSessionWithRetry(phase, slice, callbacks.runSession);
      sessionSucceeded = true;
      logger.info(`[${ts()}] [Orchestrator] ✓ ${phase} completed (cycle #${cycleCount})`);
    } catch (err: any) {
      logger.error(
        { err: err.message, cycle: cycleCount },
        `[${ts()}] [Orchestrator] ${phase} failed after retry — entering cooldown`
      );
    }

    // Transition to next phase
    const next = nextPhase(phase);
    await setPhase(next);
    logger.info(`[${ts()}] [Orchestrator] PHASE TRANSITION: ${phase} → ${next}`);

    if (sessionSucceeded) {
      logger.info(`[${ts()}] [Orchestrator] Cycle #${cycleCount} success → normal cooldown`);
    } else {
      logger.warn(`[${ts()}] [Orchestrator] Cycle #${cycleCount} failure → cooldown (may be extended)`);
    }

    // Start cooldown (extended if too many consecutive failures)
    await startCooldown();
    await waitForCooldown();

    logger.info(`[${ts()}] [Orchestrator] NEXT SESSION LAUNCH — ${next}`);
    phase = next;
  }
}
