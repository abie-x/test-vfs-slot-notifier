/**
 * Session Orchestrator — Experiment 1 (Session Segmentation Without Proxies)
 *
 * Manages the autonomous SESSION_A → cooldown → SESSION_B → cooldown →
 * SESSION_C → cooldown → SESSION_A loop.
 * Only ONE session and ONE Chrome instance may exist at any time.
 *
 * Redis keys:
 *   session:phase               — "SESSION_A" | "SESSION_B" | "SESSION_C"
 *   session:cooldown_until      — epoch ms (number stored as string)
 *   session:consecutive_failures — integer; resets to 0 on success
 *
 * Session batches (6 centres each — stays well under VFS 30-min booking timeout):
 *   SESSION_A → centres index 0–5  (centres 1–6)
 *   SESSION_B → centres index 6–11 (centres 7–12)
 *   SESSION_C → centres index 12–17 (centres 13–18)
 *
 * Why 6 per session:
 *   6 centres × ~3.5 min avg delay = ~21 min — 9 min buffer before the
 *   VFS booking journey 30-min inactivity timeout.
 *
 * Cooldown between sessions: COOLDOWN_MS (default 10 minutes)
 */
export type SessionPhase = 'SESSION_A' | 'SESSION_B' | 'SESSION_C';
export interface OrchestratorCallbacks {
    /**
     * Called once per session cycle with the phase and centre slice to poll.
     * The callback is responsible for launching Chrome, logging in, polling,
     * and fully shutting down Chrome before returning.
     *
     * @param phase       Current session phase
     * @param centreSlice Indices [start, end) into the CENTRES array
     */
    runSession: (phase: SessionPhase, centreSlice: [number, number]) => Promise<void>;
}
/**
 * Centre index slices for each phase (6 centres each).
 * SESSION_A: centres 1–6   (index 0–5)
 * SESSION_B: centres 7–12  (index 6–11)
 * SESSION_C: centres 13–18 (index 12–17)
 *
 * 6 per session keeps total booking page time ~21 min,
 * safely under VFS's 30-min inactivity timeout.
 */
export declare const PHASE_CENTRE_SLICES: Record<SessionPhase, [number, number]>;
/**
 * Start the autonomous orchestration loop.
 * Runs forever: SESSION_A → cooldown → SESSION_B → cooldown → SESSION_C → cooldown → SESSION_A → ...
 *
 * Recovery behaviour:
 *   - Startup: kills any stale Chrome on port 9223 from a previous crash
 *   - Startup: resumes any in-progress cooldown from Redis
 *   - Startup: reads last persisted phase from Redis
 *   - Per session: one automatic retry before accepting failure
 *   - Per failure: increments consecutive failure counter
 *   - After 3+ consecutive failures: switches to extended (20 min) cooldown
 *   - Process level: uncaughtException / unhandledRejection never kill the loop
 */
export declare function startOrchestrationLoop(callbacks: OrchestratorCallbacks): Promise<void>;
//# sourceMappingURL=session-orchestrator.d.ts.map