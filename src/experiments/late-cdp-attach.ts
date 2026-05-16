/**
 * Experiment — Late CDP attach after manual login
 *
 * Hypothesis: Chrome launched with --remote-debugging-port but CDP NOT connected
 * during login → Turnstile sees clean browser → login succeeds.
 * Then CDP attaches AFTER login → polling works on authenticated session.
 *
 * Flow:
 *   1. Launch Chrome with --remote-debugging-port (but don't connect CDP yet)
 *   2. You log in manually — Turnstile should pass (CDP not attached)
 *   3. Navigate to booking page, select centre + category + sub-category
 *   4. Press ENTER in terminal → CDP attaches NOW
 *   5. Polling starts — captures slot responses
 *
 * This validates whether late CDP attachment works on an authenticated session.
 */

import 'dotenv/config';
import * as readline from 'readline';
import { logger } from '../utils/logger';
import { POLL_USER_DATA_DIR, REMOTE_DEBUG_PORT } from '../auth/browser';
import { spawn } from 'child_process';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const CDP = require('chrome-remote-interface');

const CHROME_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VFS_LOGIN_URL = 'https://visa.vfsglobal.com/ind/en/fra/login';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '30000', 10);

const SUB_CATEGORIES = [
  'Long Stay',
  'Short Stay - Business',
  'Short Stay- Tourism/Visiting Family and Friends/Any other short stay',
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

function ts(): string {
  return new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
}

async function connectToVfsPage(): Promise<any> {
  logger.info('Attaching CDP to running Chrome...');
  for (let i = 0; i < 30; i++) {
    try {
      const targets = await CDP.List({ port: REMOTE_DEBUG_PORT });
      const vfs = targets.find((t: any) =>
        t.type === 'page' &&
        t.url?.includes('vfsglobal.com') &&
        !t.url?.includes('devtools')
      );
      if (vfs) {
        logger.info({ url: vfs.url }, '✓ VFS page found — CDP attached');
        return await CDP({ port: REMOTE_DEBUG_PORT, target: vfs.id });
      }
      const any = targets.find((t: any) => t.type === 'page' && !t.url?.includes('devtools'));
      if (any) {
        logger.info({ url: any.url }, '✓ CDP attached to page');
        return await CDP({ port: REMOTE_DEBUG_PORT, target: any.id });
      }
    } catch { /* retry */ }
    await sleep(1000);
  }
  throw new Error('Could not find Chrome page to attach CDP');
}

async function selectSubCategory(Runtime: any, optionText: string): Promise<boolean> {
  const script = `
    (async () => {
      try {
        const selects = document.querySelectorAll('mat-select');
        if (selects.length < 3) return { ok: false, error: 'mat-select count: ' + selects.length };
        selects[2].click();
        await new Promise(r => setTimeout(r, 800));
        const options = document.querySelectorAll('mat-option');
        const target = Array.from(options).find(o => o.textContent?.trim() === ${JSON.stringify(optionText)});
        if (!target) return { ok: false, error: 'Option not found: ' + ${JSON.stringify(optionText)} };
        target.click();
        await new Promise(r => setTimeout(r, 500));
        return { ok: true };
      } catch(e) {
        return { ok: false, error: String(e) };
      }
    })()
  `;
  const result = await Runtime.evaluate({
    expression: script, awaitPromise: true, returnByValue: true, timeout: 10_000,
  });
  const val = result.result?.value as { ok: boolean; error?: string };
  if (!val?.ok) { logger.warn({ error: val?.error }, 'selectSubCategory failed'); return false; }
  logger.info({ selected: optionText }, '✓ Sub-category selected');
  return true;
}

async function main(): Promise<void> {
  logger.info('Experiment — Late CDP attach after manual login');
  logger.info('═══════════════════════════════════════════════════════');

  // Step 1: Launch Chrome with debug port — but don't connect CDP yet
  logger.info('Launching Chrome with --remote-debugging-port (CDP NOT connected yet)...');
  const chromeProc = spawn(CHROME_EXECUTABLE, [
    `--user-data-dir=${POLL_USER_DATA_DIR}`,
    `--remote-debugging-port=${REMOTE_DEBUG_PORT}`,
    VFS_LOGIN_URL,
  ], { detached: false, stdio: 'ignore' });

  logger.info({ pid: chromeProc.pid }, '✓ Chrome launched — debug port open but CDP not attached');
  logger.info('');
  logger.info('════════════════════════════════════════════════════');
  logger.info('  CDP is NOT connected yet.');
  logger.info('  Please log in manually in the browser:');
  logger.info('  1. Enter email + password');
  logger.info('  2. Complete Cloudflare verification');
  logger.info('  3. Enter OTP');
  logger.info('  4. Navigate to booking page');
  logger.info('  5. Select Application Centre');
  logger.info('  6. Select appointment category');
  logger.info('  7. Select sub-category (any option)');
  logger.info('  8. Wait for earliest slot to appear');
  logger.info('════════════════════════════════════════════════════');

  await waitForEnter('\n>>> Press ENTER when you are on the booking page with slot visible <<<\n');

  // Step 2: NOW attach CDP — after login is complete
  logger.info('Attaching CDP now (post-login)...');
  const client = await connectToVfsPage();
  const { Network, Runtime } = client;
  await Network.enable();
  await Runtime.enable();

  logger.info('✓ CDP attached to authenticated session');
  logger.info('');

  // Verify we are on the right page
  const urlCheck = await Runtime.evaluate({
    expression: 'location.href',
    returnByValue: true,
  });
  logger.info({ url: urlCheck.result?.value }, 'Current page after CDP attach');

  // Step 3: Set up network listener for slot responses
  let pollCount = 0;
  let lastEarliestDate: string | null = null;
  let subCatIndex = 0;

  const pendingRequests = new Map<string, number>();

  Network.requestWillBeSent((params: any) => {
    if (!params.request?.url?.includes('CheckIsSlotAvailable')) return;
    pendingRequests.set(params.requestId, 0);
  });

  Network.responseReceived((params: any) => {
    if (!pendingRequests.has(params.requestId)) return;
    pendingRequests.set(params.requestId, params.response?.status ?? 0);
  });

  Network.loadingFinished(async (params: any) => {
    if (!pendingRequests.has(params.requestId)) return;
    const status = pendingRequests.get(params.requestId)!;
    pendingRequests.delete(params.requestId);

    try {
      const result = await Network.getResponseBody({ requestId: params.requestId });
      const raw = result.body ?? '';
      const parsed = JSON.parse(raw);
      pollCount++;
      const earliestDate: string | null = parsed.earliestDate ?? null;
      const slots = parsed.earliestSlotLists ?? [];
      const changed = earliestDate !== lastEarliestDate && lastEarliestDate !== null;

      if (changed) {
        logger.info('════════════════════════════════════════════════════');
        logger.info(`[${ts()}] ⚡ SLOT CHANGED: ${lastEarliestDate} → ${earliestDate}`);
        slots.forEach((s: any, i: number) =>
          logger.info(`  Slot ${i + 1}: ${s.date} — applicants: ${s.applicant}`)
        );
        logger.info('════════════════════════════════════════════════════');
      } else {
        logger.info(`[${ts()}] Poll #${pollCount} — earliestDate: ${earliestDate ?? 'none'} | status: ${status} | slots: ${slots.length}`);
      }

      lastEarliestDate = earliestDate;
    } catch (err) {
      logger.warn({ err }, `Poll #${pollCount + 1} — failed to read response body`);
    }
  });

  // Wait for first natural response (from the selection you already made)
  logger.info('Waiting for first slot response from your manual selection...');
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (pollCount > 0) { clearInterval(check); resolve(); }
    }, 500);
    // Timeout after 30s — may have already fired before CDP attached
    setTimeout(() => { clearInterval(check); resolve(); }, 30_000);
  });

  if (pollCount === 0) {
    logger.info('No response captured yet — triggering first poll manually...');
    subCatIndex = 1;
    await selectSubCategory(Runtime, SUB_CATEGORIES[subCatIndex]);
  }

  logger.info('✓ Starting automated polling loop (press Ctrl+C to stop)');

  // Polling loop
  process.on('SIGINT', async () => {
    logger.info('\nStopping...');
    await client.close().catch(() => {});
    chromeProc.kill();
    process.exit(0);
  });

  while (true) {
    await sleep(POLL_INTERVAL_MS);
    subCatIndex = (subCatIndex + 1) % SUB_CATEGORIES.length;
    logger.info(`[${ts()}] Triggering poll — selecting: "${SUB_CATEGORIES[subCatIndex]}"`);
    await selectSubCategory(Runtime, SUB_CATEGORIES[subCatIndex]);
  }
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error');
  process.exit(1);
});
