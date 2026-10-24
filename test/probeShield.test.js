// ====================================================================
// ProbeShield Unit Tests
// Validates sliding-window failure rate tracking and active scan quarantine
// ====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const probeShield = require('../src/services/probeShield');
const { ProbeShield } = probeShield;

test('ProbeShield: Initial state is not blocked', () => {
    const shield = new ProbeShield();
    assert.equal(shield.isBlocked('198.51.100.1'), false);
    assert.equal(shield.isBlocked(null), false);
    assert.equal(shield.isBlocked(''), false);
});

test('ProbeShield: Does not block below threshold of 5 failures', () => {
    const shield = new ProbeShield();
    const testIp = '198.51.100.2';

    for (let i = 0; i < 4; i++) {
        shield.recordFailure(testIp);
        assert.equal(shield.isBlocked(testIp), false);
    }
});

test('ProbeShield: Quarantines IP upon reaching 5 failures in window', () => {
    const shield = new ProbeShield();
    const testIp = '198.51.100.3';

    for (let i = 0; i < 5; i++) {
        shield.recordFailure(testIp);
    }

    assert.equal(shield.isBlocked(testIp), true);
    const stats = shield.getStats();
    assert.equal(stats.quarantinedIpsCount >= 1, true);
});

test('ProbeShield: Successful auth resets failure count prior to quarantine', () => {
    const shield = new ProbeShield();
    const testIp = '198.51.100.4';

    shield.recordFailure(testIp);
    shield.recordFailure(testIp);
    shield.recordSuccess(testIp);

    // Another 4 failures should not trigger block because count was reset
    for (let i = 0; i < 4; i++) {
        shield.recordFailure(testIp);
    }
    assert.equal(shield.isBlocked(testIp), false);
});

test('ProbeShield: Whitelists loopback addresses from quarantine', () => {
    const shield = new ProbeShield();
    for (let i = 0; i < 10; i++) {
        shield.recordFailure('127.0.0.1');
        shield.recordFailure('::1');
    }
    assert.equal(shield.isBlocked('127.0.0.1'), false);
    assert.equal(shield.isBlocked('::1'), false);
});
