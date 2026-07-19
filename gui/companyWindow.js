const { debugWindow, findItemByName, safeClickSlot, waitForWindow } = require('./guiNavigator');
const { getWindowTitle, getItemDisplayName, getItemLore } = require('../utils/parser');

/**
 * Opens a company detail window from the main market window.
 * @param {import('mineflayer').Bot} bot Mineflayer bot.
 * @param {any} marketWindow Main market window.
 * @param {string} companyName Company name.
 * @param {any} config Runtime config.
 * @param {{ info: Function, warn: Function, error: Function, debug: Function }} logger Logger.
 * @returns {Promise<any>}
 */
async function openCompanyWindow(bot, marketWindow, companyName, config, logger) {
  const companyItem = findItemByName(marketWindow, companyName);
  if (!companyItem) {
    throw new Error(`Company item not found for "${companyName}"`);
  }

  await safeClickSlot(bot, marketWindow, companyItem.slot, config, logger, `open company ${companyName}`);

  const timeoutMs = Number(config.market.guiOpenTimeoutMs) || 15000;
  const companyWindow = await waitForWindow(
    bot,
    (window) => window?.id !== marketWindow?.id,
    timeoutMs,
    `opening company window for ${companyName}`
  );

  logger.info(`Company window opened for "${companyName}": "${getWindowTitle(companyWindow)}"`);
  debugWindow(companyWindow, config, logger);
  return companyWindow;
}

/**
 * Opens a submenu by clicking a button item in company window.
 * @param {import('mineflayer').Bot} bot Mineflayer bot.
 * @param {any} companyWindow Company window.
 * @param {string} menuName Menu item text (BUY Stocks or SELL Stocks).
 * @param {any} config Runtime config.
 * @param {{ info: Function, warn: Function, error: Function, debug: Function }} logger Logger.
 * @returns {Promise<any>}
 */
async function openCompanySubMenu(bot, companyWindow, menuName, config, logger) {
  const requested = String(menuName).toLowerCase();
  const action = requested.includes('buy') ? 'buy' : requested.includes('sell') ? 'sell' : '';
  if (!action) throw new Error(`Unsupported company submenu "${menuName}"`);

  const menuItem = findItemByName(companyWindow, menuName) || findMenuAction(companyWindow, action);
  if (!menuItem) throw new Error(`${action.toUpperCase()} menu button was not found in company window.`);

  logger.info(`Opening ${action.toUpperCase()} menu using slot ${menuItem.slot}.`);
  await safeClickSlot(bot, companyWindow, menuItem.slot, config, logger, `open ${action} menu`);
  const timeoutMs = Number(config.market.guiOpenTimeoutMs) || 15000;
  const subWindow = await waitForWindow(bot, (window) => window?.id !== companyWindow?.id, timeoutMs, `opening ${action} submenu`);
  debugWindow(subWindow, config, logger);
  return subWindow;
}

function findMenuAction(window, action) {
  return require('./guiNavigator').findItem(window, (item) => {
    const text = `${getItemDisplayName(item)}\n${getItemLore(item).join('\n')}`.toLowerCase();
    // The company-information chest also contains phrases such as "you can buy".
    // Only the colored action button has an explicit "click to buy/sell" instruction.
    return text.includes(`click to ${action}`);
  });
}

module.exports = {
  openCompanyWindow,
  openCompanySubMenu
};
