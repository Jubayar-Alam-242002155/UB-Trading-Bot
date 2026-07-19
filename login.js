/**
 * Attaches offline-server login handlers.
 * When chat prompts contain /login or /register, the bot replies using the configured password.
 * @param {import('mineflayer').Bot} bot Mineflayer bot instance.
 * @param {{ account: { password?: string } }} config Runtime configuration.
 * @param {{ info: Function, warn: Function, error: Function }} logger Application logger.
 */
function initializeLoginModule(bot, config, logger) {
  const password = config?.account?.password;

  if (typeof password !== 'string' || password.trim().length === 0 || password === 'CHANGE_ME') {
    logger.warn('Login module enabled but account.password is not configured. Auto-login skipped.');
    return;
  }

  bot.on('messagestr', (message) => {
    const text = String(message).toLowerCase();

    if (text.includes('/register')) {
      const registerCommand = `/register ${password} ${password}`;
      bot.chat(registerCommand);
      logger.info('Detected /register prompt. Registration command sent.');
      return;
    }

    if (text.includes('/login')) {
      const loginCommand = `/login ${password}`;
      bot.chat(loginCommand);
      logger.info('Detected /login prompt. Login command sent.');
    }
  });
}

module.exports = { initializeLoginModule };
