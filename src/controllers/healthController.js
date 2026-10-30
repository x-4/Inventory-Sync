// ====================================================================
// Health Probe & Diagnostic Controller
// Exposes system diagnostics for K8s & Docker orchestrators
// ====================================================================

const config = require('../config');
const metrics = require('../utils/metrics');
const tunnelManager = require('../services/tunnelManager');

/**
 * Generates structured health diagnostics
 * @returns {object}
 */
function getDiagnostics() {
    const mem = process.memoryUsage();
    const heapUsedMB = (mem.heapUsed / 1024 / 1024).toFixed(2);
    const rssMB = (mem.rss / 1024 / 1024).toFixed(2);
    const snapshot = metrics.getSnapshot();

    return {
        status: 'UP',
        timestamp: new Date().toISOString(),
        service: config.SERVICE_NAME,
        version: config.VERSION,
        environment: config.ENVIRONMENT,
        uptimeSeconds: Math.floor(process.uptime()),
        components: {
            streamEngine: {
                status: 'UP',
                endpoint: config.STREAM_PATH,
                activeConnections: snapshot.requests.activeStreams,
                maxStreamsQuota: config.MAX_ACTIVE_STREAMS
            },
            tunnel: tunnelManager.getStatus(),
            datagramProcessor: {
                status: 'UP',
                mode: 'HYBRID_UDP_HTTPS',
                cacheHits: snapshot.throughput.cacheHits
            },
            memory: {
                status: 'UP',
                heapUsedMB: `${heapUsedMB} MB`,
                rssMB: `${rssMB} MB`,
                heapThresholdMB: `${config.MAX_HEAP_MB} MB`
            }
        },
        telemetry: {
            totalRequests: snapshot.requests.total,
            totalStreams: snapshot.requests.totalStreams,
            bytesTransferred: snapshot.throughput.bytesTransferred,
            datagramQueries: snapshot.throughput.datagramQueries,
            rejectedRequests: snapshot.requests.rejected
        }
    };
}

/**
 * Handles incoming health probe requests
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse}  res
 */
function handleHealthProbe(req, res) {
    const data = getDiagnostics();
    const body = JSON.stringify(data, null, 2);

    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache',
        'Server': 'Sync-Gateway/2.5'
    });
    res.end(body);
}

/**
 * Handles Kubernetes liveness probe
 */
function handleLiveness(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Server': 'Sync-Gateway/2.5' });
    res.end('OK');
}

/**
 * Handles Kubernetes readiness probe
 */
function handleReadiness(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Server': 'Sync-Gateway/2.5' });
    res.end('READY');
}

module.exports = {
    handleHealthProbe,
    handleLiveness,
    handleReadiness,
    getDiagnostics
};
