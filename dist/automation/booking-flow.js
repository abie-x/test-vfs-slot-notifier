"use strict";
/**
 * Booking Flow Automation
 * Handles booking page navigation and slot polling.
 *
 * The orchestrator in session-orchestrator.ts drives a single-pass poll
 * per session via pollSingleCentre() called directly from index.ts.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.clickStartNewBooking = clickStartNewBooking;
exports.setupBookingPage = setupBookingPage;
exports.setupNetworkMonitoring = setupNetworkMonitoring;
exports.pollSingleCentre = pollSingleCentre;
const logger_1 = require("../utils/logger");
const cdp_helpers_1 = require("./cdp-helpers");
/**
 * Click "Start New Booking" button
 */
async function clickStartNewBooking(Runtime) {
    logger_1.logger.info('Looking for "Start New Booking" button...');
    for (let i = 0; i < 20; i++) {
        await (0, cdp_helpers_1.sleep)(1000);
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
        const btn = result.result?.value;
        if (btn?.found) {
            logger_1.logger.info({ buttonText: btn.text, method: btn.method }, '✓ "Start New Booking" button clicked');
            await (0, cdp_helpers_1.sleep)(3000); // Wait for page load
            return true;
        }
        if (i % 5 === 0) {
            logger_1.logger.info(`[${i + 1}/20] Waiting for "Start New Booking" button...`);
        }
    }
    logger_1.logger.warn('Could not find "Start New Booking" button automatically');
    return false;
}
/**
 * Setup booking page - just wait for page to be ready
 */
async function setupBookingPage(Runtime) {
    logger_1.logger.info('');
    logger_1.logger.info('════════════════════════════════════════════════════');
    logger_1.logger.info('  Waiting for booking page to be ready...');
    logger_1.logger.info('════════════════════════════════════════════════════');
    await (0, cdp_helpers_1.sleep)(2000);
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
    const result = dropdownCheck.result?.value;
    if (result?.ready) {
        logger_1.logger.info({ dropdownCount: result.count }, '✓ Booking page ready');
    }
    else {
        logger_1.logger.warn({ dropdownCount: result?.count }, 'Booking page may not be fully loaded');
    }
    logger_1.logger.info('');
    logger_1.logger.info('════════════════════════════════════════════════════');
    logger_1.logger.info('  ✓ Ready to start multi-centre polling');
    logger_1.logger.info('════════════════════════════════════════════════════');
}
/**
 * Setup network monitoring for slot API calls
 */
function setupNetworkMonitoring(client, onSlotData) {
    const { Network } = client;
    const pending = new Map();
    let pollCount = 0;
    Network.requestWillBeSent((p) => {
        if (!p.request?.url?.includes('CheckIsSlotAvailable'))
            return;
        pending.set(p.requestId, 0);
    });
    Network.responseReceived((p) => {
        if (!pending.has(p.requestId))
            return;
        pending.set(p.requestId, p.response?.status ?? 0);
    });
    Network.loadingFinished(async (p) => {
        if (!pending.has(p.requestId))
            return;
        const status = pending.get(p.requestId);
        pending.delete(p.requestId);
        try {
            const resp = await Network.getResponseBody({ requestId: p.requestId });
            const data = JSON.parse(resp.body);
            pollCount++;
            const earliestDate = data?.earliestDate ?? 'N/A';
            // Each entry in earliestSlotLists has an `applicant` field that is a
            // comma-separated string of applicant numbers (e.g. "1,2,3,4,5").
            // Count total applicants across all slot entries.
            const slots = (data?.earliestSlotLists ?? []).reduce((sum, entry) => {
                const applicants = String(entry?.applicant ?? '')
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                return sum + applicants.length;
            }, 0);
            onSlotData({ earliestDate, slots, status, pollCount, rawData: data });
        }
        catch (err) {
            logger_1.logger.warn({ err }, 'Failed to read response body');
        }
    });
}
/**
 * Poll a single centre for slot availability
 */
async function pollSingleCentre(Runtime, centre, centreIndex, totalCentres) {
    // Extract short name for logging
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
    logger_1.logger.info('');
    logger_1.logger.info(`[${centreIndex}/${totalCentres}] Checking ${centreName}...`);
    // Step 1: Select centre
    const centreSelected = await (0, cdp_helpers_1.selectCentre)(Runtime, centre.name);
    if (!centreSelected) {
        logger_1.logger.error(`Failed to select centre: ${centreName}`);
        return;
    }
    logger_1.logger.info(`✓ Centre selected: ${centreName}`);
    // IMPORTANT: Wait 3 seconds for category dropdown to populate
    logger_1.logger.info('Waiting for category dropdown to load...');
    await (0, cdp_helpers_1.sleep)(3000);
    // Step 2: Select category (if needed)
    if (centre.category !== null) {
        const categorySelected = await (0, cdp_helpers_1.selectCategory)(Runtime, centre.category);
        if (!categorySelected) {
            logger_1.logger.error(`Failed to select category: ${centre.category}`);
            return;
        }
        logger_1.logger.info(`✓ Category selected: ${centre.category}`);
    }
    else {
        logger_1.logger.info('✓ Category auto-selected');
    }
    // IMPORTANT: Wait 3 seconds for subcategory dropdown to populate
    logger_1.logger.info('Waiting for subcategory dropdown to load...');
    await (0, cdp_helpers_1.sleep)(3000);
    // Step 3: Select subcategory (triggers API call)
    const subcategorySelected = await (0, cdp_helpers_1.selectSubCategory)(Runtime, centre.subcategory);
    if (!subcategorySelected) {
        logger_1.logger.error(`Failed to select subcategory for ${centreName}`);
        logger_1.logger.error(`Expected: "${centre.subcategory}"`);
        logger_1.logger.error('Check the logs above for available options');
        return;
    }
    const shortSubcat = centre.subcategory.length > 30
        ? centre.subcategory.substring(0, 30) + '...'
        : centre.subcategory;
    logger_1.logger.info(`✓ Subcategory selected: ${shortSubcat}`);
    // Wait for API response to be captured
    await (0, cdp_helpers_1.sleep)(2500);
}
//# sourceMappingURL=booking-flow.js.map