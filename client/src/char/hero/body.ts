// The hero's body: torso, arms, legs, hands and boots, lofted along the
// stretched rig's rest pose (a T-pose) and skinned to its bones. Clothing
// that hugs the body is the body itself, coloured in bands with crisp edges
// (shirt, sleeves, trousers, gloves); looser garments are added on top by
// outfits.ts. Builds change the silhouette (shoulders, waist, hips, limbs).
import { Vector3 } from '@babylonjs/core';
import { blend, Geo, lerp, one, smooth, type Ring, type Weights } from './geo';
import { curve } from './head';
import type { HeroRest } from './rig';
import { SW, uvOf, type Swatch } from './palette';

export interface Build {
  shoulder: number;
  chest: number;
  waist: number;
  hip: number;
  limb: number;
  bust: number;
  /** Hands and feet. */
  extremity: number;
}

export const BUILDS: Build[] = [
  { shoulder: 0.93, chest: 0.92, waist: 0.92, hip: 0.95, limb: 0.88, bust: 0, extremity: 0.97 }, // lean
  { shoulder: 1, chest: 1, waist: 1, hip: 1, limb: 1, bust: 0, extremity: 1 }, // average
  { shoulder: 1.12, chest: 1.12, waist: 1.07, hip: 1.03, limb: 1.16, bust: 0, extremity: 1.06 }, // broad
  { shoulder: 0.86, chest: 0.9, waist: 0.8, hip: 1.07, limb: 0.83, bust: 1, extremity: 0.9 }, // graceful
];

export type Sleeve = 'none' | 'short' | 'elbow' | 'long';
export type Glove = 'none' | 'fingerless' | 'glove' | 'gauntlet';

/** How the body itself is dressed (close-fitting layers). */
export interface Dress {
  top: Swatch;
  /** Torso below the waist (trousers / tunic). */
  bottom: Swatch;
  /** Waist line between them (metres). */
  waistY: number;
  /** Bare skin above this height on the chest (open collar), or none. */
  neck: number;
  sleeve: Sleeve;
  sleeveColor: Swatch;
  glove: Glove;
  gloveColor: Swatch;
  /** Gauntlet / bracer reach up the forearm (0..1). */
  gloveLen: number;
  trousers: Swatch;
  /** Boot shaft height above the ankle (metres). */
  boot: number;
  bootColor: Swatch;
  bootSole: Swatch;
}

const UP = new Vector3(0, 1, 0);
const FWD = new Vector3(0, 0, 1);
const RIGHT = new Vector3(1, 0, 0);

/**
 * Sample a banded loft: rings along s in [s0, s1] (`steps` of them plus the
 * band edges, each edge twice with the colours on either side so the colour
 * change is crisp).
 */
export function bandedLoft(
  g: Geo,
  s0: number,
  s1: number,
  steps: number,
  ringAt: (s: number) => Omit<Ring, 'uv'>,
  colorAt: (s: number) => Swatch,
  cuts: number[],
  opts: { segs?: number; capStart?: number; capEnd?: number; t0?: number } = {},
) {
  const ss: { s: number; side: -1 | 0 | 1 }[] = [];
  for (let i = 0; i <= steps; i++) ss.push({ s: lerp(s0, s1, i / steps), side: 0 });
  for (const c of cuts) {
    if (c <= s0 || c >= s1) continue;
    ss.push({ s: c, side: -1 }, { s: c, side: 1 });
  }
  ss.sort((a, b) => a.s - b.s || a.side - b.side);
  // drop plain samples too close to a cut (thin slivers)
  const span = (s1 - s0) / steps;
  const kept = ss.filter((x) => x.side !== 0 || !cuts.some((c) => Math.abs(c - x.s) < span * 0.3 && c > s0 && c < s1));
  const rings: Ring[] = kept.map(({ s, side }) => {
    const r = ringAt(s);
    const eps = (s1 - s0) * 1e-4 * side;
    return { ...r, uv: uvOf(colorAt(s + eps)) };
  });
  return g.loft(rings, opts);
}

/** A point and tangent along a polyline at arc length d (clamped, extrapolated past the ends). */
export function along(pts: Vector3[], d: number): { p: Vector3; t: Vector3 } {
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const seg = pts[i + 1].subtract(pts[i]);
    const l = seg.length();
    if (d <= acc + l || i + 2 === pts.length) {
      const t = seg.scale(1 / l);
      // smooth the tangent across the joint
      let tan = t;
      const k = (d - acc) / l;
      if (k > 0.8 && i + 2 < pts.length) {
        const nt = pts[i + 2].subtract(pts[i + 1]).normalize();
        tan = Vector3.Lerp(t, nt, smooth(0.8, 1.2, k) * 0.5).normalize();
      } else if (k < 0.2 && i > 0) {
        const pt = pts[i].subtract(pts[i - 1]).normalize();
        tan = Vector3.Lerp(pt, t, 0.5 + smooth(-0.2, 0.2, k) * 0.5).normalize();
      }
      return { p: pts[i].add(t.scale(d - acc)), t: tan };
    }
    acc += l;
  }
  return { p: pts[pts.length - 1].clone(), t: UP.clone() };
}

/** Section axes for a limb: x stays close to `side`, z faces `front`. */
function frame(t: Vector3, front: Vector3): { x: Vector3; z: Vector3 } {
  const z = front.subtract(t.scale(Vector3.Dot(front, t))).normalize();
  const x = Vector3.Cross(t, z).normalize();
  return { x, z };
}

export interface BodyParts {
  rest: HeroRest;
  build: Build;
  dress: Dress;
}

const TORSO = {
  a: [[0.83, 0.1], [0.87, 0.138], [0.93, 0.15], [0.99, 0.143], [1.05, 0.128], [1.12, 0.13], [1.2, 0.142], [1.28, 0.155], [1.35, 0.158], [1.41, 0.152], [1.455, 0.124], [1.49, 0.084], [1.515, 0.052]] as [number, number][],
  f: [[0.83, 0.06], [0.87, 0.08], [0.93, 0.086], [0.99, 0.083], [1.05, 0.079], [1.12, 0.083], [1.2, 0.093], [1.28, 0.103], [1.35, 0.1], [1.41, 0.086], [1.455, 0.066], [1.49, 0.05], [1.515, 0.044]] as [number, number][],
  b: [[0.83, 0.07], [0.87, 0.09], [0.93, 0.1], [0.99, 0.09], [1.05, 0.077], [1.12, 0.076], [1.2, 0.082], [1.28, 0.088], [1.35, 0.089], [1.41, 0.085], [1.455, 0.075], [1.49, 0.058], [1.515, 0.05]] as [number, number][],
};

/** The torso's section at height y for a build: half width, front and back depth, squareness. */
export function torsoRing(y: number, B: Build): { a: number; f: number; b: number; n: number; bust: number } {
  // shoulders → chest → waist → hips
  const sh = smooth(1.33, 1.43, y);
  const ch = smooth(1.12, 1.24, y) * (1 - sh);
  const wa = smooth(0.95, 1.03, y) * (1 - smooth(1.08, 1.18, y));
  const hi = 1 - smooth(0.97, 1.04, y);
  const rest = Math.max(0, 1 - sh - ch - wa - hi);
  const k = sh * B.shoulder + ch * B.chest + wa * B.waist + hi * B.hip + rest;
  const bust = B.bust * Math.exp(-(((y - 1.275) / 0.05) ** 2));
  return {
    a: curve(TORSO.a, y) * k,
    f: curve(TORSO.f, y) * lerp(1, k, 0.6) * (1 + 0.04 * bust),
    b: curve(TORSO.b, y) * lerp(1, k, 0.5),
    n: lerp(2.2, 2.35, smooth(1.3, 1.45, y)),
    bust,
  };
}

/** Radial bulge of the bust at section angle t. */
export const bustBulge = (bust: number) =>
  bust > 0.01 ? (t: number) => 1 + 0.2 * bust * (Math.exp(-(((t - (Math.PI / 2 - 0.55)) / 0.36) ** 2)) + Math.exp(-(((t - (Math.PI / 2 + 0.55)) / 0.36) ** 2))) : undefined;

/** Torso skin weights: hips → spine → chest, the lower pelvis partly on the thighs. */
export function torsoWeights(p: Vector3): Weights {
  let w = blend(one('hips'), one('spine'), smooth(0.99, 1.09, p.y));
  w = blend(w, one('chest'), smooth(1.16, 1.26, p.y));
  const leg = 0.35 * smooth(0.95, 0.86, p.y) * smooth(0.03, 0.11, Math.abs(p.x));
  if (leg > 0) w = blend(w, one(p.x > 0 ? 'upperleg.l' : 'upperleg.r'), leg);
  return w;
}

/** Torso: pelvis to the base of the neck. */
export function buildTorso(g: Geo, { build: B, dress: D }: BodyParts) {
  const ringAt = (y: number): Omit<Ring, 'uv'> => {
    const t = torsoRing(y, B);
    return { c: new Vector3(0, y, 0), x: RIGHT, z: FWD, a: t.a, f: t.f, b: t.b, n: t.n, r: bustBulge(t.bust), w: torsoWeights };
  };
  const neck = D.neck;
  bandedLoft(
    g,
    0.83,
    1.515,
    30,
    ringAt,
    (y) => (y > neck ? SW.skin : y > D.waistY ? D.top : D.bottom),
    [D.waistY, neck],
    { segs: 36, capStart: 0.035, capEnd: 0.01, t0: -Math.PI / 2 },
  );
}

/** Rest positions of a limb chain. */
function chain(rest: HeroRest, names: string[]) {
  return names.map((n) => rest.pos(n));
}

export function buildArm(g: Geo, side: 1 | -1, { rest, build: B, dress: D }: BodyParts) {
  const s = side > 0 ? 'l' : 'r';
  const pts = chain(rest, [`upperarm.${s}`, `lowerarm.${s}`, `wrist.${s}`]);
  const upper = Vector3.Distance(pts[0], pts[1]);
  const total = upper + Vector3.Distance(pts[1], pts[2]);
  const L = B.limb;
  const rad: [number, number][] = [[-0.07, 0.05], [0, 0.056], [0.06, 0.052], [0.14, 0.046], [0.22, 0.042], [upper, 0.037], [upper + 0.05, 0.04], [upper + 0.12, 0.036], [total - 0.06, 0.03], [total, 0.025]];
  const sleeveEnd = D.sleeve === 'none' ? -1 : D.sleeve === 'short' ? 0.13 : D.sleeve === 'elbow' ? upper + 0.02 : total - 0.035;
  const gloveStart = D.glove === 'none' ? 99 : total - 0.03 - D.gloveLen * 0.2;
  const ringAt = (d: number): Omit<Ring, 'uv'> => {
    const { p, t } = along(pts, Math.max(0, d));
    if (d < 0) p.addInPlace(t.scale(d));
    const { x, z } = frame(t, FWD);
    const r = curve(rad, d) * L;
    const wristFlat = smooth(total - 0.12, total, d);
    const sleeveK = d < sleeveEnd ? 1.06 : 1;
    const gloveK = d > gloveStart ? 1.08 : 1;
    let w = d < 0.03 ? blend(one('chest'), one(`upperarm.${s}`), smooth(-0.06, 0.03, d)) : one(`upperarm.${s}`);
    w = blend(w, one(`lowerarm.${s}`), smooth(upper - 0.04, upper + 0.03, d));
    w = blend(w, one(`hand.${s}`), 0.45 * smooth(total - 0.03, total + 0.01, d));
    return {
      c: p,
      x,
      z,
      // x is the arm's up/down in the T-pose: flatter at the wrist (palm down)
      a: r * lerp(1, 0.82, wristFlat) * sleeveK * gloveK,
      f: r * lerp(1, 1.12, wristFlat) * sleeveK * gloveK * (d > 0.02 && d < upper ? 1.04 : 1),
      b: r * lerp(1, 1.12, wristFlat) * sleeveK * gloveK,
      w,
    };
  };
  const colorAt = (d: number) => (d < sleeveEnd ? D.sleeveColor : d > gloveStart ? D.gloveColor : SW.skin);
  bandedLoft(g, -0.07, total, 20, ringAt, colorAt, [sleeveEnd, gloveStart], { segs: 18, capStart: 0.02, capEnd: 0.012 });
  // the shoulder's round cap
  const sh = pts[0].add(new Vector3(side * 0.012, 0.004, -0.004));
  const ax = pts[1].subtract(pts[0]).normalize();
  const shK = (B.shoulder + L) / 2;
  g.blob(
    sh,
    [ax, UP, FWD],
    [0.062 * shK, 0.058 * shK, 0.056 * shK],
    (p) => blend(one('chest'), one(`upperarm.${s}`), smooth(-0.02, 0.05, Vector3.Dot(p.subtract(pts[0]), ax))),
    uvOf(D.sleeve === 'none' ? SW.skin : D.sleeveColor),
    { lat: 9, lon: 14 },
  );
}

/** A fist (weapons sit in the grip) in skin or glove colour. */
export function buildHand(g: Geo, side: 1 | -1, { rest, build: B, dress: D }: BodyParts) {
  const s = side > 0 ? 'l' : 'r';
  const hand = rest.pos(`hand.${s}`);
  const wrist = rest.pos(`wrist.${s}`);
  const ax = hand.subtract(wrist).normalize();
  const k = B.extremity;
  const col = uvOf(D.glove === 'none' || D.glove === 'fingerless' ? SW.skin : D.gloveColor);
  const back = uvOf(D.glove === 'none' ? SW.skin : D.gloveColor);
  const w = one(`hand.${s}`);
  const at = (a: number, y: number, z: number) => hand.add(ax.scale(a * k)).add(new Vector3(0, y * k, z * k));
  // back of the hand / knuckles
  g.blob(at(0.035, 0.003, 0), [ax, UP, FWD], [0.042 * k, 0.019 * k, 0.04 * k], w, back, { lat: 8, lon: 14, n: 2.6 });
  // curled fingers under the palm
  g.blob(at(0.056, -0.022, -0.002), [ax, UP, FWD], [0.024 * k, 0.022 * k, 0.038 * k], w, col, { lat: 8, lon: 14, n: 2.4 });
  // thumb wrapped round the front
  const tb = at(0.022, -0.008, 0.034);
  const tip = at(0.05, -0.03, 0.03);
  const td = tip.subtract(tb);
  const tl = td.length();
  td.normalize();
  const tx = Vector3.Cross(td, FWD).normalize();
  g.blob(tb.add(td.scale(tl / 2)), [td, tx, Vector3.Cross(td, tx)], [tl / 2 + 0.008, 0.012 * k, 0.012 * k], w, col, { lat: 6, lon: 10 });
}

/** Legs (trousers or skin) from the pelvis to the ankle. */
export function buildLeg(g: Geo, side: 1 | -1, { rest, build: B, dress: D }: BodyParts) {
  const s = side > 0 ? 'l' : 'r';
  const pts = chain(rest, [`upperleg.${s}`, `lowerleg.${s}`, `foot.${s}`]);
  const thigh = Vector3.Distance(pts[0], pts[1]);
  const total = thigh + Vector3.Distance(pts[1], pts[2]);
  const L = lerp(1, B.limb, 0.7);
  const H = B.hip;
  const rad: [number, number][] = [[-0.09, 0.088], [0, 0.088], [0.1, 0.081], [0.22, 0.07], [thigh - 0.05, 0.056], [thigh, 0.051], [thigh + 0.08, 0.054], [thigh + 0.15, 0.054], [thigh + 0.28, 0.042], [total - 0.04, 0.034], [total, 0.032]];
  const ringAt = (d: number): Omit<Ring, 'uv'> => {
    const { p, t } = along(pts, Math.max(0, d));
    if (d < 0) p.addInPlace(t.scale(d));
    const { x, z } = frame(t, FWD);
    const r = curve(rad, d) * L * lerp(H, 1, smooth(0, 0.3, d));
    const calf = Math.exp(-(((d - thigh - 0.12) / 0.08) ** 2));
    const thighFront = Math.exp(-(((d - 0.12) / 0.12) ** 2));
    let w = d < 0.04 ? blend(one('hips'), one(`upperleg.${s}`), smooth(-0.08, 0.04, d)) : one(`upperleg.${s}`);
    w = blend(w, one(`lowerleg.${s}`), smooth(thigh - 0.05, thigh + 0.04, d));
    w = blend(w, one(`foot.${s}`), 0.4 * smooth(total - 0.04, total + 0.02, d));
    const boot = d > total - D.boot ? 1.1 : 1;
    return { c: p, x, z, a: r * 0.96 * boot, f: r * (1 + 0.06 * thighFront) * boot, b: r * (1 + 0.14 * calf) * boot, w };
  };
  bandedLoft(g, -0.09, total, 22, ringAt, (d) => (d > total - D.boot ? D.bootColor : D.trousers), [total - D.boot], { segs: 20, capStart: 0.03, capEnd: 0.02 });
  buildBoot(g, side, pts[2], rest.pos(`toes.${s}`), B, D);
}

/** Boot or shoe: heel under the ankle to a rounded toe, flat sole. */
function buildBoot(g: Geo, side: 1 | -1, ankle: Vector3, toes: Vector3, B: Build, D: Dress) {
  const s = side > 0 ? 'l' : 'r';
  const k = B.extremity;
  const heel = ankle.z - 0.06 * k;
  const tip = toes.z + 0.085 * k;
  const x0 = ankle.x + side * 0.002;
  // z, half width, top height, toe-up
  const prof: [number, number, number][] = [
    [heel, 0.03, 0.075],
    [heel + 0.02, 0.038, 0.1],
    [ankle.z + 0.01, 0.042, 0.11],
    [toes.z - 0.02, 0.046, 0.068],
    [toes.z + 0.03, 0.046, 0.052],
    [tip - 0.025, 0.04, 0.042],
    [tip, 0.022, 0.032],
  ];
  const rings: Ring[] = [];
  const soleH = 0.016;
  for (let i = 0; i < prof.length; i++) {
    const [z, a, top] = prof[i];
    const h = top * k;
    const cy = h / 2;
    const toeW = smooth(toes.z - 0.03, toes.z + 0.02, z);
    rings.push({
      c: new Vector3(x0, cy, z),
      x: RIGHT,
      z: UP,
      a: a * k,
      f: h / 2,
      b: h / 2,
      n: 3,
      w: blend(one(`foot.${s}`), one(`toes.${s}`), toeW),
      uv: (t, p) => uvOf(p.y < soleH ? D.bootSole : D.bootColor),
    });
  }
  g.loft(rings, { segs: 20, capStart: 0.012, capEnd: 0.012, t0: -Math.PI / 2 });
}
