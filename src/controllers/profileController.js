// ====================================================================
// Enterprise Device Synchronization Profile Controller
// Manages device configuration provisioning descriptors
// ====================================================================

const crypto = require('crypto');
const config = require('../config');
const metrics = require('../utils/metrics');

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
 * Handles device provisioning profile requests
 * Always returns standardized enterprise device provisioning JSON descriptor
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse}  res
 */
function handleProfileRequest(req, res) {
    metrics.incrementRequests();
    applySecurityHeaders(res);
    const host = config.PUBLIC_HOST || (req.headers && req.headers.host) || 'localhost';

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

module.exports = {
    handleProfileRequest,
    applySecurityHeaders
};
