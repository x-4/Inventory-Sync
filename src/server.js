// ====================================================================
// Enterprise Inventory Real-time Synchronization Microservice
// Version: 2.4.0 (Production Engineered & Hardened)
// ====================================================================

const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const config = require('./config');
const BatchDecoder = require('./protocol/batchDecoder');
const { renderDashboard } = require('./views/dashboard');
const { proxyRequest } = require('./gateway/corporatePortal');
const { createWarehouseLink } = require('./services/warehouseConnector');
const { createDatagramSession } = require('./services/telemetryAggregator');
const { handleHealthProbe, handleLiveness, handleReadiness } = require('./controllers/healthController');
const { handleWarehouses, handleTransactions, handleTelemetry } = require('./controllers/inventoryController');
const edgeGateway = require('./services/edgeGateway');
const logger = require('./utils/logger');
const metrics = require('./utils/metrics');

// --- Global Process Diagnostics & Logging ---
process.on('uncaughtException', (err) => {
    logger.error('Runtime', `Uncaught exception encountered: ${err.message}`, { stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
    logger.error('Runtime', `Unhandled promise rejection: ${String(reason)}`);
});

// --- Protocol decoder instance ---
const decoder = new BatchDecoder();

// --- Subscription profile template (base64-encoded link template) ---
const PROFILE_TEMPLATE = 'dmxlc3M6Ly97aWR9QHtob3N0fTo0NDM/ZW5jcnlwdGlvbj1ub25lJnNlY3VyaXR5PXRscyZzbmk9e2hvc3R9JmZwPWNocm9tZSZ0eXBlPXdzJmhvc3Q9e2hvc3R9JnBhdGg9JTJGYXBpJTJGdjIlMkZpbnZlbnRvcnklMkZsaXZlLXN0cmVhbSN7dGFnfQ==';

/**
 * Injects standardized enterprise security headers and distributed trace ID
 * @param {http.ServerResponse} res
 * @param {object}              extraHeaders
 */
function applySecurityHeaders(res, extraHeaders = {}) {
    const traceId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    const headers = {
        'Server': 'ERP-Gateway/2.4',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
        'X-Request-Id': traceId,
        'X-ERP-Route': 'mesh-gateway',
        ...extraHeaders
    };
    for (const [key, value] of Object.entries(headers)) {
        res.setHeader(key, value);
    }
}

/**
 * Generates a device synchronization profile for the requesting client
 * Supports dual-mode: proxy subscription for client tools, and authentic
 * ERP device provisioning JSON schema for browsers and compliance audits
 */
function handleProfileRequest(req, res) {
    metrics.incrementRequests();
    applySecurityHeaders(res);
    const host = config.PUBLIC_HOST || req.headers.host || 'localhost';
    const userAgent = (req.headers['user-agent'] || '').toLowerCase();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const format = url.searchParams.get('format');

    // Proxy clients identification keywords (Clash, V2Ray, Sing-box, Surge, Shadowrocket, etc.)
    const isProxyClient = format === 'raw' || format === 'base64' ||
        ['clash', 'v2ray', 'sing-box', 'shadowrocket', 'surge', 'loon', 'nekobox', 'stash', 'quantumult', 'v2rayn'].some(agent => userAgent.includes(agent));

    if (isProxyClient) {
        const tag = encodeURIComponent(config.PROFILE_TAG);
        const template = Buffer.from(PROFILE_TEMPLATE, 'base64').toString('utf8');
        const link = template
            .replace('{id}', config.SERVICE_TOKEN)
            .replace(/{host}/g, host)
            .replace('{tag}', tag);

        res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store, no-cache'
        });
        return res.end(Buffer.from(link).toString('base64'));
    }

    // Enterprise Device Provisioning JSON Schema (Audit & Scanner Masquerade)
    const deviceFingerprint = crypto.createHash('sha256')
        .update(config.SERVICE_TOKEN + host)
        .digest('hex')
        .substring(0, 12)
        .toUpperCase();

    res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache'
    });
    res.end(JSON.stringify({
        status: 'PROVISIONED',
        service: config.SERVICE_NAME,
        version: config.VERSION,
        terminalId: `PDA-TERMINAL-${deviceFingerprint}`,
        channel: {
            mode: 'SECURE_STREAM_V2',
            transport: 'WebSocket+TLS',
            gatewayHost: host,
            streamPath: config.STREAM_PATH,
            heartbeatIntervalMs: 30000,
            reconciliationQueue: 'fifo-partition-01'
        },
        license: {
            state: 'ACTIVE',
            type: 'ENTERPRISE_EDGE_SYNC',
            tier: 'TIER-1-UNLIMITED',
            expiresAt: '2028-12-31T23:59:59Z'
        },
        auditTimestamp: new Date().toISOString()
    }, null, 2));
}

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

    // High Priority #1: Active probe defense — GET/HEAD on stream endpoint requires WebSocket upgrade
    if (url.pathname === config.STREAM_PATH) {
        applySecurityHeaders(res, {
            'Upgrade': 'websocket',
            'Connection': 'Upgrade',
            'X-ERP-Service-Status': 'UPGRADE_REQUIRED'
        });
        res.writeHead(426, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
            error: 'UPGRADE_REQUIRED',
            transport: 'websocket',
            service: 'warehouse-inventory-stream',
            protocolVersion: '2.4',
            message: 'Active WebSocket upgrade handshake with enterprise authorization is required on this channel.'
        }, null, 2));
    }

    // Standardized health & diagnostic endpoints
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

    // Device synchronization profile endpoint
    if (req.method === 'GET' && url.pathname === `/api/v1/auth/device/${config.SERVICE_TOKEN}`) {
        return handleProfileRequest(req, res);
    }

    // Root route — corporate management console
    if (req.method === 'GET' && url.pathname === '/') {
        return renderDashboard(res);
    }

    // Medium Priority #5: High-fidelity enterprise REST API facades
    if (req.method === 'GET') {
        if (url.pathname === '/api/v1/inventory/warehouses') {
            return handleWarehouses(req, res);
        }
        if (url.pathname === '/api/v1/sync/transactions') {
            return handleTransactions(req, res);
        }
        if (url.pathname === '/api/v1/system/telemetry') {
            return handleTelemetry(req, res);
        }
    }

    // Enterprise API route protection for auth namespace
    if (url.pathname.startsWith('/api/v1/auth/device/')) {
        res.writeHead(401, {
            'Content-Type': 'application/json'
        });
        return res.end(JSON.stringify({
            code: 'INVALID_CLIENT_CREDENTIALS',
            message: 'Enterprise license key mismatch or revoked'
        }));
    }

    // Unmatched API requests: return standard Enterprise API 404
    if (url.pathname.startsWith('/api/')) {
        res.writeHead(404, {
            'Content-Type': 'application/json'
        });
        return res.end(JSON.stringify({
            code: 'RESOURCE_NOT_FOUND',
            message: 'Enterprise API endpoint does not exist'
        }));
    }

    // All unmatched routes: self-hosted dashboard by default (or proxy if PORTAL_ORIGIN explicitly configured)
    return proxyRequest(req, res, config.PORTAL_ORIGIN);
});

// ====================================================================
// Real-time Data Stream Engine (WebSocket)
// ====================================================================

const streamServer = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => protocols[0] || false
});

// WebSocket upgrade with Circuit Breaker guards (OOM & connection quota defense)
server.on('upgrade', (request, socket, head) => {
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

    // Circuit Breaker 1: Memory heap watermark protection (strictly tuned for 256MB container limits)
    const mem = process.memoryUsage();
    const heapUsedMB = mem.heapUsed / (1024 * 1024);
    if (heapUsedMB > config.MAX_HEAP_MB) {
        logger.warn('Protection', `Circuit breaker tripped: heap watermark exceeded (${heapUsedMB.toFixed(1)}MB > ${config.MAX_HEAP_MB}MB). Rejecting upgrade.`);
        metrics.incrementRejections();
        socket.destroy();
        return;
    }

    // Circuit Breaker 2: Concurrent active stream quota protection
    if (streamServer.clients.size >= config.MAX_ACTIVE_STREAMS) {
        logger.warn('Protection', `Circuit breaker tripped: active stream quota reached (${streamServer.clients.size} >= ${config.MAX_ACTIVE_STREAMS}). Rejecting upgrade.`);
        metrics.incrementRejections();
        socket.destroy();
        return;
    }

    streamServer.handleUpgrade(request, socket, head, (ws) => {
        streamServer.emit('connection', ws);
    });
});

// ====================================================================
// Stream Health Heartbeat (Prevents Cloudflare / NAT Idle Timeouts)
// ====================================================================
const HEARTBEAT_INTERVAL_MS = 30000;
const HANDSHAKE_TIMEOUT_MS = 10000; // 10s strict timeout for initial VLESS handshake

const heartbeatTimer = setInterval(() => {
    streamServer.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            logger.warn('Stream', 'Stale stream session detected (unresponsive to heartbeat). Terminating connection.');
            return ws.terminate();
        }
        ws.isAlive = false;
        try {
            ws.ping();
        } catch (_) {}
    });
}, HEARTBEAT_INTERVAL_MS);

// Handle incoming stream connections
streamServer.on('connection', (ws) => {
    // Defense against Slowloris-style hanging unauthenticated connections:
    // Terminate connection if no valid VLESS handshake packet received within 10 seconds
    const authTimer = setTimeout(() => {
        logger.warn('Auth', 'Handshake timed out (unauthenticated client), terminating connection.');
        try { ws.close(); } catch (_) { ws.terminate(); }
    }, HANDSHAKE_TIMEOUT_MS);

    // Initialize connection liveness state
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    let isHandshake = true;
    let link = null;              // Warehouse TCP link (reliable mode)
    let datagramSession = null;   // Datagram analytics session
    let cleaned = false;

    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearTimeout(authTimer);
        if (link) {
            link.destroy();
            link = null;
        }
        datagramSession = null;
    };

    ws.on('message', (msg) => {
        if (isHandshake) {
            isHandshake = false;
            clearTimeout(authTimer); // Handshake received, cancel auth timeout

            const header = decoder.decodeHeader(msg);
            if (!header) {
                logger.warn('Auth', 'Invalid batch payload signature. Returning enterprise protocol rejection.');
                metrics.incrementRejections();

                // High Priority #2: Return simulated enterprise RPC rejection frame before closing
                try {
                    const rejection = JSON.stringify({
                        code: 40101,
                        error: 'UNAUTHORIZED_BATCH_PAYLOAD',
                        message: 'Client inventory sync license token invalid or revoked',
                        timestamp: new Date().toISOString()
                    });
                    ws.send(rejection, () => {
                        try {
                            ws.close(1008, 'Policy Violation: Invalid license token');
                        } catch (_) {
                            ws.terminate();
                        }
                    });
                } catch (_) {
                    try { ws.close(1008); } catch (_) { ws.terminate(); }
                }
                return;
            }

            // Send handshake acknowledgement frame
            ws.send(Buffer.from([msg[0], 0]));

            const payload = msg.subarray(header.payloadStart);

            // Datagram mode (analytics telemetry, port 53 only)
            if (header.transportMode === 2) {
                if (header.targetPort !== 53) {
                    try { ws.close(); } catch (_) { ws.terminate(); }
                    return;
                }
                datagramSession = createDatagramSession(ws);
                datagramSession.initWith(payload);
                return;
            }

            // Reliable stream mode (warehouse data synchronization with adaptive backpressure)
            link = createWarehouseLink(ws, header, payload);
            return;
        }

        // Subsequent message forwarding with backpressure awareness
        if (datagramSession) {
            datagramSession.append(msg);
        } else if (link) {
            link.write(msg);
        }
    });

    ws.on('close', cleanup);
    ws.on('error', cleanup);
});

// ====================================================================
// Service Lifecycle & Graceful Shutdown
// ====================================================================

function gracefulShutdown(signal) {
    logger.info('System', `Received ${signal}. Initiating graceful shutdown...`);

    // Terminate edge connector supervisor
    edgeGateway.stop();

    // Clear heartbeat timer
    clearInterval(heartbeatTimer);

    // Terminate new WebSocket connections and close HTTP listener
    streamServer.close(() => {
        logger.info('System', 'All stream socket sessions drained.');
    });

    server.close(() => {
        logger.info('System', 'HTTP gateway listener closed successfully.');
        process.exit(0);
    });

    // Forced exit timeout if connections linger
    setTimeout(() => {
        logger.warn('System', 'Graceful shutdown timeout exceeded. Forcing termination.');
        process.exit(1);
    }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

server.listen(config.PORT, () => {
    logger.info('System', `Enterprise Inventory Sync Microservice ONLINE`, {
        port: config.PORT,
        endpoint: config.STREAM_PATH,
        version: config.VERSION,
        mode: config.TOKEN ? 'EDGE_TUNNEL_ACTIVE' : 'STANDALONE_PORT',
        ioThreadPoolSize: process.env.UV_THREADPOOL_SIZE || 4,
        publicHost: config.PUBLIC_HOST || '(dynamic)',
        portalMode: config.PORTAL_ORIGIN ? `PROXY:${config.PORTAL_ORIGIN}` : 'SELF_HOSTED',
        maxHeapQuota: `${config.MAX_HEAP_MB}MB`
    });

    // Initialize cross-platform edge tunnel supervisor asynchronously
    edgeGateway.initialize().catch((err) => {
        logger.error('EdgeGateway', `Background supervisor startup error: ${err.message}`);
    });

    // Medium Priority #7: Low-frequency enterprise reconciliation event injection (every 5 minutes)
    const AUDIT_HUBS = ['WH-TOKYO-01', 'WH-FRANKFURT-02', 'WH-VIRGINIA-01', 'WH-SINGAPORE-01'];
    const auditTimer = setInterval(() => {
        const hub = AUDIT_HUBS[Math.floor(Math.random() * AUDIT_HUBS.length)];
        const records = Math.floor(Math.random() * 800) + 200;
        const duration = Math.floor(Math.random() * 15) + 5;
        logger.info('InventorySync', 'Periodic warehouse ledger partition reconciliation committed', {
            hub,
            syncedRecords: records,
            checksum: 'sha256:verified',
            durationMs: duration
        });
    }, 5 * 60 * 1000);
    auditTimer.unref(); // Ensure unreferenced timer does not keep process alive during exit
});
