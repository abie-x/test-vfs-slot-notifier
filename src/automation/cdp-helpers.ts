/**
 * CDP Helper Functions
 * Reusable utilities for Chrome DevTools Protocol operations
 */

import { logger } from '../utils/logger';
import { REMOTE_DEBUG_PORT } from '../auth/browser';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const CDP = require('chrome-remote-interface');

export interface CDPClient {
  Page: any;
  Runtime: any;
  Network?: any;
  close: () => Promise<void>;
}

export interface ButtonCheckResult {
  found: boolean;
  disabled: boolean;
  clicked: boolean;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


/**
 * Connect to Chrome via CDP with retry logic
 */
export async function connectCDP(filterUrl?: string): Promise<CDPClient> {
  for (let i = 0; i < 30; i++) {
    try {
      const targets = await CDP.List({ port: REMOTE_DEBUG_PORT });
      const page = filterUrl
        ? targets.find((t: any) => t.type === 'page' && t.url?.includes(filterUrl) && !t.url?.includes('devtools'))
        : targets.find((t: any) => t.type === 'page' && !t.url?.includes('devtools'));
      
      if (page) {
        logger.info({ url: page.url }, 'CDP connected');
        return await CDP({ port: REMOTE_DEBUG_PORT, target: page.id });
      }
    } catch {
      // Retry on error
    }
    await sleep(1000);
  }
  throw new Error('Could not connect CDP after 30 attempts');
}

/**
 * Wait for login form fields to appear
 */
export async function waitForLoginForm(Runtime: any, maxAttempts = 20): Promise<boolean> {
  logger.info('Waiting for login form...');
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(1000);
    const check = await Runtime.evaluate({
      expression: '!!document.querySelector("#email") && !!document.querySelector("#password")',
      returnByValue: true,
    });
    if (check.result?.value === true) {
      logger.info('✓ Form ready');
      return true;
    }
    if (i === maxAttempts - 1) {
      logger.warn('Form timeout — attempting fill anyway');
    }
  }
  return false;
}

/**
 * Fill login credentials using Angular-compatible setter
 */
export async function fillLoginCredentials(
  Runtime: any,
  email: string,
  password: string
): Promise<void> {
  logger.info('Filling credentials...');
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
  logger.info({ result: fillResult.result?.value }, 'Fill result');
}

/**
 * Check and click button with disconnect/reconnect cycle for Turnstile
 */
export async function checkButtonWithRetry(
  buttonSelector: string,
  buttonName: string,
  maxChecks = 5,
  disconnectInterval = 60,
  initialWait = 7
): Promise<{ clicked: boolean; client: CDPClient | null }> {
  logger.info(`Checking ${buttonName} button (disconnect/reconnect cycle, up to ${maxChecks * disconnectInterval + initialWait}s)...`);
  
  for (let checkNum = 1; checkNum <= maxChecks; checkNum++) {
    logger.info(`Reconnecting CDP for check #${checkNum}...`);
    const client = await connectCDP('vfsglobal.com');
    await client.Runtime.enable();
    
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
    const btn = btnResult.result?.value as ButtonCheckResult | null;
    
    if (btn?.clicked) {
      logger.info(`✓ ${buttonName} button enabled and clicked (check #${checkNum})`);
      return { clicked: true, client };
    }
    
    if (btn?.disabled) {
      const elapsedTime = initialWait + (checkNum - 1) * disconnectInterval;
      logger.info(`[Check #${checkNum} at ${elapsedTime}s] ${buttonName}: disabled, waiting for Turnstile...`);
      
      if (checkNum < maxChecks) {
        logger.info(`Disconnecting CDP for ${disconnectInterval}s (giving Turnstile space to work)...`);
        await client.close();
        await sleep(disconnectInterval * 1000);
      } else {
        return { clicked: false, client };
      }
    } else if (!btn?.found) {
      logger.warn(`[Check #${checkNum}] ${buttonName} button not found`);
      if (checkNum < maxChecks) {
        await client.close();
        await sleep(disconnectInterval * 1000);
      } else {
        return { clicked: false, client };
      }
    }
  }
  
  return { clicked: false, client: null };
}

/**
 * Wait for OTP input field to appear
 */
export async function waitForOTPField(Runtime: any, maxAttempts = 30): Promise<boolean> {
  logger.info('Waiting for OTP input field...');
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(1000);
    const check = await Runtime.evaluate({
      expression: `
        (() => {
          const inputs = document.querySelectorAll('input');
          const otpInput = Array.from(inputs).find(el =>
            el.placeholder?.includes('*') ||
            document.body.innerText.includes('one time password')
          );
          return !!otpInput;
        })()
      `,
      returnByValue: true,
    });
    if (check.result?.value === true) {
      logger.info('✓ OTP screen detected');
      return true;
    }
  }
  return false;
}

/**
 * Fill OTP field using Angular-compatible setter
 */
export async function fillOTPField(Runtime: any, otp: string): Promise<void> {
  logger.info({ otp }, 'Filling OTP...');
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
  logger.info({ result: fillResult.result?.value }, '✓ OTP filled');
}

/**
 * Select centre from dropdown
 */
export async function selectCentre(Runtime: any, centreName: string): Promise<boolean> {
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
  const val = result.result?.value as { ok: boolean; error?: string };
  if (!val?.ok) {
    logger.warn({ error: val?.error }, 'selectCentre failed');
    return false;
  }
  return true;
}

/**
 * Select category from dropdown
 */
export async function selectCategory(Runtime: any, categoryText: string): Promise<boolean> {
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
  const val = result.result?.value as { ok: boolean; error?: string };
  if (!val?.ok) {
    logger.warn({ error: val?.error }, 'selectCategory failed');
    return false;
  }
  return true;
}

/**
 * Select sub-category from dropdown with detailed logging
 */
export async function selectSubCategory(Runtime: any, optionText: string): Promise<boolean> {
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
  const val = result.result?.value as { ok: boolean; error?: string; searchedFor?: string; availableOptions?: string[] };
  if (!val?.ok) {
    logger.warn({ 
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
export async function detectCurrentScreen(Runtime: any): Promise<'login' | 'otp' | 'dashboard' | 'unknown'> {
  const screenCheck = await Runtime.evaluate({
    expression: `
      (() => {
        const url = location.href;
        const hasEmailField = !!document.querySelector('#email');
        const hasOtpField = !!Array.from(document.querySelectorAll('input')).find(el =>
          el.placeholder?.includes('*') || el.type === 'password'
        );
        const hasDashboard = url.includes('application-detail') || document.body.innerText.includes('Start New Booking');
        
        if (hasEmailField) return 'login';
        if (hasOtpField) return 'otp';
        if (hasDashboard) return 'dashboard';
        return 'unknown';
      })()
    `,
    returnByValue: true,
  });
  return String(screenCheck.result?.value ?? 'unknown') as any;
}
