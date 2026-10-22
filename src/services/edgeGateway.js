// ====================================================================
// Enterprise Edge Gateway & Uplink Supervisor
// Manages zero-maintenance Cloudflare Tunnel uplinks across both
// containerized (Docker) and serverless / PaaS (GalaxyCloud, Render, etc.) runtimes.
// ====================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { spawn, execSync } = require('child_process');

const config = require('../config');
const logger = require('../utils/logger');

class EdgeGatewaySupervisor {
    constructor() {
        this.child = null;
        this.running = false;
        this.status = config.TOKEN ? 'initializing' : 'disabled';
        this.restartTimer = null;
        this.restarts = 0;
        this.lastStartTime = null;
        this.binaryPath = null;
        this.isDownloading = false;
    }

    /**
     * Resolves the target binary architecture and download URL for the current host
     * @returns {{ os: string, arch: string, ext: string, filename: string, url: string } | null}
     */
    getPlatformInfo() {
        const platform = process.platform;
        const arch = process.arch;

        let targetOS = null;
        let cfArch = null;
        let ext = '';

        if (platform === 'linux') {
            targetOS = 'linux';
            if (arch === 'x64') cfArch = 'amd64';
            else if (arch === 'arm64') cfArch = 'arm64';
            else if (arch === 'arm') cfArch = 'arm';
            else if (arch === 'ia32') cfArch = '386';
        } else if (platform === 'darwin') {
            targetOS = 'darwin';
            if (arch === 'x64') cfArch = 'amd64';
            else if (arch === 'arm64') cfArch = 'arm64';
        } else if (platform === 'win32') {
            targetOS = 'windows';
            ext = '.exe';
            if (arch === 'x64') cfArch = 'amd64';
            else if (arch === 'ia32') cfArch = '386';
        }

        if (!targetOS || !cfArch) {
            return null;
        }

        const filename = `cloudflared-${targetOS}-${cfArch}${ext}`;
        const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${filename}`;

        return { os: targetOS, arch: cfArch, ext, filename, url };
    }

    /**
     * Finds an existing binary on the host system
     * @returns {string | null}
     */
    findExistingBinary() {
        // 1. Explicit environment variable override
        if (process.env.CLOUDFLARED_PATH && fs.existsSync(process.env.CLOUDFLARED_PATH)) {
            return process.env.CLOUDFLARED_PATH;
        }

        const ext = process.platform === 'win32' ? '.exe' : '';

        // 2. Common standard system directories
        const systemCandidates = [
            '/usr/local/bin/cloudflared',
            '/usr/bin/cloudflared',
            '/bin/cloudflared'
        ];
        for (const candidate of systemCandidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }

        // 3. Application project directory and temporary cache
        const localCandidates = [
            path.join(process.cwd(), 'bin', `cloudflared${ext}`),
            path.join(os.tmpdir(), 'edge-gateway', `cloudflared${ext}`),
            path.join(os.tmpdir(), `cloudflared${ext}`)
        ];
        for (const candidate of localCandidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }

        // 4. Search in PATH
        const pathEnv = process.env.PATH || '';
        const pathDirs = pathEnv.split(path.delimiter);
        for (const dir of pathDirs) {
            if (!dir) continue;
            const candidate = path.join(dir, `cloudflared${ext}`);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }

        return null;
    }

    /**
     * Determines the optimal writable directory for caching the binary
     * @returns {string}
     */
    resolveWritableDir() {
        const candidates = [
            path.join(process.cwd(), 'bin'),
            path.join(os.tmpdir(), 'edge-gateway'),
            os.tmpdir()
        ];

        for (const dir of candidates) {
            try {
                fs.mkdirSync(dir, { recursive: true });
                const probe = path.join(dir, `.write-probe-${Date.now()}`);
                fs.writeFileSync(probe, 'ok');
                fs.unlinkSync(probe);
                return dir;
            } catch (_) {
                // Directory not writable, fallback to next candidate
            }
        }

        return os.tmpdir();
    }

    /**
     * Streams binary download following HTTP redirects (supports GitHub Releases redirects)
     * @param {string} url
     * @param {string} destination
     * @returns {Promise<void>}
     */
    downloadBinary(url, destination) {
        return new Promise((resolve, reject) => {
            const tempFile = `${destination}.tmp-${Date.now()}`;
            const maxRedirects = 6;

            const request = (currentUrl, redirectCount = 0) => {
                if (redirectCount > maxRedirects) {
                    return reject(new Error('Exceeded maximum redirection limit during binary download'));
                }

                let parsedUrl;
                try {
                    parsedUrl = new URL(currentUrl);
                } catch (e) {
                    return reject(new Error(`Invalid download URL: ${currentUrl}`));
                }

                const client = parsedUrl.protocol === 'https:' ? https : http;
                const req = client.get(parsedUrl, {
                    headers: {
                        'User-Agent': 'Enterprise-Edge-Gateway/2.4 (Automated-Provisioner)',
                        'Accept': 'application/octet-stream, */*'
                    },
                    timeout: 60000
                }, (res) => {
                    // Follow redirects (301, 302, 303, 307, 308)
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        res.resume(); // Discard redirect body
                        const nextUrl = new URL(res.headers.location, currentUrl).href;
                        return request(nextUrl, redirectCount + 1);
                    }

                    if (res.statusCode !== 200) {
                        res.resume();
                        return reject(new Error(`Binary distribution endpoint returned HTTP ${res.statusCode}`));
                    }

                    const outStream = fs.createWriteStream(tempFile);
                    res.pipe(outStream);

                    outStream.on('finish', () => {
                        outStream.close(() => {
                            try {
                                const stats = fs.statSync(tempFile);
                                // Ensure downloaded payload is an actual binary (> 10MB), not an error page
                                if (stats.size < 5 * 1024 * 1024) {
                                    fs.unlinkSync(tempFile);
                                    return reject(new Error(`Downloaded binary payload suspiciously small (${stats.size} bytes)`));
                                }
                                try {
                                    fs.renameSync(tempFile, destination);
                                } catch (renameErr) {
                                    if (renameErr.code === 'EXDEV') {
                                        fs.copyFileSync(tempFile, destination);
                                        fs.unlinkSync(tempFile);
                                    } else {
                                        throw renameErr;
                                    }
                                }
                                fs.chmodSync(destination, 0o755);
                                resolve();
                            } catch (err) {
                                reject(err);
                            }
                        });
                    });

                    outStream.on('error', (err) => {
                        fs.unlink(tempFile, () => {});
                        reject(err);
                    });
                });

                req.on('timeout', () => {
                    req.destroy(new Error('Download connection timed out after 60s'));
                });

                req.on('error', (err) => {
                    fs.unlink(tempFile, () => {});
                    reject(err);
                });
            };

            request(url);
        });
    }

    /**
     * Checks if a cloudflared process is already externally running on the system
     * (e.g. managed by host supervisor or legacy entrypoint)
     * @returns {boolean}
     */
    isExternalTunnelActive() {
        if (process.platform === 'win32') return false;
        try {
            const output = execSync('pgrep -x cloudflared || true', { encoding: 'utf8', timeout: 1000 });
            return output.trim().length > 0;
        } catch (_) {
            return false;
        }
    }

    /**
     * Ensures the edge connector binary is available, downloading if required
     * @returns {Promise<string>} Absolute path to the executable binary
     */
    async ensureBinary() {
        const existing = this.findExistingBinary();
        if (existing) {
            this.binaryPath = existing;
            return existing;
        }

        const platformInfo = this.getPlatformInfo();
        if (!platformInfo) {
            throw new Error(`Unsupported operating system / CPU architecture (${process.platform}-${process.arch})`);
        }

        const targetDir = this.resolveWritableDir();
        const targetFile = path.join(targetDir, `cloudflared${platformInfo.ext}`);

        if (fs.existsSync(targetFile)) {
            this.binaryPath = targetFile;
            return targetFile;
        }

        this.isDownloading = true;
        this.status = 'provisioning_binary';
        logger.info('EdgeGateway', `Auto-provisioning edge connector binary for ${platformInfo.os}-${platformInfo.arch}...`, {
            target: targetFile,
            source: platformInfo.url
        });

        try {
            await this.downloadBinary(platformInfo.url, targetFile);
            this.binaryPath = targetFile;
            this.isDownloading = false;
            logger.info('EdgeGateway', `Edge connector binary successfully provisioned at ${targetFile}`);
            return targetFile;
        } catch (err) {
            this.isDownloading = false;
            throw err;
        }
    }

    /**
     * Spawns the edge connector subprocess and binds watchdog listeners
     * @param {string} binary
     */
    launchProcess(binary) {
        if (!this.running || this.child) return;

        logger.info('EdgeGateway', 'Activating edge connector instance (Protocol: HTTP/2, IPv4)...', {
            binary,
            tokenConfigured: true
        });

        const args = [
            'tunnel',
            '--no-autoupdate',
            '--protocol', 'http2',
            '--edge-ip-version', '4',
            'run',
            '--token', config.TOKEN
        ];

        try {
            this.child = spawn(binary, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: false
            });

            this.lastStartTime = Date.now();
            this.status = 'connected';

            // Filter and pipe meaningful logs to central logger
            this.child.stderr.on('data', (chunk) => {
                const text = chunk.toString('utf8');
                if (text.includes('Registered tunnel connection') || text.includes('Connection registered')) {
                    logger.info('EdgeGateway', 'Edge tunnel connection registered successfully with Cloudflare Edge.');
                } else if (text.includes('ERR') || text.includes('failed') || text.includes('error')) {
                    // Extract first significant line
                    const line = text.split('\n')[0].trim();
                    if (line) {
                        logger.warn('EdgeGateway', `Edge connector alert: ${line.substring(0, 160)}`);
                    }
                }
            });

            this.child.on('error', (err) => {
                logger.error('EdgeGateway', `Edge connector execution error: ${err.message}`);
            });

            this.child.on('exit', (code, signal) => {
                this.child = null;
                if (!this.running) {
                    this.status = 'stopped';
                    return;
                }

                this.restarts++;
                this.status = 'reconnecting';
                const uptimeMs = this.lastStartTime ? Date.now() - this.lastStartTime : 0;

                logger.warn('EdgeGateway', `Edge connector exited (code: ${code}, signal: ${signal}). Auto-restarting in 3s... (Restart #${this.restarts})`);

                // Backoff slightly if exiting in rapid loops (< 3s)
                const delay = uptimeMs < 3000 ? 5000 : 3000;
                this.restartTimer = setTimeout(() => {
                    this.launchProcess(binary);
                }, delay);
            });
        } catch (err) {
            logger.error('EdgeGateway', `Failed to spawn edge connector: ${err.message}`);
            this.status = 'error';
        }
    }

    /**
     * Initializes the edge gateway supervisor asynchronously
     * (Runs non-blocking in background so HTTP/WebSocket starts immediately)
     */
    async initialize() {
        if (!config.TOKEN) {
            this.status = 'standalone';
            logger.info('EdgeGateway', 'No edge uplink token specified. Operating in direct standalone mode.');
            return;
        }

        // Check if an external supervisor has already launched cloudflared
        if (this.isExternalTunnelActive()) {
            this.status = 'externally_managed';
            logger.info('EdgeGateway', 'Active edge tunnel process detected on host. Operating in passive monitoring mode.');
            return;
        }

        this.running = true;

        try {
            const binary = await this.ensureBinary();
            this.launchProcess(binary);
        } catch (err) {
            this.status = 'provision_failed';
            logger.error('EdgeGateway', `Edge connector provisioning failed: ${err.message}. Retrying in 30s...`);

            // Schedule background retry so application keeps running in standalone mode
            this.restartTimer = setTimeout(() => {
                if (this.running) {
                    this.initialize().catch(() => {});
                }
            }, 30000);
        }
    }

    /**
     * Gracefully stops the edge connector subprocess
     */
    stop() {
        this.running = false;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }

        if (this.child) {
            try {
                this.child.kill('SIGTERM');
            } catch (_) {}

            const proc = this.child;
            setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch (_) {}
            }, 3000).unref();

            this.child = null;
        }

        this.status = 'stopped';
    }

    /**
     * Synchronously terminates the child process during sudden process termination or crash
     */
    stopSync() {
        this.running = false;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        if (this.child) {
            try {
                this.child.kill('SIGKILL');
            } catch (_) {}
            this.child = null;
        }
    }

    /**
     * Returns structured status of the edge gateway
     * @returns {object}
     */
    getStatus() {
        const isOperational = !config.TOKEN || ['connected', 'externally_managed', 'initializing', 'provisioning_binary', 'standalone'].includes(this.status);
        return {
            status: isOperational ? 'UP' : 'DEGRADED',
            mode: config.TOKEN ? (this.status === 'externally_managed' ? 'EXTERNAL_SUPERVISOR' : 'EMBEDDED_SUPERVISOR') : 'DIRECT_PORT',
            configured: Boolean(config.TOKEN),
            tunnelState: this.status,
            restarts: this.restarts,
            pid: this.child ? this.child.pid : null,
            binaryPath: this.binaryPath || 'unresolved'
        };
    }
}

const edgeGateway = new EdgeGatewaySupervisor();

module.exports = edgeGateway;
