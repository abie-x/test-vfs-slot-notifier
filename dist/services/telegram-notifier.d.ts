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
 * @param text       Message text (supports Telegram Markdown v1)
 * @param parseMode  'Markdown' | 'HTML' | undefined (default: undefined = plain text)
 * @param threadId   Optional topic thread ID for supergroup forum topics
 */
export declare function sendTelegramMessage(text: string, parseMode?: 'Markdown' | 'HTML', threadId?: number): Promise<boolean>;
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
 * Notifies the bot owner (private DM) that a VFS account has been blocked
 * with a 429001 "Access Restricted" error.
 *
 * Sends to TELEGRAM_OWNER_CHAT_ID — NOT the group chat.
 *
 * @param blockedEmail   The email address of the blocked account
 * @param nextEmail      The email address of the account we rotated to
 * @param cooldownMinutes How long the bot will wait before retrying (minutes)
 */
export declare function notifyOwnerAccountBlocked(blockedEmail: string, nextEmail: string, cooldownMinutes: number): Promise<void>;
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
export declare function notifyOwnerOtpTimeout(timedOutEmail: string, nextEmail: string, cooldownMinutes: number): Promise<void>;
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
export declare function notifyOwnerUnauthorisedActivity(blockedEmail: string, nextEmail: string, cooldownMinutes: number): Promise<void>;
/**
 * Sends a test message to verify the Telegram integration is working.
 * Call this once at startup or from a standalone test script.
 */
export declare function testTelegramIntegration(): Promise<void>;
//# sourceMappingURL=telegram-notifier.d.ts.map