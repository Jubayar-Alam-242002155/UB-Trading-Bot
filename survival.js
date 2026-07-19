const { sleep, randomIntInclusive } = require('./utils/delay');

/**
 * Starts the hunger/survival monitor for one bot session.
 * @param {import('mineflayer').Bot} bot Mineflayer bot instance.
 * @param {any} config Runtime configuration.
 * @param {{ info: Function, warn: Function, error: Function, debug?: Function }} rootLogger Root logger.
 * @returns {{start: () => void, stop: () => void, isHungry: () => boolean}}
 */
function initializeSurvivalModule(bot, config, rootLogger) {
  const logger = rootLogger;
  const lowHungerThreshold = Number(config?.survival?.lowHungerThreshold ?? 14);
  const targetHunger = Number(config?.survival?.targetHunger ?? 18);
  const hungerCheckIntervalMs = Number(config?.survival?.checkIntervalMs ?? 2000);
  const inventoryReadyTimeoutMs = Number(config?.survival?.inventoryReadyTimeoutMs ?? 10000);

  let running = false;
  let stopped = false;
  let loopPromise = null;
  let foodRequestCooldownUntil = 0;
  let nextFoodRequestAt = 0;
  let lastRequestSentAt = 0;
  let inventoryReady = hasInventoryContents(bot);
  let inventoryReadyPromise = null;

  function start() {
    if (running) return;
    stopped = false;
    running = true;
    loopPromise = runLoop().catch((error) => {
      logger.error(`Survival loop stopped with error: ${error.message}`);
    });
  }

  function stop() {
    stopped = true;
    running = false;
  }

  function isHungry() {
    return Number(bot.food) < lowHungerThreshold;
  }

  async function runLoop() {
    while (!stopped) {
      try {
        await maintainHunger();
      } catch (error) {
        logger.error(`Hunger monitor failed: ${error.message}`);
      }
      await sleep(hungerCheckIntervalMs);
    }
  }

  async function maintainHunger() {
    const currentHunger = Number(bot.food);
    if (!Number.isFinite(currentHunger)) return;

    if (!inventoryReady) {
      inventoryReady = await waitForInventoryReady();
      if (!inventoryReady) return;
    }

    if (bot.currentWindow) {
      return;
    }

    if (currentHunger >= lowHungerThreshold) {
      if (foodRequestCooldownUntil !== 0 || nextFoodRequestAt !== 0) {
        foodRequestCooldownUntil = 0;
        nextFoodRequestAt = 0;
      }
      return;
    }

    logger.info(`Current Hunger: ${currentHunger}`);

    const food = findBestFoodItem(bot);
    if (!food) {
      await requestFoodIfNeeded(currentHunger);
      return;
    }

    foodRequestCooldownUntil = 0;
    nextFoodRequestAt = 0;

    logger.info('Food found.');
    logger.info(`Food Selected: ${food.name} (slot ${food.slot})`);
    logger.info('Eating...');
    const previousHeldItem = bot.heldItem || null;
    try {
      if (!isHotbarSlot(food.slot)) {
        logger.info('Food moved to hotbar.');
      }

      await bot.equip(food, 'hand');
      logger.info('Equipped.');
      await consumeUntilSatisfied(targetHunger);

      if (previousHeldItem) {
        await bot.equip(previousHeldItem, 'hand');
      }

      logger.info('Finished.');
    } catch (error) {
      logger.warn(`Eating attempt failed: ${error.message}`);
      if (previousHeldItem) {
        try {
          await bot.equip(previousHeldItem, 'hand');
        } catch (restoreError) {
          logger.warn(`Failed to restore previous held item: ${restoreError.message}`);
        }
      }
    }
  }

  async function requestFoodIfNeeded(currentHunger) {
    const now = Date.now();
    if (now < foodRequestCooldownUntil) return;
    if (nextFoodRequestAt !== 0 && now < nextFoodRequestAt) return;

    if (now - lastRequestSentAt < 60000) {
      nextFoodRequestAt = lastRequestSentAt + 60000;
      return;
    }

    bot.chat('I need food.');
    logger.warn('No edible food found.');
    logger.warn('Requested food from chat.');

    lastRequestSentAt = now;
    foodRequestCooldownUntil = now + 60000;
    nextFoodRequestAt = now + randomIntInclusive(60000, 120000);
  }

  async function consumeUntilSatisfied(threshold) {
    while (!stopped && Number(bot.food) < threshold) {
      const activeFood = findBestFoodItem(bot);
      if (!activeFood) {
        await requestFoodIfNeeded(Number(bot.food));
        return;
      }

      await bot.equip(activeFood, 'hand');
      await bot.consume();
      await waitForHungerRecovery(threshold, 8000);
      logger.info(`Current Hunger: ${Number(bot.food)}`);
      if (Number(bot.food) >= threshold) return;
    }
  }

  async function waitForHungerRecovery(threshold, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (Number(bot.food) >= threshold) return;
      await sleep(200);
    }
  }

  async function waitForInventoryReady() {
    if (hasInventoryContents(bot)) return true;
    if (!inventoryReadyPromise) {
      inventoryReadyPromise = new Promise((resolve) => {
        const startedAt = Date.now();

        const cleanup = (value) => {
          clearInterval(interval);
          clearTimeout(timer);
          bot.removeListener('inventoryUpdate', onInventoryUpdate);
          inventoryReadyPromise = null;
          inventoryReady = value;
          resolve(value);
        };

        const onInventoryUpdate = () => {
          cleanup(true);
        };

        const interval = setInterval(() => {
          if (hasInventoryContents(bot)) {
            cleanup(true);
            return;
          }
          if (Date.now() - startedAt >= inventoryReadyTimeoutMs) {
            cleanup(false);
          }
        }, 200);

        const timer = setTimeout(() => cleanup(hasInventoryContents(bot)), inventoryReadyTimeoutMs);
        bot.on('inventoryUpdate', onInventoryUpdate);

        if (hasInventoryContents(bot)) {
          cleanup(true);
        }
      });
    }

    return inventoryReadyPromise;
  }

  return {
    start,
    stop,
    isHungry
  };
}

/**
 * Finds the best edible item, preferring hotbar slots first.
 * @param {import('mineflayer').Bot} bot Mineflayer bot instance.
 * @returns {any|null}
 */
function findBestFoodItem(bot) {
  const items = Array.isArray(bot?.inventory?.items?.()) ? bot.inventory.items() : [];
  const edible = items.filter((item) => isEdibleItem(bot, item));
  if (edible.length === 0) return null;

  const hotbarItems = edible.filter((item) => isHotbarSlot(item?.slot));
  const inventoryItems = edible.filter((item) => !isHotbarSlot(item?.slot));
  const ordered = [...hotbarItems, ...inventoryItems];
  ordered.sort((a, b) => {
    const foodA = getFoodPoints(bot, a);
    const foodB = getFoodPoints(bot, b);
    if (foodA !== foodB) return foodB - foodA;
    return (a?.slot ?? 0) - (b?.slot ?? 0);
  });
  return ordered[0] || null;
}

/**
 * Checks whether an item is edible according to the registry.
 * @param {import('mineflayer').Bot} bot Mineflayer bot instance.
 * @param {any} item Inventory item.
 * @returns {boolean}
 */
function isEdibleItem(bot, item) {
  if (!item?.name) return false;
  return getFoodPoints(bot, item) > 0;
}

/**
 * Gets food points from the item registry.
 * @param {import('mineflayer').Bot} bot Mineflayer bot instance.
 * @param {any} item Inventory item.
 * @returns {number}
 */
function getFoodPoints(bot, item) {
  const registryEntry =
    bot?.registry?.foods?.[item?.name] ||
    bot?.registry?.itemsByName?.[item?.name] ||
    bot?.registry?.items?.[item?.name];
  const foodPoints = Number(registryEntry?.foodPoints ?? registryEntry?.food ?? registryEntry?.nutrition ?? 0);
  return Number.isFinite(foodPoints) ? foodPoints : 0;
}

/**
 * Determines whether a slot is in the hotbar.
 * @param {number} slot Inventory slot.
 * @returns {boolean}
 */
function isHotbarSlot(slot) {
  return Number.isInteger(slot) && slot >= 36 && slot <= 44;
}

/**
 * Checks whether the inventory contains any synchronized item contents yet.
 * @param {import('mineflayer').Bot} bot Mineflayer bot instance.
 * @returns {boolean}
 */
function hasInventoryContents(bot) {
  const items = Array.isArray(bot?.inventory?.items?.()) ? bot.inventory.items() : [];
  if (items.length > 0) return true;

  const slots = Array.isArray(bot?.inventory?.slots) ? bot.inventory.slots : [];
  return slots.some(Boolean);
}

module.exports = {
  initializeSurvivalModule
};