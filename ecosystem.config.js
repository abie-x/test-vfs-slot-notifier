module.exports = {
  apps: [
    {
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
      cwd: '/home/compus/campus-slot-notifier',
      env_file: '/home/compus/campus-slot-notifier/.env',
      autorestart: true,
      restart_delay: 8000,
      max_restarts: 10,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
