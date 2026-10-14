// ====================================================================
// Warehouse Data Connector
// Industrial-grade reliable bidirectional data streams to warehouse nodes
// Features: true TCP kernel backpressure, connection timeout protection,
// and guaranteed leak-free resource reclamation
// ====================================================================

const net = require('net');
const config = require('../config');
const { validateEndpoint } = require('./complianceValidator');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');

const HIGH_WATERMARK = config.MAX_BUFFER_SIZE;
const LOW_WATERMARK = HIGH_WATERMARK >> 1;
const ADAPTIVE_DRAIN_POLL_MS = 8;
const UPSTREAM_CONNECT_TIMEOUT_MS = 15000; // 15s connection establishment timeout

/**
 * Creates a managed, flow-controlled bidirectional data bridge
 * between a WebSocket client and a TCP warehouse endpoint
 *
 * @param {WebSocket} ws             - Client WebSocket connection
 * @param {object}    header         - Decoded batch header (targetHost, targetPort)
 * @param {Buffer}    initialPayload - First data chunk to forward after connect
 * @returns {object|null} Connection handle with write() and destroy(), or null if blocked
 */
function createWarehouseLink(ws, header, initialPayload) {
    // Network compliance check — block restricted destinations (SSRF defense)
    const policy = validateEndpoint(header.targetHost, header.targetPort);
    if (!policy.allowed) {
        logger.warn('Compliance', `Data link blocked by security policy: ${policy.reason}`, {
            destination: `${header.targetHost}:${header.targetPort}`
        });
        metrics.incrementRejections();
        try { ws.close(); } catch (_) {}
        return null;
    }

    metrics.incrementStreams();

    let connected = false;
    const upstream = net.createConnection(
        { host: header.targetHost, port: header.targetPort },
        () => {
            connected = true;
            upstream.setTimeout(0);               // Clear initial connect timeout
            upstream.setNoDelay(true);            // Disable Nagle's algorithm for low packet latency
            upstream.setKeepAlive(true, 30000);   // Keep connection active on OS level

            if (initialPayload && initialPayload.length > 0) {
                metrics.addBytes(initialPayload.length);
                upstream.write(initialPayload);
            }
        }
    );

    // Initial connection timeout protection — prevents hanging unestablished sockets
    upstream.setTimeout(UPSTREAM_CONNECT_TIMEOUT_MS, () => {
        if (!connected) {
            logger.warn('Connector', `Connection to upstream timed out (${UPSTREAM_CONNECT_TIMEOUT_MS}ms)`, {
                destination: `${header.targetHost}:${header.targetPort}`
            });
            cleanup();
        }
    });

    // ================================================================
    // Downstream Flow Control (Upstream TCP -> Downstream WebSocket)
    // ================================================================
    let upstreamPaused = false;
    let drainTimer = null;

    const scheduleAdaptiveDrainCheck = () => {
        if (!upstreamPaused || drainTimer || upstream.destroyed) return;
        drainTimer = setTimeout(() => {
            drainTimer = null;
            if (upstream.destroyed) return;

            if (ws.bufferedAmount < LOW_WATERMARK) {
                upstreamPaused = false;
                upstream.resume();
            } else {
                scheduleAdaptiveDrainCheck();
            }
        }, ADAPTIVE_DRAIN_POLL_MS);
    };

    upstream.on('data', (chunk) => {
        if (ws.readyState !== ws.OPEN) return;
        metrics.addBytes(chunk.length);
        ws.send(chunk);

        // Pause upstream reads immediately when client send buffer saturates
        if (ws.bufferedAmount >= HIGH_WATERMARK && !upstreamPaused) {
            upstreamPaused = true;
            upstream.pause();
            scheduleAdaptiveDrainCheck();
        }
    });

    // ================================================================
    // Upstream Flow Control (Downstream WebSocket -> Upstream TCP)
    // ================================================================
    let clientSocketPaused = false;

    // Helper to safely pause/resume underlying socket
    const setClientSocketPaused = (paused) => {
        const sock = ws._socket;
        if (!sock || sock.destroyed) return;
        try {
            if (paused && !clientSocketPaused) {
                clientSocketPaused = true;
                sock.pause();
            } else if (!paused && clientSocketPaused) {
                clientSocketPaused = false;
                sock.resume();
            }
        } catch (_) {}
    };

    upstream.on('drain', () => {
        // TCP kernel buffer drained — resume reading from WebSocket client socket
        setClientSocketPaused(false);
    });

    // ================================================================
    // Connection Lifecycle & Guaranteed Leak-Free Cleanup
    // ================================================================
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        metrics.decrementStreams();

        if (drainTimer) {
            clearTimeout(drainTimer);
            drainTimer = null;
        }

        // Resume client socket to prevent hanging state before close
        setClientSocketPaused(false);

        // Terminate and destroy both endpoints
        if (!upstream.destroyed) upstream.destroy();
        if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
            try { ws.close(); } catch (_) { ws.terminate(); }
        }
    };

    upstream.on('error', (err) => {
        logger.error('Connector', `Upstream link error: ${err.message}`, {
            destination: `${header.targetHost}:${header.targetPort}`
        });
        cleanup();
    });
    upstream.on('close', cleanup);
    ws.on('close', cleanup);
    ws.on('error', cleanup);

    return {
        /**
         * Writes data to the upstream TCP connection with backpressure awareness
         * Pauses WebSocket receiver if upstream TCP buffer becomes saturated
         * @param {Buffer} data
         * @returns {boolean}
         */
        write(data) {
            if (upstream.destroyed) return false;
            metrics.addBytes(data.length);
            const canAcceptMore = upstream.write(data);

            if (!canAcceptMore) {
                setClientSocketPaused(true);
            }
            return canAcceptMore;
        },
        destroy() {
            cleanup();
        }
    };
}

module.exports = { createWarehouseLink };
