"use strict";
/**
 * Standalone Telegram integration test
 *
 * Usage:
 *   npx ts-node src/tools/test-telegram.ts
 *
 * Sends "✅ Compus Telegram integration test" to the configured group.
 * Exits 0 on success, 1 on failure.
 */
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const telegram_notifier_1 = require("../services/telegram-notifier");
(0, telegram_notifier_1.testTelegramIntegration)()
    .then(() => process.exit(0))
    .catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(1);
});
//# sourceMappingURL=test-telegram.js.map