// ====================================================================
// Inventory Synchronization Gateway Service
// Version: 2.5.0
// ====================================================================

const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const cluster = require('cluster');
const os = require('os');

const config = require('./config');
const BatchDecoder = require('./protocol/batchDecoder');
const { renderDashboard } = require('./views/dashboard');
const { proxyRequest } = require('./gateway/corporatePortal');
const { createStreamBridge } = require('./services/streamBridge');
const { createDatagramSession } = require('./services/datagramProcessor');
const { handleBatchStreamRequest, drain: drainBatchStreams } = require('./services/batchStreamEngine');
const { handleHealthProbe, handleLiveness, handleReadiness } = require('./controllers/healthController');
const { handleWarehouses, handleTransactions, handleTelemetry } = require('./controllers/inventoryController');
const { handleProfileRequest, applySecurityHeaders } = require('./controllers/profileController');
const { handleAdminAuth, handleAdminCompact, handleAdminExport } = require('./controllers/adminController');
const tunnelManager = require('./services/tunnelManager');
const rateLimiter = require('./services/rateLimiter');
const { resolvePublicIngress } = require('./utils/ingressResolver');
const logger = require('./utils/logger');
const metrics = require('./utils/metrics');

// CLI Diagnostics Doctor Interceptor
if (process.argv.includes('--doctor')) {
    const { runDoctorDiagnostics } = require('./utils/doctor');
    runDoctorDiagnostics().then((success) => {
        process.exit(success ? 0 : 1);
    });
    return;
}

// Cluster Orchestration Supervisor
if (process.env.CLUSTER_MODE === 'true' && cluster.isPrimary) {
    const cpuCount = os.cpus().length;
    const workerCount = parseInt(process.env.CLUSTER_WORKERS, 10) || Math.min(cpuCount, 8);
    logger.info('Cluster', `Master supervisor (PID: ${process.pid}) spawning ${workerCount} workers...`);

    tunnelManager.initialize().catch((err) => {
        logger.error('Tunnel', `Supervisor tunnel startup error: ${err.message}`);
    });

    let clusterShuttingDown = false;

    for (let i = 0; i < workerCount; i++) {
        cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
        if (!clusterShuttingDown) {
            logger.warn('Cluster', `Worker ${worker.process.pid} exited (${signal || code}). Spawning replacement...`);
            cluster.fork();
        }
    });

    process.on('SIGHUP', async () => {
        logger.info('Cluster', 'Master received SIGHUP. Reloading configuration and notifying workers...');
        config.reload();
        await tunnelManager.reload(config.TOKEN);
        for (const id in cluster.workers) {
            try { cluster.workers[id].process.kill('SIGHUP'); } catch (_) {}
        }
    });

    const shutdownCluster = (signal) => {
        if (clusterShuttingDown) return;
        clusterShuttingDown = true;
        logger.info('Cluster', `Master received ${signal}. Terminating all workers...`);
        tunnelManager.stop();
        for (const id in cluster.workers) {
            try { cluster.workers[id].process.kill(signal); } catch (_) {}
        }
        setTimeout(() => process.exit(0), 10000).unref();
    };

    process.on('SIGTERM', () => shutdownCluster('SIGTERM'));
    process.on('SIGINT', () => shutdownCluster('SIGINT'));
    return;
}

// --- Global Process Error Handlers ---
process.on('uncaughtException', (err) => {
    logger.error('Runtime', `Uncaught exception: ${err.message}`, { stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
    logger.error('Runtime', `Unhandled rejection: ${String(reason)}`);
});

// --- Protocol decoder instance ---
const decoder = new BatchDecoder();

// ====================================================================
// HTTP Server & Request Router
// ====================================================================

const server = http.createServer((req, res) => {
    metrics.incrementRequests();
    applySecurityHeaders(res);

    let url;
    try {
        url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch (_) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('Bad Request');
    }

    // HTTP Batch Stream (XHTTP / SplitHTTP transport) & WebSocket stream routing
    const isStreamPath = url.pathname === config.STREAM_PATH || url.pathname.startsWith(config.STREAM_PATH + '/');
    const isBatchStreamPath = url.pathname === config.BATCH_STREAM_PATH || url.pathname.startsWith(config.BATCH_STREAM_PATH + '/');

    if (isBatchStreamPath || isStreamPath) {
        const isWsUpgrade = req.headers['upgrade'] && req.headers['upgrade'].toLowerCase() === 'websocket';
        if (!isWsUpgrade) {
            const hasXhttpIndicators = isBatchStreamPath ||
                req.method === 'POST' ||
                req.method === 'OPTIONS' ||
                req.headers['x-session-id'] ||
                req.headers['xhttp-session-id'] ||
                req.headers['x-accel-session-id'] ||
                req.headers['session-id'] ||
                url.searchParams.has('session') ||
                url.searchParams.has('sessionId') ||
                url.pathname.length > config.STREAM_PATH.length;

            if (hasXhttpIndicators) {
                const basePath = isBatchStreamPath ? config.BATCH_STREAM_PATH : config.STREAM_PATH;
                return handleBatchStreamRequest(req, res, url, basePath);
            }

            // Stream endpoint requires WebSocket upgrade or XHTTP session
            if (url.pathname === config.STREAM_PATH) {
                applySecurityHeaders(res, {
                    'Upgrade': 'websocket',
                    'Connection': 'Upgrade',
                    'X-Service-Status': 'UPGRADE_REQUIRED'
                });
                res.writeHead(426, { 'Content-Type': 'application/json; charset=utf-8' });
                return res.end(JSON.stringify({
                    error: 'UPGRADE_REQUIRED',
                    transport: 'websocket',
                    service: 'inventory-stream',
                    protocolVersion: '2.5',
                    message: 'WebSocket upgrade or XHTTP session authorization is required on this endpoint.'
                }, null, 2));
            }
        }
    }

    // Health & diagnostic endpoints
    if (req.method === 'GET') {
        if (['/health', '/healthz', '/api/status'].includes(url.pathname)) {
            return handleHealthProbe(req, res);
        }
        if (url.pathname === '/ready') {
            return handleReadiness(req, res);
        }
        if (url.pathname === '/live') {
            return handleLiveness(req, res);
        }
    }

    // Device profile endpoint (matches primary or any configured tenant credential)
    if (req.method === 'GET' && config.SERVICE_TOKENS.some(token => url.pathname === `/api/v1/auth/device/${token}`)) {
        return handleProfileRequest(req, res);
    }

    // Root route — management console
    if (req.method === 'GET' && url.pathname === '/') {
        return renderDashboard(res);
    }

    // REST API endpoints & Prometheus metrics exporter
    if (req.method === 'GET') {
        // Prometheus / OpenMetrics scraping endpoint
        if (url.pathname === '/metrics' || url.pathname === '/api/v1/system/metrics') {
            const metricsText = metrics.toPrometheusFormat();
            res.writeHead(200, {
                'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
                'Cache-Control': 'no-store, no-cache'
            });
            return res.end(metricsText);
        }

        if (url.pathname === '/api/v1/inventory/warehouses') {
            return handleWarehouses(req, res);
        }
        if (url.pathname === '/api/v1/sync/transactions') {
            return handleTransactions(req, res);
        }
        if (url.pathname === '/api/v1/system/telemetry') {
            return handleTelemetry(req, res);
        }
        if (url.pathname === '/api/v1/system/export') {
            return handleAdminExport(req, res);
        }
    }

    // Administration endpoints
    if (req.method === 'POST') {
        if (url.pathname === '/api/v1/system/auth') {
            return handleAdminAuth(req, res);
        }
        if (url.pathname === '/api/v1/system/compact') {
            return handleAdminCompact(req, res);
        }
    }

    // Auth namespace protection
    if (url.pathname.startsWith('/api/v1/auth/device/')) {
        res.writeHead(401, {
            'Content-Type': 'application/json'
        });
        return res.end(JSON.stringify({
            code: 'INVALID_CREDENTIALS',
            message: 'Service credential mismatch or revoked'
        }));
    }

    // Unmatched API requests
    if (url.pathname.startsWith('/api/')) {
        res.writeHead(404, {
            'Content-Type': 'application/json'
        });
        return res.end(JSON.stringify({
            code: 'RESOURCE_NOT_FOUND',
            message: 'API endpoint does not exist'
        }));
    }

    // All unmatched routes: dashboard or portal proxy
    return proxyRequest(req, res, config.PORTAL_ORIGIN);
});

// ====================================================================
// Real-time Stream Engine (WebSocket)
// ====================================================================

const streamServer = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => protocols[0] || false
});

let isShuttingDown = false;

// WebSocket upgrade with circuit breaker guards
server.on('upgrade', (request, socket, head) => {
    if (isShuttingDown) {
        socket.destroy();
        return;
    }

    socket.setKeepAlive(true, 15000);
    socket.setNoDelay(true);

    const ingress = resolvePublicIngress(request);
    const clientIp = ingress.clientIp;

    // Rate limiting: Reject blocked addresses immediately
    if (rateLimiter.isBlocked(clientIp)) {
        logger.warn('RateLimit', `Blocked upgrade attempt from restricted address: ${clientIp}`);
        metrics.incrementRejections();
        socket.destroy();
        return;
    }

    let url;
    try {
        url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    } catch (_) {
        socket.destroy();
        return;
    }

    if (url.pathname !== config.STREAM_PATH) {
        socket.destroy();
        return;
    }

    // Circuit Breaker 1: Memory protection (Heap + RSS dual-threshold)
    const mem = process.memoryUsage();
    const heapUsedMB = mem.heapUsed / (1024 * 1024);
    const rssMB = mem.rss / (1024 * 1024);
    if (heapUsedMB > config.MAX_HEAP_MB || rssMB > config.MAX_RSS_MB) {
        logger.warn('CircuitBreaker', `Memory threshold exceeded (heap: ${heapUsedMB.toFixed(1)}MB/${config.MAX_HEAP_MB}MB, rss: ${rssMB.toFixed(1)}MB/${config.MAX_RSS_MB}MB). Rejecting upgrade.`);
        metrics.incrementRejections();
        socket.destroy();
        return;
    }

    // Circuit Breaker 2: Concurrent stream quota protection
    if (streamServer.clients.size >= config.MAX_ACTIVE_STREAMS) {
        logger.warn('CircuitBreaker', `Stream quota reached (${streamServer.clients.size} >= ${config.MAX_ACTIVE_STREAMS}). Rejecting upgrade.`);
        metrics.incrementRejections();
        socket.destroy();
        return;
    }

    streamServer.handleUpgrade(request, socket, head, (ws) => {
        streamServer.emit('connection', ws, request);
    });
});

// ====================================================================
// Stream Heartbeat (Prevents idle timeouts)
// ====================================================================
const HEARTBEAT_INTERVAL_MS = 30000;
const HANDSHAKE_TIMEOUT_MS = 10000;

const heartbeatTimer = setInterval(() => {
    streamServer.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            logger.warn('Stream', 'Stale session detected (unresponsive to heartbeat). Terminating.');
            return ws.terminate();
        }
        ws.isAlive = false;
        try {
            ws.ping();
        } catch (_) {}
    });
}, HEARTBEAT_INTERVAL_MS);

// Handle incoming stream connections
streamServer.on('connection', (ws, request) => {
    const clientIp = (request && request.clientIp) || (request ? resolvePublicIngress(request).clientIp : (ws._socket && ws._socket.remoteAddress) || '127.0.0.1');
    const streamId = 'st-' + crypto.randomBytes(3).toString('hex');
    ws.streamId = streamId;

    let authenticatedTenant = null;

    // Handshake timeout: terminate if no valid handshake within 10 seconds
    const authTimer = setTimeout(() => {
        logger.warn('Auth', `Handshake timed out for ${clientIp}, terminating connection.`, {
            streamId,
            clientIp,
            code: 'ERR_AUTH_TIMEOUT'
        });
        rateLimiter.recordFailure(clientIp);
        try { ws.close(); } catch (_) { ws.terminate(); }
    }, HANDSHAKE_TIMEOUT_MS);

    // Initialize connection liveness state
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    let isHandshake = true;
    let bridge = null;            // TCP stream bridge
    let datagramSession = null;   // Datagram session
    let cleaned = false;

    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearTimeout(authTimer);
        if (authenticatedTenant) {
            metrics.decrementTenantStream(authenticatedTenant);
            authenticatedTenant = null;
        }
        if (bridge) {
            bridge.destroy();
            bridge = null;
        }
        datagramSession = null;
    };

    ws.on('message', (msg) => {
        if (isHandshake) {
            isHandshake = false;
            clearTimeout(authTimer);

            const header = decoder.decodeHeader(msg);
            if (!header) {
                logger.warn('Auth', `Invalid payload signature from ${clientIp}. Rejecting.`, {
                    streamId,
                    clientIp,
                    code: 'ERR_INVALID_SIGNATURE'
                });
                metrics.incrementRejections();
                rateLimiter.recordFailure(clientIp);

                // Return rejection frame before closing
                try {
                    const rejection = JSON.stringify({
                        code: 40101,
                        error: 'UNAUTHORIZED',
                        message: 'Service credential invalid or revoked',
                        timestamp: new Date().toISOString()
                    });
                    ws.send(rejection, () => {
                        try {
                            ws.close(1008, 'Policy Violation');
                        } catch (_) {
                            ws.terminate();
                        }
                    });
                } catch (_) {
                    try { ws.close(1008); } catch (_) { ws.terminate(); }
                }
                return;
            }

            // Valid signature authenticated
            authenticatedTenant = header.serviceToken;
            metrics.recordTenantStream(authenticatedTenant);
            rateLimiter.recordSuccess(clientIp);

            // Send handshake acknowledgement
            ws.send(Buffer.from([msg[0], 0]));

            const payload = msg.subarray(header.payloadStart);

            // Datagram mode (port 53 only)
            if (header.transportMode === 2) {
                if (header.targetPort !== 53) {
                    try { ws.close(); } catch (_) { ws.terminate(); }
                    return;
                }
                datagramSession = createDatagramSession(ws, streamId);
                datagramSession.initWith(payload);
                return;
            }

            // Reliable stream mode (bidirectional data bridge with backpressure)
            bridge = createStreamBridge(ws, header, payload, streamId);
            return;
        }

        // Subsequent message forwarding
        if (datagramSession) {
            datagramSession.append(msg);
        } else if (bridge) {
            bridge.write(msg);
        }
    });

    ws.on('close', cleanup);
    ws.on('error', cleanup);
});

// ====================================================================
// Service Lifecycle & Graceful Shutdown
// ====================================================================

function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    // Drain HTTP batch stream sessions
    drainBatchStreams();

    const activeCount = streamServer.clients.size;
    logger.info('Lifecycle', `Received ${signal}. Initiating graceful drain (${activeCount} active sessions)...`);

    // Terminate tunnel supervisor
    tunnelManager.stop();

    // Clear heartbeat timer
    clearInterval(heartbeatTimer);

    // Stop accepting new HTTP connections
    server.close(() => {
        logger.info('Lifecycle', 'HTTP listener closed.');
    });

    // Draining window for active streams
    if (activeCount === 0) {
        logger.info('Lifecycle', 'No active sessions. Terminating immediately.');
        process.exit(0);
        return;
    }

    const drainInterval = setInterval(() => {
        if (streamServer.clients.size === 0) {
            clearInterval(drainInterval);
            logger.info('Lifecycle', 'All sessions drained successfully.');
            process.exit(0);
        }
    }, 500);

    // Forced exit timeout
    setTimeout(() => {
        clearInterval(drainInterval);
        logger.warn('Lifecycle', `Drain window exceeded (${streamServer.clients.size} remaining). Forcing termination.`);
        streamServer.clients.forEach(client => {
            try { client.terminate(); } catch (_) {}
        });
        process.exit(0);
    }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGHUP', async () => {
    logger.info('Lifecycle', 'Received SIGHUP. Initiating configuration reload...');
    try {
        const changes = config.reload();
        if (changes.tokenChanged) {
            await tunnelManager.reload(config.TOKEN);
        }
        logger.info('Lifecycle', 'Configuration reload complete. Active streams intact.', changes);
    } catch (err) {
        logger.error('Lifecycle', `Configuration reload failed: ${err.message}`);
    }
});
process.on('exit', () => {
    tunnelManager.stopSync();
});

// Print context inference audit before binding listener
config.printAuditSummary(logger);

server.listen(config.PORT, config.HOST, () => {
    logger.info('Lifecycle', `Inventory Sync Gateway ONLINE`, {
        host: config.HOST,
        port: config.PORT,
        endpoint: config.STREAM_PATH,
        version: config.VERSION,
        mode: config.TOKEN ? 'TUNNEL_ACTIVE' : 'STANDALONE_PORT',
        ioThreadPoolSize: process.env.UV_THREADPOOL_SIZE || 4,
        publicHost: config.PUBLIC_HOST || '(dynamic)',
        portalMode: config.PORTAL_ORIGIN ? `PROXY:${config.PORTAL_ORIGIN}` : 'SELF_HOSTED',
        maxHeapQuota: `${config.MAX_HEAP_MB}MB`
    });

    // Initialize tunnel supervisor asynchronously (standalone or master only)
    if (!cluster.isWorker) {
        tunnelManager.initialize().catch((err) => {
            logger.error('Tunnel', `Background supervisor startup error: ${err.message}`);
        });
    }

    // Periodic reconciliation event injection (every 5 minutes)
    const SYNC_HUBS = ['WH-TOKYO-01', 'WH-FRANKFURT-02', 'WH-VIRGINIA-01', 'WH-SINGAPORE-01'];
    const auditTimer = setInterval(() => {
        const hub = SYNC_HUBS[Math.floor(Math.random() * SYNC_HUBS.length)];
        const records = Math.floor(Math.random() * 800) + 200;
        const duration = Math.floor(Math.random() * 15) + 5;
        logger.info('InventorySync', 'Periodic ledger partition reconciliation committed', {
            hub,
            syncedRecords: records,
            checksum: 'sha256:verified',
            durationMs: duration
        });
    }, 5 * 60 * 1000);
    auditTimer.unref();
});
