// ====================================================================
// Rate Limiter Unit Tests
// Validates sliding-window failure tracking and IP blocking
// ====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const rateLimiter = require('../src/services/rateLimiter');
const { RateLimiter } = rateLimiter;

test('RateLimiter: Initial state is not blocked', () => {
    const limiter = new RateLimiter();
    assert.equal(limiter.isBlocked('198.51.100.1'), false);
    assert.equal(limiter.isBlocked(null), false);
    assert.equal(limiter.isBlocked(''), false);
});

test('RateLimiter: Does not block below threshold of 5 failures', () => {
    const limiter = new RateLimiter();
    const testIp = '198.51.100.2';

    for (let i = 0; i < 4; i++) {
        limiter.recordFailure(testIp);
        assert.equal(limiter.isBlocked(testIp), false);
    }
});

test('RateLimiter: Blocks IP upon reaching 5 failures in window', () => {
    const limiter = new RateLimiter();
    const testIp = '198.51.100.3';

    for (let i = 0; i < 5; i++) {
        limiter.recordFailure(testIp);
    }

    assert.equal(limiter.isBlocked(testIp), true);
    const stats = limiter.getStats();
    assert.equal(stats.blockedIpsCount >= 1, true);
});

test('RateLimiter: Successful auth resets failure count', () => {
    const limiter = new RateLimiter();
    const testIp = '198.51.100.4';

    limiter.recordFailure(testIp);
    limiter.recordFailure(testIp);
    limiter.recordSuccess(testIp);

    // Another 4 failures should not trigger block because count was reset
    for (let i = 0; i < 4; i++) {
        limiter.recordFailure(testIp);
    }
    assert.equal(limiter.isBlocked(testIp), false);
});

test('RateLimiter: Exempts loopback addresses from blocking', () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 10; i++) {
        limiter.recordFailure('127.0.0.1');
        limiter.recordFailure('::1');
    }
    assert.equal(limiter.isBlocked('127.0.0.1'), false);
    assert.equal(limiter.isBlocked('::1'), false);
});
