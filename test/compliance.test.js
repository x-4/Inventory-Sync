// ====================================================================
// Network Compliance Validator Tests
// Ensures SSRF prevention filters out private/loopback/cloud metadata IPs and hostnames
// ====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateEndpoint, resolveAndValidateEndpoint } = require('../src/services/complianceValidator');

test('Compliance: Blocks RFC 1918 Private IPv4 Ranges', () => {
    assert.equal(validateEndpoint('10.0.0.1', 80).allowed, false);
    assert.equal(validateEndpoint('172.16.0.1', 443).allowed, false);
    assert.equal(validateEndpoint('192.168.1.1', 8080).allowed, false);
});

test('Compliance: Blocks Loopback & Cloud Metadata IPv4 Ranges', () => {
    assert.equal(validateEndpoint('127.0.0.1', 6379).allowed, false);
    assert.equal(validateEndpoint('169.254.169.254', 80).allowed, false); // AWS/GCP/Azure Metadata
});

test('Compliance: Blocks Restricted IPv6 Ranges', () => {
    assert.equal(validateEndpoint('::1', 80).allowed, false);
    assert.equal(validateEndpoint('fe80::1', 443).allowed, false);
});

test('Compliance: Blocks Loopback & Cloud Metadata Domain Hostnames', () => {
    assert.equal(validateEndpoint('localhost', 6379).allowed, false);
    assert.equal(validateEndpoint('service.localhost', 80).allowed, false);
    assert.equal(validateEndpoint('router.local', 80).allowed, false);
    assert.equal(validateEndpoint('cluster.internal', 8080).allowed, false);
    assert.equal(validateEndpoint('metadata.google.internal', 80).allowed, false);
    assert.equal(validateEndpoint('instance-data', 80).allowed, false);
});

test('Compliance: Rejects Invalid Port Numbers', () => {
    assert.equal(validateEndpoint('8.8.8.8', 0).allowed, false);
    assert.equal(validateEndpoint('8.8.8.8', 70000).allowed, false);
    assert.equal(validateEndpoint('8.8.8.8', -1).allowed, false);
});

test('Compliance: Permits Valid Public Hosts & Domains', () => {
    assert.equal(validateEndpoint('1.1.1.1', 443).allowed, true);
    assert.equal(validateEndpoint('8.8.8.8', 53).allowed, true);
    assert.equal(validateEndpoint('api.github.com', 443).allowed, true);
});

test('Compliance: resolveAndValidateEndpoint detects restricted IP destinations directly', async () => {
    const resPrivate = await resolveAndValidateEndpoint('10.200.1.5', 80);
    assert.equal(resPrivate.allowed, false);

    const resPublic = await resolveAndValidateEndpoint('1.1.1.1', 443);
    assert.equal(resPublic.allowed, true);
    assert.equal(resPublic.resolvedIp, '1.1.1.1');
});

