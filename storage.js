const fs = require('node:fs/promises');
const path = require('node:path');

const PATHS = {
  configDir: path.join(__dirname, 'config'),
  dataDir: path.join(__dirname, 'data'),
  storageDir: path.join(__dirname, 'storage'),
  logsDir: path.join(__dirname, 'logs'),
  configFile: path.join(__dirname, 'config', 'config.json'),
  pricesFile: path.join(__dirname, 'data', 'prices.json'),
  portfolioFile: path.join(__dirname, 'data', 'portfolio.json'),
  structuredPricesFile: path.join(__dirname, 'storage', 'prices.json'),
  structuredPortfolioFile: path.join(__dirname, 'storage', 'portfolio.json'),
  logFile: path.join(__dirname, 'logs', 'bot.log')
};

const DEFAULT_CONFIG = {
  server: {
    host: 'play.unitedbangla.fun',
    port: 25565
  },
  account: {
    username: 'Tahsan69',
    password: 'CHANGE_ME',
    auth: 'offline'
  },
  reconnect: {
    enabled: true,
    delayMs: 10000,
    maxDelayMs: 60000,
    backoffMultiplier: 1.5,
    jitterMs: 2000,
    maxAttempts: 10
  },
  manualVerification: {
    enabled: true,
    fallbackAfterAttempts: 3,
    retryCommand: 'retry'
  },
  manualControl: {
    enabled: true,
    lookStepDegrees: 20
  },
  market: {
    command: '/stockmarket',
    minCheckIntervalMs: 30000,
    maxCheckIntervalMs: 50000,
    updateKeywords: [
      'market update',
      'market updated',
      'market crash',
      'market rise',
      'stock update',
      'stocks updated',
      'stock market',
      'ticker'
    ],
    marketAnnouncementDedupMs: 5000,
    mainWindowTitleContains: 'UB Stock Market',
    tickerItemName: 'Live Market Ticker',
    postLoginHomeCommand: '/home home1',
    postLoginTeleportTimeoutMs: 6000,
    postLoginTeleportFallbackDelayMs: 3000,
    postLoginTeleportMovementThreshold: 3,
    postLoginTeleportSuccessKeywords: ['teleport', 'warped', 'home'],
    buyConfirmButtonTimeoutMs: 10000,
    buyConfirmationResultTimeoutMs: 12000,
    sellConfirmButtonTimeoutMs: 10000,
    sellConfirmationResultTimeoutMs: 12000,
    guiOpenTimeoutMs: 15000,
    guiStepTimeoutMs: 10000,
    guiActionDelayMs: 700
  },
  trading: {
    enabled: true,
    reserveCash: 200,
    maxAllocationPerCompany: 0.35,
    maxSharesPerCompany: 500,
    marketMinPrice: 800,
    marketMaxPrice: 1200,
    fallbackBuyBelow: 900,
    fallbackSellAbove: 1100,
    cooldownMs: 20000,
    minHoldDurationMs: 120000,
    buyAggressiveness: 1,
    sellAggressiveness: 1,
    scoreThresholdBuy: 0.55,
    scoreThresholdSell: 0.55,
    rollingWindowSize: 30
  },
  debug: {
    enabled: false,
    logWindowContents: false,
    logClicks: true,
    logParsedPrices: true,
    logDecisions: true
  },
  logLevel: 'info'
};

/**
 * Ensures project folders and required JSON files exist.
 */
async function ensureProjectFiles() {
  await fs.mkdir(PATHS.configDir, { recursive: true });
  await fs.mkdir(PATHS.dataDir, { recursive: true });
  await fs.mkdir(PATHS.storageDir, { recursive: true });
  await fs.mkdir(PATHS.logsDir, { recursive: true });

  await ensureJson(PATHS.configFile, DEFAULT_CONFIG);
  await ensureJson(PATHS.pricesFile, { history: [] });
  await ensureJson(PATHS.portfolioFile, { positions: {}, summary: {} });
  await ensureJson(PATHS.structuredPricesFile, { lastMarketSnapshotAt: null, companies: {} });
  await ensureJson(PATHS.structuredPortfolioFile, { companies: {}, summary: { moneyInvested: 0, realizedProfit: 0, unrealizedProfit: 0 } });
  await ensureText(PATHS.logFile, '');
}

/**
 * Creates a JSON file with defaults if it is missing.
 * @param {string} filePath Absolute file path.
 * @param {object} defaultValue Default JSON content.
 */
async function ensureJson(filePath, defaultValue) {
  try {
    await fs.access(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.writeFile(filePath, `${JSON.stringify(defaultValue, null, 2)}\n`, 'utf8');
  }
}

/**
 * Creates a text file if it is missing.
 * @param {string} filePath Absolute file path.
 * @param {string} defaultValue Default text content.
 */
async function ensureText(filePath, defaultValue) {
  try {
    await fs.access(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.writeFile(filePath, defaultValue, 'utf8');
  }
}

module.exports = {
  ensureProjectFiles,
  PATHS
};
