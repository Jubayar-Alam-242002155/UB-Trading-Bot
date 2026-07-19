const { loadConfig } = require('./config');
const { ensureProjectFiles } = require('./storage');
const { createBotManager } = require('./botManager');
const { createDashboard } = require('./dashboard/server');

async function main() {
  await ensureProjectFiles();
  const config = await loadConfig();
  const dashboardPort = Number(config.dashboard?.port) || 3000;

  // Create dashboard first so we can pass callbacks in
  let dashboard;
  const manager = createBotManager({
    onEvent: (evt) => {
      if (!dashboard) return;
      // Forward every worker event to browser clients
      dashboard.broadcast(evt.type, { botId: evt.botId, ...(evt.data || {}) });
    }
  });

  dashboard = createDashboard({
    port: dashboardPort,
    onCommand: (botId, cmd) => {
      try { manager.sendCommand(botId, cmd); }
      catch (e) {
        dashboard.broadcast('log', { botId, level: 'ERROR', message: 'Command failed: ' + e.message, time: new Date().toISOString() });
      }
    },
    onAddBot: async (username) => manager.addBot(username),
    onRemoveBot: async (id) => manager.removeBot(id),
    getBots: () => manager.listBots()
  });

  console.log('[MAIN] Dashboard available at http://localhost:' + dashboardPort);
  console.log('[MAIN] Open the dashboard, then click "Add Bot" to spawn your first bot.');

  // Restore persisted bot list
  await manager.ensureStarted();
}

main().catch((error) => {
  console.error('[FATAL] ' + error.message);
  process.exitCode = 1;
});
