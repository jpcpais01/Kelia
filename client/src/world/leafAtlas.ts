// The foliage atlas, painted in code at startup: hand-drawn-looking leaf
// clusters for the stylized trees. Each cell is a fluffy clump of leaves in
// greyscale (the trees tint it with vertex colour), lit from the top so every
// clump already reads as a little ball of leaves before any lighting runs.
//
//   ┌──────────────┬──────────────┬──────────────┬──────────────┐
//   │ broad leaves │ round leaves │  oak bark    │  pine bark   │   row 0
//   ├──────────────┼──────────────┼──────────────┼──────────────┤
//   │ pine needles │ solid (flat) │  birch bark  │ cherry bark  │   row 1
//   └──────────────┴──────────────┴──────────────┴──────────────┘
//
// Leaves are greyscale (vertex colour tints them); the bark cells are painted
// in colour, as multipliers over each species' bark tone. Everything on the
// right half of the atlas is bark, which the foliage shader relies on.
// Transparent texels keep the colour of the nearest leaf, so mipmaps never
// bleed dark fringes into the alpha-tested edges.
import { RawTexture, Texture, type Scene } from '@babylonjs/core';

export const ATLAS_CELLS = {
  broad: [0, 0],
  round: [1, 0],
  needle: [0, 1],
  solid: [1, 1],
  barkOak: [2, 0],
  barkPine: [3, 0],
  barkBirch: [2, 1],
  barkCherry: [3, 1],
} as const;

const COLS = 4;
const ROWS = 2;

export type AtlasCell = keyof typeof ATLAS_CELLS;

/** UV rectangle of a cell, inset a little so bilinear taps never cross into a neighbour. */
export function cellUV(cell: AtlasCell, u: number, v: number): [number, number] {
  const [cx, cy] = ATLAS_CELLS[cell];
  const inset = 0.012;
  const uu = inset + u * (1 - 2 * inset);
  const vv = inset + v * (1 - 2 * inset);
  return [(cx + uu) / COLS, (cy + vv) / ROWS];
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Canvas {
  /** Row stride in texels (the atlas is COLS × ROWS square cells). */
  size: number;
  height: number;
  lum: Float32Array;
  /** Per-texel colour multiplier (bark only; leaves stay 1). */
  tint: Float32Array;
  alpha: Float32Array;
}

/**
 * Paint one leaf: a pointed ellipse from (x, y) along angle `a`, `len` long and
 * `wid` wide. Shading: lighter toward the tip and on the lit (upper) side, a
 * darker midrib and a thin dark rim that gives the inked anime edge.
 */
function leaf(c: Canvas, ox: number, oy: number, x: number, y: number, a: number, len: number, wid: number, tone: number, cellSize: number) {
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const r = len + 2;
  const x0 = Math.max(0, Math.floor(x - r));
  const x1 = Math.min(cellSize - 1, Math.ceil(x + r));
  const y0 = Math.max(0, Math.floor(y - r));
  const y1 = Math.min(cellSize - 1, Math.ceil(y + r));
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dx = px + 0.5 - x;
      const dy = py + 0.5 - y;
      // leaf space: s along the leaf (0 at the stem, 1 at the tip), t across
      const s = (dx * ca + dy * sa) / len;
      const t = (-dx * sa + dy * ca) / wid;
      if (s < 0 || s > 1) continue;
      // pointed at both ends, widest a bit before the middle
      const half = Math.sin(Math.PI * Math.pow(s, 0.8)) * 0.5;
      const edge = Math.abs(t) / Math.max(half, 1e-3);
      if (edge > 1) continue;
      const cov = Math.min(1, (1 - edge) * half * wid * 0.9 + 0.2);
      let l = tone * (0.86 + 0.2 * s);
      l *= 1 - 0.12 * Math.max(0, t); // the half facing away from the light
      if (Math.abs(t) < 0.08 && s > 0.08 && s < 0.85) l *= 0.9; // midrib
      if (edge > 0.8) l *= 0.8; // inked rim
      const i = (oy + py) * c.size + ox + px;
      // later leaves sit on top
      c.lum[i] = c.lum[i] * (1 - cov) + l * cov;
      c.alpha[i] = Math.max(c.alpha[i], cov);
    }
  }
}

/** A fluffy clump of leaves radiating from the centre of a cell. */
function clump(c: Canvas, cx: number, cy: number, cellSize: number, o: { count: number; len: [number, number]; wid: number; seed: number; radius: number }) {
  const r = rng(o.seed);
  const ox = cx * cellSize;
  const oy = cy * cellSize;
  const mid = cellSize / 2;
  const R = cellSize * o.radius;
  // back to front: inner, darker leaves first, the bright rim of the clump last
  const leaves: { x: number; y: number; a: number; len: number; tone: number; d: number }[] = [];
  for (let i = 0; i < o.count; i++) {
    const ang = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * R;
    const x = mid + Math.cos(ang) * d;
    const y = mid + Math.sin(ang) * d;
    const len = (o.len[0] + r() * (o.len[1] - o.len[0])) * cellSize;
    // leaves point outward with some scatter so the silhouette is ragged
    const a = ang + (r() - 0.5) * 1.3;
    // lit from the top-left of the clump, darker toward the bottom and the middle
    const lit = 0.5 + 0.5 * ((mid - y) * 0.7 + (mid - x) * 0.3) / R;
    const tone = (0.62 + 0.25 * (d / R) + 0.2 * lit) * (0.9 + r() * 0.2);
    leaves.push({ x, y, a, len, tone: Math.min(1.15, tone), d });
  }
  leaves.sort((p, q) => p.d - q.d);
  for (const l of leaves) leaf(c, ox, oy, l.x - l.len * Math.cos(l.a) * 0.35, l.y - l.len * Math.sin(l.a) * 0.35, l.a, l.len, l.len * o.wid, l.tone, cellSize);
}

/** A spray of pine needles fanning down and out from the top of the cell. */
function needles(c: Canvas, cx: number, cy: number, cellSize: number, seed: number) {
  const r = rng(seed);
  const ox = cx * cellSize;
  const oy = cy * cellSize;
  for (let b = 0; b < 9; b++) {
    // twig from near the centre outward
    const ang = -Math.PI / 2 + (b / 8 - 0.5) * 2.6 + (r() - 0.5) * 0.2;
    const tl = cellSize * (0.3 + r() * 0.14);
    const sx = cellSize * 0.5 + Math.cos(ang) * cellSize * 0.04;
    const sy = cellSize * 0.5 + Math.sin(ang) * cellSize * 0.04 + cellSize * 0.06;
    const n = 26;
    for (let k = 0; k < n; k++) {
      const s = k / n;
      const px = sx + Math.cos(ang) * tl * s;
      const py = sy + Math.sin(ang) * tl * s;
      for (const side of [-1, 1]) {
        const na = ang + side * (0.75 + r() * 0.25);
        const nl = cellSize * (0.08 + 0.05 * Math.sin(Math.PI * s)) * (0.8 + r() * 0.4);
        const tone = 0.62 + 0.38 * s + (r() - 0.5) * 0.12;
        leaf(c, ox, oy, px, py, na, nl, nl * 0.16, tone, cellSize);
      }
    }
  }
}

// ------------------------------------------------------------------ bark

/** Smooth value noise on a seeded lattice. */
function noise2(seed: number) {
  const h = (x: number, y: number) => {
    let n = (x * 374761393 + y * 668265263 + seed * 144269) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  return (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = h(xi, yi);
    const b = h(xi + 1, yi);
    const c = h(xi, yi + 1);
    const d = h(xi + 1, yi + 1);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
}

function fbm(n: (x: number, y: number) => number, x: number, y: number, oct: number) {
  let v = 0;
  let amp = 0.5;
  let f = 1;
  for (let o = 0; o < oct; o++) {
    v += n(x * f, y * f) * amp;
    f *= 2.03;
    amp *= 0.5;
  }
  return v / (1 - Math.pow(0.5, oct));
}

const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

type Painter = (u: number, v: number) => [number, number, number, number]; // lum, tint r, g, b

/** Fill one cell with a painter: u runs around the trunk, v along it. */
function paintCell(c: Canvas, cx: number, cy: number, cell: number, paint: Painter) {
  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < cell; x++) {
      const [l, r, g, b] = paint(x / cell, y / cell);
      const i = (cy * cell + y) * c.size + cx * cell + x;
      c.lum[i] = Math.min(1, Math.max(0.05, l));
      c.tint[i * 3] = r;
      c.tint[i * 3 + 1] = g;
      c.tint[i * 3 + 2] = b;
      c.alpha[i] = 1;
    }
  }
}

/** Oak: long, narrow, blocky ridges split by deep furrows and broken across by cracks, with moss and lichen. */
function oakBark(): Painter {
  const n = noise2(101);
  const m = noise2(202);
  const h = (a: number, b: number) => n(a * 12.9898 + 0.5, b * 78.233 + 0.5);
  return (u, v) => {
    // ridges meander a little as they climb
    const uw = u + (fbm(n, u * 2, v * 1.6, 3) - 0.5) * 0.22;
    // ridges drift, pinch together and spread apart as they climb
    const cu = uw * 7 + (fbm(m, u * 1.5 + 4, v * 0.8, 3) - 0.5) * 3.2;
    const ci = Math.floor(cu);
    const fu = cu - ci;
    // each ridge breaks into long plates at its own rhythm
    const rows = 2.2 + h(ci, 1) * 2.5;
    const cv = v * rows + h(ci, 2) * 7 + (fu - 0.5) * (h(ci, 5) - 0.5) * 0.8;
    const cj = Math.floor(cv);
    const fv = cv - cj;
    const wob = (fbm(m, u * 22, v * 7, 3) - 0.5) * 0.2;
    const fw = 0.14 + 0.16 * fbm(n, ci * 3.7, v * 3, 2);
    const side = Math.min(fu + wob, 1 - fu - wob);
    const furrow = 1 - sstep(0.0, fw, side);
    const brk = (1 - sstep(0.0, 0.05, Math.min(fv, 1 - fv) + wob * 0.2)) * (1 - furrow);
    // lit left flank, shaded right flank: every plate looks raised
    const bevel = (fu < 0.5 ? 1 : -0.7) * (1 - sstep(fw, fw + 0.14, side));
    let l = 0.66 + 0.22 * h(ci + 3, cj) - 0.58 * furrow - 0.38 * brk + 0.14 * bevel * (1 - furrow);
    // fibrous vertical grain and pitted, rough surfaces
    l *= 0.78 + 0.34 * fbm(m, u * 70, v * 3.5, 3);
    l *= 0.86 + 0.2 * fbm(n, u * 45 + 2, v * 30, 2);
    const moss = sstep(0.6, 0.72, fbm(m, u * 3 + 9, v * 2, 4)) * (0.35 + 0.65 * furrow);
    const lichen = sstep(0.74, 0.8, fbm(n, u * 6 + 3, v * 3 + 5, 4)) * (1 - furrow) * 0.6;
    let r = 1.02;
    let g = 1;
    let b = 0.95;
    r = r * (1 - moss) + 0.78 * moss;
    g = g * (1 - moss) + 1.14 * moss;
    b = b * (1 - moss) + 0.6 * moss;
    if (lichen > 0) {
      l = l * (1 - lichen) + 0.95 * lichen;
      r = r * (1 - lichen) + 1.2 * lichen;
      g = g * (1 - lichen) + 1.3 * lichen;
      b = b * (1 - lichen) + 1.2 * lichen;
    }
    return [l, r, g, b];
  };
}

/** Pine: big reddish scaly plates split by dark cracks, flaking at the edges. */
function pineBark(): Painter {
  const rnd = rng(303);
  const n = noise2(404);
  // jittered lattice of plate centres, plates taller than wide
  const gx = 6;
  const gy = 5;
  const pts: { x: number; y: number; t: number; w: number }[] = [];
  for (let j = -1; j <= gy; j++) for (let i = -1; i <= gx; i++) pts.push({ x: (i + 0.15 + rnd() * 0.7) / gx, y: (j + 0.15 + rnd() * 0.7) / gy, t: rnd(), w: rnd() });
  return (u, v) => {
    let d1 = 9;
    let d2 = 9;
    let best = pts[0];
    const wu = u + (fbm(n, u * 6, v * 6, 2) - 0.5) * 0.06;
    for (const p of pts) {
      const dx = (wu - p.x) * 1.0;
      const dy = (v - p.y) * 0.5;
      const d = dx * dx + dy * dy;
      if (d < d1) {
        d2 = d1;
        d1 = d;
        best = p;
      } else if (d < d2) d2 = d;
    }
    const edge = Math.sqrt(d2) - Math.sqrt(d1);
    let l = 0.62 + 0.3 * best.t;
    // papery layers inside each plate
    const lay = fbm(n, u * 18 + best.t * 9, v * 40, 3);
    l *= 0.8 + 0.3 * lay;
    l *= 0.88 + 0.18 * fbm(n, u * 70, v * 70, 2);
    // flaky, layered edges, then a dark crack of uneven width between plates
    const cw = 0.004 + 0.012 * fbm(n, u * 9 + 4, v * 9, 2);
    l *= 0.72 + 0.28 * sstep(cw, cw + 0.03, edge);
    l *= 0.18 + 0.82 * sstep(cw * 0.4, cw, edge);
    const warm = 0.5 + 0.5 * best.w;
    return [l, 1.02 + 0.12 * warm, 0.92 + 0.04 * warm, 0.84 - 0.06 * warm];
  };
}

/** Birch: chalk-white bark with dark horizontal lenticels, black scars and peeling warm patches. */
function birchBark(): Painter {
  const rnd = rng(505);
  const n = noise2(606);
  const dashes = Array.from({ length: 110 }, () => ({ x: rnd(), y: rnd(), w: 0.02 + rnd() * 0.1, h: 0.0015 + rnd() * 0.004, k: 0.3 + rnd() * 0.45 }));
  const scars = Array.from({ length: 4 }, () => ({ x: 0.15 + rnd() * 0.7, y: 0.1 + rnd() * 0.8, w: 0.06 + rnd() * 0.1, h: 0.012 + rnd() * 0.02 }));
  return (u, v) => {
    let l = 0.95 - 0.07 * fbm(n, u * 3, v * 60, 3);
    let r = 1;
    let g = 1;
    let b = 1;
    for (const d of dashes) {
      const dx = Math.abs(u - d.x) / d.w;
      const dy = Math.abs(v - d.y) / d.h;
      if (dx < 1 && dy < 1) {
        const k = (1 - dx * dx) * (1 - dy * dy);
        l -= d.k * sstep(0.1, 0.5, k);
      }
    }
    for (const sc of scars) {
      // ragged black diamonds where old branches fell
      const dx = Math.abs(u - sc.x) / sc.w;
      const dy = Math.abs(v - sc.y) / sc.h;
      const k = 1 - (dx + dy * 0.6) - (fbm(n, u * 30, v * 30, 2) - 0.5) * 0.5;
      if (k > 0) l = l * (1 - sstep(0.0, 0.15, k)) + 0.1 * sstep(0.0, 0.15, k);
    }
    // peeling bark shows warm, papery patches
    const peel = sstep(0.62, 0.7, fbm(n, u * 5 + 7, v * 9, 3));
    r = 1 + 0.08 * peel;
    g = 1 - 0.02 * peel;
    b = 1 - 0.12 * peel;
    return [l, r, g, b];
  };
}

/** Cherry: smooth, glossy dark bark banded with rows of pale horizontal lenticels. */
function cherryBark(): Painter {
  const rnd = rng(707);
  const n = noise2(808);
  const bands = Array.from({ length: 14 }, (_, i) => ({ y: (i + 0.2 + rnd() * 0.6) / 14, s: rnd() }));
  return (u, v) => {
    let l = 0.78 + 0.12 * fbm(n, u * 2, v * 4, 3);
    // faint ring texture around the trunk
    l *= 0.94 + 0.06 * Math.sin(v * 140 + fbm(n, u * 8, v * 8, 2) * 4);
    let r = 1.04;
    let g = 0.93;
    let b = 0.9;
    for (const bd of bands) {
      const dy = Math.abs(v - bd.y - (fbm(n, u * 3, bd.s * 9, 2) - 0.5) * 0.02);
      if (dy > 0.03) continue;
      // a broken row of short pale dashes, some missing, all different lengths
      const cellU = u * (9 + bd.s * 7) + bd.s * 5;
      const ci = Math.floor(cellU);
      const fu = cellU - ci;
      const len = 0.3 + 0.4 * n(ci * 1.7, bd.s * 13);
      const keep = n(ci * 3.1 + 7, bd.s * 5) > 0.35 ? 1 : 0;
      const on = keep * sstep(0.05, 0.12, fu) * (1 - sstep(len, len + 0.08, fu));
      const k = on * (1 - sstep(0.002, 0.006, dy)) * 0.75;
      l = l * (1 - k) + 0.95 * k;
      r = r * (1 - k) + 1.12 * k;
      g = g * (1 - k) + 1.05 * k;
      b = b * (1 - k) + 0.95 * k;
    }
    // soft sheen streaks along the trunk
    l += 0.06 * sstep(0.6, 0.9, fbm(n, u * 6 + 3, v * 1.5, 2));
    return [l, r, g, b];
  };
}

/** Spread leaf colour into transparent texels (a few passes of a 3×3 max-alpha fill). */
function dilate(c: Canvas, passes: number) {
  const n = c.size;
  const total = c.size * c.height;
  const filled = new Uint8Array(total);
  for (let i = 0; i < total; i++) filled[i] = c.alpha[i] > 0.02 ? 1 : 0;
  for (let p = 0; p < passes; p++) {
    const next = filled.slice();
    for (let y = 1; y < c.height - 1; y++) {
      for (let x = 1; x < n - 1; x++) {
        const i = y * n + x;
        if (filled[i]) continue;
        let sum = 0;
        let k = 0;
        for (const o of [-1, 1, -n, n]) {
          if (filled[i + o]) {
            sum += c.lum[i + o];
            k++;
          }
        }
        if (k) {
          c.lum[i] = sum / k;
          next[i] = 1;
        }
      }
    }
    filled.set(next);
  }
  for (let i = 0; i < total; i++) if (!filled[i]) c.lum[i] = 0.7;
}

/** Alpha-test threshold the foliage materials use (mips are built to keep coverage at it). */
export const LEAF_CUTOFF = 0.42;

/**
 * Replace the GPU's box-filtered mipmaps with coverage-preserving ones: each
 * smaller level's alpha is rescaled (per atlas cell) so the same share of it
 * passes the alpha test as at full size. Without this, distant crowns thin out
 * into grainy, see-through speckle; with it they stay full and soft.
 */
function uploadCoverageMips(scene: Scene, tex: Texture, c: Canvas) {
  const engine = scene.getEngine() as unknown as {
    updateTextureData?: (t: unknown, d: ArrayBufferView, x: number, y: number, w: number, h: number, face: number, lod: number, gen: boolean) => void;
  };
  const internal = tex.getInternalTexture();
  if (!engine.updateTextureData || !internal) return;
  // share of one cell's texels passing the alpha test
  const coverage = (alpha: Float32Array, w: number, cx: number, cy: number, cs: number, s: number) => {
    let k = 0;
    for (let y = cy * cs; y < (cy + 1) * cs; y++) for (let x = cx * cs; x < (cx + 1) * cs; x++) if (alpha[y * w + x] * s > LEAF_CUTOFF) k++;
    return k / (cs * cs);
  };
  const cells = COLS * ROWS;
  const cs0 = c.size / COLS;
  const target = Array.from({ length: cells }, (_, q) => coverage(c.alpha, c.size, q % COLS, Math.floor(q / COLS), cs0, 1));
  let lum = c.lum;
  let tint = c.tint;
  let alpha = c.alpha;
  let w = c.size;
  let h = c.height;
  for (let lod = 1; w > 1 || h > 1; lod++) {
    const mw = Math.max(1, w >> 1);
    const mh = Math.max(1, h >> 1);
    const nl = new Float32Array(mw * mh);
    const nt = new Float32Array(mw * mh * 3);
    const na = new Float32Array(mw * mh);
    for (let y = 0; y < mh; y++) {
      for (let x = 0; x < mw; x++) {
        let a = 0;
        let l = 0;
        let lw = 0;
        let tr = 0;
        let tg = 0;
        let tb = 0;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const sx = Math.min(w - 1, x * 2 + dx);
          const sy = Math.min(h - 1, y * 2 + dy);
          const i = sy * w + sx;
          a += alpha[i];
          // colour averaged by coverage, so empty texels don't grey the leaves
          const wt = alpha[i] + 0.02;
          l += lum[i] * wt;
          tr += tint[i * 3] * wt;
          tg += tint[i * 3 + 1] * wt;
          tb += tint[i * 3 + 2] * wt;
          lw += wt;
        }
        const o = y * mw + x;
        nl[o] = l / lw;
        nt[o * 3] = tr / lw;
        nt[o * 3 + 1] = tg / lw;
        nt[o * 3 + 2] = tb / lw;
        na[o] = a / 4;
      }
    }
    // rescale each cell's alpha back to its full-size coverage
    const scaled = new Float32Array(na);
    const cs = mw / COLS;
    if (cs >= 2 && Number.isInteger(cs)) {
      for (let q = 0; q < cells; q++) {
        const qx = q % COLS;
        const qy = Math.floor(q / COLS);
        if (target[q] >= 0.999) continue;
        let lo = 0.5;
        let hi = 4;
        for (let it = 0; it < 14; it++) {
          const mid = (lo + hi) / 2;
          if (coverage(na, mw, qx, qy, cs, mid) < target[q]) lo = mid;
          else hi = mid;
        }
        const sc = (lo + hi) / 2;
        for (let y = qy * cs; y < (qy + 1) * cs; y++) for (let x = qx * cs; x < (qx + 1) * cs; x++) scaled[y * mw + x] = Math.min(1, na[y * mw + x] * sc);
      }
    }
    engine.updateTextureData(internal, packMip(nl, nt, scaled, mw * mh), 0, 0, mw, mh, 0, lod, false);
    lum = nl;
    tint = nt;
    alpha = na;
    w = mw;
    h = mh;
  }
}

function packMip(lum: Float32Array, tint: Float32Array, alpha: Float32Array, count: number) {
  const out = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const l = Math.min(1, Math.max(0, lum[i]));
    for (let k = 0; k < 3; k++) out[i * 4 + k] = Math.round(Math.min(1, l * tint[i * 3 + k]) * 255);
    out[i * 4 + 3] = Math.round(Math.min(1, alpha[i]) * 255);
  }
  return out;
}

let cached: Texture | null = null;

/** The shared foliage atlas (built once). */
export function getLeafAtlas(scene: Scene): Texture {
  if (cached && cached.getScene() === scene) return cached;
  const cell = 512;
  const width = cell * COLS;
  const height = cell * ROWS;
  const c: Canvas = { size: width, height, lum: new Float32Array(width * height), tint: new Float32Array(width * height * 3).fill(1), alpha: new Float32Array(width * height) };
  clump(c, 0, 0, cell, { count: 300, len: [0.05, 0.085], wid: 0.5, seed: 11, radius: 0.38 });
  clump(c, 1, 0, cell, { count: 420, len: [0.035, 0.06], wid: 0.75, seed: 23, radius: 0.4 });
  needles(c, 0, 1, cell, 37);
  // opaque canopy cores, cones and boulders sample this flat cell
  paintCell(c, 1, 1, cell, () => [0.86, 1, 1, 1]);
  paintCell(c, 2, 0, cell, oakBark());
  paintCell(c, 3, 0, cell, pineBark());
  paintCell(c, 2, 1, cell, birchBark());
  paintCell(c, 3, 1, cell, cherryBark());
  dilate(c, 24);
  // stored in sRGB space: the albedo sampler converts to linear
  const tex = RawTexture.CreateRGBATexture(packMip(c.lum, c.tint, c.alpha, width * height), width, height, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  tex.name = 'leafAtlas';
  tex.wrapU = tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  tex.hasAlpha = true;
  tex.anisotropicFilteringLevel = 4;
  uploadCoverageMips(scene, tex, c);
  cached = tex;
  return tex;
}
