"use strict";
/**
 * Telegram Notifier Service
 *
 * Sends appointment slot change notifications to a Telegram group.
 *
 * Environment variables required:
 *   TELEGRAM_BOT_TOKEN  — bot token from @BotFather
 *   TELEGRAM_CHAT_ID    — group chat ID (negative number for groups)
 *
 * Design principles:
 *   - Never throws — all errors are caught and logged so polling is never disrupted
 *   - Deduplication — same centre + same date combination is never notified twice
 *   - Skips N/A dates — only notifies when a real date is available
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendTelegramMessage = sendTelegramMessage;
exports.notifyDateChange = notifyDateChange;
exports.notifyLaterDate = notifyLaterDate;
exports.notifyOwnerAccountBlocked = notifyOwnerAccountBlocked;
exports.notifyOwnerOtpTimeout = notifyOwnerOtpTimeout;
exports.notifyOwnerUnauthorisedActivity = notifyOwnerUnauthorisedActivity;
exports.testTelegramIntegration = testTelegramIntegration;
const https_1 = __importDefault(require("https"));
const logger_1 = require("../utils/logger");
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';
const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID ?? '';
// Topic thread IDs for the supergroup's forum topics
const TOPIC_FRANCE = process.env.TELEGRAM_TOPIC_FRANCE
    ? parseInt(process.env.TELEGRAM_TOPIC_FRANCE, 10)
    : 2;
// TOPIC_ITALY and TOPIC_GERMANY — coming soon
// ---------------------------------------------------------------------------
// Deduplication state
// Tracks the last date we sent a notification for per centre.
// Key: centreName, Value: last notified date string
// ---------------------------------------------------------------------------
const lastNotifiedDate = new Map();
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Returns current time as "HH:MM IST"
 */
function istTime() {
    return new Date().toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Asia/Kolkata',
    });
}
/**
 * Formats a raw date string from VFS API (e.g. "06/20/2026 00:00:00" or "2026-05-27")
 * into a readable form like "20 Jun 2026".
 * Displays in IST to avoid timezone-shift off-by-one errors.
 * Falls back to the raw string if parsing fails.
 */
function formatDate(raw) {
    try {
        // VFS returns dates as "MM/DD/YYYY HH:MM:SS" — parse explicitly to avoid
        // JavaScript's ambiguous date parsing behaviour
        let d;
        const mmddyyyy = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
        if (mmddyyyy) {
            // Parse as "YYYY-MM-DD" which is unambiguous in JS
            d = new Date(`${mmddyyyy[3]}-${mmddyyyy[1]}-${mmddyyyy[2]}T00:00:00+05:30`);
        }
        else {
            d = new Date(raw);
        }
        if (isNaN(d.getTime()))
            return raw;
        return d.toLocaleDateString('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            timeZone: 'Asia/Kolkata',
        });
    }
    catch {
        return raw;
    }
}
/**
 * Extracts a short, readable centre name from the full VFS centre name.
 * e.g. "France Visa Application Centre, Bangalore" → "Bangalore"
 */
function shortCentreName(fullName) {
    let name = fullName;
    name = name.replace('France Visa Application Centre,', '').trim();
    name = name.replace('France Visa Application Centre', '').trim();
    name = name.replace('France Temporary Enrolment Centre-', '').trim();
    name = name.replace('France Visa Application Center,', '').trim();
    return name || fullName;
}
// ---------------------------------------------------------------------------
// Core send function
// ---------------------------------------------------------------------------
/**
 * Sends a plain-text or Markdown message to the configured Telegram group.
 * Never throws — errors are logged and swallowed so polling continues.
 *
 * @param text       Message text (supports Telegram Markdown v1)
 * @param parseMode  'Markdown' | 'HTML' | undefined (default: undefined = plain text)
 * @param threadId   Optional topic thread ID for supergroup forum topics
 */
async function sendTelegramMessage(text, parseMode, threadId) {
    if (!BOT_TOKEN) {
        logger_1.logger.warn('[Telegram] TELEGRAM_BOT_TOKEN is not set — skipping send');
        return false;
    }
    if (!CHAT_ID) {
        logger_1.logger.warn('[Telegram] TELEGRAM_CHAT_ID is not set — skipping send');
        return false;
    }
    const payload = JSON.stringify({
        chat_id: CHAT_ID,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
    });
    return new Promise((resolve) => {
        const options = {
            hostname: 'api.telegram.org',
            path: `/bot${BOT_TOKEN}/sendMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
        };
        const req = https_1.default.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => {
                if (res.statusCode === 200) {
                    logger_1.logger.info('[Telegram] ✓ Message sent successfully');
                    resolve(true);
                }
                else {
                    logger_1.logger.error({ statusCode: res.statusCode, body }, '[Telegram] ✗ Send failed — non-200 response');
                    resolve(false);
                }
            });
        });
        req.on('error', (err) => {
            logger_1.logger.error({ err: err.message }, '[Telegram] ✗ Send failed — network error');
            resolve(false);
        });
        req.setTimeout(10000, () => {
            logger_1.logger.error('[Telegram] ✗ Send failed — request timed out after 10s');
            req.destroy();
            resolve(false);
        });
        req.write(payload);
        req.end();
    });
}
// ---------------------------------------------------------------------------
// Slot change notification
// ---------------------------------------------------------------------------
/**
 * Sends a Telegram notification when the earliest appointment date changes
 * for a centre.
 *
 * Suppression rules:
 *   1. New date is "N/A" or empty → skip
 *   2. Same centre + same date already notified → skip (deduplication)
 *
 * @param centreName   Full VFS centre name
 * @param previousDate Previous earliest date (raw string or null)
 * @param newDate      New earliest date (raw string)
 */
async function notifyDateChange(centreName, previousDate, newDate) {
    // Rule 1: Skip N/A or empty dates
    if (!newDate || newDate === 'N/A' || newDate.trim() === '') {
        logger_1.logger.info(`[Telegram] Skipped N/A notification for ${centreName}`);
        return;
    }
    // Rule 2: Deduplication — skip if we already notified this exact date for this centre
    const lastDate = lastNotifiedDate.get(centreName);
    if (lastDate === newDate) {
        logger_1.logger.info(`[Telegram] Suppressed duplicate notification for ${centreName} — date unchanged: ${newDate}`);
        return;
    }
    const short = shortCentreName(centreName);
    const prevFormatted = previousDate && previousDate !== 'N/A'
        ? formatDate(previousDate)
        : 'None';
    const newFormatted = formatDate(newDate);
    const time = istTime();
    const message = `🇫🇷 France Appointment Update\n` +
        `\n` +
        `📍 Centre: ${short}\n` +
        `✨ New Date: *${newFormatted}*\n` +
        `📅 Previous Date: ${prevFormatted}\n` +
        `\n` +
        `⏰ ${time} IST\n` +
        `🔗 [Book Now](https://visa.vfsglobal.com/ind/en/fra/login)`;
    logger_1.logger.info(`[Telegram] Sending date change notification for ${centreName}: ${previousDate} → ${newDate}`);
    const sent = await sendTelegramMessage(message, 'Markdown', TOPIC_FRANCE);
    if (sent) {
        // Update deduplication state only on successful send
        lastNotifiedDate.set(centreName, newDate);
    }
}
// ---------------------------------------------------------------------------
// Later date notification
// ---------------------------------------------------------------------------
/**
 * Sends a Telegram notification when the earliest date moves further out.
 * The previous slot was taken; the new (later) date is still available.
 *
 * Suppression rules:
 *   1. New date is "N/A" or empty → skip
 *   2. Same centre + same date already notified → skip (deduplication)
 *
 * @param centreName   Full VFS centre name
 * @param previousDate Previous earliest date (raw string)
 * @param newDate      New (later) earliest date (raw string)
 */
async function notifyLaterDate(centreName, previousDate, newDate) {
    // Rule 1: Skip N/A or empty dates
    if (!newDate || newDate === 'N/A' || newDate.trim() === '') {
        logger_1.logger.info(`[Telegram] Skipped N/A later-date notification for ${centreName}`);
        return;
    }
    // Rule 2: Deduplication — skip if we already notified this exact date for this centre
    const lastDate = lastNotifiedDate.get(centreName);
    if (lastDate === newDate) {
        logger_1.logger.info(`[Telegram] Suppressed duplicate later-date notification for ${centreName} — date unchanged: ${newDate}`);
        return;
    }
    const short = shortCentreName(centreName);
    const prevFormatted = formatDate(previousDate);
    const newFormatted = formatDate(newDate);
    const time = istTime();
    const message = `🇫🇷 France Appointment Update\n` +
        `\n` +
        `📍 Centre: ${short}\n` +
        `⚠️ Earlier slot taken — date moved out\n` +
        `✨ New Date: *${newFormatted}*\n` +
        `📅 Previous Date: ${prevFormatted}\n` +
        `\n` +
        `⏰ ${time} IST\n` +
        `🔗 [Book Now](https://visa.vfsglobal.com/ind/en/fra/login)`;
    logger_1.logger.info(`[Telegram] Sending later-date notification for ${centreName}: ${previousDate} → ${newDate}`);
    const sent = await sendTelegramMessage(message, 'Markdown', TOPIC_FRANCE);
    if (sent) {
        lastNotifiedDate.set(centreName, newDate);
    }
}
// ---------------------------------------------------------------------------
// Owner DM — private notifications to bot operator only
// ---------------------------------------------------------------------------
/**
 * Sends a message directly to the bot owner's personal Telegram chat.
 * Uses TELEGRAM_OWNER_CHAT_ID instead of the group TELEGRAM_CHAT_ID.
 * Never throws.
 */
async function sendOwnerMessage(text) {
    if (!BOT_TOKEN) {
        logger_1.logger.warn('[Telegram] TELEGRAM_BOT_TOKEN is not set — skipping owner DM');
        return false;
    }
    if (!OWNER_CHAT_ID) {
        logger_1.logger.warn('[Telegram] TELEGRAM_OWNER_CHAT_ID is not set — skipping owner DM');
        return false;
    }
    const payload = JSON.stringify({
        chat_id: OWNER_CHAT_ID,
        text,
        parse_mode: 'Markdown',
    });
    return new Promise((resolve) => {
        const options = {
            hostname: 'api.telegram.org',
            path: `/bot${BOT_TOKEN}/sendMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
        };
        const req = https_1.default.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => {
                if (res.statusCode === 200) {
                    logger_1.logger.info('[Telegram] ✓ Owner DM sent successfully');
                    resolve(true);
                }
                else {
                    logger_1.logger.error({ statusCode: res.statusCode, body }, '[Telegram] ✗ Owner DM failed — non-200 response');
                    resolve(false);
                }
            });
        });
        req.on('error', (err) => {
            logger_1.logger.error({ err: err.message }, '[Telegram] ✗ Owner DM failed — network error');
            resolve(false);
        });
        req.setTimeout(10000, () => {
            logger_1.logger.error('[Telegram] ✗ Owner DM failed — request timed out after 10s');
            req.destroy();
            resolve(false);
        });
        req.write(payload);
        req.end();
    });
}
/**
 * Notifies the bot owner (private DM) that a VFS account has been blocked
 * with a 429001 "Access Restricted" error.
 *
 * Sends to TELEGRAM_OWNER_CHAT_ID — NOT the group chat.
 *
 * @param blockedEmail   The email address of the blocked account
 * @param nextEmail      The email address of the account we rotated to
 * @param cooldownMinutes How long the bot will wait before retrying (minutes)
 */
async function notifyOwnerAccountBlocked(blockedEmail, nextEmail, cooldownMinutes) {
    const time = istTime();
    const message = `🚫 *VFS Account Blocked (429001)*\n` +
        `\n` +
        `⛔ Blocked: \`${blockedEmail}\`\n` +
        `✅ Rotated to: \`${nextEmail}\`\n` +
        `\n` +
        `⏳ Cooldown: ${cooldownMinutes} minutes\n` +
        `⏰ ${time} IST`;
    logger_1.logger.warn(`[Telegram] Sending account-blocked owner DM for ${blockedEmail}`);
    await sendOwnerMessage(message);
}
/**
 * Notifies the bot owner (private DM) that OTP was not received after all
 * retry attempts. Account has been rotated as a precaution.
 *
 * Sends to TELEGRAM_OWNER_CHAT_ID — NOT the group chat.
 *
 * @param timedOutEmail  The email address that did not receive the OTP
 * @param nextEmail      The email address of the account we rotated to
 * @param cooldownMinutes How long the bot will wait before retrying (minutes)
 */
async function notifyOwnerOtpTimeout(timedOutEmail, nextEmail, cooldownMinutes) {
    const time = istTime();
    const message = `⏱️ *OTP Timeout — Account Rotated*\n` +
        `\n` +
        `📭 No OTP received for: \`${timedOutEmail}\`\n` +
        `✅ Rotated to: \`${nextEmail}\`\n` +
        `\n` +
        `⚠️ Possible cause: VFS may have flagged this account\n` +
        `⏳ Cooldown: ${cooldownMinutes} minutes\n` +
        `⏰ ${time} IST`;
    logger_1.logger.warn(`[Telegram] Sending OTP timeout owner DM for ${timedOutEmail}`);
    await sendOwnerMessage(message);
}
/**
 * Notifies the bot owner (private DM) that VFS returned a 429002
 * "Access Denied Due to Unauthorised Activity" error during login.
 *
 * Sends to TELEGRAM_OWNER_CHAT_ID — NOT the group chat.
 *
 * @param blockedEmail   The email address that triggered the block
 * @param nextEmail      The email address of the account we rotated to
 * @param cooldownMinutes How long the bot will wait before retrying (minutes)
 */
async function notifyOwnerUnauthorisedActivity(blockedEmail, nextEmail, cooldownMinutes) {
    const time = istTime();
    const message = `⛔ *VFS Unauthorised Activity (429002)*\n` +
        `\n` +
        `🚫 Blocked: \`${blockedEmail}\`\n` +
        `✅ Rotated to: \`${nextEmail}\`\n` +
        `\n` +
        `⚠️ VFS flagged this session as unauthorised activity\n` +
        `⏳ Cooldown: ${cooldownMinutes} minutes\n` +
        `⏰ ${time} IST`;
    logger_1.logger.warn(`[Telegram] Sending unauthorised-activity owner DM for ${blockedEmail}`);
    await sendOwnerMessage(message);
}
// ---------------------------------------------------------------------------
// Integration test
// ---------------------------------------------------------------------------
/**
 * Sends a test message to verify the Telegram integration is working.
 * Call this once at startup or from a standalone test script.
 */
async function testTelegramIntegration() {
    logger_1.logger.info('[Telegram] Sending integration test message...');
    const ok = await sendTelegramMessage('✅ Compus Telegram integration test');
    if (ok) {
        logger_1.logger.info('[Telegram] ✓ Integration test passed — bot is connected and group is reachable');
    }
    else {
        logger_1.logger.error('[Telegram] ✗ Integration test failed — check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
    }
}
//# sourceMappingURL=telegram-notifier.js.map