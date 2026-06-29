/**
 * PM2 ecosystem config for Linux / macOS.
 * Uses __dirname so the repo can be cloned anywhere without editing this file.
 *
 * For Windows use ecosystem.windows.config.js instead (no Xvfb).
 *
 * Usage:
 *   pm2 start ecosystem.config.js
 */

const path = require('path');
const repoRoot = __dirname;

module.exports = {
  apps: [
    {
      // Xvfb — virtual display required on headless Linux servers.
      // Not needed on macOS or Windows (remove this app entry if running locally).
      name: 'xvfb',
      script: '/usr/bin/Xvfb',
      args: ':99 -screen 0 1280x720x24 -ac',
      interpreter: 'none',
      autorestart: true,
    },
    {
      name: 'compus-notifier',
      script: 'npm',
      args: 'start',
      cwd: repoRoot,
      env_file: path.join(repoRoot, '.env'),
      autorestart: true,
      restart_delay: 8000,
      max_restarts: 10,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
