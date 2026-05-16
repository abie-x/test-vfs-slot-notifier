/**
 * Browser factory.
 *
 * LOGIN:   Plain Chrome, no flags → Cloudflare Turnstile passes → saves session.json
 * POLLING: Chrome with --remote-debugging-port=9223 → CDP attaches → passive
 *          Network interception captures CheckIsSlotAvailable responses
 */

import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../utils/logger';

export const LOGIN_USER_DATA_DIR = path.resolve(process.cwd(), 'user-data-login');
export const POLL_USER_DATA_DIR  = path.resolve(process.cwd(), 'user-data-poll');
export const SESSION_FILE        = path.resolve(process.cwd(), 'session.json');

// Keep USER_DATA_DIR as alias for login dir (used by login.ts)
export const USER_DATA_DIR = LOGIN_USER_DATA_DIR;

const CHROME_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VFS_LOGIN_URL     = 'https://visa.vfsglobal.com/ind/en/fra/login';

// Port 9223 avoids conflict with any existing Chrome instance on 9222
export const REMOTE_DEBUG_PORT = 9223;

/**
 * Open Chrome for MANUAL LOGIN — zero automation flags.
 * Cloudflare Turnstile sees a clean browser, login succeeds.
 */
export function openChromeForLogin(): ReturnType<typeof spawn> {
  logger.info('Opening Chrome for manual login (no automation flags)...');

  const proc = spawn(CHROME_EXECUTABLE, [
    `--user-data-dir=${LOGIN_USER_DATA_DIR}`,
    VFS_LOGIN_URL,
  ], { detached: false, stdio: 'ignore' });

  logger.info({ pid: proc.pid }, '✓ Chrome opened for login');
  return proc;
}

/**
 * Open Chrome for POLLING — with remote debugging port.
 * Opens directly to VFS login page. CDP attaches after page loads.
 * No Playwright, no automation flags beyond the debug port.
 */
export function openChromeWithDebugging(): ReturnType<typeof spawn> {
  logger.info('Opening Chrome with remote debugging port...');``

  const proc = spawn(CHROME_EXECUTABLE, [
    `--user-data-dir=${POLL_USER_DATA_DIR}`,
    `--remote-debugging-port=${REMOTE_DEBUG_PORT}`,
    VFS_LOGIN_URL,
  ], { detached: false, stdio: 'ignore' });

  logger.info({ pid: proc.pid, debugPort: REMOTE_DEBUG_PORT }, '✓ Chrome opened for polling');
  return proc;
}
