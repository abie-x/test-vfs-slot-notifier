/**
 * Booking Flow Automation
 * Handles booking page navigation and slot polling.
 *
 * Experiment 1: startMultiCentrePolling (infinite loop) has been removed.
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
      const slots = data?.earliestSlotLists?.length ?? 0;
      
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

/**
 * Start multi-centre polling loop
 * @deprecated Not used in Experiment 1. The orchestrator drives single-pass
 * polling via pollSingleCentre() called directly from index.ts.
 */
export async function startMultiCentrePolling(
  Runtime: any,
  centres: CentreConfig[],
  minIntervalMs: number,
  maxIntervalMs: number,
  onPollComplete: (round: number, centreIndex: number, centreName: string) => void
): Promise<void> {
  let pollRound = 0;
  
  logger.info('✓ Multi-centre polling active — press Ctrl+C to stop');
  logger.info(`✓ Monitoring ${centres.length} centres with ${minIntervalMs / 1000}s-${maxIntervalMs / 1000}s randomized interval`);
  
  while (true) {
    pollRound++;
    logger.info('');
    logger.info('═══════════════════════════════════════════════════════');
    logger.info(`  POLL ROUND #${pollRound} - Checking ${centres.length} centres`);
    logger.info('═══════════════════════════════════════════════════════');
    
    for (let i = 0; i < centres.length; i++) {
      const centre = centres[i];
      
      // Extract short name for tracking
      let centreName = centre.name;
      if (centreName.includes('France Visa Application Centre,')) {
        centreName = centreName.replace('France Visa Application Centre,', '').trim();
      } else if (centreName.includes('France Visa Application Centre')) {
        centreName = centreName.replace('France Visa Application Centre', '').trim();
      } else if (centreName.includes('France Temporary Enrolment Centre-')) {
        centreName = centreName.replace('France Temporary Enrolment Centre-', '').trim();
      }
      
      // Set centre name BEFORE polling so the network handler reads the correct name
      onPollComplete(pollRound, i + 1, centreName);
      
      await pollSingleCentre(Runtime, centre, i + 1, centres.length);
      
      // Wait between centres with jitter (except after last centre)
      if (i < centres.length - 1) {
        const waitTime = Math.floor(Math.random() * (maxIntervalMs - minIntervalMs + 1)) + minIntervalMs;
        logger.info(`Waiting ${(waitTime / 1000).toFixed(1)}s before next centre...`);
        await sleep(waitTime);
      }
    }
    
    const now = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    logger.info('');
    logger.info('═══════════════════════════════════════════════════════');
    logger.info(`  [${now}] ✓ Round #${pollRound} complete - checked ${centres.length} centres`);
    logger.info('═══════════════════════════════════════════════════════');
    
    // Wait before starting next round with jitter
    const roundWaitTime = Math.floor(Math.random() * (maxIntervalMs - minIntervalMs + 1)) + minIntervalMs;
    logger.info(`Waiting ${(roundWaitTime / 1000).toFixed(1)}s before next round...`);
    await sleep(roundWaitTime);
  }
}

/**
 * Start polling loop
 * @deprecated Not used in Experiment 1.
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
