// ====================================================================
// Prometheus / OpenMetrics Exposition Exporter Tests
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
    assert.match(output, /# HELP erp_sync_active_streams/);
    assert.match(output, /# TYPE erp_sync_active_streams gauge/);
    assert.match(output, /erp_sync_active_streams \d+/);

    assert.match(output, /# HELP erp_sync_bytes_transferred_total/);
    assert.match(output, /# TYPE erp_sync_bytes_transferred_total counter/);
    assert.match(output, /erp_sync_bytes_transferred_total \d+/);

    assert.match(output, /erp_sync_uptime_seconds \d+/);
    assert.match(output, /erp_sync_requests_total \d+/);
    assert.match(output, /erp_sync_memory_rss_bytes \d+/);
    assert.match(output, /erp_sync_memory_heap_used_bytes \d+/);
});

test('Prometheus: Formats multi-tenant dimensions with standard labels', () => {
    const tenantId = 'test-tenant-uuid-1234';
    metrics.recordTenantStream(tenantId);
    metrics.recordTenantBytes(tenantId, 8888);

    const output = metrics.toPrometheusFormat();
    assert.match(output, /erp_sync_tenant_bytes_transferred_total\{tenant="test-tenant-uuid-1234"\} 8888/);
    assert.match(output, /erp_sync_tenant_active_streams\{tenant="test-tenant-uuid-1234"\} 1/);
    assert.match(output, /erp_sync_tenant_streams_total\{tenant="test-tenant-uuid-1234"\} 1/);
});
