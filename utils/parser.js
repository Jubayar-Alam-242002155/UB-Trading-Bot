/**
 * Removes Minecraft formatting codes from strings.
 * @param {string} text Raw text with formatting.
 * @returns {string}
 */
function stripFormatting(text) {
  return String(text ?? '').replace(/§[0-9A-FK-OR]/gi, '');
}

/**
 * Attempts to parse text from JSON-string payloads.
 * @param {unknown} value Any value.
 * @returns {unknown}
 */
function tryParseJsonString(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    return value;
  }
}

/**
 * Recursively extracts text fragments from modern/legacy chat-component-like objects.
 * @param {unknown} value Any source value.
 * @param {number} depth Recursion depth.
 * @returns {string[]}
 */
function extractTextParts(value, depth = 0) {
  if (depth > 20) return [];
  if (value === null || value === undefined) return [];

  const parsed = tryParseJsonString(value);
  if (typeof parsed === 'string') {
    const text = stripFormatting(parsed).trim();
    return text ? [text] : [];
  }

  if (typeof parsed === 'number' || typeof parsed === 'boolean') {
    return [String(parsed)];
  }

  if (Array.isArray(parsed)) {
    /** @type {string[]} */
    const lines = [];
    for (const entry of parsed) {
      lines.push(...extractTextParts(entry, depth + 1));
    }
    return lines;
  }

  if (typeof parsed !== 'object') return [];

  const obj = /** @type {Record<string, unknown>} */ (parsed);
  /** @type {string[]} */
  const lines = [];

  const directTextKeys = [
    'text',
    'translate',
    'fallback',
    'name',
    'value',
    'string',
    'content',
    'contents',
    'displayName',
    'customName',
    'title'
  ];

  for (const key of directTextKeys) {
    if (key in obj) {
      lines.push(...extractTextParts(obj[key], depth + 1));
    }
  }

  const nestedKeys = [
    'extra',
    'with',
    'children',
    'hoverEvent',
    'show_text',
    'component',
    'components',
    'itemComponents',
    'metadata',
    'lore',
    'customLore',
    'display',
    'nbt'
  ];

  for (const key of nestedKeys) {
    if (key in obj) {
      lines.push(...extractTextParts(obj[key], depth + 1));
    }
  }

  if (obj.type && obj.value && !lines.length) {
    lines.push(...extractTextParts(obj.value, depth + 1));
  }

  return compactLines(lines);
}

/**
 * Converts any supported text source to plain text.
 * @param {unknown} value Any text source.
 * @returns {string}
 */
function toPlainText(value) {
  const parts = dedupeAndCompact(extractTextParts(value));
  return parts.join(' ').trim();
}

/**
 * Returns display name from custom/legacy item metadata.
 * @param {any} item Inventory item.
 * @returns {string}
 */
function getItemDisplayName(item) {
  const candidates = [
    item?.displayName,
    item?.customName,
    item?.name,
    item?.metadata?.displayName,
    item?.metadata?.customName,
    item?.metadata?.name,
    item?.components?.['minecraft:custom_name'],
    item?.itemComponents?.['minecraft:custom_name'],
    item?.components?.custom_name,
    item?.itemComponents?.custom_name,
    item?.components?.name,
    item?.itemComponents?.name,
    item?.nbt?.display?.Name,
    item?.nbt?.display?.name,
    item?.nbt?.value?.display?.value?.Name,
    item?.nbt?.value?.display?.value?.name,
    item?.extra
  ];

  for (const candidate of candidates) {
    const parsed = toPlainText(candidate);
    if (parsed) return parsed;
  }

  return '';
}

/**
 * Returns lore lines from all likely metadata locations.
 * @param {any} item Inventory item.
 * @returns {string[]}
 */
function getItemLore(item) {
  const candidates = [
    item?.lore,
    item?.customLore,
    item?.metadata?.lore,
    item?.metadata?.customLore,
    item?.metadata?.components?.lore,
    item?.metadata?.itemComponents?.lore,
    item?.components?.lore,
    item?.components?.['minecraft:lore'],
    item?.itemComponents?.lore,
    item?.itemComponents?.['minecraft:lore'],
    item?.nbt?.display?.Lore,
    item?.nbt?.value?.display?.value?.Lore?.value?.value,
    item?.nbt?.value?.display?.value?.Lore,
    item?.nbt?.value?.display?.Lore
  ];

  /** @type {string[]} */
  const lines = [];
  for (const candidate of candidates) {
    const extracted = extractTextParts(candidate);
    lines.push(...extracted);
  }

  return compactLines(lines);
}

/**
 * Normalizes window title to readable text.
 * @param {any} window Window payload.
 * @returns {string}
 */
function getWindowTitle(window) {
  const candidates = [
    window?.title,
    window?.windowTitle,
    window?.name,
    window?.inventoryTitle,
    window?.metadata?.title
  ];
  for (const candidate of candidates) {
    const parsed = toPlainText(candidate);
    if (parsed) return parsed;
  }
  return '';
}

/**
 * Parses company price entries from ticker lore.
 * @param {string[]} loreLines Lore lines from ticker item.
 * @returns {Array<{name: string, price: number}>}
 */
function parseCompanyPricesFromTickerLore(loreLines) {
  /** @type {Array<{name: string, price: number}>} */
  const pairs = [];
  const normalizedLines = compactLines(loreLines.map((line) => toPlainText(line)));
  let pendingCompany = '';

  for (const line of normalizedLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (isArrowLine(trimmed)) {
      continue;
    }

    const priceMatch = trimmed.match(/\$?\s*([0-9][0-9,]*)/);
    if (priceMatch && pendingCompany) {
      const price = Number(priceMatch[1].replace(/,/g, ''));
      if (Number.isFinite(price)) {
        pairs.push({ name: pendingCompany, price });
      }
      pendingCompany = '';
      continue;
    }

    if (looksLikeCompanyName(trimmed)) {
      pendingCompany = trimmed;
    }
  }
  return dedupeCompanyPairs(pairs);
}

/**
 * Attempts to parse account balance from scoreboard lines.
 * @param {import('mineflayer').Bot} bot Mineflayer bot.
 * @returns {number|null}
 */
function parseBalanceFromScoreboard(bot) {
  const candidates = [];

  const sidebarItems = bot?.scoreboard?.sidebar?.items;
  if (Array.isArray(sidebarItems)) {
    for (const item of sidebarItems) {
      candidates.push(
        toPlainText(item?.displayName ?? item?.name ?? item?.value ?? item?.text ?? '')
      );
    }
  }

  const scoreboards = bot?.scoreboards;
  if (scoreboards && typeof scoreboards === 'object') {
    for (const key of Object.keys(scoreboards)) {
      const board = scoreboards[key];
      const items = board?.items;
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        candidates.push(
          toPlainText(item?.displayName ?? item?.name ?? item?.value ?? item?.text ?? '')
        );
      }
    }
  }

  for (const line of candidates) {
    if (!/balance/i.test(line)) continue;
    const match = line.match(/([0-9][0-9,]*)/);
    if (!match) continue;
    const value = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Tries to parse owned shares count for a company from any visible lore lines.
 * @param {import('prismarine-windows').Window | any} window Open window.
 * @param {string} companyName Company name.
 * @returns {number|null}
 */
function parseOwnedSharesFromWindow(window, companyName) {
  const slots = Array.isArray(window?.slots) ? window.slots : [];
  const companyPattern = companyName.toLowerCase();
  for (const item of slots) {
    if (!item) continue;
    const display = getItemDisplayName(item).toLowerCase();
    const lore = getItemLore(item);
    const blob = `${display}\n${lore.join('\n')}`.toLowerCase();
    if (!blob.includes(companyPattern)) continue;

    const sharesMatch = blob.match(/(?:owned\s*shares|shares\s*owned|you\s*own)\D*([0-9][0-9,]*)/i);
    if (!sharesMatch) continue;
    const parsed = Number(sharesMatch[1].replace(/,/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Compacts and de-duplicates text lines.
 * @param {string[]} lines Text lines.
 * @returns {string[]}
 */
function dedupeAndCompact(lines) {
  const compact = compactLines(lines);
  const seen = new Set();
  const result = [];
  for (const line of compact) {
    if (seen.has(line)) continue;
    seen.add(line);
    result.push(line);
  }
  return result;
}

/**
 * Compacts text lines while keeping order and duplicates.
 * @param {string[]} lines Text lines.
 * @returns {string[]}
 */
function compactLines(lines) {
  /** @type {string[]} */
  const result = [];
  for (const line of lines) {
    const normalized = stripFormatting(String(line ?? ''))
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) continue;
    result.push(normalized);
  }
  return result;
}

/**
 * Checks whether a line appears to be a company name line.
 * @param {string} line Candidate line.
 * @returns {boolean}
 */
function looksLikeCompanyName(line) {
  if (!/[a-z]/i.test(line)) return false;
  if (line.includes('$')) return false;

  const blocked = [
    'active players',
    'updates every',
    'base price',
    'all company prices',
    'portfolio',
    'balance',
    'total positions',
    'click to'
  ];
  const lower = line.toLowerCase();
  if (/^\d+\s*min$/i.test(lower)) return false;
  if (/^(up|down)$/i.test(lower)) return false;
  return !blocked.some((term) => lower.includes(term));
}

/**
 * Checks if a line is only directional arrow/symbol noise.
 * @param {string} line Line text.
 * @returns {boolean}
 */
function isArrowLine(line) {
  return /^[▲▼△▽⬆⬇↑↓]+$/.test(line.trim());
}

/**
 * De-duplicates company pairs by name while preserving latest price.
 * @param {Array<{name:string,price:number}>} entries Company price entries.
 * @returns {Array<{name:string,price:number}>}
 */
function dedupeCompanyPairs(entries) {
  /** @type {Record<string, number>} */
  const map = {};
  for (const entry of entries) {
    map[entry.name] = entry.price;
  }
  return Object.keys(map).map((name) => ({ name, price: map[name] }));
}

module.exports = {
  stripFormatting,
  toPlainText,
  getItemDisplayName,
  getItemLore,
  getWindowTitle,
  parseCompanyPricesFromTickerLore,
  parseBalanceFromScoreboard,
  parseOwnedSharesFromWindow
};
