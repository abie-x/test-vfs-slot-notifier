/**
 * Login Flow Automation
 * Handles the complete VFS login process with Turnstile bypass
 */
import { CDPClient } from './cdp-helpers';
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