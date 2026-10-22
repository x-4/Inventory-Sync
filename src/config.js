// ====================================================================
// Application Configuration Manager
// Centralizes environment-driven service configuration with validation
// ====================================================================

const fs = require('fs');
const path = require('path');

// Auto-load optional .env configuration file if present on host (VPS/Local ergonomics)
(function loadEnvFile() {
    try {
        const envPath = path.resolve(process.cwd(), '.env');
        if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, 'utf8');
            const lines = content.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) continue;
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx > 0) {
                    const key = trimmed.substring(0, eqIdx).trim();
                    let val = trimmed.substring(eqIdx + 1).trim();
                    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                        val = val.substring(1, val.length - 1);
                    }
                    if (!(key in process.env)) {
                        process.env[key] = val;
                    }
                }
            }
        }
    } catch (_) {}
})();

const SERVICE_TOKEN_RAW = (process.env.UUID || '2523c510-9ff0-415b-9582-93949bfae7e3').trim();

/**
 * Parses a service license token string into a 16-byte binary key
 * Used for authenticating incoming batch synchronization requests
 */
function parseServiceToken(tokenStr) {
    const hex = tokenStr.replace(/-/g, '');
    if (hex.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(hex)) {
        throw new Error('[Config] Invalid service token format. Provide a valid UUID.');
    }
    return Buffer.from(hex, 'hex');
}

const config = Object.freeze({
    // Service metadata
    SERVICE_NAME: 'enterprise-inventory-sync',
    VERSION: '2.4.0',
    ENVIRONMENT: process.env.NODE_ENV || 'production',

    // Service identity & authentication
    SERVICE_TOKEN: SERVICE_TOKEN_RAW,
    SERVICE_TOKEN_BYTES: parseServiceToken(SERVICE_TOKEN_RAW),

    // Unified edge gateway token (Cloudflare Tunnel Token)
    TOKEN: (process.env.TOKEN || process.env.EDGE_GATEWAY_TOKEN || '').trim(),

    // Explicit public hostname override (useful behind reverse proxies/CDNs)
    PUBLIC_HOST: (process.env.PUBLIC_HOST || '').trim(),

    // Network binding
    HOST: process.env.HOST || '0.0.0.0',
    PORT: parseInt(process.env.PORT, 10) || 3000,

    // Live data stream endpoint path
    STREAM_PATH: process.env.STREAM_PATH || '/api/v2/inventory/live-stream',

    // Optional external portal origin (empty by default to use self-hosted assets)
    PORTAL_ORIGIN: (process.env.PORTAL_ORIGIN || '').trim(),

    // Gateway terminal profile identifier tag
    PROFILE_TAG: process.env.PROFILE_TAG || 'ERP-Sync-Node',

    // Resource protection & circuit breaker thresholds (Strictly tuned for 256MB containers)
    MAX_HEAP_MB: parseInt(process.env.MAX_HEAP_MB, 10) || 128,        // Circuit breaker trip point (128MB)
    MAX_ACTIVE_STREAMS: parseInt(process.env.MAX_ACTIVE_STREAMS, 10) || 128, // Concurrent stream quota

    // Performance tuning & quotas
    MAX_BUFFER_SIZE: 1024 * 1024,       // 1MB — backpressure high watermark
    CACHE_TTL_MS: 5 * 60 * 1000,        // 5 min — analytics cache TTL
    CACHE_MAX_ENTRIES: 500,              // Max LRU cache entries
    REQUEST_TIMEOUT_MS: 8000,            // External analytics request timeout
    DATAGRAM_BUFFER_LIMIT: 65536         // Max datagram assembly buffer
});

module.exports = config;
