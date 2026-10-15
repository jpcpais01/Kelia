// Updrafts: columns of rising air that carry a glider up. Shared so the
// client can fly them and the server can tell a rising glider from a cheat.
import type { Vec2 } from './layout';

export interface Updraft {
  id: string;
  name: string;
  pos: Vec2;
  /** Column radius (m). */
  radius: number;
  /** Absolute height the air stops rising at. */
  top: number;
}

export const UPDRAFTS: Updraft[] = [
  // on the edge of Hearthmere, behind the market: the first taste of flight
  { id: 'windwell', name: 'Hearthmere Windwell', pos: [-36, -74], radius: 5, top: 44 },
  // at the foot of the Silverfall cliffs, up and over the northern plateau
  { id: 'silverfall', name: 'Silverfall Updraft', pos: [14, 210], radius: 5.5, top: 52 },
  // below Eagle's Perch: high enough to glide all the way down to the Ruins
  { id: 'greyspine', name: 'Greyspine Thermal', pos: [250, 282], radius: 6, top: 98 },
];

/** The updraft whose column contains (x, z), widened by `margin` metres. */
export function updraftAt(x: number, z: number, margin = 0): Updraft | null {
  for (const u of UPDRAFTS) {
    const r = u.radius + margin;
    const dx = x - u.pos[0];
    const dz = z - u.pos[1];
    if (dx * dx + dz * dz < r * r) return u;
  }
  return null;
}

/**
 * How fast an updraft lifts at height `y` (as a fraction of UPDRAFT_LIFT):
 * full strength low down, easing to nothing over the last 8 m so a glider
 * settles and bobs at the top instead of shooting out of it.
 */
export function updraftStrength(u: Updraft, y: number): number {
  const t = (u.top - y) / 8;
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}
