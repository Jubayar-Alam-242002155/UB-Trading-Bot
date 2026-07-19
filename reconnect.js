const mineflayer = require('mineflayer');
const { initializeInventoryModule } = require('./inventory');
const { initializeLoginModule } = require('./login');
const { initializeMarketModule } = require('./market');
const { initializeSurvivalModule } = require('./survival');
const { createManualControl } = require('./manualControl');
const { sleep } = require('./utils/delay');
const { syncPortfolioFromServer } = require('./market/portfolioSync');
const { formatDisconnectReason } = require('./utils');

/**
 * Starts the bot runtime with reconnect controls.
 * @param {object} config Runtime configuration.
 * @param {{ info: Function, warn: Function, error: Function }} logger Logger instance.
 * @param {{ onBotChange?: (bot: any) => void, onManualControl?: (mc: any) => void, onMarketSnapshot?: (snapshot: any) => void, onPortfolio?: (portfolio: any) => void, onBalance?: (balance: number) => void }} [hooks] Optional lifecycle hooks.
 */
function startBotRuntime(config, logger, hooks) {
  const reconnectEnabled = config?.reconnect?.enabled !== false;
  const reconnectDelayMs = normalizeDelay(config?.reconnect?.delayMs);
  const reconnectMaxDelayMs = normalizeDelay(config?.reconnect?.maxDelayMs, 60000);
  const reconnectBackoffMultiplier = normalizeBackoff(config?.reconnect?.backoffMultiplier);
  const reconnectJitterMs = normalizeJitter(config?.reconnect?.jitterMs);
  const maxAttempts = normalizeMaxAttempts(config?.reconnect?.maxAttempts);
  const manualFallbackEnabled = config?.manualVerification?.enabled === true;
  const manualFallbackAfterAttempts = normalizeMaxAttempts(
    config?.manualVerification?.fallbackAfterAttempts,
    3
  );
  const manualRetryCommand = normalizeRetryCommand(config?.manualVerification?.retryCommand);
  const manualControl = createManualControl({
    enabled: config?.manualControl?.enabled === true,
    lookStepDegrees: normalizeManualLookStep(config?.manualControl?.lookStepDegrees),
    logger
  });
  if (hooks?.onManualControl) hooks.onManualControl(manualControl);

  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let activeBot = null;
  let activeMarketRuntime = null;
  let activeSurvivalRuntime = null;
  let startupSequenceDone = false;
  let startupSequenceRunning = false;
  let verificationKickStreak = 0;
  let lastKickWasVerification = false;
  let isWaitingForManualRetry = false;

  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.on('data', (chunk) => {
    const command = String(chunk).trim();
    const normalizedCommand = command.toLowerCase();
    if (normalizedCommand.length === 0) return;

    if (normalizedCommand === manualRetryCommand && isWaitingForManualRetry) {
      isWaitingForManualRetry = false;
      reconnectAttempts = 0;
      verificationKickStreak = 0;
      logger.info('Manual retry command received. Starting a fresh connection attempt.');
      connect();
      return;
    }

    const handled = manualControl.handleCommand(command, activeBot);
    if (!handled && isWaitingForManualRetry && normalizedCommand !== manualRetryCommand) {
      logger.warn(
        `Waiting for manual retry command "${manualRetryCommand}" before reconnecting.`
      );
    }
  });

  function resetRuntimeState() {
    if (activeMarketRuntime) {
      try { activeMarketRuntime.stop(); } catch (_) {}
      activeMarketRuntime = null;
    }
    if (activeSurvivalRuntime) {
      try { activeSurvivalRuntime.stop(); } catch (_) {}
      activeSurvivalRuntime = null;
    }
    startupSequenceDone = false;
    startupSequenceRunning = false;
  }

  function connect() {
    lastKickWasVerification = false;
    startupSequenceDone = false;
    startupSequenceRunning = false;
    logger.info(
      `Connecting to ${config.server.host}:${config.server.port} as ${config.account.username}`
    );

    const bot = mineflayer.createBot({
      host: config.server.host,
      port: config.server.port,
      username: config.account.username,
      auth: config.account.auth
    });
    activeBot = bot;
    if (hooks?.onBotChange) hooks.onBotChange(bot);

    initializeLoginModule(bot, config, logger);
    initializeInventoryModule(bot, logger);

    bot.once('login', () => {
      reconnectAttempts = 0;
      verificationKickStreak = 0;
      isWaitingForManualRetry = false;
      logger.info('Connected and authenticated.');
    });

    bot.on('spawn', () => {
      logger.info('Spawned in the world.');
      void runStartupSequence(bot).catch((error) => {
        logger.error(`Startup sequence failed: ${error.message}`);
      });
    });

    bot.on('death', () => {
      logger.warn('Death detected. Resetting temporary state and scheduling recovery.');
      resetRuntimeState();
    });

    bot.on('respawn', () => {
      logger.info('Respawn detected. Awaiting startup recovery.');
    });

    bot.on('messagestr', (message) => {
      logger.info(`[CHAT] ${message}`);
    });

    bot.on('kicked', (reason) => {
      const formattedReason = formatDisconnectReason(reason);
      lastKickWasVerification = isVerificationKickMessage(formattedReason);
      logger.warn(`Kicked: ${formattedReason}`);
    });

    bot.on('error', (error) => {
      logger.error(`Mineflayer error: ${error.message}`);
    });

    bot.on('end', (reason) => {
      if (activeBot === bot) {
        manualControl.stopAllControls(bot);
        activeBot = null;
        if (hooks?.onBotChange) hooks.onBotChange(null);
      }
      resetRuntimeState();

      logger.warn(`Disconnected: ${formatDisconnectReason(reason)}`);

      if (!reconnectEnabled) {
        logger.warn('Reconnect is disabled. Bot will remain offline.');
        return;
      }

      if (lastKickWasVerification) {
        verificationKickStreak += 1;
      } else {
        verificationKickStreak = 0;
      }

      if (manualFallbackEnabled && verificationKickStreak >= manualFallbackAfterAttempts) {
        isWaitingForManualRetry = true;
        logger.warn(
          `Repeated verification kicks detected (${verificationKickStreak} in a row). Auto-reconnect paused. Complete manual verification, then type "${manualRetryCommand}" and press Enter to retry.`
        );
        return;
      }

      reconnectAttempts += 1;
      if (reconnectAttempts > maxAttempts) {
        logger.error(
          `Reconnect limit reached (${maxAttempts} attempts). Stopping reconnect loop.`
        );
        return;
      }

      const attemptDelayMs = calculateReconnectDelay({
        baseDelayMs: reconnectDelayMs,
        maxDelayMs: reconnectMaxDelayMs,
        backoffMultiplier: reconnectBackoffMultiplier,
        jitterMs: reconnectJitterMs,
        attempt: reconnectAttempts
      });

      logger.warn(
        `Reconnect attempt ${reconnectAttempts}/${maxAttempts} scheduled in ${attemptDelayMs}ms.`
      );

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, attemptDelayMs);
    });
  }

  process.once('SIGINT', () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
    }
  });

  connect();

  async function runStartupSequence(bot) {
    if (startupSequenceDone || startupSequenceRunning) return;
    startupSequenceRunning = true;
    try {
      logger.info('Join Survival detected. Running post-login startup sequence.');
      await teleportHomeAfterJoin(bot, config, logger);
      if (activeSurvivalRuntime) {
        activeSurvivalRuntime.stop();
      }
      activeSurvivalRuntime = initializeSurvivalModule(bot, config, logger);
      activeSurvivalRuntime.start();
      const startupPortfolio = await runStartupPortfolioSync(bot, config, logger);
      if (startupPortfolio) hooks?.onPortfolio?.(startupPortfolio);
      if (activeMarketRuntime) {
        activeMarketRuntime.stop();
      }
      activeMarketRuntime = initializeMarketModule(bot, config, logger, {
        onSnapshot: hooks?.onMarketSnapshot,
        onPortfolio: hooks?.onPortfolio,
        onBalance: hooks?.onBalance
      });
      activeMarketRuntime.start();
      logger.info('Market automation started.');
      startupSequenceDone = true;
    } finally {
      startupSequenceRunning = false;
    }
  }

  async function runStartupPortfolioSync(bot, config, logger) {
    try {
      return await syncPortfolioFromServer(bot, config, logger);
    } catch (error) {
      logger.warn(`Startup portfolio sync failed: ${error.message}`);
      return null;
    }
  }
}

function calculateReconnectDelay(options) {
  const { baseDelayMs, maxDelayMs, backoffMultiplier, jitterMs, attempt } = options;
  const raw = baseDelayMs * Math.pow(backoffMultiplier, Math.max(0, attempt - 1));
  const bounded = Math.min(maxDelayMs, raw);
  const jitter = Math.floor(Math.random() * jitterMs);
  return bounded + jitter;
}

function normalizeDelay(value, defaultValue = 5000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1000) return defaultValue;
  return Math.floor(parsed);
}

function normalizeMaxAttempts(value, defaultValue = 10) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return defaultValue;
  return Math.floor(parsed);
}

function normalizeBackoff(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return 1.5;
  return parsed;
}

function normalizeJitter(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 2000;
  return Math.floor(parsed);
}

function isVerificationKickMessage(reason) {
  const normalized = String(reason || '').toLowerCase();
  return (
    normalized.includes('verification') ||
    normalized.includes('bot verification') ||
    normalized.includes('please rejoin')
  );
}

function normalizeRetryCommand(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return 'retry';
  return value.trim().toLowerCase();
}

function normalizeManualLookStep(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  if (parsed > 90) return 90;
  return parsed;
}

async function teleportHomeAfterJoin(bot, config, logger) {
  const command = String(config.market?.postLoginHomeCommand || '/home home1');
  const timeoutMs = Number(config.market?.postLoginTeleportTimeoutMs) || 6000;
  const fallbackDelayMs = Number(config.market?.postLoginTeleportFallbackDelayMs) || 3000;
  const countdownDelayMs = Math.max(
    Number(config.market?.postLoginTeleportCountdownDelayMs) || 0,
    3800
  );
  const movementThreshold = Number(config.market?.postLoginTeleportMovementThreshold) || 3;
  const successKeywords = Array.isArray(config.market?.postLoginTeleportSuccessKeywords)
    ? config.market.postLoginTeleportSuccessKeywords
    : ['teleported', 'teleport complete', 'warped', 'moved', 'arrived'];

  const startPosition = bot.entity?.position?.clone?.() || bot.entity?.position || null;
  bot.chat(command);
  logger.info(`Sent post-login teleport command: ${command}`);

  let chatConfirmed = false;
  let countdownDetectedAt = null;
  let movedConfirmed = false;
  const startedAt = Date.now();

  const onMessage = (message) => {
    const normalized = String(message || '').toLowerCase();
    if (/teleporting to .* in \d+s\.?$/i.test(normalized)) {
      if (!countdownDetectedAt) {
        countdownDetectedAt = Date.now();
        logger.info('Teleport countdown detected. Waiting for completion.');
      }
      return;
    }

    if (successKeywords.some((keyword) => normalized.includes(String(keyword).toLowerCase()))) {
      chatConfirmed = true;
    }
  };
  bot.on('messagestr', onMessage);

  try {
    while (Date.now() - startedAt < timeoutMs) {
      if (chatConfirmed) {
        logger.info('Teleport completion detected by chat message.');
        return;
      }

      if (startPosition && bot.entity?.position) {
        const distance = bot.entity.position.distanceTo(startPosition);
        if (Number.isFinite(distance) && distance >= movementThreshold) {
          movedConfirmed = true;
          logger.info(`Teleport completion detected by position change (${distance.toFixed(2)} blocks).`);
          return;
        }
      }

      if (countdownDetectedAt) {
        const elapsedAfterCountdown = Date.now() - countdownDetectedAt;
        if (elapsedAfterCountdown >= countdownDelayMs) {
          logger.info('Teleport completion detected after countdown delay elapsed.');
          return;
        }
      }

      await sleep(1000);
    }
  } finally {
    bot.removeListener('messagestr', onMessage);
  }

  logger.info(`Teleport not confirmed${chatConfirmed || movedConfirmed ? '' : ' by movement/chat'}. Waiting fallback delay ${fallbackDelayMs}ms.`);
  await sleep(fallbackDelayMs);
}

module.exports = {
  startBotRuntime
};
