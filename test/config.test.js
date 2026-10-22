// ====================================================================
// Autonomous Configuration & Context Inference Engine Tests
// Verifies 2-parameter rule (UUID & TOKEN only), hardware resource auto-tuning,
// fallback UUID recovery, and override bypass policy
// ====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

test('Config: Autonomous context inference derives optimal parameters', () => {
    const config = require('../src/config');

    // 1. Core required identity
    assert.equal(typeof config.SERVICE_TOKEN, 'string');
    assert.match(config.SERVICE_TOKEN, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.ok(Buffer.isBuffer(config.SERVICE_TOKEN_BYTES));
    assert.equal(config.SERVICE_TOKEN_BYTES.length, 16);

    // 2. Network binding autotuned
    assert.equal(config.HOST, '0.0.0.0');
    assert.ok(typeof config.PORT === 'number' && config.PORT >= 1 && config.PORT <= 65535);

    // 3. Autonomous resource quotas derived from system/cgroup memory
    assert.ok(typeof config.MAX_HEAP_MB === 'number');
    assert.ok(config.MAX_HEAP_MB >= 64, 'Heap limit should be at least 64MB');
    assert.ok(typeof config.MAX_ACTIVE_STREAMS === 'number');
    assert.ok(config.MAX_ACTIVE_STREAMS >= 32, 'Stream quota should be at least 32');

    // 4. Autonomous enterprise disguise parameters
    assert.equal(config.STREAM_PATH, '/api/v2/inventory/live-stream');
    assert.ok(config.PROFILE_TAG.startsWith('ERP-Sync-'));

    // 5. Audit metadata verification
    assert.ok(config.AUDIT_INFO);
    assert.ok(config.AUDIT_INFO.platform);
    assert.ok(config.AUDIT_INFO.detectedMemoryMB > 0);
    assert.ok(['OS_PHYSICAL_RAM', 'LINUX_CGROUP_V1', 'LINUX_CGROUP_V2'].includes(config.AUDIT_INFO.memorySource));
    assert.ok(Array.isArray(config.AUDIT_INFO.ignoredManualOverrides));

    // 6. Audit printer execution
    let auditLogged = false;
    const mockLogger = {
        info: () => { auditLogged = true; },
        warn: () => {},
        error: () => {}
    };
    config.printAuditSummary(mockLogger);
    assert.equal(auditLogged, true);
});
