"use strict";
/**
 * Account Manager — Account Rotation to Avoid "Too Many Logins" Error
 *
 * VFS Global blocks accounts after ~9 logins in 4 hours.
 * Strategy: rotate between 3 accounts after each full sweep (18 centres = 3 sessions).
 *
 * Redis keys:
 *   account:current_index — 0, 1, or 2 (which account is currently active)
 *   account:sweep_count   — number of sessions completed in current sweep
 *
 * Rotation logic:
 *   - 1 full sweep = 3 sessions (SESSION_A → SESSION_B → SESSION_C)
 *   - After SESSION_C completes, rotate to next account (0 → 1 → 2 → 0)
 *   - Account 1 does 1 sweep → Account 2 does 1 sweep → Account 3 does 1 sweep → repeat
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCurrentAccount = getCurrentAccount;
exports.incrementSessionAndCheckRotation = incrementSessionAndCheckRotation;
exports.getRotationStatus = getRotationStatus;
exports.forceRotateOnBlock = forceRotateOnBlock;
const ioredis_1 = __importDefault(require("ioredis"));
const logger_1 = require("../utils/logger");
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
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const REDIS_KEY_CURRENT_INDEX = 'account:current_index';
const REDIS_KEY_SWEEP_COUNT = 'account:sweep_count';
const SESSIONS_PER_SWEEP = 3; // SESSION_A, SESSION_B, SESSION_C
// ---------------------------------------------------------------------------
// Redis client
// ---------------------------------------------------------------------------
const redis = new ioredis_1.default(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
});
redis.on('error', (err) => {
    logger_1.logger.warn({ err: err.message }, '[AccountManager] Redis error — account rotation will not persist across restarts');
});
redis.connect().catch(() => {
    // Error already logged by the 'error' event above
});
/**
 * Wait for Redis connection to be ready (max 3s).
 * Falls through silently if Redis is unavailable.
 */
async function waitForRedisReady() {
    for (let i = 0; i < 10; i++) {
        if (redis.status === 'ready')
            return;
        await new Promise((r) => setTimeout(r, 300));
    }
}
/**
 * Get all account credentials from environment variables.
 * Throws if any required variable is missing.
 */
function getAccountCredentials() {
    const email1 = process.env.VFS_EMAIL_ACCOUNT1;
    const email2 = process.env.VFS_EMAIL_ACCOUNT2;
    const email3 = process.env.VFS_EMAIL_ACCOUNT3;
    const email4 = process.env.VFS_EMAIL_ACCOUNT4;
    const password = process.env.VFS_PASSWORD;
    if (!email1 || !email2 || !email3 || !email4 || !password) {
        throw new Error('Missing account credentials: VFS_EMAIL_ACCOUNT1, VFS_EMAIL_ACCOUNT2, VFS_EMAIL_ACCOUNT3, VFS_EMAIL_ACCOUNT4, and VFS_PASSWORD must all be set');
    }
    return [
        { email: email1, password },
        { email: email2, password },
        { email: email3, password },
        { email: email4, password },
    ];
}
// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------
/**
 * Get current account index (0, 1, 2, or 3).
 * Defaults to 0 if not set.
 */
async function getCurrentAccountIndex() {
    try {
        const raw = await redis.get(REDIS_KEY_CURRENT_INDEX);
        if (raw !== null) {
            const parsed = parseInt(raw, 10);
            if (parsed >= 0 && parsed <= 3)
                return parsed;
        }
    }
    catch {
        // Redis unavailable — default to account 0
    }
    return 0;
}
/**
 * Set current account index (0, 1, or 2).
 */
async function setCurrentAccountIndex(index) {
    try {
        await redis.set(REDIS_KEY_CURRENT_INDEX, String(index));
        logger_1.logger.info(`[AccountManager] Account index persisted → ${index}`);
    }
    catch (err) {
        logger_1.logger.warn({ err: err.message }, '[AccountManager] Could not persist account index to Redis');
    }
}
/**
 * Get current sweep count (number of sessions completed in current sweep).
 * Defaults to 0 if not set.
 */
async function getSweepCount() {
    try {
        const raw = await redis.get(REDIS_KEY_SWEEP_COUNT);
        if (raw)
            return parseInt(raw, 10);
    }
    catch {
        // Redis unavailable
    }
    return 0;
}
/**
 * Set sweep count.
 */
async function setSweepCount(count) {
    try {
        await redis.set(REDIS_KEY_SWEEP_COUNT, String(count));
    }
    catch (err) {
        logger_1.logger.warn({ err: err.message }, '[AccountManager] Could not persist sweep count to Redis');
    }
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Get the credentials for the currently active account.
 * Returns { email, password } for the current account.
 */
async function getCurrentAccount() {
    await waitForRedisReady();
    const accounts = getAccountCredentials();
    const index = await getCurrentAccountIndex();
    const account = accounts[index];
    logger_1.logger.info(`[${ts()}] [AccountManager] Using account ${index + 1}: ${account.email}`);
    return account;
}
/**
 * Increment session counter and check if we should rotate accounts.
 * Call this after each session completes successfully.
 *
 * Returns true if account was rotated, false otherwise.
 */
async function incrementSessionAndCheckRotation() {
    const sweepCount = await getSweepCount();
    const newSweepCount = sweepCount + 1;
    logger_1.logger.info(`[${ts()}] [AccountManager] Session completed — sweep progress: ${newSweepCount}/${SESSIONS_PER_SWEEP}`);
    if (newSweepCount >= SESSIONS_PER_SWEEP) {
        // Full sweep completed — rotate to next account (0 → 1 → 2 → 3 → 0)
        const currentIndex = await getCurrentAccountIndex();
        const newIndex = (currentIndex + 1) % 4;
        await setCurrentAccountIndex(newIndex);
        await setSweepCount(0);
        const accounts = getAccountCredentials();
        const newAccount = accounts[newIndex];
        logger_1.logger.info('');
        logger_1.logger.info('═══════════════════════════════════════════════════════');
        logger_1.logger.info(`  [${ts()}] [AccountManager] ACCOUNT ROTATION`);
        logger_1.logger.info(`  [${ts()}] [AccountManager] Full sweep completed (${SESSIONS_PER_SWEEP} sessions)`);
        logger_1.logger.info(`  [${ts()}] [AccountManager] Switching: Account ${currentIndex + 1} → Account ${newIndex + 1}`);
        logger_1.logger.info(`  [${ts()}] [AccountManager] Next login will use: ${newAccount.email}`);
        logger_1.logger.info('═══════════════════════════════════════════════════════');
        return true;
    }
    else {
        // Still in current sweep
        await setSweepCount(newSweepCount);
        return false;
    }
}
/**
 * Get current rotation status for logging/debugging.
 */
async function getRotationStatus() {
    await waitForRedisReady();
    const accounts = getAccountCredentials();
    const index = await getCurrentAccountIndex();
    const sweepCount = await getSweepCount();
    const currentEmail = accounts[index].email;
    return {
        currentAccountIndex: index,
        currentEmail,
        sweepProgress: `${sweepCount}/${SESSIONS_PER_SWEEP} sessions`,
    };
}
/**
 * Force-rotate to the next account immediately when a 429001 block is detected.
 * Does NOT touch sweep_count — the new account continues from the current sweep
 * progress and rotates normally after its own full sweep.
 *
 * Returns the email of the newly active account.
 */
async function forceRotateOnBlock(blockedEmail) {
    const currentIndex = await getCurrentAccountIndex();
    const newIndex = (currentIndex + 1) % 4;
    await setCurrentAccountIndex(newIndex);
    const accounts = getAccountCredentials();
    const newAccount = accounts[newIndex];
    logger_1.logger.warn('');
    logger_1.logger.warn('═══════════════════════════════════════════════════════');
    logger_1.logger.warn(`  [${ts()}] [AccountManager] FORCE ROTATION (429001 BLOCK)`);
    logger_1.logger.warn(`  [${ts()}] [AccountManager] Blocked account: ${blockedEmail}`);
    logger_1.logger.warn(`  [${ts()}] [AccountManager] Switching: Account ${currentIndex + 1} → Account ${newIndex + 1}`);
    logger_1.logger.warn(`  [${ts()}] [AccountManager] Next login will use: ${newAccount.email}`);
    logger_1.logger.warn('═══════════════════════════════════════════════════════');
    return newAccount.email;
}
//# sourceMappingURL=account-manager.js.map