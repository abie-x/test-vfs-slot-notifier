/**
 * Login Flow Automation
 * Handles the complete VFS login process with Turnstile bypass
 */
import { CDPClient } from './cdp-helpers';
/** Thrown when VFS shows "Access Restricted for User ID (429001)" after Sign In */
export declare class AccountBlockedError extends Error {
    constructor(email: string);
}
/** Thrown when VFS shows "Access Denied Due to Unauthorised Activity (429002)" after Sign In */
export declare class UnauthorisedActivityError extends Error {
    constructor(email: string);
}
/** Thrown when OTP is not received from Gmail after all retry attempts */
export declare class OtpTimeoutError extends Error {
    constructor(email: string);
}
/**
 * Perform login with credentials
 */
export declare function performLogin(client: CDPClient, email: string, password: string): Promise<CDPClient>;
/**
 * Handle OTP screen and submission
 */
export declare function handleOTPScreen(client: CDPClient, email: string, password: string): Promise<CDPClient>;
/**
 * Wait for redirect away from login page
 */
export declare function waitForLoginComplete(Runtime: any): Promise<void>;
//# sourceMappingURL=login-flow.d.ts.map