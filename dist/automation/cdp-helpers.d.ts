/**
 * CDP Helper Functions
 * Reusable utilities for Chrome DevTools Protocol operations
 */
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
export declare function sleep(ms: number): Promise<void>;
/**
 * Connect to Chrome via CDP with retry logic
 */
export declare function connectCDP(filterUrl?: string): Promise<CDPClient>;
/**
 * Wait for login form fields to appear
 */
export declare function waitForLoginForm(Runtime: any, maxAttempts?: number): Promise<boolean>;
/**
 * Fill login credentials using Angular-compatible setter
 */
export declare function fillLoginCredentials(Runtime: any, email: string, password: string): Promise<void>;
/**
 * Check and click button with disconnect/reconnect cycle for Turnstile
 */
export declare function checkButtonWithRetry(buttonSelector: string, buttonName: string, maxChecks?: number, disconnectInterval?: number, initialWait?: number): Promise<{
    clicked: boolean;
    client: CDPClient | null;
}>;
/**
 * Wait for OTP input field to appear
 */
export declare function waitForOTPField(Runtime: any, maxAttempts?: number): Promise<boolean>;
/**
 * Fill OTP field using Angular-compatible setter
 */
export declare function fillOTPField(Runtime: any, otp: string): Promise<void>;
/**
 * Select centre from dropdown
 */
export declare function selectCentre(Runtime: any, centreName: string): Promise<boolean>;
/**
 * Select category from dropdown
 */
export declare function selectCategory(Runtime: any, categoryText: string): Promise<boolean>;
/**
 * Select sub-category from dropdown with detailed logging
 */
export declare function selectSubCategory(Runtime: any, optionText: string): Promise<boolean>;
/**
 * Detect current screen type
 */
export declare function detectCurrentScreen(Runtime: any): Promise<'login' | 'otp' | 'dashboard' | 'unknown'>;
//# sourceMappingURL=cdp-helpers.d.ts.map