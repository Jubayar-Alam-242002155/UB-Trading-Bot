const { createDashboard } = require('./server');

let dashboard = null;
let botRef = null;
let manualControlRef = null;
let lastState = {
  balance: 0,
  botStatus: 'offline',
  companies: [],
  portfolio: {},
  tradingEnabled: true
};

const LOG_BUFFER_MAX = 200;
const logBuffer = [];

/**
 * Starts the dashboard and wires it to the bot.
 * @param {{ port?: number }} options
 * @returns {{ broadcast: Function, pushLog: Function, updateState: Function }}
 */
function startDashboard(options = {}) {
  dashboard = createDashboard({
    port: options.port || 3000,
    onCommand: handleCommand
  });

  return {
    broadcast: dashboard.broadcast,
    pushLog,
    updatePrices,
    updatePortfolio,
    updateBalance,
    updateBotStatus,
    setBot,
    setManualControl,
    setTradingEnabled
  };
}

/**
 * Sets the active bot reference for command routing.
 * @param {import('mineflayer').Bot} bot
 */
function setBot(bot) {
  botRef = bot;
}

/**
 * Sets the manual control handler.
 * @param {{ handleCommand: Function, stopAllControls: Function }} mc
 */
function setManualControl(mc) {
  manualControlRef = mc;
}

/**
 * Sets trading enabled state.
 * @param {boolean} enabled
 */
function setTradingEnabled(enabled) {
  lastState.tradingEnabled = enabled;
  if (dashboard) dashboard.broadcast('tradingEnabled', { enabled });
}

/**
 * Pushes a log entry to the dashboard.
 * @param {string} level Log level.
 * @param {string} message Log message.
 */
function pushLog(level, message) {
  const entry = {
    time: new Date().toISOString(),
    level,
    message
  };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  if (dashboard) dashboard.broadcast('log', entry);
}

/**
 * Updates market prices on the dashboard.
 * @param {Array<{name:string, price:number, investors?:number|null, stockPoolFree?:number|null}>} companies
 */
function updatePrices(companies) {
  lastState.companies = companies;
  if (dashboard) dashboard.broadcast('prices', { companies });
}

/**
 * Updates portfolio data on the dashboard.
 * @param {any} portfolio Portfolio object.
 */
function updatePortfolio(portfolio) {
  lastState.portfolio = portfolio;
  if (dashboard) dashboard.broadcast('portfolio', portfolio);
}

/**
 * Updates balance on the dashboard.
 * @param {number} balance Current balance.
 */
function updateBalance(balance) {
  lastState.balance = balance;
  if (dashboard) dashboard.broadcast('balance', { balance });
}

/**
 * Updates bot connection status.
 * @param {string} status Status string.
 */
function updateBotStatus(status) {
  lastState.botStatus = status;
  if (dashboard) dashboard.broadcast('status', { status });
}

/**
 * Handles incoming commands from the dashboard UI.
 * @param {string} cmd Raw command string.
 */
function handleCommand(cmd) {
  pushLog('CMD', `> ${cmd}`);

  // Bot control commands
  const lower = cmd.toLowerCase().trim();

  if (lower === '/status' || lower === 'status') {
    pushLog('INFO', `Bot: ${lastState.botStatus} | Balance: $${lastState.balance} | Trading: ${lastState.tradingEnabled ? 'ON' : 'OFF'}`);
    return;
  }

  if (lower === '/help' || lower === 'help') {
    pushLog('INFO', 'Commands: /chat <msg>, /status, manual on/off, move <dir> <on/off>, look <dir>, stop, /help');
    return;
  }

  // Manual control commands
  if (manualControlRef && (
    lower.startsWith('manual ') || lower.startsWith('move ') ||
    lower.startsWith('look ') || lower === 'stop'
  )) {
    const handled = manualControlRef.handleCommand(cmd, botRef);
    if (handled) {
      pushLog('INFO', `Manual control: ${cmd}`);
      return;
    }
  }

  // Chat command
  if (lower.startsWith('/chat ') || lower.startsWith('chat ')) {
    const message = cmd.replace(/^\/?(chat)\s+/i, '').trim();
    if (botRef && message) {
      botRef.chat(message);
      pushLog('CHAT', `Sent: ${message}`);
    } else {
      pushLog('WARN', 'No active bot or empty message');
    }
    return;
  }

  // Minecraft command (starts with /)
  if (cmd.startsWith('/') && botRef) {
    botRef.chat(cmd);
    pushLog('CHAT', `Sent: ${cmd}`);
    return;
  }

  // Default: send as chat
  if (botRef) {
    botRef.chat(cmd);
    pushLog('CHAT', `Sent: ${cmd}`);
  } else {
    pushLog('WARN', 'No active bot connection');
  }
}

module.exports = { startDashboard };
