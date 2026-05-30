/**
 * Booking Flow Automation
 * Handles booking page navigation and slot polling.
 *
 * The orchestrator in session-orchestrator.ts drives a single-pass poll
 * per session via pollSingleCentre() called directly from index.ts.
 */

import { logger } from '../utils/logger';
import { CDPClient, sleep, selectCentre, selectCategory, selectSubCategory } from './cdp-helpers';
import { CentreConfig } from '../config/centres.config';

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
 * Setup booking page - just wait for page to be ready
 */
export async function setupBookingPage(Runtime: any): Promise<void> {
  logger.info('');
  logger.info('════════════════════════════════════════════════════');
  logger.info('  Waiting for booking page to be ready...');
  logger.info('════════════════════════════════════════════════════');
  
  await sleep(2000);
  
  // Verify dropdowns are present
  const dropdownCheck = await Runtime.evaluate({
    expression: `
      (() => {
        const selects = document.querySelectorAll('mat-select');
        return { count: selects.length, ready: selects.length >= 3 };
      })()
    `,
    returnByValue: true,
  });
  
  const result = dropdownCheck.result?.value as { count: number; ready: boolean };
  if (result?.ready) {
    logger.info({ dropdownCount: result.count }, '✓ Booking page ready');
  } else {
    logger.warn({ dropdownCount: result?.count }, 'Booking page may not be fully loaded');
  }
  
  logger.info('');
  logger.info('════════════════════════════════════════════════════');
  logger.info('  ✓ Ready to start multi-centre polling');
  logger.info('════════════════════════════════════════════════════');
}

/**
 * Setup network monitoring for slot API calls
 */
export function setupNetworkMonitoring(
  client: CDPClient,
  onSlotData: (data: { earliestDate: string; slots: number; status: number; pollCount: number; rawData: any }) => void
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

      // Each entry in earliestSlotLists has an `applicant` field that is a
      // comma-separated string of applicant numbers (e.g. "1,2,3,4,5").
      // Count total applicants across all slot entries.
      const slots: number = (data?.earliestSlotLists ?? []).reduce(
        (sum: number, entry: any) => {
          const applicants = String(entry?.applicant ?? '')
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean);
          return sum + applicants.length;
        },
        0
      );

      onSlotData({ earliestDate, slots, status, pollCount, rawData: data });
    } catch (err: any) {
      logger.warn({ err }, 'Failed to read response body');
    }
  });
}

/**
 * Poll a single centre for slot availability
 */
export async function pollSingleCentre(
  Runtime: any,
  centre: CentreConfig,
  centreIndex: number,
  totalCentres: number
): Promise<void> {
  // Extract short name for logging
  let centreName = centre.name;
  if (centreName.includes('France Visa Application Centre,')) {
    centreName = centreName.replace('France Visa Application Centre,', '').trim();
  } else if (centreName.includes('France Visa Application Centre')) {
    centreName = centreName.replace('France Visa Application Centre', '').trim();
  } else if (centreName.includes('France Temporary Enrolment Centre-')) {
    centreName = centreName.replace('France Temporary Enrolment Centre-', '').trim();
  }
  
  logger.info('');
  logger.info(`[${centreIndex}/${totalCentres}] Checking ${centreName}...`);
  
  // Step 1: Select centre
  const centreSelected = await selectCentre(Runtime, centre.name);
  if (!centreSelected) {
    logger.error(`Failed to select centre: ${centreName}`);
    return;
  }
  logger.info(`✓ Centre selected: ${centreName}`);
  
  // IMPORTANT: Wait 3 seconds for category dropdown to populate
  logger.info('Waiting for category dropdown to load...');
  await sleep(3000);
  
  // Step 2: Select category (if needed)
  if (centre.category !== null) {
    const categorySelected = await selectCategory(Runtime, centre.category);
    if (!categorySelected) {
      logger.error(`Failed to select category: ${centre.category}`);
      return;
    }
    logger.info(`✓ Category selected: ${centre.category}`);
  } else {
    logger.info('✓ Category auto-selected');
  }
  
  // IMPORTANT: Wait 3 seconds for subcategory dropdown to populate
  logger.info('Waiting for subcategory dropdown to load...');
  await sleep(3000);
  
  // Step 3: Select subcategory (triggers API call)
  const subcategorySelected = await selectSubCategory(Runtime, centre.subcategory);
  if (!subcategorySelected) {
    logger.error(`Failed to select subcategory for ${centreName}`);
    logger.error(`Expected: "${centre.subcategory}"`);
    logger.error('Check the logs above for available options');
    return;
  }
  const shortSubcat = centre.subcategory.length > 30 
    ? centre.subcategory.substring(0, 30) + '...' 
    : centre.subcategory;
  logger.info(`✓ Subcategory selected: ${shortSubcat}`);
  
  // Wait for API response to be captured
  await sleep(2500);
}


