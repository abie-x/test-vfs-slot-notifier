/**
 * Account Manager — Account Rotation to Avoid "Too Many Logins" Error
 *
 * VFS Global blocks accounts after ~9 logins in 4 hours.
 * Strategy: rotate between 3 accounts after each full sweep (18 centres = 3 sessions).
 *
 * Redis keys:
 *   account:current_index — 0, 1, or 2 (which account is currently active)
 *   account:sweep_count   — number of sessions completed in current sweep
 *
 * Rotation logic:
 *   - 1 full sweep = 3 sessions (SESSION_A → SESSION_B → SESSION_C)
 *   - After SESSION_C completes, rotate to next account (0 → 1 → 2 → 0)
 *   - Account 1 does 1 sweep → Account 2 does 1 sweep → Account 3 does 1 sweep → repeat
 */
interface AccountCredentials {
    email: string;
    password: string;
}
/**
 * Get the credentials for the currently active account.
 * Returns { email, password } for the current account.
 */
export declare function getCurrentAccount(): Promise<AccountCredentials>;
/**
 * Increment session counter and check if we should rotate accounts.
 * Call this after each session completes successfully.
 *
 * Returns true if account was rotated, false otherwise.
 */
export declare function incrementSessionAndCheckRotation(): Promise<boolean>;
/**
 * Get current rotation status for logging/debugging.
 */
export declare function getRotationStatus(): Promise<{
    currentAccountIndex: number;
    currentEmail: string;
    sweepProgress: string;
}>;
export {};
//# sourceMappingURL=account-manager.d.ts.map