/**
 * Gmail OTP reader.
 * Reads the latest OTP email from VFS (donotreply@vfshelpline.com)
 * and extracts the 6-digit OTP.
 */
/**
 * Poll Gmail for the latest OTP from VFS.
 * Retries every 3 seconds for up to maxWaitMs.
 */
export declare function waitForOtp(maxWaitMs?: number): Promise<string | null>;
//# sourceMappingURL=gmail.d.ts.map