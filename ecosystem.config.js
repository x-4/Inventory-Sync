// ====================================================================
// Enterprise Microservice Ecosystem Configuration (PM2 Supervisor)
// ====================================================================

module.exports = {
    apps: [{
        name: 'enterprise-inventory-sync',
        script: 'src/server.js',
        instances: 1,
        exec_mode: 'fork',
        autorestart: true,
        watch: false,
        max_memory_restart: '180M',
        env: {
            NODE_ENV: 'production',
            PORT: 3000,
            HOST: '0.0.0.0',
            UV_THREADPOOL_SIZE: 64,
            NODE_OPTIONS: '--max-old-space-size=160'
        },
        kill_timeout: 10000,
        exp_backoff_restart_delay: 1000,
        max_restarts: 100,
        min_uptime: '10s'
    }]
};
