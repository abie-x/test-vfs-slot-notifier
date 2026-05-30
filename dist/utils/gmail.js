"use strict";
/**
 * Gmail OTP reader.
 * Reads the latest OTP email from VFS (donotreply@vfshelpline.com)
 * and extracts the 6-digit OTP.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.waitForOtp = waitForOtp;
const googleapis_1 = require("googleapis");
const logger_1 = require("./logger");
const VFS_SENDER = 'donotreply@vfshelpline.com';
const OTP_REGEX = /The OTP for your application with VFS Global is (\d{6})/;
const MAX_AGE_MS = 5 * 60 * 1000; // OTP expires in 5 minutes
function getGmailClient() {
    const clientId = process.env.GMAIL_CLIENT_ID;
    const clientSecret = process.env.GMAIL_CLIENT_SECRET;
    const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
    if (!clientId || !clientSecret || !refreshToken) {
        throw new Error('GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN must be set in .env');
    }
    const auth = new googleapis_1.google.auth.OAuth2(clientId, clientSecret, 'http://localhost');
    auth.setCredentials({ refresh_token: refreshToken });
    return googleapis_1.google.gmail({ version: 'v1', auth });
}
/**
 * Poll Gmail for the latest OTP from VFS.
 * Retries every 3 seconds for up to maxWaitMs.
 */
async function waitForOtp(maxWaitMs = 2 * 60 * 1000) {
    logger_1.logger.info('Waiting for OTP email from VFS...');
    const gmail = getGmailClient();
    const deadline = Date.now() + maxWaitMs;
    const sentAfter = Math.floor((Date.now() - 30_000) / 1000); // emails sent in last 30s
    while (Date.now() < deadline) {
        try {
            // Search for recent emails from VFS sender
            const listRes = await gmail.users.messages.list({
                userId: 'me',
                q: `from:${VFS_SENDER} after:${sentAfter}`,
                maxResults: 5,
            });
            const messages = listRes.data.messages ?? [];
            for (const msg of messages) {
                if (!msg.id)
                    continue;
                const msgRes = await gmail.users.messages.get({
                    userId: 'me',
                    id: msg.id,
                    format: 'full',
                });
                // Check email age
                const internalDate = parseInt(msgRes.data.internalDate ?? '0', 10);
                if (Date.now() - internalDate > MAX_AGE_MS)
                    continue;
                // Extract body text
                const payload = msgRes.data.payload;
                let body = '';
                if (payload?.body?.data) {
                    body = Buffer.from(payload.body.data, 'base64').toString('utf8');
                }
                else if (payload?.parts) {
                    for (const part of payload.parts) {
                        if (part.mimeType === 'text/plain' && part.body?.data) {
                            body = Buffer.from(part.body.data, 'base64').toString('utf8');
                            break;
                        }
                    }
                }
                const match = body.match(OTP_REGEX);
                if (match) {
                    logger_1.logger.info({ otp: match[1] }, '✓ OTP found in Gmail');
                    return match[1];
                }
            }
        }
        catch (err) {
            logger_1.logger.warn({ err }, 'Gmail API error — retrying');
        }
        const remaining = Math.round((deadline - Date.now()) / 1000);
        logger_1.logger.info(`Waiting for OTP email... (${remaining}s remaining)`);
        await new Promise((r) => setTimeout(r, 3_000));
    }
    logger_1.logger.error('OTP not received within timeout');
    return null;
}
//# sourceMappingURL=gmail.js.map