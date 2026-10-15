// Wire protocol between the browser client and the game server (JSON over
// WebSocket). Snapshots use compact arrays; everything else is readable.
import type { Appearance } from './data/appearance';
import type { ClassId } from './data/classes';
import type { CharacterData, PublicCharacter } from './character';
import type { Equipment, InventorySlot } from './data/items';

/** Locomotion state a client reports for itself (drives remote animation). */
export enum MoveState {
  Idle = 0,
  Walk = 1,
  Run = 2,
  Sprint = 3,
  Air = 4,
  Dodge = 5,
  Dead = 6,
  Sit = 7,
  Wade = 8,
  Glide = 9,
}

// ---------------------------------------------------------------- client -> server
export type ClientMessage =
  | { t: 'hello'; v: number; token: string }
  | { t: 'create'; name: string; cls: ClassId; appearance: Appearance }
  | { t: 'enter' }
  | { t: 'mv'; x: number; y: number; z: number; yaw: number; st: MoveState; seq: number }
  | { t: 'chat'; text: string }
  | { t: 'emote'; e: string }
  /** c = client clock (echoed back), r = the client's smoothed round trip in ms (shown on the Tab roster). */
  | { t: 'ping'; c: number; r?: number }
  /**
   * Combat action: k = combo / skill / dodge, i = index (combo step or skill
   * slot), yaw = facing, tx/tz = aimed ground point (targeted skills).
   */
  | { t: 'act'; k: ActKind; i: number; yaw: number; tx: number; tz: number }
  | { t: 'use'; id: string }
  | { t: 'respawn' }
  /** Equip (or drink) the item in inventory slot i. */
  | { t: 'equip'; i: number }
  | { t: 'unequip'; slot: 'offhand' | 'outfit' }
  /** Teleport to a named place (a point-of-interest id); an empty id cancels. */
  | { t: 'travel'; poi: string }
  | { t: 'discard'; i: number };

export type ActKind = 'c' | 's' | 'd';

/** Monster AI state carried in snapshots. */
export enum MonsterState {
  Idle = 0,
  Walk = 1,
  Run = 2,
  Attack = 3,
  Stunned = 4,
  Dead = 5,
  Rising = 6,
}

/** Hit flags. */
export const HIT_CRIT = 1;
export const HIT_HEAL = 2;
export const HIT_PLAYER = 4; // the target is a player (otherwise a monster)
export const HIT_DODGED = 8;
export const HIT_DOT = 16; // damage over time tick

/** [targetId, amount, flags, sourceId] */
export type Hit = [number, number, number, number];

// ---------------------------------------------------------------- server -> client
/** Snapshot entity: [id, x, y, z, yaw, state, hpFraction(0-255)] */
export type SnapEntity = [number, number, number, number, number, number, number];
/** Snapshot monster: [id, kind index (MONSTER_IDS), x, y, z, yaw, MonsterState, hpFraction(0-255)] */
export type SnapMonster = [number, number, number, number, number, number, number, number];

/** What the server tells you about yourself when it changes. */
export interface SelfState {
  hp: number;
  maxHp: number;
  level: number;
  xp: number;
  inventory?: InventorySlot[];
  equipment?: Equipment;
  /** XP just earned (for the "+24 XP" toast). */
  gain?: number;
}

export type ServerMessage =
  | { t: 'welcome'; uid: string; character: CharacterData | null; serverNow: number; dayTime: number; online: number; guest: boolean }
  | { t: 'error'; code: string; message: string }
  | { t: 'nameTaken'; name: string }
  | { t: 'created'; character: CharacterData }
  | { t: 'world'; you: number; character: CharacterData; players: PublicCharacter[]; dayTime: number; serverNow: number }
  | { t: 's'; ts: number; e: SnapEntity[]; m: SnapMonster[] }
  | { t: 'act'; id: number; k: ActKind; i: number; yaw: number; tx: number; tz: number }
  /** A monster starts attack `a` aimed at (tx, tz). */
  | { t: 'mact'; id: number; a: number; tx: number; tz: number; yaw: number }
  | { t: 'hit'; h: Hit[] }
  | { t: 'me'; s: SelfState }
  | { t: 'died'; by: string }
  | { t: 'respawned'; x: number; y: number; z: number; yaw: number }
  | { t: 'lvl'; id: number; level: number; maxHp: number }
  | { t: 'loot'; id: string; qty: number }
  | { t: 'kill'; id: number; xp: number }
  /** A player's visible gear changed. */
  | { t: 'look'; id: number; weapon: string | null; offhand: string | null; outfit: number }
  | { t: 'join'; p: PublicCharacter }
  | { t: 'leave'; id: number }
  | { t: 'chat'; id: number; name: string; text: string; sys?: boolean }
  | { t: 'emote'; id: number; e: string }
  | { t: 'correct'; x: number; y: number; z: number }
  /**
   * Teleports: `start` begins a channel of `ms`, `cancel` ends it early, and
   * `arrive` lands the player at x/y/z (sent after the traveller's `correct`).
   */
  | { t: 'travel'; id: number; s: 'start' | 'cancel' | 'arrive'; poi: string; ms?: number; x?: number; y?: number; z?: number }
  | { t: 'pong'; c: number; s: number }
  /** Everyone's latest round trip: [entityId, ms][] (every couple of seconds). */
  | { t: 'pings'; p: [number, number][] };

export const EMOTES = ['wave', 'cheer', 'sit', 'dance'] as const;
export type Emote = (typeof EMOTES)[number];

/** Round to centimetres to keep packets small. */
export const q = (v: number) => Math.round(v * 100) / 100;
