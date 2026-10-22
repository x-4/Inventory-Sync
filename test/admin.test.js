// ====================================================================
// Terminal Administration Controller Tests
// Validates token verification, heap compaction, and profile export
// ====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const config = require('../src/config');
const { handleAdminAuth, handleAdminCompact, handleAdminExport } = require('../src/controllers/adminController');

test('Admin: handleAdminAuth rejects invalid master key with 401', (_, done) => {
    const req = new EventEmitter();
    let statusCode = null;
    let body = '';

    const res = {
        setHeader: () => {},
        writeHead: (code) => { statusCode = code; },
        end: (payload) => {
            body = payload;
            assert.equal(statusCode, 401);
            const parsed = JSON.parse(body);
            assert.equal(parsed.authenticated, false);
            assert.equal(parsed.code, 'INVALID_CREDENTIALS');
            done();
        }
    };

    handleAdminAuth(req, res);
    req.emit('data', JSON.stringify({ token: 'wrong-key-00000000' }));
    req.emit('end');
});

test('Admin: handleAdminAuth accepts valid master key with 200', (_, done) => {
    const req = new EventEmitter();
    let statusCode = null;
    let body = '';

    const res = {
        setHeader: () => {},
        writeHead: (code) => { statusCode = code; },
        end: (payload) => {
            body = payload;
            assert.equal(statusCode, 200);
            const parsed = JSON.parse(body);
            assert.equal(parsed.authenticated, true);
            assert.equal(parsed.service, config.SERVICE_NAME);
            assert.ok(parsed.version);
            done();
        }
    };

    handleAdminAuth(req, res);
    req.emit('data', JSON.stringify({ token: config.SERVICE_TOKEN }));
    req.emit('end');
});

test('Admin: handleAdminCompact rejects unauthenticated requests with 401', () => {
    let statusCode = null;
    let body = '';

    const req = { headers: {} };
    const res = {
        setHeader: () => {},
        writeHead: (code) => { statusCode = code; },
        end: (payload) => { body = payload; }
    };

    handleAdminCompact(req, res);
    assert.equal(statusCode, 401);
});

test('Admin: handleAdminCompact purges cache and returns freed memory snapshot', () => {
    let statusCode = null;
    let body = '';

    const req = {
        headers: {
            authorization: `Bearer ${config.SERVICE_TOKEN}`
        }
    };
    const res = {
        setHeader: () => {},
        writeHead: (code) => { statusCode = code; },
        end: (payload) => { body = payload; }
    };

    handleAdminCompact(req, res);
    assert.equal(statusCode, 200);
    const parsed = JSON.parse(body);
    assert.equal(parsed.status, 'COMPACTED');
    assert.ok(typeof parsed.clearedEntries === 'number');
    assert.ok(parsed.heapFreedMB !== undefined);
});

test('Admin: handleAdminExport generates complete client formats for terminal', () => {
    let statusCode = null;
    let body = '';

    const req = {
        headers: {
            authorization: `Bearer ${config.SERVICE_TOKEN}`,
            host: 'mesh.enterprise.internal'
        }
    };
    const res = {
        setHeader: () => {},
        writeHead: (code) => { statusCode = code; },
        end: (payload) => { body = payload; }
    };

    handleAdminExport(req, res);
    assert.equal(statusCode, 200);
    const parsed = JSON.parse(body);
    assert.ok(parsed.rawUrl);
    assert.strictEqual(parsed.subscriptionUrl, undefined);
    assert.ok(parsed.formats.yaml.includes(config.SERVICE_TOKEN));
    assert.ok(parsed.formats.json.includes(config.SERVICE_TOKEN));
});
