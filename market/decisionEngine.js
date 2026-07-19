function decideTrade(context) {
  const logger = context.logger;
  const trading = context.config.trading || {};
  const buyThreshold = Number(trading.fallbackBuyBelow ?? 900);
  const sellThreshold = Number(trading.fallbackSellAbove ?? 1100);
  const minPrice = Number(trading.marketMinPrice ?? 800);
  const maxPrice = Number(trading.marketMaxPrice ?? 1200);
  const reserveCash = Number(trading.reserveCash ?? 0);
  const maxAllocationPerCompany = Number(trading.maxAllocationPerCompany ?? 0.35);
  const maxSharesPerCompany = Number(trading.maxSharesPerCompany ?? 500);
  const balance = Number(context.snapshot.balance);
  const portfolioValue = getPortfolioValue(context.portfolio, balance);
  const priceHistory = context.priceHistory || {};
  const unavailableBuyCompanyNames = context.unavailableBuyCompanyNames instanceof Set
    ? context.unavailableBuyCompanyNames
    : new Set(context.unavailableBuyCompanyNames || []);

  const priceMap = new Map();
  for (const company of context.snapshot.companies) {
    priceMap.set(company.name, Number(company.price));
  }

  const evaluations = [];
  const sellCandidates = [];
  const buyCandidates = [];

  for (const [companyName, entry] of Object.entries(context.portfolio.companies || {})) {
    const snapshotPrice = Number(priceMap.get(companyName));
    const portfolioPrice = Number(entry.currentPrice ?? entry.price ?? NaN);
    const price = Number.isFinite(snapshotPrice) ? snapshotPrice : portfolioPrice;
    const ownedShares = Number(entry.shares ?? entry.ownedShares ?? 0) || 0;
    const avgBuy = Number(entry.avgBuy ?? entry.averageBuyPrice ?? 0) || 0;
    const invested = Number.isFinite(entry.moneyInvested) && entry.moneyInvested > 0
      ? Number(entry.moneyInvested) : ownedShares * avgBuy;
    const profit = Number(entry.profit ?? 0) || 0;
    const momentum = getPriceMomentum(companyName, price, priceHistory);
    const sellRule = `SELL if price > ${sellThreshold}`;
    const buyRule = `BUY if price < ${buyThreshold}`;

    if (!Number.isFinite(price)) {
      evaluations.push({ companyName, currentPrice: NaN, minPrice, maxPrice, buyRule, sellRule, eligible: 'NO',
        reason: 'Company is owned but missing from the current market snapshot.' });
      continue;
    }

    if (!Number.isFinite(snapshotPrice)) {
      loggerDecisionLine(logger, companyName, ownedShares, price, price > sellThreshold, invested, avgBuy, sellThreshold, buyThreshold, 'PORTFOLIO PRICE FALLBACK');
    }

    if (ownedShares <= 0) {
      loggerDecisionLine(logger, companyName, ownedShares, price, false, invested, avgBuy, sellThreshold, buyThreshold, 'NO SHARES OWNED');
      evaluations.push({ companyName, currentPrice: price, minPrice, maxPrice, buyRule, sellRule, eligible: 'NO',
        reason: 'No shares owned in the synced portfolio.' });
      continue;
    }

    const profitPerShare = price - avgBuy;
    const isProfitable = profitPerShare > 0;
    const aboveSellThreshold = price > sellThreshold;

    if (aboveSellThreshold && isProfitable) {
      loggerDecisionLine(logger, companyName, ownedShares, price, true, invested, avgBuy, sellThreshold, buyThreshold, 'SELL CANDIDATE');
      sellCandidates.push({ name: companyName, price, profit: profitPerShare * ownedShares, ownedShares, momentum, avgBuy });
      evaluations.push({ companyName, currentPrice: price, minPrice, maxPrice, buyRule, sellRule, eligible: 'YES',
        reason: `Price (${price}) exceeds sell threshold (${sellThreshold}) and is above avg buy (${avgBuy}). Profit per share: ${profitPerShare}.` });
    } else if (!aboveSellThreshold) {
      loggerDecisionLine(logger, companyName, ownedShares, price, false, invested, avgBuy, sellThreshold, buyThreshold, 'BELOW SELL THRESHOLD');
      evaluations.push({ companyName, currentPrice: price, minPrice, maxPrice, buyRule, sellRule, eligible: 'NO',
        reason: `Owned ${ownedShares} shares, but price (${price}) is not above sell threshold (${sellThreshold}).` });
    } else {
      loggerDecisionLine(logger, companyName, ownedShares, price, false, invested, avgBuy, sellThreshold, buyThreshold, 'NOT PROFITABLE');
      evaluations.push({ companyName, currentPrice: price, minPrice, maxPrice, buyRule, sellRule, eligible: 'NO',
        reason: `Price (${price}) exceeds sell threshold but is not above avg buy (${avgBuy}). Profit per share: ${profitPerShare}.` });
    }
  }

  const evaluatedInSellLoop = new Set(Object.keys(context.portfolio.companies || {}));

  for (const company of context.snapshot.companies) {
    if (evaluatedInSellLoop.has(company.name)) continue;

    const ownedEntry = context.portfolio.companies?.[company.name] || {};
    const ownedShares = Number(ownedEntry.shares ?? ownedEntry.ownedShares ?? 0) || 0;
    const avgBuy = Number(ownedEntry.avgBuy ?? ownedEntry.averageBuyPrice ?? 0) || 0;
    const moneyInvested = Number.isFinite(ownedEntry.moneyInvested) && Number(ownedEntry.moneyInvested) > 0
      ? Number(ownedEntry.moneyInvested) : ownedShares * avgBuy;
    const price = Number(company.price);
    const buyRule = `BUY if price < ${buyThreshold}`;
    const sellRule = `SELL if price > ${sellThreshold}`;

    if (!Number.isFinite(price)) {
      loggerDecisionLine(logger, company.name, ownedShares, NaN, false, moneyInvested, avgBuy, sellThreshold, buyThreshold, 'PRICE NOT NUMERIC');
      evaluations.push({ companyName: company.name, currentPrice: NaN, minPrice, maxPrice, buyRule, sellRule, eligible: 'NO', reason: 'Price is not numeric.' });
      continue;
    }

    const availableShares = Number(company.stockPoolFree);
    if (unavailableBuyCompanyNames.has(company.name) ||
      (Number.isFinite(availableShares) && availableShares <= 0)) {
      loggerDecisionLine(logger, company.name, ownedShares, price, false, moneyInvested, avgBuy, sellThreshold, buyThreshold, 'NO STOCK AVAILABLE');
      evaluations.push({ companyName: company.name, currentPrice: price, minPrice, maxPrice, buyRule, sellRule, eligible: 'NO',
        reason: 'No shares are currently available in this company stock pool.' });
      continue;
    }

    if (price >= buyThreshold) {
      loggerDecisionLine(logger, company.name, ownedShares, price, false, moneyInvested, avgBuy, sellThreshold, buyThreshold, 'ABOVE BUY THRESHOLD');
      evaluations.push({ companyName: company.name, currentPrice: price, minPrice, maxPrice, buyRule, sellRule, eligible: 'NO', reason: 'Price is not below buy threshold.' });
      continue;
    }

    if (!Number.isFinite(balance) || balance <= price + reserveCash) {
      loggerDecisionLine(logger, company.name, ownedShares, price, false, moneyInvested, avgBuy, sellThreshold, buyThreshold, 'INSUFFICIENT BALANCE');
      evaluations.push({ companyName: company.name, currentPrice: price, minPrice, maxPrice, buyRule, sellRule, eligible: 'NO',
        reason: `Price is below buy threshold, but balance ${balance} is not greater than price ${price}.` });
      continue;
    }

    if (ownedShares >= maxSharesPerCompany) {
      loggerDecisionLine(logger, company.name, ownedShares, price, false, moneyInvested, avgBuy, sellThreshold, buyThreshold, 'MAX SHARES REACHED');
      evaluations.push({ companyName: company.name, currentPrice: price, minPrice, maxPrice, buyRule, sellRule, eligible: 'NO',
        reason: `Maximum shares per company reached (${ownedShares}/${maxSharesPerCompany}).` });
      continue;
    }

    const allocationLimit = Number.isFinite(portfolioValue) ? portfolioValue * maxAllocationPerCompany : Infinity;
    const allocationRemaining = allocationLimit - moneyInvested;
    if (moneyInvested > 0 && allocationRemaining <= price) {
      loggerDecisionLine(logger, company.name, ownedShares, price, false, moneyInvested, avgBuy, sellThreshold, buyThreshold, 'ALLOCATION LIMIT');
      evaluations.push({ companyName: company.name, currentPrice: price, minPrice, maxPrice, buyRule, sellRule, eligible: 'NO',
        reason: `Company allocation limit reached. Invested=${moneyInvested} limit=${allocationLimit}.` });
      continue;
    }

    loggerDecisionLine(logger, company.name, ownedShares, price, false, moneyInvested, avgBuy, sellThreshold, buyThreshold, 'BUY CANDIDATE');
    buyCandidates.push({ name: company.name, price, investors: company.investors, stockPoolFree: company.stockPoolFree, ownedShares });
    evaluations.push({ companyName: company.name, currentPrice: price, minPrice, maxPrice, buyRule, sellRule, eligible: 'YES',
      reason: `Price is below buy threshold and distance from minimum is ${price - minPrice}.` });
  }

  if (sellCandidates.length > 0) {
    const selected = rankSellCandidates(sellCandidates)[0];
    return { action: 'sell', companyName: selected.name, price: selected.price,
      reason: `Sell threshold matched. Selected highest-price/highest-profit candidate at ${selected.price}.`, evaluations };
  }

  if (buyCandidates.length > 0) {
    const selected = rankBuyCandidates(buyCandidates)[0];
    return { action: 'buy', companyName: selected.name, price: selected.price,
      reason: `Buy threshold matched. Selected lowest-price candidate at ${selected.price}.`, evaluations };
  }

  return { action: 'hold', reason: 'No fallback buy/sell conditions were met.', evaluations };
}

function getPortfolioValue(portfolio, balance) {
  const summary = portfolio?.summary || {};
  const invested = Number(summary.moneyInvested ?? 0) || 0;
  const unrealized = Number(summary.unrealizedProfit ?? 0) || 0;
  if (Number.isFinite(balance)) return balance + invested + unrealized;
  return invested + unrealized;
}

function loggerDecisionLine(logger, companyName, shares, price, sell, invested, avgBuy, sellThreshold, buyThreshold, note) {
  if (logger && typeof logger.info === 'function') {
    logger.info(`Eval ${companyName}: price=${price} avgBuy=${avgBuy} owned=${shares} sell=${sell} ${note}`);
  } else {
    console.log(`[SELL EVAL] ${companyName} price=${price} avgBuy=${avgBuy} owned=${shares} sell=${sell} ${note}`);
  }
}

function rankBuyCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    if (a.price !== b.price) return a.price - b.price;
    const poolA = Number.isFinite(a.stockPoolFree) ? a.stockPoolFree : -1;
    const poolB = Number.isFinite(b.stockPoolFree) ? b.stockPoolFree : -1;
    if (poolA !== poolB) return poolB - poolA;
    const investorsA = Number.isFinite(a.investors) ? a.investors : Number.MAX_SAFE_INTEGER;
    const investorsB = Number.isFinite(b.investors) ? b.investors : Number.MAX_SAFE_INTEGER;
    if (investorsA !== investorsB) return investorsA - investorsB;
    return String(a.name).localeCompare(String(b.name));
  });
}

function rankSellCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    if (a.momentum !== b.momentum) return b.momentum - a.momentum;
    if (a.price !== b.price) return b.price - a.price;
    if (a.profit !== b.profit) return b.profit - a.profit;
    return String(a.name).localeCompare(String(b.name));
  });
}

function getPriceMomentum(companyName, currentPrice, priceHistory) {
  const historicalPrices = priceHistory?.companies?.[companyName]?.historicalPrices;
  if (!Array.isArray(historicalPrices) || historicalPrices.length < 2) return 0;
  const lastPoint = historicalPrices[historicalPrices.length - 1];
  const previousPoint = historicalPrices[historicalPrices.length - 2];
  const lastPrice = Number(lastPoint?.price);
  const previousPrice = Number(previousPoint?.price);
  if (!Number.isFinite(lastPrice) || !Number.isFinite(previousPrice)) return 0;
  const latestObservedPrice = Number.isFinite(currentPrice) ? currentPrice : lastPrice;
  return latestObservedPrice - previousPrice;
}

module.exports = { decideTrade };
