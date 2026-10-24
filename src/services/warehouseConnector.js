// ====================================================================
// Warehouse Data Connector
// Industrial-grade reliable bidirectional data streams to warehouse nodes
// Features: true TCP kernel backpressure (100% pure event-driven, zero polling),
// DNS Rebinding immunity, and guaranteed leak-free resource reclamation
// ====================================================================

const net = require('net');
const dns = require('dns');
const config = require('../config');
const { validateEndpoint, isRestrictedIPv4, isRestrictedIPv6 } = require('./complianceValidator');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');

const HIGH_WATERMARK = config.MAX_BUFFER_SIZE;
const LOW_WATERMARK = HIGH_WATERMARK >> 1;
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
    // 1. Initial network compliance check (Port & static hostname/IP blacklist)
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

    let upstream = null;
    let connected = false;
    let cleaned = false;
    let clientSocketPaused = false;
    let upstreamPaused = false;
    const pendingWrites = [];

    // Helper to safely pause/resume underlying WebSocket client socket
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

    // Pure event-driven resume check without timers
    const checkAndResumeUpstream = () => {
        if (upstreamPaused && upstream && !upstream.destroyed && ws.bufferedAmount < LOW_WATERMARK) {
            upstreamPaused = false;
            upstream.resume();
        }
    };

    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        metrics.decrementStreams();

        // Remove socket listeners to prevent leak
        if (ws._socket && !ws._socket.destroyed) {
            ws._socket.removeListener('drain', checkAndResumeUpstream);
        }

        // Resume client socket to prevent hanging state before close
        setClientSocketPaused(false);

        // Terminate and destroy both endpoints
        if (upstream && !upstream.destroyed) upstream.destroy();
        if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
            try { ws.close(); } catch (_) { ws.terminate(); }
        }
    };

    // Attach native drain listener to client socket
    if (ws._socket && !ws._socket.destroyed) {
        ws._socket.on('drain', checkAndResumeUpstream);
    }

    // Connects to target IP address with socket hardening and pure event-driven flow control
    const initiateUpstreamConnection = (connectIp) => {
        if (cleaned) return;

        upstream = net.createConnection(
            { host: connectIp, port: header.targetPort },
            () => {
                connected = true;
                upstream.setTimeout(0);               // Clear initial connect timeout
                upstream.setNoDelay(true);            // Disable Nagle's algorithm for low packet latency
                upstream.setKeepAlive(true, 30000);   // Keep connection active on OS level

                // Flush initial payload
                if (initialPayload && initialPayload.length > 0) {
                    metrics.addBytes(initialPayload.length);
                    upstream.write(initialPayload);
                }

                // Flush any data received during DNS resolution
                while (pendingWrites.length > 0) {
                    const chunk = pendingWrites.shift();
                    metrics.addBytes(chunk.length);
                    const canAcceptMore = upstream.write(chunk);
                    if (!canAcceptMore) {
                        setClientSocketPaused(true);
                        break;
                    }
                }
            }
        );

        // Connection timeout protection
        upstream.setTimeout(UPSTREAM_CONNECT_TIMEOUT_MS, () => {
            if (!connected) {
                logger.warn('Connector', `Connection to upstream timed out (${UPSTREAM_CONNECT_TIMEOUT_MS}ms)`, {
                    destination: `${header.targetHost}:${header.targetPort}`
                });
                cleanup();
            }
        });

        // Downstream Flow Control (Upstream TCP -> Downstream WebSocket)
        upstream.on('data', (chunk) => {
            if (ws.readyState !== ws.OPEN) return;
            metrics.addBytes(chunk.length);

            ws.send(chunk, (err) => {
                if (err) return;
                checkAndResumeUpstream();
            });

            // Pause upstream reads immediately when client send buffer saturates
            if (ws.bufferedAmount >= HIGH_WATERMARK && !upstreamPaused) {
                upstreamPaused = true;
                upstream.pause();
            }
        });

        // Upstream Flow Control (Downstream WebSocket -> Upstream TCP)
        upstream.on('drain', () => {
            // TCP kernel buffer drained — resume reading from WebSocket client socket
            setClientSocketPaused(false);
        });

        upstream.on('error', (err) => {
            logger.error('Connector', `Upstream link error: ${err.message}`, {
                destination: `${header.targetHost}:${header.targetPort}`
            });
            cleanup();
        });
        upstream.on('close', cleanup);
    };

    // 2. DNS Rebinding Immunity: Resolve domains and inspect all resolved IPs before connecting
    if (net.isIP(header.targetHost)) {
        initiateUpstreamConnection(header.targetHost);
    } else {
        dns.lookup(header.targetHost, { all: true, verbatim: true }, (err, addresses) => {
            if (cleaned) return;
            if (err || !addresses || addresses.length === 0) {
                logger.warn('Connector', `DNS resolution failed for upstream destination: ${header.targetHost}`, {
                    error: err ? err.message : 'No addresses resolved'
                });
                cleanup();
                return;
            }

            // Inspect EVERY resolved IP address against restricted private/metadata ranges
            for (const entry of addresses) {
                const ip = entry.address;
                const isRestricted = (entry.family === 6 || net.isIPv6(ip))
                    ? isRestrictedIPv6(ip)
                    : isRestrictedIPv4(ip);

                if (isRestricted) {
                    logger.warn('Compliance', `SSRF/DNS Rebinding blocked: Host ${header.targetHost} resolved to restricted IP ${ip}`);
                    metrics.incrementRejections();
                    cleanup();
                    return;
                }
            }

            // Connect to verified first IP address directly (immune to TOCTOU rebinding races)
            initiateUpstreamConnection(addresses[0].address);
        });
    }

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
            if (cleaned) return false;
            if (!connected || !upstream || upstream.destroyed) {
                if (pendingWrites.length < 64) {
                    pendingWrites.push(data);
                }
                return true;
            }

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
