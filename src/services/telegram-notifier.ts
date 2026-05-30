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

import https from 'https';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';

// ---------------------------------------------------------------------------
// Deduplication state
// Tracks the last date we sent a notification for per centre.
// Key: centreName, Value: last notified date string
// ---------------------------------------------------------------------------
const lastNotifiedDate = new Map<string, string>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns current time as "HH:MM IST"
 */
function istTime(): string {
  return new Date().toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Kolkata',
  });
}

/**
 * Formats a raw date string into a readable form like "12 Jun 2026".
 * Falls back to the raw string if parsing fails.
 *
 * Handles two formats from the VFS API:
 *   - "MM/DD/YYYY HH:MM:SS"  e.g. "06/12/2026 00:00:00"
 *   - "YYYY-MM-DD"           e.g. "2026-06-12"
 *
 * Dates are parsed as UTC to avoid timezone shifts (e.g. midnight IST
 * rolling back to the previous day when converted to UTC).
 */
function formatDate(raw: string): string {
  try {
    let isoString: string;

    // Match "MM/DD/YYYY HH:MM:SS" or "MM/DD/YYYY"
    const mdyMatch = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (mdyMatch) {
      // Reconstruct as an explicit UTC ISO string so Date() never applies local offset
      isoString = `${mdyMatch[3]}-${mdyMatch[1]}-${mdyMatch[2]}T00:00:00Z`;
    } else {
      // Assume YYYY-MM-DD — append Z to force UTC interpretation
      isoString = raw.includes('T') ? raw : `${raw.split(' ')[0]}T00:00:00Z`;
    }

    const d = new Date(isoString);
    if (isNaN(d.getTime())) return raw;

    return d.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  } catch {
    return raw;
  }
}

/**
 * Extracts a short, readable centre name from the full VFS centre name.
 * e.g. "France Visa Application Centre, Bangalore" → "Bangalore"
 */
function shortCentreName(fullName: string): string {
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
 * @param text     Message text (supports Telegram Markdown v1)
 * @param parseMode  'Markdown' | 'HTML' | undefined (default: undefined = plain text)
 */
export async function sendTelegramMessage(
  text: string,
  parseMode?: 'Markdown' | 'HTML'
): Promise<boolean> {
  if (!BOT_TOKEN) {
    logger.warn('[Telegram] TELEGRAM_BOT_TOKEN is not set — skipping send');
    return false;
  }
  if (!CHAT_ID) {
    logger.warn('[Telegram] TELEGRAM_CHAT_ID is not set — skipping send');
    return false;
  }

  const payload = JSON.stringify({
    chat_id: CHAT_ID,
    text,
    ...(parseMode ? { parse_mode: parseMode } : {}),
  });

  return new Promise((resolve) => {
    const options: https.RequestOptions = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          logger.info('[Telegram] ✓ Message sent successfully');
          resolve(true);
        } else {
          logger.error(
            { statusCode: res.statusCode, body },
            '[Telegram] ✗ Send failed — non-200 response'
          );
          resolve(false);
        }
      });
    });

    req.on('error', (err) => {
      logger.error({ err: err.message }, '[Telegram] ✗ Send failed — network error');
      resolve(false);
    });

    req.setTimeout(10000, () => {
      logger.error('[Telegram] ✗ Send failed — request timed out after 10s');
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
export async function notifyDateChange(
  centreName: string,
  previousDate: string | null,
  newDate: string
): Promise<void> {
  // Rule 1: Skip N/A or empty dates
  if (!newDate || newDate === 'N/A' || newDate.trim() === '') {
    logger.info(`[Telegram] Skipped N/A notification for ${centreName}`);
    return;
  }

  // Rule 2: Deduplication — skip if we already notified this exact date for this centre
  const lastDate = lastNotifiedDate.get(centreName);
  if (lastDate === newDate) {
    logger.info(`[Telegram] Suppressed duplicate notification for ${centreName} — date unchanged: ${newDate}`);
    return;
  }

  const short = shortCentreName(centreName);
  const prevFormatted = previousDate && previousDate !== 'N/A'
    ? formatDate(previousDate)
    : 'None';
  const newFormatted = formatDate(newDate);
  const time = istTime();

  const message =
    `🇫🇷 France Appointment Update\n` +
    `\n` +
    `📍 Centre: ${short}\n` +
    `📅 Previous Date: ${prevFormatted}\n` +
    `✨ New Date: ${newFormatted}\n` +
    `\n` +
    `⏰ ${time} IST\n` +
    `🔗 [Book Now](https://visa.vfsglobal.com/ind/en/fra/login)`;

  logger.info(`[Telegram] Sending date change notification for ${centreName}: ${previousDate} → ${newDate}`);

  const sent = await sendTelegramMessage(message, 'Markdown');

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
export async function notifyLaterDate(
  centreName: string,
  previousDate: string,
  newDate: string
): Promise<void> {
  // Rule 1: Skip N/A or empty dates
  if (!newDate || newDate === 'N/A' || newDate.trim() === '') {
    logger.info(`[Telegram] Skipped N/A later-date notification for ${centreName}`);
    return;
  }

  // Rule 2: Deduplication — skip if we already notified this exact date for this centre
  const lastDate = lastNotifiedDate.get(centreName);
  if (lastDate === newDate) {
    logger.info(`[Telegram] Suppressed duplicate later-date notification for ${centreName} — date unchanged: ${newDate}`);
    return;
  }

  const short = shortCentreName(centreName);
  const prevFormatted = formatDate(previousDate);
  const newFormatted = formatDate(newDate);
  const time = istTime();

  const message =
    `🇫🇷 France Appointment Update\n` +
    `\n` +
    `📍 Centre: ${short}\n` +
    `⚠️ Earlier slot taken — date moved out\n` +
    `📅 Was: ${prevFormatted}\n` +
    `📅 Now: ${newFormatted}\n` +
    `\n` +
    `⏰ ${time} IST\n` +
    `🔗 [Book Now](https://visa.vfsglobal.com/ind/en/fra/login)`;

  logger.info(`[Telegram] Sending later-date notification for ${centreName}: ${previousDate} → ${newDate}`);

  const sent = await sendTelegramMessage(message, 'Markdown');

  if (sent) {
    lastNotifiedDate.set(centreName, newDate);
  }
}

// ---------------------------------------------------------------------------
// Integration test
// ---------------------------------------------------------------------------

/**
 * Sends a test message to verify the Telegram integration is working.
 * Call this once at startup or from a standalone test script.
 */
export async function testTelegramIntegration(): Promise<void> {
  logger.info('[Telegram] Sending integration test message...');
  const ok = await sendTelegramMessage('✅ Compus Telegram integration test');
  if (ok) {
    logger.info('[Telegram] ✓ Integration test passed — bot is connected and group is reachable');
  } else {
    logger.error('[Telegram] ✗ Integration test failed — check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
  }
}
