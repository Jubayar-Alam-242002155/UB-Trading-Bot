const fs = require('node:fs/promises');
const path = require('node:path');

const STORAGE_DIR = process.env.BOT_STORAGE_DIR
  ? path.resolve(process.env.BOT_STORAGE_DIR)
  : path.join(__dirname, '..', 'storage');
const STORAGE_FILE = path.join(STORAGE_DIR, 'portfolio.json');
const portfolioState = createEmptyPortfolio();
let portfolioLoaded = false;

async function loadPortfolio() {
  if (portfolioLoaded) return portfolioState;
  try {
    const raw = await fs.readFile(STORAGE_FILE, 'utf8');
    applyNormalizedPortfolio(portfolioState, normalizePortfolio(JSON.parse(raw)));
    portfolioLoaded = true;
    return portfolioState;
  } catch (error) {
    if (error.code === 'ENOENT') {
      const seed = createEmptyPortfolio();
      applyNormalizedPortfolio(portfolioState, seed);
      portfolioLoaded = true;
      await savePortfolio(portfolioState);
      return portfolioState;
    }
    throw error;
  }
}

async function savePortfolio(portfolio) {
  const normalized = normalizePortfolio(portfolio);
  applyNormalizedPortfolio(portfolioState, normalized);
  portfolioLoaded = true;
  await fs.mkdir(path.dirname(STORAGE_FILE), { recursive: true });
  await fs.writeFile(STORAGE_FILE, JSON.stringify(portfolioState, null, 2) + '\n', 'utf8');
  return portfolioState;
}

function ensureCompany(portfolio, companyName) {
  if (!portfolio.companies[companyName]) {
    portfolio.companies[companyName] = {
      company: companyName, shares: 0, ownedShares: 0,
      avgBuy: 0, averageBuyPrice: 0, currentPrice: 0,
      grossValue: 0, netValue: 0, profit: 0, status: '',
      currentValue: 0, moneyInvested: 0, availableShares: null,
      realizedProfit: 0, unrealizedProfit: 0, totalTransactions: 0,
      lastBuyAt: null, lastSellAt: null, lastSynchronizationTime: null
    };
  }
  portfolio.companies[companyName].company = companyName;
  return portfolio.companies[companyName];
}

function applyBuy(portfolio, trade) {
  const entry = ensureCompany(portfolio, trade.companyName);
  const quantity = Math.max(0, Math.floor(trade.quantity));
  if (quantity <= 0) return;
  const cost = quantity * trade.price;
  const totalSharesAfter = entry.ownedShares + quantity;
  if (totalSharesAfter > 0) {
    const weightedCost = entry.averageBuyPrice * entry.ownedShares + cost;
    entry.averageBuyPrice = weightedCost / totalSharesAfter;
  }
  entry.ownedShares = totalSharesAfter;
  entry.shares = totalSharesAfter;
  entry.avgBuy = entry.averageBuyPrice;
  entry.moneyInvested += cost;
  entry.totalTransactions += 1;
  entry.lastBuyAt = trade.timestamp;
}

function applySell(portfolio, trade) {
  const entry = ensureCompany(portfolio, trade.companyName);
  const quantity = Math.max(0, Math.floor(trade.quantity));
  if (quantity <= 0) return;
  if (entry.ownedShares <= 0) return;
  const actualQuantity = Math.min(quantity, entry.ownedShares);
  const costBasis = actualQuantity * entry.averageBuyPrice;
  const revenue = actualQuantity * trade.price;
  const profit = revenue - costBasis;
  entry.ownedShares -= actualQuantity;
  entry.shares = entry.ownedShares;
  entry.moneyInvested = Math.max(0, entry.moneyInvested - costBasis);
  entry.realizedProfit += profit;
  entry.totalTransactions += 1;
  entry.lastSellAt = trade.timestamp;
  if (entry.ownedShares === 0) {
    entry.averageBuyPrice = 0;
    entry.avgBuy = 0;
  }
}

function normalizePortfolio(portfolio) {
  const source = portfolio && typeof portfolio === 'object' ? portfolio : {};
  const normalized = {
    companies: {},
    summary: {
      moneyInvested: 0, realizedProfit: 0, unrealizedProfit: 0,
      lastSynchronizationTime: null,
      ...(source.summary && typeof source.summary === 'object' ? source.summary : {})
    }
  };
  const sourceCompanies = source.companies && typeof source.companies === 'object' ? source.companies : {};
  for (const companyName of Object.keys(sourceCompanies)) {
    const entry = sourceCompanies[companyName] && typeof sourceCompanies[companyName] === 'object'
      ? sourceCompanies[companyName] : {};
    const shares = Number(entry.shares ?? entry.ownedShares) || 0;
    const avgBuy = Number(entry.avgBuy ?? entry.averageBuyPrice) || 0;
    const moneyInvested = Number(entry.moneyInvested);
    normalized.companies[companyName] = {
      company: String(entry.company || companyName),
      shares, ownedShares: shares,
      avgBuy, averageBuyPrice: avgBuy,
      currentPrice: Number(entry.currentPrice) || 0,
      grossValue: Number(entry.grossValue ?? entry.currentValue) || 0,
      netValue: Number(entry.netValue ?? entry.currentValue) || 0,
      profit: Number(entry.profit ?? entry.realizedProfit ?? 0) || 0,
      currentValue: Number(entry.currentValue ?? entry.grossValue ?? 0) || 0,
      status: String(entry.status ?? ''),
      moneyInvested: Number.isFinite(moneyInvested) && moneyInvested > 0 ? moneyInvested : shares * avgBuy,
      availableShares:
        entry.availableShares === null || entry.availableShares === undefined
          ? null : Number(entry.availableShares) || 0,
      realizedProfit: Number(entry.realizedProfit) || 0,
      unrealizedProfit: Number(entry.unrealizedProfit) || 0,
      totalTransactions: Number(entry.totalTransactions) || 0,
      lastBuyAt: entry.lastBuyAt ?? null,
      lastSellAt: entry.lastSellAt ?? null,
      lastSynchronizationTime: entry.lastSynchronizationTime ?? null
    };
  }
  return normalized;
}

function recalculateUnrealized(portfolio, currentPrices) {
  let totalInvested = 0;
  let totalRealized = 0;
  let totalUnrealized = 0;
  for (const companyName of Object.keys(portfolio.companies)) {
    const entry = portfolio.companies[companyName];
    const currentPrice = currentPrices[companyName];
    const unrealized =
      Number.isFinite(currentPrice) && Number(entry.shares || entry.ownedShares) > 0
        ? Number(entry.shares || entry.ownedShares) * (currentPrice - Number(entry.avgBuy || entry.averageBuyPrice || 0))
        : 0;
    entry.unrealizedProfit = unrealized;
    entry.shares = Number(entry.shares ?? entry.ownedShares) || 0;
    entry.ownedShares = entry.shares;
    entry.avgBuy = Number(entry.avgBuy ?? entry.averageBuyPrice) || 0;
    entry.averageBuyPrice = entry.avgBuy;
    totalInvested += Number.isFinite(entry.moneyInvested) && entry.moneyInvested > 0
      ? entry.moneyInvested : entry.shares * entry.avgBuy;
    totalRealized += entry.realizedProfit;
    totalUnrealized += unrealized;
  }
  portfolio.summary.moneyInvested = totalInvested;
  portfolio.summary.realizedProfit = totalRealized;
  portfolio.summary.unrealizedProfit = totalUnrealized;
}

function createEmptyPortfolio() {
  return {
    companies: {},
    summary: {
      moneyInvested: 0, realizedProfit: 0, unrealizedProfit: 0,
      lastSynchronizationTime: null
    }
  };
}

function applyNormalizedPortfolio(target, normalized) {
  const next = normalized && typeof normalized === 'object' ? normalized : createEmptyPortfolio();
  const targetCompanies = target.companies && typeof target.companies === 'object' ? target.companies : (target.companies = {});
  for (const key of Object.keys(targetCompanies)) delete targetCompanies[key];
  const sourceCompanies = next.companies && typeof next.companies === 'object' ? next.companies : {};
  for (const companyName of Object.keys(sourceCompanies)) targetCompanies[companyName] = sourceCompanies[companyName];
  const targetSummary = target.summary && typeof target.summary === 'object' ? target.summary : (target.summary = {});
  const sourceSummary = next.summary && typeof next.summary === 'object' ? next.summary : {};
  for (const key of Object.keys(targetSummary)) delete targetSummary[key];
  for (const key of Object.keys(sourceSummary)) targetSummary[key] = sourceSummary[key];
}

module.exports = {
  loadPortfolio, savePortfolio, ensureCompany,
  applyBuy, applySell, recalculateUnrealized,
  normalizePortfolio, createEmptyPortfolio
};
