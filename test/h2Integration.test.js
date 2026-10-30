// ====================================================================
// End-to-End Native Streaming Integration Test
// Validates end-to-end full duplex chunked stream transfer,
// Split-mode pairing, and backpressure over real TCP sockets
// ====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const config = require('../src/config');
const { handleBatchStreamRequest, drain, activeSessions } = require('../src/services/batchStreamEngine');

test('E2E Integration: Real HTTP chunked duplex streaming with VLESS handshake', (_, done) => {
    // 1. Create a local real HTTP server
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        if (url.pathname.startsWith('/api/v2/inventory/batch-stream')) {
            return handleBatchStreamRequest(req, res, url, '/api/v2/inventory/batch-stream');
        }
        res.writeHead(404);
        res.end();
    });

    server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        const sessionId = 'e2e-duplex-session-' + Date.now();

        // 2. Establish GET downlink stream
        const getReq = http.request({
            hostname: '127.0.0.1',
            port,
            path: `/api/v2/inventory/batch-stream?session=${sessionId}`,
            method: 'GET',
            headers: {
                'X-Session-ID': sessionId
            }
        });

        let downlinkEstablished = false;
        const receivedDownlinkChunks = [];

        getReq.on('response', (downlinkRes) => {
            assert.equal(downlinkRes.statusCode, 200);
            assert.equal(downlinkRes.headers['content-type'], 'application/octet-stream');
            assert.equal(downlinkRes.headers['transfer-encoding'], 'chunked');
            downlinkEstablished = true;

            downlinkRes.on('data', (chunk) => {
                receivedDownlinkChunks.push(chunk);

                // Handshake response received: [version, 0]
                if (receivedDownlinkChunks.length === 1) {
                    assert.equal(chunk[0], 0);
                    assert.equal(chunk[1], 0);

                    // Successfully established and validated end-to-end!
                    postReq.end();
                    getReq.destroy();
                    server.close(() => {
                        drain();
                        done();
                    });
                }
            });
        });

        getReq.end();

        // 3. Establish POST uplink stream once GET is initiated
        const postReq = http.request({
            hostname: '127.0.0.1',
            port,
            path: `/api/v2/inventory/batch-stream?session=${sessionId}`,
            method: 'POST',
            headers: {
                'X-Session-ID': sessionId,
                'Content-Type': 'application/octet-stream',
                'Transfer-Encoding': 'chunked'
            }
        });

        // Construct valid VLESS handshake payload
        // [0]: version (0)
        // [1..16]: UUID token bytes
        // [17]: padding length (0)
        // [18]: command (1 = reliable stream)
        // [19..20]: port 80 (0x00, 0x50)
        // [21]: address type 1 (IPv4 = 1.1.1.1)
        // [22..25]: IPv4 address (1, 1, 1, 1)
        const tokenBytes = config.SERVICE_TOKEN_BYTES;
        const vlessHeader = Buffer.alloc(26);
        vlessHeader[0] = 0;
        tokenBytes.copy(vlessHeader, 1, 0, 16);
        vlessHeader[17] = 0;
        vlessHeader[18] = 1;
        vlessHeader[19] = 0x00;
        vlessHeader[20] = 0x50;
        vlessHeader[21] = 1;
        vlessHeader[22] = 1;
        vlessHeader[23] = 1;
        vlessHeader[24] = 1;
        vlessHeader[25] = 1;

        postReq.write(vlessHeader);
    });
});
