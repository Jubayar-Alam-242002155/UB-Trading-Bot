// Worker process — runs ONE bot instance.
// Reads BOT_ID, BOT_USERNAME, BOT_STORAGE_DIR from env.
// Communicates with parent via stdout (line-delimited JSON) and stdin (JSON commands).

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { startBotRuntime } = require('./reconnect');
const { ensureProjectFiles } = require('./storage');
const fs = require('node:fs/promises');
const path = require('node:path');
const fsSync = require('node:fs');

const BOT_ID = process.env.BOT_ID || 'default';
const BOT_USERNAME = process.env.BOT_USERNAME;
const BOT_STORAGE_DIR = process.env.BOT_STORAGE_DIR;

if (!BOT_USERNAME || !BOT_STORAGE_DIR) {
  console.error('Worker requires BOT_USERNAME and BOT_STORAGE_DIR env vars');
  process.exit(1);
}

/**
 * Emits a structured event to the parent process.
 * @param {string} type Event type.
 * @param {any} data Event payload.
 */
function emit(type, data) {
  try {
    process.stdout.write('__BOT_EVT__' + JSON.stringify({ botId: BOT_ID, type, data }) + '\n');
  } catch (_) {}
}

let activeBot = null;
let activeManualControl = null;

/**
 * Wraps the base logger so every line is forwarded to parent + parses balance out.
 * @param {any} baseLogger Base logger.
 */
function wrapLogger(baseLogger) {
  return {
    info: (msg) => {
      baseLogger.info(msg);
      const text = String(msg);
      // Only actual player messages belong in the Chat panel. Server notices,
      // blank spacer lines, and market receipts stay in Market Activity.
      const isPlayerChat = /^\[CHAT\]\s*<[^>]+>\s*\S/.test(text);
      emit(isPlayerChat ? 'chat' : 'log', {
        level: isPlayerChat ? 'CHAT' : 'INFO',
        message: text,
        time: new Date().toISOString()
      });
      parseAndEmit(msg);
    },
    warn: (msg) => {
      baseLogger.warn(msg);
      emit('log', { level: 'WARN', message: msg, time: new Date().toISOString() });
    },
    error: (msg) => {
      baseLogger.error(msg);
      emit('log', { level: 'ERROR', message: msg, time: new Date().toISOString() });
    },
    debug: (msg) => {
      baseLogger.debug(msg);
      // GUI diagnostics can contain hundreds of lines per market scan. Keep them
      // in the bot log, but do not stream them to the browser by default.
      if (process.env.DASHBOARD_DEBUG === 'true') {
        emit('log', { level: 'DEBUG', message: msg, time: new Date().toISOString() });
      }
    }
  };
}

function parseAndEmit(msg) {
  const bal = msg.match(/Balance=([0-9][0-9,.]*)/);
  if (bal) {
    const n = Number(bal[1].replace(/,/g, ''));
    if (Number.isFinite(n)) emit('balance', { balance: n });
  }
  if (/Connected and authenticated|Spawned in the world/.test(msg)) emit('status', { status: 'online' });
  else if (/Connecting to/.test(msg)) emit('status', { status: 'connecting' });
  else if (/Disconnected|Kicked/.test(msg)) emit('status', { status: 'offline' });
  if (/STOCK PURCHASED|STOCK SOLD|BUY successful|SELL successful/.test(msg)) {
    emit('log', { level: 'TRADE', message: msg, time: new Date().toISOString() });
  }
}

function startStoragePolling() {
  const portfolioFile = path.join(BOT_STORAGE_DIR, 'portfolio.json');
  const pricesFile = path.join(BOT_STORAGE_DIR, 'prices.json');
  let lastPortfolioMtime = 0;
  let lastPricesMtime = 0;

  async function tick() {
    try {
      const stat = await fs.stat(portfolioFile);
      if (stat.mtimeMs !== lastPortfolioMtime) {
        lastPortfolioMtime = stat.mtimeMs;
        const raw = await fs.readFile(portfolioFile, 'utf8');
        emit('portfolio', JSON.parse(raw));
      }
    } catch (_) {}

    try {
      const stat = await fs.stat(pricesFile);
      if (stat.mtimeMs !== lastPricesMtime) {
        lastPricesMtime = stat.mtimeMs;
        const raw = await fs.readFile(pricesFile, 'utf8');
        const store = JSON.parse(raw);
        const companies = Object.entries(store.companies || {}).map(([name, entry]) => ({
          name,
          price: Number(entry.currentPrice) || 0,
          investors: null,
          stockPoolFree: null
        }));
        if (companies.length) emit('prices', { companies });
      }
    } catch (_) {}
  }

  tick();
  setInterval(tick, 2000);
}

// Handle commands from parent via stdin (line-delimited JSON)
let stdinBuffer = '';
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk.toString();
  let idx;
  while ((idx = stdinBuffer.indexOf('\n')) !== -1) {
    const line = stdinBuffer.slice(0, idx).trim();
    stdinBuffer = stdinBuffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      handleCommand(msg);
    } catch (e) {
      emit('log', { level: 'ERROR', message: 'Bad command JSON: ' + e.message, time: new Date().toISOString() });
    }
  }
});

function handleCommand(msg) {
  if (msg.type !== 'command') return;
  const cmd = String(msg.command || '').trim();
  if (!cmd) return;

  emit('log', { level: 'CMD', message: '> ' + cmd, time: new Date().toISOString() });

  const lower = cmd.toLowerCase();

  if (lower === '/help' || lower === 'help') {
    emit('log', { level: 'INFO', message: 'Commands: /chat <msg>, /status, manual on/off, move, look, stop', time: new Date().toISOString() });
    return;
  }
  if (lower === '/status' || lower === 'status') {
    emit('log', { level: 'INFO', message: 'Bot ' + BOT_USERNAME + ' | Active bot: ' + (activeBot ? 'yes' : 'no'), time: new Date().toISOString() });
    return;
  }

  if (activeManualControl && (lower.startsWith('manual ') || lower.startsWith('move ') || lower.startsWith('look ') || lower === 'stop')) {
    const handled = activeManualControl.handleCommand(cmd, activeBot);
    if (handled) return;
  }

  if (lower.startsWith('/chat ') || lower.startsWith('chat ')) {
    const message = cmd.replace(/^\/?(chat)\s+/i, '').trim();
    if (activeBot && message) {
      activeBot.chat(message);
      emit('log', { level: 'CHAT', message: 'Sent: ' + message, time: new Date().toISOString() });
    }
    return;
  }

  if (activeBot) {
    activeBot.chat(cmd);
    emit('log', { level: 'CHAT', message: 'Sent: ' + cmd, time: new Date().toISOString() });
  } else {
    emit('log', { level: 'WARN', message: 'No active bot connection', time: new Date().toISOString() });
  }
}

async function main() {
  // Ensure storage dir exists and is seeded
  fsSync.mkdirSync(BOT_STORAGE_DIR, { recursive: true });
  await ensureProjectFiles();

  const portfolioPath = path.join(BOT_STORAGE_DIR, 'portfolio.json');
  const pricesPath = path.join(BOT_STORAGE_DIR, 'prices.json');
  try { fsSync.accessSync(portfolioPath); } catch (_) {
    fsSync.writeFileSync(portfolioPath, JSON.stringify({ companies: {}, summary: { moneyInvested: 0, realizedProfit: 0, unrealizedProfit: 0 } }, null, 2));
  }
  try { fsSync.accessSync(pricesPath); } catch (_) {
    fsSync.writeFileSync(pricesPath, JSON.stringify({ lastMarketSnapshotAt: null, companies: {} }, null, 2));
  }

  const config = await loadConfig();
  // Override username per bot
  config.account = { ...config.account, username: BOT_USERNAME };

  const baseLogger = createLogger(config.logLevel);
  const logger = wrapLogger(baseLogger);

  logger.info('Worker started for bot: ' + BOT_USERNAME + ' (id=' + BOT_ID + ')');

  startStoragePolling();

  startBotRuntime(config, logger, {
    onBotChange: (bot) => {
      activeBot = bot;
      if (bot === null) emit('status', { status: 'offline' });
    },
    onManualControl: (mc) => { activeManualControl = mc; },
    onMarketSnapshot: (snapshot) => {
      emit('prices', { companies: snapshot.companies || [] });
      if (Number.isFinite(snapshot.balance)) emit('balance', { balance: snapshot.balance });
    },
    onPortfolio: (portfolio) => emit('portfolio', portfolio),
    onBalance: (balance) => {
      if (Number.isFinite(balance)) emit('balance', { balance });
    }
  });
}

main().catch((error) => {
  emit('log', { level: 'ERROR', message: 'Fatal: ' + error.message, time: new Date().toISOString() });
  process.exit(1);
});
