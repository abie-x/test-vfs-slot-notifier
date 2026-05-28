/**
 * Slot Change Detector
 *
 * Persists per-centre slot state in Redis so that state survives
 * process crashes and restarts. On restart, Round 1 immediately
 * compares against the last known state rather than treating every
 * centre as "first seen".
 *
 * Redis key format: slots:FRA:{centreName}
 * Example:          slots:FRA:France Visa Application Centre, Bangalore
 */

import Redis from 'ioredis';
import { logger } from '../utils/logger';
import { notifyDateChange } from '../services/telegram-notifier';

// ---------------------------------------------------------------------------
// Redis client — connection errors are caught and logged; they do not crash
// the process. If Redis is unavailable, detectSlotChange returns 'none' so
// polling continues uninterrupted.
// ---------------------------------------------------------------------------
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  // Disable auto-reconnect noise in logs when Redis is intentionally absent
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});

redis.on('error', (err) => {
  logger.warn({ err: err.message }, 'Redis connection error — slot state will not be persisted');
});

// Attempt connection once at startup so we know early if Redis is reachable
redis.connect().catch(() => {
  // Error already logged by the 'error' event above
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlotEntry {
  date: string;
  applicants: number[]; // parsed from the comma-separated `applicant` field
}

export interface CentreSlotState {
  earliestDate: string | null;
  hasSlots: boolean;
  slotEntries: SlotEntry[]; // one entry per earliestSlotLists element
  totalApplicants: number;  // sum of applicants across all entries
  lastChecked: string;      // ISO timestamp
}

export type SlotChangeType = 'appeared' | 'earlier' | 'disappeared' | 'none';

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Compare the current API response against the last persisted state for a
 * centre, persist the new state, and return what kind of change occurred.
 *
 * @param centreName  Short display name used as part of the Redis key
 * @param apiResponse Raw parsed JSON body from CheckIsSlotAvailable
 * @returns SlotChangeType — will be used for Telegram notifications later
 */
export async function detectSlotChange(
  centreName: string,
  apiResponse: any
): Promise<SlotChangeType> {
  const redisKey = `slots:FRA:${centreName}`;

  // Build current state from API response
  const rawEntries: any[] = apiResponse?.earliestSlotLists ?? [];
  const slotEntries: SlotEntry[] = rawEntries.map((entry: any) => ({
    date: entry?.date ?? '',
    applicants: String(entry?.applicant ?? '')
      .split(',')
      .map((s: string) => parseInt(s.trim(), 10))
      .filter((n: number) => !isNaN(n)),
  }));
  const totalApplicants = slotEntries.reduce((sum, e) => sum + e.applicants.length, 0);

  const currentState: CentreSlotState = {
    earliestDate: apiResponse?.earliestDate ?? null,
    hasSlots: slotEntries.length > 0 && totalApplicants > 0,
    slotEntries,
    totalApplicants,
    lastChecked: new Date().toISOString(),
  };

  // ---------------------------------------------------------------------------
  // Read previous state from Redis
  // ---------------------------------------------------------------------------
  let previousState: CentreSlotState | null = null;
  try {
    const raw = await redis.get(redisKey);
    previousState = raw ? (JSON.parse(raw) as CentreSlotState) : null;
  } catch (err: any) {
    logger.warn({ err: err.message, centreName }, 'Redis GET failed — skipping change detection');
    return 'none';
  }

  // ---------------------------------------------------------------------------
  // Persist current state
  // ---------------------------------------------------------------------------
  try {
    await redis.set(redisKey, JSON.stringify(currentState));
  } catch (err: any) {
    logger.warn({ err: err.message, centreName }, 'Redis SET failed — state not persisted');
    // Continue — we still have previousState in memory for this call
  }

  // ---------------------------------------------------------------------------
  // No previous state — first run for this centre
  // If slots are already available, notify immediately (it's new to us).
  // If no slots, just save baseline silently.
  // ---------------------------------------------------------------------------
  if (!previousState) {
    if (currentState.hasSlots) {
      logger.warn(
        `🚨 FIRST OBSERVATION WITH SLOTS — ${centreName} | earliestDate: ${currentState.earliestDate} | applicants: ${currentState.totalApplicants}`
      );
      notifyDateChange(centreName, null, currentState.earliestDate ?? '').catch((err) => {
        logger.warn({ err: err.message }, '[Telegram] notifyDateChange threw unexpectedly (first observation)');
      });
      return 'appeared';
    }
    logger.info(
      `[${centreName}] First observation — no slots | earliestDate: ${currentState.earliestDate}`
    );
    return 'none';
  }

  // ---------------------------------------------------------------------------
  // Case 1: Slots appeared (none before, some now)
  // ---------------------------------------------------------------------------
  if (!previousState.hasSlots && currentState.hasSlots) {
    logger.warn(
      `🚨 SLOTS APPEARED — ${centreName} | earliestDate: ${currentState.earliestDate} | applicants: ${currentState.totalApplicants}`
    );
    notifyDateChange(centreName, previousState.earliestDate, currentState.earliestDate ?? '').catch((err) => {
      logger.warn({ err: err.message }, '[Telegram] notifyDateChange threw unexpectedly (appeared)');
    });
    return 'appeared';
  }

  // ---------------------------------------------------------------------------
  // Case 2: Earlier date opened (both had slots, but date moved earlier)
  // ISO date strings are lexicographically comparable: "2026-05-19" < "2026-05-26"
  // ---------------------------------------------------------------------------
  if (
    previousState.hasSlots &&
    currentState.hasSlots &&
    currentState.earliestDate !== null &&
    previousState.earliestDate !== null &&
    currentState.earliestDate < previousState.earliestDate
  ) {
    logger.warn(
      `🚨 EARLIER DATE — ${centreName} | was: ${previousState.earliestDate} → now: ${currentState.earliestDate} | applicants: ${currentState.totalApplicants}`
    );
    notifyDateChange(centreName, previousState.earliestDate, currentState.earliestDate).catch((err) => {
      logger.warn({ err: err.message }, '[Telegram] notifyDateChange threw unexpectedly (earlier)');
    });
    return 'earlier';
  }

  // ---------------------------------------------------------------------------
  // Case 3: Slots disappeared (had slots before, none now)
  // ---------------------------------------------------------------------------
  if (previousState.hasSlots && !currentState.hasSlots) {
    logger.info(`ℹ️  Slots gone — ${centreName}`);
    return 'disappeared';
  }

  // ---------------------------------------------------------------------------
  // No meaningful change
  // ---------------------------------------------------------------------------
  logger.info(
    `✓ No change — ${centreName} | earliestDate: ${currentState.earliestDate} | hasSlots: ${currentState.hasSlots} | applicants: ${currentState.totalApplicants}`
  );
  return 'none';
}
