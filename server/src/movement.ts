// Movement validation: the server trusts no position it can't explain.
// Walking, sprinting and dodging are bounded by speed; jumps by how high a
// jump can go; and flight by a glide budget: once a player is well above the
// ground, the highest they may be falls steadily with time (slower than any
// real glider sinks), so hanging in the air is impossible while a genuine
// glide from a cliff never comes near the limit. Updrafts reset the budget,
// up to the top of their column.
import { MAX_ACCEPTED_SPEED, MAX_WADE_DEPTH, WORLD_HALF, updraftAt, waterAt, type Heightmap } from '@kelia/shared';

/** Seconds a player may stay up before the budget starts falling. */
const AIR_GRACE = 1.5;
/** How far above the start of a flight a jump (or lag) may still carry them (m). */
const AIR_HEADROOM = 3;
/** The slowest sink accepted on average (m/s); real gliders sink 1.5 m/s or faster. */
const MIN_SINK = 1;
/** Closer than this to the ground (or water) counts as on it. */
const LOW = 1.5;
/** How far beyond an updraft's top a rider may bob. */
const UPDRAFT_OVERSHOOT = 4;

export interface AirState {
  /** When the current flight started (ms), 0 when on the ground. */
  since: number;
  /** Height the flight started at. */
  startY: number;
}

export interface Pos {
  x: number;
  y: number;
  z: number;
}

export type MoveVerdict =
  | { ok: true }
  /** Rejected: send them back where they were. */
  | { ok: false; why: 'speed' | 'bounds' | 'underground' | 'flying' | 'water' }
  /** Too high for how long they've been up: accept the move, but no higher than `y`. */
  | { ok: false; why: 'hover'; y: number };

export const newAirState = (): AirState => ({ since: 0, startY: 0 });

/**
 * Judge a reported move from `from` to `to`, `dt` seconds later. `extra` is
 * any additional horizontal distance allowed right now (dodges). Updates
 * `air` when the move is accepted (or clamped).
 */
export function judgeMove(hm: Heightmap, from: Pos, to: Pos, dt: number, extra: number, now: number, air: AirState): MoveVerdict {
  const horiz = Math.hypot(to.x - from.x, to.z - from.z);
  if (horiz > MAX_ACCEPTED_SPEED * dt + 1.2 + extra) return { ok: false, why: 'speed' };
  if (Math.abs(to.x) > WORLD_HALF - 6 || Math.abs(to.z) > WORLD_HALF - 6) return { ok: false, why: 'bounds' };
  const ground = hm.sample(to.x, to.z);
  if (to.y < ground - 1.2) return { ok: false, why: 'underground' };
  const w = waterAt(to.x, to.z);
  // standing in water too deep to wade (a glider skimming over it is fine)
  if (w > -Infinity && w - ground > MAX_WADE_DEPTH + 0.35 && to.y < w + 0.3) return { ok: false, why: 'water' };

  // the highest they may be right now
  let cap = Infinity;
  const surface = Math.max(ground, w);
  if (to.y - surface < LOW) air.since = 0;
  else {
    const lift = updraftAt(to.x, to.z, 2);
    if (lift) {
      // rising air carries them up to the top of its column, and no further
      cap = lift.top + UPDRAFT_OVERSHOOT;
      air.since = now;
      air.startY = Math.min(to.y, cap);
    } else {
      if (!air.since) {
        air.since = now;
        air.startY = to.y;
      }
      const t = (now - air.since) / 1000;
      cap = Math.max(surface + LOW, air.startY + AIR_HEADROOM - MIN_SINK * Math.max(0, t - AIR_GRACE));
    }
  }
  const y = Math.min(to.y, cap);
  // a sudden climb: a jump adds about a metre per message at most
  if (y > Math.max(ground + 5, from.y + 2.2)) return { ok: false, why: 'flying' };
  return y < to.y ? { ok: false, why: 'hover', y } : { ok: true };
}
