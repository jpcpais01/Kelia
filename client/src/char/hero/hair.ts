// Anime hair: a shell over the scalp down to the hairline, then locks —
// tapered, pointed ribbons that curl their edges round the head — laid in
// layers: bangs over the forehead, locks framing the face, the back, and per
// style a crown of spikes, a braid or a high tail. Long hair hangs from the
// head and follows the chest below the neck so it never swings through the
// shoulders when the head turns.
import { Vector3 } from '@babylonjs/core';
import { blend, Geo, lerp, one, smooth, type Weights } from './geo';
import { CHIN_Y } from './face';
import { chainWeights, type ChainJoints, type ChainName } from './chains';
import { SW, uvAlong, uvOf, type Swatch } from './palette';

/** The scalp the hair sits on (an ellipsoid just outside the skull). */
const C = new Vector3(0, 1.688, -0.012);
const R = new Vector3(0.091, 0.122, 0.106);
const DEG = Math.PI / 180;
/** How far locks stand off the head at their tips (metres). */
const VOLUME = 0.012;

/** Point on the scalp: phi round the head (0 = front, + = the hero's left), theta up from the equator, off = extra radius. */
export function scalp(phi: number, theta: number, off = 0): Vector3 {
  const p = phi * DEG;
  const t = theta * DEG;
  const k = 1 + off;
  return new Vector3(C.x + Math.sin(p) * Math.cos(t) * R.x * k, C.y + Math.sin(t) * R.y * k, C.z + Math.cos(p) * Math.cos(t) * R.z * k);
}

/** Head weight above the neck, chest weight for hair hanging below it. */
export const hairW = (p: Vector3): Weights => blend(one('head'), one('chest'), smooth(1.56, 1.4, p.y));

export type LockRegion = 'bang' | 'side' | 'back' | 'top' | 'tail' | 'long';

interface LockOpts {
  width: number;
  thick?: number;
  /** Fraction of the length where the lock is widest. */
  peak?: number;
  color?: Swatch;
  cup?: number;
  region: LockRegion;
  segs?: number;
  /** Tip sharpness: 1 = straight taper, bigger = longer point. */
  sharp?: number;
  /** The chain the lock hangs from (it swings), and how far above its first joint it starts to. */
  dyn?: ChainName;
  fade?: number;
}

export interface HairBuild {
  g: Geo;
  /** Regions to leave out (headgear covers them). */
  skip: Set<LockRegion>;
  /** Chains laid out for this style, and those something hangs from. */
  chains: ChainJoints;
  used: Set<ChainName>;
}

/** Weights for hair on a chain (or plain hair weights when it has none). */
function dynW(h: HairBuild, c: ChainName | undefined, p: Vector3, fade = 0.5): Weights {
  const joints = c && h.chains[c];
  if (!c || !joints) return hairW(p);
  h.used.add(c);
  return chainWeights(c, joints, p, hairW(p), fade);
}

/** One lock along the given points. */
function lock(h: HairBuild, pts: Vector3[], o: LockOpts) {
  if (h.skip.has(o.region)) return;
  const peak = o.peak ?? 0.25;
  const sharp = o.sharp ?? 0.95;
  // volume: each lock lifts off the head more toward its tip (on the head it
  // puffs out from the scalp, hanging below it out from the body's axis)
  pts = pts.map((p, k) => {
    const u = k / Math.max(1, pts.length - 1);
    const d = p.y > 1.56 ? p.subtract(C).multiplyByFloats(1 / R.x, 1 / R.y, 1 / R.z) : new Vector3(p.x, 0, p.z - C.z);
    if (d.lengthSquared() < 1e-8) return p;
    return p.add(d.normalize().scale(VOLUME * Math.pow(u, 0.6) * (o.region === 'bang' ? 0.6 : 1)));
  });
  const th = o.thick ?? 0.0085;
  h.g.ribbon(pts, {
    samples: 6,
    segs: o.segs ?? 8,
    width: (s) => (s < peak ? lerp(0.75, 1, Math.sin((s / peak) * Math.PI * 0.5)) : Math.pow(Math.max(0, 1 - (s - peak) / (1 - peak)), sharp)) * o.width,
    thick: (s) => th * (s < peak ? 1 : lerp(1, 0.35, (s - peak) / (1 - peak))),
    normal: (_s, p) => p.subtract(C).multiplyByFloats(1 / R.x, 1 / R.y, 1 / R.z).normalize(),
    w: (_s, p) => dynW(h, o.dyn, p, o.fade),
    uv: (s) => uvAlong(o.color ?? SW.hair, s),
    cup: (s) => -(o.cup ?? 0.006) * Math.min(1, s * 4) * (1 - s * 0.5),
    n: 2.2,
  });
}

/** The shell over the scalp down to the hairline (θ by φ in degrees). */
function cap(h: HairBuild, hairline: (phi: number) => number, off = 0.0, color: Swatch = SW.hair) {
  const rows = 12;
  const cols = 40;
  const outer: Vector3[][] = [];
  const inner: Vector3[][] = [];
  for (let i = 0; i <= rows; i++) {
    const ro: Vector3[] = [];
    const ri: Vector3[] = [];
    for (let j = 0; j < cols; j++) {
      const phi = -180 + (j / cols) * 360;
      const th = lerp(89.5, hairline(phi), Math.pow(i / rows, 0.85));
      ro.push(scalp(phi, th, off));
      ri.push(scalp(phi, th, off - 0.12));
    }
    outer.push(ro);
    inner.push(ri);
  }
  h.g.shell(outer, inner, { wrap: true, uv: () => uvOf(color), w: hairW });
}

/** Hairline: forehead, temples, over the ears, nape. */
const hairlineOf = (front: number, side: number, back: number) => (phi: number) => {
  const a = Math.abs(phi);
  if (a < 60) return lerp(front, lerp(front, side, 0.45), smooth(0, 60, a));
  if (a < 105) return lerp(lerp(front, side, 0.45), side, smooth(60, 105, a));
  return lerp(side, back, smooth(105, 180, a));
};

/** A fan of locks: bangs over the forehead. */
function bangs(h: HairBuild, list: { phi: number; len: number; curl?: number; w?: number }[], o: Partial<LockOpts> = {}) {
  // a shadowed under-layer between the bangs, so they read as separate locks with depth
  for (let i = 0; i + 1 < list.length; i++) {
    const a = list[i];
    const b = list[i + 1];
    const phi = (a.phi + b.phi) / 2;
    const len = Math.min(a.len, b.len) * 0.92;
    const curl = ((a.curl ?? 0) + (b.curl ?? 0)) / 2;
    const tipTh = lerp(26, -7, len);
    lock(
      h,
      [scalp(phi * 0.5, 70, 0.0), scalp(phi * 0.85, 50, 0.05), scalp(phi + curl * 0.5, 30, 0.08), scalp(phi + curl, tipTh + 6, 0.09), scalp(phi + curl * 1.4, tipTh, 0.08)],
      { width: 0.024, region: 'bang', peak: 0.4, sharp: 1.1, color: SW.hairDark, ...o },
    );
  }
  for (const b of list) {
    const tipTh = lerp(26, -7, b.len);
    const curl = b.curl ?? 0;
    lock(
      h,
      [scalp(b.phi * 0.5, 72, 0.02), scalp(b.phi * 0.85, 52, 0.07), scalp(b.phi + curl * 0.5, 30, 0.1), scalp(b.phi + curl, tipTh + 6, 0.11), scalp(b.phi + curl * 1.4, tipTh, 0.095)],
      { width: b.w ?? 0.03, region: 'bang', peak: 0.4, sharp: 0.85, ...o },
    );
  }
}

/** Locks framing the face, in front of the ears, ending at `endY` (metres). */
function sideLocks(h: HairBuild, endY: number, o: Partial<LockOpts> = {}, out = 0.1) {
  for (const side of [-1, 1]) {
    const tipTh = Math.asin(Math.max(-1, Math.min(1, (endY - C.y) / R.y))) / DEG;
    const pts = [scalp(side * 55, 62, 0.02), scalp(side * 72, 38, 0.07), scalp(side * 80, 8, 0.11), scalp(side * 78, lerp(8, tipTh, 0.6), out + 0.03)];
    if (endY < CHIN_Y - 0.02) {
      // long: past the jaw and down the front of the shoulder
      const jaw = scalp(side * 76, -40, out + 0.1);
      pts.push(jaw, new Vector3(side * 0.1, lerp(jaw.y, endY, 0.5), 0.045), new Vector3(side * 0.115, endY, 0.06));
    } else pts.push(scalp(side * 74, tipTh, out + 0.02));
    const long = endY < CHIN_Y - 0.02;
    const dyn: ChainName = side > 0 ? 'hair.side.l' : 'hair.side.r';
    h.chains[dyn] = long ? [pts[2], pts[4], pts[5], pts[6]] : pts.slice(1, 5);
    lock(h, pts, { width: 0.034, region: long ? 'long' : 'side', peak: long ? 0.55 : 0.4, dyn, ...o });
    lock(h, pts.slice(0, 4).map((p, i) => p.add(new Vector3(side * 0.006, -0.004 * i, -0.018 - i * 0.004))), { width: 0.032, region: 'side', peak: 0.4, color: SW.hairDark, dyn, ...o });
  }
}

/** Locks down the back of the head to `endY`, fanned from φ = 100° to 260°. */
function backLocks(h: HairBuild, endY: number, count: number, o: Partial<LockOpts> = {}, flare = 0.12) {
  backChain(h, endY);
  const long = endY < scalp(180, -38, flare + 0.02).y - 0.04;
  /** One lock's path at φ = `pp`, `inset` metres under the outer layer. */
  const path = (pp: number, jitter: number, inset: number) => {
    const k = 1 - inset;
    const pts = [scalp(pp, 70, 0.02 - inset), scalp(pp, 30, 0.07 - inset), scalp(pp, -10, 0.1 - inset)];
    const nape = scalp(pp, -38 + jitter * 6, flare + 0.02 - inset);
    pts.push(nape);
    if (long) {
      // long hair: down the back, clear of the shoulders
      const s = Math.sin(pp * DEG);
      const xs = s * 0.11;
      pts.push(
        new Vector3(xs * 1.15, lerp(nape.y, endY, 0.35), (-0.13 - Math.abs(s) * 0.02) * k),
        new Vector3(xs * 1.25, lerp(nape.y, endY, 0.7), -0.135 * k),
        new Vector3(xs * 1.35 + jitter * 0.01, endY + inset, -0.13 * k),
      );
    } else {
      const tipTh = Math.asin(Math.max(-1, Math.min(1, (endY - C.y) / R.y))) / DEG;
      pts.push(scalp(pp, tipTh + inset * 200, flare + 0.06 - inset));
    }
    return pts;
  };
  const phiOf = (t: number) => {
    const phi = lerp(102, 258, t);
    return phi > 180 ? phi - 360 : phi;
  };
  for (let i = 0; i < count; i++) {
    const jitter = Math.sin(i * 12.9898) * 0.5;
    lock(h, path(phiOf((i + 0.5) / count), jitter, 0), { width: long ? 0.046 : 0.04, region: long ? 'long' : 'back', peak: long ? 0.6 : 0.4, color: i % 3 === 1 ? SW.hairDark : SW.hair, dyn: 'hair.back', ...o });
    // and a shadowed lock tucked under the seam to the next one
    if (i + 1 < count) lock(h, path(phiOf((i + 1) / count), -jitter, 0.012), { width: long ? 0.036 : 0.03, region: long ? 'long' : 'back', peak: 0.45, color: SW.hairDark, dyn: 'hair.back', thick: 0.006, ...o });
  }
}

/** The chain down the back of the head: from the nape to `endY` (the longest hair hanging there). */
function backChain(h: HairBuild, endY: number) {
  const top = scalp(180, -12, 0.06);
  const prev = h.chains['hair.back'];
  const end = Math.min(endY - 0.05, prev ? prev[prev.length - 1].y : Infinity);
  h.chains['hair.back'] = [0, 1, 2, 3, 4].map((k) => new Vector3(0, lerp(top.y, end, k / 4), lerp(top.z, -0.14, Math.min(1, k / 2))));
}

/** Spikes swept back from the crown (tousled / spiky styles). */
function crown(h: HairBuild, n: number, lift: number) {
  for (let i = 0; i < n; i++) {
    const phi = lerp(-150, 150, (i + 0.5) / n) + Math.sin(i * 7.1) * 8;
    const back = Math.abs(phi) > 90;
    lock(h, [scalp(phi * 0.3, 84, 0.01), scalp(phi * 0.7, 66, 0.07 + lift * 0.5), scalp(phi, back ? 40 : 46, 0.1 + lift), scalp(phi * 1.05, back ? 22 : 32, 0.13 + lift)], {
      width: 0.03,
      region: 'top',
      peak: 0.3,
      sharp: 1.6,
    });
  }
}

function braid(h: HairBuild, endY: number) {
  if (h.skip.has('long')) return;
  backChain(h, endY);
  const bw = (p: Vector3) => dynW(h, 'hair.back', p);
  const top = new Vector3(0, 1.6, -0.118);
  const n = 11;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const y = lerp(top.y, endY + 0.06, t);
    const z = lerp(-0.118, -0.128, smooth(0, 0.3, t)) + Math.sin(t * 3) * 0.004;
    const r = lerp(0.024, 0.016, t);
    const tilt = (i % 2 ? 1 : -1) * 0.45;
    const ax = new Vector3(Math.sin(tilt), Math.cos(tilt), 0);
    const side = Vector3.Cross(ax, new Vector3(0, 0, 1)).normalize();
    h.g.blob(new Vector3((i % 2 ? 1 : -1) * r * 0.25, y, z), [side, ax, new Vector3(0, 0, 1)], [r, r * 1.5, r * 0.85], bw, uvOf(i % 2 ? SW.hair : SW.hairDark), { lat: 6, lon: 10 });
  }
  // the tie and a tuft
  const tie = new Vector3(0, endY + 0.04, -0.13);
  h.g.blob(tie, [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)], [0.017, 0.01, 0.016], bw, uvOf(SW.gold(7)), { lat: 6, lon: 12 });
  for (const dx of [-1, 0, 1]) {
    lock(h, [tie, tie.add(new Vector3(dx * 0.012, -0.04, -0.004)), tie.add(new Vector3(dx * 0.02, -0.085, 0.002))], { width: 0.016, region: 'long', peak: 0.2, thick: 0.009, dyn: 'hair.back' });
  }
}

function tail(h: HairBuild) {
  if (h.skip.has('tail')) return;
  const tie = scalp(180, 38, 0.06);
  h.chains['hair.tail'] = [new Vector3(0, 0.03, -0.05), new Vector3(0, -0.02, -0.12), new Vector3(0, -0.13, -0.14), new Vector3(0, -0.3, -0.11)].map((d) => tie.add(d));
  h.g.blob(tie, [new Vector3(1, 0, 0), new Vector3(0, 0.6, -0.8).normalize(), new Vector3(0, 0.8, 0.6).normalize()], [0.026, 0.014, 0.024], hairW, uvOf(SW.gold(7)), { lat: 6, lon: 12 });
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = ((i - (n - 1) / 2) / n) * 1.6;
    const sx = Math.sin(a) * 0.03;
    lock(
      h,
      [
        tie.add(new Vector3(sx * 0.3, 0.008, 0.01)),
        tie.add(new Vector3(sx * 1.2, 0.03, -0.06)),
        tie.add(new Vector3(sx * 1.8, -0.03, -0.12)),
        tie.add(new Vector3(sx * 2.0, -0.13, -0.135)),
        tie.add(new Vector3(sx * 1.6 + Math.sin(i * 3.3) * 0.02, -0.27 - Math.abs(Math.cos(i)) * 0.04, -0.11)),
      ],
      { width: 0.032, region: 'tail', peak: 0.25, thick: 0.012, color: i % 3 === 2 ? SW.hairDark : SW.hair, sharp: 1.5, dyn: 'hair.tail', fade: 0.6 },
    );
  }
  // hair swept up from the nape to the tie
  for (let i = 0; i < 6; i++) {
    const phi = lerp(115, 245, (i + 0.5) / 6);
    const pp = phi > 180 ? phi - 360 : phi;
    lock(h, [scalp(pp, -35, 0.03), scalp(pp * 0.9 + (pp > 0 ? 18 : -18), 0, 0.06), scalp(180 + (pp > 0 ? -12 : 12), 32, 0.07)], {
      width: 0.04,
      region: 'tail',
      peak: 0.5,
      sharp: 0.8,
    });
  }
}

/**
 * Build a hairstyle. 0 Tousled, 1 Long Braid, 2 Side Part, 3 High Tail,
 * 4 Buzz. `skip` leaves out what a hat or hood covers.
 */
export function buildHair(g: Geo, style: number, skip: LockRegion[] = [], soft = false): ChainJoints {
  const h: HairBuild = { g, skip: new Set(skip), chains: {}, used: new Set() };
  switch (style) {
    case 0: {
      cap(h, hairlineOf(30, -6, -42));
      bangs(h, [
        { phi: -52, len: 0.45, curl: -6 },
        { phi: -33, len: 0.75, curl: -4 },
        { phi: -14, len: 0.95, curl: 3 },
        { phi: 4, len: 0.8, curl: 6, w: 0.03 },
        { phi: 22, len: 0.9, curl: 4 },
        { phi: 40, len: 0.65, curl: 6 },
        { phi: 56, len: 0.45, curl: 8 },
      ]);
      sideLocks(h, soft ? CHIN_Y + 0.0 : CHIN_Y + 0.045);
      backLocks(h, soft ? 1.53 : 1.585, 11);
      crown(h, 13, 0.05);
      break;
    }
    case 1: {
      cap(h, hairlineOf(32, -8, -40));
      bangs(h, [
        { phi: -50, len: 0.55, curl: -8 },
        { phi: -30, len: 0.85, curl: -10 },
        { phi: -10, len: 1.0, curl: -12 },
        { phi: 10, len: 0.95, curl: -12, w: 0.03 },
        { phi: 30, len: 0.8, curl: -10 },
        { phi: 50, len: 0.55, curl: -6 },
      ]);
      sideLocks(h, soft ? 1.32 : 1.42);
      backChain(h, soft ? 1.02 : 1.1);
      backLocks(h, soft ? 1.36 : 1.5, 10, {}, 0.1);
      braid(h, soft ? 1.02 : 1.1);
      break;
    }
    case 2: {
      cap(h, hairlineOf(34, -10, -44));
      // a deep side part: everything sweeps from the hero's left to the right
      bangs(h, [
        { phi: 50, len: 0.4, curl: -10 },
        { phi: 32, len: 0.7, curl: -18 },
        { phi: 12, len: 0.95, curl: -24, w: 0.034 },
        { phi: -8, len: 1.05, curl: -22, w: 0.034 },
        { phi: -28, len: 0.9, curl: -16 },
        { phi: -48, len: 0.7, curl: -10 },
      ]);
      sideLocks(h, soft ? CHIN_Y - 0.01 : CHIN_Y + 0.02, {}, 0.12);
      backLocks(h, soft ? 1.5 : 1.56, 10, {}, 0.14);
      break;
    }
    case 3: {
      cap(h, hairlineOf(30, -4, -30));
      bangs(h, [
        { phi: -46, len: 0.5, curl: -4 },
        { phi: -26, len: 0.8, curl: -2 },
        { phi: -6, len: 0.95, curl: 2 },
        { phi: 14, len: 0.85, curl: 5 },
        { phi: 34, len: 0.7, curl: 6 },
        { phi: 52, len: 0.45, curl: 8 },
      ]);
      sideLocks(h, soft ? CHIN_Y - 0.03 : CHIN_Y + 0.03);
      tail(h);
      break;
    }
    default: {
      cap(h, hairlineOf(36, 2, -38), -0.05, SW.hairDark);
      break;
    }
  }
  const out: ChainJoints = {};
  for (const c of h.used) out[c] = h.chains[c];
  return out;
}
