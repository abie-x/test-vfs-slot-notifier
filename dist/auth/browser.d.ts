/**
 * Browser lifecycle management.
 *
 * Chrome with --remote-debugging-port=9223 → CDP attaches for automation.
 * Network interception captures CheckIsSlotAvailable responses.
 *
 * Step 2 additions:
 *   - launchChrome()   — spawn Chrome and wait for CDP to be reachable
 *   - shutdownChrome() — SIGTERM → wait for exit → SIGKILL → port cleanup
 *     Guarantees no Chrome process or CDP port survives after shutdown.
 */
import { ChildProcess } from 'child_process';
export declare const POLL_USER_DATA_DIR: string;
export declare const REMOTE_DEBUG_PORT = 9223;
/**
 * Spawn a fresh Chrome instance pointing at the VFS login page.
 * Waits CHROME_STARTUP_WAIT_MS for the process to stabilise before returning.
 *
 * @returns The spawned ChildProcess handle — keep it to pass to shutdownChrome()
 */
export declare function launchChrome(): Promise<ChildProcess>;
/**
 * Fully terminate Chrome and clean up the CDP debug port.
 *
 * Sequence:
 *   1. SIGTERM  — ask Chrome to exit gracefully
 *   2. Wait up to CHROME_GRACEFUL_EXIT_MS for the exit event
 *   3. SIGKILL  — force-kill if still alive
 *   4. Port cleanup — kill any remaining process on REMOTE_DEBUG_PORT via lsof
 *
 * Safe to call even if Chrome has already exited.
 */
export declare function shutdownChrome(proc: ChildProcess): Promise<void>;
//# sourceMappingURL=browser.d.ts.map