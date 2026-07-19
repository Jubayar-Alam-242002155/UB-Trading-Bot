/**
 * Creates a prefixed logger for a module.
 * @param {{ info: Function, warn: Function, error: Function, debug?: Function }} logger Base logger.
 * @param {string} scope Module scope label.
 * @param {boolean} debugEnabled Enables debug logs.
 * @returns {{ info: Function, warn: Function, error: Function, debug: Function }}
 */
function createScopedLogger(logger, scope, debugEnabled) {
  const prefix = `[${scope}]`;
  return {
    info: (message) => logger.info(`${prefix} ${message}`),
    warn: (message) => logger.warn(`${prefix} ${message}`),
    error: (message) => logger.error(`${prefix} ${message}`),
    debug: (message) => {
      if (debugEnabled) {
        if (typeof logger.debug === 'function') {
          logger.debug(`${prefix} ${message}`);
        } else {
          logger.info(`${prefix} [DEBUG] ${message}`);
        }
      }
    }
  };
}

module.exports = {
  createScopedLogger
};
