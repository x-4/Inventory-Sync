// ====================================================================
// Enterprise Structured Logger
// Formats service logs with timestamps, modules, and severity levels
// ====================================================================

const LOG_LEVELS = {
    DEBUG: 10,
    INFO: 20,
    WARN: 30,
    ERROR: 40,
    AUDIT: 50
};

function getLogLevel() {
    const envLevel = (process.env.LOG_LEVEL || '').toUpperCase();
    if (envLevel in LOG_LEVELS) {
        return LOG_LEVELS[envLevel];
    }
    return LOG_LEVELS.INFO;
}

function formatMessage(level, moduleName, message, extra = null) {
    const timestamp = new Date().toISOString();
    const payload = {
        ts: timestamp,
        level,
        module: moduleName,
        msg: message
    };
    if (extra) {
        payload.meta = extra;
    }
    return JSON.stringify(payload);
}

const logger = {
    debug(moduleName, message, extra) {
        if (getLogLevel() <= LOG_LEVELS.DEBUG) {
            console.log(formatMessage('DEBUG', moduleName, message, extra));
        }
    },
    info(moduleName, message, extra) {
        if (getLogLevel() <= LOG_LEVELS.INFO) {
            console.log(formatMessage('INFO', moduleName, message, extra));
        }
    },
    warn(moduleName, message, extra) {
        if (getLogLevel() <= LOG_LEVELS.WARN) {
            console.warn(formatMessage('WARN', moduleName, message, extra));
        }
    },
    error(moduleName, message, extra) {
        if (getLogLevel() <= LOG_LEVELS.ERROR) {
            console.error(formatMessage('ERROR', moduleName, message, extra));
        }
    },
    audit(moduleName, message, extra) {
        console.log(formatMessage('AUDIT', moduleName, message, extra));
    }
};

module.exports = logger;
