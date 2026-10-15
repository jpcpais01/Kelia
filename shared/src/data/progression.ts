import { CLASSES, type ClassId } from './classes';
import { ITEMS, type Equipment } from './items';

export const MAX_LEVEL = 10;

/** Level at which each of the three class skills (1, 2, 3) unlocks. */
export const SKILL_UNLOCK = [1, 3, 5] as const;

/** Seconds between potions. */
export const POTION_COOLDOWN = 6;

/** Total XP needed to go from `level` to `level + 1`. */
export function xpToNext(level: number): number {
  if (level >= MAX_LEVEL) return Infinity;
  return Math.round(100 * Math.pow(level, 1.55));
}

export function passiveTotal(cls: ClassId, level: number, stat: string): number {
  let v = 0;
  for (const p of CLASSES[cls].passives) if (p.stat === stat && level >= p.level) v += p.value;
  return v;
}

export interface Stats {
  maxHp: number;
  /** Weapon power: skill damage = power × skill.power. */
  power: number;
  crit: number;
  /** Movement speed multiplier. */
  speed: number;
  /** Fraction of max health regenerated per second. */
  regen: number;
  /** Cooldown reduction (0.15 = 15% faster). */
  cdr: number;
}

/** Everything a character's level, class, passives and gear add up to. */
export function statsFor(cls: ClassId, level: number, equipment?: Equipment | null): Stats {
  const c = CLASSES[cls];
  let hp = c.baseHp + c.hpPerLevel * (level - 1);
  let power = c.basePower + c.powerPerLevel * (level - 1);
  let crit = 0.05;
  let speed = 1;
  for (const id of equipment ? [equipment.weapon, equipment.offhand, equipment.outfit] : []) {
    const s = id ? ITEMS[id]?.stats : undefined;
    if (!s) continue;
    hp += s.hp ?? 0;
    power += s.power ?? 0;
    crit += s.crit ?? 0;
    speed += s.speed ?? 0;
  }
  hp *= 1 + passiveTotal(cls, level, 'maxHp');
  power *= 1 + passiveTotal(cls, level, 'power');
  crit += passiveTotal(cls, level, 'crit');
  speed += passiveTotal(cls, level, 'speed');
  return {
    maxHp: Math.round(hp),
    power,
    crit,
    speed,
    regen: passiveTotal(cls, level, 'regen'),
    cdr: passiveTotal(cls, level, 'cooldown'),
  };
}

export function maxHpFor(cls: ClassId, level: number, equipment?: Equipment | null): number {
  return statsFor(cls, level, equipment).maxHp;
}
