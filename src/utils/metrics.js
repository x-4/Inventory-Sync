// ====================================================================
// Service Metrics & Observability Collector
// Aggregates operational counters for health probes and dashboards
// ====================================================================

const startTime = Date.now();

const metrics = {
    totalRequests: 0,
    totalStreams: 0,
    activeStreams: 0,
    rejectedConnections: 0,
    bytesTransferred: 0,
    datagramQueries: 0,
    cacheHits: 0
};

// Per-Tenant Traffic Tracking: uuid -> { totalStreams, activeStreams, bytesTransferred }
const tenantMetrics = new Map();

const collector = {
    incrementRequests() { metrics.totalRequests++; },
    incrementStreams() { metrics.totalStreams++; metrics.activeStreams++; },
    decrementStreams() { if (metrics.activeStreams > 0) metrics.activeStreams--; },
    incrementRejections() { metrics.rejectedConnections++; },
    addBytes(count) { metrics.bytesTransferred += count; },
    incrementDatagrams() { metrics.datagramQueries++; },
    incrementCacheHits() { metrics.cacheHits++; },

    /**
     * Records a stream session for a specific tenant/UUID
     * @param {string} tenantUuid
     */
    recordTenantStream(tenantUuid) {
        if (!tenantUuid) return;
        let t = tenantMetrics.get(tenantUuid);
        if (!t) {
            t = { totalStreams: 0, activeStreams: 0, bytesTransferred: 0 };
            tenantMetrics.set(tenantUuid, t);
        }
        t.totalStreams++;
        t.activeStreams++;
    },

    /**
     * Decrements active stream session for a specific tenant/UUID
     * @param {string} tenantUuid
     */
    decrementTenantStream(tenantUuid) {
        if (!tenantUuid) return;
        const t = tenantMetrics.get(tenantUuid);
        if (t && t.activeStreams > 0) {
            t.activeStreams--;
        }
    },

    /**
     * Records byte throughput for a specific tenant/UUID
     * @param {string} tenantUuid
     * @param {number} count
     */
    recordTenantBytes(tenantUuid, count) {
        if (!tenantUuid || !count) return;
        let t = tenantMetrics.get(tenantUuid);
        if (!t) {
            t = { totalStreams: 0, activeStreams: 0, bytesTransferred: 0 };
            tenantMetrics.set(tenantUuid, t);
        }
        t.bytesTransferred += count;
    },

    getTenantSnapshot() {
        const out = {};
        for (const [uuid, stat] of tenantMetrics.entries()) {
            out[uuid] = { ...stat };
        }
        return out;
    },

    getSnapshot() {
        const mem = process.memoryUsage();
        return {
            uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
            requests: {
                total: metrics.totalRequests,
                totalStreams: metrics.totalStreams,
                activeStreams: metrics.activeStreams,
                rejected: metrics.rejectedConnections
            },
            throughput: {
                bytesTransferred: metrics.bytesTransferred,
                datagramQueries: metrics.datagramQueries,
                cacheHits: metrics.cacheHits
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
            '# HELP erp_sync_uptime_seconds Process uptime in seconds',
            '# TYPE erp_sync_uptime_seconds gauge',
            `erp_sync_uptime_seconds ${snapshot.uptimeSeconds}`,
            '',
            '# HELP erp_sync_active_streams Current number of active concurrent stream connections',
            '# TYPE erp_sync_active_streams gauge',
            `erp_sync_active_streams ${snapshot.requests.activeStreams}`,
            '',
            '# HELP erp_sync_streams_total Total stream sessions accepted since startup',
            '# TYPE erp_sync_streams_total counter',
            `erp_sync_streams_total ${snapshot.requests.totalStreams}`,
            '',
            '# HELP erp_sync_requests_total Total HTTP requests handled',
            '# TYPE erp_sync_requests_total counter',
            `erp_sync_requests_total ${snapshot.requests.total}`,
            '',
            '# HELP erp_sync_circuit_breaker_rejections_total Total requests or upgrades rejected by circuit breakers/probe shield',
            '# TYPE erp_sync_circuit_breaker_rejections_total counter',
            `erp_sync_circuit_breaker_rejections_total ${snapshot.requests.rejected}`,
            '',
            '# HELP erp_sync_bytes_transferred_total Total network payload bytes transferred',
            '# TYPE erp_sync_bytes_transferred_total counter',
            `erp_sync_bytes_transferred_total ${snapshot.throughput.bytesTransferred}`,
            '',
            '# HELP erp_sync_datagram_queries_total Total datagram queries processed',
            '# TYPE erp_sync_datagram_queries_total counter',
            `erp_sync_datagram_queries_total ${snapshot.throughput.datagramQueries}`,
            '',
            '# HELP erp_sync_dns_cache_hits_total Total datagram and telemetry cache hits',
            '# TYPE erp_sync_dns_cache_hits_total counter',
            `erp_sync_dns_cache_hits_total ${snapshot.throughput.cacheHits}`,
            '',
            '# HELP erp_sync_memory_rss_bytes Resident Set Size memory allocation in bytes',
            '# TYPE erp_sync_memory_rss_bytes gauge',
            `erp_sync_memory_rss_bytes ${snapshot.memory.rssBytes}`,
            '',
            '# HELP erp_sync_memory_heap_used_bytes V8 heap bytes in active use',
            '# TYPE erp_sync_memory_heap_used_bytes gauge',
            `erp_sync_memory_heap_used_bytes ${snapshot.memory.heapUsedBytes}`
        ];

        // Append tenant-level dimensions
        for (const [uuid, stat] of tenantMetrics.entries()) {
            lines.push(
                `erp_sync_tenant_bytes_transferred_total{tenant="${uuid}"} ${stat.bytesTransferred}`,
                `erp_sync_tenant_active_streams{tenant="${uuid}"} ${stat.activeStreams}`,
                `erp_sync_tenant_streams_total{tenant="${uuid}"} ${stat.totalStreams}`
            );
        }

        return lines.join('\n') + '\n';
    }
};

module.exports = collector;

