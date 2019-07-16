let currentLogger = {
    error: global.console.error,
    info: global.console.info,
    warn: global.console.warn
};

module.exports = {
    get logging() {
        const loggerInterface = {};
        return Object.assign(loggerInterface, currentLogger, {
            setLogger(newLogger) {
                currentLogger = newLogger;
                // Overwrite any existing reference to loggerInterface
                Object.assign(loggerInterface, newLogger);
            }
        });
    }
};
