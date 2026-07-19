const CONTROL_STATES = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];

/**
 * Creates terminal-based manual control commands for a connected bot.
 * @param {{ enabled: boolean, lookStepDegrees: number, logger: { info: Function, warn: Function, error: Function } }} options Setup options.
 * @returns {{handleCommand: Function, stopAllControls: Function}}
 */
function createManualControl(options) {
  const enabled = options.enabled;
  const lookStepDegrees = options.lookStepDegrees;
  const logger = options.logger;
  let manualMode = false;

  /**
   * Handles one terminal command line.
   * @param {string} commandLine Raw command text.
   * @param {import('mineflayer').Bot|null} bot Current active bot.
   * @returns {boolean} True when the input is handled as a manual control command.
   */
  function handleCommand(commandLine, bot) {
    if (!enabled) return false;

    const trimmed = commandLine.trim();
    if (trimmed.length === 0) return false;

    const lower = trimmed.toLowerCase();
    if (lower === 'manual help') {
      printManualHelp();
      return true;
    }

    if (lower === 'manual on') {
      manualMode = true;
      logger.info('Manual control mode enabled.');
      return true;
    }

    if (lower === 'manual off') {
      if (bot) stopAllControls(bot);
      manualMode = false;
      logger.info('Manual control mode disabled.');
      return true;
    }

    if (lower === 'manual status') {
      logger.info(`Manual control mode: ${manualMode ? 'ON' : 'OFF'}`);
      return true;
    }

    if (!manualMode) return false;

    const [command, arg1, arg2] = trimmed.split(/\s+/);
    const keyword = String(command).toLowerCase();

    if (keyword === 'look') {
      handleLookCommand(bot, arg1, arg2, lookStepDegrees, logger);
      return true;
    }

    if (keyword === 'move') {
      handleMoveCommand(bot, arg1, arg2, logger);
      return true;
    }

    if (keyword === 'stop') {
      if (!bot) {
        logger.warn('No active bot instance. Nothing to stop.');
        return true;
      }
      stopAllControls(bot);
      logger.info('All manual movement controls were turned off.');
      return true;
    }

    if (keyword === 'say') {
      if (!bot) {
        logger.warn('No active bot instance. Cannot send chat message.');
        return true;
      }
      const message = trimmed.slice(4).trim();
      if (message.length === 0) {
        logger.warn('Usage: say <message>');
        return true;
      }
      bot.chat(message);
      logger.info(`[MANUAL] Sent chat message: ${message}`);
      return true;
    }

    return false;
  }

  /**
   * Turns off all movement-related control states.
   * @param {import('mineflayer').Bot} bot Bot instance.
   */
  function stopAllControls(bot) {
    if (!bot || typeof bot.setControlState !== 'function') return;
    for (const state of CONTROL_STATES) {
      bot.setControlState(state, false);
    }
  }

  return {
    handleCommand,
    stopAllControls
  };
}

/**
 * Processes look commands and rotates camera.
 * @param {import('mineflayer').Bot|null} bot Bot instance.
 * @param {string|undefined} direction Look direction.
 * @param {string|undefined} value Optional degrees.
 * @param {number} defaultStep Default look step in degrees.
 * @param {{ info: Function, warn: Function, error: Function }} logger Logger.
 */
function handleLookCommand(bot, direction, value, defaultStep, logger) {
  if (!bot?.entity) {
    logger.warn('No active bot entity. Cannot apply look command.');
    return;
  }

  const normalizedDirection = String(direction || '').toLowerCase();
  if (!['up', 'down', 'left', 'right'].includes(normalizedDirection)) {
    logger.warn('Usage: look <up|down|left|right> [degrees]');
    return;
  }

  const stepDegrees = normalizeLookStep(value, defaultStep);
  const stepRadians = degreesToRadians(stepDegrees);
  let yawDelta = 0;
  let pitchDelta = 0;

  if (normalizedDirection === 'left') yawDelta = -stepRadians;
  if (normalizedDirection === 'right') yawDelta = stepRadians;
  if (normalizedDirection === 'up') pitchDelta = -stepRadians;
  if (normalizedDirection === 'down') pitchDelta = stepRadians;

  const currentYaw = bot.entity.yaw;
  const currentPitch = bot.entity.pitch;
  const targetYaw = currentYaw + yawDelta;
  const targetPitch = clampPitch(currentPitch + pitchDelta);

  bot.look(targetYaw, targetPitch, true)
    .then(() => {
      logger.info(
        `[MANUAL] Looked ${normalizedDirection} by ${stepDegrees} degree(s).`
      );
    })
    .catch((error) => {
      logger.error(`Manual look failed: ${error.message}`);
    });
}

/**
 * Processes movement state commands.
 * @param {import('mineflayer').Bot|null} bot Bot instance.
 * @param {string|undefined} control Control state name.
 * @param {string|undefined} mode on/off mode.
 * @param {{ info: Function, warn: Function }} logger Logger.
 */
function handleMoveCommand(bot, control, mode, logger) {
  if (!bot) {
    logger.warn('No active bot instance. Cannot apply movement command.');
    return;
  }

  const normalizedControl = String(control || '').toLowerCase();
  const normalizedMode = String(mode || '').toLowerCase();
  if (!CONTROL_STATES.includes(normalizedControl)) {
    logger.warn('Usage: move <forward|back|left|right|jump|sprint|sneak> <on|off>');
    return;
  }
  if (!['on', 'off'].includes(normalizedMode)) {
    logger.warn('Usage: move <forward|back|left|right|jump|sprint|sneak> <on|off>');
    return;
  }

  const enabled = normalizedMode === 'on';
  bot.setControlState(normalizedControl, enabled);
  logger.info(`[MANUAL] Movement "${normalizedControl}" set to ${enabled ? 'ON' : 'OFF'}.`);
}

/**
 * Prints available manual control commands.
 */
function printManualHelp() {
  console.log('[MANUAL] Commands:');
  console.log('[MANUAL]   manual on');
  console.log('[MANUAL]   manual off');
  console.log('[MANUAL]   manual status');
  console.log('[MANUAL]   manual help');
  console.log('[MANUAL]   look <up|down|left|right> [degrees]');
  console.log('[MANUAL]   move <forward|back|left|right|jump|sprint|sneak> <on|off>');
  console.log('[MANUAL]   stop');
  console.log('[MANUAL]   say <message>');
}

/**
 * Normalizes configured or user-provided look step.
 * @param {unknown} value Value to normalize.
 * @param {number} defaultValue Default degree value.
 * @returns {number}
 */
function normalizeLookStep(value, defaultValue) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  if (parsed > 90) return 90;
  return parsed;
}

/**
 * Converts degrees to radians.
 * @param {number} degrees Angle in degrees.
 * @returns {number}
 */
function degreesToRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/**
 * Clamps camera pitch to Minecraft-safe range.
 * @param {number} pitch Candidate pitch in radians.
 * @returns {number}
 */
function clampPitch(pitch) {
  const min = -Math.PI / 2;
  const max = Math.PI / 2;
  if (pitch < min) return min;
  if (pitch > max) return max;
   return pitch;
}

module.exports = {
  createManualControl
};
