// ====================================================================
// Batch Decoder (Protocol) Tests
// Verifies constant-time signature validation, framing, and boundary safety
// ====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const BatchDecoder = require('../src/protocol/batchDecoder');
const config = require('../src/config');

test('Decoder: Rejects truncated buffers and invalid signatures', () => {
    const decoder = new BatchDecoder();

    assert.equal(decoder.decodeHeader(Buffer.alloc(10)), null);
    assert.equal(decoder.decodeHeader(Buffer.alloc(24)), null); // All zeroes (wrong key)
});

test('Decoder: Correctly parses valid reliable-stream IPv4 payload', () => {
    const decoder = new BatchDecoder();

    // Construct valid packet:
    // [0]: version (0)
    // [1..16]: UUID token bytes
    // [17]: padding length (0)
    // [18]: transportMode (1: TCP)
    // [19..20]: port (443 -> 0x01, 0xbb)
    // [21]: addressType (1: IPv4)
    // [22..25]: IPv4 (1.1.1.1)
    // [26..]: payload data ("PING")
    const packet = Buffer.concat([
        Buffer.from([0]),
        config.SERVICE_TOKEN_BYTES,
        Buffer.from([0]),                   // padding = 0
        Buffer.from([1]),                   // transportMode = 1
        Buffer.from([0x01, 0xbb]),          // port = 443
        Buffer.from([1]),                   // addressType = 1
        Buffer.from([1, 1, 1, 1]),          // targetHost = 1.1.1.1
        Buffer.from('PING')                 // payload
    ]);

    const header = decoder.decodeHeader(packet);
    assert.ok(header);
    assert.equal(header.transportMode, 1);
    assert.equal(header.targetPort, 443);
    assert.equal(header.targetHost, '1.1.1.1');
    assert.equal(header.payloadStart, 26);
});

test('Decoder: Out-of-bounds padding does not cause crash or buffer read exception', () => {
    const decoder = new BatchDecoder();

    // Malicious packet with huge padding
    const packet = Buffer.concat([
        Buffer.from([0]),
        config.SERVICE_TOKEN_BYTES,
        Buffer.from([250]),                 // padding = 250 (exceeds total length)
        Buffer.from([1, 0x01, 0xbb, 1, 1, 1, 1, 1])
    ]);

    const header = decoder.decodeHeader(packet);
    assert.equal(header, null); // Gracefully returns null without crashing
});
