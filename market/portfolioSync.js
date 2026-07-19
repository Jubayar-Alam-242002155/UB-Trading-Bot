const {
  openPortfolioWindow,
  openStockMarketWindow,
  returnToMarketWindow
} = require('../gui/guiNavigator');
const { getItemDisplayName, getItemLore, getWindowTitle, stripFormatting } = require('../utils/parser');
const { loadPortfolio, savePortfolio, ensureCompany } = require('./portfolio');

/**
 * Synchronizes portfolio state from the server's dedicated Portfolio GUI.
 * @param {import('mineflayer').Bot} bot Mineflayer bot instance.
 * @param {any} arg2 Market window or runtime config.
 * @param {any} arg3 Runtime config or logger.
 * @param {any} arg4 Logger when a market window is provided.
 * @returns {Promise<any>}
 */
async function syncPortfolioFromServer(bot, arg2, arg3, arg4) {
  const { marketWindow, config, logger } = normalizeArgs(arg2, arg3, arg4);
  logger.info('Synchronizing portfolio...');

  const activeMarketWindow =
    marketWindow && getWindowTitle(marketWindow).toLowerCase().includes(marketTitleHint(config))
      ? marketWindow
      : await openStockMarketWindow(bot, config, logger);

  logger.info('Market opened');

  // Build a map of item-name -> real company name from market window
  const marketCompanyMap = buildCompanyNameMapFromMarket(activeMarketWindow);

  const portfolioWindow = await openPortfolioWindow(bot, activeMarketWindow, config, logger);
  logger.info('Portfolio opened');

  const timestamp = new Date().toISOString();
  const portfolio = await loadPortfolio();
  for (const key of Object.keys(portfolio.companies || {})) {
    delete portfolio.companies[key];
  }

  const entries = parsePortfolioWindow(portfolioWindow, timestamp, marketCompanyMap);
  for (const entry of entries) {
    portfolio.companies[entry.company] = entry;
  }

  refreshPortfolioSummary(portfolio);
  portfolio.summary.lastSynchronizationTime = timestamp;
  await savePortfolio(portfolio);
  logger.info('Portfolio synchronized');
  if (config.debug?.enabled && config.debug?.logParsedPrices) {
    logger.debug(`Portfolio data: ${JSON.stringify(portfolio.summary)}`);
  }

  for (const entry of entries) {
    logger.info(
      `Owned: ${entry.company} | Shares=${entry.shares} | AvgBuy=${entry.avgBuy} | Current=${entry.currentPrice} | Profit=${entry.profit}`
    );
  }

  await returnToMarketWindow(bot, portfolioWindow, config, logger);
  logger.info('Portfolio sync complete.');
  return portfolio;
}

/**
 * Builds a map from Minecraft item-name to real company name from market window slots.
 * The market window lore contains "Company Name" followed by the actual company name.
 * The item.name field contains the Minecraft ID (e.g. "map", "bricks", "oak_log").
 * Both portfolio and market windows use the same Minecraft item for each company,
 * so we can translate portfolio item names -> real company names.
 * @param {any} marketWindow The open market window.
 * @returns {Record<string, string>} Map from item-name -> company-name.
 */
function buildCompanyNameMapFromMarket(marketWindow) {
  /** @type {Record<string, string>} */
  const map = {};
  const slots = Array.isArray(marketWindow?.slots) ? marketWindow.slots : [];

  for (const item of slots) {
    if (!item) continue;
    const itemName = String(item?.name ?? '');
    if (!itemName) continue;

    const lore = getItemLore(item);
    const lines = lore.map((line) => stripFormatting(String(line)).trim()).filter(Boolean);

    for (let i = 0; i < lines.length; i += 1) {
      if (!/company\s*name/i.test(lines[i])) continue;
      const companyName = lines[i + 1];
      if (!companyName) continue;
      // Skip if the next line is itself a label (e.g. another "Company Name" line)
      if (/^company\s*name$/i.test(companyName.trim())) continue;
      map[itemName] = companyName;
      break;
    }
  }

  return map;
}

/**
 * Parses every owned-company row from the Portfolio GUI.
 * @param {any} window Portfolio GUI window.
 * @param {string} timestamp Sync timestamp.
 * @param {Record<string, string>} marketCompanyMap Item-name -> company-name map from market window.
 * @returns {Array<Record<string, any>>}
 */
function parsePortfolioWindow(window, timestamp, marketCompanyMap = {}) {
  const entries = [];
  const slots = Array.isArray(window?.slots) ? window.slots : [];

  for (const item of slots) {
    if (!item) continue;
    const parsed = parsePortfolioEntry(item, timestamp, marketCompanyMap);
    if (!parsed) continue;
    entries.push(parsed);
  }

  return dedupeByCompany(entries);
}

/**
 * Parses a single owned-company row.
 * @param {any} item Portfolio item.
 * @param {string} timestamp Sync timestamp.
 * @param {Record<string, string>} marketCompanyMap Item-name -> company-name map from market window.
 * @returns {Record<string, any>|null}
 */
function parsePortfolioEntry(item, timestamp, marketCompanyMap = {}) {
  const lines = collectTextLines(item);
  const blob = lines.join('\n').toLowerCase();

  if (!looksLikePortfolioEntry(blob)) {
    return null;
  }

  const itemName = String(item?.name ?? '');
  let company =
    extractLabelValue(lines, [/company\s*name/i]) ||
    stripFormatting(getItemDisplayName(item)).trim() ||
    firstMeaningfulLine(lines);

  // Always prefer the market window mapping when available.
  // The market window authoritatively maps Minecraft item IDs to real company names.
  // Without this, portfolio entries get stored under Minecraft display names
  // (e.g. "Bricks" instead of "BuildRight Corp") causing the decision engine
  // to find 0 shares when looking up by company name.
  if (itemName && marketCompanyMap[itemName]) {
    company = marketCompanyMap[itemName];
  }

  if (!company) return null;

  const shares = extractShares(lines, blob);
  const avgBuy = extractMoneyAfterLabel(lines, [/avg\s*buy/i]);
  const currentPrice = extractMoneyAfterLabel(lines, [/current\s*price/i, /^price$/i]);
  const currentValue = extractMoneyAfterLabel(lines, [/current\s*value/i, /^value$/i]);
  const profit = extractSignedMoneyAfterLabel(lines, [/^p$/i, /profit/i, /profit\s*\/?\s*loss/i]);
  const status = extractLabelValue(lines, [/status/i]) || '';

  return {
    company,
    shares,
    ownedShares: shares,
    avgBuy,
    averageBuyPrice: avgBuy,
    currentPrice,
    currentValue,
    profit,
    status,
    lastSync: timestamp,
    lastSynchronizationTime: timestamp
  };
}

/**
 * Checks whether a display name corresponds to a known Minecraft item name.
 * This helps distinguish "Bricks" (item name) from "BuildRight Corp" (company name).
 * @param {string} displayName The parsed display name.
 * @param {string} itemName The Minecraft item name.
 * @returns {boolean}
 */
function isItemDisplayName(displayName, itemName) {
  if (!itemName) return false;
  const normalizedDisplay = displayName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalizedItem = itemName.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalizedDisplay === normalizedItem || normalizedDisplay.includes(normalizedItem) || normalizedItem.includes(normalizedDisplay);
}

/**
 * Collects all visible text from an item.
 * @param {any} item GUI item.
 * @returns {string[]}
 */
function collectTextLines(item) {
  const lines = [];
  const displayName = stripFormatting(getItemDisplayName(item));
  if (displayName) lines.push(displayName);
  const lore = getItemLore(item);
  for (const line of lore) {
    lines.push(line);
  }
  return compactLines(lines);
}

/**
 * Checks whether a slot looks like a portfolio company entry.
 * @param {string} blob Lowercase text blob.
 * @returns {boolean}
 */
function looksLikePortfolioEntry(blob) {
  return (
    /avg\s*buy/i.test(blob) &&
    (/owned/i.test(blob) || /your\s*stocks/i.test(blob) || /stocks/i.test(blob)) &&
    (/\bprofit\b/i.test(blob) || /\bp\b/i.test(blob) || /profit\s*\/\s*loss/i.test(blob) || /[$][+-]?[0-9]/i.test(blob))
  );
}

/**
 * Extracts the text value immediately following a label.
 * @param {string[]} lines Source lines.
 * @param {RegExp[]} labels Label patterns.
 * @returns {string|null}
 */
function extractLabelValue(lines, labels) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const normalizedLine = line.replace(/:\s*$/, '').trim();
    if (!labels.some((pattern) => pattern.test(line) || pattern.test(normalizedLine))) continue;

    const inline = line.replace(/^.*?:\s*/i, '').trim();
    if (inline && !labels.some((pattern) => pattern.test(inline) || pattern.test(inline.replace(/:\s*$/, '').trim()))) {
      return inline;
    }

    for (let cursor = index + 1; cursor < Math.min(lines.length, index + 5); cursor += 1) {
      const candidate = lines[cursor];
      if (!candidate) continue;
      if (/^[\/\-\|\[\]█]+$/.test(candidate.trim())) continue;
      const normalizedCandidate = candidate.replace(/:\s*$/, '').trim();
      if (labels.some((pattern) => pattern.test(candidate) || pattern.test(normalizedCandidate))) continue;
      return candidate.trim();
    }
  }

  return null;
}

/**
 * Extracts a money value after a label.
 * @param {string[]} lines Source lines.
 * @param {RegExp[]} labels Label patterns.
 * @returns {number}
 */
function extractMoneyAfterLabel(lines, labels) {
  const value = extractLabelValue(lines, labels);
  return parseMoney(value);
}

/**
 * Extracts a signed money value after a label.
 * @param {string[]} lines Source lines.
 * @param {RegExp[]} labels Label patterns.
 * @returns {number}
 */
function extractSignedMoneyAfterLabel(lines, labels) {
  const value = extractLabelValue(lines, labels);
  return parseSignedMoney(value);
}

/**
 * Extracts owned shares count from the Portfolio row.
 * @param {string[]} lines Source lines.
 * @param {string} blob Lowercase text blob.
 * @returns {number}
 */
function extractShares(lines, blob) {
  const ratioMatch = blob.match(/(?:stocks?|owned)[^0-9]{0,40}([0-9][0-9,]*)\s*\/\s*([0-9][0-9,]*)/i);
  if (ratioMatch) {
    return parseInteger(ratioMatch[1]);
  }

  const ownedRowMatch = blob.match(/owned[^0-9]{0,20}([0-9][0-9,]*)\s*stocks?/i);
  if (ownedRowMatch) {
    return parseInteger(ownedRowMatch[1]);
  }

  const ownedValue = extractLabelValue(lines, [/stocks?/i, /owned/i]);
  const ownedMatch = String(ownedValue || blob).match(/([0-9][0-9,]*)/);
  return ownedMatch ? parseInteger(ownedMatch[1]) : 0;
}

/**
 * Returns first non-label meaningful line.
 * @param {string[]} lines Source lines.
 * @returns {string}
 */
function firstMeaningfulLine(lines) {
  for (const line of lines) {
    if (!line) continue;
    if (/^(company\s*name|current\s*price|current\s*value|avg\s*buy|status|profit|stocks?|owned)$/i.test(line)) {
      continue;
    }
    if (/^[\/\-\|\[\]█]+$/.test(line.trim())) continue;
    return line.trim();
  }
  return '';
}

/**
 * Removes duplicate company entries while keeping the latest one.
 * @param {Array<Record<string, any>>} entries Parsed entries.
 * @returns {Array<Record<string, any>>}
 */
function dedupeByCompany(entries) {
  const map = {};
  for (const entry of entries) {
    map[entry.company] = entry;
  }
  return Object.values(map);
}

/**
 * Converts JSON chat-component text into normalized lines.
 * @param {string[]} lines Input lines.
 * @returns {string[]}
 */
function compactLines(lines) {
  const result = [];
  for (const line of lines) {
    const normalized = stripFormatting(String(line || ''))
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) continue;
    result.push(normalized);
  }
  return result;
}

/**
 * Parses a formatted currency string.
 * @param {string|number|null} text Value text.
 * @returns {number}
 */
function parseMoney(text) {
  const match = String(text ?? '').match(/([0-9][0-9,]*(?:\.[0-9]+)?)/);
  if (!match) return 0;
  const parsed = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Parses a signed formatted currency string.
 * @param {string|number|null} text Value text.
 * @returns {number}
 */
function parseSignedMoney(text) {
  const match = String(text ?? '').match(/([+-]?[0-9][0-9,]*(?:\.[0-9]+)?)/);
  if (!match) return 0;
  const parsed = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Parses an integer.
 * @param {string|number|null} text Value text.
 * @returns {number}
 */
function parseInteger(text) {
  const match = String(text ?? '').match(/([0-9][0-9,]*)/);
  if (!match) return 0;
  const parsed = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Normalizes arguments for backward-compatible call sites.
 * @param {any} arg2 Market window or config.
 * @param {any} arg3 Config or logger.
 * @param {any} arg4 Logger when a market window is provided.
 * @returns {{marketWindow:any|null,config:any,logger:any}}
 */
function normalizeArgs(arg2, arg3, arg4) {
  if (arg2 && typeof arg2 === 'object' && Array.isArray(arg2.slots)) {
    return { marketWindow: arg2, config: arg3, logger: arg4 };
  }

  return { marketWindow: null, config: arg2, logger: arg3 };
}

/**
 * Builds a lowercase market title hint.
 * @param {any} config Runtime config.
 * @returns {string}
 */
function marketTitleHint(config) {
  return String(config?.market?.mainWindowTitleContains || 'UB Stock Market').toLowerCase();
}

/**
 * Refreshes aggregate portfolio summary values.
 * @param {any} portfolio Portfolio object.
 */
function refreshPortfolioSummary(portfolio) {
  let moneyInvested = 0;
  let realizedProfit = 0;
  let unrealizedProfit = 0;

  for (const companyName of Object.keys(portfolio.companies || {})) {
    const entry = portfolio.companies[companyName];
    const shares = Number(entry.shares || entry.ownedShares || 0);
    const avgBuy = Number(entry.avgBuy || entry.averageBuyPrice || 0);
    moneyInvested += shares * avgBuy;
    realizedProfit += Number(entry.profit) || 0;
    unrealizedProfit += Number(entry.profit) || 0;
  }

  portfolio.summary.moneyInvested = moneyInvested;
  portfolio.summary.realizedProfit = realizedProfit;
  portfolio.summary.unrealizedProfit = unrealizedProfit;
}

module.exports = {
  syncPortfolioFromServer
};