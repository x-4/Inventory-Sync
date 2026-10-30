// ====================================================================
// Device Profile Controller
// Manages device configuration provisioning descriptors
// ====================================================================

const crypto = require('crypto');
const config = require('../config');
const metrics = require('../utils/metrics');
const { resolvePublicIngress } = require('../utils/ingressResolver');

/**
 * Injects standardized security headers and distributed trace ID
 * @param {http.ServerResponse} res
 * @param {object}              extraHeaders
 */
function applySecurityHeaders(res, extraHeaders = {}) {
    const traceId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    const headers = {
        'Server': 'Sync-Gateway/2.5',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
        'X-Request-Id': traceId,
        'X-Gateway-Route': 'stream-mesh',
        ...extraHeaders
    };
    for (const [key, value] of Object.entries(headers)) {
        res.setHeader(key, value);
    }
}

/**
 * Handles device provisioning profile requests
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse}  res
 */
function handleProfileRequest(req, res) {
    metrics.incrementRequests();
    applySecurityHeaders(res);
    const ingress = resolvePublicIngress(req);
    const host = ingress.hostname;

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
        terminalId: `DEVICE-${deviceFingerprint}`,
        channel: {
            mode: 'SECURE_STREAM_V2',
            transport: 'HTTP/2-Chunked+TLS',
            gatewayHost: host,
            streamPath: config.STREAM_PATH,
            heartbeatIntervalMs: 30000,
            queue: 'fifo-partition-01'
        },
        license: {
            state: 'ACTIVE',
            type: 'SYNC_GATEWAY',
            tier: 'TIER-1',
            expiresAt: '2028-12-31T23:59:59Z'
        },
        auditTimestamp: new Date().toISOString()
    }, null, 2));
}

module.exports = {
    handleProfileRequest,
    applySecurityHeaders
};
