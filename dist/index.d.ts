/**
 * Campus Slot Notifier — Experiment 1 (Session Segmentation Without Proxies)
 *
 * Architecture:
 *   - ONE active session at a time
 *   - ONE Chrome instance at a time
 *   - SESSION_A polls centres 1–9, SESSION_B polls centres 10–18
 *   - 10-minute cooldown between sessions (no browser active)
 *   - 3–4 minute randomized delay between centre changes
 *   - Fully autonomous: loops forever after a single `npm start`
 *
 * Turnstile Strategy: Disconnect/Reconnect Cycle
 *   - Disconnect CDP before Turnstile renders (7s login / 8s OTP)
 *   - Check button status every 60 seconds (5 checks total)
 *   - Reconnect briefly only to check button status
 *
 * Usage: npm start
 */
import 'dotenv/config';
//# sourceMappingURL=index.d.ts.map