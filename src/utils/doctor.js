// ====================================================================
// System & Deployment Doctor CLI
// Performs comprehensive diagnostics across hardware quotas,
// network bindings, compliance filters, and tunnel connectivity.
// ====================================================================

const os = require('os');
const net = require('net');
const dgram = require('dgram');
const config = require('../config');
const { validateEndpoint } = require('../services/complianceValidator');
const tunnelManager = require('../services/tunnelManager');

// ANSI Color formatting helpers for terminal output
const colors = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m'
};

const sym = {
    ok: `${colors.green}✔${colors.reset}`,
    warn: `${colors.yellow}⚠${colors.reset}`,
    err: `${colors.red}✖${colors.reset}`,
    bullet: `${colors.cyan}•${colors.reset}`
};

/**
 * Tests local port bindability
 */
function testPortAvailability(port, host = '0.0.0.0') {
    return new Promise((resolve) => {
        const testServer = net.createServer();
        testServer.once('error', (err) => {
            resolve({ available: false, error: err.code || err.message });
        });
        testServer.once('listening', () => {
            testServer.close(() => {
                resolve({ available: true });
            });
        });
        testServer.listen(port, host);
    });
}

/**
 * Tests native UDP 53 connectivity
 */
function testUdpConnectivity(host = '1.1.1.1', timeoutMs = 1500) {
    return new Promise((resolve) => {
        let socket;
        let finished = false;
        try {
            socket = dgram.createSocket('udp4');
        } catch (err) {
            return resolve({ reachable: false, reason: err.message });
        }

        const timer = setTimeout(() => {
            if (!finished) {
                finished = true;
                try { socket.close(); } catch (_) {}
                resolve({ reachable: false, reason: 'timeout' });
            }
        }, timeoutMs);

        // Standard minimal DNS query payload
        const query = Buffer.from([
            0xaa, 0xbb, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01
        ]);

        socket.on('message', () => {
            if (!finished) {
                finished = true;
                clearTimeout(timer);
                try { socket.close(); } catch (_) {}
                resolve({ reachable: true });
            }
        });

        socket.on('error', (err) => {
            if (!finished) {
                finished = true;
                clearTimeout(timer);
                try { socket.close(); } catch (_) {}
                resolve({ reachable: false, reason: err.code || err.message });
            }
        });

        socket.send(query, 53, host, (err) => {
            if (err && !finished) {
                finished = true;
                clearTimeout(timer);
                try { socket.close(); } catch (_) {}
                resolve({ reachable: false, reason: err.code || err.message });
            }
        });
    });
}

/**
 * Runs the comprehensive system doctor diagnostics suite
 */
async function runDoctorDiagnostics() {
    console.log(`\n${colors.bold}${colors.cyan}====================================================================${colors.reset}`);
    console.log(`${colors.bold}${colors.cyan} Inventory Sync Gateway — Deployment Diagnostics v${config.VERSION}${colors.reset}`);
    console.log(`${colors.bold}${colors.cyan}====================================================================${colors.reset}\n`);

    let totalIssues = 0;
    let totalWarnings = 0;

    // 1. Runtime & Virtualization Context
    console.log(`${colors.bold}[1/6] Runtime & Platform Context${colors.reset}`);
    console.log(`  ${sym.ok} Node.js: ${process.version} (V8 ${process.versions.v8})`);
    console.log(`  ${sym.ok} Platform: ${os.type()} ${os.release()} (${process.arch})`);
    console.log(`  ${sym.ok} Detected Platform: ${colors.bold}${config.AUDIT_INFO.platform}${colors.reset}`);
    console.log(`  ${sym.ok} Memory Source: ${config.AUDIT_INFO.memorySource} (${config.AUDIT_INFO.detectedMemoryMB}MB detected)`);

    // 2. Resource Sizing
    console.log(`\n${colors.bold}[2/6] Resource Quotas & Protection${colors.reset}`);
    console.log(`  ${sym.ok} Heap Threshold: ${config.MAX_HEAP_MB} MB`);
    console.log(`  ${sym.ok} RSS Threshold: ${config.MAX_RSS_MB} MB`);
    console.log(`  ${sym.ok} Max Concurrent Streams: ${config.MAX_ACTIVE_STREAMS}`);
    console.log(`  ${sym.ok} I/O Threadpool: ${config.AUDIT_INFO.threadPoolSize} threads`);
    console.log(`  ${sym.ok} Backpressure Watermark: ${(config.MAX_BUFFER_SIZE / 1024).toFixed(0)} KB`);

    // 3. Network Binding
    console.log(`\n${colors.bold}[3/6] Network Bindings${colors.reset}`);
    console.log(`  ${sym.ok} Listen Binding: ${config.HOST}:${config.PORT}`);
    const portCheck = await testPortAvailability(config.PORT, config.HOST);
    if (portCheck.available) {
        console.log(`  ${sym.ok} Port ${config.PORT}: Available`);
    } else {
        console.log(`  ${sym.warn} Port ${config.PORT}: In use (${portCheck.error}) — Normal if service is running`);
        totalWarnings++;
    }
    console.log(`  ${sym.ok} Stream Endpoint: ${config.STREAM_PATH}`);
    console.log(`  ${sym.ok} Profile Tag: ${config.PROFILE_TAG}`);

    // 4. Credentials
    console.log(`\n${colors.bold}[4/6] Service Credentials${colors.reset}`);
    if (config.AUDIT_INFO.credentialStatus === 'USER_PROVIDED') {
        console.log(`  ${sym.ok} Service Token: ${config.SERVICE_TOKEN.substring(0, 8)}... (User Provided)`);
    } else {
        console.log(`  ${sym.warn} Service Token: Using default fallback (${config.SERVICE_TOKEN.substring(0, 8)}...) — Provide custom UUID for production`);
        totalWarnings++;
    }

    // 5. Compliance Boundaries
    console.log(`\n${colors.bold}[5/6] Compliance & Security${colors.reset}`);
    const loopbackBlocked = !validateEndpoint('127.0.0.1', 80).allowed;
    const metaBlocked = !validateEndpoint('169.254.169.254', 80).allowed;
    const publicAllowed = validateEndpoint('1.1.1.1', 443).allowed;

    if (loopbackBlocked && metaBlocked && publicAllowed) {
        console.log(`  ${sym.ok} Loopback (127.0.0.1): Blocked (Pass)`);
        console.log(`  ${sym.ok} Cloud Metadata (169.254.169.254): Blocked (Pass)`);
        console.log(`  ${sym.ok} Public Egress: Permitted (Pass)`);
    } else {
        console.log(`  ${sym.err} Compliance Filter Integrity Check Failed!`);
        totalIssues++;
    }

    // 6. Connectivity
    console.log(`\n${colors.bold}[6/6] Connectivity & Tunnel${colors.reset}`);
    const udpTest = await testUdpConnectivity('1.1.1.1', 1200);
    if (udpTest.reachable) {
        console.log(`  ${sym.ok} UDP 53 Fast-Path: Reachable`);
    } else {
        console.log(`  ${sym.warn} UDP 53 Fast-Path: Blocked (${udpTest.reason}) — HTTPS fallback will handle queries`);
        totalWarnings++;
    }

    const platformInfo = tunnelManager.getPlatformInfo();
    if (platformInfo) {
        console.log(`  ${sym.ok} Tunnel Binary Platform: ${platformInfo.filename} supported`);
    }
    if (config.TOKEN) {
        console.log(`  ${sym.ok} Tunnel Mode: Configured (TOKEN active)`);
    } else {
        console.log(`  ${sym.ok} Tunnel Mode: Standalone (direct port)`);
    }

    // Summary
    console.log(`\n${colors.bold}${colors.cyan}--------------------------------------------------------------------${colors.reset}`);
    if (totalIssues === 0 && totalWarnings === 0) {
        console.log(`${colors.bold}${colors.green}  ✔ System Status: HEALTHY — Ready for production!${colors.reset}`);
    } else if (totalIssues === 0) {
        console.log(`${colors.bold}${colors.green}  ✔ System Status: OPERATIONAL — ${totalWarnings} advisory notice(s).${colors.reset}`);
    } else {
        console.log(`${colors.bold}${colors.red}  ✖ System Status: ${totalIssues} issue(s) detected. Review above.${colors.reset}`);
    }
    console.log(`${colors.bold}${colors.cyan}--------------------------------------------------------------------${colors.reset}\n`);

    return totalIssues === 0;
}

module.exports = {
    runDoctorDiagnostics
};
