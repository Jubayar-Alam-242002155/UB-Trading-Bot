const { sleep, withTimeout } = require('../utils/delay');
const { getItemDisplayName, getItemLore, getWindowTitle } = require('../utils/parser');

/**
 * Waits for a window matching a predicate.
 * @param {import('mineflayer').Bot} bot Mineflayer bot.
 * @param {(window: any) => boolean} predicate Window predicate.
 * @param {number} timeoutMs Timeout in milliseconds.
 * @param {string} label Operation label.
 * @returns {Promise<any>}
 */
async function waitForWindow(bot, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const current = bot.currentWindow;
    if (current && predicate(current)) {
      resolve(current);
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onOpen = (window) => {
      if (!predicate(window)) return;
      cleanup();
      resolve(window);
    };

    const onEnd = () => {
      cleanup();
      reject(new Error(`Window wait cancelled because bot disconnected during ${label}`));
    };

    function cleanup() {
      clearTimeout(timer);
      bot.removeListener('windowOpen', onOpen);
      bot.removeListener('end', onEnd);
    }

    bot.on('windowOpen', onOpen);
    bot.on('end', onEnd);
  });
}

/**
 * Sends /stockmarket and waits for the main stock window.
 * @param {import('mineflayer').Bot} bot Mineflayer bot.
 * @param {any} config Runtime config.
 * @param {{ info: Function, warn: Function, error: Function, debug: Function }} logger Logger.
 * @returns {Promise<any>}
 */
async function openStockMarketWindow(bot, config, logger) {
  const timeoutMs = Number(config.market.guiOpenTimeoutMs) || 15000;
  const titleHint = String(config.market.mainWindowTitleContains || 'UB Stock Market').toLowerCase();
  const command = String(config.market.command || '/stockmarket');
  const existingWindow = bot.currentWindow;
  if (existingWindow) {
    const existingTitle = getWindowTitle(existingWindow).toLowerCase();
    if (existingTitle.includes(titleHint)) {
      logger.info(`Reusing currently open market window: "${getWindowTitle(existingWindow)}"`);
      return existingWindow;
    }
  }

  bot.chat(command);
  logger.info(`Sent market command: ${command}`);

  const window = await waitForWindow(
    bot,
    (candidate) => getWindowTitle(candidate).toLowerCase().includes(titleHint),
    timeoutMs,
    'opening stock market window'
  );
  const windowTitle = getWindowTitle(window);

  logger.info(`Market window opened: "${windowTitle}"`);
  return window;
}

/**
 * Opens the Portfolio GUI from the Stock Market window.
 * @param {import('mineflayer').Bot} bot Mineflayer bot.
 * @param {any} marketWindow Market window.
 * @param {any} config Runtime config.
 * @param {{ info: Function, warn: Function, error: Function, debug: Function }} logger Logger.
 * @returns {Promise<any>}
 */
async function openPortfolioWindow(bot, marketWindow, config, logger) {
  const marketTitleHint = String(config.market.mainWindowTitleContains || 'UB Stock Market').toLowerCase();
  const currentTitle = getWindowTitle(bot.currentWindow).toLowerCase();
  if (!currentTitle.includes(marketTitleHint)) {
    throw new Error('Cannot open portfolio because the market window is not active.');
  }

  const portfolioItem = findItem(marketWindow, (item, slot) => {
    if (slot !== 40) return false;
    const display = getItemDisplayName(item).toLowerCase();
    const lore = getItemLore(item).join('\n').toLowerCase();
    return display.includes('chest') && (lore.includes('view all your stocks') || lore.includes('my portfolio'));
  }) || (marketWindow?.slots?.[40]
    ? { slot: 40, item: marketWindow.slots[40] }
    : null);

  if (!portfolioItem) {
    throw new Error('Portfolio chest was not found in the market window.');
  }

  await safeClickSlot(bot, marketWindow, portfolioItem.slot, config, logger, 'open portfolio');

  const timeoutMs = Number(config.market.guiOpenTimeoutMs) || 15000;
  const window = await waitForWindow(
    bot,
    (candidate) => candidate?.id !== marketWindow?.id,
    timeoutMs,
    'opening portfolio window'
  );

  logger.info(`Portfolio window opened: "${getWindowTitle(window)}"`);
  return window;
}

/**
 * Returns from a company/portfolio GUI back to the stock market window.
 * @param {import('mineflayer').Bot} bot Mineflayer bot.
 * @param {any} activeWindow Current active window.
 * @param {any} config Runtime config.
 * @param {{ info: Function, warn: Function, error: Function, debug: Function }} logger Logger.
 * @returns {Promise<any>}
 */
async function returnToMarketWindow(bot, activeWindow, config, logger) {
  const marketTitleHint = String(config.market.mainWindowTitleContains || 'UB Stock Market').toLowerCase();
  const currentTitle = getWindowTitle(bot.currentWindow).toLowerCase();
  if (currentTitle.includes(marketTitleHint)) {
    return bot.currentWindow;
  }

  const backButton = findItem(activeWindow, (item) => {
    const display = getItemDisplayName(item).toLowerCase();
    const lore = getItemLore(item).join('\n').toLowerCase();
    return display.includes('arrow') && lore.includes('click to go back');
  });

  if (!backButton) {
    throw new Error('Back arrow was not found in the active GUI window.');
  }

  await safeClickSlot(bot, activeWindow, backButton.slot, config, logger, 'return to market');

  const timeoutMs = Number(config.market.guiOpenTimeoutMs) || 15000;
  const marketWindow = await waitForWindow(
    bot,
    (candidate) => getWindowTitle(candidate).toLowerCase().includes(marketTitleHint),
    timeoutMs,
    'returning to stock market window'
  );

  logger.info(`Returned to market window: "${getWindowTitle(marketWindow)}"`);
  return marketWindow;
}

/**
 * Finds an item index by custom predicate.
 * @param {any} window Open window.
 * @param {(item: any, index: number) => boolean} predicate Item predicate.
 * @returns {{slot: number, item: any} | null}
 */
function findItem(window, predicate) {
  const slots = Array.isArray(window?.slots) ? window.slots : [];
  for (let slot = 0; slot < slots.length; slot += 1) {
    const item = slots[slot];
    if (!item) continue;
    if (predicate(item, slot)) {
      return { slot, item };
    }
  }
  return null;
}

/**
 * Finds an item by display-name query.
 * @param {any} window Open window.
 * @param {string} query Target name query.
 * @returns {{slot: number, item: any} | null}
 */
function findItemByDisplayName(window, query) {
  const needle = String(query).toLowerCase();
  return findItem(window, (item) => {
    const display = getItemDisplayName(item).toLowerCase();
    return display.includes(needle);
  });
}

/**
 * Finds an item by lore query.
 * @param {any} window Open window.
 * @param {string} query Lore text query.
 * @returns {{slot: number, item: any} | null}
 */
function findItemByLore(window, query) {
  const needle = String(query).toLowerCase();
  return findItem(window, (item) => getItemLore(item).join('\n').toLowerCase().includes(needle));
}

/**
 * Finds an item by regex against display name and lore.
 * @param {any} window Open window.
 * @param {RegExp} regex Regular expression.
 * @returns {{slot: number, item: any} | null}
 */
function findItemByRegex(window, regex) {
  return findItem(window, (item) => {
    const display = getItemDisplayName(item);
    const lore = getItemLore(item).join('\n');
    return regex.test(`${display}\n${lore}`);
  });
}

/**
 * Backward-compatible finder that checks display name first, then lore.
 * @param {any} window Open window.
 * @param {string} query Query text.
 * @returns {{slot:number,item:any}|null}
 */
function findItemByName(window, query) {
  return findItemByDisplayName(window, query) || findItemByLore(window, query);
}

/**
 * Clicks a slot safely and waits for a short inventory update delay.
 * @param {import('mineflayer').Bot} bot Mineflayer bot.
 * @param {any} window Window expected before click.
 * @param {number} slot Slot index.
 * @param {any} config Runtime config.
 * @param {{ info: Function, warn: Function, error: Function, debug: Function }} logger Logger.
 * @param {string} reason Click reason for logs.
 */
async function safeClickSlot(bot, window, slot, config, logger, reason) {
  const active = await resolveActiveWindow(bot, window, config, logger, reason);

  const item = active.slots?.[slot];
  if (!item) {
    throw new Error(`Cannot click slot ${slot}: no item exists`);
  }

  if (config.debug?.enabled && config.debug?.logClicks) {
    const lore = getItemLore(item);
    logger.debug(
      `Clicked slot ${slot} for ${reason}. display="${getItemDisplayName(item)}" lore=${JSON.stringify(lore)}`
    );
  }

  await withTimeout(
    () => bot.clickWindow(slot, 0, 0),
    Number(config.market.guiStepTimeoutMs) || 10000,
    `clicking slot ${slot}`
  );

  await sleep(Number(config.market.guiActionDelayMs) || 700);

  return active;
}

/**
 * Resolves the live active window for a click operation.
 * @param {import('mineflayer').Bot} bot Mineflayer bot.
 * @param {any} expectedWindow Previously captured window.
 * @param {any} config Runtime config.
 * @param {{ info: Function, warn: Function, error: Function, debug: Function }} logger Logger.
 * @param {string} reason Click reason for logs.
 * @returns {Promise<any>}
 */
async function resolveActiveWindow(bot, expectedWindow, config, logger, reason) {
  const current = bot.currentWindow;
  const expectedTitle = getWindowTitle(expectedWindow).toLowerCase();
  const currentTitle = getWindowTitle(current).toLowerCase();

  if (current && expectedTitle && currentTitle === expectedTitle) {
    return current;
  }

  if (current && expectedWindow && !expectedTitle && current.id === expectedWindow.id) {
    return current;
  }

  const timeoutMs = Number(config.market?.guiOpenTimeoutMs) || 15000;
  logger.warn(`Window is not the expected active GUI while ${reason}. Waiting for "${expectedTitle || 'expected window'}".`);

  return waitForWindow(
    bot,
    (candidate) => {
      if (!candidate) return false;
      if (!expectedTitle) return Boolean(expectedWindow && candidate.id === expectedWindow.id);
      return getWindowTitle(candidate).toLowerCase() === expectedTitle;
    },
    timeoutMs,
    reason
  );
}

/**
 * Dumps window details when debug mode is enabled.
 * @param {any} window Open window.
 * @param {any} config Runtime config.
 * @param {{ debug: Function }} logger Logger.
 */
function debugWindow(window, config, logger) {
  if (!config.debug?.enabled || !config.debug?.logWindowContents) return;
  const title = getWindowTitle(window);
  logger.debug(`Window debug: "${title}" id=${window?.id ?? 'unknown'}`);
  const slots = Array.isArray(window?.slots) ? window.slots : [];
  for (let i = 0; i < slots.length; i += 1) {
    const item = slots[i];
    if (!item) continue;
    logger.debug(
      `slot=${i} display="${getItemDisplayName(item)}" lore=${JSON.stringify(getItemLore(item))} nbt=${JSON.stringify(item?.nbt ?? null)}`
    );
  }
}

module.exports = {
  waitForWindow,
  openStockMarketWindow,
  openPortfolioWindow,
  returnToMarketWindow,
  findItem,
  findWindowItem: findItem,
  findItemByDisplayName,
  findItemByLore,
  findItemByRegex,
  findItemByName,
  safeClickSlot,
  resolveActiveWindow,
  debugWindow
};
