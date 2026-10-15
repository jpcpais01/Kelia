import { CLASSES, type ClassId } from './classes';

export const MAX_LEVEL = 10;

/** Total XP needed to go from `level` to `level + 1`. */
export function xpToNext(level: number): number {
  if (level >= MAX_LEVEL) return Infinity;
  return Math.round(100 * Math.pow(level, 1.55));
}

export function maxHpFor(cls: ClassId, level: number): number {
  const c = CLASSES[cls];
  let hp = c.baseHp + c.hpPerLevel * (level - 1);
  for (const p of c.passives) if (p.stat === 'maxHp' && level >= p.level) hp *= 1 + p.value;
  return Math.round(hp);
}

export function passiveTotal(cls: ClassId, level: number, stat: string): number {
  let v = 0;
  for (const p of CLASSES[cls].passives) if (p.stat === stat && level >= p.level) v += p.value;
  return v;
}
