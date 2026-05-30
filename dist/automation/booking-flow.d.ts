/**
 * Booking Flow Automation
 * Handles booking page navigation and slot polling.
 *
 * The orchestrator in session-orchestrator.ts drives a single-pass poll
 * per session via pollSingleCentre() called directly from index.ts.
 */
import { CDPClient } from './cdp-helpers';
import { CentreConfig } from '../config/centres.config';
/**
 * Click "Start New Booking" button
 */
export declare function clickStartNewBooking(Runtime: any): Promise<boolean>;
/**
 * Setup booking page - just wait for page to be ready
 */
export declare function setupBookingPage(Runtime: any): Promise<void>;
/**
 * Setup network monitoring for slot API calls
 */
export declare function setupNetworkMonitoring(client: CDPClient, onSlotData: (data: {
    earliestDate: string;
    slots: number;
    status: number;
    pollCount: number;
    rawData: any;
}) => void): void;
/**
 * Poll a single centre for slot availability
 */
export declare function pollSingleCentre(Runtime: any, centre: CentreConfig, centreIndex: number, totalCentres: number): Promise<void>;
//# sourceMappingURL=booking-flow.d.ts.map