/**
 * PM2 ecosystem config for Windows.
 *
 * Differences from ecosystem.config.js (Linux):
 *   - No Xvfb app — Chrome runs in a real window on Windows, no virtual display needed
 *   - cwd uses the current directory (__dirname) instead of a hardcoded Linux path
 *   - env_file path uses __dirname so it resolves wherever the repo is cloned
 *
 * Usage (from the repo root on Windows):
 *   pm2 start ecosystem.windows.config.js
 *   pm2 save
 *   pm2 startup   (follow the printed command to auto-start on boot)
 */

const path = require('path');
const repoRoot = __dirname;

module.exports = {
  apps: [
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
