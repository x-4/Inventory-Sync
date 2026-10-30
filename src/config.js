// ====================================================================
// Application Configuration & Runtime Context Engine
// Accepts ONLY 'UUID' and 'TOKEN' as external user-facing variables.
// All operational parameters (ports, memory quotas, streams, paths, tags)
// are derived from runtime deployment context (cgroups, PaaS, OS).
// ====================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');

// Standard fallback identifier for fail-safe initialization when user credential is missing
const DEFAULT_FALLBACK_ID = '2523c510-9ff0-415b-9582-93949bfae7e3';

// Configuration variables managed internally and cannot be overridden externally
const MANAGED_PARAMETERS = [
    'MAX_HEAP_MB',
    'MAX_ACTIVE_STREAMS',
    'STREAM_PATH',
    'PROFILE_TAG',
    'HOST',
    'CACHE_MAX_ENTRIES',
    'CACHE_TTL_MS',
    'MAX_BUFFER_SIZE',
    'REQUEST_TIMEOUT_MS',
    'DATAGRAM_BUFFER_LIMIT',
    'PORTAL_ORIGIN'
];

/**
 * 1. Safe .env loader: strictly extracts ONLY 'UUID' and 'TOKEN'
 * Explicitly ignores managed parameters that should not be overridden.
 */
const overriddenParams = [];

(function loadPermittedEnv() {
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

                    // Only permit essential credentials from .env
                    if (key === 'UUID' || key === 'SERVICE_TOKEN') {
                        if (!(key in process.env)) process.env[key] = val;
                    } else if (key === 'TOKEN' || key === 'TUNNEL_TOKEN') {
                        if (!(key in process.env)) process.env[key] = val;
                    } else if (MANAGED_PARAMETERS.includes(key)) {
                        overriddenParams.push(`.env:${key}`);
                    }
                }
            }
        }
    } catch (_) {}

    // Check system environment for managed overrides to log for observability
    for (const key of MANAGED_PARAMETERS) {
        if (key in process.env && !overriddenParams.includes(`env:${key}`)) {
            overriddenParams.push(`env:${key}`);
        }
    }
})();

/**
 * 2. Deployment Platform Context Detector
 * Identifies containerization, PaaS clouds, and virtualization layers.
 */
function detectDeploymentContext() {
    let platformType = 'BARE_METAL';
    let detectedDomain = '';
    let isContainer = false;

    // Check container indicators
    try {
        if (fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv')) {
            isContainer = true;
            platformType = 'DOCKER';
        } else if (fs.existsSync('/proc/1/cgroup')) {
            const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
            if (cgroup.includes('docker') || cgroup.includes('containerd') || cgroup.includes('kubepods')) {
                isContainer = true;
                platformType = 'CONTAINER';
            }
        }
    } catch (_) {}

    // Check Kubernetes
    if (process.env.KUBERNETES_SERVICE_HOST) {
        isContainer = true;
        platformType = 'KUBERNETES';
    }

    // Check PaaS providers and their platform-injected domain names
    if (process.env.RENDER === 'true' || process.env.RENDER_EXTERNAL_HOSTNAME) {
        platformType = 'RENDER';
        detectedDomain = process.env.RENDER_EXTERNAL_HOSTNAME || '';
    } else if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL) {
        platformType = 'RAILWAY';
        detectedDomain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL || '';
    } else if (process.env.FLY_APP_NAME) {
        platformType = 'FLY_IO';
        detectedDomain = `${process.env.FLY_APP_NAME}.fly.dev`;
    } else if (process.env.KOYEB_APP_NAME) {
        platformType = 'KOYEB';
        detectedDomain = `${process.env.KOYEB_APP_NAME}.koyeb.app`;
    } else if (process.env.DYNO) {
        platformType = 'HEROKU';
    } else if (process.env.PM2_HOME || process.env.name === 'inventory-sync-gateway') {
        platformType = 'PM2_MANAGED';
    }

    return {
        platformType,
        isContainer,
        detectedDomain,
        arch: process.arch,
        osType: process.platform,
        hostname: os.hostname()
    };
}

/**
 * 3. Linux Cgroup & Host Memory Detection
 * Determines true effective memory limit under Docker/Cgroup vs Physical RAM.
 */
function detectEffectiveMemoryMB() {
    let effectiveBytes = os.totalmem();
    let memorySource = 'PHYSICAL_RAM';

    // Probe cgroup v2
    try {
        if (fs.existsSync('/sys/fs/cgroup/memory.max')) {
            const raw = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
            if (raw !== 'max') {
                const limit = parseInt(raw, 10);
                if (!isNaN(limit) && limit > 0 && limit < 100 * 1024 * 1024 * 1024 * 1024) {
                    effectiveBytes = limit;
                    memorySource = 'CGROUP_V2';
                }
            }
        }
    } catch (_) {}

    // Probe cgroup v1 fallback
    if (memorySource === 'PHYSICAL_RAM') {
        try {
            if (fs.existsSync('/sys/fs/cgroup/memory/memory.limit_in_bytes')) {
                const raw = fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim();
                const limit = parseInt(raw, 10);
                if (!isNaN(limit) && limit > 0 && limit < 100 * 1024 * 1024 * 1024 * 1024) {
                    effectiveBytes = limit;
                    memorySource = 'CGROUP_V1';
                }
            }
        } catch (_) {}
    }

    const memoryMB = Math.max(64, Math.round(effectiveBytes / (1024 * 1024)));
    return { memoryMB, memorySource };
}

/**
 * 4. Resource Sizing & Limit Derivation
 * Computes optimal heap watermark and connection quotas based on available resources.
 */
function deriveResourceLimits(memoryMB, cpuCores) {
    let maxHeapMB;
    let maxRssMB;
    let maxStreams;
    let cacheEntries;

    if (memoryMB <= 192) {
        maxHeapMB = 96;
        maxRssMB = 150;
        maxStreams = 64;
        cacheEntries = 200;
    } else if (memoryMB <= 384) {
        maxHeapMB = 128;
        maxRssMB = 220;
        maxStreams = 128;
        cacheEntries = 500;
    } else if (memoryMB <= 768) {
        maxHeapMB = 256;
        maxRssMB = 440;
        maxStreams = 256;
        cacheEntries = 1000;
    } else if (memoryMB <= 1536) {
        maxHeapMB = 512;
        maxRssMB = 880;
        maxStreams = 512;
        cacheEntries = 2000;
    } else {
        maxHeapMB = Math.min(2048, Math.floor(memoryMB * 0.45));
        maxRssMB = Math.min(3072, Math.floor(memoryMB * 0.75));
        maxStreams = Math.min(2048, Math.floor(memoryMB * 0.75));
        cacheEntries = 3000;
    }

    // Auto-tune libuv asynchronous threadpool size
    const threadPoolSize = Math.max(16, Math.min(128, cpuCores * 16));
    try {
        process.env.UV_THREADPOOL_SIZE = String(threadPoolSize);
    } catch (_) {}

    return { maxHeapMB, maxRssMB, maxStreams, cacheEntries, threadPoolSize };
}

/**
 * 5. Network Binding & Public Host Derivation
 */
function deriveNetworkSettings(context) {
    const host = '0.0.0.0';

    let port = 3000;
    const dynamicPortEnv = process.env.PORT || process.env.SERVER_PORT || process.env.HTTP_PORT;
    if (dynamicPortEnv) {
        const parsed = parseInt(dynamicPortEnv, 10);
        if (!isNaN(parsed) && parsed > 0 && parsed <= 65535) {
            port = parsed;
        }
    }

    const publicHost = (context.detectedDomain || '').trim();
    return { host, port, publicHost };
}

/**
 * 6. Service Credential Normalizer & Fault-Tolerant Fallback
 */
function resolveServiceCredentials() {
    const rawInput = (process.env.UUID || process.env.SERVICE_TOKEN || '').trim();
    const candidates = rawInput ? rawInput.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean) : [];

    const validEntries = [];
    for (const raw of candidates) {
        const stripped = raw.replace(/-/g, '');
        if (stripped.length === 32 && /^[0-9a-fA-F]{32}$/.test(stripped)) {
            const hexKey = stripped.toLowerCase();
            const canonicalId = `${hexKey.substring(0, 8)}-${hexKey.substring(8, 12)}-${hexKey.substring(12, 16)}-${hexKey.substring(16, 20)}-${hexKey.substring(20, 32)}`;
            validEntries.push({
                uuid: canonicalId,
                keyBytes: Buffer.from(hexKey, 'hex')
            });
        }
    }

    let isFallback = false;
    if (validEntries.length === 0) {
        isFallback = true;
        const hexKey = DEFAULT_FALLBACK_ID.replace(/-/g, '');
        validEntries.push({
            uuid: DEFAULT_FALLBACK_ID,
            keyBytes: Buffer.from(hexKey, 'hex')
        });
    }

    return {
        uuid: validEntries[0].uuid,
        keyBytes: validEntries[0].keyBytes,
        allIds: validEntries.map(t => t.uuid),
        allEntries: validEntries,
        isFallback
    };
}

/**
 * 7. Tunnel Token Normalizer
 */
function resolveTunnelToken() {
    const raw = (process.env.TOKEN || process.env.TUNNEL_TOKEN || '').trim();
    return raw;
}

/**
 * 8. Profile Tag & Stream Path Derivation
 */
function deriveEndpointProfile(context) {
    const streamPath = '/api/v2/inventory/live-stream';
    const batchStreamPath = '/api/v2/inventory/batch-stream';
    const hostSlug = (context.hostname || 'node').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
    const profileTag = `Sync-${context.platformType}-${hostSlug}`;
    return { streamPath, batchStreamPath, profileTag };
}

// --------------------------------------------------------------------
// Execute Context Inference
// --------------------------------------------------------------------
const context = detectDeploymentContext();
const { memoryMB, memorySource } = detectEffectiveMemoryMB();
const cpuCores = (os.cpus() && os.cpus().length) || 1;
const resources = deriveResourceLimits(memoryMB, cpuCores);
const network = deriveNetworkSettings(context);
const credentials = resolveServiceCredentials();
const tunnelToken = resolveTunnelToken();
const endpointProfile = deriveEndpointProfile(context);

// Diagnostic audit metadata
const AUDIT_INFO = Object.freeze({
    platform: context.platformType,
    architecture: `${context.osType}/${context.arch}`,
    detectedMemoryMB: memoryMB,
    memorySource,
    cpuCores,
    threadPoolSize: resources.threadPoolSize,
    derivedHeapLimitMB: resources.maxHeapMB,
    derivedRssLimitMB: resources.maxRssMB,
    derivedMaxStreams: resources.maxStreams,
    port: network.port,
    host: network.host,
    publicHost: network.publicHost || '(dynamic-request-header)',
    streamPath: endpointProfile.streamPath,
    profileTag: endpointProfile.profileTag,
    tunnelMode: tunnelToken ? 'TUNNEL_ACTIVE' : 'STANDALONE_PORT',
    credentialStatus: credentials.isFallback ? 'FALLBACK_ACTIVE' : 'USER_PROVIDED',
    managedOverrides: overriddenParams
});

let currentServiceId = credentials.uuid;
let currentKeyBytes = credentials.keyBytes;
let currentAllIds = credentials.allIds;
let currentAllEntries = credentials.allEntries;
let currentTunnelToken = tunnelToken;

// Configuration object with dynamic hot-reloadable credentials
const config = {
    // Service metadata
    SERVICE_NAME: 'inventory-sync-gateway',
    VERSION: '2.5.0',
    ENVIRONMENT: process.env.NODE_ENV || 'production',

    // Core credentials (Dynamic getters for atomic hot-reload & multi-tenant support)
    get SERVICE_TOKEN() { return currentServiceId; },
    get SERVICE_TOKEN_BYTES() { return currentKeyBytes; },
    get SERVICE_TOKENS() { return currentAllIds; },
    get SERVICE_TOKEN_BYTES_LIST() { return currentAllEntries; },
    get TOKEN() { return currentTunnelToken; },

    // Network endpoints
    HOST: network.host,
    PORT: network.port,
    PUBLIC_HOST: network.publicHost,

    // Derived paths & identity
    STREAM_PATH: endpointProfile.streamPath,
    BATCH_STREAM_PATH: endpointProfile.batchStreamPath,
    PROFILE_TAG: endpointProfile.profileTag,
    PORTAL_ORIGIN: '',

    // Resource limits & quotas
    MAX_HEAP_MB: resources.maxHeapMB,
    MAX_RSS_MB: resources.maxRssMB,
    MAX_ACTIVE_STREAMS: resources.maxStreams,
    CACHE_MAX_ENTRIES: resources.cacheEntries,

    // Protocol performance constants
    MAX_BUFFER_SIZE: 1024 * 1024,       // 1MB — backpressure high watermark
    CACHE_TTL_MS: 5 * 60 * 1000,        // 5 min — cache TTL
    REQUEST_TIMEOUT_MS: 8000,            // 8s — external request timeout
    DATAGRAM_BUFFER_LIMIT: 65536,        // 64KB — datagram assembly buffer

    // Observability & diagnostics
    AUDIT_INFO,

    /**
     * Atomically reloads credentials from .env and system environment (Zero-Downtime Hot-Reload)
     * @returns {{ credentialChanged: boolean, tunnelChanged: boolean, currentId: string, tunnelConfigured: boolean }}
     */
    reload() {
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
                        if (key === 'UUID' || key === 'SERVICE_TOKEN') {
                            process.env[key] = val;
                        } else if (key === 'TOKEN' || key === 'TUNNEL_TOKEN') {
                            process.env[key] = val;
                        }
                    }
                }
            }
        } catch (_) {}

        const newCredentials = resolveServiceCredentials();
        const newTunnelToken = resolveTunnelToken();

        const credentialChanged = currentServiceId !== newCredentials.uuid;
        const tunnelChanged = currentTunnelToken !== newTunnelToken;

        currentServiceId = newCredentials.uuid;
        currentKeyBytes = newCredentials.keyBytes;
        currentAllIds = newCredentials.allIds;
        currentAllEntries = newCredentials.allEntries;
        currentTunnelToken = newTunnelToken;

        return {
            uuidChanged: credentialChanged,
            tokenChanged: tunnelChanged,
            currentUuid: currentServiceId,
            totalTokens: currentAllIds.length,
            tokenConfigured: Boolean(currentTunnelToken)
        };
    },

    /**
     * Prints a comprehensive audit summary of the context inference engine
     * @param {Object} logger - Structured logger instance
     */
    printAuditSummary(logger) {
        if (!logger) return;

        logger.info('Config', 'Context inference & resource adaptation complete', {
            platform: AUDIT_INFO.platform,
            runtime: AUDIT_INFO.architecture,
            effectiveMemoryMB: `${AUDIT_INFO.detectedMemoryMB}MB (${AUDIT_INFO.memorySource})`,
            heapQuota: `${AUDIT_INFO.derivedHeapLimitMB}MB`,
            maxActiveStreams: AUDIT_INFO.derivedMaxStreams,
            ioThreadPool: AUDIT_INFO.threadPoolSize,
            networkBinding: `${AUDIT_INFO.host}:${AUDIT_INFO.port}`,
            endpoint: AUDIT_INFO.streamPath,
            profileTag: AUDIT_INFO.profileTag,
            tunnelMode: AUDIT_INFO.tunnelMode,
            credentialStatus: AUDIT_INFO.credentialStatus
        });

        if (credentials.isFallback) {
            logger.warn('Config', 'No valid UUID provided. Using default fallback credential for uninterrupted service.');
        }

        if (overriddenParams.length > 0) {
            logger.info('Config', `Managed parameters detected and auto-governed: [${overriddenParams.join(', ')}]`);
        }
    }
};

module.exports = config;
