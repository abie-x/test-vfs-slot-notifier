/**
 * Booking Flow Automation
 * Handles booking page navigation and slot polling
 */

import { logger } from '../utils/logger';
import { CDPClient, sleep, selectSubCategory } from './cdp-helpers';

/**
 * Click "Start New Booking" button
 */
export async function clickStartNewBooking(Runtime: any): Promise<boolean> {
  logger.info('Looking for "Start New Booking" button...');
  
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const result = await Runtime.evaluate({
      expression: `
        (() => {
          const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
          const bookingBtn = buttons.find(btn => {
            const text = btn.textContent?.toLowerCase() || '';
            return text.includes('start new booking');
          });
          
          if (bookingBtn) {
            bookingBtn.click();
            return { found: true, text: bookingBtn.textContent?.trim(), method: 'text' };
          }
          
          const orangeBtn = document.querySelector('button[class*="orange"], a[class*="orange"]');
          if (orangeBtn && orangeBtn.textContent?.toLowerCase().includes('booking')) {
            orangeBtn.click();
            return { found: true, text: orangeBtn.textContent?.trim(), method: 'orange-fallback' };
          }
          
          return { found: false };
        })()
      `,
      returnByValue: true,
    });
    
    const btn = result.result?.value as { found: boolean; text?: string; method?: string } | null;
    if (btn?.found) {
      logger.info({ buttonText: btn.text, method: btn.method }, '✓ "Start New Booking" button clicked');
      await sleep(3000); // Wait for page load
      return true;
    }
    
    if (i % 5 === 0) {
      logger.info(`[${i + 1}/20] Waiting for "Start New Booking" button...`);
    }
  }
  
  logger.warn('Could not find "Start New Booking" button automatically');
  return false;
}

/**
 * Setup booking page dropdowns (without selecting sub-category)
 */
export async function setupBookingPage(Runtime: any): Promise<void> {
  logger.info('');
  logger.info('════════════════════════════════════════════════════');
  logger.info('  Automating booking page setup...');
  logger.info('════════════════════════════════════════════════════');
  
  await sleep(2000);
  
  // Select Application Centre (Mangalore)
  logger.info('Selecting Application Centre: Mangalore...');
  const centreResult = await Runtime.evaluate({
    expression: `
      (async () => {
        try {
          const selects = document.querySelectorAll('mat-select');
          if (selects.length < 1) return { ok: false, error: 'Centre dropdown not found' };
          
          const centreSelect = selects[0];
          centreSelect.click();
          await new Promise(r => setTimeout(r, 1000));
          
          const options = document.querySelectorAll('mat-option');
          const mangaloreOption = Array.from(options).find(opt => 
            opt.textContent?.includes('Mangalore')
          );
          
          if (!mangaloreOption) return { ok: false, error: 'Mangalore option not found' };
          
          mangaloreOption.click();
          await new Promise(r => setTimeout(r, 1000));
          return { ok: true, selected: mangaloreOption.textContent?.trim() };
        } catch(e) {
          return { ok: false, error: String(e) };
        }
      })()
    `,
    awaitPromise: true,
    returnByValue: true,
    timeout: 15_000,
  });
  
  const centreRes = centreResult.result?.value as { ok: boolean; selected?: string; error?: string };
  if (centreRes?.ok) {
    logger.info({ centre: centreRes.selected }, '✓ Application Centre selected');
  } else {
    logger.warn({ error: centreRes?.error }, 'Failed to select centre — may already be selected');
  }
  
  // Wait for category to auto-populate
  logger.info('Waiting for Appointment Category to auto-populate...');
  await sleep(3000);
  
  const categoryCheck = await Runtime.evaluate({
    expression: `
      (() => {
        const selects = document.querySelectorAll('mat-select');
        if (selects.length < 2) return { found: false };
        const categoryText = selects[1].textContent?.trim();
        return { found: true, category: categoryText };
      })()
    `,
    returnByValue: true,
  });
  const catRes = categoryCheck.result?.value as { found: boolean; category?: string };
  logger.info({ category: catRes?.category }, '✓ Appointment Category auto-populated');
  
  // Wait for sub-category dropdown to be ready
  logger.info('Waiting for sub-category dropdown to be ready...');
  await sleep(2000);
  
  logger.info('');
  logger.info('════════════════════════════════════════════════════');
  logger.info('  ✓ Booking page setup complete!');
  logger.info('  Network monitoring will capture first API call');
  logger.info('════════════════════════════════════════════════════');
}

/**
 * Setup network monitoring for slot API calls
 */
export function setupNetworkMonitoring(
  client: CDPClient,
  onSlotData: (data: { earliestDate: string; slots: number; status: number; pollCount: number }) => void
): void {
  const { Network } = client;
  const pending = new Map<string, number>();
  let pollCount = 0;
  
  Network.requestWillBeSent((p: any) => {
    if (!p.request?.url?.includes('CheckIsSlotAvailable')) return;
    pending.set(p.requestId, 0);
  });
  
  Network.responseReceived((p: any) => {
    if (!pending.has(p.requestId)) return;
    pending.set(p.requestId, p.response?.status ?? 0);
  });
  
  Network.loadingFinished(async (p: any) => {
    if (!pending.has(p.requestId)) return;
    const status = pending.get(p.requestId)!;
    pending.delete(p.requestId);
    
    try {
      const resp = await Network.getResponseBody({ requestId: p.requestId });
      const data = JSON.parse(resp.body);
      pollCount++;
      
      const earliestDate = data?.earliestDate ?? 'N/A';
      const slots = data?.earliestSlotLists?.length ?? 0;
      
      onSlotData({ earliestDate, slots, status, pollCount });
    } catch (err: any) {
      logger.warn({ err }, 'Failed to read response body');
    }
  });
}

/**
 * Start polling loop
 */
export async function startPollingLoop(
  Runtime: any,
  subCategories: string[],
  pollIntervalMs: number,
  onPoll: (category: string) => void
): Promise<void> {
  logger.info('✓ Polling active — press Ctrl+C to stop');
  
  let subCatIndex = 0;
  
  while (true) {
    await sleep(pollIntervalMs);
    subCatIndex = (subCatIndex + 1) % subCategories.length;
    const category = subCategories[subCatIndex];
    
    onPoll(category);
    await selectSubCategory(Runtime, category);
  }
}
