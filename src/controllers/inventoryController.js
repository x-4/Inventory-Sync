// ====================================================================
// Enterprise Inventory & Logistics Facade Controller
// Exposes high-fidelity mock ERP REST endpoints for audits and dashboard telemetry
// ====================================================================

const config = require('../config');
const metrics = require('../utils/metrics');

const WAREHOUSE_NODES = [
    { id: 'WH-US-EAST', name: 'North America Distribution Hub', location: 'Virginia, USA', status: 'ACTIVE', latencyMs: 14, capacityUsed: '78.4%' },
    { id: 'WH-EU-CENTRAL', name: 'European Logistics Centre', location: 'Frankfurt, Germany', status: 'ACTIVE', latencyMs: 22, capacityUsed: '64.1%' },
    { id: 'WH-AP-EAST', name: 'East Asia Consolidated Depot', location: 'Tokyo, Japan', status: 'ACTIVE', latencyMs: 31, capacityUsed: '82.9%' },
    { id: 'WH-AP-SOUTH', name: 'Southeast Asia Transit Terminal', location: 'Singapore', status: 'ACTIVE', latencyMs: 45, capacityUsed: '56.3%' },
    { id: 'WH-US-WEST', name: 'Pacific Coast Fulfillment Facility', location: 'Oregon, USA', status: 'ACTIVE', latencyMs: 18, capacityUsed: '71.2%' }
];

const RECENT_OPERATIONS = [
    'Stock Ledger Partition Sync',
    'SKU Quantity Delta Reconciliation',
    'Pallet RFID Bin Audit Verification',
    'Cross-dock Shipment Dispatchping',
    'Inventory Checksum Integrity Probe'
];

/**
 * Returns dynamic warehouse nodes metadata
 */
function handleWarehouses(req, res) {
    const data = {
        totalHubs: WAREHOUSE_NODES.length,
        meshStatus: 'HEALTHY',
        consensusProtocol: 'Raft-Delta-v2',
        nodes: WAREHOUSE_NODES.map(node => ({
            ...node,
            activeSyncWorkers: Math.floor(Math.random() * 8) + 12,
            lastHeartbeat: new Date().toISOString()
        }))
    };

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data, null, 2));
}

/**
 * Returns simulated recent inventory delta transactions
 */
function handleTransactions(req, res) {
    const now = Date.now();
    const transactions = [];

    for (let i = 0; i < 8; i++) {
        const hub = WAREHOUSE_NODES[i % WAREHOUSE_NODES.length];
        const op = RECENT_OPERATIONS[i % RECENT_OPERATIONS.length];
        const batchNum = 2841900 + (now % 1000) - (i * 7);

        transactions.push({
            batchId: `BATCH-${batchNum}`,
            originHub: hub.id,
            operation: op,
            payloadSizeKB: Math.floor(Math.random() * 600) + 120,
            status: 'COMMITTED',
            timestamp: new Date(now - (i * 14000)).toISOString()
        });
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ transactions }, null, 2));
}

/**
 * Returns live system telemetry linked directly to server metrics
 */
function handleTelemetry(req, res) {
    const mem = process.memoryUsage();
    const snapshot = metrics.getSnapshot();

    const data = {
        service: config.SERVICE_NAME,
        version: config.VERSION,
        uptimeSeconds: Math.floor(process.uptime()),
        meshUptimeSLA: '99.998%',
        metrics: {
            totalBatches: 2841920 + snapshot.requests.total,
            activeStreams: snapshot.requests.activeStreams,
            maxStreamsQuota: config.MAX_ACTIVE_STREAMS,
            avgLatencyMs: Math.floor(Math.random() * 6) + 14,
            heapUsedMB: (mem.heapUsed / 1024 / 1024).toFixed(2),
            rssMB: (mem.rss / 1024 / 1024).toFixed(2),
            heapThresholdMB: config.MAX_HEAP_MB,
            bytesTransferred: snapshot.throughput.bytesTransferred
        },
        clusterState: 'SYNCHRONIZED',
        timestamp: new Date().toISOString()
    };

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data, null, 2));
}

module.exports = {
    handleWarehouses,
    handleTransactions,
    handleTelemetry
};
