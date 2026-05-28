/**
 * Standalone Telegram integration test
 *
 * Usage:
 *   npx ts-node src/tools/test-telegram.ts
 *
 * Sends "✅ Compus Telegram integration test" to the configured group.
 * Exits 0 on success, 1 on failure.
 */

import 'dotenv/config';
import { testTelegramIntegration } from '../services/telegram-notifier';

testTelegramIntegration()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(1);
  });
