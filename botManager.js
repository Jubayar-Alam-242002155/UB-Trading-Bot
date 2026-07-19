const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');

const REGISTRY_FILE = path.join(__dirname, 'storage', 'bots.json');
const WORKER_SCRIPT = path.join(__dirname, 'botWorker.js');
const STORAGE_ROOT = path.join(__dirname, 'storage', 'bots');

/**
 * Creates and manages multiple bot worker processes.
 * @param {{ onEvent?: (evt: {botId:string,type:string,data:any}) => void }} options
 * @returns {{ addBot: Function, removeBot: Function, listBots: Function, sendCommand: Function, getBots: Function, ensureStarted: Function }}
 */
function createBotManager(options = {}) {
  const onEvent = options.onEvent || (() => {});
  const bots = new Map(); // id -> { id, username, addedAt, proc, state }

  fsSync.mkdirSync(STORAGE_ROOT, { recursive: true });

  async function loadRegistry() {
    try {
      const raw = await fs.readFile(REGISTRY_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.bots) ? parsed.bots : [];
    } catch (_) { return []; }
  }

  async function saveRegistry() {
    const list = Array.from(bots.values()).map(b => ({
      id: b.id, username: b.username, addedAt: b.addedAt
    }));
    await fs.mkdir(path.dirname(REGISTRY_FILE), { recursive: true });
    await fs.writeFile(REGISTRY_FILE, JSON.stringify({ bots: list }, null, 2), 'utf8');
  }

  function spawnWorker(entry) {
    const storageDir = path.join(STORAGE_ROOT, entry.id);
    fsSync.mkdirSync(storageDir, { recursive: true });

    const proc = spawn(process.execPath, [WORKER_SCRIPT], {
      env: {
        ...process.env,
        BOT_ID: entry.id,
        BOT_USERNAME: entry.username,
        BOT_STORAGE_DIR: storageDir
      },
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdoutBuffer = '';
    proc.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      let idx;
      while ((idx = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, idx);
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        if (line.startsWith('__BOT_EVT__')) {
          try {
            const evt = JSON.parse(line.slice('__BOT_EVT__'.length));
            handleWorkerEvent(entry, evt);
          } catch (e) {
            console.error('[MANAGER] Bad event JSON:', e.message);
          }
        } else if (line.trim()) {
          // Regular stdout — also echo to parent console
          console.log('[bot:' + entry.id + '] ' + line);
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      console.error('[bot:' + entry.id + ' stderr] ' + s.trim());
      onEvent({ botId: entry.id, type: 'log', data: { level: 'ERROR', message: s.trim(), time: new Date().toISOString() } });
    });

    proc.on('exit', (code) => {
      console.log('[MANAGER] Worker ' + entry.id + ' exited with code ' + code);
      const b = bots.get(entry.id);
      if (b) {
        b.state = 'offline';
        b.proc = null;
      }
      onEvent({ botId: entry.id, type: 'status', data: { status: 'offline' } });
      // Auto-restart after 10s if bot still registered
      if (bots.has(entry.id)) {
        setTimeout(() => {
          const still = bots.get(entry.id);
          if (still && !still.proc) {
            console.log('[MANAGER] Restarting worker ' + entry.id);
            still.proc = spawnWorker(still);
          }
        }, 10000);
      }
    });

    return proc;
  }

  function handleWorkerEvent(entry, evt) {
    const b = bots.get(entry.id);
    if (!b) return;
    if (evt.type === 'balance') b.state = { ...(b.state || {}), balance: evt.data.balance };
    if (evt.type === 'status') b.state = { ...(b.state || {}), status: evt.data.status };
    if (evt.type === 'portfolio') b.state = { ...(b.state || {}), portfolio: evt.data };
    if (evt.type === 'prices') b.state = { ...(b.state || {}), prices: evt.data.companies };
    onEvent(evt);
  }

  async function addBot(username) {
    username = String(username || '').trim();
    if (!username) throw new Error('Username required');
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) throw new Error('Invalid Minecraft username');

    const id = username.toLowerCase();
    if (bots.has(id)) throw new Error('Bot ' + username + ' already added');

    const entry = { id, username, addedAt: new Date().toISOString(), proc: null, state: { status: 'connecting' } };
    bots.set(id, entry);
    entry.proc = spawnWorker(entry);
    await saveRegistry();

    onEvent({ botId: id, type: 'bot-added', data: { id, username, addedAt: entry.addedAt } });
    return { id, username, addedAt: entry.addedAt };
  }

  async function removeBot(id) {
    const entry = bots.get(id);
    if (!entry) throw new Error('Bot ' + id + ' not found');
    if (entry.proc) {
      try { entry.proc.kill(); } catch (_) {}
    }
    bots.delete(id);
    await saveRegistry();
    onEvent({ botId: id, type: 'bot-removed', data: { id } });
  }

  function listBots() {
    return Array.from(bots.values()).map(b => ({
      id: b.id,
      username: b.username,
      addedAt: b.addedAt,
      state: b.state || {}
    }));
  }

  function sendCommand(id, cmd) {
    const entry = bots.get(id);
    if (!entry) throw new Error('Bot ' + id + ' not found');
    if (!entry.proc) throw new Error('Bot ' + id + ' offline');
    try {
      entry.proc.stdin.write(JSON.stringify({ type: 'command', command: cmd }) + '\n');
    } catch (e) {
      throw new Error('Failed to send: ' + e.message);
    }
  }

  async function ensureStarted() {
    const registered = await loadRegistry();
    for (const b of registered) {
      if (!bots.has(b.id)) {
        try { await addBotFromRegistry(b); } catch (e) {
          console.error('[MANAGER] Failed to spawn ' + b.id + ': ' + e.message);
        }
      }
    }
  }

  async function addBotFromRegistry(b) {
    if (bots.has(b.id)) return;
    const entry = { id: b.id, username: b.username, addedAt: b.addedAt, proc: null, state: { status: 'connecting' } };
    bots.set(b.id, entry);
    entry.proc = spawnWorker(entry);
    onEvent({ botId: b.id, type: 'bot-added', data: { id: b.id, username: b.username, addedAt: b.addedAt } });
  }

  process.on('SIGINT', () => {
    for (const b of bots.values()) {
      if (b.proc) try { b.proc.kill(); } catch (_) {}
    }
    process.exit(0);
  });

  return { addBot, removeBot, listBots, sendCommand, getBots: () => bots, ensureStarted };
}

module.exports = { createBotManager };
