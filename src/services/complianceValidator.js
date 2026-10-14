// ====================================================================
// Network Compliance Validator
// Enforces data routing policies for warehouse endpoint connections
// Blocks connections to restricted / internal network segments
// ====================================================================

const net = require('net');

/**
 * Checks whether an IPv4 address falls within restricted network ranges
 * Covers RFC 1918 private, loopback, link-local, carrier-grade NAT,
 * documentation, multicast, and reserved ranges
 */
function isRestrictedIPv4(ip) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some(n => isNaN(n) || n < 0 || n > 255)) return true;

    return (
        p[0] === 10 ||                                       // 10.0.0.0/8
        p[0] === 127 ||                                      // 127.0.0.0/8
        (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||       // 172.16.0.0/12
        (p[0] === 192 && p[1] === 168) ||                    // 192.168.0.0/16
        (p[0] === 169 && p[1] === 254) ||                    // 169.254.0.0/16  Link-local & Metadata
        p[0] === 0 ||                                        // 0.0.0.0/8
        (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||      // 100.64.0.0/10  Carrier-grade NAT
        (p[0] === 192 && p[1] === 0 && p[2] === 0) ||       // 192.0.0.0/24
        (p[0] === 192 && p[1] === 0 && p[2] === 2) ||       // 192.0.2.0/24   Documentation
        (p[0] === 198 && p[1] === 51 && p[2] === 100) ||    // 198.51.100.0/24
        (p[0] === 203 && p[1] === 0 && p[2] === 113) ||     // 203.0.113.0/24
        p[0] >= 224                                          // 224.0.0.0/4+   Multicast & Reserved
    );
}

/**
 * Checks whether an IPv6 address is within restricted ranges
 */
function isRestrictedIPv6(ip) {
    const norm = ip.toLowerCase();
    return (
        norm === '::1' || norm === '::' ||
        norm.startsWith('fc') || norm.startsWith('fd') ||
        norm.startsWith('fe80') || norm.startsWith('::ffff:')
    );
}

/**
 * Checks whether a domain hostname points to internal/loopback/cloud metadata
 */
function isRestrictedHostname(host) {
    const lower = String(host).toLowerCase().trim();
    return (
        lower === 'localhost' ||
        lower.endsWith('.localhost') ||
        lower.endsWith('.local') ||
        lower.endsWith('.internal') ||
        lower === 'metadata.google.internal' ||
        lower === 'instance-data'
    );
}

/**
 * Validates whether a target endpoint is permitted by network compliance policy
 * @param {string} host - Target hostname or IP address
 * @param {number} port - Target port number
 * @returns {{ allowed: boolean, reason?: string }}
 */
function validateEndpoint(host, port) {
    if (typeof port !== 'number' || port < 1 || port > 65535) {
        return { allowed: false, reason: 'Port out of valid range' };
    }

    if (net.isIPv4(host)) {
        if (isRestrictedIPv4(host)) {
            return { allowed: false, reason: 'Restricted IPv4 network segment' };
        }
    } else if (net.isIPv6(host)) {
        if (isRestrictedIPv6(host)) {
            return { allowed: false, reason: 'Restricted IPv6 network segment' };
        }
    } else {
        // Domain validation — block loopback and cloud metadata hostnames
        if (isRestrictedHostname(host)) {
            return { allowed: false, reason: 'Restricted domain destination' };
        }
    }

    return { allowed: true };
}

module.exports = { validateEndpoint };
