import { DEFAULT_APPEARANCE, type Appearance } from './data/appearance';
import { CLASSES, type ClassId } from './data/classes';
import { OUTFIT_ITEM_IDS, type Equipment, type InventorySlot } from './data/items';
import { maxHpFor } from './data/progression';
import { ARRIVAL_POINT, ARRIVAL_YAW } from './world/layout';

/** A saved character as stored in Firestore (and sent to its owner). */
export interface CharacterData {
  uid: string;
  name: string;
  cls: ClassId;
  appearance: Appearance;
  level: number;
  xp: number;
  hp: number;
  pos: [number, number, number];
  yaw: number;
  inventory: InventorySlot[];
  equipment: Equipment;
  createdAt: number;
  updatedAt: number;
  playTime: number; // seconds
  discovered: string[]; // point-of-interest ids
}

export function newCharacter(uid: string, name: string, cls: ClassId, appearance: Appearance): CharacterData {
  const c = CLASSES[cls];
  const now = Date.now();
  return {
    uid,
    name,
    cls,
    appearance: { ...DEFAULT_APPEARANCE, ...appearance },
    level: 1,
    xp: 0,
    hp: maxHpFor(cls, 1),
    pos: [ARRIVAL_POINT[0], 0, ARRIVAL_POINT[1]],
    yaw: ARRIVAL_YAW,
    inventory: [{ id: 'potion_small', qty: 3 }],
    equipment: {
      weapon: c.startingWeapon,
      offhand: c.startingOffhand ?? null,
      outfit: OUTFIT_ITEM_IDS[appearance.outfit] ?? OUTFIT_ITEM_IDS[0],
    },
    createdAt: now,
    updatedAt: now,
    playTime: 0,
    discovered: ['village'],
  };
}

/** What other players get to know about you. */
export interface PublicCharacter {
  id: number; // session entity id
  name: string;
  cls: ClassId;
  appearance: Appearance;
  level: number;
  weapon: string | null;
  offhand: string | null;
  hp: number;
  maxHp: number;
}

const NAME_RE = /^[A-Za-z][A-Za-z'-]{1,14}[A-Za-z]$/;
const BLOCKED = ['admin', 'moderator', 'gm', 'kelia', 'fuck', 'shit', 'cunt', 'nigger', 'nigga', 'faggot', 'bitch', 'whore', 'rape', 'hitler', 'nazi'];

export function validateName(name: string): string | null {
  const n = name.trim();
  if (n.length < 3) return 'Names need at least 3 letters.';
  if (n.length > 16) return 'Names can be at most 16 letters.';
  if (!NAME_RE.test(n)) return "Use letters only (an apostrophe or hyphen inside is fine).";
  if (/['-]{2}/.test(n)) return 'That name has too many marks in a row.';
  const lower = n.toLowerCase();
  if (BLOCKED.some((b) => lower.includes(b))) return 'Please choose a different name.';
  return null;
}

export function normalizeName(name: string): string {
  const n = name.trim();
  return n.charAt(0).toUpperCase() + n.slice(1);
}

export const nameKey = (name: string) => name.trim().toLowerCase();
