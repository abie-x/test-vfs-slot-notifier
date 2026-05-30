"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectSlotChange = detectSlotChange;
const ioredis_1 = __importDefault(require("ioredis"));
const logger_1 = require("../utils/logger");
const telegram_notifier_1 = require("../services/telegram-notifier");
// ---------------------------------------------------------------------------
// Redis client — connection errors are caught and logged; they do not crash
// the process. If Redis is unavailable, detectSlotChange returns 'none' so
// polling continues uninterrupted.
// ---------------------------------------------------------------------------
const redis = new ioredis_1.default(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    // Disable auto-reconnect noise in logs when Redis is intentionally absent
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
});
redis.on('error', (err) => {
    logger_1.logger.warn({ err: err.message }, 'Redis connection error — slot state will not be persisted');
});
// Attempt connection once at startup so we know early if Redis is reachable
redis.connect().catch(() => {
    // Error already logged by the 'error' event above
});
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
async function detectSlotChange(centreName, apiResponse) {
    const redisKey = `slots:FRA:${centreName}`;
    // Build current state from API response
    const rawEntries = apiResponse?.earliestSlotLists ?? [];
    const slotEntries = rawEntries.map((entry) => ({
        date: entry?.date ?? '',
        applicants: String(entry?.applicant ?? '')
            .split(',')
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => !isNaN(n)),
    }));
    const totalApplicants = slotEntries.reduce((sum, e) => sum + e.applicants.length, 0);
    const currentState = {
        earliestDate: apiResponse?.earliestDate ?? null,
        hasSlots: slotEntries.length > 0 && totalApplicants > 0,
        slotEntries,
        totalApplicants,
        lastChecked: new Date().toISOString(),
    };
    // ---------------------------------------------------------------------------
    // Read previous state from Redis
    // ---------------------------------------------------------------------------
    let previousState = null;
    try {
        const raw = await redis.get(redisKey);
        previousState = raw ? JSON.parse(raw) : null;
    }
    catch (err) {
        logger_1.logger.warn({ err: err.message, centreName }, 'Redis GET failed — skipping change detection');
        return 'none';
    }
    // ---------------------------------------------------------------------------
    // Persist current state
    // ---------------------------------------------------------------------------
    try {
        await redis.set(redisKey, JSON.stringify(currentState));
    }
    catch (err) {
        logger_1.logger.warn({ err: err.message, centreName }, 'Redis SET failed — state not persisted');
        // Continue — we still have previousState in memory for this call
    }
    // ---------------------------------------------------------------------------
    // No previous state — first run for this centre
    // If slots are already available, notify immediately (it's new to us).
    // If no slots, just save baseline silently.
    // ---------------------------------------------------------------------------
    if (!previousState) {
        if (currentState.hasSlots) {
            logger_1.logger.warn(`🚨 FIRST OBSERVATION WITH SLOTS — ${centreName} | earliestDate: ${currentState.earliestDate} | applicants: ${currentState.totalApplicants}`);
            (0, telegram_notifier_1.notifyDateChange)(centreName, null, currentState.earliestDate ?? '').catch((err) => {
                logger_1.logger.warn({ err: err.message }, '[Telegram] notifyDateChange threw unexpectedly (first observation)');
            });
            return 'appeared';
        }
        logger_1.logger.info(`[${centreName}] First observation — no slots | earliestDate: ${currentState.earliestDate}`);
        return 'none';
    }
    // ---------------------------------------------------------------------------
    // Case 1: Slots appeared (none before, some now)
    // ---------------------------------------------------------------------------
    if (!previousState.hasSlots && currentState.hasSlots) {
        logger_1.logger.warn(`🚨 SLOTS APPEARED — ${centreName} | earliestDate: ${currentState.earliestDate} | applicants: ${currentState.totalApplicants}`);
        (0, telegram_notifier_1.notifyDateChange)(centreName, previousState.earliestDate, currentState.earliestDate ?? '').catch((err) => {
            logger_1.logger.warn({ err: err.message }, '[Telegram] notifyDateChange threw unexpectedly (appeared)');
        });
        return 'appeared';
    }
    // ---------------------------------------------------------------------------
    // Case 2: Earlier date opened (both had slots, but date moved earlier)
    // ISO date strings are lexicographically comparable: "2026-05-19" < "2026-05-26"
    // ---------------------------------------------------------------------------
    if (previousState.hasSlots &&
        currentState.hasSlots &&
        currentState.earliestDate !== null &&
        previousState.earliestDate !== null &&
        currentState.earliestDate < previousState.earliestDate) {
        logger_1.logger.warn(`🚨 EARLIER DATE — ${centreName} | was: ${previousState.earliestDate} → now: ${currentState.earliestDate} | applicants: ${currentState.totalApplicants}`);
        (0, telegram_notifier_1.notifyDateChange)(centreName, previousState.earliestDate, currentState.earliestDate).catch((err) => {
            logger_1.logger.warn({ err: err.message }, '[Telegram] notifyDateChange threw unexpectedly (earlier)');
        });
        return 'earlier';
    }
    // ---------------------------------------------------------------------------
    // Case 3: Date moved later (both had slots, but date moved further out)
    // The earlier slot is gone — someone booked it. The new date is still
    // available and worth notifying about for people who missed the earlier one.
    // ---------------------------------------------------------------------------
    if (previousState.hasSlots &&
        currentState.hasSlots &&
        currentState.earliestDate !== null &&
        previousState.earliestDate !== null &&
        currentState.earliestDate > previousState.earliestDate) {
        logger_1.logger.info(`ℹ️  DATE MOVED LATER — ${centreName} | was: ${previousState.earliestDate} → now: ${currentState.earliestDate} | applicants: ${currentState.totalApplicants}`);
        (0, telegram_notifier_1.notifyLaterDate)(centreName, previousState.earliestDate, currentState.earliestDate).catch((err) => {
            logger_1.logger.warn({ err: err.message }, '[Telegram] notifyLaterDate threw unexpectedly (later)');
        });
        return 'later';
    }
    // ---------------------------------------------------------------------------
    // Case 4: Slots disappeared (had slots before, none now)
    // ---------------------------------------------------------------------------
    if (previousState.hasSlots && !currentState.hasSlots) {
        logger_1.logger.info(`ℹ️  Slots gone — ${centreName}`);
        return 'disappeared';
    }
    // ---------------------------------------------------------------------------
    // No meaningful change
    // ---------------------------------------------------------------------------
    logger_1.logger.info(`✓ No change — ${centreName} | earliestDate: ${currentState.earliestDate} | hasSlots: ${currentState.hasSlots} | applicants: ${currentState.totalApplicants}`);
    return 'none';
}
//# sourceMappingURL=slot-detector.js.map