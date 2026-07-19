const { findItem, safeClickSlot } = require('./guiNavigator');
const { getItemDisplayName, getItemLore } = require('../utils/parser');

const SELL_PRIORITY = ['Sell All'];

/**
 * Executes a sell action by selecting the sell-all option.
 * @param {import('mineflayer').Bot} bot Mineflayer bot.
 * @param {any} sellWindow Sell menu window.
 * @param {any} config Runtime config.
 * @param {{ info: Function, warn: Function, error: Function, debug: Function }} logger Logger.
 * @returns {Promise<{success: boolean, selectedLabel: string|null, quantityHint: number|null, reason?: string}>}
 */
async function executeSell(bot, sellWindow, config, logger, options = {}) {
  for (const label of SELL_PRIORITY) {
    const match = findOption(sellWindow, label);
    if (!match) continue;
    if (!isOptionAvailable(match.item)) {
      logger.debug(`Sell option "${label}" exists but is unavailable.`);
      continue;
    }

    const quantityHint = estimateSellAllQuantity(match.item);
    // Arm the watcher before the click so an immediate server response is not lost.
    if (typeof options.onBeforeConfirm === 'function') {
      await options.onBeforeConfirm({ selectedQuantity: quantityHint });
    }
    await safeClickSlot(bot, sellWindow, match.slot, config, logger, 'sell all stocks');
    logger.info(`Selected quantity: ${quantityHint ?? 'all'}`);
    return {
      success: true,
      selectedLabel: label,
      quantityHint
    };
  }

  logger.warn('No available SELL option found in sell menu.');
  return {
    success: false,
    selectedLabel: null,
    quantityHint: null,
    reason: 'No available SELL option found in sell menu.'
  };
}

/**
 * Finds an option item by display text or lore text.
 * @param {any} window Sell window.
 * @param {string} label Option label.
 * @returns {{slot:number,item:any}|null}
 */
function findOption(window, label) {
  const needle = label.toLowerCase();
  return findItem(window, (item) => {
    const display = getItemDisplayName(item).toLowerCase();
    const loreBlob = getItemLore(item).join('\n').toLowerCase();
    return display.includes(needle) || loreBlob.includes(needle);
  });
}

/**
 * Determines if a sell option is available.
 * @param {any} item Inventory item.
 * @returns {boolean}
 */
function isOptionAvailable(item) {
  const name = String(item?.name || '').toLowerCase();
  if (name.includes('black_wool')) return false;
  if (name.includes('green_wool') || name.includes('lime_wool')) return true;
  return true;
}

/**
 * Estimates the quantity implied by the sell-all option.
 * @param {any} item Inventory item.
 * @returns {number|null}
 */
function estimateSellAllQuantity(item) {
  const lore = getItemLore(item);
  for (let index = 0; index < lore.length - 1; index += 1) {
    if (!/^stocks:?$/i.test(String(lore[index]).trim())) continue;
    const parsed = Number(String(lore[index + 1]).replace(/[^0-9,]/g, '').replace(/,/g, ''));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const ownedMatch = lore.join(' ').match(/you own\D*([0-9][0-9,]*)/i);
  if (ownedMatch) {
    const parsed = Number(ownedMatch[1].replace(/,/g, ''));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  return null;
}

module.exports = {
  executeSell
};
