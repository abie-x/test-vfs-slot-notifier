/**
 * Browser factory.
 *
 * Chrome with --remote-debugging-port=9223 → CDP attaches for automation
 * Network interception captures CheckIsSlotAvailable responses
 */

import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../utils/logger';

export const POLL_USER_DATA_DIR  = path.resolve(process.cwd(), 'user-data-poll');

const CHROME_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VFS_LOGIN_URL     = 'https://visa.vfsglobal.com/ind/en/fra/login';

// Port 9223 avoids conflict with any existing Chrome instance on 9222
export const REMOTE_DEBUG_PORT = 9223;

/**
 * Open Chrome for POLLING — with remote debugging port.
 * Opens directly to VFS login page. CDP attaches after page loads.
 * No Playwright, no automation flags beyond the debug port.
 */
export function openChromeWithDebugging(): ReturnType<typeof spawn> {
  logger.info('Opening Chrome with remote debugging port...');

  const proc = spawn(CHROME_EXECUTABLE, [
    `--user-data-dir=${POLL_USER_DATA_DIR}`,
    `--remote-debugging-port=${REMOTE_DEBUG_PORT}`,
    VFS_LOGIN_URL,
  ], { detached: false, stdio: 'ignore' });

  logger.info({ pid: proc.pid, debugPort: REMOTE_DEBUG_PORT }, '✓ Chrome opened for polling');
  return proc;
}
