/**
 * VFS France Centre Configuration
 *
 * This file maps all 18 VFS France centres across India to their exact
 * dropdown text for Application Centre, Appointment Category, and Appointment Subcategory.
 *
 * CRITICAL: Text must match EXACTLY (case-sensitive, spaces, punctuation)
 * Angular Material dropdowns use strict === matching.
 *
 * How to update this config:
 * 1. Open VFS booking page in a clean browser
 * 2. For each centre, select it from the dropdown
 * 3. Copy the EXACT text from category and subcategory dropdowns
 * 4. Update the config below
 *
 * Note: Only tourism visa subcategories are configured.
 * Other visa types can be added later if needed.
 */
export interface CentreConfig {
    /** Exact text from Application Centre dropdown */
    name: string;
    /**
     * Exact text from Appointment Category dropdown.
     * Set to null if category auto-selects (only one option available).
     */
    category: string | null;
    /**
     * Exact text from Appointment Subcategory dropdown for tourism visa.
     * This is what triggers the CheckIsSlotAvailable API call.
     */
    subcategory: string;
}
/**
 * All 18 VFS France centres in India
 *
 * TODO: Fill in exact dropdown text for each centre by manually testing
 * Current data is placeholder — needs verification from actual booking page
 */
export declare const CENTRES: CentreConfig[];
//# sourceMappingURL=centres.config.d.ts.map