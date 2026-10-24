// ====================================================================
// Binary Batch Decoder
// Deserializes incoming inventory batch synchronization payloads
// Supports reliable-stream (mode 1) and datagram (mode 2) transports
// ====================================================================

const crypto = require('crypto');
const config = require('../config');

class BatchDecoder {
    constructor() {
        this._keyRef = config.SERVICE_TOKEN_BYTES;
    }

    /**
     * Validates the authentication segment of a batch payload header
     * Uses constant-time comparison against configured enterprise service tokens.
     * In multi-tenant environments, verifies all active tokens securely.
     * @param {Buffer} buffer - Raw incoming data buffer
     * @returns {string|false} Matched canonical UUID string on success, false on failure
     */
    validateSignature(buffer) {
        if (!Buffer.isBuffer(buffer) || buffer.length < 17) return false;
        const candidate = buffer.subarray(1, 17);
        const tokenList = config.SERVICE_TOKEN_BYTES_LIST || [
            { uuid: config.SERVICE_TOKEN, tokenBytes: config.SERVICE_TOKEN_BYTES }
        ];

        let matched = false;
        let matchedUuid = null;

        for (const entry of tokenList) {
            try {
                if (crypto.timingSafeEqual(candidate, entry.tokenBytes)) {
                    matched = true;
                    matchedUuid = entry.uuid;
                }
            } catch (_) {}
        }

        return matched ? matchedUuid : false;
    }

    /**
     * Resolves a warehouse endpoint address from binary-encoded address data
     * @param {number} format - Address encoding: 1=IPv4, 3=Domain, 4=IPv6
     * @param {Buffer} data   - Raw address bytes
     * @returns {string|null}
     */
    resolveEndpoint(format, data) {
        if (format === 1) {
            if (data.length < 4) return null;
            return `${data[0]}.${data[1]}.${data[2]}.${data[3]}`;
        }
        if (format === 3) {
            return data.toString('utf8');
        }
        // IPv6
        if (data.length < 16) return null;
        const segments = [];
        for (let i = 0; i < 8; i++) {
            segments.push(((data[i * 2] << 8) | data[i * 2 + 1]).toString(16));
        }
        return segments.join(':');
    }

    /**
     * Decodes the full header of a binary batch data packet
     * Extracts transport mode, target warehouse address, port, and payload offset
     * @param {Buffer} buffer - Raw incoming batch data
     * @returns {object|null} Parsed header metadata, or null if invalid
     */
    decodeHeader(buffer) {
        if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
        const matchedUuid = this.validateSignature(buffer);
        if (!matchedUuid) return null;

        const paddingLen = buffer[17];
        const baseOffset = 18 + paddingLen;

        // Ensure buffer has enough bytes for: command(1) + port(2) + addrType(1)
        if (buffer.length < baseOffset + 4) return null;

        const transportMode = buffer[baseOffset];               // 1: Reliable, 2: Datagram
        const targetPort = (buffer[baseOffset + 1] << 8) | buffer[baseOffset + 2];

        let addressFormat = buffer[baseOffset + 3];
        if (addressFormat !== 1) addressFormat += 1;            // Normalize address encoding

        let addressLength = 0;
        let addressOffset = baseOffset + 4;

        switch (addressFormat) {
            case 1:  // IPv4 — 4 bytes
                addressLength = 4;
                break;
            case 3:  // Domain — length-prefixed string
                if (buffer.length < addressOffset + 1) return null;
                addressLength = buffer[addressOffset];
                addressOffset += 1;
                break;
            case 4:  // IPv6 — 16 bytes
                addressLength = 16;
                break;
            default:
                return null;
        }

        const payloadStart = addressOffset + addressLength;
        if (payloadStart > buffer.length) return null;

        const targetHost = this.resolveEndpoint(
            addressFormat,
            buffer.subarray(addressOffset, payloadStart)
        );
        if (!targetHost) return null;

        return {
            transportMode,
            addressFormat,
            targetPort,
            targetHost,
            payloadStart,
            serviceToken: matchedUuid
        };
    }

}

module.exports = BatchDecoder;
