// ====================================================================
// Adaptive Rate Limiter & Connection Shield
// Defends against scanning, brute-force, and slow connection attacks.
// Implements sliding-window failure tracking and temporary IP blocking.
// ====================================================================

const logger = require('../utils/logger');
const metrics = require('../utils/metrics');

class RateLimiter {
    constructor() {
        this._failures = new Map(); // ip -> { count, windowStart }
        this._blocklist = new Map(); // ip -> unblockTimestamp
        this._windowMs = 60 * 1000; // 60s observation window
        this._maxFailures = 5; // Max 5 failures per window
        this._blockDurationMs = 10 * 60 * 1000; // 10 minute block
        this._cleanupInterval = setInterval(() => this._purgeExpired(), 60 * 1000);
        this._cleanupInterval.unref();
    }

    /**
     * Checks whether an IP is currently blocked
     * @param {string} ip
     * @returns {boolean}
     */
    isBlocked(ip) {
        if (!ip) return false;
        const unblockTime = this._blocklist.get(ip);
        if (!unblockTime) return false;

        if (Date.now() >= unblockTime) {
            this._blocklist.delete(ip);
            return false;
        }
        return true;
    }

    /**
     * Records a failed handshake or invalid credential attempt.
     * Automatically blocks the IP if threshold is breached within the time window.
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
            this._blocklist.set(ip, now + this._blockDurationMs);
            metrics.incrementRejections();
            logger.warn('RateLimit', `IP ${ip} blocked for 10m due to repeated invalid attempts (${record.count} failures in 60s).`);
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
        for (const [ip, unblockTime] of this._blocklist.entries()) {
            if (now >= unblockTime) this._blocklist.delete(ip);
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
            blockedIpsCount: this._blocklist.size,
            trackedIps: this._failures.size
        };
    }

    /**
     * Resets all internal tracking states (useful for tests and maintenance)
     */
    reset() {
        this._failures.clear();
        this._blocklist.clear();
    }
}


const rateLimiter = new RateLimiter();
rateLimiter.RateLimiter = RateLimiter;

module.exports = rateLimiter;
