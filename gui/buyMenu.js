const { findItem, safeClickSlot } = require('./guiNavigator');
const { getItemDisplayName, getItemLore } = require('../utils/parser');
const { sleep } = require('../utils/delay');

const BUY_PRIORITY = ['Maximum Affordable', '50', '25', '10', '5', '1'];
const CONFIRM_LORE_KEYWORD = 'CLICK TO CONFIRM';

async function executeBuy(bot, buyWindow, config, logger, options = {}) {
  const availability = checkStockAvailability(buyWindow);
  if (availability.available === 0) {
    return {
      success: false, selectedLabel: null, selectedQuantity: null,
      quantitySlot: null, confirmSlot: null,
      reason: `No stocks available (sold: ${availability.sold}, available: ${availability.available}).`
    };
  }

  const selection = selectQuantityOption(buyWindow, logger);
  if (!selection) {
    return {
      success: false, selectedLabel: null, selectedQuantity: null,
      quantitySlot: null, confirmSlot: null,
      reason: 'No available quantity option was found.'
    };
  }

  await safeClickSlot(bot, buyWindow, selection.slot, config, logger, `select buy quantity "${selection.label}"`);
  logger.info(`Selected quantity: ${selection.selectedQuantity ?? 'unknown'} (${selection.label})`);

  await sleep(Number(config.market.guiActionDelayMs) || 700);

  const postSelectWindow = bot.currentWindow;
  if (postSelectWindow && logger.debug) {
    const slots = Array.isArray(postSelectWindow.slots) ? postSelectWindow.slots : [];
    logger.debug(`[BUY CONFIRM] Post-quantity window has ${slots.length} slots. Non-empty:`);
    for (let i = 0; i < slots.length; i++) {
      const item = slots[i];
      if (!item) continue;
      const d = getItemDisplayName(item);
      const l = getItemLore(item).join(' | ');
      if (d || l) {
        logger.debug(`[BUY CONFIRM]   Slot ${i}: name="${item.name}" display="${d}" lore="${l}"`);
      }
    }
  }

  const confirmWaitMs = Number(config.market.buyConfirmButtonTimeoutMs) || 10000;
  const confirm = await waitForConfirmButton(bot, confirmWaitMs, logger);
  if (!confirm) {
    return {
      success: false, selectedLabel: selection.label, selectedQuantity: selection.selectedQuantity,
      quantitySlot: selection.slot, confirmSlot: null,
      reason: `Confirmation button with lore "${CONFIRM_LORE_KEYWORD}" was not found.`
    };
  }

  // Arm the result watcher immediately before the click. The server can publish
  // the success chat message during clickWindow's short post-click delay.
  if (typeof options.onBeforeConfirm === 'function') {
    await options.onBeforeConfirm({ selectedQuantity: selection.selectedQuantity });
  }
  await safeClickSlot(bot, bot.currentWindow, confirm.slot, config, logger, 'confirm buy trade');
  logger.info(`Clicked confirmation button: slot ${confirm.slot}`);

  return {
    success: true, selectedLabel: selection.label,
    selectedQuantity: selection.selectedQuantity,
    quantitySlot: selection.slot, confirmSlot: confirm.slot
  };
}

function selectQuantityOption(window, logger) {
  for (const label of BUY_PRIORITY) {
    const option = findOption(window, label);
    if (!option) continue;
    if (!isOptionAvailable(option.item)) {
      logger.debug(`Buy option "${label}" exists but is unavailable.`);
      continue;
    }
    return { ...option, label, selectedQuantity: estimateQuantity(option.item, label) };
  }
  return null;
}

function findOption(window, label) {
  const needle = label.toLowerCase();
  return findItem(window, (item) => {
    const display = getItemDisplayName(item).toLowerCase();
    const lore = getItemLore(item).map((line) => line.toLowerCase());
    const loreBlob = lore.join('\n');
    const selectable = loreBlob.includes('click to select') || loreBlob.includes('selected');
    if (needle === 'maximum affordable') {
      return selectable && (loreBlob.includes('afford') || loreBlob.includes('whole stocks'));
    }
    const qty = Number(needle);
    if (Number.isFinite(qty)) {
      if (!selectable) return false;
      if (itemContainsStockQuantity(item, qty)) return true;
      return loreBlob.includes(`stocks:\n${qty}`) || loreBlob.includes(`stocks ${qty}`);
    }
    return display.includes(needle) || loreBlob.includes(needle);
  });
}

async function waitForConfirmButton(bot, timeoutMs, logger) {
  const startedAt = Date.now();
  let fallbackCandidate = null;
  while (Date.now() - startedAt < timeoutMs) {
    const active = bot.currentWindow;
    if (active) {
      const slots = Array.isArray(active.slots) ? active.slots : [];
      for (let i = 0; i < slots.length; i++) {
        const item = slots[i];
        if (!item) continue;
        const name = String(item.name || '').toLowerCase();
        const display = getItemDisplayName(item).toUpperCase();
        const lore = getItemLore(item).map((line) => line.toUpperCase());
        const loreBlob = lore.join('\n');
        if (loreBlob.includes(CONFIRM_LORE_KEYWORD)) {
          if (logger) logger.debug(`[BUY CONFIRM] Found confirm at slot ${i} via CLICK TO CONFIRM`);
          return { slot: i, item };
        }
        if (display.includes('CONFIRM')) {
          if (logger) logger.debug(`[BUY CONFIRM] Found confirm at slot ${i} via display CONFIRM`);
          return { slot: i, item };
        }
        if (name.includes('green_wool') || name.includes('lime_wool')) {
          const isQuantitySelector = loreBlob.includes('CLICK TO SELECT') || loreBlob.includes('STOCKS:');
          const isConfirmLike = loreBlob.includes('CONFIRM') || loreBlob.includes('PURCHASE') || loreBlob.includes('TOTAL') || loreBlob.includes('COST');
          if (!isQuantitySelector && isConfirmLike) {
            if (logger) logger.debug(`[BUY CONFIRM] Found confirm at slot ${i} via green wool + purchase lore`);
            return { slot: i, item };
          }
          if (!isQuantitySelector && !fallbackCandidate) {
            fallbackCandidate = { slot: i, item };
          }
        }
      }
      if (fallbackCandidate && Date.now() - startedAt > timeoutMs / 2) {
        if (logger) logger.debug(`[BUY CONFIRM] Using fallback at slot ${fallbackCandidate.slot}`);
        return fallbackCandidate;
      }
    }
    await sleep(200);
  }
  if (fallbackCandidate) {
    if (logger) logger.debug(`[BUY CONFIRM] Using fallback at slot ${fallbackCandidate.slot} after timeout`);
    return fallbackCandidate;
  }
  if (logger) logger.debug('[BUY CONFIRM] No confirmation button found within timeout');
  return null;
}

function isOptionAvailable(item) {
  const name = String(item?.name || '').toLowerCase();
  if (name.includes('black_wool')) return false;
  if (name.includes('green_wool') || name.includes('lime_wool')) return true;
  return true;
}

function estimateQuantity(item, label) {
  const fromLabel = parseQuantity(String(label));
  if (Number.isFinite(fromLabel) && fromLabel > 0) return fromLabel;
  const lore = getItemLore(item);
  if (label.toLowerCase().includes('maximum affordable')) {
    const stocksLineValue = valueAfterLabel(lore, 'stocks');
    const stocksParsed = parseQuantity(stocksLineValue || '');
    if (Number.isFinite(stocksParsed) && stocksParsed > 0) return stocksParsed;
    for (const line of lore) {
      const maxMatch = line.match(/(?:can buy|afford)\D*([0-9][0-9,]*)/i);
      if (!maxMatch) continue;
      const parsed = Number(maxMatch[1].replace(/,/g, ''));
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  const stocksLineValue = valueAfterLabel(lore, 'stocks');
  const stocksParsed = parseQuantity(stocksLineValue || '');
  if (Number.isFinite(stocksParsed) && stocksParsed > 0) return stocksParsed;
  return null;
}

function parseQuantity(text) {
  const match = String(text).match(/([0-9][0-9,]*)/);
  if (!match) return null;
  const parsed = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function itemContainsStockQuantity(item, quantity) {
  const lore = getItemLore(item);
  for (let i = 0; i < lore.length - 1; i += 1) {
    if (!/^stocks:?$/i.test(lore[i].trim())) continue;
    const parsed = parseQuantity(lore[i + 1]);
    if (parsed === quantity) return true;
  }
  return false;
}

function valueAfterLabel(lore, label) {
  for (let i = 0; i < lore.length - 1; i += 1) {
    if (lore[i].trim().toLowerCase() !== label.toLowerCase()) continue;
    return lore[i + 1] ?? null;
  }
  return null;
}

function checkStockAvailability(window) {
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

module.exports = { executeBuy };
