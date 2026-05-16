/**
 * VFS Login — run this separately before starting the poller.
 *
 * Opens Chrome with ZERO automation flags so Cloudflare Turnstile passes.
 * You log in manually, press Enter, session is saved to session.json.
 *
 * Usage: npm run login
 */

import 'dotenv/config';
import { logger } from './utils/logger';
import { performManualLogin, hasSavedSession } from './auth/login';
import { SESSION_FILE } from './auth/browser';
import * as fs from 'fs';

async function main(): Promise<void> {
  logger.info('VFS Login — session capture');

  if (hasSavedSession()) {
    logger.info({ sessionFile: SESSION_FILE }, 'Existing session.json found.');
    logger.info('Delete session.json to force a fresh login, or run npm start to begin polling.');

    // Check how old the session is
    const stat = fs.statSync(SESSION_FILE);
    const ageMinutes = Math.round((Date.now() - stat.mtimeMs) / 60000);
    logger.info({ ageMinutes }, 'Session age');

    if (ageMinutes > 60) {
      logger.warn('Session is over 1 hour old — may be expired. Consider re-logging in.');
      logger.warn('Delete session.json and run npm run login again.');
    }

    process.exit(0);
  }

  const success = await performManualLogin();

  if (!success) {
    logger.error('Login failed.');
    process.exit(1);
  }

  logger.info('════════════════════════════════════════════════════');
  logger.info('✓ Session saved. Now run: npm start');
  logger.info('════════════════════════════════════════════════════');
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error');
  process.exit(1);
});
