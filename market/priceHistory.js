const fs = require('node:fs/promises');
const path = require('node:path');

const STORAGE_DIR = process.env.BOT_STORAGE_DIR
  ? path.resolve(process.env.BOT_STORAGE_DIR)
  : path.join(__dirname, '..', 'storage');
const STORAGE_FILE = path.join(STORAGE_DIR, 'prices.json');

async function loadPriceHistory() {
  try {
    const raw = await fs.readFile(STORAGE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') {
      const seed = createEmptyPriceStore();
      await savePriceHistory(seed);
      return seed;
    }
    throw error;
  }
}

async function savePriceHistory(store) {
  await fs.mkdir(path.dirname(STORAGE_FILE), { recursive: true });
  await fs.writeFile(STORAGE_FILE, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

async function appendMarketSnapshot(snapshot, rollingWindowSize) {
  const store = await loadPriceHistory();
  const now = snapshot.timestamp;
  for (const company of snapshot.companies) {
    if (!store.companies[company.name]) {
      store.companies[company.name] = {
        currentPrice: company.price,
        lastUpdateTime: now,
        lowestSeen: company.price,
        highestSeen: company.price,
        movingAverage: company.price,
        historicalPrices: []
      };
    }
    const entry = store.companies[company.name];
    entry.currentPrice = company.price;
    entry.lastUpdateTime = now;
    entry.lowestSeen = Math.min(entry.lowestSeen, company.price);
    entry.highestSeen = Math.max(entry.highestSeen, company.price);
    entry.historicalPrices.push({ timestamp: now, price: company.price });
    entry.historicalPrices = trimHistory(entry.historicalPrices, rollingWindowSize);
    entry.movingAverage = average(entry.historicalPrices.map((point) => point.price));
  }
  store.lastMarketSnapshotAt = now;
  await savePriceHistory(store);
  return store;
}

function createEmptyPriceStore() {
  return { lastMarketSnapshotAt: null, companies: {} };
}

function trimHistory(history, maxPoints) {
  const max = Math.max(10, Number(maxPoints) || 30);
  if (history.length <= max) return history;
  return history.slice(history.length - max);
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

module.exports = { loadPriceHistory, savePriceHistory, appendMarketSnapshot };
