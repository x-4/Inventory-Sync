// ====================================================================
// Edge Gateway Supervisor Tests
// Verifies cross-platform provisioning resolution, lifecycle, and status
// ====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const edgeGateway = require('../src/services/edgeGateway');

test('EdgeGateway: Platform information detection matches current runtime', () => {
    const info = edgeGateway.getPlatformInfo();
    assert.ok(info, 'Platform info should not be null for supported architectures');
    assert.ok(['linux', 'darwin', 'windows'].includes(info.os));
    assert.ok(['amd64', 'arm64', 'arm', '386'].includes(info.arch));
    assert.ok(info.url.startsWith('https://github.com/cloudflare/cloudflared/releases/latest/download/'));
    assert.ok(info.filename.includes(info.os));
});

test('EdgeGateway: Resolves a writable directory for binary provisioning', () => {
    const dir = edgeGateway.resolveWritableDir();
    assert.ok(typeof dir === 'string' && dir.length > 0);
    assert.ok(fs.existsSync(dir), 'Resolved directory must exist on filesystem');
});

test('EdgeGateway: getStatus returns compliant enterprise diagnostics schema', () => {
    const status = edgeGateway.getStatus();
    assert.ok(['UP', 'DEGRADED', 'DISABLED'].includes(status.status));
    assert.ok(['EDGE_UPLINK', 'DIRECT_PORT', 'EMBEDDED_SUPERVISOR', 'EXTERNAL_SUPERVISOR'].includes(status.mode));
    assert.equal(typeof status.configured, 'boolean');
    assert.equal(typeof status.restarts, 'number');
    assert.equal(typeof status.binaryPath, 'string');
});
