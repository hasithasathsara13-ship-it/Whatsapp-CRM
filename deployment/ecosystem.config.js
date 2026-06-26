// PM2 Process Manager Configuration
// Usage: pm2 start ecosystem.config.js

module.exports = {
  apps: [
    {
      name: 'whatsapp-crm-server',
      script: './server/index.js',
      cwd: '/home/ubuntu/whatsapp-crm',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 8790
      },
      // Restart policy
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      min_uptime: '10s',
      // Logs
      error_file: '/home/ubuntu/whatsapp-crm/logs/server-error.log',
      out_file: '/home/ubuntu/whatsapp-crm/logs/server-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true
    }
  ]
};
