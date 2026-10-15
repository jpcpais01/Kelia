// Wire protocol between the browser client and the game server (JSON over
// WebSocket). Snapshots use compact arrays; everything else is readable.
import type { Appearance } from './data/appearance';
import type { ClassId } from './data/classes';
import type { CharacterData, PublicCharacter } from './character';

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
}

// ---------------------------------------------------------------- client -> server
export type ClientMessage =
  | { t: 'hello'; v: number; token: string }
  | { t: 'create'; name: string; cls: ClassId; appearance: Appearance }
  | { t: 'enter' }
  | { t: 'mv'; x: number; y: number; z: number; yaw: number; st: MoveState; seq: number }
  | { t: 'chat'; text: string }
  | { t: 'emote'; e: string }
  | { t: 'ping'; c: number };

// ---------------------------------------------------------------- server -> client
/** Snapshot entity: [id, x, y, z, yaw, state, hpFraction(0-255)] */
export type SnapEntity = [number, number, number, number, number, number, number];

export type ServerMessage =
  | { t: 'welcome'; uid: string; character: CharacterData | null; serverNow: number; dayTime: number; online: number; guest: boolean }
  | { t: 'error'; code: string; message: string }
  | { t: 'nameTaken'; name: string }
  | { t: 'created'; character: CharacterData }
  | { t: 'world'; you: number; character: CharacterData; players: PublicCharacter[]; dayTime: number; serverNow: number }
  | { t: 's'; ts: number; e: SnapEntity[] }
  | { t: 'join'; p: PublicCharacter }
  | { t: 'leave'; id: number }
  | { t: 'chat'; id: number; name: string; text: string; sys?: boolean }
  | { t: 'emote'; id: number; e: string }
  | { t: 'correct'; x: number; y: number; z: number }
  | { t: 'pong'; c: number; s: number };

export const EMOTES = ['wave', 'cheer', 'sit', 'dance'] as const;
export type Emote = (typeof EMOTES)[number];

/** Round to centimetres to keep packets small. */
export const q = (v: number) => Math.round(v * 100) / 100;
