// Kelia game server: HTTP health endpoint + WebSocket game protocol.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { MAX_PLAYERS, PROTOCOL_VERSION } from '@kelia/shared';
import { config } from './config';
import { initFirebase } from './auth';
import { FileStore, FirestoreStore, type CharacterStore } from './store';
import { World } from './world';

const app = await initFirebase();
const store: CharacterStore = app ? await FirestoreStore.create(app) : new FileStore(config.dataDir);
console.log(`[server] saves: ${store.kind}, guests: ${config.allowGuests ? 'on' : 'off'}`);
const world = new World(store);
world.start();

function originAllowed(origin: string | undefined) {
  if (!config.allowedOrigins.length || !origin) return true;
  return config.allowedOrigins.some((o) => origin === o || (o.startsWith('*.') && origin.endsWith(o.slice(1))));
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.url === '/health' || req.url === '/') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, name: 'kelia', online: world.online, max: MAX_PLAYERS, protocol: PROTOCOL_VERSION, version: config.version, saves: store.kind }));
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/ws') || !originAllowed(req.headers.origin)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? '';
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    world.connect(ws, ip);
  });
});

// Drop dead connections (laptops that slept, etc). With noServer the
// 'connection' event never fires, so liveness is tracked from the upgrade.
const alive = new WeakMap<object, boolean>();
setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.get(ws)) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    ws.ping();
  }
}, 15_000);

server.listen(config.port, () => console.log(`[server] Kelia listening on :${config.port}`));

async function shutdown() {
  console.log('[server] shutting down, saving players…');
  await world.stop();
  if (store instanceof FileStore) store.flushNow();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
