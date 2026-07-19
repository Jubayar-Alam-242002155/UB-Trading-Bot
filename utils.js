/**
 * Returns the current timestamp in ISO format.
 * @returns {string}
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Normalizes disconnect/kick reasons for readable logs.
 * @param {unknown} reason Mineflayer reason payload.
 * @returns {string}
 */
function formatDisconnectReason(reason) {
  if (typeof reason === 'string') return reason;
  if (reason === null || reason === undefined) return 'No reason provided';

  try {
    return JSON.stringify(reason);
  } catch (error) {
    return String(reason);
  }
}

module.exports = {
  nowIso,
  formatDisconnectReason
};
