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

/**
 * Every leaf mass has its own shape, so no crown reads as a pile of balls:
 * squashed or stretched, built from two to four overlapping lobes, some
 * drooping at the edges, some with a bite taken out of one side. Seeded by
 * the clump's position, so every LOD of a tree agrees on it.
 */
interface ClumpShape {
  sx: number;
  sy: number;
  sz: number;
  droop: number;
  leaf: number;
  /** Lobe offsets and radii, in clump radii (the first is the main lobe). */
  lobes: { o: C3; r: number }[];
  wsum: number;
  bite: C3 | null;
  /** Scalloped rim: amount, lobe count, two phases. */
  edge: [number, number, number, number];
}

function clumpShape(c: C3): ClumpShape {
  const rnd = mulberry((Math.round(c[0] * 97) * 73856093) ^ (Math.round(c[1] * 97) * 19349663) ^ (Math.round(c[2] * 97) * 83492791));
  const kind = rnd();
  const droop = kind < 0.28 ? 0.3 + rnd() * 0.35 : rnd() * 0.12;
  // tufted clumps break into more, smaller lobes
  const tufted = kind > 0.72;
  const lobes: { o: C3; r: number }[] = [{ o: [(rnd() - 0.5) * 0.2, (rnd() - 0.5) * 0.15, (rnd() - 0.5) * 0.2], r: tufted ? 0.62 : 0.78 }];
  const extra = tufted ? 3 : 1 + Math.floor(rnd() * 2);
  for (let i = 0; i < extra; i++) {
    const a = rnd() * Math.PI * 2;
    const up = rnd() * 1.1 - 0.3;
    const d = (tufted ? 0.55 : 0.45) + rnd() * 0.22;
    const l = Math.hypot(1, up);
    lobes.push({ o: [(Math.cos(a) / l) * d, (up / l) * d, (Math.sin(a) / l) * d], r: (tufted ? 0.42 : 0.48) + rnd() * 0.2 });
  }
  let bite: C3 | null = null;
  if (rnd() < 0.4) {
    const a = rnd() * Math.PI * 2;
    bite = normalize([Math.cos(a), rnd() * 0.8 - 0.4, Math.sin(a)]) as C3;
  }
  return {
    sx: 0.76 + rnd() * 0.52,
    sy: (0.56 + rnd() * 0.44) * (droop > 0.25 ? 0.9 : 1),
    sz: 0.76 + rnd() * 0.52,
    edge: [0.12 + rnd() * 0.2, 2 + Math.floor(rnd() * 3), rnd() * 6.28, rnd() * 6.28],
    droop,
    leaf: 0.88 + rnd() * 0.26,
    lobes,
    wsum: lobes.reduce((w, l) => w + l.r * l.r, 0),
    bite,
  };
}

/** A point in a clump's shape: `u`, `th` pick the direction, `dd` the depth (0..1 of the lobe). */
function clumpPoint(cl: { c: C3; r: number }, sh: ClumpShape, lobe: { o: C3; r: number }, u: number, th: number, dd: number): C3 {
  const sq = Math.sqrt(1 - u * u);
  // an uneven, scalloped rim instead of a smooth sphere
  const [ea, ek, p1, p2] = sh.edge;
  const lr = lobe.r * cl.r * (1 + ea * Math.sin(th * ek + p1) * Math.cos(u * 2.6 + p2));
  let ox = (sq * Math.cos(th) * dd * lr + lobe.o[0] * cl.r) * sh.sx;
  let oy = (u * dd * lr * 0.85 + lobe.o[1] * cl.r) * sh.sy;
  const oz = (sq * Math.sin(th) * dd * lr + lobe.o[2] * cl.r) * sh.sz;
  // drooping clumps hang lower underneath and sag at the rim
  if (oy < 0) oy *= 1 + sh.droop;
  oy -= (sh.droop * (ox * ox + oz * oz)) / Math.max(cl.r, 0.1) * 0.6;
  return [cl.c[0] + ox, cl.c[1] + oy, cl.c[2] + oz];
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
    const sh = clumpShape(cl.c);
    // bigger clumps get more cards, so every mass is equally dense
    let cnt = o.local !== undefined ? Math.max(2, Math.round(per * Math.pow(cl.r / 1.3, 2))) : per;
    if (sh.bite) cnt = Math.round(cnt * 1.12);
    for (let i = 0; i < cnt; i++) {
      // pick a lobe (bigger lobes get more leaves)
      let pick = rnd() * sh.wsum;
      let lobe = sh.lobes[0];
      for (const l of sh.lobes) {
        pick -= l.r * l.r;
        if (pick <= 0) {
          lobe = l;
          break;
        }
      }
      // biased toward the lobe surface, so the cards build the silhouette
      const u = rnd() * 2 - 1;
      const th = rnd() * Math.PI * 2;
      const dd = 0.35 + 0.5 * Math.cbrt(rnd());
      const p = clumpPoint(cl, sh, lobe, u, th, dd);
      const d = dd * cl.r;
      // a bite out of one side leaves a gap the light shows through
      if (sh.bite) {
        const ox = p[0] - cl.c[0], oy = p[1] - cl.c[1], oz = p[2] - cl.c[2];
        if ((ox * sh.bite[0] + oy * sh.bite[1] + oz * sh.bite[2]) / (Math.hypot(ox, oy, oz) || 1) > 0.7 && rnd() < 0.85) continue;
      }
      const lc: C3 = [cl.c[0] + lobe.o[0] * cl.r * sh.sx, cl.c[1] + lobe.o[1] * cl.r * sh.sy, cl.c[2] + lobe.o[2] * cl.r * sh.sz];
      // shading normal: mostly the whole crown, a little the lobe
      const nc = [(p[0] - center[0]) / radius[0], (p[1] - center[1]) / radius[1], (p[2] - center[2]) / radius[2]];
      const nl = [(p[0] - lc[0]) / cl.r, (p[1] - lc[1]) / cl.r, (p[2] - lc[2]) / cl.r];
      const n = normalize([nc[0] * (1 - lw) + nl[0] * lw, nc[1] * (1 - lw) + nl[1] * lw + 0.12, nc[2] * (1 - lw) + nl[2] * lw]);
      const h = Math.min(1, Math.max(0, (p[1] - (center[1] - radius[1])) / (radius[1] * 2)));
      let col = mix3(pal.low, pal.high, Math.pow(h, 0.85));
      // the outer shell catches more light than the inner leaves
      col = scale3(col, tint * (0.82 + 0.25 * (d / cl.r)));
      if (accent && rnd() < accent.share) col = scale3(accent.color, 0.9 + rnd() * 0.2);
      b.card(p, cl.r * grow * sh.leaf * (0.8 + rnd() * 0.4), n, col, cs, cell, rnd() * Math.PI * 2);
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
  /** Optional limbs sprouting lower down the trunk (`at` along it). */
  side?: Level;
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

  const grow = (parent: Limb, lv: number, outBase: number, Lside?: Level) => {
    const L = Lside ?? (lv === 0 ? spec.limbs : spec.levels[lv - 1]);
    if (!L) return;
    const fork = lv === 0 && !Lside;
    const count = Math.round(lerp(L.n, rnd()));
    const az0 = rnd() * Math.PI * 2;
    const plen = parent.pts.reduce((acc, p, i) => (i ? acc + Math.hypot(p[0] - parent.pts[i - 1][0], p[1] - parent.pts[i - 1][1], p[2] - parent.pts[i - 1][2]) : 0), 0);
    for (let k = 0; k < count; k++) {
      // main limbs all fork from the trunk top; deeper branches spread along their parent
      const t = fork ? 1 - rnd() * 0.12 : lerp(L.at, count === 1 ? 0.5 : k / (count - 1)) + (rnd() - 0.5) * 0.08;
      const fi = Math.min(parent.pts.length - 1.001, Math.max(0, t * (parent.pts.length - 1)));
      const i0 = Math.floor(fi);
      const ft = fi - i0;
      const a = parent.pts[i0];
      const b = parent.pts[i0 + 1];
      const base: C3 = [a[0] + (b[0] - a[0]) * ft, a[1] + (b[1] - a[1]) * ft, a[2] + (b[2] - a[2]) * ft];
      const pdir: C3 = fork ? UP : normalize([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
      // golden-angle spiral so siblings never bunch up on one side
      const az = az0 + k * (fork ? (Math.PI * 2) / count : 2.39996) + (rnd() - 0.5) * 0.6;
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
  if (spec.side) grow(limbs[0], 0, 0, spec.side);
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
interface WoodLook {
  cell: AtlasCell;
  /** Bark repeats around the trunk up close (finer furrows on thick trunks). */
  around?: number;
  /** Moss, lichen or wet bark blended in per vertex (LOD 0 only). */
  tint?: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => number;
  tintColor?: C3;
}

/** Moss creeping up the foot of the trunk and settling on top of the big limbs. */
function mossy(seed: number, height: number, amount: number) {
  return (x: number, y: number, z: number, _nx: number, ny: number, _nz: number) => {
    const n = noise.noise(x * 1.7 + seed, z * 1.7 + y * 1.3) * 0.5 + 0.5;
    const foot = Math.max(0, 1 - y / height);
    const top = Math.max(0, ny - 0.45) * (y > 1.5 ? 0.9 : 0);
    return Math.min(0.85, (foot * foot * 1.6 + top) * (0.35 + 0.9 * n) * amount);
  };
}

function meshWood(b: MeshBuilder2, limbs: Limb[], lod: number, bark: C3, maxDepth: number[], segs: number[][], look: WoodLook) {
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
    b.tube(pts, radii, sways, sg, tint, {
      shade: l.depth === 0 ? [0.62, 1] : [0.86, 1.06],
      cell: look.cell,
      around: l.depth === 0 && lod === 0 ? (look.around ?? 1) : 1,
      tint: lod === 0 && l.depth <= 1 ? look.tint : undefined,
      tintColor: look.tintColor,
    });
  }
}

/** Buttress roots spreading from the trunk foot into the ground. */
function roots(b: MeshBuilder2, rnd: () => number, n: number, r: number, bark: C3, segs: number, look: WoodLook) {
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
    b.tube(pts, radii, [0, 0, 0, 0, 0], segs, scale3(bark, 0.92), { shade: [0.7, 0.85], cell: look.cell, tint: look.tint, tintColor: look.tintColor });
  }
}

/** A clump's stand-in in the shadow map, squashed like its leaves. */
function shadowBlob(b: MeshBuilder2, cl: { c: C3; r: number }, sy: number, col: C3, center: C3) {
  const sh = clumpShape(cl.c);
  const l = sh.lobes[0];
  const c: C3 = [cl.c[0] + l.o[0] * cl.r * sh.sx, cl.c[1] + l.o[1] * cl.r * sh.sy - cl.r * sh.droop * 0.2, cl.c[2] + l.o[2] * cl.r * sh.sz];
  b.blob(c, [cl.r * 0.8 * sh.sx, cl.r * sy * sh.sy * (1 + sh.droop * 0.3), cl.r * 0.8 * sh.sz], 0, noise, 0.2, col, col, center, 0.5);
}

/** Small inner foliage volumes per clump: the crown stays solid where it should be, open between masses. */
function clumpCores(b: MeshBuilder2, crown: Crown, pal: Palette, lod: number, shrink = 0.5) {
  // deep inner shade: glimpsed through the leaves, never a lit ball of its own
  const lo = scale3(pal.core, 0.85);
  const hi = mix3(pal.core, pal.low, 0.7);
  // only the big masses at the limb ends get one; small clumps stay airy
  for (const cl of crown.clumps) {
    if (!cl.main) continue;
    const sh = clumpShape(cl.c);
    // one core per big lobe (up close), squashed like the clump, slightly
    // below the lobe centre: the lit top stays all leaves
    // (upward lobes get none: a core there would poke through the thin top)
    sh.lobes.slice(0, lod === 0 ? 2 : 1).forEach((l, i) => {
      if (i > 0 && l.o[1] > 0.1) return;
      const r = cl.r * shrink * (sh.bite ? 0.72 : 0.9) * (i === 0 ? 1 : l.r / sh.lobes[0].r);
      const c: C3 = [cl.c[0] + l.o[0] * cl.r * sh.sx, cl.c[1] + Math.min(l.o[1], 0) * cl.r * sh.sy - cl.r * (0.16 + sh.droop * 0.2), cl.c[2] + l.o[2] * cl.r * sh.sz];
      b.blob(c, [r * sh.sx, r * 0.75 * sh.sy, r * sh.sz], lod === 0 ? 1 : lod === 1 ? 0 : -1, noise, 0.25, lo, hi, crown.center, (cl.s ?? 0.6) - 0.1, 0.5);
    });
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

const BARK_MOSS = hex('#56762c');

export function broadleaf(lod: number, variant: number): Built {
  const b = new MeshBuilder2();
  const rnd = mulberry(variant * 977 + 13);
  const leafRnd = mulberry(variant * 977 + 14 + lod);
  const bark = [hex('#8a6a50'), hex('#7c6656'), hex('#8e6c4c')][variant % 3];
  const pal = OAK_PALETTES[variant % OAK_PALETTES.length];
  // Every oak differs: a broad, spreading old giant, a taller upright one and
  // a leaning, gnarled one. A sturdy, mossy trunk forks into spreading limbs
  // (and the odd heavy limb lower down), each splitting into branches and
  // twigs that carry the leaf masses, so the wood shows between them.
  const shape = [
    { trunk: 2.8, spread: [0.95, 1.2], len: [3.2, 3.9], side: 2, lean: 0.18, gnarl: 0.18 },
    { trunk: 3.6, spread: [0.7, 1.0], len: [2.8, 3.4], side: 1, lean: 0.12, gnarl: 0.13 },
    { trunk: 3.1, spread: [0.85, 1.15], len: [3.0, 3.7], side: 1, lean: 0.42, gnarl: 0.26 },
  ][variant % 3];
  const la = rnd() * Math.PI * 2;
  const spec: TreeSpec = {
    trunkLen: shape.trunk + rnd() * 0.7,
    trunkR: [0.48, 0.28],
    lean: [Math.cos(la) * shape.lean, 1, Math.sin(la) * shape.lean],
    trunkSteps: 6,
    gnarl: shape.gnarl,
    limbs: { n: [4, 5], at: [1, 1], angle: shape.spread as [number, number], len: shape.len as [number, number], r: 0.68, taper: 0.3, steps: 5, bend: 0.55, wobble: 0.24, clump: [1.35, 1.7] },
    side: { n: [shape.side, shape.side], at: [0.55, 0.78], angle: [1.05, 1.3], len: [2.6, 3.3], r: 0.62, taper: 0.3, steps: 5, bend: 0.75, wobble: 0.26, clump: [1.25, 1.55] },
    levels: [
      { n: [2, 3], at: [0.5, 0.9], angle: [0.6, 1.0], len: [0.38, 0.52], r: 0.62, taper: 0.35, steps: 4, bend: 0.35, wobble: 0.3, clump: [1.0, 1.3] },
      { n: [2, 3], at: [0.3, 0.85], angle: [0.6, 1.05], len: [0.4, 0.6], r: 0.6, taper: 0.3, steps: 2, bend: 0.2, wobble: 0.45 },
    ],
  };
  const { limbs, clumps } = growTree(spec, rnd);
  const crown = envelope(farClumps(clumps, lod));
  const look: WoodLook = { cell: 'barkOak', around: 1, tint: mossy(variant * 7.3, 1.9, 1), tintColor: BARK_MOSS };
  meshWood(b, limbs, lod, bark, [3, 2, 1, 0], WOOD_SEGS, look);
  if (lod === 0) roots(b, rnd, 5 + (variant % 2), spec.trunkR[0], bark, 6, look);
  if (lod === 3) {
    for (const cl of crown.clumps) shadowBlob(b, cl, 0.7, pal.core, crown.center);
    return done(b);
  }
  clumpCores(b, crown, pal, lod);
  leafCards(b, crown, pal, [10, 4, 2][lod], [1.3, 1.65, 2.1][lod], 'broad', leafRnd, 0.75, undefined, { shell: [0.1, 0.12, 0.2][lod], local: 0.5 });
  return done(b);
}

// ------------------------------------------------------------------ blossom

const BLOSSOMS: { pal: Palette; accent: C3 }[] = [
  // classic deep sakura pink
  { pal: { low: hex('#f096a6'), high: hex('#ffe6ea'), core: hex('#d07a8a') }, accent: hex('#fff4f8') },
  // pale, almost white blossom with rosy hearts
  { pal: { low: hex('#f2b6c4'), high: hex('#fff6f8'), core: hex('#d995a6') }, accent: hex('#ff9fb6') },
];

/** A flowering tree: a dark, glossy, twisting trunk throwing long, low limbs under soft pink clouds. */
export function blossom(lod: number, variant: number): Built {
  const b = new MeshBuilder2();
  const rnd = mulberry(variant * 3331 + 71);
  const leafRnd = mulberry(variant * 3331 + 72 + lod);
  const bark = hex('#5e3c38');
  const kind = BLOSSOMS[variant % BLOSSOMS.length];
  const spec: TreeSpec = {
    trunkLen: 2.2 + rnd() * 0.7,
    trunkR: [0.36, 0.22],
    lean: [(rnd() - 0.5) * 0.55, 1, (rnd() - 0.5) * 0.55],
    trunkSteps: 6,
    gnarl: 0.34,
    limbs: { n: [4, 5], at: [1, 1], angle: [1.0, 1.3], len: [2.8, 3.6], r: 0.7, taper: 0.28, steps: 6, bend: 0.3, wobble: 0.34, clump: [1.25, 1.55] },
    side: variant % 2 === 0 ? { n: [1, 1], at: [0.62, 0.75], angle: [1.2, 1.35], len: [2.5, 2.9], r: 0.6, taper: 0.28, steps: 5, bend: 0.5, wobble: 0.35, clump: [1.15, 1.35] } : undefined,
    levels: [
      { n: [2, 3], at: [0.35, 0.85], angle: [0.6, 1.05], len: [0.4, 0.55], r: 0.6, taper: 0.3, steps: 4, bend: 0.05, wobble: 0.4, clump: [1.0, 1.3] },
      { n: [2, 3], at: [0.4, 0.9], angle: [0.6, 1.0], len: [0.4, 0.6], r: 0.6, taper: 0.3, steps: 2, bend: -0.15, wobble: 0.45 },
    ],
  };
  const { limbs, clumps } = growTree(spec, rnd);
  const crown = envelope(farClumps(clumps, lod));
  const look: WoodLook = { cell: 'barkCherry', around: 1, tint: mossy(variant * 3.1, 1.2, 0.45), tintColor: hex('#5f6e3a') };
  meshWood(b, limbs, lod, bark, [3, 2, 1, 0], WOOD_SEGS, look);
  if (lod === 0) roots(b, rnd, 4, spec.trunkR[0], bark, 6, look);
  if (lod === 3) {
    for (const cl of crown.clumps) shadowBlob(b, cl, 0.65, kind.pal.core, crown.center);
    return done(b);
  }
  clumpCores(b, crown, kind.pal, lod, 0.4);
  leafCards(b, crown, kind.pal, [12, 4, 2][lod], [1.25, 1.65, 2.1][lod], 'round', leafRnd, 0.8, { color: kind.accent, share: 0.14 }, { shell: [0.1, 0.12, 0.2][lod], local: 0.5 });
  return done(b);
}

// ------------------------------------------------------------------ pine

/** Tiered stylized conifer: a scaly red-brown trunk under drooping, irregular skirts of needle sprays. */
export function pine(lod: number, variant: number): Built {
  const b = new MeshBuilder2();
  const rnd = mulberry(variant * 331 + 7);
  const slender = variant % 2 === 1;
  const h = (slender ? 9 : 7.5) + rnd() * 2.5;
  const barkCol = hex('#6a4232');
  const pineLook: WoodLook = { cell: 'barkPine' };
  // a slightly curving trunk, visible between the skirts
  const lean: C3 = [(rnd() - 0.5) * 0.08, 1, (rnd() - 0.5) * 0.08];
  const tpts = curve([0, -0.4, 0], lean, h * 0.94, [7, 5, 3, 3][lod], 0, 0.04, rnd);
  const tr = tpts.map((_, i) => {
    const t = i / (tpts.length - 1);
    return 0.36 * (1 - t * 0.82) + 0.12 * Math.pow(Math.max(0, 1 - t * 5), 2);
  });
  const tsw = tpts.map((_, i) => (i / (tpts.length - 1)) * 0.12);
  meshWood(b, [{ pts: tpts, radii: tr, sways: tsw, depth: 0 }], lod, barkCol, [0, 0, 0, 0], [[9], [6], [4], [4]], pineLook);
  const trunkAt = (y: number): C3 => {
    const t = Math.min(1, Math.max(0, (y + 0.4) / (h * 0.94)));
    const fi = t * (tpts.length - 1);
    const i0 = Math.min(tpts.length - 2, Math.floor(fi));
    return mix3(tpts[i0], tpts[i0 + 1], fi - i0);
  };
  const tiers = [6, 5, 4, 3][lod] + (slender ? 1 : 0);
  const dark = hex('#123c33');
  const mid = slender ? hex('#2a6a52') : hex('#2c6e4a');
  const light = slender ? hex('#86c27a') : hex('#78b85a');
  let topY = 0;
  const wide = slender ? 0.78 : 1;
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    // irregular tiers: each a little wider or narrower, set a little off-centre
    const radius = (2.9 * (1 - t * 0.78) + rnd() * 0.25) * wide * (0.88 + rnd() * 0.24);
    const height = (2.5 - t * 0.7) * (0.6 + 2.4 / tiers);
    const baseY = 1.5 + t * h * 0.8 + (rnd() - 0.5) * 0.25;
    const sway = 0.25 + t * 0.6;
    const c0 = trunkAt(baseY);
    topY = baseY + height * 0.87;
    if (lod === 3) b.cone(baseY, height, radius, 6, dark, dark, sway, 0.14, 0);
    else b.cone(baseY + height * 0.02, height * 0.72, radius * 0.66, [10, 8, 6][lod], mix3(dark, mid, 0.35), mix3(dark, mid, 0.75), sway, 0.12, rnd() * 6);
    if (lod === 3) continue;
    if (lod === 0) {
      // bare limbs reaching out under each skirt, drooping toward their tips
      const kb = 5;
      for (let j = 0; j < kb; j++) {
        const a = (j / kb) * Math.PI * 2 + i * 0.9 + rnd() * 0.5;
        const len = radius * (0.5 + rnd() * 0.12);
        const y0 = baseY + height * 0.22;
        const pts: C3[] = [0, 1, 2].map((k) => {
          const f = k / 2;
          return [c0[0] + Math.cos(a) * len * f, y0 + f * 0.25 - f * f * 0.55, c0[2] + Math.sin(a) * len * f];
        });
        const r0 = 0.09 * (1 - t * 0.5);
        b.tube(pts, [r0, r0 * 0.55, r0 * 0.2], [sway * 0.2, sway * 0.6, sway * 0.9], 4, barkCol, { shade: [0.8, 1], cell: 'barkPine' });
      }
    }
    // needle sprays around the skirt, hanging slightly outward and down
    const k = [11, 7, 4][lod] + (lod === 0 ? Math.round(radius * 1.5) : 0);
    for (let j = 0; j < k; j++) {
      const a = (j / k) * Math.PI * 2 + rnd() * 0.4 + i;
      const rr = radius * (0.72 + rnd() * 0.22);
      const p: C3 = [Math.cos(a) * rr, baseY + height * (0.1 + rnd() * 0.25), Math.sin(a) * rr];
      const n = normalize([Math.cos(a), 0.55 + t * 0.4, Math.sin(a)]);
      const col = mix3(mid, light, 0.25 + 0.75 * t + (rnd() - 0.5) * 0.25);
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

const BIRCHES: Palette[] = [
  { low: hex('#3f7a34'), high: hex('#d2e05a'), core: hex('#355f2a') },
  { low: hex('#4a8038'), high: hex('#e4e46a'), core: hex('#3a6430') },
];

/** One slender white birch stem with steep side branches and small airy clumps. */
function birchStem(rnd: () => number, base: C3, lean: C3, height: number, r0: number, limbs: Limb[], clumps: Clump[], side = 6) {
  const spec: TreeSpec = {
    trunkLen: height,
    trunkR: [r0, r0 * 0.3],
    lean,
    trunkSteps: 8,
    gnarl: 0.07,
    limbs: { n: [3, 3], at: [1, 1], angle: [0.25, 0.5], len: [1.2, 1.7], r: 0.8, taper: 0.3, steps: 3, bend: 0.3, wobble: 0.2, clump: [1.0, 1.2] },
    levels: [{ n: [1, 2], at: [0.5, 0.8], angle: [0.5, 0.8], len: [0.45, 0.6], r: 0.6, taper: 0.3, steps: 2, bend: 0.2, wobble: 0.3, clump: [0.8, 1.0] }],
  };
  const g = growTree(spec, rnd);
  for (const l of g.limbs) l.pts = l.pts.map((p) => add3(p, base));
  for (const c of g.clumps) c.c = add3(c.c, base);
  // side branches up the upper trunk, angled steeply skyward
  const trunk = g.limbs[0];
  for (let k = 0; k < side; k++) {
    const t = 0.4 + (k / side) * 0.5;
    const i = Math.min(trunk.pts.length - 2, Math.floor(t * (trunk.pts.length - 1)));
    const dir = deflect(UP, 0.8 + rnd() * 0.3, k * 2.39996 + rnd() * 0.5);
    const len = 1.7 + rnd() * 0.8 - t * 0.8;
    const pts = curve(trunk.pts[i], dir, len, 3, 0.25, 0.2, rnd);
    const br = trunk.radii[i] * 0.42;
    const out = t * height * 0.4;
    g.limbs.push({ pts, radii: pts.map((_, q) => br * (1 - 0.7 * (q / (pts.length - 1)))), sways: pts.map((_, q) => swayAt(out + (q / (pts.length - 1)) * len)), depth: 1 });
    g.clumps.push({ c: pts[pts.length - 1], r: 0.85 + rnd() * 0.3, s: Math.min(0.85, swayAt(out + len) + 0.12), main: true });
  }
  limbs.push(...g.limbs);
  clumps.push(...g.clumps);
}

export function birch(lod: number, variant: number): Built {
  const b = new MeshBuilder2();
  const rnd = mulberry(variant * 51 + 3);
  const leafRnd = mulberry(variant * 51 + 4 + lod);
  const white = hex('#f4f0e6');
  const pal = BIRCHES[variant % BIRCHES.length];
  const limbs: Limb[] = [];
  const clumps: Clump[] = [];
  if (variant % 2 === 0) {
    // a single tall, slender stem
    birchStem(rnd, [0, 0, 0], [(rnd() - 0.5) * 0.15, 1, (rnd() - 0.5) * 0.15], 6.0 + rnd() * 1.6, 0.24, limbs, clumps);
  } else {
    // a clump of two or three stems springing apart from one root
    const n = 2 + Math.round(rnd());
    const a0 = rnd() * Math.PI * 2;
    for (let k = 0; k < n; k++) {
      const a = a0 + (k / n) * Math.PI * 2;
      birchStem(rnd, [Math.cos(a) * 0.18, 0, Math.sin(a) * 0.18], [Math.cos(a) * 0.2, 1, Math.sin(a) * 0.2], 5.2 + rnd() * 1.4 - k * 0.5, 0.17, limbs, clumps, 4);
    }
  }
  const crown = envelope(farClumps(clumps, lod));
  meshWood(b, limbs, lod, white, [2, 1, 0, 0], WOOD_SEGS, { cell: 'barkBirch' });
  if (lod === 3) {
    b.blob(crown.center, [crown.radius[0] * 0.8, crown.radius[1] * 0.85, crown.radius[2] * 0.8], 1, noise, 0.3, pal.core, pal.core, crown.center, 0.7);
    return done(b);
  }
  leafCards(b, crown, pal, [9, 4, 2][lod], [1.3, 1.7, 2.3][lod], 'round', leafRnd, 0.9, undefined, { shell: [0.12, 0.15, 0.3][lod], local: 0.5 });
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
