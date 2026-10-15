// The stylized vegetation models, built in code. Crowns are clouds of
// camera-facing leaf cards (painted leaf clusters from the foliage atlas)
// around an opaque core, with shading normals that point away from the crown
// centre: every tree reads as a few big, soft, sunlit balls of leaves with a
// ragged leafy silhouette, the way hand-painted anime trees do.
//
// Every builder takes a LOD: 0 close-up, 1 mid, 2 far, 3 shadow proxy (a
// cheap opaque stand-in that only the shadow map sees).
import { Color3, VertexData } from '@babylonjs/core';
import { Simplex2 } from '@kelia/shared';
import type { AtlasCell } from './leafAtlas';
import { MeshBuilder2, mulberry, normalize } from './meshgen';

export interface Built {
  data: VertexData;
  /** Billboard corners (null for meshes without leaf cards). */
  corners: Float32Array | null;
}

type C3 = [number, number, number];
const hex = (h: string): C3 => {
  const c = Color3.FromHexString(h).toLinearSpace();
  return [c.r, c.g, c.b];
};
const mix3 = (a: C3, b: C3, t: number): C3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale3 = (a: C3, s: number): C3 => [a[0] * s, a[1] * s, a[2] * s];

const noise = new Simplex2(4242);

/**
 * Set while building a tree's horizon LOD: the far band's geometry with only
 * the trunk for wood. Past a few hundred metres a tree is a few dozen pixels
 * tall and its limbs (half its triangles) are thinner than a pixel.
 */
let horizon = false;

/** Build a type's horizon stand-in (its far LOD, stripped of invisible detail). */
export function buildHorizon(build: () => Built): Built {
  horizon = true;
  try {
    return build();
  } finally {
    horizon = false;
  }
}

function done(b: MeshBuilder2): Built {
  return { data: b.toVertexData(), corners: b.cornerData() };
}

interface Palette {
  /** Shadowed underside of the crown. */
  low: C3;
  /** Sunlit top of the crown. */
  high: C3;
  /** Inner core (seen through gaps). */
  core: C3;
}

interface Crown {
  center: C3;
  radius: C3;
  /** Leaf clumps; `s` overrides the sway weight (clumps out on a limb move with it). */
  clumps: { c: C3; r: number; s?: number; main?: boolean }[];
}

/** Fill a crown with leaf cards. `per` = cards per clump, `grow` = card size × clump radius. */
function leafCards(
  b: MeshBuilder2,
  crown: Crown,
  pal: Palette,
  per: number,
  grow: number,
  cell: AtlasCell,
  rnd: () => number,
  sway: number,
  accent?: { color: C3; share: number },
  o: { shell?: number; local?: number } = {},
) {
  const { center, radius } = crown;
  const lw = o.local ?? 0.38;
  for (const cl of crown.clumps) {
    const cs = cl.s ?? sway;
    const tint = 0.9 + rnd() * 0.2;
    // bigger clumps get more cards, so every mass is equally dense
    const cnt = o.local !== undefined ? Math.max(2, Math.round(per * Math.pow(cl.r / 1.3, 2))) : per;
    for (let i = 0; i < cnt; i++) {
      // biased toward the clump surface, so the cards build the silhouette
      const u = rnd() * 2 - 1;
      const th = rnd() * Math.PI * 2;
      const sq = Math.sqrt(1 - u * u);
      const d = (0.35 + 0.5 * Math.cbrt(rnd())) * cl.r;
      const p: C3 = [cl.c[0] + sq * Math.cos(th) * d, cl.c[1] + u * d * 0.85, cl.c[2] + sq * Math.sin(th) * d];
      // shading normal: mostly the whole crown, a little the clump
      const nc = [(p[0] - center[0]) / radius[0], (p[1] - center[1]) / radius[1], (p[2] - center[2]) / radius[2]];
      const nl = [(p[0] - cl.c[0]) / cl.r, (p[1] - cl.c[1]) / cl.r, (p[2] - cl.c[2]) / cl.r];
      const n = normalize([nc[0] * (1 - lw) + nl[0] * lw, nc[1] * (1 - lw) + nl[1] * lw + 0.12, nc[2] * (1 - lw) + nl[2] * lw]);
      const h = Math.min(1, Math.max(0, (p[1] - (center[1] - radius[1])) / (radius[1] * 2)));
      let col = mix3(pal.low, pal.high, Math.pow(h, 0.85));
      // the outer shell catches more light than the inner leaves
      col = scale3(col, tint * (0.82 + 0.25 * (d / cl.r)));
      if (accent && rnd() < accent.share) col = scale3(accent.color, 0.9 + rnd() * 0.2);
      b.card(p, cl.r * grow * (0.8 + rnd() * 0.4), n, col, cs, cell, rnd() * Math.PI * 2);
    }
  }
  // a thin shell over the whole crown closes the gaps between clumps
  const shell = Math.round(per * crown.clumps.length * (o.shell ?? 0.3));
  for (let i = 0; i < shell; i++) {
    const u = rnd() * 1.6 - 0.6;
    const th = rnd() * Math.PI * 2;
    const sq = Math.sqrt(1 - u * u);
    const k = 0.72 + rnd() * 0.18;
    const p: C3 = [center[0] + sq * Math.cos(th) * radius[0] * k, center[1] + u * radius[1] * k, center[2] + sq * Math.sin(th) * radius[2] * k];
    const n = normalize([(p[0] - center[0]) / radius[0], (p[1] - center[1]) / radius[1] + 0.12, (p[2] - center[2]) / radius[2]]);
    const h = Math.min(1, Math.max(0, (p[1] - (center[1] - radius[1])) / (radius[1] * 2)));
    const col = scale3(mix3(pal.low, pal.high, Math.pow(h, 0.85)), 0.88 + rnd() * 0.16);
    const r0 = crown.clumps[0].r;
    b.card(p, r0 * grow * (0.9 + rnd() * 0.3), n, col, sway, cell, rnd() * Math.PI * 2);
  }
}

/** Opaque inner volume so the crown never shows sky through its middle. */
function core(b: MeshBuilder2, crown: Crown, pal: Palette, shrink: number, sway: number, subdiv = 1) {
  const { center, radius } = crown;
  // the same gradient as the leaves, a touch deeper: it reads as inner foliage through the gaps
  const lo = mix3(pal.core, pal.low, 0.5);
  const hi = mix3(pal.low, pal.high, 0.45);
  b.blob(center, [radius[0] * shrink, radius[1] * shrink, radius[2] * shrink], subdiv, noise, 0.25, lo, hi, center, sway, 0.5);
}

// ------------------------------------------------------------------ branching

type Clump = { c: C3; r: number; s: number; main?: boolean };

/** One grown branch: a curve with a radius and sway weight per point. */
interface Limb {
  pts: C3[];
  radii: number[];
  sways: number[];
  depth: number;
}

interface Level {
  /** Children per parent branch. */
  n: [number, number];
  /** Where along the parent they sprout (0..1). */
  at: [number, number];
  /** Angle away from the parent's direction (radians). */
  angle: [number, number];
  /** Length as a share of the parent's. */
  len: [number, number];
  /** Start radius as a share of the parent's radius there; end radius share of the start. */
  r: number;
  taper: number;
  /** Curve points. */
  steps: number;
  /** Pull toward the sky (+) or droop (−) over the branch's length. */
  bend: number;
  wobble: number;
  /** Grow a leaf clump at the tip, of this radius range. */
  clump?: [number, number];
}

interface TreeSpec {
  trunkLen: number;
  trunkR: [number, number];
  lean: C3;
  trunkSteps: number;
  gnarl: number;
  /** Main limbs fork from the trunk top, spreading out at `angle` from vertical. */
  limbs: Level;
  /** Deeper levels: secondary branches, then twigs. */
  levels: Level[];
}

const UP: C3 = [0, 1, 0];
const add3 = (a: C3, b: C3): C3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const lerp = (a: [number, number], t: number) => a[0] + (a[1] - a[0]) * t;

/** A direction `angle` away from `d`, turned `az` around it. */
function deflect(d: C3, angle: number, az: number): C3 {
  const n = normalize(d) as C3;
  const ref: C3 = Math.abs(n[1]) < 0.95 ? UP : [1, 0, 0];
  const u = normalize([ref[1] * n[2] - ref[2] * n[1], ref[2] * n[0] - ref[0] * n[2], ref[0] * n[1] - ref[1] * n[0]]);
  const v: C3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  return normalize([
    n[0] * ca + (u[0] * Math.cos(az) + v[0] * Math.sin(az)) * sa,
    n[1] * ca + (u[1] * Math.cos(az) + v[1] * Math.sin(az)) * sa,
    n[2] * ca + (u[2] * Math.cos(az) + v[2] * Math.sin(az)) * sa,
  ]) as C3;
}

/** March a curve from `base` along `dir`, bending toward (or away from) the sky. */
function curve(base: C3, dir: C3, len: number, steps: number, bend: number, wobble: number, rnd: () => number): C3[] {
  const pts: C3[] = [base];
  let d = normalize(dir) as C3;
  let p = base;
  const step = len / steps;
  for (let i = 0; i < steps; i++) {
    d = normalize([
      d[0] + (rnd() - 0.5) * wobble,
      d[1] + bend / steps + (rnd() - 0.5) * wobble * 0.5,
      d[2] + (rnd() - 0.5) * wobble,
    ]) as C3;
    p = add3(p, [d[0] * step, d[1] * step, d[2] * step]);
    pts.push(p);
  }
  return pts;
}

/** Sway weight for a point this far (in metres of wood) out from the trunk. */
const swayAt = (out: number) => 0.05 + 0.62 * Math.min(1, out / 5.5);

/**
 * Grow a whole tree skeleton: a curved trunk forking into limbs, each limb
 * splitting into branches and twigs, with leaf clumps at the tips. The
 * skeleton is the same at every LOD (only what gets meshed changes), so the
 * crown never changes shape when a tree swaps detail level.
 */
function growTree(spec: TreeSpec, rnd: () => number): { limbs: Limb[]; clumps: Clump[] } {
  const limbs: Limb[] = [];
  const clumps: Clump[] = [];
  const trunkPts = curve([0, -0.4, 0], spec.lean, spec.trunkLen, spec.trunkSteps, 0.05, spec.gnarl, rnd);
  const tr = trunkPts.map((_, i) => {
    const t = i / (trunkPts.length - 1);
    // a flared foot, then an even taper
    return lerp(spec.trunkR, t) + spec.trunkR[0] * 0.55 * Math.pow(Math.max(0, 1 - t * 4), 2);
  });
  limbs.push({ pts: trunkPts, radii: tr, sways: trunkPts.map((_, i) => (i / (trunkPts.length - 1)) * 0.05), depth: 0 });

  const grow = (parent: Limb, lv: number, outBase: number) => {
    const L = lv === 0 ? spec.limbs : spec.levels[lv - 1];
    if (!L) return;
    const count = Math.round(lerp(L.n, rnd()));
    const az0 = rnd() * Math.PI * 2;
    const plen = parent.pts.reduce((acc, p, i) => (i ? acc + Math.hypot(p[0] - parent.pts[i - 1][0], p[1] - parent.pts[i - 1][1], p[2] - parent.pts[i - 1][2]) : 0), 0);
    for (let k = 0; k < count; k++) {
      // main limbs all fork from the trunk top; deeper branches spread along their parent
      const t = lv === 0 ? 1 - rnd() * 0.12 : lerp(L.at, count === 1 ? 0.5 : k / (count - 1)) + (rnd() - 0.5) * 0.08;
      const fi = Math.min(parent.pts.length - 1.001, Math.max(0, t * (parent.pts.length - 1)));
      const i0 = Math.floor(fi);
      const ft = fi - i0;
      const a = parent.pts[i0];
      const b = parent.pts[i0 + 1];
      const base: C3 = [a[0] + (b[0] - a[0]) * ft, a[1] + (b[1] - a[1]) * ft, a[2] + (b[2] - a[2]) * ft];
      const pdir: C3 = lv === 0 ? UP : normalize([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
      // golden-angle spiral so siblings never bunch up on one side
      const az = az0 + k * (lv === 0 ? (Math.PI * 2) / count : 2.39996) + (rnd() - 0.5) * 0.6;
      let dir = deflect(pdir, lerp(L.angle, rnd()), az);
      // side branches never point back down into the crown
      if (lv > 0 && dir[1] < -0.2) dir = normalize([dir[0], -0.2, dir[2]]) as C3;
      const len = (lv === 0 ? 1 : plen) * lerp(L.len, rnd());
      const pts = curve(base, dir, len, L.steps, L.bend, L.wobble, rnd);
      const pr = parent.radii[i0] + (parent.radii[i0 + 1] - parent.radii[i0]) * ft;
      const r0 = pr * L.r;
      const out0 = outBase + (lv === 0 ? 0 : t * plen);
      const radii: number[] = [];
      const sways: number[] = [];
      let acc = 0;
      pts.forEach((p, i) => {
        if (i) acc += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1], p[2] - pts[i - 1][2]);
        const q = i / (pts.length - 1);
        radii.push(r0 * (1 - (1 - L.taper) * Math.pow(q, 0.8)));
        sways.push(swayAt(out0 + acc));
      });
      const limb: Limb = { pts, radii, sways, depth: lv + 1 };
      limbs.push(limb);
      if (L.clump) clumps.push({ c: pts[pts.length - 1], r: lerp(L.clump, rnd()), s: Math.min(0.85, sways[sways.length - 1] + 0.12), main: lv === 0 });
      grow(limb, lv + 1, out0);
    }
  };
  grow(limbs[0], 0, 0);
  return { limbs, clumps };
}

/** The envelope of a set of clumps, for crown-wide shading normals. */
function envelope(clumps: Clump[]): Crown {
  const lo: C3 = [1e9, 1e9, 1e9];
  const hi: C3 = [-1e9, -1e9, -1e9];
  for (const cl of clumps) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], cl.c[k] - cl.r);
      hi[k] = Math.max(hi[k], cl.c[k] + cl.r);
    }
  }
  const center: C3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const radius: C3 = [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2];
  return { center, radius, clumps };
}

/** Mesh the wood: deeper branches drop out at lower detail. */
function meshWood(b: MeshBuilder2, limbs: Limb[], lod: number, bark: C3, maxDepth: number[], segs: number[][], colorAt?: (l: Limb, i: number) => C3) {
  for (const l of limbs) {
    if (l.depth > maxDepth[lod] || (horizon && l.depth > 0)) continue;
    const sg = horizon ? 4 : segs[lod][Math.min(l.depth, segs[lod].length - 1)];
    let pts = l.pts;
    let radii = l.radii;
    let sways = l.sways;
    // far away, every other curve point is plenty
    if ((lod >= 2 || (lod === 1 && l.depth >= 2)) && pts.length > 3) {
      const keep = pts.map((_, i) => i % 2 === 0 || i === pts.length - 1);
      pts = pts.filter((_, i) => keep[i]);
      radii = radii.filter((_, i) => keep[i]);
      sways = sways.filter((_, i) => keep[i]);
    }
    const tint = scale3(bark, l.depth === 0 ? 1 : 1.08 + l.depth * 0.04);
    b.tube(pts, radii, sways, sg, tint, { shade: l.depth === 0 ? [0.62, 1] : [0.86, 1.06], colorAt: colorAt && lod === 0 ? (i) => colorAt(l, i) : undefined });
  }
}

/** Buttress roots spreading from the trunk foot into the ground. */
function roots(b: MeshBuilder2, rnd: () => number, n: number, r: number, bark: C3, segs: number) {
  const a0 = rnd() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * Math.PI * 2 + (rnd() - 0.5) * 0.5;
    const len = r * (2.4 + rnd() * 1.6);
    const pts: C3[] = [];
    const radii: number[] = [];
    for (let k = 0; k <= 4; k++) {
      const t = k / 4;
      // hugging the trunk, then arching out and diving into the soil
      const d = r * 0.35 + len * t;
      pts.push([Math.cos(a) * d, 0.9 * (1 - t) * (1 - t) + 0.05 - 0.3 * t * t, Math.sin(a) * d]);
      radii.push(r * (0.5 - 0.4 * t));
    }
    b.tube(pts, radii, [0, 0, 0, 0, 0], segs, scale3(bark, 0.92), { shade: [0.7, 0.85] });
  }
}

/** Small inner foliage volumes per clump: the crown stays solid where it should be, open between masses. */
function clumpCores(b: MeshBuilder2, crown: Crown, pal: Palette, lod: number, shrink = 0.5) {
  // deep inner shade: glimpsed through the leaves, never a lit ball of its own
  const lo = scale3(pal.core, 0.85);
  const hi = mix3(pal.core, pal.low, 0.7);
  // only the big masses at the limb ends get one; small clumps stay airy
  for (const cl of crown.clumps) {
    if (!cl.main) continue;
    const r = cl.r * shrink;
    // slightly below the clump centre: the lit top stays all leaves
    b.blob([cl.c[0], cl.c[1] - cl.r * 0.12, cl.c[2]], [r, r * 0.8, r], lod === 0 ? 1 : lod === 1 ? 0 : -1, noise, 0.25, lo, hi, crown.center, (cl.s ?? 0.6) - 0.1, 0.5);
  }
}

// ------------------------------------------------------------------ broadleaf

const OAK_PALETTES: Palette[] = [
  { low: hex('#1f5a3a'), high: hex('#9ad24e'), core: hex('#1c4a30') },
  { low: hex('#2a6234'), high: hex('#b4d84e'), core: hex('#22502c') },
  { low: hex('#1b5444'), high: hex('#7fcb5a'), core: hex('#18463a') },
];

// radial segments per branch depth, per LOD
const WOOD_SEGS = [
  [10, 7, 5, 4],
  [7, 5, 3],
  [5, 3],
  [5, 3],
];

/** Far away the small clumps fold into the big ones at the limb ends. */
function farClumps(clumps: Clump[], lod: number): Clump[] {
  if (lod < 2) return clumps;
  return clumps.filter((c) => c.main).map((c) => ({ ...c, r: c.r * 1.3 }));
}

export function broadleaf(lod: number, variant: number): Built {
  const b = new MeshBuilder2();
  const rnd = mulberry(variant * 977 + 13);
  const leafRnd = mulberry(variant * 977 + 14 + lod);
  const bark = hex('#7a573f');
  const pal = OAK_PALETTES[variant % OAK_PALETTES.length];
  // A sturdy trunk forks into four or five spreading limbs; each splits into
  // branches and twigs that carry the leaf masses, so the wood shows between
  // and beneath them instead of one ball of leaves on a stick.
  const spec: TreeSpec = {
    trunkLen: 3.0 + rnd() * 0.9,
    trunkR: [0.46, 0.27],
    lean: [(rnd() - 0.5) * 0.24, 1, (rnd() - 0.5) * 0.24],
    trunkSteps: 6,
    gnarl: 0.16,
    limbs: { n: [4, 5], at: [1, 1], angle: [0.85, 1.15], len: [3.0, 3.8], r: 0.68, taper: 0.3, steps: 5, bend: 0.55, wobble: 0.22, clump: [1.35, 1.7] },
    levels: [
      { n: [2, 3], at: [0.5, 0.9], angle: [0.6, 1.0], len: [0.38, 0.52], r: 0.62, taper: 0.35, steps: 4, bend: 0.35, wobble: 0.3, clump: [1.0, 1.3] },
      { n: [2, 2], at: [0.35, 0.85], angle: [0.6, 1.0], len: [0.4, 0.6], r: 0.6, taper: 0.3, steps: 2, bend: 0.2, wobble: 0.4 },
    ],
  };
  const { limbs, clumps } = growTree(spec, rnd);
  const crown = envelope(farClumps(clumps, lod));
  meshWood(b, limbs, lod, bark, [3, 2, 1, 0], WOOD_SEGS);
  if (lod === 0) roots(b, rnd, 5, spec.trunkR[0], bark, 6);
  if (lod === 3) {
    for (const cl of crown.clumps) b.blob(cl.c, [cl.r * 0.8, cl.r * 0.7, cl.r * 0.8], 0, noise, 0.2, pal.core, pal.core, crown.center, 0.5);
    return done(b);
  }
  clumpCores(b, crown, pal, lod);
  leafCards(b, crown, pal, [10, 4, 2][lod], [1.3, 1.65, 2.1][lod], 'broad', leafRnd, 0.75, undefined, { shell: [0.1, 0.12, 0.2][lod], local: 0.5 });
  return done(b);
}

// ------------------------------------------------------------------ blossom

const BLOSSOM: Palette = { low: hex('#f096a6'), high: hex('#ffe6ea'), core: hex('#d07a8a') };

/** A flowering tree: a dark, twisting trunk throwing long, low limbs under soft pink clouds. */
export function blossom(lod: number, variant: number): Built {
  const b = new MeshBuilder2();
  const rnd = mulberry(variant * 3331 + 71);
  const leafRnd = mulberry(variant * 3331 + 72 + lod);
  const bark = hex('#6a463c');
  const spec: TreeSpec = {
    trunkLen: 2.4 + rnd() * 0.7,
    trunkR: [0.36, 0.22],
    lean: [(rnd() - 0.5) * 0.5, 1, (rnd() - 0.5) * 0.5],
    trunkSteps: 6,
    gnarl: 0.3,
    limbs: { n: [4, 5], at: [1, 1], angle: [0.95, 1.25], len: [2.8, 3.6], r: 0.7, taper: 0.28, steps: 6, bend: 0.3, wobble: 0.32, clump: [1.25, 1.55] },
    levels: [
      { n: [2, 3], at: [0.35, 0.85], angle: [0.6, 1.05], len: [0.4, 0.55], r: 0.6, taper: 0.3, steps: 4, bend: 0.05, wobble: 0.4, clump: [1.0, 1.3] },
      { n: [2, 2], at: [0.4, 0.9], angle: [0.6, 1.0], len: [0.4, 0.6], r: 0.6, taper: 0.3, steps: 2, bend: -0.1, wobble: 0.45 },
    ],
  };
  const { limbs, clumps } = growTree(spec, rnd);
  const crown = envelope(farClumps(clumps, lod));
  meshWood(b, limbs, lod, bark, [3, 2, 1, 0], WOOD_SEGS);
  if (lod === 0) roots(b, rnd, 4, spec.trunkR[0], bark, 6);
  if (lod === 3) {
    for (const cl of crown.clumps) b.blob(cl.c, [cl.r * 0.8, cl.r * 0.65, cl.r * 0.8], 0, noise, 0.2, BLOSSOM.core, BLOSSOM.core, crown.center, 0.5);
    return done(b);
  }
  clumpCores(b, crown, BLOSSOM, lod, 0.4);
  leafCards(b, crown, BLOSSOM, [12, 4, 2][lod], [1.25, 1.65, 2.1][lod], 'round', leafRnd, 0.8, { color: hex('#fff4f8'), share: 0.14 }, { shell: [0.1, 0.12, 0.2][lod], local: 0.5 });
  return done(b);
}

// ------------------------------------------------------------------ pine

/** Tiered stylized conifer: drooping skirts of needle sprays around dark cones. */
export function pine(lod: number, variant: number): Built {
  const b = new MeshBuilder2();
  const rnd = mulberry(variant * 331 + 7);
  const h = 7.5 + rnd() * 3;
  b.branch([0, -0.4, 0], [0, 1, 0], h * 0.92, 0.36, 0.07, [7, 5, 4, 4][lod], [3, 2, 1, 1][lod], hex('#5a3e30'), 0, 0.1);
  const tiers = [6, 5, 4, 3][lod];
  const dark = hex('#123c33');
  const mid = hex('#2c6e4a');
  const light = hex('#78b85a');
  let topY = 0;
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const radius = 2.9 * (1 - t * 0.78) + rnd() * 0.25;
    const height = (2.5 - t * 0.7) * (0.6 + 2.4 / tiers);
    const baseY = 1.5 + t * h * 0.8;
    const sway = 0.25 + t * 0.6;
    topY = baseY + height * 0.87;
    if (lod === 3) b.cone(baseY, height, radius, 6, dark, dark, sway, 0.14, 0);
    else b.cone(baseY + height * 0.02, height * 0.72, radius * 0.66, [10, 8, 6][lod], mix3(dark, mid, 0.35), mix3(dark, mid, 0.75), sway, 0.12, rnd() * 6);
    if (lod === 3) continue;
    if (lod === 0) {
      // bare limbs reaching out under each skirt, drooping toward their tips
      const kb = 4;
      for (let j = 0; j < kb; j++) {
        const a = (j / kb) * Math.PI * 2 + i * 0.9 + rnd() * 0.5;
        const len = radius * (0.75 + rnd() * 0.15);
        const y0 = baseY + height * 0.18;
        const pts: C3[] = [0, 1, 2].map((k) => {
          const f = k / 2;
          return [Math.cos(a) * len * f, y0 + f * 0.25 - f * f * 0.55, Math.sin(a) * len * f];
        });
        const r0 = 0.09 * (1 - t * 0.5);
        b.tube(pts, [r0, r0 * 0.55, r0 * 0.2], [sway * 0.2, sway * 0.6, sway * 0.9], 4, hex('#5a3e30'), { shade: [0.8, 1] });
      }
    }
    // needle sprays around the skirt, hanging slightly outward and down
    const k = [11, 7, 4][lod] + (lod === 0 ? Math.round(radius * 1.5) : 0);
    for (let j = 0; j < k; j++) {
      const a = (j / k) * Math.PI * 2 + rnd() * 0.4 + i;
      const rr = radius * (0.72 + rnd() * 0.22);
      const p: C3 = [Math.cos(a) * rr, baseY + height * (0.1 + rnd() * 0.25), Math.sin(a) * rr];
      const n = normalize([Math.cos(a), 0.55 + t * 0.4, Math.sin(a)]);
      const col = mix3(mid, light, 0.25 + 0.75 * t + (rnd() - 0.5) * 0.2);
      b.card(p, (1.25 + radius * 0.3) * [1, 1.25, 1.7][lod], n, col, sway, 'needle', Math.PI + (rnd() - 0.5) * 0.8);
    }
    // a few sprays crowning each tier
    const kt = [3, 2, 1][lod];
    for (let j = 0; j < kt; j++) {
      const a = rnd() * Math.PI * 2;
      const p: C3 = [Math.cos(a) * radius * 0.3, baseY + height * 0.55, Math.sin(a) * radius * 0.3];
      b.card(p, 1.3 * [1, 1.25, 1.7][lod], normalize([Math.cos(a) * 0.4, 1, Math.sin(a) * 0.4]), mix3(mid, light, 0.6 + 0.4 * t), sway, 'needle', Math.PI + (rnd() - 0.5) * 1.2);
    }
  }
  if (lod < 3) {
    b.card([0, topY - 0.35, 0], 1.5 * [1, 1.2, 1.5][lod], [0, 1, 0], mix3(mid, light, 0.85), 0.9, 'needle', Math.PI);
  }
  return done(b);
}

// ------------------------------------------------------------------ birch

const BIRCH: Palette = { low: hex('#3f7a34'), high: hex('#d2e05a'), core: hex('#355f2a') };

export function birch(lod: number, variant: number): Built {
  const b = new MeshBuilder2();
  const rnd = mulberry(variant * 51 + 3);
  const leafRnd = mulberry(variant * 51 + 4 + lod);
  const white = hex('#f4f0e6');
  // A tall, slender white trunk with dark lenticel bands, and many thin
  // branches climbing at a steep angle, each holding a small airy clump.
  const spec: TreeSpec = {
    trunkLen: 6.0 + rnd() * 1.6,
    trunkR: [0.24, 0.07],
    lean: [(rnd() - 0.5) * 0.15, 1, (rnd() - 0.5) * 0.15],
    trunkSteps: 8,
    gnarl: 0.07,
    limbs: { n: [3, 3], at: [1, 1], angle: [0.25, 0.5], len: [1.2, 1.7], r: 0.8, taper: 0.3, steps: 3, bend: 0.3, wobble: 0.2, clump: [1.0, 1.2] },
    levels: [{ n: [1, 2], at: [0.5, 0.8], angle: [0.5, 0.8], len: [0.45, 0.6], r: 0.6, taper: 0.3, steps: 2, bend: 0.2, wobble: 0.3, clump: [0.8, 1.0] }],
  };
  const { limbs, clumps } = growTree(spec, rnd);
  // side branches up the upper trunk, angled steeply skyward
  const trunk = limbs[0];
  const side = 6;
  for (let k = 0; k < side; k++) {
    const t = 0.4 + (k / side) * 0.5;
    const i = Math.min(trunk.pts.length - 2, Math.floor(t * (trunk.pts.length - 1)));
    const base = trunk.pts[i];
    const dir = deflect(UP, 0.8 + rnd() * 0.3, k * 2.39996 + rnd() * 0.5);
    const len = 1.7 + rnd() * 0.8 - t * 0.8;
    const pts = curve(base, dir, len, 3, 0.25, 0.2, rnd);
    const r0 = trunk.radii[i] * 0.42;
    const out = t * spec.trunkLen * 0.4;
    limbs.push({ pts, radii: pts.map((_, q) => r0 * (1 - 0.7 * (q / (pts.length - 1)))), sways: pts.map((_, q) => swayAt(out + (q / (pts.length - 1)) * len)), depth: 1 });
    clumps.push({ c: pts[pts.length - 1], r: 0.85 + rnd() * 0.3, s: Math.min(0.85, swayAt(out + len) + 0.12), main: true });
  }
  const crown = envelope(clumps);
  // bark bands: dark rings at seeded heights along the trunk only
  const bandSeed = rnd() * 10;
  const band = (l: Limb, i: number): C3 => {
    if (l.depth > 0) return white;
    const y = l.pts[i][1];
    const v = Math.sin(y * 4.3 + bandSeed) * Math.sin(y * 1.7 + bandSeed * 2);
    return v > 0.55 ? hex('#5a5550') : v > 0.35 ? hex('#cfc8bb') : white;
  };
  // the trunk gets enough rings for the bands to show up close
  if (lod === 0) {
    const t = limbs[0];
    const dense: C3[] = [];
    const dr: number[] = [];
    const ds: number[] = [];
    for (let i = 0; i < t.pts.length - 1; i++) {
      for (let k = 0; k < 3; k++) {
        const f = k / 3;
        dense.push(mix3(t.pts[i], t.pts[i + 1], f));
        dr.push(t.radii[i] + (t.radii[i + 1] - t.radii[i]) * f);
        ds.push(t.sways[i] + (t.sways[i + 1] - t.sways[i]) * f);
      }
    }
    dense.push(t.pts[t.pts.length - 1]);
    dr.push(t.radii[t.radii.length - 1]);
    ds.push(t.sways[t.sways.length - 1]);
    limbs[0] = { pts: dense, radii: dr, sways: ds, depth: 0 };
  }
  meshWood(b, limbs, lod, white, [2, 1, 0, 0], WOOD_SEGS, band);
  if (lod === 3) {
    b.blob(crown.center, [crown.radius[0] * 0.8, crown.radius[1] * 0.85, crown.radius[2] * 0.8], 1, noise, 0.3, BIRCH.core, BIRCH.core, crown.center, 0.7);
    return done(b);
  }
  leafCards(b, crown, BIRCH, [9, 4, 2][lod], [1.3, 1.7, 2.3][lod], 'round', leafRnd, 0.9, undefined, { shell: [0.12, 0.15, 0.3][lod], local: 0.5 });
  return done(b);
}

// ------------------------------------------------------------------ bushes

const BUSH: Palette = { low: hex('#1f5230'), high: hex('#8cc84c'), core: hex('#1b4529') };
const BUSH_FLOWER: Palette = { low: hex('#28583a'), high: hex('#7ec25a'), core: hex('#1e4a2e') };

export function bush(lod: number, variant: number): Built {
  const b = new MeshBuilder2();
  const rnd = mulberry(variant * 71 + 5);
  const flowering = variant % 2 === 1;
  const pal = flowering ? BUSH_FLOWER : BUSH;
  const center: C3 = [0, 0.55, 0];
  const radius: C3 = [1.25 + rnd() * 0.3, 0.9, 1.25 + rnd() * 0.3];
  const clumps = [
    { c: [0, 0.75, 0] as C3, r: 0.85 },
    { c: [0.7, 0.45, 0.25] as C3, r: 0.65 },
    { c: [-0.55, 0.45, -0.4] as C3, r: 0.65 },
    { c: [-0.2, 0.4, 0.7] as C3, r: 0.55 },
  ];
  const crown: Crown = { center, radius, clumps };
  if (lod === 3) {
    b.blob(center, radius, 0, noise, 0.3, pal.core, pal.core, [0, -0.4, 0], 0.35, 0.5);
    return done(b);
  }
  core(b, crown, pal, 0.62, 0.35, lod === 2 ? 0 : 1);
  leafCards(b, crown, pal, [16, 8, 4][lod], [1.5, 1.9, 2.4][lod], 'round', rnd, 0.35, flowering ? { color: variant % 4 === 1 ? hex('#ffb0cf') : hex('#fff2c4'), share: lod === 2 ? 0.2 : 0.28 } : undefined);
  return done(b);
}

// ------------------------------------------------------------------ rocks

const STONE = hex('#aaa39b');
const STONE_DARK = hex('#625e68');
const MOSS = hex('#679b3c');

export function rock(lod: number, variant: number): Built {
  const b = new MeshBuilder2();
  const rnd = mulberry(variant * 17 + 1);
  const sub = lod >= 2 ? 1 : 2;
  b.boulder([0, 0, 0], [1.05 + rnd() * 0.35, 0.8 + rnd() * 0.3, 1.0 + rnd() * 0.35], variant * 3 + 1, STONE, STONE_DARK, MOSS, { subdiv: sub, cuts: 8 + (variant % 3) });
  if (variant % 2 === 0 && lod < 2) b.boulder([0.95, -0.12, 0.55], [0.5, 0.42, 0.5], variant * 5 + 2, STONE, STONE_DARK, MOSS, { subdiv: 1, cuts: 6 });
  return done(b);
}
