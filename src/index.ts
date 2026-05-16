/**
 * VFS Slot Poller — Phase 5
 *
 * Flow:
 *   1. Chrome opens, you log in and select centre + category + sub-category manually
 *   2. First CheckIsSlotAvailable fires naturally — captured via CDP
 *   3. Every 20s, script cycles sub-category to next option → captures response
 *   4. Logs earliestDate on every poll, alerts on change
 *
 * Sub-category options (France/Mangalore):
 *   - Long Stay
 *   - Short Stay - Business
 *   - Short Stay- Tourism/Visiting Family and Friends/Any other short stay
 */

import 'dotenv/config';
import { logger } from './utils/logger';
import { openChromeWithDebugging, REMOTE_DEBUG_PORT } from './auth/browser';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const CDP = require('chrome-remote-interface');

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '20000', 10);

// Sub-category options in order — script cycles through these
const SUB_CATEGORIES = [
  'Long Stay',
  'Short Stay - Business',
  'Short Stay- Tourism/Visiting Family and Friends/Any other short stay',
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function ts(): string {
  return new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
}

async function connectToVfsPage(): Promise<any> {
  logger.info('Waiting for VFS page in Chrome...');
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await CDP.List({ port: REMOTE_DEBUG_PORT });
      const vfs = targets.find((t: any) =>
        t.type === 'page' &&
        t.url?.includes('vfsglobal.com') &&
        !t.url?.includes('devtools')
      );
      if (vfs) {
        logger.info({ url: vfs.url }, '✓ VFS page found — attaching CDP');
        return await CDP({ port: REMOTE_DEBUG_PORT, target: vfs.id });
      }
    } catch { /* retry */ }
    if (i % 5 === 0) logger.info(`Waiting for VFS page... (${60 - i}s remaining)`);
    await sleep(1000);
  }
  throw new Error('VFS page did not load within 60s');
}

/**
 * Select a sub-category option in the Angular Material dropdown via CDP.
 * Opens the mat-select panel, clicks the matching option, waits for panel to close.
 */
async function selectSubCategory(Runtime: any, optionText: string): Promise<boolean> {
  const script = `
    (async () => {
      try {
        // Find all mat-select elements and pick the sub-category one
        // (3rd mat-select on the page: centre, category, sub-category)
        const selects = document.querySelectorAll('mat-select');
        if (selects.length < 3) return { ok: false, error: 'mat-select not found, count: ' + selects.length };

        const subCatSelect = selects[2];

        // Click to open the dropdown panel
        subCatSelect.click();
        await new Promise(r => setTimeout(r, 800));

        // Find the option in the overlay panel
        const options = document.querySelectorAll('mat-option');
        const target = Array.from(options).find(o => o.textContent?.trim() === ${JSON.stringify(optionText)});

        if (!target) {
          const available = Array.from(options).map(o => o.textContent?.trim());
          return { ok: false, error: 'Option not found: ' + ${JSON.stringify(optionText)}, available };
        }

        target.click();
        await new Promise(r => setTimeout(r, 500));

        return { ok: true, selected: ${JSON.stringify(optionText)} };
      } catch(e) {
        return { ok: false, error: String(e) };
      }
    })()
  `;

  const result = await Runtime.evaluate({
    expression: script,
    awaitPromise: true,
    returnByValue: true,
    timeout: 10_000,
  });

  const val = result.result?.value as { ok: boolean; selected?: string; error?: string; available?: string[] };

  if (!val?.ok) {
    logger.warn({ error: val?.error, available: val?.available }, 'selectSubCategory failed');
    return false;
  }

  logger.info({ selected: val.selected }, '✓ Sub-category selected');
  return true;
}

/**
 * Wait for the next CheckIsSlotAvailable response via CDP Network events.
 * Returns the parsed response or null on timeout.
 */
function waitForSlotResponse(
  Network: any,
  timeoutMs: number
): Promise<{ earliestDate: string | null; slots: Array<{ applicant: string; date: string }>; raw: string } | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      logger.warn('Timeout waiting for slot response');
      resolve(null);
    }, timeoutMs);

    const pendingRequests = new Map<string, number>(); // requestId → status

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
      clearTimeout(timer);

      try {
        const result = await Network.getResponseBody({ requestId: params.requestId });
        const raw = result.body ?? '';
        const parsed = JSON.parse(raw);
        resolve({
          earliestDate: parsed.earliestDate ?? null,
          slots: parsed.earliestSlotLists ?? [],
          raw,
        });
      } catch (err) {
        logger.warn({ err }, 'Failed to read response body');
        resolve(null);
      }
    });
  });
}

async function main(): Promise<void> {
  logger.info('VFS Slot Poller — Phase 5');
  logger.info(`Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
  logger.info({ subCategories: SUB_CATEGORIES }, 'Sub-categories to cycle');

  const chromeProc = openChromeWithDebugging();
  await sleep(4000);

  const client = await connectToVfsPage();
  const { Network, Runtime } = client;
  await Network.enable();
  await Runtime.enable();

  logger.info('');
  logger.info('════════════════════════════════════════════════════');
  logger.info('  CDP attached.');
  logger.info('  Please:');
  logger.info('  1. Log in manually');
  logger.info('  2. Select Application Centre');
  logger.info('  3. Select appointment category');
  logger.info('  4. Select sub-category (any option)');
  logger.info('  Polling starts automatically after first slot response.');
  logger.info('  Press Ctrl+C to stop.');
  logger.info('════════════════════════════════════════════════════');
  logger.info('');

  // ── Poll 0: capture the first natural response ───────────────────────────
  logger.info('Waiting for your manual sub-category selection...');

  let lastEarliestDate: string | null = null;
  let pollCount = 0;
  let subCatIndex = 0; // tracks which sub-category was last selected

  // Set up persistent network listeners
  const pendingRequests = new Map<string, number>();

  Network.requestWillBeSent((params: any) => {
    if (!params.request?.url?.includes('CheckIsSlotAvailable')) return;
    pendingRequests.set(params.requestId, 0);
    logger.debug({ requestId: params.requestId }, '→ Slot request sent');
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
      const slots: Array<{ applicant: string; date: string }> = parsed.earliestSlotLists ?? [];
      const changed = earliestDate !== lastEarliestDate;

      if (changed && lastEarliestDate !== null) {
        logger.info('════════════════════════════════════════════════════');
        logger.info(`[${ts()}] ⚡ SLOT CHANGED: ${lastEarliestDate} → ${earliestDate}`);
        slots.forEach((s, i) => logger.info(`  Slot ${i + 1}: ${s.date} — applicants: ${s.applicant}`));
        logger.info('════════════════════════════════════════════════════');
        // TODO Phase 6: send Telegram notification here
      } else {
        logger.info(`[${ts()}] Poll #${pollCount} — earliestDate: ${earliestDate ?? 'none'} | status: ${status} | slots: ${slots.length}`);
      }

      lastEarliestDate = earliestDate;

    } catch (err) {
      logger.warn({ err }, `Poll #${pollCount + 1} — failed to read response body`);
    }
  });

  // ── Polling loop ─────────────────────────────────────────────────────────
  // Wait for first natural response before starting automated cycling
  logger.info('Waiting for first natural slot response...');
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (lastEarliestDate !== null || pollCount > 0) {
        clearInterval(check);
        resolve();
      }
    }, 500);
  });

  logger.info('✓ First response captured — starting automated polling cycle');

  // Determine which sub-category was selected (we'll cycle from the next one)
  // For now start from index 0 and cycle through all 3
  while (true) {
    await sleep(POLL_INTERVAL_MS);

    subCatIndex = (subCatIndex + 1) % SUB_CATEGORIES.length;
    const nextOption = SUB_CATEGORIES[subCatIndex];

    logger.info(`[${ts()}] Triggering poll — selecting: "${nextOption}"`);
    const ok = await selectSubCategory(Runtime, nextOption);

    if (!ok) {
      logger.warn('Could not select sub-category — page may have changed');
      logger.warn('Check the browser window');
    }
  }
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error');
  process.exit(1);
});
