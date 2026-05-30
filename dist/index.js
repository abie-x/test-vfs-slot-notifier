"use strict";
/**
 * Campus Slot Notifier — Experiment 1 (Session Segmentation Without Proxies)
 *
 * Architecture:
 *   - ONE active session at a time
 *   - ONE Chrome instance at a time
 *   - SESSION_A polls centres 1–9, SESSION_B polls centres 10–18
 *   - 10-minute cooldown between sessions (no browser active)
 *   - 3–4 minute randomized delay between centre changes
 *   - Fully autonomous: loops forever after a single `npm start`
 *
 * Turnstile Strategy: Disconnect/Reconnect Cycle
 *   - Disconnect CDP before Turnstile renders (7s login / 8s OTP)
 *   - Check button status every 60 seconds (5 checks total)
 *   - Reconnect briefly only to check button status
 *
 * Usage: npm start
 */
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const logger_1 = require("./utils/logger");
const browser_1 = require("./auth/browser");
const cdp_helpers_1 = require("./automation/cdp-helpers");
const login_flow_1 = require("./automation/login-flow");
const booking_flow_1 = require("./automation/booking-flow");
const centres_config_1 = require("./config/centres.config");
const slot_detector_1 = require("./monitoring/slot-detector");
const session_orchestrator_1 = require("./orchestration/session-orchestrator");
const account_manager_1 = require("./auth/account-manager");
// 3–4 minute randomized delay between centre changes (Experiment 1 requirement)
const CENTRE_DELAY_MIN_MS = parseInt(process.env.CENTRE_DELAY_MIN_MS ?? '180000', 10); // 3 min
const CENTRE_DELAY_MAX_MS = parseInt(process.env.CENTRE_DELAY_MAX_MS ?? '240000', 10); // 4 min
// ---------------------------------------------------------------------------
// Timestamp helper
// Returns a compact [HH:MM:SS] string in IST for log prefixes.
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
// Single session runner
// Called by the orchestrator once per session cycle.
// Responsible for: Chrome launch → login → poll → Chrome shutdown.
// ---------------------------------------------------------------------------
async function runSession(phase, centreSlice) {
    const [sliceStart, sliceEnd] = centreSlice;
    const sessionCentres = centres_config_1.CENTRES.slice(sliceStart, sliceEnd);
    logger_1.logger.info('');
    logger_1.logger.info('═══════════════════════════════════════════════════════');
    logger_1.logger.info(`  [${ts()}] [${phase}] SESSION START`);
    logger_1.logger.info(`  [${ts()}] [${phase}] Centres: ${sliceStart + 1}–${sliceEnd} (${sessionCentres.length} centres)`);
    logger_1.logger.info(`  [${ts()}] [${phase}] Centre delay: ${CENTRE_DELAY_MIN_MS / 1000}s – ${CENTRE_DELAY_MAX_MS / 1000}s`);
    logger_1.logger.info('═══════════════════════════════════════════════════════');
    // Get current account credentials (rotates automatically after each full sweep)
    const { email, password } = await (0, account_manager_1.getCurrentAccount)();
    logger_1.logger.info(`[${ts()}] [${phase}] Using account: ${email}`);
    // ------------------------------------------------------------------
    // Chrome launch
    // ------------------------------------------------------------------
    logger_1.logger.info(`[${ts()}] [${phase}] Launching fresh Chrome instance...`);
    const chromeProc = await (0, browser_1.launchChrome)();
    logger_1.logger.info(`[${ts()}] [${phase}] ✓ Chrome launched (PID: ${chromeProc.pid})`);
    // Track CDP client so we can close it before killing Chrome
    let cdpClient = null;
    try {
        // ------------------------------------------------------------------
        // Login
        // ------------------------------------------------------------------
        logger_1.logger.info(`[${ts()}] [${phase}] LOGIN START — connecting CDP...`);
        let client = await (0, cdp_helpers_1.connectCDP)();
        cdpClient = client;
        await client.Page.enable();
        await client.Runtime.enable();
        logger_1.logger.info(`[${ts()}] [${phase}] CDP connected — starting login flow`);
        client = await (0, login_flow_1.performLogin)(client, email, password);
        cdpClient = client;
        logger_1.logger.info(`[${ts()}] [${phase}] ✓ Login credentials submitted`);
        // ------------------------------------------------------------------
        // OTP
        // ------------------------------------------------------------------
        logger_1.logger.info(`[${ts()}] [${phase}] OTP START — waiting for OTP screen...`);
        client = await (0, login_flow_1.handleOTPScreen)(client, email, password);
        cdpClient = client;
        logger_1.logger.info(`[${ts()}] [${phase}] ✓ OTP submitted`);
        // ------------------------------------------------------------------
        // Login completion
        // ------------------------------------------------------------------
        logger_1.logger.info(`[${ts()}] [${phase}] Waiting for post-login redirect...`);
        await (0, login_flow_1.waitForLoginComplete)(client.Runtime);
        logger_1.logger.info(`[${ts()}] [${phase}] ✓ LOGIN COMPLETE`);
        // ------------------------------------------------------------------
        // Dismiss password save dialog
        // ------------------------------------------------------------------
        logger_1.logger.info(`[${ts()}] [${phase}] Dismissing password save dialog...`);
        await (0, cdp_helpers_1.sleep)(2000);
        await client.Runtime.evaluate({
            expression: `
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      `,
            returnByValue: true,
        });
        await (0, cdp_helpers_1.sleep)(1000);
        // ------------------------------------------------------------------
        // Start New Booking
        // ------------------------------------------------------------------
        logger_1.logger.info(`[${ts()}] [${phase}] Clicking "Start New Booking"...`);
        const bookingClicked = await (0, booking_flow_1.clickStartNewBooking)(client.Runtime);
        if (!bookingClicked) {
            logger_1.logger.warn(`[${ts()}] [${phase}] "Start New Booking" not found — manual click may be needed`);
        }
        else {
            logger_1.logger.info(`[${ts()}] [${phase}] ✓ "Start New Booking" clicked`);
        }
        // ------------------------------------------------------------------
        // Booking page ready
        // ------------------------------------------------------------------
        logger_1.logger.info(`[${ts()}] [${phase}] Waiting for booking page...`);
        await (0, booking_flow_1.setupBookingPage)(client.Runtime);
        logger_1.logger.info(`[${ts()}] [${phase}] ✓ Booking page ready`);
        // ------------------------------------------------------------------
        // Network monitoring
        // ------------------------------------------------------------------
        await client.Network.enable();
        logger_1.logger.info(`[${ts()}] [${phase}] ✓ Network monitoring active`);
        let currentCentreName = '';
        // Abort flag — set to true by the network monitor when a fatal API
        // response is detected (429 rate limit or session invalidation).
        // The polling loop checks this flag after each centre and exits early.
        let sessionAborted = false;
        let abortReason = '';
        (0, booking_flow_1.setupNetworkMonitoring)(client, ({ earliestDate, slots, status, pollCount, rawData }) => {
            logger_1.logger.info(`[${ts()}] [${phase}] [${currentCentreName}] Poll #${pollCount} — ` +
                `status: ${status} | earliestDate: ${earliestDate} | slots: ${slots}`);
            if (status === 429) {
                logger_1.logger.warn(`[${ts()}] [${phase}] [${currentCentreName}] ⚠️  HTTP 429 — rate limited (Permission Issue 429201)`);
                sessionAborted = true;
                abortReason = 'HTTP 429 rate limit';
            }
            // Session invalidation: VFS returns 401 or redirects to login mid-session
            if (status === 401) {
                logger_1.logger.warn(`[${ts()}] [${phase}] [${currentCentreName}] ⚠️  HTTP 401 — session expired or invalid`);
                sessionAborted = true;
                abortReason = 'HTTP 401 session expired';
            }
            if (status === 200) {
                const capturedName = currentCentreName;
                (0, slot_detector_1.detectSlotChange)(capturedName, rawData).catch((err) => {
                    logger_1.logger.warn({ err: err.message, centre: capturedName }, 'detectSlotChange threw unexpectedly');
                });
            }
        });
        // ------------------------------------------------------------------
        // Centre polling — single pass through this session's batch
        // ------------------------------------------------------------------
        logger_1.logger.info(`[${ts()}] [${phase}] POLLING START — ${sessionCentres.length} centres`);
        for (let i = 0; i < sessionCentres.length; i++) {
            // Check abort flag before each centre
            if (sessionAborted) {
                logger_1.logger.warn(`[${ts()}] [${phase}] SESSION ABORTED — reason: ${abortReason}`);
                logger_1.logger.warn(`[${ts()}] [${phase}] Stopping poll at centre ${i + 1}/${sessionCentres.length} — handing off to orchestrator`);
                throw new Error(`Session aborted: ${abortReason}`);
            }
            const centre = sessionCentres[i];
            // Extract short name for log readability
            let centreName = centre.name;
            if (centreName.includes('France Visa Application Centre,')) {
                centreName = centreName.replace('France Visa Application Centre,', '').trim();
            }
            else if (centreName.includes('France Visa Application Centre')) {
                centreName = centreName.replace('France Visa Application Centre', '').trim();
            }
            else if (centreName.includes('France Temporary Enrolment Centre-')) {
                centreName = centreName.replace('France Temporary Enrolment Centre-', '').trim();
            }
            currentCentreName = centreName;
            logger_1.logger.info('');
            logger_1.logger.info(`[${ts()}] [${phase}] ── Centre ${i + 1}/${sessionCentres.length}: ${centreName}`);
            // Check for session expiry before polling (catch redirects early)
            try {
                const urlCheck = await client.Runtime.evaluate({
                    expression: 'location.pathname',
                    returnByValue: true,
                });
                const path = String(urlCheck.result?.value ?? '');
                if (path.includes('/login') || path.includes('/page-not-found')) {
                    logger_1.logger.warn(`[${ts()}] [${phase}] ⚠️  Session Expired or Invalid — redirected to ${path}`);
                    throw new Error(`Session expired: redirected to ${path}`);
                }
            }
            catch (err) {
                // If the error is our own throw, re-throw it
                if (err.message?.includes('Session expired'))
                    throw err;
                // Otherwise CDP may be briefly disconnected — non-fatal, continue
            }
            await (0, booking_flow_1.pollSingleCentre)(client.Runtime, centre, i + 1, sessionCentres.length);
            logger_1.logger.info(`[${ts()}] [${phase}] ✓ ${centreName} polled`);
            // Check abort flag immediately after poll — a 429 may have arrived
            // during the pollSingleCentre call itself
            if (sessionAborted) {
                logger_1.logger.warn(`[${ts()}] [${phase}] SESSION ABORTED after polling ${centreName} — reason: ${abortReason}`);
                throw new Error(`Session aborted: ${abortReason}`);
            }
            // Also detect session invalidation via URL (VFS redirects to /login or /page-not-found on expiry)
            try {
                const urlCheck = await client.Runtime.evaluate({
                    expression: 'location.pathname',
                    returnByValue: true,
                });
                const path = String(urlCheck.result?.value ?? '');
                if (path.includes('/login') || path.includes('/page-not-found')) {
                    logger_1.logger.warn(`[${ts()}] [${phase}] ⚠️  Session Expired or Invalid — redirected to ${path}`);
                    throw new Error(`Session expired: redirected to ${path}`);
                }
            }
            catch (err) {
                // If the error is our own throw, re-throw it
                if (err.message?.includes('Session expired'))
                    throw err;
                // Otherwise CDP may be briefly disconnected — non-fatal, continue
            }
            // 3–4 minute randomized delay between centres (except after last)
            if (i < sessionCentres.length - 1) {
                const waitMs = Math.floor(Math.random() * (CENTRE_DELAY_MAX_MS - CENTRE_DELAY_MIN_MS + 1)) +
                    CENTRE_DELAY_MIN_MS;
                const waitMin = (waitMs / 60000).toFixed(1);
                const resumeAt = new Date(Date.now() + waitMs).toLocaleTimeString('en-IN', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false,
                    timeZone: 'Asia/Kolkata',
                });
                logger_1.logger.info(`[${ts()}] [${phase}] Centre delay: ${waitMin} min — next centre at ${resumeAt}`);
                await (0, cdp_helpers_1.sleep)(waitMs);
            }
        }
        logger_1.logger.info('');
        logger_1.logger.info(`[${ts()}] [${phase}] ✓ POLLING COMPLETE — all ${sessionCentres.length} centres done`);
        // ------------------------------------------------------------------
        // Close CDP cleanly before killing Chrome
        // ------------------------------------------------------------------
        logger_1.logger.info(`[${ts()}] [${phase}] Closing CDP connection...`);
        await client.close().catch(() => { });
        cdpClient = null;
        logger_1.logger.info(`[${ts()}] [${phase}] ✓ CDP closed`);
    }
    finally {
        // ------------------------------------------------------------------
        // Guaranteed Chrome shutdown — runs even on error
        // Order: close CDP → SIGTERM → wait → SIGKILL → port cleanup
        // ------------------------------------------------------------------
        if (cdpClient !== null) {
            logger_1.logger.info(`[${ts()}] [${phase}] Closing CDP connection (error path)...`);
            await cdpClient.close().catch(() => { });
            cdpClient = null;
        }
        logger_1.logger.info(`[${ts()}] [${phase}] BROWSER SHUTDOWN — terminating Chrome...`);
        await (0, browser_1.shutdownChrome)(chromeProc);
        logger_1.logger.info('');
        logger_1.logger.info('═══════════════════════════════════════════════════════');
        logger_1.logger.info(`  [${ts()}] [${phase}] SESSION END`);
        logger_1.logger.info(`  [${ts()}] [${phase}] ✓ Chrome terminated`);
        logger_1.logger.info(`  [${ts()}] [${phase}] ✓ CDP disconnected`);
        logger_1.logger.info(`  [${ts()}] [${phase}] ✓ Port 9223 released`);
        logger_1.logger.info('═══════════════════════════════════════════════════════');
    }
}
// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main() {
    logger_1.logger.info('');
    logger_1.logger.info('╔═══════════════════════════════════════════════════════╗');
    logger_1.logger.info('║  Campus Slot Notifier — Experiment 1                  ║');
    logger_1.logger.info('║  Session Segmentation Without Proxies                 ║');
    logger_1.logger.info('╚═══════════════════════════════════════════════════════╝');
    logger_1.logger.info(`[${ts()}] Application start`);
    logger_1.logger.info(`[${ts()}] Monitoring ${centres_config_1.CENTRES.length} VFS France centres across India`);
    logger_1.logger.info(`[${ts()}] Strategy: slow segmented sessions | full browser recycling | no proxies`);
    logger_1.logger.info(`[${ts()}] Centre delay: ${CENTRE_DELAY_MIN_MS / 1000}s – ${CENTRE_DELAY_MAX_MS / 1000}s`);
    logger_1.logger.info(`[${ts()}] Cooldown: ${parseInt(process.env.SESSION_COOLDOWN_MS ?? '600000', 10) / 60000} min between sessions`);
    logger_1.logger.info('');
    // Handle graceful shutdown
    process.on('SIGINT', () => {
        logger_1.logger.info(`\n[${ts()}] [Main] SIGINT received — shutting down`);
        process.exit(0);
    });
    // Start the autonomous orchestration loop — runs forever
    await (0, session_orchestrator_1.startOrchestrationLoop)({ runSession });
}
main().catch((err) => {
    logger_1.logger.error({ err }, `[${ts()}] Fatal error`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map