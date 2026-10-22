// ====================================================================
// Universal Ingress & Reverse Proxy Context Resolver
// Intelligently reconstructs real client endpoints, protocols, and ports
// across complex multi-tier CDN / Ingress / Reverse Proxy architectures
// (Cloudflare, Nginx, Caddy, Traefik, AWS ALB, Envoy, PaaS Ingress).
// ====================================================================

const config = require('../config');

/**
 * Resolves comprehensive public ingress metadata from an incoming HTTP request
 * @param {import('http').IncomingMessage} req
 * @returns {{
 *   host: string,
 *   hostname: string,
 *   port: number,
 *   protocol: 'http' | 'https',
 *   isSecure: boolean,
 *   clientIp: string,
 *   fullUrl: string
 * }}
 */
function resolvePublicIngress(req) {
    if (!req || !req.headers) {
        return {
            host: config.PUBLIC_HOST || `localhost:${config.PORT}`,
            hostname: config.PUBLIC_HOST || 'localhost',
            port: config.PORT,
            protocol: 'http',
            isSecure: false,
            clientIp: '127.0.0.1',
            fullUrl: `http://localhost:${config.PORT}/`
        };
    }

    const headers = req.headers;

    // 1. Resolve Protocol (HTTPS / HTTP)
    let protocol = 'http';
    if (req.socket && req.socket.encrypted) {
        protocol = 'https';
    } else if (headers['x-forwarded-proto']) {
        const protoRaw = headers['x-forwarded-proto'].split(',')[0].trim().toLowerCase();
        if (protoRaw === 'https' || protoRaw === 'http') {
            protocol = protoRaw;
        }
    } else if (headers['cf-visitor']) {
        try {
            const visitor = JSON.parse(headers['cf-visitor']);
            if (visitor && visitor.scheme) {
                protocol = visitor.scheme.toLowerCase();
            }
        } catch (_) {}
    } else if (headers['x-forwarded-ssl'] === 'on' || headers['front-end-https'] === 'on') {
        protocol = 'https';
    }

    // 2. Resolve Host & Port
    // Priority: config.PUBLIC_HOST -> X-Forwarded-Host -> Host header -> localhost
    let rawHost = (config.PUBLIC_HOST || '').trim();
    if (!rawHost && headers['x-forwarded-host']) {
        rawHost = headers['x-forwarded-host'].split(',')[0].trim();
    }
    if (!rawHost && headers.host) {
        rawHost = headers.host.trim();
    }
    if (!rawHost) {
        rawHost = `localhost:${config.PORT}`;
    }

    let hostname = rawHost;
    let port = protocol === 'https' ? 443 : 80;

    // Check if host string explicitly specifies a port (e.g., example.com:8443)
    const colonIdx = rawHost.lastIndexOf(':');
    if (colonIdx > 0 && !rawHost.endsWith(']')) { // Avoid IPv6 closing bracket false positive
        const portStr = rawHost.substring(colonIdx + 1);
        const parsedPort = parseInt(portStr, 10);
        if (!isNaN(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
            hostname = rawHost.substring(0, colonIdx);
            port = parsedPort;
        }
    } else if (headers['x-forwarded-port']) {
        const parsedPort = parseInt(headers['x-forwarded-port'].split(',')[0].trim(), 10);
        if (!isNaN(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
            port = parsedPort;
        }
    } else if (hostname === 'localhost' || /^127\.|^10\.|^172\.(1[6-9]|2[0-9]|3[0-1])\.|^192\.168\./.test(hostname)) {
        // Direct local or private IP access without explicit proxy port
        port = config.PORT;
    }

    // Reconstruct canonical host string
    const isStandardPort = (protocol === 'https' && port === 443) || (protocol === 'http' && port === 80);
    const host = isStandardPort ? hostname : `${hostname}:${port}`;
    const isSecure = protocol === 'https';

    // 3. Resolve Real Client IP
    let clientIp = (headers['cf-connecting-ip'] ||
        headers['x-real-ip'] ||
        (headers['x-forwarded-for'] && headers['x-forwarded-for'].split(',')[0].trim()) ||
        (req.socket && req.socket.remoteAddress) ||
        '127.0.0.1').trim();

    // Clean IPv6 IPv4-mapped prefix (::ffff:1.2.3.4)
    if (clientIp.startsWith('::ffff:')) {
        clientIp = clientIp.substring(7);
    }

    const fullUrl = `${protocol}://${host}${req.url || '/'}`;

    return {
        host,
        hostname,
        port,
        protocol,
        isSecure,
        clientIp,
        fullUrl
    };
}

module.exports = {
    resolvePublicIngress
};
