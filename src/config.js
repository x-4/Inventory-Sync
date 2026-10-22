// ====================================================================
// Autonomous Application Configuration & Context Inference Engine
// Strictly accepts ONLY 'UUID' and 'TOKEN' as external user variables.
// All operational parameters (ports, memory quotas, streams, paths, tags)
// are autonomously derived from runtime deployment context (cgroups, PaaS, OS).
// ====================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');

// Standard fallback UUID for fail-safe initialization when user UUID is missing or invalid
const DETERMINISTIC_FALLBACK_UUID = '2523c510-9ff0-415b-9582-93949bfae7e3';

// List of configuration variables that must be autonomously managed and cannot be manually overridden
const PROHIBITED_MANUAL_OVERRIDES = [
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
 * Explicitly ignores and bypasses any prohibited manual overrides.
 */
const ignoredOverridesDetected = [];

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

                    // Only permit essential tokens from .env
                    if (key === 'UUID' || key === 'SERVICE_TOKEN') {
                        if (!(key in process.env)) process.env[key] = val;
                    } else if (key === 'TOKEN' || key === 'EDGE_GATEWAY_TOKEN') {
                        if (!(key in process.env)) process.env[key] = val;
                    } else if (PROHIBITED_MANUAL_OVERRIDES.includes(key)) {
                        ignoredOverridesDetected.push(`.env:${key}`);
                    }
                }
            }
        }
    } catch (_) {}

    // Check system environment for prohibited overrides to log for observability
    for (const key of PROHIBITED_MANUAL_OVERRIDES) {
        if (key in process.env && !ignoredOverridesDetected.includes(`env:${key}`)) {
            ignoredOverridesDetected.push(`env:${key}`);
        }
    }
})();

/**
 * 2. Deployment Platform Context Detector
 * Identifies containerization, PaaS clouds, and virtualization layers.
 */
function detectDeploymentContext() {
    let platformType = 'BARE_METAL_HOST';
    let detectedDomain = '';
    let isContainer = false;

    // Check container indicators
    try {
        if (fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv')) {
            isContainer = true;
            platformType = 'DOCKER_CONTAINER';
        } else if (fs.existsSync('/proc/1/cgroup')) {
            const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
            if (cgroup.includes('docker') || cgroup.includes('containerd') || cgroup.includes('kubepods')) {
                isContainer = true;
                platformType = 'CONTAINER_CGROUP';
            }
        }
    } catch (_) {}

    // Check Kubernetes
    if (process.env.KUBERNETES_SERVICE_HOST) {
        isContainer = true;
        platformType = 'KUBERNETES_CLUSTER';
    }

    // Check PaaS providers and their platform-injected domain names
    if (process.env.RENDER === 'true' || process.env.RENDER_EXTERNAL_HOSTNAME) {
        platformType = 'RENDER_PAAS';
        detectedDomain = process.env.RENDER_EXTERNAL_HOSTNAME || '';
    } else if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL) {
        platformType = 'RAILWAY_PAAS';
        detectedDomain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL || '';
    } else if (process.env.FLY_APP_NAME) {
        platformType = 'FLY_IO_PAAS';
        detectedDomain = `${process.env.FLY_APP_NAME}.fly.dev`;
    } else if (process.env.KOYEB_APP_NAME) {
        platformType = 'KOYEB_PAAS';
        detectedDomain = `${process.env.KOYEB_APP_NAME}.koyeb.app`;
    } else if (process.env.DYNO) {
        platformType = 'HEROKU_PAAS';
    } else if (process.env.PM2_HOME || process.env.name === 'enterprise-inventory-sync') {
        platformType = 'PM2_MANAGED_HOST';
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
    let memorySource = 'OS_PHYSICAL_RAM';

    // Probe cgroup v2
    try {
        if (fs.existsSync('/sys/fs/cgroup/memory.max')) {
            const raw = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
            if (raw !== 'max') {
                const limit = parseInt(raw, 10);
                if (!isNaN(limit) && limit > 0 && limit < 100 * 1024 * 1024 * 1024 * 1024) {
                    effectiveBytes = limit;
                    memorySource = 'LINUX_CGROUP_V2';
                }
            }
        }
    } catch (_) {}

    // Probe cgroup v1 fallback
    if (memorySource === 'OS_PHYSICAL_RAM') {
        try {
            if (fs.existsSync('/sys/fs/cgroup/memory/memory.limit_in_bytes')) {
                const raw = fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim();
                const limit = parseInt(raw, 10);
                if (!isNaN(limit) && limit > 0 && limit < 100 * 1024 * 1024 * 1024 * 1024) {
                    effectiveBytes = limit;
                    memorySource = 'LINUX_CGROUP_V1';
                }
            }
        } catch (_) {}
    }

    const memoryMB = Math.max(64, Math.round(effectiveBytes / (1024 * 1024)));
    return { memoryMB, memorySource };
}

/**
 * 4. Autonomous Resource Sizing & Limit Derivation
 * Computes optimal heap watermark and connection quotas based on hardware context.
 */
function deriveResourceLimits(memoryMB, cpuCores) {
    let maxHeapMB;
    let maxStreams;
    let cacheEntries;

    if (memoryMB <= 192) {
        // Ultra-micro environment (128MB VPS / small container)
        maxHeapMB = 96;
        maxStreams = 64;
        cacheEntries = 200;
    } else if (memoryMB <= 384) {
        // Standard lightweight container (256MB Docker spec)
        // Reserves ~70MB for cloudflared + ~58MB for off-heap buffers and OS
        maxHeapMB = 128;
        maxStreams = 128;
        cacheEntries = 500;
    } else if (memoryMB <= 768) {
        // Medium container / 512MB VPS
        maxHeapMB = 256;
        maxStreams = 256;
        cacheEntries = 1000;
    } else if (memoryMB <= 1536) {
        // 1GB container / 1GB VPS
        maxHeapMB = 512;
        maxStreams = 512;
        cacheEntries = 2000;
    } else {
        // Large instance (>= 2GB)
        maxHeapMB = Math.min(2048, Math.floor(memoryMB * 0.45));
        maxStreams = Math.min(2048, Math.floor(memoryMB * 0.75));
        cacheEntries = 3000;
    }

    // Auto-tune libuv asynchronous threadpool size
    const threadPoolSize = Math.max(16, Math.min(128, cpuCores * 16));
    try {
        process.env.UV_THREADPOOL_SIZE = String(threadPoolSize);
    } catch (_) {}

    return { maxHeapMB, maxStreams, cacheEntries, threadPoolSize };
}

/**
 * 5. Autonomous Network Binding & Public Host Derivation
 */
function deriveNetworkSettings(context) {
    // HOST is strictly 0.0.0.0 for robust ingress across containers, VPS, and PaaS
    const host = '0.0.0.0';

    // PORT: Check for platform dynamic port injection (e.g., Render, Heroku, Railway, Fly, Koyeb)
    let port = 3000;
    const dynamicPortEnv = process.env.PORT || process.env.SERVER_PORT || process.env.HTTP_PORT;
    if (dynamicPortEnv) {
        const parsed = parseInt(dynamicPortEnv, 10);
        if (!isNaN(parsed) && parsed > 0 && parsed <= 65535) {
            port = parsed;
        }
    }

    // PUBLIC_HOST: If detected from PaaS provider, use it; otherwise fallback to empty string
    // to allow dynamic incoming Host header adaptation in HTTP/WebSocket requests.
    const publicHost = (context.detectedDomain || '').trim();

    return { host, port, publicHost };
}

/**
 * 6. Service Identity (UUID) Token Normalizer & Fault-Tolerant Fallback
 */
function resolveServiceToken() {
    const rawInput = (process.env.UUID || process.env.SERVICE_TOKEN || '').trim();
    let isFallback = false;
    let canonicalUuid = DETERMINISTIC_FALLBACK_UUID;
    let hexKey = '';

    if (rawInput) {
        const stripped = rawInput.replace(/-/g, '');
        if (stripped.length === 32 && /^[0-9a-fA-F]{32}$/.test(stripped)) {
            hexKey = stripped.toLowerCase();
            // Format canonical 8-4-4-4-12 UUID string
            canonicalUuid = `${hexKey.substring(0, 8)}-${hexKey.substring(8, 12)}-${hexKey.substring(12, 16)}-${hexKey.substring(16, 20)}-${hexKey.substring(20, 32)}`;
        } else {
            isFallback = true;
            hexKey = DETERMINISTIC_FALLBACK_UUID.replace(/-/g, '');
        }
    } else {
        isFallback = true;
        hexKey = DETERMINISTIC_FALLBACK_UUID.replace(/-/g, '');
    }

    return {
        uuid: canonicalUuid,
        tokenBytes: Buffer.from(hexKey, 'hex'),
        isFallback
    };
}

/**
 * 7. Edge Gateway (Cloudflare Tunnel) Token Normalizer
 */
function resolveEdgeGatewayToken() {
    const raw = (process.env.TOKEN || process.env.EDGE_GATEWAY_TOKEN || '').trim();
    return raw;
}

/**
 * 8. Profile Tag & Stream Path Auto-Derivation
 */
function deriveDisguiseProfile(context) {
    // Unified enterprise live stream telemetry endpoint
    const streamPath = '/api/v2/inventory/live-stream';

    // Profile tag automatically incorporates platform context and host slug
    const hostSlug = (context.hostname || 'node').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
    const profileTag = `ERP-Sync-${context.platformType.replace(/_PAAS|_CONTAINER|_HOST|_CLUSTER/g, '')}-${hostSlug}`;

    return { streamPath, profileTag };
}

// --------------------------------------------------------------------
// Execute Autonomous Context Inference
// --------------------------------------------------------------------
const context = detectDeploymentContext();
const { memoryMB, memorySource } = detectEffectiveMemoryMB();
const cpuCores = (os.cpus() && os.cpus().length) || 1;
const resources = deriveResourceLimits(memoryMB, cpuCores);
const network = deriveNetworkSettings(context);
const identity = resolveServiceToken();
const edgeToken = resolveEdgeGatewayToken();
const disguise = deriveDisguiseProfile(context);

// Diagnostic audit metadata
const AUDIT_INFO = Object.freeze({
    platform: context.platformType,
    architecture: `${context.osType}/${context.arch}`,
    detectedMemoryMB: memoryMB,
    memorySource,
    cpuCores,
    threadPoolSize: resources.threadPoolSize,
    derivedHeapLimitMB: resources.maxHeapMB,
    derivedMaxStreams: resources.maxStreams,
    port: network.port,
    host: network.host,
    publicHost: network.publicHost || '(dynamic-request-header)',
    streamPath: disguise.streamPath,
    profileTag: disguise.profileTag,
    tokenMode: edgeToken ? 'CLOUDFLARE_TUNNEL_ACTIVE' : 'STANDALONE_PORT_ACTIVE',
    uuidStatus: identity.isFallback ? 'DETERMINISTIC_FALLBACK_ACTIVE' : 'EXPLICIT_AUTHENTICATED',
    ignoredManualOverrides: ignoredOverridesDetected
});

// Final frozen configuration object
const config = Object.freeze({
    // Service metadata
    SERVICE_NAME: 'enterprise-inventory-sync',
    VERSION: '2.4.0',
    ENVIRONMENT: process.env.NODE_ENV || 'production',

    // Core Required Credentials (Only UUID & TOKEN permitted)
    SERVICE_TOKEN: identity.uuid,
    SERVICE_TOKEN_BYTES: identity.tokenBytes,
    TOKEN: edgeToken,

    // Autonomously derived network endpoints
    HOST: network.host,
    PORT: network.port,
    PUBLIC_HOST: network.publicHost,

    // Autonomously derived enterprise paths & identity
    STREAM_PATH: disguise.streamPath,
    PROFILE_TAG: disguise.profileTag,
    PORTAL_ORIGIN: '',

    // Autonomously derived resource limits & quotas
    MAX_HEAP_MB: resources.maxHeapMB,
    MAX_ACTIVE_STREAMS: resources.maxStreams,
    CACHE_MAX_ENTRIES: resources.cacheEntries,

    // Fixed enterprise protocol performance constants
    MAX_BUFFER_SIZE: 1024 * 1024,       // 1MB — backpressure high watermark
    CACHE_TTL_MS: 5 * 60 * 1000,        // 5 min — analytics cache TTL
    REQUEST_TIMEOUT_MS: 8000,            // 8s — external analytics request timeout
    DATAGRAM_BUFFER_LIMIT: 65536,        // 64KB — datagram assembly buffer

    // Observability & diagnostics
    AUDIT_INFO,

    /**
     * Prints a comprehensive audit of the autonomous context inference engine
     * @param {Object} logger - Structured logger instance
     */
    printAuditSummary(logger) {
        if (!logger) return;

        logger.info('ConfigEngine', 'Autonomous Context Inference & Resource Adaptation Complete', {
            platform: AUDIT_INFO.platform,
            runtime: AUDIT_INFO.architecture,
            effectiveMemoryMB: `${AUDIT_INFO.detectedMemoryMB}MB (${AUDIT_INFO.memorySource})`,
            circuitBreakerHeapQuota: `${AUDIT_INFO.derivedHeapLimitMB}MB`,
            maxActiveStreams: AUDIT_INFO.derivedMaxStreams,
            ioThreadPool: AUDIT_INFO.threadPoolSize,
            networkBinding: `${AUDIT_INFO.host}:${AUDIT_INFO.port}`,
            endpoint: AUDIT_INFO.streamPath,
            profileTag: AUDIT_INFO.profileTag,
            uplinkMode: AUDIT_INFO.tokenMode,
            uuidStatus: AUDIT_INFO.uuidStatus
        });

        if (identity.isFallback) {
            logger.warn('ConfigEngine', 'Notice: No valid UUID provided in environment. Initialized with deterministic fail-safe token for uninterrupted service.');
        }

        if (ignoredOverridesDetected.length > 0) {
            logger.info('ConfigEngine', `Autonomous management active: manual overrides bypassed [${ignoredOverridesDetected.join(', ')}]`);
        }
    }
});

module.exports = config;
