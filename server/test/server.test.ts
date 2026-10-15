import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { DEFAULT_APPEARANCE, PROTOCOL_VERSION, type ServerMessage } from '@kelia/shared';

const PORT = 18000 + Math.floor(Math.random() * 1000);
let proc: ChildProcess;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelia-'));

before(async () => {
  proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, FIREBASE_SERVICE_ACCOUNT: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve) => proc.stdout!.on('data', (d) => String(d).includes('listening') && resolve()));
});
after(() => proc.kill('SIGTERM'));

class Client {
  ws: WebSocket;
  inbox: ServerMessage[] = [];
  waiters: ((m: ServerMessage) => boolean)[] = [];
  constructor() {
    this.ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    this.ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMessage;
      this.inbox.push(m);
      this.waiters = this.waiters.filter((w) => !w(m));
    });
  }
  open() { return new Promise((r) => this.ws.once('open', r)); }
  send(m: object) { this.ws.send(JSON.stringify(m)); }
  wait<T extends ServerMessage['t']>(t: T, timeout = 4000): Promise<Extract<ServerMessage, { t: T }>> {
    const hit = this.inbox.find((m) => m.t === t);
    if (hit) { this.inbox.splice(this.inbox.indexOf(hit), 1); return Promise.resolve(hit as never); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for ' + t)), timeout);
      this.waiters.push((m) => {
        if (m.t !== t) return false;
        clearTimeout(timer);
        this.inbox.splice(this.inbox.indexOf(m), 1);
        resolve(m as never);
        return true;
      });
    });
  }
}

const guest = (id: string) => `guest:${id}:${'s'.repeat(24)}`;

test('health endpoint', async () => {
  const r = await fetch(`http://localhost:${PORT}/health`);
  const j = (await r.json()) as { ok: boolean };
  assert.equal(j.ok, true);
});

test('guest can create, enter, move, chat; names are unique; cheats are corrected', async () => {
  const a = new Client();
  await a.open();
  a.send({ t: 'hello', v: PROTOCOL_VERSION, token: guest('alice') });
  const w = await a.wait('welcome');
  assert.equal(w.character, null);
  a.send({ t: 'create', name: 'Aria', cls: 'ranger', appearance: DEFAULT_APPEARANCE });
  const created = await a.wait('created');
  assert.equal(created.character.name, 'Aria');
  a.send({ t: 'enter' });
  const world = await a.wait('world');
  const me = world.character;

  const b = new Client();
  await b.open();
  b.send({ t: 'hello', v: PROTOCOL_VERSION, token: guest('bob') });
  await b.wait('welcome');
  b.send({ t: 'create', name: 'aria', cls: 'vanguard', appearance: DEFAULT_APPEARANCE });
  await b.wait('nameTaken');
  b.send({ t: 'create', name: 'Borin', cls: 'vanguard', appearance: DEFAULT_APPEARANCE });
  await b.wait('created');
  b.send({ t: 'enter' });
  const wb = await b.wait('world');
  assert.equal(wb.players.length, 1);
  const join = await a.wait('join');
  assert.equal(join.p.name, 'Borin');

  // A legal step is accepted and shows up in snapshots.
  await new Promise((r) => setTimeout(r, 120));
  a.send({ t: 'mv', x: me.pos[0] + 0.5, y: me.pos[1], z: me.pos[2], yaw: 1, st: 1, seq: 1 });
  await new Promise((r) => setTimeout(r, 150));
  const snap = await b.wait('s');
  assert.ok(snap.e.length === 2);
  // A teleport is rejected.
  a.send({ t: 'mv', x: me.pos[0] + 200, y: me.pos[1], z: me.pos[2], yaw: 1, st: 1, seq: 2 });
  const corr = await a.wait('correct');
  assert.ok(Math.abs(corr.x - (me.pos[0] + 0.5)) < 0.05);

  b.send({ t: 'chat', text: 'hello there' });
  let chat;
  do { chat = await a.wait('chat'); } while (chat.sys);
  assert.equal(chat.text, 'hello there');
  assert.equal(chat.name, 'Borin');

  // Reconnecting loads the saved character.
  b.ws.close();
  await a.wait('leave');
  const b2 = new Client();
  await b2.open();
  b2.send({ t: 'hello', v: PROTOCOL_VERSION, token: guest('bob') });
  const w2 = await b2.wait('welcome');
  assert.equal(w2.character?.name, 'Borin');
  a.ws.close();
  b2.ws.close();
});
