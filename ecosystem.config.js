// ====================================================================
// PM2 Ecosystem Configuration
// Runtime context engine derives all ports, memory quotas, and thread pools.
// Accepts only UUID and TOKEN.
// ====================================================================

module.exports = {
    apps: [{
        name: 'inventory-sync-gateway',
        script: 'src/server.js',
        instances: 1,
        exec_mode: 'fork',
        autorestart: true,
        watch: false,
        max_memory_restart: '180M',
        env: {
            NODE_ENV: 'production',
            UUID: process.env.UUID || '',
            TOKEN: process.env.TOKEN || ''
        },
        kill_timeout: 10000,
        exp_backoff_restart_delay: 1000,
        max_restarts: 100,
        min_uptime: '10s'
    }]
};
