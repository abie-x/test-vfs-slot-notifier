/**
 * Campus Slot Notifier — Production (Fully Automated)
 *
 * Optimized architecture with modular design:
 *   - Reusable CDP helper functions
 *   - Separated login and booking flows
 *   - Improved error handling and retry logic
 *   - Cleaner code organization
 *
 * Turnstile Strategy: Disconnect/Reconnect Cycle
 * - Initial disconnect: 7s (login) / 8s (OTP) for Turnstile to render
 * - Check button status every 60 seconds (5 checks total)
 * - Disconnect between checks (gives Turnstile 60s windows to work)
 * - Reconnect briefly (1-2s) only to check button status
 * - Total patience: ~247 seconds before reload retry
 * - One reload retry, then exits if still fails
 *
 * Usage: npm start
 */

import 'dotenv/config';
import { logger } from './utils/logger';
import { POLL_USER_DATA_DIR, REMOTE_DEBUG_PORT } from './auth/browser';
import { spawn } from 'child_process';
import { connectCDP, sleep } from './automation/cdp-helpers';
import { performLogin, handleOTPScreen, waitForLoginComplete } from './automation/login-flow';
import {
  clickStartNewBooking,
  setupBookingPage,
  setupNetworkMonitoring,
  startMultiCentrePolling,
} from './automation/booking-flow';
import { CENTRES } from './config/centres.config';
import { detectSlotChange } from './monitoring/slot-detector';

const CHROME_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VFS_LOGIN_URL = 'https://visa.vfsglobal.com/ind/en/fra/login';

// Polling interval with jitter (randomized between min and max)
// IMPORTANT: Set conservatively to avoid rate limiting (HTTP 429)
const POLL_INTERVAL_MIN_MS = parseInt(process.env.POLL_INTERVAL_MIN_MS ?? '45000', 10); // 45 seconds
const POLL_INTERVAL_MAX_MS = parseInt(process.env.POLL_INTERVAL_MAX_MS ?? '75000', 10); // 75 seconds

async function main(): Promise<void> {
  logger.info('Campus Slot Notifier — Multi-Centre Monitoring');
  logger.info('═══════════════════════════════════════════════════════');
  logger.info(`Monitoring ${CENTRES.length} VFS France centres across India`);
  logger.info('═══════════════════════════════════════════════════════');

  // Validate environment variables
  const email = process.env.VFS_EMAIL ?? '';
  const password = process.env.VFS_PASSWORD ?? '';
  if (!email || !password) {
    logger.error('VFS_EMAIL and VFS_PASSWORD must be set');
    process.exit(1);
  }

  // Step 1: Launch Chrome
  logger.info('Launching Chrome...');
  const chromeProc = spawn(
    CHROME_EXECUTABLE,
    [
      `--user-data-dir=${POLL_USER_DATA_DIR}`,
      `--remote-debugging-port=${REMOTE_DEBUG_PORT}`,
      VFS_LOGIN_URL,
    ],
    { detached: false, stdio: 'ignore' }
  );
  await sleep(3000);

  // Step 2: Connect CDP and perform login
  logger.info('Connecting CDP...');
  let client = await connectCDP();
  await client.Page.enable();
  await client.Runtime.enable();

  client = await performLogin(client, email, password);

  // Step 3: Handle OTP screen
  client = await handleOTPScreen(client);

  // Step 4: Wait for login completion
  await waitForLoginComplete(client.Runtime);

  // Step 5: Dismiss password save dialog
  logger.info('Dismissing password save dialog...');
  await sleep(2000);
  await client.Runtime.evaluate({
    expression: `
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    `,
    returnByValue: true,
  });
  await sleep(1000);

  // Step 6: Click "Start New Booking"
  const bookingClicked = await clickStartNewBooking(client.Runtime);
  if (!bookingClicked) {
    logger.warn('Please click "Start New Booking" manually');
  }

  // Step 7: Setup booking page (just verify it's ready)
  await setupBookingPage(client.Runtime);

  // Step 8: Enable network monitoring BEFORE any centre selection
  await client.Network.enable();

  let currentCentreName = '';

  setupNetworkMonitoring(client, ({ earliestDate, slots, status, pollCount, rawData }) => {
    const now = new Date().toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });

    logger.info(
      `[${now}] [${currentCentreName}] Poll #${pollCount} — ` +
      `earliestDate: ${earliestDate} | status: ${status} | slots: ${slots}`
    );

    if (status === 200) {
      // Persist state to Redis and detect changes — fire-and-forget, errors are
      // caught inside detectSlotChange so they never crash the polling loop
      const capturedName = currentCentreName;
      detectSlotChange(capturedName, rawData).catch((err) => {
        logger.warn({ err: err.message, centre: capturedName }, 'detectSlotChange threw unexpectedly');
      });
    }
  });

  // Step 9: Start multi-centre polling loop
  logger.info('Starting multi-centre polling...');
  
  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('\nStopping...');
    await client.close().catch(() => {});
    chromeProc.kill();
    process.exit(0);
  });

  await startMultiCentrePolling(
    client.Runtime,
    CENTRES,
    POLL_INTERVAL_MIN_MS,
    POLL_INTERVAL_MAX_MS,
    (_round, _centreIndex, centreName) => {
      currentCentreName = centreName;
    }
  );
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error');
  process.exit(1);
});
