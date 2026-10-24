// ====================================================================
// Multi-Tenant UUID & Per-Tenant Traffic Tracking Tests
// ====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const BatchDecoder = require('../src/protocol/batchDecoder');
const config = require('../src/config');
const metrics = require('../src/utils/metrics');

test('MultiTenant: BatchDecoder accepts primary service token', () => {
    const decoder = new BatchDecoder();
    const packet = Buffer.alloc(24);
    packet[0] = 0x01; // version
    config.SERVICE_TOKEN_BYTES.copy(packet, 1);
    packet[17] = 0x00; // padding length

    const matched = decoder.validateSignature(packet);
    assert.equal(typeof matched, 'string');
    assert.equal(matched, config.SERVICE_TOKEN);
});

test('MultiTenant: Metrics collector tracks per-tenant streams and throughput', () => {
    const tenantA = 'a1111111-2222-3333-4444-555555555555';
    const tenantB = 'b2222222-3333-4444-5555-666666666666';

    metrics.recordTenantStream(tenantA);
    metrics.recordTenantBytes(tenantA, 5000);

    metrics.recordTenantStream(tenantB);
    metrics.recordTenantBytes(tenantB, 12000);

    const snapshot = metrics.getSnapshot();
    assert.ok(snapshot.tenants);
    assert.ok(snapshot.tenants[tenantA]);
    assert.ok(snapshot.tenants[tenantB]);

    assert.equal(snapshot.tenants[tenantA].totalStreams, 1);
    assert.equal(snapshot.tenants[tenantA].activeStreams, 1);
    assert.equal(snapshot.tenants[tenantA].bytesTransferred, 5000);

    assert.equal(snapshot.tenants[tenantB].bytesTransferred, 12000);

    metrics.decrementTenantStream(tenantA);
    const updated = metrics.getSnapshot();
    assert.equal(updated.tenants[tenantA].activeStreams, 0);
});
