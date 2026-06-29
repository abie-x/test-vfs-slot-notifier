"use strict";
/**
 * Login Flow Automation
 * Handles the complete VFS login process with Turnstile bypass
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OtpTimeoutError = exports.UnauthorisedActivityError = exports.AccountBlockedError = void 0;
exports.performLogin = performLogin;
exports.handleOTPScreen = handleOTPScreen;
exports.waitForLoginComplete = waitForLoginComplete;
const logger_1 = require("../utils/logger");
const gmail_1 = require("../utils/gmail");
const cdp_helpers_1 = require("./cdp-helpers");
/** Thrown when VFS shows "Access Restricted for User ID (429001)" after Sign In */
class AccountBlockedError extends Error {
    constructor(email) {
        super(`ACCOUNT_BLOCKED_429001: ${email}`);
        this.name = 'AccountBlockedError';
    }
}
exports.AccountBlockedError = AccountBlockedError;
/** Thrown when VFS shows "Access Denied Due to Unauthorised Activity (429002)" after Sign In */
class UnauthorisedActivityError extends Error {
    constructor(email) {
        super(`UNAUTHORISED_ACTIVITY_429002: ${email}`);
        this.name = 'UnauthorisedActivityError';
    }
}
exports.UnauthorisedActivityError = UnauthorisedActivityError;
/** Thrown when OTP is not received from Gmail after all retry attempts */
class OtpTimeoutError extends Error {
    constructor(email) {
        super(`OTP_TIMEOUT: ${email}`);
        this.name = 'OtpTimeoutError';
    }
}
exports.OtpTimeoutError = OtpTimeoutError;
const BUTTON_SELECTOR = 'button.btn-brand-orange, button[type="submit"]';
const TURNSTILE_WAIT_LOGIN = 7000;
const TURNSTILE_WAIT_OTP = 8000;
/**
 * Perform login with credentials
 */
async function performLogin(client, email, password) {
    const { Page, Runtime } = client;
    // Navigate to login page
    logger_1.logger.info('Navigating to VFS login...');
    await Page.navigate({ url: 'https://visa.vfsglobal.com/ind/en/fra/login' });
    await (0, cdp_helpers_1.sleep)(3000);
    // Wait for and fill form
    await (0, cdp_helpers_1.waitForLoginForm)(Runtime);
    await (0, cdp_helpers_1.fillLoginCredentials)(Runtime, email, password);
    // Disconnect for Turnstile
    logger_1.logger.info('Disconnecting CDP before Turnstile renders...');
    await client.close();
    logger_1.logger.info('✓ CDP disconnected — Turnstile should pass now');
    await (0, cdp_helpers_1.sleep)(TURNSTILE_WAIT_LOGIN);
    // Check Sign In button with retry
    const { clicked, client: newClient } = await (0, cdp_helpers_1.checkButtonWithRetry)(BUTTON_SELECTOR, 'Sign In', 5, 60, 7);
    if (!clicked) {
        logger_1.logger.warn('Sign In button still disabled — attempting reload retry');
        return await retryLoginWithReload(email, password);
    }
    // Wait briefly for VFS to process the login and redirect
    logger_1.logger.info('Waiting for post-Sign In redirect...');
    await (0, cdp_helpers_1.sleep)(4000);
    // Detect if VFS blocked this account (429001 Access Restricted / 429002 Unauthorised Activity)
    const postSignInScreen = await newClient.Runtime.evaluate({
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
    const postSignIn = postSignInScreen.result?.value;
    if (postSignIn?.is429002) {
        logger_1.logger.warn(`[Login] ⚠️  Unauthorised Activity (429002) — URL: ${postSignIn.url}`);
        throw new UnauthorisedActivityError(email);
    }
    if (postSignIn?.is429001) {
        logger_1.logger.warn(`[Login] ⚠️  Account blocked (429001) — URL: ${postSignIn.url}`);
        throw new AccountBlockedError(email);
    }
    return newClient;
}
/**
 * Retry login with page reload
 */
async function retryLoginWithReload(email, password) {
    logger_1.logger.warn('Reloading page to retry (one time)...');
    const client = await (0, cdp_helpers_1.connectCDP)('vfsglobal.com');
    const { Page, Runtime } = client;
    await Page.enable();
    await Runtime.enable();
    await Page.reload();
    await (0, cdp_helpers_1.sleep)(3000);
    await (0, cdp_helpers_1.waitForLoginForm)(Runtime, 10);
    await (0, cdp_helpers_1.fillLoginCredentials)(Runtime, email, password);
    await client.close();
    await (0, cdp_helpers_1.sleep)(TURNSTILE_WAIT_LOGIN);
    const { clicked, client: newClient } = await (0, cdp_helpers_1.checkButtonWithRetry)(BUTTON_SELECTOR, 'Sign In', 5, 60, 7);
    if (!clicked) {
        logger_1.logger.error('Sign In still failed after reload — throwing for orchestrator to handle');
        throw new Error('LOGIN_FAILED_AFTER_RELOAD');
    }
    // Wait briefly for VFS to process the login and redirect
    await (0, cdp_helpers_1.sleep)(4000);
    // Detect if VFS blocked this account (429001 Access Restricted / 429002 Unauthorised Activity)
    const postSignInScreen = await newClient.Runtime.evaluate({
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
    const postSignIn = postSignInScreen.result?.value;
    if (postSignIn?.is429002) {
        logger_1.logger.warn(`[Login] ⚠️  Unauthorised Activity (429002) on reload retry — URL: ${postSignIn.url}`);
        throw new UnauthorisedActivityError(email);
    }
    if (postSignIn?.is429001) {
        logger_1.logger.warn(`[Login] ⚠️  Account blocked (429001) on reload retry — URL: ${postSignIn.url}`);
        throw new AccountBlockedError(email);
    }
    return newClient;
}
/**
 * Handle OTP screen and submission
 */
async function handleOTPScreen(client, email, password) {
    const { Runtime } = client;
    logger_1.logger.info('');
    logger_1.logger.info('════════════════════════════════════════════════════');
    logger_1.logger.info('  Waiting for OTP screen...');
    logger_1.logger.info('════════════════════════════════════════════════════');
    const otpFieldFound = await (0, cdp_helpers_1.waitForOTPField)(Runtime);
    if (!otpFieldFound) {
        logger_1.logger.error('OTP screen not detected — login may have failed');
        throw new Error('OTP screen not found');
    }
    // Disconnect for OTP Turnstile
    logger_1.logger.info('Disconnecting CDP before OTP Turnstile renders...');
    await client.close();
    logger_1.logger.info('✓ CDP disconnected — OTP Turnstile should pass now');
    await (0, cdp_helpers_1.sleep)(TURNSTILE_WAIT_OTP);
    // Fetch OTP from Gmail
    const otp = await fetchOTPWithRetry();
    if (!otp) {
        throw new OtpTimeoutError(email);
    }
    // Reconnect and fill OTP
    logger_1.logger.info('Reconnecting CDP to fill OTP...');
    const newClient = await (0, cdp_helpers_1.connectCDP)('vfsglobal.com');
    await newClient.Runtime.enable();
    await (0, cdp_helpers_1.fillOTPField)(newClient.Runtime, otp);
    await (0, cdp_helpers_1.sleep)(2000); // Wait for Angular to process
    // Check Submit button with retry
    const { clicked, client: finalClient } = await (0, cdp_helpers_1.checkButtonWithRetry)(BUTTON_SELECTOR, 'Submit', 5, 60, 2);
    if (!clicked) {
        logger_1.logger.warn('Submit button still disabled — attempting reload retry');
        return await retryOTPSubmitWithReload(otp, email, password);
    }
    return finalClient;
}
/**
 * Fetch OTP with retry logic
 */
async function fetchOTPWithRetry() {
    logger_1.logger.info('');
    logger_1.logger.info('════════════════════════════════════════════════════');
    logger_1.logger.info('  Fetching OTP from Gmail...');
    logger_1.logger.info('  (checking Gmail API automatically)');
    logger_1.logger.info('════════════════════════════════════════════════════');
    let otp = await (0, gmail_1.waitForOtp)(2 * 60 * 1000);
    if (!otp) {
        logger_1.logger.warn('OTP not received within 2 minutes — waiting 2 more minutes...');
        logger_1.logger.info('(VFS sometimes delays OTP delivery)');
        otp = await (0, gmail_1.waitForOtp)(2 * 60 * 1000);
    }
    if (!otp) {
        logger_1.logger.error('OTP still not received after 4 minutes total');
        logger_1.logger.error('This may indicate an issue with VFS OTP delivery');
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
async function retryOTPSubmitWithReload(otp, email, password) {
    logger_1.logger.warn('Reloading page to retry Submit (one time)...');
    const client = await (0, cdp_helpers_1.connectCDP)('vfsglobal.com');
    const { Page, Runtime } = client;
    await Page.enable();
    await Runtime.enable();
    await Page.reload();
    await (0, cdp_helpers_1.sleep)(3000);
    // Detect which screen we landed on after reload
    const screen = await (0, cdp_helpers_1.detectCurrentScreen)(Runtime);
    logger_1.logger.info(`[OTP retry] Screen after reload: ${screen}`);
    if (screen === 'login') {
        // ----------------------------------------------------------------
        // Reload sent us back to the login page — run the full login flow
        // ----------------------------------------------------------------
        logger_1.logger.warn('[OTP retry] Landed on login screen — re-running login flow');
        await (0, cdp_helpers_1.waitForLoginForm)(Runtime, 10);
        await (0, cdp_helpers_1.fillLoginCredentials)(Runtime, email, password);
        // Disconnect for Turnstile
        logger_1.logger.info('[OTP retry] Disconnecting CDP before Turnstile renders...');
        await client.close();
        await (0, cdp_helpers_1.sleep)(TURNSTILE_WAIT_LOGIN);
        // Click Sign In
        const { clicked: signInClicked, client: signInClient } = await (0, cdp_helpers_1.checkButtonWithRetry)(BUTTON_SELECTOR, 'Sign In', 5, 60, 7);
        if (!signInClicked) {
            logger_1.logger.error('[OTP retry] Sign In still failed after reload — manual intervention required');
            process.exit(1);
        }
        // Wait for OTP screen
        logger_1.logger.info('[OTP retry] Waiting for OTP screen after re-login...');
        const otpFound = await (0, cdp_helpers_1.waitForOTPField)(signInClient.Runtime);
        if (!otpFound) {
            logger_1.logger.error('[OTP retry] OTP screen not found after re-login — manual intervention required');
            process.exit(1);
        }
        // Disconnect for OTP Turnstile
        logger_1.logger.info('[OTP retry] Disconnecting CDP before OTP Turnstile renders...');
        await signInClient.close();
        await (0, cdp_helpers_1.sleep)(TURNSTILE_WAIT_OTP);
        // Fetch a fresh OTP — the previous one is now stale
        logger_1.logger.info('[OTP retry] Fetching fresh OTP from Gmail...');
        const freshOtp = await fetchOTPWithRetry();
        if (!freshOtp) {
            logger_1.logger.error('[OTP retry] Could not fetch fresh OTP — rotating account');
            throw new OtpTimeoutError(email);
        }
        // Reconnect and fill fresh OTP
        const otpClient = await (0, cdp_helpers_1.connectCDP)('vfsglobal.com');
        await otpClient.Runtime.enable();
        await (0, cdp_helpers_1.fillOTPField)(otpClient.Runtime, freshOtp);
        await (0, cdp_helpers_1.sleep)(2000);
        // Submit
        const { clicked: submitClicked, client: finalClient } = await (0, cdp_helpers_1.checkButtonWithRetry)(BUTTON_SELECTOR, 'Submit', 5, 60, 2);
        if (!submitClicked) {
            logger_1.logger.error('[OTP retry] Submit still failed after full re-login — manual intervention required');
            process.exit(1);
        }
        return finalClient;
    }
    else {
        // ----------------------------------------------------------------
        // Still on OTP screen — re-fill the existing OTP and retry Submit
        // ----------------------------------------------------------------
        logger_1.logger.info('[OTP retry] Still on OTP screen — re-filling OTP');
        await (0, cdp_helpers_1.fillOTPField)(Runtime, otp);
        await (0, cdp_helpers_1.sleep)(2000);
        // Disconnect for Turnstile before retrying Submit
        logger_1.logger.info('[OTP retry] Disconnecting CDP before OTP Turnstile renders...');
        await client.close();
        await (0, cdp_helpers_1.sleep)(TURNSTILE_WAIT_OTP);
        const { clicked, client: newClient } = await (0, cdp_helpers_1.checkButtonWithRetry)(BUTTON_SELECTOR, 'Submit', 5, 60, 2);
        if (!clicked) {
            logger_1.logger.error('[OTP retry] Submit still failed after reload — manual intervention required');
            process.exit(1);
        }
        return newClient;
    }
}
/**
 * Wait for redirect away from login page
 */
async function waitForLoginComplete(Runtime) {
    logger_1.logger.info('Waiting for login to complete...');
    for (let i = 0; i < 30; i++) {
        await (0, cdp_helpers_1.sleep)(1000);
        try {
            const urlCheck = await Runtime.evaluate({
                expression: 'location.pathname',
                returnByValue: true,
            });
            const path = String(urlCheck.result?.value ?? '');
            if (!path.includes('/login')) {
                logger_1.logger.info({ path }, '✓ Login complete — redirected away from login');
                return;
            }
        }
        catch {
            // CDP might be disconnected, continue waiting
        }
    }
    logger_1.logger.warn('Login redirect timeout — may still be on login page');
}
//# sourceMappingURL=login-flow.js.map