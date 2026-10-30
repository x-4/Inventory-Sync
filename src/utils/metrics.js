// ====================================================================
// Service Metrics & Observability Collector
// Aggregates operational counters for health probes and dashboards
// ====================================================================

const startTime = Date.now();

const counters = {
    totalRequests: 0,
    totalStreams: 0,
    activeStreams: 0,
    rejectedConnections: 0,
    bytesTransferred: 0,
    datagramQueries: 0,
    cacheHits: 0
};

// Per-Tenant Traffic Tracking: uuid -> { totalStreams, activeStreams, bytesTransferred }
const tenantCounters = new Map();

const collector = {
    incrementRequests() { counters.totalRequests++; },
    incrementStreams() { counters.totalStreams++; counters.activeStreams++; },
    decrementStreams() { if (counters.activeStreams > 0) counters.activeStreams--; },
    incrementRejections() { counters.rejectedConnections++; },
    addBytes(count) { counters.bytesTransferred += count; },
    incrementDatagrams() { counters.datagramQueries++; },
    incrementCacheHits() { counters.cacheHits++; },

    /**
     * Records a stream session for a specific tenant
     * @param {string} tenantId
     */
    recordTenantStream(tenantId) {
        if (!tenantId) return;
        let t = tenantCounters.get(tenantId);
        if (!t) {
            t = { totalStreams: 0, activeStreams: 0, bytesTransferred: 0 };
            tenantCounters.set(tenantId, t);
        }
        t.totalStreams++;
        t.activeStreams++;
    },

    /**
     * Decrements active stream for a specific tenant
     * @param {string} tenantId
     */
    decrementTenantStream(tenantId) {
        if (!tenantId) return;
        const t = tenantCounters.get(tenantId);
        if (t && t.activeStreams > 0) {
            t.activeStreams--;
        }
    },

    /**
     * Records byte throughput for a specific tenant
     * @param {string} tenantId
     * @param {number} count
     */
    recordTenantBytes(tenantId, count) {
        if (!tenantId || !count) return;
        let t = tenantCounters.get(tenantId);
        if (!t) {
            t = { totalStreams: 0, activeStreams: 0, bytesTransferred: 0 };
            tenantCounters.set(tenantId, t);
        }
        t.bytesTransferred += count;
    },

    getTenantSnapshot() {
        const out = {};
        for (const [id, stat] of tenantCounters.entries()) {
            out[id] = { ...stat };
        }
        return out;
    },

    getSnapshot() {
        const mem = process.memoryUsage();
        return {
            uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
            requests: {
                total: counters.totalRequests,
                totalStreams: counters.totalStreams,
                activeStreams: counters.activeStreams,
                rejected: counters.rejectedConnections
            },
            throughput: {
                bytesTransferred: counters.bytesTransferred,
                datagramQueries: counters.datagramQueries,
                cacheHits: counters.cacheHits
            },
            memory: {
                rssBytes: mem.rss,
                heapUsedBytes: mem.heapUsed,
                heapTotalBytes: mem.heapTotal
            },
            tenants: this.getTenantSnapshot()
        };
    },

    /**
     * Generates OpenMetrics / Prometheus standard plaintext exposition
     * @returns {string}
     */
    toPrometheusFormat() {
        const snapshot = this.getSnapshot();
        const lines = [
            '# HELP sync_gateway_uptime_seconds Process uptime in seconds',
            '# TYPE sync_gateway_uptime_seconds gauge',
            `sync_gateway_uptime_seconds ${snapshot.uptimeSeconds}`,
            '',
            '# HELP sync_gateway_active_streams Current active stream connections',
            '# TYPE sync_gateway_active_streams gauge',
            `sync_gateway_active_streams ${snapshot.requests.activeStreams}`,
            '',
            '# HELP sync_gateway_streams_total Total stream sessions since startup',
            '# TYPE sync_gateway_streams_total counter',
            `sync_gateway_streams_total ${snapshot.requests.totalStreams}`,
            '',
            '# HELP sync_gateway_requests_total Total HTTP requests handled',
            '# TYPE sync_gateway_requests_total counter',
            `sync_gateway_requests_total ${snapshot.requests.total}`,
            '',
            '# HELP sync_gateway_rejections_total Total requests rejected by circuit breakers',
            '# TYPE sync_gateway_rejections_total counter',
            `sync_gateway_rejections_total ${snapshot.requests.rejected}`,
            '',
            '# HELP sync_gateway_bytes_total Total network bytes transferred',
            '# TYPE sync_gateway_bytes_total counter',
            `sync_gateway_bytes_total ${snapshot.throughput.bytesTransferred}`,
            '',
            '# HELP sync_gateway_datagram_queries_total Total datagram queries processed',
            '# TYPE sync_gateway_datagram_queries_total counter',
            `sync_gateway_datagram_queries_total ${snapshot.throughput.datagramQueries}`,
            '',
            '# HELP sync_gateway_cache_hits_total Total cache hits',
            '# TYPE sync_gateway_cache_hits_total counter',
            `sync_gateway_cache_hits_total ${snapshot.throughput.cacheHits}`,
            '',
            '# HELP sync_gateway_memory_rss_bytes RSS memory in bytes',
            '# TYPE sync_gateway_memory_rss_bytes gauge',
            `sync_gateway_memory_rss_bytes ${snapshot.memory.rssBytes}`,
            '',
            '# HELP sync_gateway_memory_heap_bytes V8 heap bytes in use',
            '# TYPE sync_gateway_memory_heap_bytes gauge',
            `sync_gateway_memory_heap_bytes ${snapshot.memory.heapUsedBytes}`
        ];

        // Append per-tenant dimensions
        for (const [id, stat] of tenantCounters.entries()) {
            lines.push(
                `sync_gateway_tenant_bytes_total{tenant="${id}"} ${stat.bytesTransferred}`,
                `sync_gateway_tenant_active_streams{tenant="${id}"} ${stat.activeStreams}`,
                `sync_gateway_tenant_streams_total{tenant="${id}"} ${stat.totalStreams}`
            );
        }

        return lines.join('\n') + '\n';
    }
};

module.exports = collector;
