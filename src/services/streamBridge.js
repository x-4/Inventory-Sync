// ====================================================================
// Bidirectional Stream Bridge
// Manages reliable TCP data streams with event-driven flow control,
// DNS rebinding immunity, and leak-free resource reclamation
// ====================================================================

const net = require('net');
const dns = require('dns');
const config = require('../config');
const { validateEndpoint, isRestrictedIPv4, isRestrictedIPv6 } = require('./complianceValidator');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');

const HIGH_WATERMARK = config.MAX_BUFFER_SIZE;
const LOW_WATERMARK = HIGH_WATERMARK >> 1;
const CONNECT_TIMEOUT_MS = config.CONNECT_TIMEOUT_MS || 15000;
const MAX_PENDING_WRITES = config.MAX_PENDING_WRITES || 64;

const { EventEmitter } = require('events');

/**
 * Creates a managed, flow-controlled bidirectional data bridge
 * between a WebSocket client and a TCP endpoint
 *
 * @param {WebSocket} ws             - Client WebSocket connection
 * @param {object}    header         - Decoded header (targetHost, targetPort)
 * @param {Buffer}    initialPayload - First data chunk to forward after connect
 * @param {string}    [streamId='st-unknown'] - Unique stream trace identifier
 * @returns {object|null} Connection handle with write() and destroy(), or null if blocked
 */
function createStreamBridge(ws, header, initialPayload, streamId = 'st-unknown') {
    // 1. Network compliance check (port & hostname/IP restrictions)
    const policy = validateEndpoint(header.targetHost, header.targetPort);
    if (!policy.allowed) {
        logger.warn('Compliance', `Stream blocked by policy: ${policy.reason}`, {
            streamId,
            code: 'ERR_POLICY_BLOCKED',
            destination: `${header.targetHost}:${header.targetPort}`
        });
        metrics.incrementRejections();
        try { ws.close(); } catch (_) {}
        return null;
    }

    metrics.incrementStreams();

    const bridgeEmitter = new EventEmitter();
    let upstream = null;
    let connected = false;
    let cleaned = false;
    let clientSocketPaused = false;
    let upstreamPaused = false;
    const pendingWrites = [];

    // Helper to safely pause/resume underlying client socket
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
        bridgeEmitter.removeAllListeners();

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

    // Connects to target IP with socket hardening and event-driven flow control
    const initiateConnection = (connectIp) => {
        if (cleaned) return;

        upstream = net.createConnection(
            { host: connectIp, port: header.targetPort },
            () => {
                connected = true;
                upstream.setTimeout(0);
                upstream.setNoDelay(true);
                upstream.setKeepAlive(true, 30000);

                // Flush initial payload
                if (initialPayload && initialPayload.length > 0) {
                    metrics.addBytes(initialPayload.length);
                    upstream.write(initialPayload);
                }

                // Flush pending data accumulated during DNS resolution
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
        upstream.setTimeout(CONNECT_TIMEOUT_MS, () => {
            if (!connected) {
                logger.warn('StreamBridge', `Connection timed out (${CONNECT_TIMEOUT_MS}ms)`, {
                    streamId,
                    code: 'ERR_CONNECT_TIMEOUT',
                    destination: `${header.targetHost}:${header.targetPort}`
                });
                cleanup();
            }
        });

        // Downstream Flow Control (Upstream TCP -> Downstream WebSocket)
        upstream.on('data', (chunk) => {
            if (ws.readyState !== ws.OPEN) return;
            metrics.addBytes(chunk.length);
            if (header.serviceToken) {
                metrics.recordTenantBytes(header.serviceToken, chunk.length);
            }

            ws.send(chunk, (err) => {
                if (err) return;
                checkAndResumeUpstream();
            });

            // Pause upstream reads when client send buffer saturates
            if (ws.bufferedAmount >= HIGH_WATERMARK && !upstreamPaused) {
                upstreamPaused = true;
                upstream.pause();
            }
        });

        // Upstream Flow Control (Downstream Virtual Socket -> Upstream TCP)
        upstream.on('drain', () => {
            // TCP buffer drained — resume reading from client
            setClientSocketPaused(false);
            bridgeEmitter.emit('drain');
        });

        upstream.on('error', (err) => {
            logger.error('StreamBridge', `Upstream error: ${err.message}`, {
                streamId,
                code: 'ERR_UPSTREAM_FAIL',
                destination: `${header.targetHost}:${header.targetPort}`
            });
            cleanup();
        });
        upstream.on('close', cleanup);
    };

    // 2. DNS Rebinding Immunity: Resolve domains and verify all IPs before connecting
    if (net.isIP(header.targetHost)) {
        initiateConnection(header.targetHost);
    } else {
        dns.lookup(header.targetHost, { all: true, verbatim: true }, (err, addresses) => {
            if (cleaned) return;
            if (err || !addresses || addresses.length === 0) {
                logger.warn('StreamBridge', `DNS resolution failed for: ${header.targetHost}`, {
                    streamId,
                    code: 'ERR_DNS_RESOLUTION',
                    error: err ? err.message : 'No addresses resolved'
                });
                cleanup();
                return;
            }

            // Verify every resolved IP against restricted ranges
            for (const entry of addresses) {
                const ip = entry.address;
                const isRestricted = (entry.family === 6 || net.isIPv6(ip))
                    ? isRestrictedIPv6(ip)
                    : isRestrictedIPv4(ip);

                if (isRestricted) {
                    logger.warn('Compliance', `DNS rebinding blocked: ${header.targetHost} resolved to restricted IP ${ip}`, {
                        streamId,
                        code: 'ERR_REBINDING_BLOCKED',
                        targetHost: header.targetHost,
                        resolvedIp: ip
                    });
                    metrics.incrementRejections();
                    cleanup();
                    return;
                }
            }

            // Connect to verified first IP (immune to TOCTOU rebinding races)
            initiateConnection(addresses[0].address);
        });
    }

    ws.on('close', cleanup);
    ws.on('error', cleanup);

    return {
        /**
         * Writes data to the upstream TCP connection with backpressure awareness
         * @param {Buffer} data
         * @returns {boolean}
         */
        write(data) {
            if (cleaned) return false;
            if (!connected || !upstream || upstream.destroyed) {
                if (pendingWrites.length < MAX_PENDING_WRITES) {
                    pendingWrites.push(data);
                }
                return true;
            }

            metrics.addBytes(data.length);
            if (header.serviceToken) {
                metrics.recordTenantBytes(header.serviceToken, data.length);
            }
            const canAcceptMore = upstream.write(data);

            if (!canAcceptMore) {
                setClientSocketPaused(true);
            }
            return canAcceptMore;
        },
        /**
         * Registers a listener when upstream TCP write buffer drains
         * @param {Function} callback
         */
        onDrain(callback) {
            if (typeof callback === 'function') {
                bridgeEmitter.on('drain', callback);
            }
        },
        destroy() {
            cleanup();
        }
    };
}

module.exports = { createStreamBridge };
