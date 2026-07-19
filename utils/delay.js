/**
 * Sleeps for a number of milliseconds.
 * @param {number} ms Delay in milliseconds.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Returns a random integer in the inclusive range [min, max].
 * @param {number} min Minimum value.
 * @param {number} max Maximum value.
 * @returns {number}
 */
function randomIntInclusive(min, max) {
  const floorMin = Math.floor(Math.min(min, max));
  const floorMax = Math.floor(Math.max(min, max));
  return floorMin + Math.floor(Math.random() * (floorMax - floorMin + 1));
}

/**
 * Wraps a promise factory with timeout protection.
 * @template T
 * @param {() => Promise<T>} factory Promise factory.
 * @param {number} timeoutMs Timeout in milliseconds.
 * @param {string} label Timeout label used in error text.
 * @returns {Promise<T>}
 */
async function withTimeout(factory, timeoutMs, label) {
  /** @type {NodeJS.Timeout | null} */
  let timer = null;

  try {
    return await Promise.race([
      factory(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

module.exports = {
  sleep,
  randomIntInclusive,
  withTimeout
};
