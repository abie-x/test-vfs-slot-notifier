/**
 * Login Flow Automation
 * Handles the complete VFS login process with Turnstile bypass
 */

import { logger } from '../utils/logger';
import { waitForOtp } from '../utils/gmail';
import {
  CDPClient,
  connectCDP,
  sleep,
  waitForLoginForm,
  fillLoginCredentials,
  checkButtonWithRetry,
  waitForOTPField,
  fillOTPField,
  detectCurrentScreen,
} from './cdp-helpers';

/** Thrown when VFS shows "Access Restricted for User ID (429001)" after Sign In */
export class AccountBlockedError extends Error {
  constructor(email: string) {
    super(`ACCOUNT_BLOCKED_429001: ${email}`);
    this.name = 'AccountBlockedError';
  }
}

/** Thrown when VFS shows "Access Denied Due to Unauthorised Activity (429002)" after Sign In */
export class UnauthorisedActivityError extends Error {
  constructor(email: string) {
    super(`UNAUTHORISED_ACTIVITY_429002: ${email}`);
    this.name = 'UnauthorisedActivityError';
  }
}

/** Thrown when OTP is not received from Gmail after all retry attempts */
export class OtpTimeoutError extends Error {
  constructor(email: string) {
    super(`OTP_TIMEOUT: ${email}`);
    this.name = 'OtpTimeoutError';
  }
}

const BUTTON_SELECTOR = 'button.btn-brand-orange, button[type="submit"]';
const TURNSTILE_WAIT_LOGIN = 7000;
const TURNSTILE_WAIT_OTP = 8000;

/**
 * Perform login with credentials
 */
export async function performLogin(
  client: CDPClient,
  email: string,
  password: string
): Promise<CDPClient> {
  const { Page, Runtime } = client;
  
  // Navigate to login page
  logger.info('Navigating to VFS login...');
  await Page.navigate({ url: 'https://visa.vfsglobal.com/ind/en/fra/login' });
  await sleep(3000);
  
  // Wait for and fill form
  await waitForLoginForm(Runtime);
  await fillLoginCredentials(Runtime, email, password);
  
  // Disconnect for Turnstile
  logger.info('Disconnecting CDP before Turnstile renders...');
  await client.close();
  logger.info('✓ CDP disconnected — Turnstile should pass now');
  await sleep(TURNSTILE_WAIT_LOGIN);
  
  // Check Sign In button with retry
  const { clicked, client: newClient } = await checkButtonWithRetry(
    BUTTON_SELECTOR,
    'Sign In',
    5,
    60,
    7
  );
  
  if (!clicked) {
    logger.warn('Sign In button still disabled — attempting reload retry');
    return await retryLoginWithReload(email, password);
  }

  // Wait briefly for VFS to process the login and redirect
  logger.info('Waiting for post-Sign In redirect...');
  await sleep(4000);

  // Detect if VFS blocked this account (429001 Access Restricted / 429002 Unauthorised Activity)
  const postSignInScreen = await newClient!.Runtime.evaluate({
    expression: `
      (() => {
        const bodyText = document.body.innerText ?? '';
        const url = location.href;
        const is429002 = bodyText.includes('429002') || bodyText.includes('Unauthorised Activity');
        const is429001 = bodyText.includes('429001') || bodyText.includes('Access Restricted for User ID') || (url.includes('page-not-found') && bodyText.includes('429'));
        return { is429001, is429002, url };
      })()
    `,
    returnByValue: true,
  });
  const postSignIn = postSignInScreen.result?.value as { is429001: boolean; is429002: boolean; url: string } | null;
  if (postSignIn?.is429002) {
    logger.warn(`[Login] ⚠️  Unauthorised Activity (429002) — URL: ${postSignIn.url}`);
    throw new UnauthorisedActivityError(email);
  }
  if (postSignIn?.is429001) {
    logger.warn(`[Login] ⚠️  Account blocked (429001) — URL: ${postSignIn.url}`);
    throw new AccountBlockedError(email);
  }

  return newClient!;
}

/**
 * Retry login with page reload
 */
async function retryLoginWithReload(email: string, password: string): Promise<CDPClient> {
  logger.warn('Reloading page to retry (one time)...');
  
  const client = await connectCDP('vfsglobal.com');
  const { Page, Runtime } = client;
  await Page.enable();
  await Runtime.enable();
  
  await Page.reload();
  await sleep(3000);
  
  await waitForLoginForm(Runtime, 10);
  await fillLoginCredentials(Runtime, email, password);
  
  await client.close();
  await sleep(TURNSTILE_WAIT_LOGIN);
  
  const { clicked, client: newClient } = await checkButtonWithRetry(
    BUTTON_SELECTOR,
    'Sign In',
    5,
    60,
    7
  );
  
  if (!clicked) {
    logger.error('Sign In still failed after reload — throwing for orchestrator to handle');
    throw new Error('LOGIN_FAILED_AFTER_RELOAD');
  }

  // Wait briefly for VFS to process the login and redirect
  await sleep(4000);

  // Detect if VFS blocked this account (429001 Access Restricted / 429002 Unauthorised Activity)
  const postSignInScreen = await newClient!.Runtime.evaluate({
    expression: `
      (() => {
        const bodyText = document.body.innerText ?? '';
        const url = location.href;
        const is429002 = bodyText.includes('429002') || bodyText.includes('Unauthorised Activity');
        const is429001 = bodyText.includes('429001') || bodyText.includes('Access Restricted for User ID') || (url.includes('page-not-found') && bodyText.includes('429'));
        return { is429001, is429002, url };
      })()
    `,
    returnByValue: true,
  });
  const postSignIn = postSignInScreen.result?.value as { is429001: boolean; is429002: boolean; url: string } | null;
  if (postSignIn?.is429002) {
    logger.warn(`[Login] ⚠️  Unauthorised Activity (429002) on reload retry — URL: ${postSignIn.url}`);
    throw new UnauthorisedActivityError(email);
  }
  if (postSignIn?.is429001) {
    logger.warn(`[Login] ⚠️  Account blocked (429001) on reload retry — URL: ${postSignIn.url}`);
    throw new AccountBlockedError(email);
  }

  return newClient!;
}

/**
 * Handle OTP screen and submission
 */
export async function handleOTPScreen(
  client: CDPClient,
  email: string,
  password: string
): Promise<CDPClient> {
  const { Runtime } = client;
  
  logger.info('');
  logger.info('════════════════════════════════════════════════════');
  logger.info('  Waiting for OTP screen...');
  logger.info('════════════════════════════════════════════════════');
  
  const otpFieldFound = await waitForOTPField(Runtime);
  
  if (!otpFieldFound) {
    logger.error('OTP screen not detected — login may have failed');
    throw new Error('OTP screen not found');
  }
  
  // Disconnect for OTP Turnstile
  logger.info('Disconnecting CDP before OTP Turnstile renders...');
  await client.close();
  logger.info('✓ CDP disconnected — OTP Turnstile should pass now');
  await sleep(TURNSTILE_WAIT_OTP);
  
  // Fetch OTP from Gmail
  const otp = await fetchOTPWithRetry();
  
  if (!otp) {
    throw new OtpTimeoutError(email);
  }
  
  // Reconnect and fill OTP
  logger.info('Reconnecting CDP to fill OTP...');
  const newClient = await connectCDP('vfsglobal.com');
  await newClient.Runtime.enable();
  
  await fillOTPField(newClient.Runtime, otp);
  await sleep(2000); // Wait for Angular to process
  
  // Check Submit button with retry
  const { clicked, client: finalClient } = await checkButtonWithRetry(
    BUTTON_SELECTOR,
    'Submit',
    5,
    60,
    2
  );
  
  if (!clicked) {
    logger.warn('Submit button still disabled — attempting reload retry');
    return await retryOTPSubmitWithReload(otp, email, password);
  }
  
  return finalClient!;
}

/**
 * Fetch OTP with retry logic
 */
async function fetchOTPWithRetry(): Promise<string | null> {
  logger.info('');
  logger.info('════════════════════════════════════════════════════');
  logger.info('  Fetching OTP from Gmail...');
  logger.info('  (checking Gmail API automatically)');
  logger.info('════════════════════════════════════════════════════');
  
  let otp = await waitForOtp(2 * 60 * 1000);
  
  if (!otp) {
    logger.warn('OTP not received within 2 minutes — waiting 2 more minutes...');
    logger.info('(VFS sometimes delays OTP delivery)');
    otp = await waitForOtp(2 * 60 * 1000);
  }
  
  if (!otp) {
    logger.error('OTP still not received after 4 minutes total');
    logger.error('This may indicate an issue with VFS OTP delivery');
  }
  
  return otp;
}

/**
 * Retry OTP submit with reload.
 *
 * After reload, VFS almost always lands back on the login page (OTP screen
 * is transient and does not survive a reload). We detect which screen we're
 * on and handle both cases:
 *
 *   login screen → run full login flow (fill creds → Turnstile → Sign In)
 *                  then wait for OTP screen, fetch a fresh OTP, fill & Submit
 *   otp screen   → re-fill the existing OTP and retry Submit as before
 */
async function retryOTPSubmitWithReload(
  otp: string,
  email: string,
  password: string
): Promise<CDPClient> {
  logger.warn('Reloading page to retry Submit (one time)...');

  const client = await connectCDP('vfsglobal.com');
  const { Page, Runtime } = client;
  await Page.enable();
  await Runtime.enable();

  await Page.reload();
  await sleep(3000);

  // Detect which screen we landed on after reload
  const screen = await detectCurrentScreen(Runtime);
  logger.info(`[OTP retry] Screen after reload: ${screen}`);

  if (screen === 'login') {
    // ----------------------------------------------------------------
    // Reload sent us back to the login page — run the full login flow
    // ----------------------------------------------------------------
    logger.warn('[OTP retry] Landed on login screen — re-running login flow');

    await waitForLoginForm(Runtime, 10);
    await fillLoginCredentials(Runtime, email, password);

    // Disconnect for Turnstile
    logger.info('[OTP retry] Disconnecting CDP before Turnstile renders...');
    await client.close();
    await sleep(TURNSTILE_WAIT_LOGIN);

    // Click Sign In
    const { clicked: signInClicked, client: signInClient } = await checkButtonWithRetry(
      BUTTON_SELECTOR,
      'Sign In',
      5,
      60,
      7
    );

    if (!signInClicked) {
      logger.error('[OTP retry] Sign In still failed after reload — manual intervention required');
      process.exit(1);
    }

    // Wait for OTP screen
    logger.info('[OTP retry] Waiting for OTP screen after re-login...');
    const otpFound = await waitForOTPField(signInClient!.Runtime);
    if (!otpFound) {
      logger.error('[OTP retry] OTP screen not found after re-login — manual intervention required');
      process.exit(1);
    }

    // Disconnect for OTP Turnstile
    logger.info('[OTP retry] Disconnecting CDP before OTP Turnstile renders...');
    await signInClient!.close();
    await sleep(TURNSTILE_WAIT_OTP);

    // Fetch a fresh OTP — the previous one is now stale
    logger.info('[OTP retry] Fetching fresh OTP from Gmail...');
    const freshOtp = await fetchOTPWithRetry();
    if (!freshOtp) {
      logger.error('[OTP retry] Could not fetch fresh OTP — rotating account');
      throw new OtpTimeoutError(email);
    }

    // Reconnect and fill fresh OTP
    const otpClient = await connectCDP('vfsglobal.com');
    await otpClient.Runtime.enable();
    await fillOTPField(otpClient.Runtime, freshOtp);
    await sleep(2000);

    // Submit
    const { clicked: submitClicked, client: finalClient } = await checkButtonWithRetry(
      BUTTON_SELECTOR,
      'Submit',
      5,
      60,
      2
    );

    if (!submitClicked) {
      logger.error('[OTP retry] Submit still failed after full re-login — manual intervention required');
      process.exit(1);
    }

    return finalClient!;

  } else {
    // ----------------------------------------------------------------
    // Still on OTP screen — re-fill the existing OTP and retry Submit
    // ----------------------------------------------------------------
    logger.info('[OTP retry] Still on OTP screen — re-filling OTP');

    await fillOTPField(Runtime, otp);
    await sleep(2000);

    // Disconnect for Turnstile before retrying Submit
    logger.info('[OTP retry] Disconnecting CDP before OTP Turnstile renders...');
    await client.close();
    await sleep(TURNSTILE_WAIT_OTP);

    const { clicked, client: newClient } = await checkButtonWithRetry(
      BUTTON_SELECTOR,
      'Submit',
      5,
      60,
      2
    );

    if (!clicked) {
      logger.error('[OTP retry] Submit still failed after reload — manual intervention required');
      process.exit(1);
    }

    return newClient!;
  }
}

/**
 * Wait for redirect away from login page
 */
export async function waitForLoginComplete(Runtime: any): Promise<void> {
  logger.info('Waiting for login to complete...');
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      const urlCheck = await Runtime.evaluate({
        expression: 'location.pathname',
        returnByValue: true,
      });
      const path = String(urlCheck.result?.value ?? '');
      if (!path.includes('/login')) {
        logger.info({ path }, '✓ Login complete — redirected away from login');
        return;
      }
    } catch {
      // CDP might be disconnected, continue waiting
    }
  }
  logger.warn('Login redirect timeout — may still be on login page');
}
