/**
 * Manual login flow using a plain Chrome process (zero Playwright involvement).
 *
 * Flow:
 * 1. Open Chrome normally (via child_process) — no CDP, no automation flags
 * 2. User logs in manually — Turnstile sees a real browser
 * 3. User presses Enter in terminal when done
 * 4. We read + decrypt cookies using chrome-cookies-secure (handles macOS Keychain)
 * 5. Save as session.json for Playwright polling phase
 */

import * as fs from 'fs';
import * as readline from 'readline';
import { logger } from '../utils/logger';
import { USER_DATA_DIR, SESSION_FILE, openChromeForLogin } from './browser';
import path from 'path';

// chrome-cookies-secure handles macOS Keychain decryption automatically
// eslint-disable-next-line @typescript-eslint/no-require-imports
const chromeCookies = require('chrome-cookies-secure');

const CHROME_DEFAULT_DIR = path.join(USER_DATA_DIR, 'Default');

type PlaywrightCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
};

/**
 * Wait for the user to press Enter in the terminal.
 */
function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

/**
 * Read and decrypt VFS cookies from Chrome profile using chrome-cookies-secure.
 * Handles macOS Keychain decryption automatically.
 */
async function readDecryptedCookies(): Promise<PlaywrightCookie[]> {
  return new Promise((resolve, reject) => {
    chromeCookies.getCookies(
      'https://visa.vfsglobal.com',
      'puppeteer',
      (err: Error | null, cookies: Array<Record<string, unknown>>) => {
        if (err) return reject(err);

        const normalized: PlaywrightCookie[] = cookies.map((c) => ({
          name: String(c.name ?? ''),
          value: String(c.value ?? ''),
          domain: String(c.domain ?? '.vfsglobal.com'),
          path: String(c.path ?? '/'),
          expires: normalizeExpiry(c.expires),
          httpOnly: Boolean(c.HttpOnly ?? c.httpOnly ?? false),
          secure: Boolean(c.Secure ?? c.secure ?? false),
          sameSite: normalizeSameSite(c.sameSite ?? c.SameSite),
        }));

        resolve(normalized);
      },
      CHROME_DEFAULT_DIR
    );
  });
}

function normalizeExpiry(raw: unknown): number {
  if (!raw || raw === 0) return -1;
  const n = Number(raw);
  // WebKit timestamp: microseconds since Jan 1, 1601 — very large number
  if (n > 1e15) {
    const EPOCH_DIFF = 11644473600;
    return Math.floor(n / 1_000_000) - EPOCH_DIFF;
  }
  return Math.floor(n);
}

function normalizeSameSite(raw: unknown): 'Strict' | 'Lax' | 'None' {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'strict') return 'Strict';
  if (s === 'lax') return 'Lax';
  return 'None';
}

/**
 * Save cookies as a Playwright storageState file.
 */
function saveSessionFile(cookies: PlaywrightCookie[]): void {
  const storageState = { cookies, origins: [] };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(storageState, null, 2));
  const names = cookies.map((c) => c.name);
  logger.info({ sessionFile: SESSION_FILE, cookieCount: cookies.length, names }, '✓ Session saved');
}

/**
 * Main login orchestrator.
 * Opens Chrome, waits for manual login, reads cookies, saves session.
 */
export async function performManualLogin(): Promise<boolean> {
  logger.info('════════════════════════════════════════════════════');
  logger.info('  Opening Chrome as a NORMAL browser (no automation)');
  logger.info('════════════════════════════════════════════════════');

  const chromeProc = openChromeForLogin();

  logger.info('');
  logger.info('  Chrome is now open. Please:');
  logger.info('  1. Log in with your email and password');
  logger.info('  2. Complete Cloudflare verification');
  logger.info('  3. Enter OTP if prompted');
  logger.info('  4. Wait until you see the VFS dashboard/home page');
  logger.info('');

  await waitForEnter('  >>> Press ENTER here once you are fully logged in <<<\n');

  logger.info('Closing Chrome to release cookie database lock...');
  chromeProc.kill();

  // Give Chrome a moment to flush and close cleanly
  await new Promise((r) => setTimeout(r, 2_000));

  logger.info('Reading and decrypting cookies from Chrome profile...');

  try {
    const cookies = await readDecryptedCookies();

    if (cookies.length === 0) {
      logger.error('No VFS cookies found. Did login complete successfully?');
      return false;
    }

    const hasSession = cookies.some((c) => c.name === 'lt_sn' || c.name === 'cf_clearance');
    if (!hasSession) {
      logger.warn('Key session cookies (lt_sn, cf_clearance) not found — session may be incomplete');
    }

    saveSessionFile(cookies);
    return true;

  } catch (err) {
    logger.error({ err }, 'Failed to read cookies from Chrome profile');
    return false;
  }
}

/**
 * Check if a saved session file exists on disk.
 */
export function hasSavedSession(): boolean {
  return fs.existsSync(SESSION_FILE);
}
