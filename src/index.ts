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

import 'dotenv/config';
import { logger } from './utils/logger';
import { launchChrome, shutdownChrome } from './auth/browser';
import { connectCDP, sleep } from './automation/cdp-helpers';
import { performLogin, handleOTPScreen, waitForLoginComplete } from './automation/login-flow';
import {
  clickStartNewBooking,
  setupBookingPage,
  setupNetworkMonitoring,
  pollSingleCentre,
} from './automation/booking-flow';
import { CENTRES } from './config/centres.config';
import { detectSlotChange } from './monitoring/slot-detector';
import {
  startOrchestrationLoop,
  SessionPhase,
} from './orchestration/session-orchestrator';

// 3–4 minute randomized delay between centre changes (Experiment 1 requirement)
const CENTRE_DELAY_MIN_MS = parseInt(process.env.CENTRE_DELAY_MIN_MS ?? '180000', 10); // 3 min
const CENTRE_DELAY_MAX_MS = parseInt(process.env.CENTRE_DELAY_MAX_MS ?? '240000', 10); // 4 min

// ---------------------------------------------------------------------------
// Timestamp helper
// Returns a compact [HH:MM:SS] string in IST for log prefixes.
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
// Single session runner
// Called by the orchestrator once per session cycle.
// Responsible for: Chrome launch → login → poll → Chrome shutdown.
// ---------------------------------------------------------------------------

async function runSession(phase: SessionPhase, centreSlice: [number, number]): Promise<void> {
  const [sliceStart, sliceEnd] = centreSlice;
  const sessionCentres = CENTRES.slice(sliceStart, sliceEnd);

  logger.info('');
  logger.info('═══════════════════════════════════════════════════════');
  logger.info(`  [${ts()}] [${phase}] SESSION START`);
  logger.info(`  [${ts()}] [${phase}] Centres: ${sliceStart + 1}–${sliceEnd} (${sessionCentres.length} centres)`);
  logger.info(`  [${ts()}] [${phase}] Centre delay: ${CENTRE_DELAY_MIN_MS / 1000}s – ${CENTRE_DELAY_MAX_MS / 1000}s`);
  logger.info('═══════════════════════════════════════════════════════');

  // Validate environment variables
  const email = process.env.VFS_EMAIL ?? '';
  const password = process.env.VFS_PASSWORD ?? '';
  if (!email || !password) {
    logger.error(`[${ts()}] VFS_EMAIL and VFS_PASSWORD must be set`);
    process.exit(1);
  }

  // ------------------------------------------------------------------
  // Chrome launch
  // ------------------------------------------------------------------
  logger.info(`[${ts()}] [${phase}] Launching fresh Chrome instance...`);
  const chromeProc = await launchChrome();
  logger.info(`[${ts()}] [${phase}] ✓ Chrome launched (PID: ${chromeProc.pid})`);

  // Track CDP client so we can close it before killing Chrome
  let cdpClient: Awaited<ReturnType<typeof connectCDP>> | null = null;

  try {
    // ------------------------------------------------------------------
    // Login
    // ------------------------------------------------------------------
    logger.info(`[${ts()}] [${phase}] LOGIN START — connecting CDP...`);
    let client = await connectCDP();
    cdpClient = client;
    await client.Page.enable();
    await client.Runtime.enable();
    logger.info(`[${ts()}] [${phase}] CDP connected — starting login flow`);

    client = await performLogin(client, email, password);
    cdpClient = client;
    logger.info(`[${ts()}] [${phase}] ✓ Login credentials submitted`);

    // ------------------------------------------------------------------
    // OTP
    // ------------------------------------------------------------------
    logger.info(`[${ts()}] [${phase}] OTP START — waiting for OTP screen...`);
    client = await handleOTPScreen(client);
    cdpClient = client;
    logger.info(`[${ts()}] [${phase}] ✓ OTP submitted`);

    // ------------------------------------------------------------------
    // Login completion
    // ------------------------------------------------------------------
    logger.info(`[${ts()}] [${phase}] Waiting for post-login redirect...`);
    await waitForLoginComplete(client.Runtime);
    logger.info(`[${ts()}] [${phase}] ✓ LOGIN COMPLETE`);

    // ------------------------------------------------------------------
    // Dismiss password save dialog
    // ------------------------------------------------------------------
    logger.info(`[${ts()}] [${phase}] Dismissing password save dialog...`);
    await sleep(2000);
    await client.Runtime.evaluate({
      expression: `
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      `,
      returnByValue: true,
    });
    await sleep(1000);

    // ------------------------------------------------------------------
    // Start New Booking
    // ------------------------------------------------------------------
    logger.info(`[${ts()}] [${phase}] Clicking "Start New Booking"...`);
    const bookingClicked = await clickStartNewBooking(client.Runtime);
    if (!bookingClicked) {
      logger.warn(`[${ts()}] [${phase}] "Start New Booking" not found — manual click may be needed`);
    } else {
      logger.info(`[${ts()}] [${phase}] ✓ "Start New Booking" clicked`);
    }

    // ------------------------------------------------------------------
    // Booking page ready
    // ------------------------------------------------------------------
    logger.info(`[${ts()}] [${phase}] Waiting for booking page...`);
    await setupBookingPage(client.Runtime);
    logger.info(`[${ts()}] [${phase}] ✓ Booking page ready`);

    // ------------------------------------------------------------------
    // Network monitoring
    // ------------------------------------------------------------------
    await client.Network.enable();
    logger.info(`[${ts()}] [${phase}] ✓ Network monitoring active`);

    let currentCentreName = '';

    // Abort flag — set to true by the network monitor when a fatal API
    // response is detected (429 rate limit or session invalidation).
    // The polling loop checks this flag after each centre and exits early.
    let sessionAborted = false;
    let abortReason = '';

    setupNetworkMonitoring(client, ({ earliestDate, slots, status, pollCount, rawData }) => {
      logger.info(
        `[${ts()}] [${phase}] [${currentCentreName}] Poll #${pollCount} — ` +
        `status: ${status} | earliestDate: ${earliestDate} | slots: ${slots}`
      );

      if (status === 429) {
        logger.warn(`[${ts()}] [${phase}] [${currentCentreName}] ⚠️  HTTP 429 — rate limited (Permission Issue 429201)`);
        sessionAborted = true;
        abortReason = 'HTTP 429 rate limit';
      }

      // Session invalidation: VFS returns 401 or redirects to login mid-session
      if (status === 401) {
        logger.warn(`[${ts()}] [${phase}] [${currentCentreName}] ⚠️  HTTP 401 — session expired or invalid`);
        sessionAborted = true;
        abortReason = 'HTTP 401 session expired';
      }

      if (status === 200) {
        const capturedName = currentCentreName;
        detectSlotChange(capturedName, rawData).catch((err) => {
          logger.warn({ err: err.message, centre: capturedName }, 'detectSlotChange threw unexpectedly');
        });
      }
    });

    // ------------------------------------------------------------------
    // Centre polling — single pass through this session's batch
    // ------------------------------------------------------------------
    logger.info(`[${ts()}] [${phase}] POLLING START — ${sessionCentres.length} centres`);

    for (let i = 0; i < sessionCentres.length; i++) {
      // Check abort flag before each centre
      if (sessionAborted) {
        logger.warn(`[${ts()}] [${phase}] SESSION ABORTED — reason: ${abortReason}`);
        logger.warn(`[${ts()}] [${phase}] Stopping poll at centre ${i + 1}/${sessionCentres.length} — handing off to orchestrator`);
        throw new Error(`Session aborted: ${abortReason}`);
      }

      const centre = sessionCentres[i];

      // Extract short name for log readability
      let centreName = centre.name;
      if (centreName.includes('France Visa Application Centre,')) {
        centreName = centreName.replace('France Visa Application Centre,', '').trim();
      } else if (centreName.includes('France Visa Application Centre')) {
        centreName = centreName.replace('France Visa Application Centre', '').trim();
      } else if (centreName.includes('France Temporary Enrolment Centre-')) {
        centreName = centreName.replace('France Temporary Enrolment Centre-', '').trim();
      }

      currentCentreName = centreName;

      logger.info('');
      logger.info(`[${ts()}] [${phase}] ── Centre ${i + 1}/${sessionCentres.length}: ${centreName}`);

      await pollSingleCentre(client.Runtime, centre, i + 1, sessionCentres.length);

      logger.info(`[${ts()}] [${phase}] ✓ ${centreName} polled`);

      // Check abort flag immediately after poll — a 429 may have arrived
      // during the pollSingleCentre call itself
      if (sessionAborted) {
        logger.warn(`[${ts()}] [${phase}] SESSION ABORTED after polling ${centreName} — reason: ${abortReason}`);
        throw new Error(`Session aborted: ${abortReason}`);
      }

      // Also detect session invalidation via URL (VFS redirects to /login on expiry)
      try {
        const urlCheck = await client.Runtime.evaluate({
          expression: 'location.pathname',
          returnByValue: true,
        });
        const path = String(urlCheck.result?.value ?? '');
        if (path.includes('/login')) {
          logger.warn(`[${ts()}] [${phase}] ⚠️  Session Expired or Invalid — redirected to login page`);
          throw new Error('Session expired: redirected to login');
        }
      } catch (err: any) {
        // If the error is our own throw, re-throw it
        if (err.message?.includes('Session expired')) throw err;
        // Otherwise CDP may be briefly disconnected — non-fatal, continue
      }

      // 3–4 minute randomized delay between centres (except after last)
      if (i < sessionCentres.length - 1) {
        const waitMs =
          Math.floor(Math.random() * (CENTRE_DELAY_MAX_MS - CENTRE_DELAY_MIN_MS + 1)) +
          CENTRE_DELAY_MIN_MS;
        const waitMin = (waitMs / 60000).toFixed(1);
        const resumeAt = new Date(Date.now() + waitMs).toLocaleTimeString('en-IN', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
          timeZone: 'Asia/Kolkata',
        });
        logger.info(`[${ts()}] [${phase}] Centre delay: ${waitMin} min — next centre at ${resumeAt}`);
        await sleep(waitMs);
      }
    }

    logger.info('');
    logger.info(`[${ts()}] [${phase}] ✓ POLLING COMPLETE — all ${sessionCentres.length} centres done`);

    // ------------------------------------------------------------------
    // Close CDP cleanly before killing Chrome
    // ------------------------------------------------------------------
    logger.info(`[${ts()}] [${phase}] Closing CDP connection...`);
    await client.close().catch(() => {});
    cdpClient = null;
    logger.info(`[${ts()}] [${phase}] ✓ CDP closed`);

  } finally {
    // ------------------------------------------------------------------
    // Guaranteed Chrome shutdown — runs even on error
    // Order: close CDP → SIGTERM → wait → SIGKILL → port cleanup
    // ------------------------------------------------------------------
    if (cdpClient !== null) {
      logger.info(`[${ts()}] [${phase}] Closing CDP connection (error path)...`);
      await (cdpClient as any).close().catch(() => {});
      cdpClient = null;
    }

    logger.info(`[${ts()}] [${phase}] BROWSER SHUTDOWN — terminating Chrome...`);
    await shutdownChrome(chromeProc);

    logger.info('');
    logger.info('═══════════════════════════════════════════════════════');
    logger.info(`  [${ts()}] [${phase}] SESSION END`);
    logger.info(`  [${ts()}] [${phase}] ✓ Chrome terminated`);
    logger.info(`  [${ts()}] [${phase}] ✓ CDP disconnected`);
    logger.info(`  [${ts()}] [${phase}] ✓ Port 9223 released`);
    logger.info('═══════════════════════════════════════════════════════');
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logger.info('');
  logger.info('╔═══════════════════════════════════════════════════════╗');
  logger.info('║  Campus Slot Notifier — Experiment 1                  ║');
  logger.info('║  Session Segmentation Without Proxies                 ║');
  logger.info('╚═══════════════════════════════════════════════════════╝');
  logger.info(`[${ts()}] Application start`);
  logger.info(`[${ts()}] Monitoring ${CENTRES.length} VFS France centres across India`);
  logger.info(`[${ts()}] Strategy: slow segmented sessions | full browser recycling | no proxies`);
  logger.info(`[${ts()}] Centre delay: ${CENTRE_DELAY_MIN_MS / 1000}s – ${CENTRE_DELAY_MAX_MS / 1000}s`);
  logger.info(`[${ts()}] Cooldown: ${parseInt(process.env.SESSION_COOLDOWN_MS ?? '600000', 10) / 60000} min between sessions`);
  logger.info('');

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    logger.info(`\n[${ts()}] [Main] SIGINT received — shutting down`);
    process.exit(0);
  });

  // Start the autonomous orchestration loop — runs forever
  await startOrchestrationLoop({ runSession });
}

main().catch((err) => {
  logger.error({ err }, `[${ts()}] Fatal error`);
  process.exit(1);
});
