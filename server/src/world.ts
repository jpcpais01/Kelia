// The authoritative game world: sessions, players, movement validation,
// chat and the fixed 20 Hz snapshot loop.
import type { WebSocket } from 'ws';
import {
  CHAT_MAX_LENGTH,
  CHAT_RATE_PER_10S,
  EMOTES,
  Heightmap,
  MAX_ACCEPTED_SPEED,
  MAX_PLAYERS,
  MAX_WADE_DEPTH,
  MoveState,
  PROTOCOL_VERSION,
  SAVE_INTERVAL_MS,
  SPAWN_POINT,
  TICK_MS,
  WORLD_HALF,
  dayTimeAt,
  isClassId,
  isValidAppearance,
  statsFor,
  outfitIndex,
  ITEMS,
  newCharacter,
  normalizeName,
  q,
  sanitizeAppearance,
  validateName,
  waterAt,
  POINTS_OF_INTEREST,
  type CharacterData,
  type ClientMessage,
  type PublicCharacter,
  type ServerMessage,
  type SnapEntity,
  type Stats,
} from '@kelia/shared';
import { verifyToken, type AuthResult } from './auth';
import { config } from './config';
import { Combat, PlayerCombat, type Fighter } from './combat';
import type { CharacterStore } from './store';

export class Session {
  auth: AuthResult | null = null;
  character: CharacterData | null = null;
  player: Player | null = null;
  chatTimes: number[] = [];
  alive = true;
  /** Round trip the client last reported (ms), for the Tab roster. */
  ping = 0;
  constructor(readonly ws: WebSocket, readonly ip: string) {}

  send(msg: ServerMessage) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }
  sendRaw(data: string) {
    if (this.ws.readyState === 1) this.ws.send(data);
  }
}

export class Player {
  x: number;
  y: number;
  z: number;
  yaw: number;
  state: MoveState = MoveState.Idle;
  lastMoveAt = Date.now();
  lastSaveAt = Date.now();
  joinedAt = Date.now();
  corrections = 0;
  stats: Stats;
  combat = new PlayerCombat();

  constructor(readonly id: number, readonly session: Session, public character: CharacterData) {
    [this.x, this.y, this.z] = character.pos;
    this.yaw = character.yaw;
    this.stats = statsFor(character.cls, character.level, character.equipment);
  }

  get maxHp() {
    return this.stats.maxHp;
  }

  send(msg: object) {
    this.session.sendRaw(JSON.stringify(msg));
  }

  get publicInfo(): PublicCharacter {
    const c = this.character;
    return {
      id: this.id,
      name: c.name,
      cls: c.cls,
      appearance: { ...c.appearance, outfit: outfitIndex(c.equipment, c.appearance.outfit) },
      level: c.level,
      weapon: c.equipment.weapon,
      offhand: c.equipment.offhand,
      hp: c.hp,
      maxHp: this.maxHp,
    };
  }
}

export class World {
  readonly sessions = new Set<Session>();
  readonly players = new Map<number, Player>();
  private nextId = 1;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  readonly heightmap: Heightmap;
  readonly combat: Combat;
  private lastTick = Date.now();
  private tickCount = 0;

  constructor(private store: CharacterStore) {
    const t0 = Date.now();
    this.heightmap = new Heightmap(1).fill();
    console.log(`[world] heightmap ${this.heightmap.size}² ready in ${Date.now() - t0} ms`);
    this.combat = new Combat({
      players: this.players as unknown as Map<number, Fighter>,
      groundAt: (x, z) => this.heightmap.sample(x, z),
      walkable: (x, z) => Math.abs(x) < WORLD_HALF - 40 && Math.abs(z) < WORLD_HALF - 40 && !this.tooDeep(x, z),
      broadcast: (msg) => this.broadcast(msg as ServerMessage),
      now: () => Date.now(),
    });
    console.log(`[world] ${this.combat.monsters.length} monsters roam the valley`);
  }

  start() {
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  async stop() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    await Promise.all([...this.players.values()].map((p) => this.save(p)));
  }

  get online() {
    return this.players.size;
  }

  // ------------------------------------------------------------------ connections
  connect(ws: WebSocket, ip: string) {
    const s = new Session(ws, ip);
    this.sessions.add(s);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.handle(s, msg).catch((err) => {
        console.error('[world] handler error', err);
        s.send({ t: 'error', code: 'internal', message: 'Something went wrong on the server.' });
      });
    });
    ws.on('close', () => this.disconnect(s));
    ws.on('error', () => this.disconnect(s));
    return s;
  }

  private disconnect(s: Session) {
    if (!s.alive) return;
    s.alive = false;
    this.sessions.delete(s);
    const p = s.player;
    if (p) {
      this.players.delete(p.id);
      this.combat.playerLeft(p.id);
      if (p.combat.dead) {
        // fallen heroes wake up in the village
        p.character.hp = p.maxHp;
        p.x = SPAWN_POINT[0];
        p.z = SPAWN_POINT[1];
        p.y = this.heightmap.sample(p.x, p.z);
      }
      this.syncCharacter(p);
      void this.save(p);
      this.broadcast({ t: 'leave', id: p.id });
      this.broadcast({ t: 'chat', id: 0, name: '', text: `${p.character.name} has left Kelia.`, sys: true });
      s.player = null;
    }
  }

  // ------------------------------------------------------------------ messages
  private async handle(s: Session, msg: ClientMessage) {
    if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') return;
    switch (msg.t) {
      case 'hello':
        return this.onHello(s, msg);
      case 'create':
        return this.onCreate(s, msg);
      case 'enter':
        return this.onEnter(s);
      case 'mv':
        return this.onMove(s, msg);
      case 'chat':
        return this.onChat(s, msg.text);
      case 'emote':
        if (s.player && (EMOTES as readonly string[]).includes(msg.e)) this.broadcast({ t: 'emote', id: s.player.id, e: msg.e });
        return;
      case 'ping': {
        const r = Number(msg.r);
        if (Number.isFinite(r) && r >= 0) s.ping = Math.min(9999, Math.round(r));
        return s.send({ t: 'pong', c: Number(msg.c) || 0, s: Date.now() });
      }
      case 'act':
        if (s.player) this.combat.act(s.player, msg.k, Number(msg.i) | 0, Number(msg.yaw), Number(msg.tx), Number(msg.tz));
        return;
      case 'use':
        if (s.player) this.combat.usePotion(s.player, String(msg.id));
        return;
      case 'respawn':
        if (s.player) this.combat.respawn(s.player);
        return;
      case 'equip':
        if (s.player) this.combat.equip(s.player, Number(msg.i) | 0);
        return;
      case 'unequip':
        if (s.player && (msg.slot === 'offhand' || msg.slot === 'outfit')) this.combat.unequip(s.player, msg.slot);
        return;
      case 'discard':
        if (s.player) this.combat.discard(s.player, Number(msg.i) | 0);
        return;
    }
  }

  private async onHello(s: Session, msg: Extract<ClientMessage, { t: 'hello' }>) {
    if (s.auth) return;
    if (msg.v !== PROTOCOL_VERSION) {
      s.send({ t: 'error', code: 'version', message: 'Kelia was updated. Please refresh the page.' });
      return;
    }
    try {
      s.auth = await verifyToken(String(msg.token ?? ''));
    } catch (err) {
      s.send({ t: 'error', code: 'auth', message: (err as Error).message || 'Login failed.' });
      s.ws.close();
      return;
    }
    // One session per account: the newest login wins.
    for (const other of this.sessions) {
      if (other !== s && other.auth?.uid === s.auth.uid) {
        other.send({ t: 'error', code: 'replaced', message: 'You logged in from another window.' });
        other.ws.close();
        this.disconnect(other);
      }
    }
    s.character = await this.store.load(s.auth.uid);
    s.send({
      t: 'welcome',
      uid: s.auth.uid,
      character: s.character,
      serverNow: Date.now(),
      dayTime: dayTimeAt(Date.now()),
      online: this.online,
      guest: s.auth.guest,
    });
  }

  private async onCreate(s: Session, msg: Extract<ClientMessage, { t: 'create' }>) {
    if (!s.auth || s.player) return;
    const name = normalizeName(String(msg.name ?? ''));
    const problem = validateName(name);
    if (problem) return s.send({ t: 'error', code: 'name', message: problem });
    if (!isClassId(msg.cls)) return s.send({ t: 'error', code: 'class', message: 'Unknown class.' });
    if (!isValidAppearance(msg.appearance)) return s.send({ t: 'error', code: 'appearance', message: 'Invalid appearance.' });
    const character = newCharacter(s.auth.uid, name, msg.cls, sanitizeAppearance(msg.appearance));
    character.pos[1] = this.heightmap.sample(character.pos[0], character.pos[2]);
    const ok = await this.store.create(character);
    if (!ok) return s.send({ t: 'nameTaken', name });
    s.character = character;
    s.send({ t: 'created', character });
  }

  private onEnter(s: Session) {
    if (!s.auth || !s.character || s.player) return;
    if (this.players.size >= MAX_PLAYERS) {
      s.send({ t: 'error', code: 'full', message: `Kelia is full (${MAX_PLAYERS} players). Try again in a moment.` });
      return;
    }
    const c = s.character;
    // Never spawn inside terrain or deep water.
    const [x, , z] = c.pos;
    const ground = this.heightmap.sample(x, z);
    if (!Number.isFinite(c.pos[1]) || c.pos[1] < ground - 0.5 || this.tooDeep(x, z)) {
      c.pos = [SPAWN_POINT[0], this.heightmap.sample(SPAWN_POINT[0], SPAWN_POINT[1]), SPAWN_POINT[1]];
    }
    const p = new Player(this.nextId++, s, c);
    p.character.hp = Math.min(p.maxHp, Math.max(1, p.character.hp));
    s.player = p;
    this.players.set(p.id, p);
    s.send({
      t: 'world',
      you: p.id,
      character: c,
      players: [...this.players.values()].filter((o) => o !== p).map((o) => o.publicInfo),
      dayTime: dayTimeAt(Date.now()),
      serverNow: Date.now(),
    });
    this.broadcast({ t: 'join', p: p.publicInfo }, p);
    this.broadcast({ t: 'chat', id: 0, name: '', text: `${c.name} has entered Kelia.`, sys: true });
  }

  private tooDeep(x: number, z: number) {
    const w = waterAt(x, z);
    return w > -Infinity && w - this.heightmap.sample(x, z) > MAX_WADE_DEPTH + 0.35;
  }

  private onMove(s: Session, msg: Extract<ClientMessage, { t: 'mv' }>) {
    const p = s.player;
    if (!p) return;
    const { x, y, z, yaw } = msg;
    if (![x, y, z, yaw].every(Number.isFinite)) return;
    if (p.combat.dead) return;
    const now = Date.now();
    const dt = Math.min(1.0, Math.max(0.05, (now - p.lastMoveAt) / 1000));
    const horiz = Math.hypot(x - p.x, z - p.z);
    const allowed = MAX_ACCEPTED_SPEED * dt + 1.2 + (now < p.combat.dashUntil ? p.combat.dashDistance : 0);
    const ground = this.heightmap.sample(x, z);
    const outOfBounds = Math.abs(x) > WORLD_HALF - 6 || Math.abs(z) > WORLD_HALF - 6;
    const underground = y < ground - 1.2;
    const flying = y > Math.max(ground + 5, p.y + 2.2);
    if (horiz > allowed || outOfBounds || underground || flying || this.tooDeep(x, z)) {
      p.corrections++;
      s.send({ t: 'correct', x: q(p.x), y: q(p.y), z: q(p.z) });
      p.lastMoveAt = now;
      return;
    }
    p.x = x;
    p.y = y;
    p.z = z;
    p.yaw = yaw;
    p.state = (msg.st | 0) as MoveState;
    p.lastMoveAt = now;
    this.discover(p);
  }

  /** Mark points of interest as discovered when a player walks close. */
  private discover(p: Player) {
    const c = p.character;
    for (const poi of POINTS_OF_INTEREST) {
      if (c.discovered.includes(poi.id)) continue;
      if (Math.hypot(p.x - poi.pos[0], p.z - poi.pos[1]) < (poi.kind === 'forest' || poi.kind === 'lake' ? 60 : 22)) {
        c.discovered.push(poi.id);
        p.session.send({ t: 'chat', id: 0, name: '', text: `Discovered: ${poi.name}`, sys: true });
      }
    }
  }

  private onChat(s: Session, raw: unknown) {
    const p = s.player;
    if (!p) return;
    const text = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, CHAT_MAX_LENGTH);
    if (!text) return;
    const now = Date.now();
    s.chatTimes = s.chatTimes.filter((t) => now - t < 10_000);
    if (s.chatTimes.length >= CHAT_RATE_PER_10S) {
      s.send({ t: 'chat', id: 0, name: '', text: 'You are sending messages too quickly.', sys: true });
      return;
    }
    s.chatTimes.push(now);
    if (text.startsWith('/')) return this.command(p, text);
    this.broadcast({ t: 'chat', id: p.id, name: p.character.name, text });
  }

  private command(p: Player, text: string) {
    const [cmd] = text.slice(1).split(/\s+/);
    const reply = (t: string) => p.session.send({ t: 'chat', id: 0, name: '', text: t, sys: true });
    switch (cmd.toLowerCase()) {
      case 'who':
        return reply(`Online (${this.players.size}): ${[...this.players.values()].map((o) => `${o.character.name} (Lv ${o.character.level})`).join(', ')}`);
      case 'roll': {
        const n = 1 + Math.floor(Math.random() * 100);
        return this.broadcast({ t: 'chat', id: 0, name: '', text: `${p.character.name} rolls ${n} (1-100).`, sys: true });
      }
      case 'stuck':
        p.x = SPAWN_POINT[0];
        p.z = SPAWN_POINT[1];
        p.y = this.heightmap.sample(p.x, p.z);
        p.session.send({ t: 'correct', x: q(p.x), y: q(p.y), z: q(p.z) });
        return reply('Returned you to Hearthmere.');
      case 'tp': {
        if (!config.devCommands) break;
        const [, xs, zs] = text.split(/\s+/);
        const x = Number(xs);
        const z = Number(zs);
        if (!Number.isFinite(x) || !Number.isFinite(z)) return reply('/tp x z');
        p.x = x;
        p.z = z;
        p.y = this.heightmap.sample(x, z);
        p.session.send({ t: 'correct', x: q(p.x), y: q(p.y), z: q(p.z) });
        return;
      }
      case 'give': {
        if (!config.devCommands) break;
        const [, id, n] = text.split(/\s+/);
        if (!ITEMS[id]) return reply('/give itemId [qty]');
        if (this.combat.addItem(p, id, Math.max(1, Number(n) || 1))) p.session.send({ t: 'loot', id, qty: Math.max(1, Number(n) || 1) });
        return;
      }
      case 'wave':
      case 'cheer':
      case 'dance':
      case 'sit':
        return this.broadcast({ t: 'emote', id: p.id, e: cmd.toLowerCase() });
    }
    return reply('Commands: /who, /roll, /stuck, /wave, /cheer, /dance, /sit');
  }

  // ------------------------------------------------------------------ simulation
  private tick() {
    const now = Date.now();
    const dt = Math.min(0.25, (now - this.lastTick) / 1000);
    this.lastTick = now;
    if (this.players.size === 0) return;
    this.combat.tick(dt);
    const e: SnapEntity[] = [];
    for (const p of this.players.values()) {
      const hpFrac = Math.round((p.character.hp / p.maxHp) * 255);
      e.push([p.id, q(p.x), q(p.y), q(p.z), Math.round(p.yaw * 1000) / 1000, p.combat.dead ? MoveState.Dead : p.state, hpFrac]);
      if (now - p.lastSaveAt > SAVE_INTERVAL_MS) {
        p.lastSaveAt = now;
        this.syncCharacter(p);
        void this.save(p);
      }
    }
    // players see everyone, but only the monsters around them
    const head = JSON.stringify({ t: 's', ts: now, e }).slice(0, -1);
    for (const p of this.players.values()) p.session.sendRaw(`${head},"m":${JSON.stringify(this.combat.snapshot(p.x, p.z, 110))}}`);
    // everyone's ping for the Tab roster, every 2 s
    if (++this.tickCount % 40 === 0) this.broadcast({ t: 'pings', p: [...this.players.values()].map((p) => [p.id, p.session.ping] as [number, number]) });
  }

  private syncCharacter(p: Player) {
    const c = p.character;
    c.pos = [q(p.x), q(p.y), q(p.z)];
    c.yaw = Math.round(p.yaw * 1000) / 1000;
    c.playTime += Math.round((Date.now() - p.joinedAt) / 1000);
    p.joinedAt = Date.now();
    c.updatedAt = Date.now();
  }

  private async save(p: Player) {
    try {
      await this.store.save(p.character);
    } catch (err) {
      console.error('[world] save failed for', p.character.name, err);
    }
  }

  broadcast(msg: ServerMessage, except?: Player) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) if (p !== except) p.session.sendRaw(data);
  }
}
