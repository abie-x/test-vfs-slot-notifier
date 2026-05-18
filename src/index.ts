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
  startPollingLoop,
} from './automation/booking-flow';

const CHROME_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VFS_LOGIN_URL = 'https://visa.vfsglobal.com/ind/en/fra/login';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '30000', 10);

const SUB_CATEGORIES = [
  'Long Stay',
  'Short Stay - Business',
  'Short Stay- Tourism/Visiting Family and Friends/Any other short stay',
];

function ts(): string {
  return new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
}

async function main(): Promise<void> {
  logger.info('Campus Slot Notifier — Production (Fully Automated)');
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

  // Step 7: Setup booking page (centre + category only, no sub-category yet)
  await setupBookingPage(client.Runtime);

  // Step 8: Enable network monitoring BEFORE selecting first sub-category
  await client.Network.enable();
  
  let lastEarliestDate: string | null = null;
  
  setupNetworkMonitoring(client, ({ earliestDate, slots, status, pollCount }) => {
    const now = new Date().toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
    logger.info(
      `[${now}] Poll #${pollCount} — earliestDate: ${earliestDate} | status: ${status} | slots: ${slots}`
    );

    if (earliestDate !== lastEarliestDate && lastEarliestDate !== null && earliestDate !== 'N/A') {
      logger.warn({ old: lastEarliestDate, new: earliestDate }, '⚠️  SLOT CHANGE DETECTED');
    }
    lastEarliestDate = earliestDate;
  });

  // Step 9: Now select first sub-category to trigger first API call (will be captured)
  logger.info('Selecting first sub-category to trigger initial slot check...');
  const { selectSubCategory } = await import('./automation/cdp-helpers');
  await selectSubCategory(client.Runtime, SUB_CATEGORIES[0]);
  await sleep(3000); // Wait for first API response

  // Step 10: Start polling loop
  logger.info('Starting automated polling...');
  
  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('\nStopping...');
    await client.close().catch(() => {});
    chromeProc.kill();
    process.exit(0);
  });

  await startPollingLoop(client.Runtime, SUB_CATEGORIES, POLL_INTERVAL_MS, (category) => {
    logger.info(`[${ts()}] Triggering poll — "${category}"`);
  });
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error');
  process.exit(1);
});
