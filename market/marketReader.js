const {
  debugWindow,
  findItemByDisplayName,
  findItemByLore,
  openStockMarketWindow
} = require('../gui/guiNavigator');
const { getItemDisplayName, getItemLore, parseCompanyPricesFromTickerLore } = require('../utils/parser');

/**
 * Opens stock market GUI and parses ticker/company/balance metadata.
 * @param {import('mineflayer').Bot} bot Mineflayer bot.
 * @param {any} config Runtime configuration.
 * @param {{ info: Function, warn: Function, error: Function, debug: Function }} logger Logger.
 * @returns {Promise<{timestamp:string, companies:Array<{name:string,price:number,investors:number|null,stockPoolFree:number|null}>, balance:number, window:any}>}
 */
async function readMarketSnapshot(bot, config, logger) {
  const window = await openStockMarketWindow(bot, config, logger);
  debugWindow(window, config, logger);

  const tickerItemName = String(config.market.tickerItemName || 'Live Market Ticker');
  const ticker = findItemByDisplayName(window, tickerItemName) || findItemByLore(window, 'All Company Prices');
  const tickerPrices = ticker ? parseCompanyPricesFromTickerLore(getItemLore(ticker.item)) : [];

  const companyCards = parseCompanyCards(window);
  const companies = mergeCompanyData(tickerPrices, companyCards);
  const balance = parseBalanceFromMarketWindow(window);
  const timestamp = new Date().toISOString();

  if (!Number.isFinite(balance)) {
    throw new Error('Balance parsing failed from Stock Market GUI (Balance $value not found).');
  }

  if (companies.length < 7) {
    throw new Error(`Expected 7 companies, parsed ${companies.length}.`);
  }

  logger.info(`Parsed ${companies.length} company prices. Balance=${balance}`);
  if (config.debug?.enabled && config.debug?.logParsedPrices) {
    logger.debug(`Companies parsed: ${JSON.stringify(companies)}`);
  }

  return {
    timestamp,
    companies,
    balance,
    window
  };
}

/**
 * Parses balance value from any GUI item lore containing "Balance".
 * @param {any} window Open market window.
 * @returns {number|null}
 */
function parseBalanceFromMarketWindow(window) {
  const slots = Array.isArray(window?.slots) ? window.slots : [];
  for (const item of slots) {
    if (!item) continue;
    const lore = getItemLore(item);
    for (let i = 0; i < lore.length; i += 1) {
      const line = lore[i];
      if (!/balance/i.test(line)) continue;
      const value = parseCurrency(lore[i + 1] || '');
      if (Number.isFinite(value)) return value;
    }

    const blob = [getItemDisplayName(item), ...lore].join('\n');
    const fallback = parseBalanceFromText(blob);
    if (Number.isFinite(fallback)) return fallback;
  }
  return null;
}

/**
 * Parses structured company cards from the market window.
 * @param {any} window Open market window.
 * @returns {Array<{name:string,price:number,investors:number|null,stockPoolFree:number|null}>}
 */
function parseCompanyCards(window) {
  /** @type {Array<{name:string,price:number,investors:number|null,stockPoolFree:number|null}>} */
  const companies = [];
  const slots = Array.isArray(window?.slots) ? window.slots : [];

  for (const item of slots) {
    if (!item) continue;
    const lore = getItemLore(item);
    if (!lore.length) continue;
    const blob = lore.join('\n');
    if (!/company\s*name/i.test(blob)) continue;

    const companyName = findValueAfterLabel(lore, /company\s*name/i);
    const priceText = findValueAfterLabel(lore, /current\s*price/i);
    const investorsText = findValueAfterLabel(lore, /investors/i);
    const stockPoolFree = parseStockPoolFree(lore);

    const price = parseCurrency(priceText || '');
    if (!companyName || !Number.isFinite(price)) continue;

    const investors = parseInteger(investorsText || '');
    companies.push({
      name: companyName,
      price,
      investors: Number.isFinite(investors) ? investors : null,
      stockPoolFree
    });
  }

  return dedupeCompanies(companies);
}

/**
 * Merges ticker and company-card metadata. Card metadata wins when available.
 * @param {Array<{name:string,price:number}>} tickerPrices Parsed ticker data.
 * @param {Array<{name:string,price:number,investors:number|null,stockPoolFree:number|null}>} cardData Parsed card data.
 * @returns {Array<{name:string,price:number,investors:number|null,stockPoolFree:number|null}>}
 */
function mergeCompanyData(tickerPrices, cardData) {
  if (cardData.length >= 7) {
    return cardData;
  }

  /** @type {Record<string, {name:string,price:number,investors:number|null,stockPoolFree:number|null}>} */
  const map = {};

  for (const company of tickerPrices) {
    map[company.name] = {
      name: company.name,
      price: company.price,
      investors: null,
      stockPoolFree: null
    };
  }

  for (const company of cardData) {
    map[company.name] = {
      name: company.name,
      price: company.price,
      investors: company.investors,
      stockPoolFree: company.stockPoolFree
    };
  }

  return Object.values(map);
}

/**
 * Parses first integer after a labeled line.
 * @param {string[]} lore Lore lines.
 * @param {RegExp} labelPattern Label pattern.
 * @returns {string|null}
 */
function findValueAfterLabel(lore, labelPattern) {
  for (let i = 0; i < lore.length; i += 1) {
    if (!labelPattern.test(lore[i])) continue;
    return lore[i + 1] ?? null;
  }
  return null;
}

/**
 * Parses balance from a large text blob.
 * @param {string} text Input text.
 * @returns {number|null}
 */
function parseBalanceFromText(text) {
  const match = text.match(/balance[\s\S]{0,30}\$?\s*([0-9][0-9,]*)/i);
  if (!match) return null;
  const parsed = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parses currency string like "$100,000".
 * @param {string} text Input text.
 * @returns {number|null}
 */
function parseCurrency(text) {
  const match = String(text).match(/\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/);
  if (!match) return null;
  const parsed = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parses integer from text.
 * @param {string} text Input text.
 * @returns {number|null}
 */
function parseInteger(text) {
  const match = String(text).match(/([0-9][0-9,]*)/);
  if (!match) return null;
  const parsed = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parses free stock pool amount from lore patterns.
 * @param {string[]} lore Lore lines.
 * @returns {number|null}
 */
function parseStockPoolFree(lore) {
  for (let i = 0; i < lore.length; i += 1) {
    if (!/stock\s*pool/i.test(lore[i])) continue;
    for (let j = i + 1; j < Math.min(lore.length, i + 6); j += 1) {
      if (!/free/i.test(lore[j])) continue;
      const parsed = parseInteger(lore[j - 1] || lore[j]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  const blob = lore.join(' ');
  const inline = blob.match(/([0-9][0-9,]*)\s*free/i);
  if (!inline) return null;
  const parsed = Number(inline[1].replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * De-duplicates companies by name.
 * @param {Array<{name:string,price:number,investors:number|null,stockPoolFree:number|null}>} companies Company rows.
 * @returns {Array<{name:string,price:number,investors:number|null,stockPoolFree:number|null}>}
 */
function dedupeCompanies(companies) {
  /** @type {Record<string, {name:string,price:number,investors:number|null,stockPoolFree:number|null}>} */
  const map = {};
  for (const company of companies) {
    map[company.name] = company;
  }
  return Object.values(map);
}

module.exports = {
  readMarketSnapshot
};
