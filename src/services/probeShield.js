// ====================================================================
// Adaptive Anti-Probing & Malicious Scan Shield
// Defends against active scanning, brute-force probes, and Slowloris attacks.
// Implements sliding-window failure rate tracking and temporary IP quarantine.
// ====================================================================

const logger = require('../utils/logger');
const metrics = require('../utils/metrics');

class ProbeShield {
    constructor() {
        this._failures = new Map(); // ip -> { count, windowStart }
        this._quarantine = new Map(); // ip -> unblockTimestamp
        this._windowMs = 60 * 1000; // 60s observation window
        this._maxFailures = 5; // Max 5 signature/handshake failures per window
        this._quarantineDurationMs = 10 * 60 * 1000; // 10 minute quarantine
        this._cleanupInterval = setInterval(() => this._purgeExpired(), 60 * 1000);
        this._cleanupInterval.unref();
    }

    /**
     * Checks whether an IP is currently quarantined
     * @param {string} ip
     * @returns {boolean}
     */
    isBlocked(ip) {
        if (!ip) return false;
        const unblockTime = this._quarantine.get(ip);
        if (!unblockTime) return false;

        if (Date.now() >= unblockTime) {
            this._quarantine.delete(ip);
            return false;
        }
        return true;
    }

    /**
     * Records a failed handshake, invalid token, or protocol signature violation
     * Automatically quarantines IP if threshold is breached within the time window
     * @param {string} ip
     */
    recordFailure(ip) {
        if (!ip || ip === '127.0.0.1' || ip === '::1') return;
        const now = Date.now();
        let record = this._failures.get(ip);

        if (!record || now - record.windowStart > this._windowMs) {
            record = { count: 1, windowStart: now };
            this._failures.set(ip, record);
            return;
        }

        record.count++;
        if (record.count >= this._maxFailures) {
            this._failures.delete(ip);
            this._quarantine.set(ip, now + this._quarantineDurationMs);
            metrics.incrementRejections();
            logger.warn('ProbeShield', `Quarantine active: IP ${ip} isolated for 10m due to repeated invalid/probing handshakes (${record.count} failures in 60s).`);
        }
    }

    /**
     * Clears failure count for an IP upon successful authentication
     * @param {string} ip
     */
    recordSuccess(ip) {
        if (ip) {
            this._failures.delete(ip);
        }
    }

    /**
     * Periodically purges expired entries to keep memory footprint bounded
     */
    _purgeExpired() {
        const now = Date.now();
        for (const [ip, unblockTime] of this._quarantine.entries()) {
            if (now >= unblockTime) this._quarantine.delete(ip);
        }
        for (const [ip, record] of this._failures.entries()) {
            if (now - record.windowStart > this._windowMs * 2) this._failures.delete(ip);
        }
    }

    /**
     * Returns diagnostics status
     */
    getStats() {
        return {
            quarantinedIpsCount: this._quarantine.size,
            activeTrackedIps: this._failures.size
        };
    }

    /**
     * Resets all internal tracking and quarantine states (useful for tests and maintenance)
     */
    reset() {
        this._failures.clear();
        this._quarantine.clear();
    }
}


const probeShield = new ProbeShield();
probeShield.ProbeShield = ProbeShield;

module.exports = probeShield;

