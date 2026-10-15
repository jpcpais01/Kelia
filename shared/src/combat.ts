// Small combat helpers shared by the server (authoritative hits) and the
// client (aiming, previews).
import type { ActKind } from './protocol';
import { CLASSES, type ClassId, type SkillDef } from './data/classes';
import { SKILL_UNLOCK } from './data/progression';

export function skillFor(cls: ClassId, k: ActKind, i: number): SkillDef | null {
  const c = CLASSES[cls];
  if (k === 'c') return c.combo[i] ?? null;
  if (k === 's') return c.skills[i] ?? null;
  if (k === 'd') return c.dodge;
  return null;
}

export function skillUnlocked(k: ActKind, i: number, level: number) {
  return k !== 's' || level >= (SKILL_UNLOCK[i] ?? 99);
}

/** Is (px, pz) inside the cone at (ox, oz) facing `yaw` (0 = +z)? */
export function inCone(ox: number, oz: number, yaw: number, px: number, pz: number, range: number, arc: number, targetRadius = 0) {
  const dx = px - ox;
  const dz = pz - oz;
  const d = Math.hypot(dx, dz);
  if (d > range + targetRadius) return false;
  if (d < targetRadius + 0.3) return true;
  let a = Math.atan2(dx, dz) - yaw;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  // widen the cone a little for the target's body
  return Math.abs(a) <= arc / 2 + Math.atan2(targetRadius, d);
}

/** Clamp an aimed point to at most `range` from the caster. */
export function clampAim(ox: number, oz: number, tx: number, tz: number, range: number): [number, number] {
  const dx = tx - ox;
  const dz = tz - oz;
  const d = Math.hypot(dx, dz);
  if (d <= range || d < 1e-6) return [tx, tz];
  return [ox + (dx / d) * range, oz + (dz / d) * range];
}

/** Closest distance from point P to the segment AB (2D). */
export function segmentDistance(ax: number, az: number, bx: number, bz: number, px: number, pz: number) {
  const vx = bx - ax;
  const vz = bz - az;
  const l2 = vx * vx + vz * vz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / l2)) : 0;
  return Math.hypot(ax + vx * t - px, az + vz * t - pz);
}

export const CRIT_MULTIPLIER = 1.65;
