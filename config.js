const fs = require('node:fs/promises');
const path = require('node:path');

const CONFIG_PATH = path.join(__dirname, 'config', 'config.json');

/**
 * Loads runtime configuration from config/config.json.
 * Throws if the file is missing or invalid.
 * @returns {Promise<object>} Parsed configuration object.
 */
async function loadConfig() {
  const raw = await fs.readFile(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

module.exports = {
  loadConfig,
  CONFIG_PATH
};
