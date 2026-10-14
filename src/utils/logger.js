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

const CURRENT_LEVEL = process.env.LOG_LEVEL === 'DEBUG' ? LOG_LEVELS.DEBUG : LOG_LEVELS.INFO;

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
    info(moduleName, message, extra) {
        if (CURRENT_LEVEL <= LOG_LEVELS.INFO) {
            console.log(formatMessage('INFO', moduleName, message, extra));
        }
    },
    warn(moduleName, message, extra) {
        if (CURRENT_LEVEL <= LOG_LEVELS.WARN) {
            console.warn(formatMessage('WARN', moduleName, message, extra));
        }
    },
    error(moduleName, message, extra) {
        if (CURRENT_LEVEL <= LOG_LEVELS.ERROR) {
            console.error(formatMessage('ERROR', moduleName, message, extra));
        }
    },
    audit(moduleName, message, extra) {
        console.log(formatMessage('AUDIT', moduleName, message, extra));
    }
};

module.exports = logger;
