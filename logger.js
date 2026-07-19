const fs = require('node:fs/promises');
const path = require('node:path');
const { nowIso } = require('./utils');

const LOG_FILE = path.join(__dirname, 'logs', 'bot.log');

const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

/**
 * Creates a simple leveled logger for console and file output.
 * @param {string} level Minimum log level to emit.
 * @returns {{error: Function, warn: Function, info: Function, debug: Function}}
 */
function createLogger(level = 'info') {
  const minLevel = LEVELS[level] ?? LEVELS.info;

  /**
   * Writes one log line if its level is enabled.
   * @param {'error'|'warn'|'info'|'debug'} entryLevel Log level.
   * @param {string} message Log message.
   */
  function log(entryLevel, message) {
    if (LEVELS[entryLevel] > minLevel) return;

    const line = `[${nowIso()}] [${entryLevel.toUpperCase()}] ${message}`;
    console.log(line);
    fs.appendFile(LOG_FILE, `${line}\n`, 'utf8').catch((error) => {
      console.error(`[LOGGER_WRITE_ERROR] ${error.message}`);
    });
  }

  return {
    error: (message) => log('error', message),
    warn: (message) => log('warn', message),
    info: (message) => log('info', message),
    debug: (message) => log('debug', message)
  };
}

module.exports = {
  createLogger,
  LOG_FILE
};
