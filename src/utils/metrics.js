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

const collector = {
    incrementRequests() { metrics.totalRequests++; },
    incrementStreams() { metrics.totalStreams++; metrics.activeStreams++; },
    decrementStreams() { if (metrics.activeStreams > 0) metrics.activeStreams--; },
    incrementRejections() { metrics.rejectedConnections++; },
    addBytes(count) { metrics.bytesTransferred += count; },
    incrementDatagrams() { metrics.datagramQueries++; },
    incrementCacheHits() { metrics.cacheHits++; },

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
            }
        };
    }
};

module.exports = collector;
