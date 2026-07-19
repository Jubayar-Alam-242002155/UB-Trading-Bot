const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const HTML_PATH = path.join(__dirname, 'public', 'index.html');
const TERMINAL_HTML_PATH = path.join(__dirname, 'public', 'terminal.html');
const DEFAULT_PORT = 3000;

/**
 * Creates and starts the multi-bot dashboard HTTP server.
 * @param {{
 *   port?: number,
 *   onCommand?: (botId: string, cmd: string) => void,
 *   onAddBot?: (username: string) => Promise<any>,
 *   onRemoveBot?: (id: string) => Promise<void>,
 *   getBots?: () => any[]
 * }} options
 */
function createDashboard(options = {}) {
  const port = options.port || DEFAULT_PORT;
  const onCommand = options.onCommand || (() => {});
  const onAddBot = options.onAddBot;
  const onRemoveBot = options.onRemoveBot;
  const getBots = options.getBots || (() => []);
  const sseClients = new Set();
  const logsByBot = new Map();
  const chatByBot = new Map();

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = req.url || '/';

    // SSE
    if (url === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write(':\n\n');
      sseClients.add(res);

      // Replay current bot list + state
      try {
        const bots = getBots();
        for (const b of bots) {
          res.write('event: bot-added\ndata: ' + JSON.stringify({ botId: b.id, id: b.id, username: b.username, addedAt: b.addedAt }) + '\n\n');
          if (b.state) {
            if (b.state.balance != null) res.write('event: balance\ndata: ' + JSON.stringify({ botId: b.id, balance: b.state.balance }) + '\n\n');
            if (b.state.status) res.write('event: status\ndata: ' + JSON.stringify({ botId: b.id, status: b.state.status }) + '\n\n');
            if (b.state.portfolio) res.write('event: portfolio\ndata: ' + JSON.stringify({ botId: b.id, ...b.state.portfolio }) + '\n\n');
            if (b.state.prices) res.write('event: prices\ndata: ' + JSON.stringify({ botId: b.id, companies: b.state.prices }) + '\n\n');
          }
          for (const entry of logsByBot.get(b.id) || []) {
            res.write('event: log\ndata: ' + JSON.stringify({ botId: b.id, ...entry }) + '\n\n');
          }
          for (const entry of chatByBot.get(b.id) || []) {
            res.write('event: chat\ndata: ' + JSON.stringify({ botId: b.id, ...entry }) + '\n\n');
          }
        }
      } catch (e) { console.error('[DASH] Replay failed:', e.message); }

      req.on('close', () => sseClients.delete(res));
      return;
    }

    // GET /bots — list bots
    if (url === '/bots' && req.method === 'GET') {
      const bots = getBots().map(b => ({ id: b.id, username: b.username, addedAt: b.addedAt, state: b.state || {} }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ bots }));
      return;
    }

    // POST /bots — add a bot
    if (url === '/bots' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const { username } = JSON.parse(body || '{}');
        const result = await onAddBot(username);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, bot: result }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // DELETE /bots/:id — remove a bot
    const delMatch = url.match(/^\/bots\/([^\/]+)$/);
    if (delMatch && req.method === 'DELETE') {
      try {
        await onRemoveBot(decodeURIComponent(delMatch[1]));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // POST /bots/:id/command — send command
    const cmdMatch = url.match(/^\/bots\/([^\/]+)\/command$/);
    if (cmdMatch && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const { command } = JSON.parse(body || '{}');
        const cmd = String(command || '').trim();
        if (!cmd) throw new Error('Empty command');
        onCommand(decodeURIComponent(cmdMatch[1]), cmd);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    // Serve HTML
    if (url === '/' || url === '/index.html') {
      try {
        const html = fs.readFileSync(HTML_PATH, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (e) {
        res.writeHead(500); res.end('Dashboard HTML not found: ' + e.message);
      }
      return;
    }

    if (url === '/terminal' || url === '/terminal.html') {
      try {
        const html = fs.readFileSync(TERMINAL_HTML_PATH, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (e) {
        res.writeHead(500); res.end('Terminal HTML not found: ' + e.message);
      }
      return;
    }

    res.writeHead(404); res.end('Not Found');
  });

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  function broadcast(event, data) {
    if (event === 'log' && data?.botId) {
      const logs = logsByBot.get(data.botId) || [];
      logs.push({ time: data.time, level: data.level, message: data.message });
      if (logs.length > 1000) logs.splice(0, logs.length - 1000);
      logsByBot.set(data.botId, logs);
    }
    if (event === 'chat' && data?.botId) {
      const chat = chatByBot.get(data.botId) || [];
      chat.push({ time: data.time, level: data.level, message: data.message });
      if (chat.length > 1000) chat.splice(0, chat.length - 1000);
      chatByBot.set(data.botId, chat);
    }
    if (event === 'bot-removed' && data?.botId) {
      logsByBot.delete(data.botId);
      chatByBot.delete(data.botId);
    }
    const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
    for (const client of sseClients) {
      try { client.write(payload); } catch (_) { sseClients.delete(client); }
    }
  }

  server.listen(port, () => {
    console.log('[DASHBOARD] Dashboard running at http://localhost:' + port);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('[DASHBOARD] Port ' + port + ' in use, trying ' + (port + 1));
      server.listen(port + 1);
    } else {
      console.error('[DASHBOARD] Server error: ' + err.message);
    }
  });

  return { broadcast, server };
}

module.exports = { createDashboard };
