function getLogging() {
    let logging = {};
    let _logger = null;

    logging.error = (...args) => {
        _logger ? _logger.error(...args) : null;
    };

    logging.info = (...args) => {
        _logger ? _logger.info(...args) : null;
    };

    logging.warn = (...args) => {
        _logger ? _logger.warn(...args) : null;
    };

    logging.updateLogger = (logger) => {
        _logger = logger;
    };

    return logging;
}

module.exports = {
    get logging() {
        return getLogging();
    }
};