module.exports = {
  apps: [
    {
      name:             'fratoo-bridge',
      script:           'dist/main.js',

      // Keep a single instance — the TCP server binds one port; cluster mode
      // would cause EADDRINUSE on all workers after the first.
      instances:        1,
      exec_mode:        'fork',

      // Restart automatically, but back off after repeated failures.
      autorestart:      true,
      restart_delay:    3000,   // ms between restarts
      max_restarts:     10,
      min_uptime:       5000,   // must stay up ≥5 s to count as a clean start

      // Restart if the process leaks past this threshold.
      max_memory_restart: '256M',

      env_production: {
        NODE_ENV: 'production',
      },

      // Structured timestamps in PM2 logs.
      log_date_format:  'YYYY-MM-DD HH:mm:ss.SSS',
      merge_logs:       true,

      // On Windows Server, PM2 writes logs here by default:
      //   %USERPROFILE%\.pm2\logs\fratoo-bridge-out.log
      //   %USERPROFILE%\.pm2\logs\fratoo-bridge-error.log
      // Override with absolute paths if you prefer a specific location, e.g.:
      // out_file:  'C:/logs/fratoo-bridge-out.log',
      // error_file: 'C:/logs/fratoo-bridge-error.log',
    },
  ],
};
