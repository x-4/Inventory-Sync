// ====================================================================
// Prometheus / OpenMetrics Exposition Tests
// ====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const metrics = require('../src/utils/metrics');

test('Prometheus: toPrometheusFormat generates valid OpenMetrics plain-text exposition', () => {
    metrics.incrementRequests();
    metrics.incrementStreams();
    metrics.addBytes(1024);

    const output = metrics.toPrometheusFormat();

    // Verify OpenMetrics line structure
    assert.ok(typeof output === 'string');
    assert.match(output, /# HELP sync_gateway_active_streams/);
    assert.match(output, /# TYPE sync_gateway_active_streams gauge/);
    assert.match(output, /sync_gateway_active_streams \d+/);

    assert.match(output, /# HELP sync_gateway_bytes_total/);
    assert.match(output, /# TYPE sync_gateway_bytes_total counter/);
    assert.match(output, /sync_gateway_bytes_total \d+/);

    assert.match(output, /sync_gateway_uptime_seconds \d+/);
    assert.match(output, /sync_gateway_requests_total \d+/);
    assert.match(output, /sync_gateway_memory_rss_bytes \d+/);
    assert.match(output, /sync_gateway_memory_heap_bytes \d+/);
});

test('Prometheus: Formats multi-tenant dimensions with standard labels', () => {
    const tenantId = 'test-tenant-uuid-1234';
    metrics.recordTenantStream(tenantId);
    metrics.recordTenantBytes(tenantId, 8888);

    const output = metrics.toPrometheusFormat();
    assert.match(output, /sync_gateway_tenant_bytes_total\{tenant="test-tenant-uuid-1234"\} 8888/);
    assert.match(output, /sync_gateway_tenant_active_streams\{tenant="test-tenant-uuid-1234"\} 1/);
    assert.match(output, /sync_gateway_tenant_streams_total\{tenant="test-tenant-uuid-1234"\} 1/);
});
