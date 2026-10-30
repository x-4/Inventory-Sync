// ====================================================================
// Datagram Processor & SWR / Singleflight Unit Tests
// ====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { ResponseCache, purgeResponseCache } = require('../src/services/datagramProcessor');

test('ResponseCache: Standard LRU storage and retrieval within TTL', () => {
    const cache = new ResponseCache(10, 1000); // 1s TTL
    const payload = Buffer.from('query_result_sample');
    cache.set('key1', payload);

    const hit = cache.get('key1');
    assert.ok(hit);
    assert.equal(hit.data.toString(), 'query_result_sample');
    assert.equal(hit.isStale, false);
});

test('ResponseCache: SWR awareness yields stale data between 1x and 2x TTL', async () => {
    const cache = new ResponseCache(10, 50); // 50ms TTL
    const payload = Buffer.from('sample_stale_data');
    cache.set('stale_key', payload);

    // Wait 60ms (> 1x TTL, < 2x TTL)
    await new Promise(resolve => setTimeout(resolve, 60));

    const result = cache.get('stale_key');
    assert.ok(result, 'Cache should return data within 2x TTL window');
    assert.equal(result.data.toString(), 'sample_stale_data');
    assert.equal(result.isStale, true, 'Result must be flagged as stale');
});

test('ResponseCache: Hard expiration purges data beyond 2x TTL', async () => {
    const cache = new ResponseCache(10, 30); // 30ms TTL
    cache.set('exp_key', Buffer.from('expired'));

    // Wait 70ms (> 2x TTL)
    await new Promise(resolve => setTimeout(resolve, 70));

    const result = cache.get('exp_key');
    assert.equal(result, null, 'Cache must return null beyond 2x TTL');
});

test('ResponseCache: Clear purges all active entries', () => {
    const cache = new ResponseCache(10, 10000);
    cache.set('k1', Buffer.from('v1'));
    cache.set('k2', Buffer.from('v2'));
    assert.equal(cache.clear(), 2);
    assert.equal(cache.get('k1'), null);
});
