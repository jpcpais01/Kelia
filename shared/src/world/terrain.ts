// Analytic terrain for Kelia's starting area. Pure functions of (x, z) so the
// client (meshes, grass, water) and the server (validation, monster AI) agree.
import { Simplex2, clamp, lerp, smoothstep } from '../noise';
import {
  HILLS,
  LAKE,
  PATHS,
  RIVER_POINTS,
  RUINS,
  SHRINE,
  VIEWPOINT,
  VILLAGE,
  WATERFALL,
  WATER_LEVEL,
  WORLD_SEED,
  type Vec2,
} from './layout';

const N = new Simplex2(WORLD_SEED);
const N2 = new Simplex2(WORLD_SEED + 101);
const N3 = new Simplex2(WORLD_SEED + 202);

// --- river geometry ---------------------------------------------------------
const RIVER_LEN: number[] = [0];
for (let i = 1; i < RIVER_POINTS.length; i++) {
  const [ax, az] = RIVER_POINTS[i - 1];
  const [bx, bz] = RIVER_POINTS[i];
  RIVER_LEN.push(RIVER_LEN[i - 1] + Math.hypot(bx - ax, bz - az));
}
export const RIVER_TOTAL = RIVER_LEN[RIVER_LEN.length - 1];
// The falls sit on segment 3 -> 4.
export const FALL_S0 = RIVER_LEN[3] + 6;
export const FALL_S1 = RIVER_LEN[3] + 13;
const RIVER_TOP_START = 31.2;
const RIVER_TOP_END = 30.2;
const RIVER_LOW_START = 7.6;

/** Water surface height along the river at arc length s. */
export function riverWaterY(s: number): number {
  if (s <= FALL_S0) return lerp(RIVER_TOP_START, RIVER_TOP_END, s / FALL_S0);
  if (s >= FALL_S1) return lerp(RIVER_LOW_START, WATER_LEVEL + 0.05, smoothstep(FALL_S1, RIVER_TOTAL, s));
  // On the falls themselves: a steep curve like water leaving a lip.
  const t = (s - FALL_S0) / (FALL_S1 - FALL_S0);
  return lerp(RIVER_TOP_END, RIVER_LOW_START, t * t * (1.6 - 0.6 * t));
}

/** River half-width at arc length s (widens toward the lake). */
export function riverHalfWidth(s: number): number {
  return lerp(3.2, 7.5, smoothstep(0, RIVER_TOTAL, s)) + 1.2 * N3.noise(s * 0.02, 3.7);
}

export interface RiverHit {
  dist: number; // horizontal distance to the centreline
  s: number; // arc length of the closest point
  dirX: number; // flow direction at the closest point
  dirZ: number;
}

const _hit: RiverHit = { dist: 0, s: 0, dirX: 0, dirZ: 1 };
/** Closest point on the river centreline. Reuses one object: copy if kept. */
export function riverQuery(x: number, z: number): RiverHit {
  let best = Infinity;
  for (let i = 1; i < RIVER_POINTS.length; i++) {
    const [ax, az] = RIVER_POINTS[i - 1];
    const [bx, bz] = RIVER_POINTS[i];
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz;
    let t = ((x - ax) * dx + (z - az) * dz) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + dx * t;
    const pz = az + dz * t;
    const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
    if (d2 < best) {
      best = d2;
      const len = Math.sqrt(len2);
      _hit.s = RIVER_LEN[i - 1] + t * len;
      _hit.dirX = dx / len;
      _hit.dirZ = dz / len;
    }
  }
  // Meander the channel a little so it isn't made of straight segments.
  _hit.dist = Math.sqrt(best) + N2.noise(x * 0.018, z * 0.018) * 4.5;
  if (_hit.dist < 0) _hit.dist = 0;
  return _hit;
}

/** Distance to the nearest dirt trail. */
export function pathDistance(x: number, z: number): number {
  let best = Infinity;
  for (const path of PATHS) {
    for (let i = 1; i < path.length; i++) {
      const [ax, az] = path[i - 1];
      const [bx, bz] = path[i];
      const dx = bx - ax;
      const dz = bz - az;
      const len2 = dx * dx + dz * dz;
      let t = ((x - ax) * dx + (z - az) * dz) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = x - (ax + dx * t);
      const ez = z - (az + dz * t);
      const d2 = ex * ex + ez * ez;
      if (d2 < best) best = d2;
    }
  }
  return Math.sqrt(best) + N.noise(x * 0.05, z * 0.05) * 0.8;
}

const dist = (x: number, z: number, c: Vec2) => Math.hypot(x - c[0], z - c[1]);

/** Edge distance of the northern plateau (positive = on the plateau). */
function plateauSide(x: number, z: number): { mask: number; sharp: number } {
  const fx = Math.abs(x - WATERFALL.center[0]);
  const edgeZ = 226 + N.noise(x * 0.008, 7.1) * 14 + fx * 0.08;
  const sharp = lerp(3.5, 38, smoothstep(26, 130, fx));
  const mask = smoothstep(edgeZ - sharp, edgeZ + sharp, z);
  return { mask, sharp };
}

/** 0..1 forest density (Whisperwood in the west, plus a few copses). */
export function forestMask(x: number, z: number): number {
  const edge = -125 + N2.noise(z * 0.006, 1.3) * 45;
  let m = smoothstep(edge + 25, edge - 35, x);
  // small copses scattered elsewhere
  const copse = smoothstep(0.55, 0.75, N3.noise(x * 0.012, z * 0.012));
  m = Math.max(m, copse * 0.8);
  // keep the village, the lake and the ruins clear
  m *= smoothstep(VILLAGE.radius + 10, VILLAGE.radius + 45, dist(x, z, VILLAGE.center));
  m *= smoothstep(LAKE.radius - 10, LAKE.radius + 25, dist(x, z, LAKE.center));
  m *= smoothstep(RUINS.radius, RUINS.radius + 30, dist(x, z, RUINS.center));
  m *= smoothstep(SHRINE.radius + 6, SHRINE.radius + 30, dist(x, z, SHRINE.center));
  return clamp(m, 0, 1);
}

/** 0..1 rocky-hills influence (Greyspine). */
export function hillsMask(x: number, z: number): number {
  const d = dist(x, z, HILLS.center) + N.noise(x * 0.01, z * 0.01) * 40;
  return smoothstep(HILLS.radius, HILLS.radius * 0.35, d);
}

function baseHeight(x: number, z: number): number {
  // Rolling meadows
  let h = 6 + N.fbm(x * 0.0032, z * 0.0032, 4) * 9 + N2.fbm(x * 0.011, z * 0.011, 3) * 2.2;
  // Forest floor is a bit lumpier
  h += forestMask(x, z) * N3.fbm(x * 0.02, z * 0.02, 3) * 2.5;
  // Greyspine Hills: ridged rock
  const hm = hillsMask(x, z);
  if (hm > 0) h += hm * (N2.ridged(x * 0.0065, z * 0.0065, 5) * 52 + 6);
  // Eagle's Perch summit
  const dv = dist(x, z, VIEWPOINT.center);
  h += 26 * Math.exp(-(dv * dv) / (2 * 42 * 42));
  // Northern plateau with Silverfall cliff
  const p = plateauSide(x, z);
  if (p.mask > 0) {
    const top = 32.5 + N3.fbm(x * 0.006, z * 0.006, 3) * 3.5;
    h = lerp(h, Math.max(h, top), p.mask);
  }
  // Mountain wall around the playable area
  const e = Math.max(Math.abs(x), Math.abs(z)) + N.noise(x * 0.01, z * 0.01) * 26;
  const m = smoothstep(415, 505, e);
  if (m > 0) h += m * (30 + N.ridged(x * 0.0045, z * 0.0045, 3) * 38 + N2.fbm(x * 0.012, z * 0.012, 3) * 14);
  return h;
}

function blendTo(h: number, target: number, w: number) {
  return h + (target - h) * w;
}

/** Ground height (m) at world position (x, z). */
export function heightAt(x: number, z: number): number {
  let h = baseHeight(x, z);

  // Village plateau and the arrival shrine: flattened, gently rounded edges.
  const dvil = dist(x, z, VILLAGE.center);
  h = blendTo(h, VILLAGE.height + N.noise(x * 0.03, z * 0.03) * 0.25, smoothstep(VILLAGE.radius + 32, VILLAGE.radius - 6, dvil));
  const dsh = dist(x, z, SHRINE.center);
  const shrineTop = VILLAGE.height + 1.4;
  h = blendTo(h, shrineTop, smoothstep(SHRINE.radius + 22, SHRINE.radius + 1, dsh));
  const dr = dist(x, z, RUINS.center);
  h = blendTo(h, 9.5, smoothstep(RUINS.radius + 30, RUINS.radius - 8, dr) * 0.92);

  // Mirror Lake basin
  const dl = dist(x, z, LAKE.center) + N2.noise(x * 0.02, z * 0.02) * 10;
  if (dl < LAKE.radius + 40) {
    const shore = WATER_LEVEL + 0.7;
    h = blendTo(h, shore, smoothstep(LAKE.radius + 40, LAKE.radius + 4, dl));
    const depth = smoothstep(LAKE.radius + 2, LAKE.radius * 0.45, dl);
    h = lerp(h, WATER_LEVEL - 0.15 - depth * 4.5, smoothstep(LAKE.radius + 6, LAKE.radius - 2, dl));
    // Lantern Isle
    const di = Math.hypot(x - 196, z + 276);
    h = blendTo(h, WATER_LEVEL + 1.1, smoothstep(14, 6, di));
  }

  // Silverrun river: banks blend to the water, the bed sits below it.
  const r = riverQuery(x, z);
  const hw = riverHalfWidth(r.s);
  const bankW = lerp(10, 26, smoothstep(FALL_S1, FALL_S1 + 60, r.s));
  if (r.dist < hw + bankW) {
    const wy = riverWaterY(r.s);
    // Banks: pull toward slightly above the water.
    const bank = smoothstep(hw + bankW, hw + 0.5, r.dist);
    const bankH = wy + 0.55 + Math.max(0, r.dist - hw) * 0.09 + N.noise(x * 0.07, z * 0.07) * 0.3;
    // Carve a valley where the land is high, raise soft levees where it's low.
    h = lerp(h, bankH, bank * (h > bankH ? 0.9 : 1));
    // Bed
    const bed = smoothstep(hw + 0.8, hw * 0.3, r.dist);
    const depth = r.s > FALL_S0 && r.s < FALL_S1 + 10 ? 2.2 : 1.1;
    h = lerp(h, wy - depth, bed);
  }
  return h;
}

/** Water surface height at (x, z), or -Infinity if there's no water here. */
export function waterAt(x: number, z: number): number {
  const dl = dist(x, z, LAKE.center);
  if (dl < LAKE.radius + 20) return WATER_LEVEL;
  const r = riverQuery(x, z);
  if (r.dist < riverHalfWidth(r.s) + 2.5) return riverWaterY(r.s);
  return -Infinity;
}

/** Ground surface colour weights used for vertex painting and grass density. */
export interface Surface {
  grass: number; // lush meadow grass
  forest: number; // dark forest floor
  rock: number;
  sand: number;
  dirt: number; // trails / village ground
}

const _surf: Surface = { grass: 0, forest: 0, rock: 0, sand: 0, dirt: 0 };
export function surfaceAt(x: number, z: number, h: number, slope: number): Surface {
  const s = _surf;
  const f = forestMask(x, z);
  const rockBySlope = smoothstep(0.16, 0.32, slope);
  const hills = hillsMask(x, z);
  const rockByHills = hills * smoothstep(0.25, 0.6, N.noise(x * 0.02, z * 0.02) * 0.5 + 0.5 + slope * 0.6);
  s.rock = clamp(Math.max(rockBySlope, rockByHills * 0.85), 0, 1);
  const w = waterAt(x, z);
  s.sand = w > -Infinity ? smoothstep(w + 0.85, w + 0.3, h) : 0;
  const pd = pathDistance(x, z);
  const vil = smoothstep(VILLAGE.radius - 4, VILLAGE.radius - 22, dist(x, z, VILLAGE.center));
  const ruins = smoothstep(RUINS.radius - 5, RUINS.radius - 22, dist(x, z, RUINS.center)) * 0.85;
  s.dirt = clamp(Math.max(smoothstep(2.0, 0.7, pd), vil * 0.55 * (0.6 + 0.4 * N2.noise(x * 0.08, z * 0.08)), ruins), 0, 1);
  s.forest = f * (1 - s.rock);
  s.grass = clamp(1 - s.rock - s.sand - s.dirt - s.forest * 0.5, 0, 1);
  return s;
}

/** Grass blade density 0..1 at a location (meadows dense, forest sparse). */
export function grassDensity(x: number, z: number, h: number, slope: number): number {
  const s = surfaceAt(x, z, h, slope);
  const w = waterAt(x, z);
  if (w > -Infinity && h < w + 0.15) return 0;
  const patchy = 0.75 + 0.25 * N3.noise(x * 0.04, z * 0.04);
  return clamp((s.grass * 1.0 + s.forest * 0.35) * (1 - s.dirt * 1.2) * (1 - s.rock) * patchy, 0, 1);
}
