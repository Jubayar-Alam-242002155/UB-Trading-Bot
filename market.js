const { openStockMarketWindow, returnToMarketWindow } = require('./gui/guiNavigator');
const { executeBuy } = require('./gui/buyMenu');
const { executeSell } = require('./gui/sellMenu');
const { openCompanySubMenu, openCompanyWindow } = require('./gui/companyWindow');
const { decideTrade } = require('./market/decisionEngine');
const { readMarketSnapshot } = require('./market/marketReader');
const { appendMarketSnapshot } = require('./market/priceHistory');
const { getItemLore, parseOwnedSharesFromWindow } = require('./utils/parser');
const { randomIntInclusive, sleep } = require('./utils/delay');
const { createScopedLogger } = require('./utils/logger');
const { syncPortfolioFromServer } = require('./market/portfolioSync');

/**
 * Initializes market automation lifecycle for one bot connection.
 * @param {import('mineflayer').Bot} bot Mineflayer bot instance.
 * @param {any} config Runtime configuration.
 * @param {{ info: Function, warn: Function, error: Function, debug?: Function }} rootLogger Root logger.
 * @returns {{start: () => void, stop: () => void}}
 */
function initializeMarketModule(bot, config, rootLogger, hooks = {}) {
  const logger = createScopedLogger(rootLogger, 'MARKET', Boolean(config.debug?.enabled));
  const minIntervalMs = Number(config.market?.minCheckIntervalMs) || 30000;
  const maxIntervalMs = Number(config.market?.maxCheckIntervalMs) || 50000;
  const announcementKeywords = Array.isArray(config.market?.updateKeywords)
    ? config.market.updateKeywords
    : [
        'market update',
        'market updated',
        'market crash',
        'market rise',
        'stock update',
        'stocks updated',
        'stock market',
        'ticker'
      ];
  const announcementDedupMs = Number(config.market?.marketAnnouncementDedupMs) || 5000;

  let running = false;
  let stopped = false;
  let cycleLock = false;
  let lastTradeAtMs = 0;
  let lastTradedCompanyName = '';
  let loopPromise = null;
  /** @type {NodeJS.Timeout|null} */
  let waitTimer = null;
  /** @type {(() => void)|null} */
  let waitResolver = null;
  /** @type {Array<{type:'startup'|'timer_fallback'|'market_update', updateKey?:string, reason:string}>} */
  let pendingTriggers = [];
  /** @type {Map<string, {snapshotSignature:string|null, traded:boolean}>} */
  const processedMarketUpdates = new Map();
  /** @type {Map<string, Set<string>>} Companies proven sold out for a price snapshot. */
  const unavailableBuyCompanies = new Map();
  let updateSequence = 0;
  let lastAnnouncementText = '';
  let lastAnnouncementAt = 0;
  let lastAnnouncementKey = '';
  let latestUpdateKey = '';

  const onMarketChatMessage = (message) => {
    const raw = String(message || '');
    if (!running || stopped || !isMarketAnnouncement(raw, announcementKeywords)) return;

    const normalized = normalizeMarketMessage(raw);
    const now = Date.now();
    let updateKey = '';
    if (
      normalized.length > 0 &&
      normalized === lastAnnouncementText &&
      now - lastAnnouncementAt <= announcementDedupMs
    ) {
      updateKey = lastAnnouncementKey;
    } else {
      updateKey = `market-update-${now}-${updateSequence += 1}`;
    }

    lastAnnouncementText = normalized;
    lastAnnouncementAt = now;
    lastAnnouncementKey = updateKey;
    latestUpdateKey = updateKey;

    logger.info('Market update detected.');
    queueTrigger({
      type: 'market_update',
      updateKey,
      reason: `chat update "${normalized || raw}" detected`
    });
    interruptTimer('Interrupting timer due to market update.');
  };

  /**
   * Starts market event loop.
   */
  function start() {
    if (running) return;
    stopped = false;
    running = true;
    bot.on('messagestr', onMarketChatMessage);
    queueTrigger({ type: 'startup', reason: 'initial startup scan' });
    loopPromise = runLoop().catch((error) => {
      logger.error(`Market loop stopped with error: ${error.message}`);
    });
  }

  /**
   * Stops market event loop.
   */
  function stop() {
    stopped = true;
    running = false;
    bot.removeListener('messagestr', onMarketChatMessage);
    interruptTimer();
    pendingTriggers = [];
    running = false;
  }

  /**
   * Runs trigger loop for market scans.
   */
  async function runLoop() {
    while (!stopped) {
      const trigger = await nextTrigger();
      if (!trigger || stopped) continue;
      await runCycle(trigger);
    }
  }

  /**
   * Gets next trigger (queued event or fallback timer).
   * @returns {Promise<{type:'startup'|'timer_fallback'|'market_update', updateKey?:string, reason:string}|null>}
   */
  async function nextTrigger() {
    if (pendingTriggers.length > 0) {
      return pendingTriggers.shift() || null;
    }

    const waitMs = randomIntInclusive(minIntervalMs, maxIntervalMs);
    logger.info(`Next fallback scan in ${Math.floor(waitMs / 1000)} seconds.`);

    return new Promise((resolve) => {
      waitResolver = () => {
        waitResolver = null;
        resolve(pendingTriggers.shift() || null);
      };
      waitTimer = setTimeout(() => {
        waitTimer = null;
        waitResolver = null;
        resolve({ type: 'timer_fallback', reason: 'fallback timer elapsed' });
      }, waitMs);
    });
  }

  /**
   * Enqueues a trigger, skipping duplicate market-update keys.
   * @param {{type:'startup'|'timer_fallback'|'market_update', updateKey?:string, reason:string}} trigger Trigger payload.
   */
  function queueTrigger(trigger) {
    if (trigger.type === 'market_update' && trigger.updateKey) {
      const alreadyQueued = pendingTriggers.some(
        (entry) => entry.type === 'market_update' && entry.updateKey === trigger.updateKey
      );
      if (alreadyQueued) return;
    }
    pendingTriggers.push(trigger);
    if (waitResolver) {
      const resolve = waitResolver;
      waitResolver = null;
      resolve();
    }
  }

  /**
   * Interrupts currently waiting fallback timer.
   * @param {string} [message] Optional log text.
   */
  function interruptTimer(message) {
    if (waitTimer) {
      clearTimeout(waitTimer);
      waitTimer = null;
      if (message) logger.info(message);
    }
    if (waitResolver) {
      const resolve = waitResolver;
      waitResolver = null;
      resolve();
    }
  }

  /**
   * Runs a single market observation and optional trade cycle.
   * @param {{type:'startup'|'timer_fallback'|'market_update', updateKey?:string, reason:string}} trigger Trigger payload.
   */
  async function runCycle(trigger) {
    if (stopped || cycleLock) return;
    cycleLock = true;
    try {
      if (Number(bot.food) < 14) {
        logger.warn(`Hunger critical (${Number(bot.food)}). Pausing trading until food is restored.`);
        return;
      }
      logger.info(`Starting market check cycle (${trigger.type}: ${trigger.reason}).`);
      logger.info('Opening market...');
      const snapshot = await readMarketSnapshot(bot, config, logger);
      publishSnapshot(snapshot);
      const snapshotSignature = buildSnapshotSignature(snapshot);

      if (trigger.type === 'market_update' && trigger.updateKey) {
        const previous = processedMarketUpdates.get(trigger.updateKey);
        if (previous?.traded && previous.snapshotSignature === snapshotSignature) {
          logger.warn(
            'Skipping duplicate trade attempt for the same market update because prices did not change.'
          );
          return;
        }
      } else if (latestUpdateKey) {
        const latest = processedMarketUpdates.get(latestUpdateKey);
        if (latest?.traded && latest.snapshotSignature === snapshotSignature) {
          logger.info('Skipping fallback duplicate trade; latest market update already traded at same prices.');
          return;
        }
      }

      const history = await appendMarketSnapshot(snapshot, Number(config.trading?.rollingWindowSize) || 30);
      const portfolio = await syncPortfolioFromServer(bot, snapshot.window, config, logger);
      publishPortfolio(portfolio);

      const decision = decideTrade({
        snapshot,
        priceHistory: history,
        portfolio,
        config,
        logger,
        unavailableBuyCompanyNames: unavailableBuyCompanies.get(snapshotSignature) || new Set()
      });

      if (config.debug?.enabled && config.debug?.logDecisions) {
        for (const entry of decision.evaluations || []) {
          logger.debug(
            `Eval ${entry.companyName}: price=${entry.currentPrice} eligible=${entry.eligible} reason=${entry.reason}`
          );
        }
        logger.debug(`Decision: ${JSON.stringify(decision)}`);
      }
      logger.info(`Decision: ${decision.action.toUpperCase()} - ${decision.reason}`);

      if (decision.action === 'hold') {
        if (hasForcedBuyOpportunity(snapshot, config)) {
          logger.error(
            'Forced-buy condition met (price below buy threshold and sufficient balance), but decision is HOLD.'
          );
        }
        if (trigger.type === 'market_update' && trigger.updateKey) {
          processedMarketUpdates.set(trigger.updateKey, {
            snapshotSignature,
            traded: false
          });
        }
        return;
      }

      const cooldownMs = Number(config.trading?.cooldownMs) || 20000;
      const nowMs = Date.now();
      if (decision.companyName === lastTradedCompanyName && nowMs - lastTradeAtMs < cooldownMs) {
        logger.warn(`Trade cooldown active. Waiting until ${cooldownMs}ms passes.`);
        return;
      }

      if (Number(bot.food) < 14) {
        logger.warn(`Hunger critical (${Number(bot.food)}). Trade execution paused.`);
        return;
      }

      const result = await executeTradeDecision(bot, decision, config, logger, snapshot);
      if (!result.executed) {
        logger.warn(`Trade was not executed: ${result.reason}`);
        if (decision.action === 'buy' && isSoldOutReason(result.reason)) {
          const unavailable = unavailableBuyCompanies.get(snapshotSignature) || new Set();
          unavailable.add(decision.companyName);
          unavailableBuyCompanies.set(snapshotSignature, unavailable);
          logger.info(`Marked ${decision.companyName} unavailable until market prices change.`);
        }
        if (decision.action === 'buy' && hasForcedBuyOpportunity(snapshot, config, unavailableBuyCompanies.get(snapshotSignature))) {
          logger.error(
            `Forced-buy condition met (price below buy threshold) but BUY did not execute. reason="${result.reason}"`
          );
        }
        if (trigger.type === 'market_update' && trigger.updateKey) {
          processedMarketUpdates.set(trigger.updateKey, {
            snapshotSignature,
            traded: false
          });
        }
        return;
      }

      if (decision.action === 'buy' && result.quantity > 0 && decision.companyName && decision.price) {
        logger.info('Trade Completed');
        logger.info('Reopening company page...');
        try {
          publishPortfolio(await syncPortfolioFromServer(bot, config, logger));
        } catch (error) {
          logger.error(`Portfolio synchronization after BUY failed: ${error.message}`);
        }
      }

      if (decision.action === 'sell' && result.quantity > 0 && decision.companyName && decision.price) {
        logger.info('Trade Completed');
        logger.info('Reopening company page...');
        try {
          publishPortfolio(await syncPortfolioFromServer(bot, config, logger));
        } catch (error) {
          logger.error(`Portfolio synchronization after SELL failed: ${error.message}`);
        }
      }

      lastTradeAtMs = Date.now();
      lastTradedCompanyName = decision.companyName || '';
      if (Number.isFinite(result.balance)) hooks.onBalance?.(result.balance);
      if (trigger.type === 'market_update' && trigger.updateKey) {
        processedMarketUpdates.set(trigger.updateKey, {
          snapshotSignature,
          traded: true
        });
      }

      logger.info('Trade complete.');
      logger.info(
        `Trade executed: ${decision.action.toUpperCase()} ${decision.companyName}. quantity=${result.quantity} balance=${snapshot.balance}`
      );
      queueTrigger({ type: 'timer_fallback', reason: 'immediate post-trade market recheck' });
    } catch (error) {
      logger.error(`Market cycle failed: ${error.message}`);
    } finally {
      cycleLock = false;
    }
  }

  function publishSnapshot(snapshot) {
    hooks.onSnapshot?.({
      timestamp: snapshot.timestamp,
      balance: snapshot.balance,
      companies: snapshot.companies
    });
  }

  function publishPortfolio(portfolio) {
    hooks.onPortfolio?.(portfolio);
  }

  return {
    start,
    stop
  };
}

/**
 * Executes a buy/sell decision through GUI navigation.
 * @param {import('mineflayer').Bot} bot Mineflayer bot instance.
 * @param {{action:'buy'|'sell', companyName?:string}} decision Decision payload.
 * @param {any} config Runtime config.
 * @param {{ info: Function, warn: Function, error: Function, debug: Function }} logger Logger.
 * @param {{timestamp:string,window:any}} snapshot Current market snapshot.
 * @returns {Promise<{executed:boolean, quantity:number, reason:string}>}
 */
async function executeTradeDecision(bot, decision, config, logger, snapshot) {
  if (!decision.companyName) {
    return { executed: false, quantity: 0, reason: 'Decision had no company name.' };
  }

  try {
    const { loadPortfolio } = require('./market/portfolio');
    const sharedPortfolio = await loadPortfolio();
    const sharedEntry = sharedPortfolio.companies?.[decision.companyName];
    if (decision.action === 'sell') {
      if (!sharedEntry || Number(sharedEntry.shares ?? sharedEntry.ownedShares ?? 0) <= 0) {
        logger.error(
          `Cannot sell ${decision.companyName}: no shares in portfolio`
        );
        return { executed: false, quantity: 0, reason: 'Shared portfolio did not contain owned shares for sell.' };
      }
    }

    const marketWindow = await openStockMarketWindow(bot, config, logger);
    const companyWindow = await openCompanyWindow(bot, marketWindow, decision.companyName, config, logger);
    const beforeShares = parseOwnedSharesFromWindow(companyWindow, decision.companyName);

    if (decision.action === 'buy') {
      // Check stock availability before attempting buy
      const availability = parseStockAvailability(companyWindow);
      logger.debug(`Stock availability for ${decision.companyName}: sold=${availability.sold} available=${availability.available}`);
      if (Number.isFinite(availability.available) && availability.available === 0) {
        logger.warn(`Skipping ${decision.companyName}: no stocks available (sold: ${availability.sold}, available: ${availability.available}).`);
        return {
          executed: false,
          quantity: 0,
          reason: `No stocks available (sold: ${availability.sold}, available: ${availability.available}).`
        };
      }

      logger.info(`Buying... company="${decision.companyName}" price=${decision.price ?? 'unknown'}`);
      let buyWindow;
      try {
        buyWindow = await openCompanySubMenu(bot, companyWindow, 'BUY Stocks', config, logger);
      } catch (error) {
        logger.warn('BUY Stocks button not found by name. Trying lore-based buy button.');
        try {
          buyWindow = await openCompanySubMenu(bot, companyWindow, 'CLICK TO BUY', config, logger);
        } catch (secondError) {
          return {
            executed: false,
            quantity: 0,
            reason: 'BUY menu button not found in company window (name/lore checks failed).'
          };
        }
      }
      const beforeBalance = Number(snapshotBalanceFromWindow(companyWindow));
      let confirmationPromise = null;
      const confirmationOptions = {
        logger,
        bot,
        companyName: decision.companyName,
        beforeShares,
        beforeBalance: Number.isFinite(beforeBalance) ? beforeBalance : null,
        selectedQuantity: null,
        price: decision.price || null,
        timeoutMs: Number(config.market.buyConfirmationResultTimeoutMs) || 12000
      };
      const buyResult = await executeBuy(bot, buyWindow, config, logger, {
        onBeforeConfirm: ({ selectedQuantity }) => {
          confirmationOptions.selectedQuantity = selectedQuantity;
          confirmationPromise = waitForBuyConfirmation(confirmationOptions);
        }
      });
      if (!buyResult.success) {
        return {
          executed: false,
          quantity: 0,
          reason: buyResult.reason || 'No available buy option.'
        };
      }

      logger.info('Waiting for confirmation...');
      const confirmation = await confirmationPromise;
      if (!confirmation.confirmed) {
        logger.warn(`BUY confirmation watcher timed out: ${confirmation.reason}`);
        try {
          const fallbackPortfolio = await syncPortfolioFromServer(bot, config, logger);
          const fallbackEntry = fallbackPortfolio?.companies?.[decision.companyName];
          const fallbackShares = Number(fallbackEntry?.shares ?? fallbackEntry?.ownedShares ?? 0) || 0;
          if (Number.isFinite(beforeShares) ? fallbackShares > beforeShares : fallbackShares > 0) {
            const quantity = Number.isFinite(beforeShares) ? fallbackShares - beforeShares : fallbackShares;
            logger.info(
              `BUY fallback confirmed through portfolio resync. shares=${fallbackShares} before=${beforeShares ?? 'unknown'}`
            );
            try {
              await openStockMarketWindow(bot, config, logger);
            } catch (error) {
              logger.warn(`Unable to return to stock market after BUY fallback: ${error.message}`);
            }
            return {
              executed: true,
              quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
              reason: `BUY confirmed through portfolio resync after watcher timeout at ${snapshot.timestamp}`
            };
          }
        } catch (fallbackError) {
          logger.warn(`BUY fallback resync failed: ${fallbackError.message}`);
        }
        return { executed: false, quantity: 0, reason: confirmation.reason };
      }

      const quantity = confirmation.quantity;
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return {
          executed: false,
          quantity: 0,
          reason: 'Buy confirmation detected but quantity could not be resolved to > 0.'
        };
      }

      logger.info('Trade confirmed.');
      logger.info(`Owned shares: ${confirmation.ownedShares ?? 'unknown'}`);
      logger.info(`New balance: ${confirmation.newBalance ?? 'unknown'}`);

      try {
        await openStockMarketWindow(bot, config, logger);
      } catch (error) {
        logger.warn(`Unable to return to stock market immediately after BUY: ${error.message}`);
      }
      return {
        executed: true,
        quantity,
        balance: confirmation.newBalance,
        reason: `BUY executed via ${buyResult.selectedLabel} at ${snapshot.timestamp}`
      };
    }

    logger.info(`Selling... company="${decision.companyName}" price=${decision.price ?? 'unknown'}`);
    let sellWindow;
    try {
      sellWindow = await openCompanySubMenu(bot, companyWindow, 'CLICK TO SELL', config, logger);
    } catch (error) {
      logger.warn('CLICK TO SELL button not found by lore/name. Trying SELL Stocks fallback.');
      try {
        sellWindow = await openCompanySubMenu(bot, companyWindow, 'SELL Stocks', config, logger);
      } catch (secondError) {
        return {
          executed: false,
          quantity: 0,
          reason: 'SELL menu button not found in company window (name/lore checks failed).'
        };
      }
    }

    const beforeBalance = Number(snapshotBalanceFromWindow(companyWindow));
    let confirmationPromise = null;
    const confirmationOptions = {
      logger,
      bot,
      companyName: decision.companyName,
      beforeShares,
      beforeBalance: Number.isFinite(beforeBalance) ? beforeBalance : null,
      selectedQuantity: null,
      price: decision.price || null,
      timeoutMs: Number(config.market.sellConfirmationResultTimeoutMs) || 12000
    };
    const sellResult = await executeSell(bot, sellWindow, config, logger, {
      onBeforeConfirm: ({ selectedQuantity }) => {
        confirmationOptions.selectedQuantity = selectedQuantity;
        confirmationPromise = waitForSellConfirmation(confirmationOptions);
      }
    });
    if (!sellResult.success) {
      return { executed: false, quantity: 0, reason: sellResult.reason || 'No available sell option.' };
    }

    logger.info('Waiting for confirmation...');
    const confirmation = await confirmationPromise;
    if (!confirmation.confirmed) {
      return { executed: false, quantity: 0, reason: confirmation.reason };
    }
    const quantity = confirmation.quantity;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return {
        executed: false,
        quantity: 0,
        reason: 'Sell confirmation detected but quantity could not be resolved to > 0.'
      };
    }

    logger.info('Trade confirmed.');
    logger.info(`Owned shares: ${confirmation.ownedShares ?? 'unknown'}`);
    logger.info(`New balance: ${confirmation.newBalance ?? 'unknown'}`);

    try {
      await openStockMarketWindow(bot, config, logger);
    } catch (error) {
      logger.warn(`Unable to return to stock market immediately after SELL: ${error.message}`);
    }
    return {
      executed: true,
      quantity,
      balance: confirmation.newBalance,
      reason: `SELL executed via ${sellResult.selectedLabel} at ${snapshot.timestamp}`
    };
  } catch (error) {
    return { executed: false, quantity: 0, reason: error.message };
  }
}

/**
 * Returns normalized message text for update de-duplication.
 * @param {string} message Raw message.
 * @returns {string}
 */
function normalizeMarketMessage(message) {
  return String(message || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Checks whether a chat message looks like a market announcement.
 * @param {string} message Raw chat message.
 * @param {string[]} keywords Keyword list.
 * @returns {boolean}
 */
function isMarketAnnouncement(message, keywords) {
  const normalized = normalizeMarketMessage(message);
  if (!normalized) return false;
  return keywords.some((keyword) => normalized.includes(String(keyword).toLowerCase()));
}

/**
 * Creates stable snapshot signature for duplicate-trade protection.
 * @param {{companies:Array<{name:string,price:number}>,balance:number}} snapshot Parsed snapshot.
 * @returns {string}
 */
function buildSnapshotSignature(snapshot) {
  const companies = [...(snapshot.companies || [])]
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((company) => `${company.name}:${company.price}`);
  return `${companies.join('|')}|balance:${snapshot.balance}`;
}

/**
 * Builds company price lookup map.
 * @param {Array<{name:string,price:number}>} companies Company price entries.
 * @returns {Record<string, number>}
 */
function toPriceMap(companies) {
  /** @type {Record<string, number>} */
  const map = {};
  for (const company of companies) {
    map[company.name] = company.price;
  }
  return map;
}

/**
 * Infers trade quantity from before/after holdings or button hint.
 * @param {number|null} beforeShares Holdings before action.
 * @param {number|null} afterShares Holdings after action.
 * @param {number|null} quantityHint Option quantity hint.
 * @returns {number}
 */
function inferQuantity(beforeShares, afterShares, quantityHint) {
  if (Number.isFinite(beforeShares) && Number.isFinite(afterShares)) {
    return Math.max(0, Math.abs(afterShares - beforeShares));
  }
  if (Number.isFinite(quantityHint) && quantityHint > 0) {
    return Math.floor(quantityHint);
  }
  return 0;
}

/**
 * Waits for post-confirmation buy signals and resolves quantity.
 * @param {{
 *   logger: { info: Function, warn: Function, error: Function, debug: Function },
 *   bot: import('mineflayer').Bot,
 *   companyName: string,
 *   beforeShares: number|null,
 *   beforeBalance: number|null,
 *   selectedQuantity: number|null,
 *   price: number|null,
 *   timeoutMs: number
 * }} options Confirmation wait options.
 * @returns {Promise<{confirmed:boolean, reason:string, quantity:number, ownedShares:number|null, newBalance:number|null}>}
 */
async function waitForBuyConfirmation(options) {
  const logger = options.logger;
  let chatConfirmed = false;
  let chatQuantity = null;
  
  logger.debug(`[BUY CONFIRM] Registering chat listener for ${options.companyName}, timeout=${options.timeoutMs}ms`);
  
  const onMessage = (message) => {
    try {
      const text = String(message).toLowerCase();
      logger.debug(`[BUY CONFIRM] Chat message received: ${text.substring(0, 100)}`);
      
      if (
        text.includes('stock purchased') ||
        text.includes('bought') ||
        text.includes('purchase successful') ||
        text.includes('you bought') ||
        text.includes('buy successful') ||
        (text.includes('pool') && text.includes('you own'))
      ) {
        chatConfirmed = true;
        logger.debug(`[BUY CONFIRM] Chat confirmation detected: ${text.substring(0, 100)}`);
        // Match format: "Stocks   344 @ $1,000 each" or "bought 50 stocks"
        // Use \s+ to match multiple spaces
        const qtyMatch = text.match(/(?:stocks?\s+(\d+)|bought\s+(\d+)|purchase\s+(\d+)|stocks?\s{2,}(\d+))/i);
        if (qtyMatch) {
          const qty = qtyMatch[1] || qtyMatch[2] || qtyMatch[3] || qtyMatch[4];
          chatQuantity = parseInt(qty, 10);
          logger.debug(`[BUY CONFIRM] Chat quantity parsed: ${chatQuantity}`);
        } else {
          logger.debug('[BUY CONFIRM] No quantity match in chat message');
        }
      }
    } catch (error) {
      logger.debug(`[BUY CONFIRM] Error in chat handler: ${error.message}`);
    }
  };
  
  options.bot.on('messagestr', onMessage);

  const startWindowId = options.bot.currentWindow?.id ?? null;
  const startedAt = Date.now();
  let lastOwnedShares = Number.isFinite(options.beforeShares) ? options.beforeShares : null;
  let lastBalance = Number.isFinite(options.beforeBalance) ? options.beforeBalance : null;
  
  try {
    while (Date.now() - startedAt < options.timeoutMs) {
      const activeWindow = options.bot.currentWindow;
      const newWindowId = activeWindow?.id ?? null;
      const guiChanged = startWindowId !== null && newWindowId !== null && newWindowId !== startWindowId;
      
      // Parse current state
      const ownedShares = parseOwnedSharesFromWindow(activeWindow, options.companyName);
      const ownedSharesGeneric = parseOwnedSharesGeneric(activeWindow);
      const ownedSharesResolved =
        Number.isFinite(ownedShares) ? ownedShares : Number.isFinite(ownedSharesGeneric) ? ownedSharesGeneric : null;
      const newBalance = snapshotBalanceFromWindow(activeWindow);
      
      // Check for changes
      const sharesIncreased = Number.isFinite(ownedSharesResolved) && 
                             Number.isFinite(lastOwnedShares) && 
                             ownedSharesResolved > lastOwnedShares;
      const sharesIncreasedFromZero = Number.isFinite(ownedSharesResolved) && 
                                      ownedSharesResolved > 0 &&
                                      (!Number.isFinite(options.beforeShares) || options.beforeShares === 0);
      const balanceDecreased = Number.isFinite(newBalance) && 
                              Number.isFinite(lastBalance) && 
                              newBalance < lastBalance;
      
      // Update last known values
      if (Number.isFinite(ownedSharesResolved)) lastOwnedShares = ownedSharesResolved;
      if (Number.isFinite(newBalance)) lastBalance = newBalance;

      if (chatConfirmed || sharesIncreased || sharesIncreasedFromZero || balanceDecreased) {
        const quantity = resolveConfirmedQuantity({
          beforeShares: options.beforeShares,
          afterShares: Number.isFinite(ownedSharesResolved) ? ownedSharesResolved : null,
          beforeBalance: options.beforeBalance,
          afterBalance: Number.isFinite(newBalance) ? newBalance : null,
          selectedQuantity: options.selectedQuantity,
          price: options.price,
          chatQuantity: chatQuantity
        });
        
        logger.debug(`[BUY CONFIRM] Detection triggered: chat=${chatConfirmed} sharesInc=${sharesIncreased} sharesFromZero=${sharesIncreasedFromZero} balanceDec=${balanceDecreased}`);
        logger.debug(`[BUY CONFIRM] Shares: before=${options.beforeShares} after=${ownedSharesResolved} balance: before=${options.beforeBalance} after=${newBalance}`);

        return {
          confirmed: true,
          reason: chatConfirmed
            ? 'Chat success message received.'
            : sharesIncreased || sharesIncreasedFromZero
              ? 'Owned shares increased.'
              : 'Balance decreased.',
          quantity,
          ownedShares: Number.isFinite(ownedSharesResolved) ? ownedSharesResolved : null,
          newBalance: Number.isFinite(newBalance) ? newBalance : null
        };
      }

      await sleep(200);
    }

    return {
      confirmed: false,
      reason:
        'BUY FAILED: no chat success, no balance decrease, no owned-share increase, and no GUI change within timeout.',
      quantity: 0,
      ownedShares: null,
      newBalance: null
    };
  } finally {
    options.bot.removeListener('messagestr', onMessage);
  }
}

/**
 * Waits for post-confirmation sell signals and resolves quantity.
 * @param {{
 *   bot: import('mineflayer').Bot,
 *   companyName: string,
 *   beforeShares: number|null,
 *   beforeBalance: number|null,
 *   selectedQuantity: number|null,
 *   price: number|null,
 *   timeoutMs: number
 * }} options Confirmation wait options.
 * @returns {Promise<{confirmed:boolean, reason:string, quantity:number, ownedShares:number|null, newBalance:number|null}>}
 */
async function waitForSellConfirmation(options) {
  let chatConfirmed = false;
  const onMessage = (message) => {
    const text = String(message).toLowerCase();
    if (
      text.includes('sold') ||
      text.includes('sell successful') ||
      text.includes('you sold') ||
      (text.includes('pool') && text.includes('you own'))
    ) {
      chatConfirmed = true;
    }
  };
  options.bot.on('messagestr', onMessage);

  const startWindowId = options.bot.currentWindow?.id ?? null;
  const startedAt = Date.now();
  try {
    while (Date.now() - startedAt < options.timeoutMs) {
      const activeWindow = options.bot.currentWindow;
      const newWindowId = activeWindow?.id ?? null;
      const guiChanged = startWindowId !== null && newWindowId !== null && newWindowId !== startWindowId;
      const ownedShares = parseOwnedSharesFromWindow(activeWindow, options.companyName);
      const ownedSharesGeneric = parseOwnedSharesGeneric(activeWindow);
      const ownedSharesResolved =
        Number.isFinite(ownedShares) ? ownedShares : Number.isFinite(ownedSharesGeneric) ? ownedSharesGeneric : null;
      const newBalance = snapshotBalanceFromWindow(activeWindow);
      const sharesDecreased =
        Number.isFinite(options.beforeShares) &&
        Number.isFinite(ownedSharesResolved) &&
        /** @type {number} */ (ownedSharesResolved) < /** @type {number} */ (options.beforeShares);
      const balanceIncreased =
        Number.isFinite(options.beforeBalance) &&
        Number.isFinite(newBalance) &&
        /** @type {number} */ (newBalance) > /** @type {number} */ (options.beforeBalance);

      if (chatConfirmed || guiChanged || sharesDecreased || balanceIncreased) {
        const quantity = resolveConfirmedSellQuantity({
          beforeShares: options.beforeShares,
          afterShares: Number.isFinite(ownedSharesResolved) ? ownedSharesResolved : null,
          beforeBalance: options.beforeBalance,
          afterBalance: Number.isFinite(newBalance) ? newBalance : null,
          selectedQuantity: options.selectedQuantity,
          price: options.price
        });
        return {
          confirmed: true,
          reason: chatConfirmed
            ? 'Chat success message received.'
            : guiChanged
              ? 'GUI changed after confirm click.'
              : sharesDecreased
                ? 'Owned shares decreased.'
                : 'Balance increased.',
          quantity,
          ownedShares: Number.isFinite(ownedSharesResolved) ? ownedSharesResolved : null,
          newBalance: Number.isFinite(newBalance) ? newBalance : null
        };
      }

      await sleep(200);
    }

    return {
      confirmed: false,
      reason:
        'SELL FAILED: no chat success, no balance increase, no owned-share decrease, and no GUI change within timeout.',
      quantity: 0,
      ownedShares: null,
      newBalance: null
    };
  } finally {
    options.bot.removeListener('messagestr', onMessage);
  }
}

/**
 * Resolves confirmed quantity from post-confirmation signals.
 * @param {{
 *   beforeShares:number|null,
 *   afterShares:number|null,
 *   beforeBalance:number|null,
 *   afterBalance:number|null,
 *   selectedQuantity:number|null,
 *   price:number|null,
 *   chatQuantity:number|null
 * }} data Quantity inputs.
 * @returns {number}
 */
function resolveConfirmedQuantity(data) {
  // Priority 1: Use chat-parsed quantity if available (most reliable)
  if (Number.isFinite(data.chatQuantity) && /** @type {number} */ (data.chatQuantity) > 0) {
    return /** @type {number} */ (data.chatQuantity);
  }

  // Priority 2: Use share difference if available
  if (Number.isFinite(data.beforeShares) && Number.isFinite(data.afterShares)) {
    const diff = /** @type {number} */ (data.afterShares) - /** @type {number} */ (data.beforeShares);
    if (diff > 0) return diff;
  }

  // Priority 3: Estimate from balance change
  if (
    Number.isFinite(data.beforeBalance) &&
    Number.isFinite(data.afterBalance) &&
    Number.isFinite(data.price) &&
    /** @type {number} */ (data.price) > 0
  ) {
    const spent = /** @type {number} */ (data.beforeBalance) - /** @type {number} */ (data.afterBalance);
    const estimated = Math.floor(spent / /** @type {number} */ (data.price));
    if (estimated > 0) return estimated;
  }

  // Priority 4: Use selected quantity hint
  if (Number.isFinite(data.selectedQuantity) && /** @type {number} */ (data.selectedQuantity) > 0) {
    return Math.floor(/** @type {number} */ (data.selectedQuantity));
  }

  return 0;
}

/**
 * Resolves confirmed sell quantity from post-confirmation signals.
 * @param {{
 *   beforeShares:number|null,
 *   afterShares:number|null,
 *   beforeBalance:number|null,
 *   afterBalance:number|null,
 *   selectedQuantity:number|null,
 *   price:number|null
 * }} data Quantity inputs.
 * @returns {number}
 */
function resolveConfirmedSellQuantity(data) {
  if (Number.isFinite(data.beforeShares) && Number.isFinite(data.afterShares)) {
    const diff = /** @type {number} */ (data.beforeShares) - /** @type {number} */ (data.afterShares);
    if (diff > 0) return diff;
  }

  if (
    Number.isFinite(data.beforeBalance) &&
    Number.isFinite(data.afterBalance) &&
    Number.isFinite(data.price) &&
    /** @type {number} */ (data.price) > 0
  ) {
    const earned = /** @type {number} */ (data.afterBalance) - /** @type {number} */ (data.beforeBalance);
    const estimated = Math.floor(earned / /** @type {number} */ (data.price));
    if (estimated > 0) return estimated;
  }

  if (Number.isFinite(data.selectedQuantity) && /** @type {number} */ (data.selectedQuantity) > 0) {
    return Math.floor(/** @type {number} */ (data.selectedQuantity));
  }

  return 0;
}

/**
 * Parses balance value from currently visible window text.
 * @param {any} window Active window.
 * @returns {number|null}
 */
function snapshotBalanceFromWindow(window) {
  const slots = Array.isArray(window?.slots) ? window.slots : [];
  for (const item of slots) {
    if (!item) continue;
    const lore = getItemLore(item);
    const display = String(item?.displayName || item?.name || '');
    const lines = [display, ...lore];
    for (let i = 0; i < lines.length; i += 1) {
      if (!/balance|your balance/i.test(String(lines[i]))) continue;
      const next = String(lines[i + 1] || lines[i]);
      const match = next.match(/\$?\s*([0-9][0-9,]*)/);
      if (!match) continue;
      const parsed = Number(match[1].replace(/,/g, ''));
      if (Number.isFinite(parsed)) return parsed;
    }
    for (const line of lines) {
      if (!/after/i.test(String(line))) continue;
      const match = String(line).match(/\$?\s*([0-9][0-9,]*)/);
      if (!match) continue;
      const parsed = Number(match[1].replace(/,/g, ''));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/**
 * Parses generic "You own X / Y" share values from active window lore.
 * @param {any} window Active window.
 * @returns {number|null}
 */
function parseOwnedSharesGeneric(window) {
  const slots = Array.isArray(window?.slots) ? window.slots : [];
  for (const item of slots) {
    if (!item) continue;
    const lore = getItemLore(item);
    for (let i = 0; i < lore.length - 1; i += 1) {
      if (!/you own/i.test(String(lore[i]))) continue;
      const parsed = Number(String(lore[i + 1]).replace(/[^0-9,]/g, '').replace(/,/g, ''));
      if (Number.isFinite(parsed)) return parsed;
    }
    const blob = lore.join(' ');
    const inline = blob.match(/you\s*own\D*([0-9][0-9,]*)\s*\/\s*[0-9]/i);
    if (!inline) continue;
    const parsed = Number(inline[1].replace(/,/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Checks if any company hits forced-buy condition.
 * @param {{companies:Array<{price:number}>, balance:number}} snapshot Market snapshot.
 * @param {any} config Runtime configuration.
 * @returns {boolean}
 */
function hasForcedBuyOpportunity(snapshot, config, unavailableCompanyNames = new Set()) {
  const buyThreshold = Number(config?.trading?.fallbackBuyBelow ?? 900);
  const balance = Number(snapshot.balance);
  if (!Number.isFinite(balance)) return false;
  return snapshot.companies.some(
    (company) => {
      const available = Number(company.stockPoolFree);
      return Number(company.price) < buyThreshold &&
        balance > Number(company.price) &&
        !unavailableCompanyNames.has(company.name) &&
        (!Number.isFinite(available) || available > 0);
    }
  );
}

function isSoldOutReason(reason) {
  return /no stocks available|available:\s*0\b|sold out/i.test(String(reason || ''));
}

/**
 * Parses stock availability from company window.
 * @param {any} window Company window.
 * @returns {{available:number, sold:number}}
 */
function parseStockAvailability(window) {
  const slots = Array.isArray(window?.slots) ? window.slots : [];
  for (const item of slots) {
    if (!item) continue;
    const lore = getItemLore(item);
    const loreBlob = lore.join('\n').toLowerCase();

    if (!loreBlob.includes('max pool') || !loreBlob.includes('stocks')) continue;

    const soldMatch = loreBlob.match(/sold:\s*([0-9][0-9,]*)\s*stocks/i);
    const availableMatch = loreBlob.match(/available:\s*([0-9][0-9,]*)\s*stocks/i);

    const sold = soldMatch ? Number(soldMatch[1].replace(/,/g, '')) : NaN;
    const available = availableMatch ? Number(availableMatch[1].replace(/,/g, '')) : NaN;

    if (Number.isFinite(sold) && Number.isFinite(available)) {
      return { sold, available };
    }
  }

  return { sold: NaN, available: NaN };
}

module.exports = {
  initializeMarketModule
};
