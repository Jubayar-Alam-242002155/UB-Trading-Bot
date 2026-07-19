const fs = require('node:fs/promises');
const path = require('node:path');
const util = require('node:util');
const { getItemDisplayName, getItemLore, getWindowTitle } = require('./utils/parser');

const DEBUG_DIR = path.join(__dirname, 'debug');

/**
 * Attaches GUI inspection handlers for reverse engineering server inventories.
 * @param {import('mineflayer').Bot} bot Mineflayer bot instance.
 * @param {{ info: Function, warn: Function, error: Function, debug?: Function }} logger Application logger.
 */
function initializeInventoryModule(bot, logger) {
  bot.on('windowOpen', async (window) => {
    try {
      const title = getWindowTitle(window) || 'unknown';
      const windowId = window?.id ?? window?.windowId ?? 'unknown';
      const windowType = window?.type ?? window?.inventoryType ?? 'unknown';
      const slots = Array.isArray(window?.slots) ? window.slots : [];

      logger.info(`[GUI] ${title} (${slots.length} slots)`);

      /** @type {Array<Record<string, unknown>>} */
      const occupiedSlots = [];

      for (let index = 0; index < slots.length; index += 1) {
        const item = slots[index];
        if (!item) continue;

        const displayName = getItemDisplayName(item) || item?.name || 'unknown';
        const lore = getItemLore(item);

        logger.debug(
          `[GUI][SLOT ${index}] name=${String(item?.name ?? 'unknown')} displayName=${displayName} lore=${JSON.stringify(lore)}`
        );

        occupiedSlots.push({
          slot: index,
          name: item?.name ?? null,
          displayName,
          lore,
          nbt: normalizeForJson(item?.nbt ?? null),
          components: normalizeForJson(item?.components ?? item?.itemComponents ?? null),
          metadata: normalizeForJson(item?.metadata ?? null),
          rawItem: normalizeForJson(item),
          rawItemInspect: util.inspect(item, {
            depth: null,
            colors: false,
            compact: false,
            maxArrayLength: null,
            breakLength: Infinity
          })
        });
      }

      await writeWindowDebugFile({
        capturedAt: new Date().toISOString(),
        title,
        windowType,
        windowId,
        slotCount: slots.length,
        occupiedSlots
      });
    } catch (error) {
      logger.error(`[GUI] Failed to inspect window: ${error.message}`);
    }
  });
}

/**
 * Writes a full window snapshot to debug/window_TIMESTAMP.json.
 * @param {Record<string, unknown>} snapshot Window snapshot.
 */
async function writeWindowDebugFile(snapshot) {
  await fs.mkdir(DEBUG_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(DEBUG_DIR, `window_${timestamp}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

/**
 * Converts complex objects to safe JSON-compatible values without truncation.
 * @param {unknown} value Any input value.
 * @param {WeakSet<object>} [seen] Circular-reference tracker.
 * @returns {unknown}
 */
function normalizeForJson(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (Buffer.isBuffer(value)) return { type: 'Buffer', base64: value.toString('base64') };
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForJson(entry, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(/** @type {object} */ (value))) {
      return '[Circular]';
    }
    seen.add(/** @type {object} */ (value));

    /** @type {Record<string, unknown>} */
    const output = {};
    for (const key of Object.keys(/** @type {Record<string, unknown>} */ (value))) {
      output[key] = normalizeForJson(
        /** @type {Record<string, unknown>} */ (value)[key],
        seen
      );
    }
    return output;
  }

  return String(value);
}

module.exports = { initializeInventoryModule };
