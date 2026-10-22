// ====================================================================
// Ingress Resolver Tests
// Verifies multi-layer reverse proxy header extraction (X-Forwarded-*, CF-Visitor, etc.)
// ====================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePublicIngress } = require('../src/utils/ingressResolver');

test('Ingress: Resolves standard direct HTTP request correctly', () => {
    const req = {
        headers: {
            host: 'localhost:3000'
        },
        socket: { remoteAddress: '127.0.0.1' }
    };

    const ingress = resolvePublicIngress(req);
    assert.equal(ingress.hostname, 'localhost');
    assert.equal(ingress.port, 3000);
    assert.equal(ingress.protocol, 'http');
    assert.equal(ingress.isSecure, false);
    assert.equal(ingress.clientIp, '127.0.0.1');
});

test('Ingress: Resolves multi-tier reverse proxy HTTPS with X-Forwarded headers', () => {
    const req = {
        headers: {
            host: '10.0.0.2:3000',
            'x-forwarded-host': 'sync.enterprise.com, internal-proxy',
            'x-forwarded-proto': 'https, http',
            'x-forwarded-port': '443',
            'x-forwarded-for': '203.0.113.195, 10.0.0.1'
        }
    };

    const ingress = resolvePublicIngress(req);
    assert.equal(ingress.hostname, 'sync.enterprise.com');
    assert.equal(ingress.port, 443);
    assert.equal(ingress.protocol, 'https');
    assert.equal(ingress.isSecure, true);
    assert.equal(ingress.clientIp, '203.0.113.195');
    assert.equal(ingress.host, 'sync.enterprise.com');
});

test('Ingress: Resolves Cloudflare CF-Visitor scheme and CF-Connecting-IP', () => {
    const req = {
        headers: {
            host: 'cf-edge.enterprise.org',
            'cf-visitor': '{"scheme":"https"}',
            'cf-connecting-ip': '198.51.100.42'
        }
    };

    const ingress = resolvePublicIngress(req);
    assert.equal(ingress.hostname, 'cf-edge.enterprise.org');
    assert.equal(ingress.port, 443);
    assert.equal(ingress.protocol, 'https');
    assert.equal(ingress.isSecure, true);
    assert.equal(ingress.clientIp, '198.51.100.42');
});

test('Ingress: Resolves custom non-standard public port (e.g., PaaS 6425)', () => {
    const req = {
        headers: {
            'x-forwarded-host': 'paas.custom.net:6425',
            'x-forwarded-proto': 'https'
        }
    };

    const ingress = resolvePublicIngress(req);
    assert.equal(ingress.hostname, 'paas.custom.net');
    assert.equal(ingress.port, 6425);
    assert.equal(ingress.protocol, 'https');
    assert.equal(ingress.isSecure, true);
    assert.equal(ingress.host, 'paas.custom.net:6425');
});
