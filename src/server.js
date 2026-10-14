// ====================================================================
// Enterprise Inventory Real-time Synchronization Microservice
// Version: 2.4.0 (Production Engineered & Hardened)
// ====================================================================

const http = require('http');
const { WebSocketServer } = require('ws');

const config = require('./config');
const BatchDecoder = require('./protocol/batchDecoder');
const { renderDashboard } = require('./views/dashboard');
const { proxyRequest } = require('./gateway/corporatePortal');
const { createWarehouseLink } = require('./services/warehouseConnector');
const { createDatagramSession } = require('./services/telemetryAggregator');
const { handleHealthProbe, handleLiveness, handleReadiness } = require('./controllers/healthController');
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
 * Generates a device synchronization profile for the requesting client
 * Supports explicit PUBLIC_HOST override or dynamic host header detection
 */
function handleProfileRequest(req, res) {
    metrics.incrementRequests();
    const host = config.PUBLIC_HOST || req.headers.host || 'localhost';
    const tag = encodeURIComponent(config.PROFILE_TAG);
    const template = Buffer.from(PROFILE_TEMPLATE, 'base64').toString('utf8');
    const link = template
        .replace('{id}', config.SERVICE_TOKEN)
        .replace(/{host}/g, host)
        .replace('{tag}', tag);

    res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store, no-cache',
        'Server': 'ERP-Gateway/2.4'
    });
    res.end(Buffer.from(link).toString('base64'));
}

// ====================================================================
// HTTP Server & Request Router
// ====================================================================

const server = http.createServer((req, res) => {
    metrics.incrementRequests();
    let url;
    try {
        url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch (_) {
        res.writeHead(400, { 'Content-Type': 'text/plain', 'Server': 'ERP-Gateway/2.4' });
        return res.end('Bad Request');
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

    // Enterprise API route protection for auth namespace
    if (url.pathname.startsWith('/api/v1/auth/device/')) {
        res.writeHead(401, {
            'Content-Type': 'application/json',
            'Server': 'ERP-Gateway/2.4'
        });
        return res.end(JSON.stringify({
            code: 'INVALID_CLIENT_CREDENTIALS',
            message: 'Enterprise license key mismatch or revoked'
        }));
    }

    // Unmatched API requests: return standard Enterprise API 404
    if (url.pathname.startsWith('/api/')) {
        res.writeHead(404, {
            'Content-Type': 'application/json',
            'Server': 'ERP-Gateway/2.4'
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
                logger.warn('Auth', 'Invalid batch signature. Rejecting client connection.');
                metrics.incrementRejections();
                setTimeout(() => {
                    try { ws.close(); } catch (_) { ws.terminate(); }
                }, Math.random() * 200 + 100);
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
});
