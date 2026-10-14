// ====================================================================
// Enterprise Facade & Active Probe Defense Tests
// Validates masquerade behavior, RFC 426 compliance, content negotiation,
// security headers, and mock ERP REST API responses
// ====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const config = require('../src/config');
const { handleWarehouses, handleTransactions, handleTelemetry } = require('../src/controllers/inventoryController');

test('Facade: handleWarehouses returns valid enterprise hub metadata', () => {
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

test('Facade: handleTransactions returns simulated stock transactions', () => {
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

test('Facade: handleTelemetry returns real-time linked system metrics', () => {
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
