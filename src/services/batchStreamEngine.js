// ====================================================================
// HTTP Batch Stream Engine (Split & Chunked Synchronization)
// Implements XHTTP / SplitHTTP streaming transport over HTTP/1.1 and HTTP/2
// Supports stream-one, stream-up, packet-up, and autonomous session management
// ====================================================================

const crypto = require('crypto');
const { EventEmitter } = require('events');
const config = require('../config');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');
const rateLimiter = require('./rateLimiter');
const BatchDecoder = require('../protocol/batchDecoder');
const { createStreamBridge } = require('./streamBridge');
const { createDatagramSession } = require('./datagramProcessor');
const { resolvePublicIngress } = require('../utils/ingressResolver');

const SESSION_IDLE_TIMEOUT_MS = config.SESSION_IDLE_TIMEOUT_MS || 60000;
const HANDSHAKE_TIMEOUT_MS = config.HANDSHAKE_TIMEOUT_MS || 10000;
const REAPER_INTERVAL_MS = config.REAPER_INTERVAL_MS || 15000;
const MAX_PENDING_DOWNLINK_CHUNKS = config.MAX_PENDING_DOWNLINK_CHUNKS || 100;

const decoder = new BatchDecoder();

/**
 * Virtual Duplex Stream Channel
 * Bridges an HTTP Response stream (downlink) and HTTP Request stream (uplink)
 * to look like a standard bidirectional client interface for streamBridge and datagramProcessor.
 */
class HttpStreamChannel extends EventEmitter {
    constructor(sessionId) {
        super();
        this.sessionId = sessionId;
        this.downlinkRes = null;
        this.activeUplinkReq = null;

        // Mock socket for downstream backpressure / bridge compatibility
        this._socket = new EventEmitter();
        this._socket.destroyed = false;
        this._socket.pause = () => {
            if (this.activeUplinkReq && !this.activeUplinkReq.destroyed) {
                try { this.activeUplinkReq.pause(); } catch (_) {}
            }
        };
        this._socket.resume = () => {
            if (this.activeUplinkReq && !this.activeUplinkReq.destroyed) {
                try { this.activeUplinkReq.resume(); } catch (_) {}
            }
        };
        this._socket.destroy = () => {
            this._socket.destroyed = true;
            this._socket.emit('close');
        };

        // Channel state constants (mirroring WebSocket readyState for compatibility)
        this.CONNECTING = 0;
        this.OPEN = 1;
        this.CLOSING = 2;
        this.CLOSED = 3;
        this.readyState = this.OPEN;

        this.bufferedAmount = 0;
        this.pendingDownlinkChunks = [];
        this.boundDrainHandler = () => {
            this.bufferedAmount = 0;
            this.emit('drain');
            this._socket.emit('drain');
        };

        // Default error boundary to prevent unhandled 'error' event crash
        this.on('error', (err) => {
            logger.debug('StreamChannel', `Channel event on session ${this.sessionId}: ${err.message}`);
        });
    }

    /**
     * Binds active uplink request to channel for bidirectional flow control
     * @param {http.IncomingMessage} req
     */
    bindUplinkRequest(req) {
        this.activeUplinkReq = req;
        req.on('close', () => {
            if (this.activeUplinkReq === req) {
                this.activeUplinkReq = null;
            }
        });
    }

    /**
     * Attaches a downstream HTTP response as the downlink channel
     * @param {http.ServerResponse} res
     */
    attachDownlink(res) {
        if (this.downlinkRes && !this.downlinkRes.writableEnded && this.downlinkRes !== res) {
            try { this.downlinkRes.end(); } catch (_) {}
            if (this.downlinkRes.socket) {
                this.downlinkRes.socket.removeListener('drain', this.boundDrainHandler);
            }
        }

        this.downlinkRes = res;
        const rawSocket = res.socket || (res.socket && res.socket._handle) || null;

        if (rawSocket) {
            try {
                rawSocket.setKeepAlive(true, 15000);
                rawSocket.setNoDelay(true);
            } catch (_) {}
            rawSocket.on('drain', this.boundDrainHandler);
        }

        res.on('close', () => {
            if (this.downlinkRes === res) {
                this.downlinkRes = null;
                this.emit('downlink_close');
            }
        });

        // Flush any chunks queued before downlink connection arrived
        while (this.pendingDownlinkChunks.length > 0 && !res.writableEnded) {
            const chunk = this.pendingDownlinkChunks.shift();
            this.send(chunk);
        }
    }

    /**
     * Sends data chunk downstream through HTTP response (chunked transfer)
     * @param {Buffer} chunk
     * @param {Function} [callback]
     */
    send(chunk, callback) {
        if (this.readyState !== this.OPEN) {
            if (callback) callback(new Error('Channel is closed'));
            return;
        }

        if (!this.downlinkRes || this.downlinkRes.writableEnded) {
            // Buffer up to configured chunk quota if downlink is temporarily disconnected
            if (this.pendingDownlinkChunks.length < MAX_PENDING_DOWNLINK_CHUNKS) {
                this.pendingDownlinkChunks.push(chunk);
            }
            if (callback) callback();
            return;
        }

        try {
            const canAcceptMore = this.downlinkRes.write(chunk, (err) => {
                if (err) {
                    this.emit('error', err);
                }
                if (callback) callback(err);
            });

            if (!canAcceptMore) {
                this.bufferedAmount += chunk.length;
            }
        } catch (err) {
            this.emit('error', err);
            if (callback) callback(err);
        }
    }

    /**
     * Closes the virtual channel and ends the downlink response
     */
    close() {
        if (this.readyState === this.CLOSED) return;
        this.readyState = this.CLOSED;

        if (this.downlinkRes && !this.downlinkRes.writableEnded) {
            try { this.downlinkRes.end(); } catch (_) {}
        }
        if (this.downlinkRes && this.downlinkRes.socket) {
            this.downlinkRes.socket.removeListener('drain', this.boundDrainHandler);
        }

        this._socket.destroyed = true;
        this._socket.emit('close');

        this.pendingDownlinkChunks = [];
        this.emit('close');
    }

    /**
     * Immediately destroys underlying sockets
     */
    terminate() {
        this.close();
        if (this._socket && !this._socket.destroyed) {
            try { this._socket.destroy(); } catch (_) {}
        }
    }
}

/**
 * Tracks a bidirectional HTTP Batch Sync Session
 */
class BatchStreamSession {
    constructor(sessionId, clientIp) {
        this.sessionId = sessionId;
        this.streamId = 'xs-' + sessionId.slice(0, 8);
        this.clientIp = clientIp;
        this.createdAt = Date.now();
        this.lastActivity = Date.now();

        this.isHandshakeDone = false;
        this.handshakeBuffer = Buffer.alloc(0);
        this.channel = new HttpStreamChannel(sessionId);
        this.bridge = null;
        this.datagramSession = null;
        this.authenticatedTenant = null;
        this.cleaned = false;

        // Packet-up sequence ordering queue
        this.nextExpectedSeq = 0;
        this.packetQueue = new Map();

        // Handshake expiration timer
        this.authTimer = setTimeout(() => {
            if (!this.isHandshakeDone) {
                logger.warn('Auth', `XHTTP handshake timed out for ${this.clientIp}. Terminating.`, {
                    streamId: this.streamId,
                    clientIp: this.clientIp,
                    code: 'ERR_AUTH_TIMEOUT'
                });
                rateLimiter.recordFailure(this.clientIp);
                this.cleanup();
            }
        }, HANDSHAKE_TIMEOUT_MS);

        this.channel.on('error', (err) => {
            logger.debug('BatchStream', `Channel error on session ${this.streamId}: ${err.message}`);
            this.cleanup();
        });

        this.channel.on('close', () => this.cleanup());
    }

    touch() {
        this.lastActivity = Date.now();
    }

    cleanup() {
        if (this.cleaned) return;
        this.cleaned = true;
        clearTimeout(this.authTimer);
        this.packetQueue.clear();

        if (this.authenticatedTenant) {
            metrics.decrementTenantStream(this.authenticatedTenant);
            this.authenticatedTenant = null;
        }

        if (this.bridge) {
            try { this.bridge.destroy(); } catch (_) {}
            this.bridge = null;
        }

        this.datagramSession = null;
        this.channel.close();
    }
}

// Active session registry: sessionId -> BatchStreamSession
const activeSessions = new Map();

// Periodic idle session scavenger
const reaperInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of activeSessions.entries()) {
        if (now - session.lastActivity > SESSION_IDLE_TIMEOUT_MS) {
            logger.debug?.('BatchStream', `Cleaning up idle session: ${id}`);
            session.cleanup();
            activeSessions.delete(id);
        }
    }
}, REAPER_INTERVAL_MS);

// Allow Node.js process to exit without waiting on reaper
if (reaperInterval.unref) {
    reaperInterval.unref();
}

/**
 * Extracts session ID and sequence metadata from standard XHTTP placements:
 * 1. Request headers (X-Session-ID, XHTTP-Session-ID, X-Accel-Session-ID, Session-ID)
 * 2. URL query parameters (session, sessionId, id, seq, sequence)
 * 3. URL path suffix (/stream-path/:sessionId or /stream-path/:sessionId/:seq)
 *
 * @param {http.IncomingMessage} req
 * @param {URL} url
 * @param {string} basePath
 * @returns {{ sessionId: string|null, sequence: number|null }}
 */
function extractSessionMetadata(req, url, basePath) {
    let sessionId = null;
    let sequence = null;

    // 1. Headers check
    const headerId = req.headers['x-session-id'] ||
                     req.headers['xhttp-session-id'] ||
                     req.headers['x-accel-session-id'] ||
                     req.headers['session-id'];
    if (headerId && typeof headerId === 'string' && headerId.trim().length > 0) {
        sessionId = headerId.trim();
    }

    // 2. Query parameter check
    if (!sessionId) {
        const queryId = url.searchParams.get('session') ||
                        url.searchParams.get('sessionId') ||
                        url.searchParams.get('id');
        if (queryId && queryId.trim().length > 0) {
            sessionId = queryId.trim();
        }
    }

    const querySeq = url.searchParams.get('seq') || url.searchParams.get('sequence');
    if (querySeq !== null && !isNaN(parseInt(querySeq, 10))) {
        sequence = parseInt(querySeq, 10);
    }

    // 3. Path suffix check
    if (url.pathname.startsWith(basePath)) {
        const remaining = url.pathname.slice(basePath.length).replace(/^\/+/, '');
        if (remaining.length > 0) {
            const parts = remaining.split('/');
            if (parts[0] && parts[0].length > 0 && !sessionId) {
                sessionId = parts[0];
            }
            if (parts[1] && !isNaN(parseInt(parts[1], 10))) {
                sequence = parseInt(parts[1], 10);
            }
        }
    }

    return { sessionId, sequence };
}

/**
 * Extracts session ID for legacy callers
 * @param {http.IncomingMessage} req
 * @param {URL} url
 * @param {string} basePath
 * @returns {string|null}
 */
function extractSessionId(req, url, basePath) {
    return extractSessionMetadata(req, url, basePath).sessionId;
}

/**
 * Feeds an incoming chunk of data from client upload into the session
 * @param {BatchStreamSession} session
 * @param {Buffer} chunk
 * @param {http.IncomingMessage} req
 */
function processUplinkChunk(session, chunk, req) {
    session.touch();

    if (!session.isHandshakeDone) {
        session.handshakeBuffer = Buffer.concat([session.handshakeBuffer, chunk]);

        // Protocol header requires at least 24 bytes
        if (session.handshakeBuffer.length < 24) {
            return;
        }

        const header = decoder.decodeHeader(session.handshakeBuffer);
        if (!header) {
            // If data exceeds 1KB without a valid signature, reject
            if (session.handshakeBuffer.length > 1024) {
                logger.warn('Auth', `Invalid payload signature on XHTTP stream from ${session.clientIp}. Rejecting.`, {
                    streamId: session.streamId,
                    clientIp: session.clientIp,
                    code: 'ERR_INVALID_SIGNATURE'
                });
                metrics.incrementRejections();
                rateLimiter.recordFailure(session.clientIp);

                const rejection = JSON.stringify({
                    code: 40101,
                    error: 'UNAUTHORIZED',
                    message: 'Service credential invalid or revoked',
                    timestamp: new Date().toISOString()
                });
                session.channel.send(Buffer.from(rejection));
                session.cleanup();
                activeSessions.delete(session.sessionId);
            }
            return;
        }

        // Authenticated successfully
        clearTimeout(session.authTimer);
        session.isHandshakeDone = true;
        session.authenticatedTenant = header.serviceToken;
        metrics.recordTenantStream(session.authenticatedTenant);
        rateLimiter.recordSuccess(session.clientIp);

        // Send handshake acknowledgement frame [version, 0] down to client
        session.channel.send(Buffer.from([session.handshakeBuffer[0], 0]));

        const initialPayload = session.handshakeBuffer.subarray(header.payloadStart);
        session.handshakeBuffer = Buffer.alloc(0);

        // Mode 2: Datagram transport (DNS port 53)
        if (header.transportMode === 2) {
            if (header.targetPort !== 53) {
                session.cleanup();
                activeSessions.delete(session.sessionId);
                return;
            }
            session.datagramSession = createDatagramSession(session.channel, session.streamId);
            session.datagramSession.initWith(initialPayload);
            return;
        }

        // Mode 1: Reliable TCP Stream Bridge
        session.bridge = createStreamBridge(session.channel, header, initialPayload, session.streamId);
        return;
    }

    // Subsequent data streaming
    if (session.datagramSession) {
        session.datagramSession.append(chunk);
    } else if (session.bridge) {
        const canAccept = session.bridge.write(chunk);
        if (!canAccept && req && !req.destroyed) {
            try { req.pause(); } catch (_) {}
            session.bridge.onDrain?.(() => {
                try { req.resume(); } catch (_) {}
            });
        }
    }
}

/**
 * Handles sliding window packet-up reordering before pushing to uplink processor
 * @param {BatchStreamSession} session
 * @param {Buffer} chunk
 * @param {number|null} sequence
 * @param {http.IncomingMessage} req
 */
function feedOrderedUplinkChunk(session, chunk, sequence, req) {
    if (sequence === null || sequence === undefined) {
        return processUplinkChunk(session, chunk, req);
    }

    if (sequence === session.nextExpectedSeq) {
        processUplinkChunk(session, chunk, req);
        session.nextExpectedSeq++;

        // Drain any consecutive packets that arrived earlier
        while (session.packetQueue.has(session.nextExpectedSeq)) {
            const nextChunk = session.packetQueue.get(session.nextExpectedSeq);
            session.packetQueue.delete(session.nextExpectedSeq);
            processUplinkChunk(session, nextChunk, req);
            session.nextExpectedSeq++;
        }
    } else if (sequence > session.nextExpectedSeq) {
        // Queue out-of-order packet (cap at 16 packets to prevent memory bloating)
        if (session.packetQueue.size < 16) {
            session.packetQueue.set(sequence, chunk);
        } else {
            // Evict and process to prevent deadlock
            processUplinkChunk(session, chunk, req);
            session.nextExpectedSeq = sequence + 1;
        }
    } else {
        // Stale or duplicate packet, forward directly
        processUplinkChunk(session, chunk, req);
    }
}

/**
 * Main HTTP Batch Stream Request Handler (XHTTP Transport)
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {URL} url
 * @param {string} basePath
 * @returns {boolean} True if request was handled by batchStreamEngine
 */
function handleBatchStreamRequest(req, res, url, basePath = config.STREAM_PATH) {
    if (req.socket) {
        try {
            req.socket.setKeepAlive(true, 15000);
            req.socket.setNoDelay(true);
        } catch (_) {}
    }

    const ingress = resolvePublicIngress(req);
    const clientIp = ingress.clientIp;

    // Rate limiter: check if client IP is blocked
    if (rateLimiter.isBlocked(clientIp)) {
        logger.warn('RateLimit', `Blocked XHTTP request from restricted address: ${clientIp}`);
        metrics.incrementRejections();
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Server': 'Sync-Gateway/2.5' });
        res.end(JSON.stringify({
            code: 40301,
            error: 'FORBIDDEN',
            message: 'Access denied: source address restricted by enterprise gateway policy',
            timestamp: new Date().toISOString()
        }));
        return true;
    }

    // CORS preflight handling for web-based sync clients
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Session-ID, XHTTP-Session-ID, X-Accel-Session-ID, Session-ID, X-Padding',
            'Access-Control-Max-Age': '86400',
            'Server': 'Sync-Gateway/2.5'
        });
        res.end();
        return true;
    }

    // Resolve or generate Session ID & sequence metadata
    const { sessionId: rawSessionId, sequence } = extractSessionMetadata(req, url, basePath);
    let sessionId = rawSessionId;

    // Circuit Breaker: Quota check for new sessions
    const isExisting = Boolean(sessionId && activeSessions.has(sessionId));
    if (!isExisting && activeSessions.size >= config.MAX_ACTIVE_STREAMS) {
        logger.warn('CircuitBreaker', `Stream quota reached (${activeSessions.size} >= ${config.MAX_ACTIVE_STREAMS}). Rejecting XHTTP.`);
        metrics.incrementRejections();
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Server': 'Sync-Gateway/2.5' });
        res.end(JSON.stringify({
            code: 50301,
            error: 'SERVICE_UNAVAILABLE',
            message: 'Stream capacity quota saturated. Please retry batch transaction shortly.',
            timestamp: new Date().toISOString()
        }));
        return true;
    }

    // Memory Circuit Breaker: Heap usage guard against high-load OOM
    const memUsage = process.memoryUsage();
    const maxHeapBytes = (config.MAX_HEAP_MB || 512) * 1024 * 1024;
    if (memUsage.heapUsed > maxHeapBytes) {
        logger.warn('CircuitBreaker', `Heap limit exceeded (${(memUsage.heapUsed / 1024 / 1024).toFixed(1)}MB > ${config.MAX_HEAP_MB}MB). Throttling stream.`);
        metrics.incrementRejections();
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Server': 'Sync-Gateway/2.5' });
        res.end(JSON.stringify({
            code: 50302,
            error: 'SERVICE_UNAVAILABLE',
            message: 'Gateway resource threshold reached. Throttling incoming transactions.',
            timestamp: new Date().toISOString()
        }));
        return true;
    }

    // --------------------------------------------------------------------
    // GET: Downlink Stream (Server -> Client chunked stream)
    // --------------------------------------------------------------------
    if (req.method === 'GET') {
        if (!sessionId) {
            // Missing session identifier on GET
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Server': 'Sync-Gateway/2.5' });
            res.end(JSON.stringify({
                code: 40001,
                error: 'BAD_REQUEST',
                message: 'Transaction session identifier required for batch synchronization stream',
                timestamp: new Date().toISOString()
            }));
            return true;
        }

        // Establish streaming response headers
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Cache-Control': 'no-cache, no-store, no-transform, must-revalidate',
            'Connection': 'keep-alive',
            'Transfer-Encoding': 'chunked',
            'X-Accel-Buffering': 'no',
            'X-Session-ID': sessionId,
            'Server': 'Sync-Gateway/2.5'
        });
        if (typeof res.flushHeaders === 'function') {
            res.flushHeaders();
        }

        let session = activeSessions.get(sessionId);
        if (!session) {
            session = new BatchStreamSession(sessionId, clientIp);
            activeSessions.set(sessionId, session);
        }

        session.touch();
        session.channel.attachDownlink(res);

        res.on('close', () => {
            session.touch();
            // Give 10s grace period for client reconnection before purge if idle
            setTimeout(() => {
                if (!session.channel.downlinkRes && activeSessions.has(sessionId)) {
                    session.cleanup();
                    activeSessions.delete(sessionId);
                }
            }, 10000).unref();
        });

        return true;
    }

    // --------------------------------------------------------------------
    // POST: Uplink Stream or Single-Stream Bidirectional
    // --------------------------------------------------------------------
    if (req.method === 'POST') {
        // Auto-generate session ID for stream-one or autonomous initiation
        if (!sessionId) {
            sessionId = crypto.randomUUID();
        }

        let session = activeSessions.get(sessionId);
        const isNewSession = !session;

        if (isNewSession) {
            session = new BatchStreamSession(sessionId, clientIp);
            activeSessions.set(sessionId, session);

            // In stream-one (or before a separate GET connects), the POST response itself
            // is initialized as the chunked downlink channel!
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Cache-Control': 'no-cache, no-store, no-transform, must-revalidate',
                'Connection': 'keep-alive',
                'Transfer-Encoding': 'chunked',
                'X-Accel-Buffering': 'no',
                'X-Session-ID': sessionId,
                'Server': 'Sync-Gateway/2.5'
            });
            if (typeof res.flushHeaders === 'function') {
                res.flushHeaders();
            }

            session.channel.attachDownlink(res);
        }

        session.touch();
        session.channel.bindUplinkRequest(req);

        req.on('data', (chunk) => {
            feedOrderedUplinkChunk(session, chunk, sequence, req);
        });

        req.on('end', () => {
            session.touch();
            // If this was a discrete packet-up request and downlink is on a separate connection,
            // finish this specific POST response with 204 No Content
            if (!isNewSession && res !== session.channel.downlinkRes && !res.writableEnded) {
                res.writeHead(204, { 'Server': 'Sync-Gateway/2.5' });
                res.end();
            }
        });

        req.on('error', (err) => {
            logger.warn('BatchStream', `Uplink error from ${clientIp}: ${err.message}`);
            session.cleanup();
            activeSessions.delete(sessionId);
        });

        res.on('close', () => {
            // If the POST response was the active downlink channel, cleanup
            if (res === session.channel.downlinkRes) {
                session.cleanup();
                activeSessions.delete(sessionId);
            }
        });

        return true;
    }

    return false;
}

/**
 * Returns diagnostic metadata for health and doctor probes
 */
function getStatus() {
    return {
        status: 'UP',
        mode: 'HTTP_BATCH_SYNC',
        activeSessions: activeSessions.size,
        maxQuota: config.MAX_ACTIVE_STREAMS
    };
}

/**
 * Purges all active sessions during graceful shutdown
 */
function drain() {
    clearInterval(reaperInterval);
    for (const session of activeSessions.values()) {
        try { session.cleanup(); } catch (_) {}
    }
    activeSessions.clear();
}

module.exports = {
    handleBatchStreamRequest,
    extractSessionId,
    getStatus,
    drain,
    HttpStreamChannel,
    BatchStreamSession,
    activeSessions
};

