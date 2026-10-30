// ====================================================================
// HTTP Batch Stream Engine (XHTTP) Tests
// Validates session orchestration, split stream mode, stream-one mode,
// rate limiting, and VLESS protocol handshake over HTTP
// ====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { EventEmitter } = require('events');

const config = require('../src/config');
const {
    handleBatchStreamRequest,
    extractSessionId,
    getStatus,
    drain,
    activeSessions,
    HttpStreamChannel
} = require('../src/services/batchStreamEngine');
const rateLimiter = require('../src/services/rateLimiter');

test('BatchStream: Session ID extraction from headers, query, and path', () => {
    // 1. From header
    const reqHeader = {
        headers: { 'x-session-id': 'session-uuid-1234' }
    };
    const url1 = new URL('http://localhost/api/v2/inventory/batch-stream');
    assert.equal(extractSessionId(reqHeader, url1, '/api/v2/inventory/batch-stream'), 'session-uuid-1234');

    // 2. From query
    const reqQuery = { headers: {} };
    const url2 = new URL('http://localhost/api/v2/inventory/batch-stream?session=query-uuid-5678');
    assert.equal(extractSessionId(reqQuery, url2, '/api/v2/inventory/batch-stream'), 'query-uuid-5678');

    // 3. From path suffix
    const reqPath = { headers: {} };
    const url3 = new URL('http://localhost/api/v2/inventory/batch-stream/path-uuid-9999/seq1');
    assert.equal(extractSessionId(reqPath, url3, '/api/v2/inventory/batch-stream'), 'path-uuid-9999');

    // 4. Missing session ID
    const reqEmpty = { headers: {} };
    const urlEmpty = new URL('http://localhost/api/v2/inventory/batch-stream');
    assert.equal(extractSessionId(reqEmpty, urlEmpty, '/api/v2/inventory/batch-stream'), null);
});

test('BatchStream: OPTIONS preflight returns 204 with CORS and gateway headers', () => {
    const req = {
        method: 'OPTIONS',
        headers: { host: 'localhost' }
    };
    let statusCode = null;
    let headers = null;
    let ended = false;

    const res = {
        writeHead: (code, h) => {
            statusCode = code;
            headers = h;
        },
        end: () => { ended = true; }
    };

    const url = new URL('http://localhost/api/v2/inventory/batch-stream');
    const handled = handleBatchStreamRequest(req, res, url, '/api/v2/inventory/batch-stream');

    assert.equal(handled, true);
    assert.equal(statusCode, 204);
    assert.equal(headers['Server'], 'Sync-Gateway/2.5');
    assert.equal(headers['Access-Control-Allow-Methods'], 'GET, POST, OPTIONS');
    assert.equal(ended, true);
});

test('BatchStream: GET downlink stream establishes chunked connection', () => {
    const req = {
        method: 'GET',
        headers: {
            host: 'localhost',
            'x-session-id': 'test-downlink-session-01'
        }
    };
    let statusCode = null;
    let headers = null;

    const res = new EventEmitter();
    res.writeHead = (code, h) => {
        statusCode = code;
        headers = h;
    };
    res.flushHeaders = () => {};
    res.end = () => {};

    const url = new URL('http://localhost/api/v2/inventory/batch-stream');
    const handled = handleBatchStreamRequest(req, res, url, '/api/v2/inventory/batch-stream');

    assert.equal(handled, true);
    assert.equal(statusCode, 200);
    assert.equal(headers['Content-Type'], 'application/octet-stream');
    assert.equal(headers['Transfer-Encoding'], 'chunked');
    assert.equal(headers['X-Accel-Buffering'], 'no');
    assert.equal(headers['X-Session-ID'], 'test-downlink-session-01');

    assert.ok(activeSessions.has('test-downlink-session-01'));
});

test('BatchStream: Split mode (POST uplink pairs with GET downlink and sends VLESS ack)', (_, done) => {
    const sessionId = 'test-split-session-02';

    // 1. Establish GET downlink
    const getReq = {
        method: 'GET',
        headers: {
            host: 'localhost',
            'x-session-id': sessionId
        }
    };
    const getRes = new EventEmitter();
    let getHeaders = null;
    const downlinkData = [];

    getRes.writeHead = (code, h) => { getHeaders = h; };
    getRes.flushHeaders = () => {};
    getRes.write = (chunk) => {
        downlinkData.push(chunk);
        return true;
    };
    getRes.end = () => {};

    const getUrl = new URL(`http://localhost/api/v2/inventory/batch-stream?session=${sessionId}`);
    handleBatchStreamRequest(getReq, getRes, getUrl, '/api/v2/inventory/batch-stream');

    // 2. Send POST uplink with valid VLESS handshake payload
    const postReq = new EventEmitter();
    postReq.method = 'POST';
    postReq.headers = {
        host: 'localhost',
        'x-session-id': sessionId
    };

    const postRes = new EventEmitter();
    postRes.writeHead = () => {};
    postRes.end = () => {};

    const postUrl = new URL(`http://localhost/api/v2/inventory/batch-stream?session=${sessionId}`);
    handleBatchStreamRequest(postReq, postRes, postUrl, '/api/v2/inventory/batch-stream');

    // Construct valid VLESS packet:
    // [0]: version (0)
    // [1..16]: UUID token bytes
    // [17]: padding length (0)
    // [18]: transportMode (1: TCP)
    // [19..20]: port (80 -> 0x00, 0x50)
    // [21]: addressType (1: IPv4)
    // [22..25]: IPv4 (1.1.1.1)
    // [26..]: payload data ("DATA")
    const packet = Buffer.concat([
        Buffer.from([0]),
        config.SERVICE_TOKEN_BYTES,
        Buffer.from([0]),                   // padding = 0
        Buffer.from([1]),                   // transportMode = 1
        Buffer.from([0x00, 0x50]),          // port = 80
        Buffer.from([1]),                   // addressType = 1
        Buffer.from([1, 1, 1, 1]),          // targetHost = 1.1.1.1
        Buffer.from('DATA')                 // payload
    ]);

    postReq.emit('data', packet);

    // Verify VLESS response header [version, 0] was sent down to the GET response
    setImmediate(() => {
        assert.ok(downlinkData.length >= 1, 'Downlink should receive handshake acknowledgment');
        const ack = downlinkData[0];
        assert.equal(ack.length, 2);
        assert.equal(ack[0], 0);
        assert.equal(ack[1], 0);
        done();
    });
});

test('BatchStream: Single-stream (stream-one) mode initializes POST response as downlink', () => {
    const postReq = new EventEmitter();
    postReq.method = 'POST';
    postReq.headers = {
        host: 'localhost'
        // No session ID provided — auto generated
    };

    let postStatus = null;
    let postHeaders = null;
    const postRes = new EventEmitter();
    postRes.writeHead = (code, h) => {
        postStatus = code;
        postHeaders = h;
    };
    postRes.flushHeaders = () => {};
    postRes.write = () => true;
    postRes.end = () => {};

    const postUrl = new URL('http://localhost/api/v2/inventory/batch-stream');
    const handled = handleBatchStreamRequest(postReq, postRes, postUrl, '/api/v2/inventory/batch-stream');

    assert.equal(handled, true);
    assert.equal(postStatus, 200);
    assert.equal(postHeaders['Content-Type'], 'application/octet-stream');
    assert.equal(postHeaders['Transfer-Encoding'], 'chunked');
    assert.ok(postHeaders['X-Session-ID']);
});

test('BatchStream: Diagnostics status reports valid session metadata', () => {
    const status = getStatus();
    assert.equal(status.status, 'UP');
    assert.equal(status.mode, 'HTTP_BATCH_SYNC');
    assert.equal(typeof status.activeSessions, 'number');
    assert.equal(status.maxQuota, config.MAX_ACTIVE_STREAMS);
});

test('BatchStream: drain purges all active sessions cleanly', () => {
    drain();
    assert.equal(activeSessions.size, 0);
});
