"use strict";
/**
 * CDP Helper Functions
 * Reusable utilities for Chrome DevTools Protocol operations
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.sleep = sleep;
exports.connectCDP = connectCDP;
exports.waitForLoginForm = waitForLoginForm;
exports.fillLoginCredentials = fillLoginCredentials;
exports.checkButtonWithRetry = checkButtonWithRetry;
exports.waitForOTPField = waitForOTPField;
exports.fillOTPField = fillOTPField;
exports.selectCentre = selectCentre;
exports.selectCategory = selectCategory;
exports.selectSubCategory = selectSubCategory;
exports.detectCurrentScreen = detectCurrentScreen;
const logger_1 = require("../utils/logger");
const browser_1 = require("../auth/browser");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const CDP = require('chrome-remote-interface');
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Connect to Chrome via CDP with retry logic
 */
async function connectCDP(filterUrl) {
    for (let i = 0; i < 30; i++) {
        try {
            const targets = await CDP.List({ port: browser_1.REMOTE_DEBUG_PORT });
            const page = filterUrl
                ? targets.find((t) => t.type === 'page' && t.url?.includes(filterUrl) && !t.url?.includes('devtools'))
                : targets.find((t) => t.type === 'page' && !t.url?.includes('devtools'));
            if (page) {
                logger_1.logger.info({ url: page.url }, 'CDP connected');
                return await CDP({ port: browser_1.REMOTE_DEBUG_PORT, target: page.id });
            }
        }
        catch {
            // Retry on error
        }
        await sleep(1000);
    }
    throw new Error('Could not connect CDP after 30 attempts');
}
/**
 * Wait for login form fields to appear
 */
async function waitForLoginForm(Runtime, maxAttempts = 20) {
    logger_1.logger.info('Waiting for login form...');
    for (let i = 0; i < maxAttempts; i++) {
        await sleep(1000);
        const check = await Runtime.evaluate({
            expression: '!!document.querySelector("#email") && !!document.querySelector("#password")',
            returnByValue: true,
        });
        if (check.result?.value === true) {
            logger_1.logger.info('✓ Form ready');
            return true;
        }
        if (i === maxAttempts - 1) {
            logger_1.logger.warn('Form timeout — attempting fill anyway');
        }
    }
    return false;
}
/**
 * Fill login credentials using Angular-compatible setter
 */
async function fillLoginCredentials(Runtime, email, password) {
    logger_1.logger.info('Filling credentials...');
    const fillResult = await Runtime.evaluate({
        expression: `
      (async () => {
        const email = document.querySelector('#email');
        const pass  = document.querySelector('#password');
        if (!email || !pass) return { ok: false, error: 'Fields not found' };
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(email, ${JSON.stringify(email)});
        email.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
        setter?.call(pass, ${JSON.stringify(password)});
        pass.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true, emailValue: email.value, passLength: pass.value.length };
      })()
    `,
        awaitPromise: true,
        returnByValue: true,
        timeout: 10_000,
    });
    logger_1.logger.info({ result: fillResult.result?.value }, 'Fill result');
}
/**
 * Check and click button with disconnect/reconnect cycle for Turnstile
 */
async function checkButtonWithRetry(buttonSelector, buttonName, maxChecks = 5, disconnectInterval = 60, initialWait = 7) {
    logger_1.logger.info(`Checking ${buttonName} button (disconnect/reconnect cycle, up to ${maxChecks * disconnectInterval + initialWait}s)...`);
    // URL patterns that indicate a dead/error page — no point polling on these
    const DEAD_PAGE_PATTERNS = [
        'page-not-found',
        '502',
        '503',
        '504',
        'error',
        'unavailable',
        'maintenance',
    ];
    for (let checkNum = 1; checkNum <= maxChecks; checkNum++) {
        logger_1.logger.info(`Reconnecting CDP for check #${checkNum}...`);
        const client = await connectCDP('vfsglobal.com');
        await client.Runtime.enable();
        // ── Guard: bail immediately if we're on an error/dead page ──────────
        const urlResult = await client.Runtime.evaluate({
            expression: 'location.href',
            returnByValue: true,
        });
        const currentUrl = String(urlResult.result?.value ?? '');
        const isDeadPage = DEAD_PAGE_PATTERNS.some((p) => currentUrl.includes(p));
        if (isDeadPage) {
            logger_1.logger.warn(`[Check #${checkNum}] Dead/error page detected — aborting button poll (url: ${currentUrl})`);
            await client.close();
            return { clicked: false, client: null };
        }
        // ────────────────────────────────────────────────────────────────────
        const btnResult = await client.Runtime.evaluate({
            expression: `
        (() => {
          const btn = document.querySelector('${buttonSelector}');
          if (!btn) return { found: false };
          const disabled = btn.hasAttribute('disabled');
          if (!disabled) btn.click();
          return { found: true, disabled, clicked: !disabled };
        })()
      `,
            returnByValue: true,
        });
        const btn = btnResult.result?.value;
        if (btn?.clicked) {
            logger_1.logger.info(`✓ ${buttonName} button enabled and clicked (check #${checkNum})`);
            return { clicked: true, client };
        }
        if (btn?.disabled) {
            const elapsedTime = initialWait + (checkNum - 1) * disconnectInterval;
            logger_1.logger.info(`[Check #${checkNum} at ${elapsedTime}s] ${buttonName}: disabled, waiting for Turnstile...`);
            if (checkNum < maxChecks) {
                logger_1.logger.info(`Disconnecting CDP for ${disconnectInterval}s (giving Turnstile space to work)...`);
                await client.close();
                await sleep(disconnectInterval * 1000);
            }
            else {
                return { clicked: false, client };
            }
        }
        else if (!btn?.found) {
            logger_1.logger.warn(`[Check #${checkNum}] ${buttonName} button not found`);
            if (checkNum < maxChecks) {
                await client.close();
                await sleep(disconnectInterval * 1000);
            }
            else {
                return { clicked: false, client };
            }
        }
    }
    return { clicked: false, client: null };
}
/**
 * Wait for OTP input field to appear
 */
async function waitForOTPField(Runtime, maxAttempts = 30) {
    logger_1.logger.info('Waiting for OTP input field...');
    for (let i = 0; i < maxAttempts; i++) {
        await sleep(1000);
        const check = await Runtime.evaluate({
            expression: `
        (() => {
          const bodyText = document.body.innerText ?? '';
          const url = location.href;
          // Bail out early if VFS shows a block page (429001 or 429002)
          const isBlocked =
            bodyText.includes('429001') ||
            bodyText.includes('Access Restricted for User ID') ||
            bodyText.includes('429002') ||
            bodyText.includes('Unauthorised Activity') ||
            (url.includes('page-not-found') && bodyText.includes('429'));
          if (isBlocked) return 'blocked';
          const inputs = document.querySelectorAll('input');
          const otpInput = Array.from(inputs).find(el =>
            el.placeholder?.includes('*') ||
            bodyText.includes('one time password')
          );
          return otpInput ? 'found' : 'waiting';
        })()
      `,
            returnByValue: true,
        });
        const result = check.result?.value;
        if (result === 'blocked') {
            logger_1.logger.warn('⚠️  VFS block page detected while waiting for OTP screen (429002/429001)');
            return false;
        }
        if (result === 'found') {
            logger_1.logger.info('✓ OTP screen detected');
            return true;
        }
    }
    return false;
}
/**
 * Fill OTP field using Angular-compatible setter
 */
async function fillOTPField(Runtime, otp) {
    logger_1.logger.info({ otp }, 'Filling OTP...');
    const fillResult = await Runtime.evaluate({
        expression: `
      (async () => {
        const inputs = document.querySelectorAll('input');
        const otpInput = Array.from(inputs).find(el =>
          el.placeholder?.includes('*') ||
          el.type === 'password' ||
          el.type === 'text'
        );
        if (!otpInput) return { ok: false, error: 'OTP input not found' };
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(otpInput, ${JSON.stringify(otp)});
        otpInput.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 500));
        return { ok: true, value: otpInput.value };
      })()
    `,
        awaitPromise: true,
        returnByValue: true,
    });
    logger_1.logger.info({ result: fillResult.result?.value }, '✓ OTP filled');
}
/**
 * Select centre from dropdown
 */
async function selectCentre(Runtime, centreName) {
    const script = `
    (async () => {
      try {
        const selects = document.querySelectorAll('mat-select');
        if (selects.length < 1) return { ok: false, error: 'Centre dropdown not found' };
        selects[0].click();
        await new Promise(r => setTimeout(r, 1000));
        const options = document.querySelectorAll('mat-option');
        const target = Array.from(options).find(o => o.textContent?.trim() === ${JSON.stringify(centreName)});
        if (!target) return { ok: false, error: 'Centre not found' };
        target.click();
        await new Promise(r => setTimeout(r, 1000));
        return { ok: true };
      } catch(e) { return { ok: false, error: String(e) }; }
    })()
  `;
    const result = await Runtime.evaluate({
        expression: script,
        awaitPromise: true,
        returnByValue: true,
        timeout: 15_000,
    });
    const val = result.result?.value;
    if (!val?.ok) {
        logger_1.logger.warn({ error: val?.error }, 'selectCentre failed');
        return false;
    }
    return true;
}
/**
 * Select category from dropdown
 */
async function selectCategory(Runtime, categoryText) {
    const script = `
    (async () => {
      try {
        const selects = document.querySelectorAll('mat-select');
        if (selects.length < 2) return { ok: false, error: 'Category dropdown not found' };
        selects[1].click();
        await new Promise(r => setTimeout(r, 800));
        const options = document.querySelectorAll('mat-option');
        const target = Array.from(options).find(o => o.textContent?.trim() === ${JSON.stringify(categoryText)});
        if (!target) return { ok: false, error: 'Category not found' };
        target.click();
        await new Promise(r => setTimeout(r, 500));
        return { ok: true };
      } catch(e) { return { ok: false, error: String(e) }; }
    })()
  `;
    const result = await Runtime.evaluate({
        expression: script,
        awaitPromise: true,
        returnByValue: true,
        timeout: 10_000,
    });
    const val = result.result?.value;
    if (!val?.ok) {
        logger_1.logger.warn({ error: val?.error }, 'selectCategory failed');
        return false;
    }
    return true;
}
/**
 * Select sub-category from dropdown with detailed logging
 */
async function selectSubCategory(Runtime, optionText) {
    const script = `
    (async () => {
      try {
        const selects = document.querySelectorAll('mat-select');
        if (selects.length < 3) return { ok: false, error: 'mat-select count: ' + selects.length };
        selects[2].click();
        await new Promise(r => setTimeout(r, 800));
        const options = document.querySelectorAll('mat-option');
        
        // Get all available options for debugging
        const availableOptions = Array.from(options).map(o => o.textContent?.trim());
        
        const target = Array.from(options).find(o => o.textContent?.trim() === ${JSON.stringify(optionText)});
        if (!target) {
          return { 
            ok: false, 
            error: 'Option not found',
            searchedFor: ${JSON.stringify(optionText)},
            availableOptions: availableOptions
          };
        }
        target.click();
        await new Promise(r => setTimeout(r, 500));
        return { ok: true };
      } catch(e) { return { ok: false, error: String(e) }; }
    })()
  `;
    const result = await Runtime.evaluate({
        expression: script,
        awaitPromise: true,
        returnByValue: true,
        timeout: 10_000,
    });
    const val = result.result?.value;
    if (!val?.ok) {
        logger_1.logger.warn({
            error: val?.error,
            searchedFor: val?.searchedFor,
            availableOptions: val?.availableOptions
        }, 'selectSubCategory failed');
        return false;
    }
    return true;
}
/**
 * Detect current screen type
 */
async function detectCurrentScreen(Runtime) {
    const screenCheck = await Runtime.evaluate({
        expression: `
      (() => {
        const url = location.href;
        const bodyText = document.body.innerText ?? '';
        const hasEmailField = !!document.querySelector('#email');
        const hasOtpField = !!Array.from(document.querySelectorAll('input')).find(el =>
          el.placeholder?.includes('*') || el.type === 'password'
        );
        const hasDashboard = url.includes('application-detail') || bodyText.includes('Start New Booking');

        // VFS account-level block: "Access Restricted for User ID (429001)" or "Unauthorised Activity (429002)"
        const isBlocked =
          bodyText.includes('429001') ||
          bodyText.includes('Access Restricted for User ID') ||
          bodyText.includes('429002') ||
          bodyText.includes('Unauthorised Activity') ||
          (url.includes('page-not-found') && bodyText.includes('429'));

        if (isBlocked) return 'blocked_429001';
        if (hasEmailField) return 'login';
        if (hasOtpField) return 'otp';
        if (hasDashboard) return 'dashboard';
        return 'unknown';
      })()
    `,
        returnByValue: true,
    });
    return String(screenCheck.result?.value ?? 'unknown');
}
//# sourceMappingURL=cdp-helpers.js.map