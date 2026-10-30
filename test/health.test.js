// ====================================================================
// Health Diagnostics Controller Tests
// Verifies status, version, dependency availability, and telemetry fields
// ====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDiagnostics } = require('../src/controllers/healthController');

test('Health: Diagnostics snapshot returns expected structure', () => {
    const diag = getDiagnostics();

    assert.equal(diag.status, 'UP');
    assert.equal(typeof diag.version, 'string');
    assert.equal(diag.version, '2.5.0');
    assert.equal(diag.service, 'inventory-sync-gateway');
    assert.equal(typeof diag.uptimeSeconds, 'number');

    // Verify component checks
    assert.ok(diag.components.streamEngine);
    assert.equal(diag.components.streamEngine.status, 'UP');
    assert.ok(diag.components.tunnel);
    assert.equal(diag.components.tunnel.status, 'UP');
    assert.ok(diag.components.datagramProcessor);
    assert.equal(diag.components.datagramProcessor.status, 'UP');
    assert.equal(diag.components.datagramProcessor.mode, 'HYBRID_UDP_HTTPS');
    assert.ok(diag.components.memory);

    // Verify telemetry
    assert.ok(diag.telemetry);
    assert.equal(typeof diag.telemetry.totalRequests, 'number');
});

test('Config: Validates explicit network binding and environment standards', () => {
    const config = require('../src/config');
    assert.ok(config.HOST === '0.0.0.0' || typeof config.HOST === 'string');
    assert.equal(typeof config.PORT, 'number');
    assert.ok(config.PORT > 0 && config.PORT < 65536);
    assert.equal(config.VERSION, '2.5.0');
});
