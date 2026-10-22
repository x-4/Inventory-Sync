// ====================================================================
// Enterprise Gateway & Service Integration Tests
// Validates RFC 426 compliance, content negotiation,
// security headers, device provisioning, and mock ERP REST API responses
// ====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const { handleWarehouses, handleTransactions, handleTelemetry } = require('../src/controllers/inventoryController');
const { handleProfileRequest } = require('../src/controllers/profileController');

test('Integration: handleWarehouses returns valid enterprise hub metadata', () => {
    let statusCode = null;
    let headers = null;
    let body = '';

    const req = {};
    const res = {
        writeHead: (code, h) => {
            statusCode = code;
            headers = h;
        },
        end: (payload) => {
            body = payload;
        }
    };

    handleWarehouses(req, res);

    assert.equal(statusCode, 200);
    assert.equal(headers['Content-Type'], 'application/json; charset=utf-8');
    const parsed = JSON.parse(body);
    assert.equal(parsed.meshStatus, 'HEALTHY');
    assert.equal(parsed.totalHubs, 5);
    assert.ok(Array.isArray(parsed.nodes) && parsed.nodes.length === 5);
    assert.equal(parsed.nodes[0].id, 'WH-US-EAST');
});

test('Integration: handleTransactions returns simulated stock transactions', () => {
    let statusCode = null;
    let body = '';

    const req = {};
    const res = {
        writeHead: (code) => { statusCode = code; },
        end: (payload) => { body = payload; }
    };

    handleTransactions(req, res);

    assert.equal(statusCode, 200);
    const parsed = JSON.parse(body);
    assert.ok(Array.isArray(parsed.transactions) && parsed.transactions.length === 8);
    assert.equal(parsed.transactions[0].status, 'COMMITTED');
    assert.ok(parsed.transactions[0].batchId.startsWith('BATCH-'));
});

test('Integration: handleTelemetry returns real-time linked system metrics', () => {
    let statusCode = null;
    let body = '';

    const req = {};
    const res = {
        writeHead: (code) => { statusCode = code; },
        end: (payload) => { body = payload; }
    };

    handleTelemetry(req, res);

    assert.equal(statusCode, 200);
    const parsed = JSON.parse(body);
    assert.equal(parsed.service, config.SERVICE_NAME);
    assert.equal(parsed.clusterState, 'SYNCHRONIZED');
    assert.ok(parsed.metrics);
    assert.equal(typeof parsed.metrics.totalBatches, 'number');
    assert.equal(typeof parsed.metrics.heapUsedMB, 'string');
});

test('Profile: Default request returns enterprise device provisioning JSON (User-Agent ignored)', () => {
    let statusCode = null;
    let headers = null;
    let body = '';

    const req = {
        url: `/api/v1/auth/device/${config.SERVICE_TOKEN}`,
        headers: {
            host: 'mesh.enterprise.internal',
            'user-agent': 'Enterprise-Scanner/2.4 (Android 14; Zebra TC52)'
        }
    };
    const res = {
        setHeader: () => {},
        writeHead: (code, h) => {
            statusCode = code;
            headers = h;
        },
        end: (payload) => {
            body = payload;
        }
    };

    handleProfileRequest(req, res);

    assert.equal(statusCode, 200);
    assert.equal(headers['Content-Type'], 'application/json; charset=utf-8');
    const parsed = JSON.parse(body);
    assert.equal(parsed.status, 'PROVISIONED');
    assert.ok(parsed.terminalId.startsWith('PDA-TERMINAL-'));
    assert.equal(parsed.channel.mode, 'SECURE_STREAM_V2');
});

test('Profile: Request with ?format=raw safely ignores query and returns enterprise JSON descriptor', () => {
    let statusCode = null;
    let headers = null;
    let body = '';

    const req = {
        url: `/api/v1/auth/device/${config.SERVICE_TOKEN}?format=raw`,
        headers: {
            host: 'mesh.enterprise.internal',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        }
    };
    const res = {
        setHeader: () => {},
        writeHead: (code, h) => {
            statusCode = code;
            headers = h;
        },
        end: (payload) => {
            body = payload;
        }
    };

    handleProfileRequest(req, res);

    assert.equal(statusCode, 200);
    assert.equal(headers['Content-Type'], 'application/json; charset=utf-8');
    const parsed = JSON.parse(body);
    assert.equal(parsed.status, 'PROVISIONED');
    assert.ok(parsed.terminalId.startsWith('PDA-TERMINAL-'));
    assert.equal(parsed.channel.mode, 'SECURE_STREAM_V2');
});
