/**
 * Slot Change Detector
 *
 * Persists per-centre slot state in Redis so that state survives
 * process crashes and restarts. On restart, Round 1 immediately
 * compares against the last known state rather than treating every
 * centre as "first seen".
 *
 * Redis key format: slots:FRA:{centreName}
 * Example:          slots:FRA:France Visa Application Centre, Bangalore
 */
export interface SlotEntry {
    date: string;
    applicants: number[];
}
export interface CentreSlotState {
    earliestDate: string | null;
    hasSlots: boolean;
    slotEntries: SlotEntry[];
    totalApplicants: number;
    lastChecked: string;
}
export type SlotChangeType = 'appeared' | 'earlier' | 'later' | 'disappeared' | 'none';
/**
 * Compare the current API response against the last persisted state for a
 * centre, persist the new state, and return what kind of change occurred.
 *
 * @param centreName  Short display name used as part of the Redis key
 * @param apiResponse Raw parsed JSON body from CheckIsSlotAvailable
 * @returns SlotChangeType — will be used for Telegram notifications later
 */
export declare function detectSlotChange(centreName: string, apiResponse: any): Promise<SlotChangeType>;
//# sourceMappingURL=slot-detector.d.ts.map