// ====================================================================
// Enterprise Edge Terminal Administration Controller
// Manages authenticated session verification, memory compaction, and profile export
// ====================================================================

const crypto = require('crypto');
const config = require('../config');
const { purgeAnalyticsCache } = require('../services/telemetryAggregator');
const { applySecurityHeaders } = require('./profileController');
const logger = require('../utils/logger');

const PROFILE_TEMPLATE = 'dmxlc3M6Ly97aWR9QHtob3N0fTo0NDM/ZW5jcnlwdGlvbj1ub25lJnNlY3VyaXR5PXRscyZzbmk9e2hvc3R9JmZwPWNocm9tZSZ0eXBlPXdzJmhvc3Q9e2hvc3R9JnBhdGg9JTJGYXBpJTJGdjIlMkZpbnZlbnRvcnklMkZsaXZlLXN0cmVhbSN7dGFnfQ==';

/**
 * Validates request authentication token using constant-time comparison
 * @param {string} token
 * @returns {boolean}
 */
function verifyToken(token) {
    if (!token || typeof token !== 'string') return false;
    const cleanToken = token.trim();
    if (cleanToken.length !== config.SERVICE_TOKEN.length) return false;
    try {
        return crypto.timingSafeEqual(
            Buffer.from(cleanToken, 'utf8'),
            Buffer.from(config.SERVICE_TOKEN, 'utf8')
        );
    } catch (_) {
        return false;
    }
}

/**
 * Extracts bearer or header token from request
 * @param {http.IncomingMessage} req
 * @returns {string}
 */
function extractToken(req) {
    const headers = req.headers || {};
    const authHeader = headers['authorization'] || '';
    if (authHeader.startsWith('Bearer ')) {
        return authHeader.substring(7).trim();
    }
    return (headers['x-terminal-token'] || headers['x-service-token'] || '').trim();
}

/**
 * Handles terminal access verification
 */
function handleAdminAuth(req, res) {
    applySecurityHeaders(res);

    let body = '';
    req.on('data', chunk => {
        body += chunk;
        if (body.length > 4096) req.destroy();
    });

    req.on('end', () => {
        let token = '';
        try {
            const parsed = JSON.parse(body || '{}');
            token = parsed.token || '';
        } catch (_) {}

        if (!verifyToken(token)) {
            res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({
                authenticated: false,
                code: 'INVALID_CREDENTIALS',
                message: 'Terminal access token verification failed'
            }));
        }

        const host = config.PUBLIC_HOST || (req.headers && req.headers.host) || 'localhost';
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            authenticated: true,
            version: config.VERSION,
            service: config.SERVICE_NAME,
            host,
            streamPath: config.STREAM_PATH,
            profileTag: config.PROFILE_TAG,
            maxHeapMB: config.MAX_HEAP_MB,
            maxStreams: config.MAX_ACTIVE_STREAMS
        }));
    });
}

/**
 * Handles on-demand memory compaction and cache purge
 */
function handleAdminCompact(req, res) {
    applySecurityHeaders(res);
    const token = extractToken(req);

    if (!verifyToken(token)) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ code: 'UNAUTHORIZED', message: 'Authentication required' }));
    }

    const memBefore = process.memoryUsage();
    const clearedEntries = purgeAnalyticsCache();

    // Trigger V8 Garbage Collection if exposed
    if (typeof global.gc === 'function') {
        try {
            global.gc();
        } catch (_) {}
    }

    const memAfter = process.memoryUsage();
    const heapFreedBytes = Math.max(0, memBefore.heapUsed - memAfter.heapUsed);
    const heapFreedMB = (heapFreedBytes / 1024 / 1024).toFixed(2);

    logger.info('System', `Admin-triggered memory compaction executed (Freed: ${heapFreedMB}MB, Cleared entries: ${clearedEntries})`);

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
        status: 'COMPACTED',
        clearedEntries,
        heapUsedBeforeMB: (memBefore.heapUsed / 1024 / 1024).toFixed(2),
        heapUsedAfterMB: (memAfter.heapUsed / 1024 / 1024).toFixed(2),
        heapFreedMB,
        timestamp: new Date().toISOString()
    }));
}

/**
 * Generates client export snippets for terminal dashboard
 */
function handleAdminExport(req, res) {
    applySecurityHeaders(res);
    const token = extractToken(req);

    if (!verifyToken(token)) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ code: 'UNAUTHORIZED', message: 'Authentication required' }));
    }

    const host = config.PUBLIC_HOST || (req.headers && req.headers.host) || 'localhost';
    const tag = encodeURIComponent(config.PROFILE_TAG);
    const template = Buffer.from(PROFILE_TEMPLATE, 'base64').toString('utf8');
    const rawUrl = template
        .replace('{id}', config.SERVICE_TOKEN)
        .replace(/{host}/g, host)
        .replace('{tag}', tag);

    const subscriptionUrl = `https://${host}/api/v1/auth/device/${config.SERVICE_TOKEN}?format=raw`;

    // Standard client yaml configuration snippet
    const yamlConfig = [
        `  - name: "${config.PROFILE_TAG}"`,
        `    type: vless`,
        `    server: ${host}`,
        `    port: 443`,
        `    uuid: ${config.SERVICE_TOKEN}`,
        `    network: ws`,
        `    tls: true`,
        `    udp: true`,
        `    servername: ${host}`,
        `    ws-opts:`,
        `      path: "${config.STREAM_PATH}"`,
        `      headers:`,
        `        Host: ${host}`
    ].join('\n');

    // Standard client json configuration snippet
    const jsonConfig = JSON.stringify({
        type: "vless",
        tag: config.PROFILE_TAG,
        server: host,
        server_port: 443,
        uuid: config.SERVICE_TOKEN,
        transport: {
            type: "ws",
            path: config.STREAM_PATH,
            headers: { Host: host }
        },
        tls: {
            enabled: true,
            server_name: host,
            utls: { enabled: true, finger_print: "chrome" }
        }
    }, null, 2);

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
        service: config.SERVICE_NAME,
        host,
        port: 443,
        uuid: config.SERVICE_TOKEN,
        path: config.STREAM_PATH,
        tag: config.PROFILE_TAG,
        rawUrl,
        subscriptionUrl,
        formats: {
            yaml: yamlConfig,
            json: jsonConfig
        }
    }));
}

module.exports = {
    handleAdminAuth,
    handleAdminCompact,
    handleAdminExport
};
