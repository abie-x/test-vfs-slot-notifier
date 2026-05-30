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
/**
 * Sends a plain-text or Markdown message to the configured Telegram group.
 * Never throws — errors are logged and swallowed so polling continues.
 *
 * @param text     Message text (supports Telegram Markdown v1)
 * @param parseMode  'Markdown' | 'HTML' | undefined (default: undefined = plain text)
 */
export declare function sendTelegramMessage(text: string, parseMode?: 'Markdown' | 'HTML'): Promise<boolean>;
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
export declare function notifyDateChange(centreName: string, previousDate: string | null, newDate: string): Promise<void>;
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
export declare function notifyLaterDate(centreName: string, previousDate: string, newDate: string): Promise<void>;
/**
 * Sends a test message to verify the Telegram integration is working.
 * Call this once at startup or from a standalone test script.
 */
export declare function testTelegramIntegration(): Promise<void>;
//# sourceMappingURL=telegram-notifier.d.ts.map