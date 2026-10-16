// The foliage atlas, painted in code at startup: hand-drawn-looking leaf
// clusters for the stylized trees. Each cell is a fluffy clump of leaves in
// greyscale (the trees tint it with vertex colour), lit from the top so every
// clump already reads as a little ball of leaves before any lighting runs.
//
//   ┌──────────────┬──────────────┬──────────────┬──────────────┐
//   │ broad leaves │ round leaves │  oak bark    │  pine bark   │   row 0
//   ├──────────────┼──────────────┼──────────────┼──────────────┤
//   │ pine needles │ solid (flat) │  birch bark  │ cherry bark  │   row 1
//   ├──────────────┼──────────────┼──────────────┼──────────────┤
//   │ broad, bold  │ round, bold  │ needles,bold │   (spare)    │   row 2
//   └──────────────┴──────────────┴──────────────┴──────────────┘
//
// Leaves are greyscale (vertex colour tints them); the bark cells are painted
// in colour, as multipliers over each species' bark tone. Everything on the
// right half of rows 0–1 is bark, which the foliage shader relies on.
//
// Row 2 holds the same clumps painted boldly, the way a painter simplifies a
// tree across the valley: a full, solid body of foliage with a few big,
// softly shaded leaves breaking its rim. Once a leaf card is small on screen
// the foliage vertex shader switches it to its bold twin (FAR_CELL_SHIFT), so
// a crown reads as soft, full masses with leafy edges instead of a speckle
// of sub-pixel leaves and holes.
// Transparent texels keep the colour of the nearest leaf, so mipmaps never
// bleed dark fringes into the alpha-tested edges.
import { RawTexture, Texture, type Scene } from '@babylonjs/core';

export const ATLAS_CELLS = {
  broad: [0, 0],
  round: [1, 0],
  needle: [0, 1],
  solid: [1, 1],
  broadBold: [0, 2],
  roundBold: [1, 2],
  needleBold: [2, 2],
  barkOak: [2, 0],
  barkPine: [3, 0],
  barkBirch: [2, 1],
  barkCherry: [3, 1],
} as const;

const COLS = 4;
const ROWS = 3;

export type AtlasCell = keyof typeof ATLAS_CELLS;

/**
 * Where each fine leaf cell's bold twin sits, as a UV shift (the foliage
 * vertex shader applies it to small cards): broad and round move down two
 * rows, the needles two rows down and over by half the atlas.
 */
export const FAR_CELL_SHIFT = {
  /** Cards whose v is below this are broad/round leaves (row 0). */
  row0: 1 / ROWS,
  /** Below this (and left of `needleU`) are the pine needles (row 1). */
  row1: 2 / ROWS,
  needleU: 1 / COLS,
  /** Shift for row 0 cells (in v) and for the needles (u, v). */
  dv0: 2 / ROWS,
  needle: [2 / COLS, 1 / ROWS] as [number, number],
};

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
function leaf(c: Canvas, ox: number, oy: number, x: number, y: number, a: number, len: number, wid: number, tone: number, cellSize: number, ink = 0.8, rib = 0.9) {
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
      if (Math.abs(t) < 0.08 && s > 0.08 && s < 0.85) l *= rib; // midrib
      if (edge > 0.8) l *= ink; // inked rim
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

// ------------------------------------------------------------------ bold (far) cells

const smooth01 = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/**
 * A clump painted for distance: a solid body of a few overlapping, softly
 * shaded lobes (each lit from the top-left and casting a soft shade onto the
 * lobe below it), with big leaves breaking the rim so the silhouette stays
 * leafy. No holes inside, no fine dark lines: it averages into a clean,
 * full mass when it is small on screen.
 */
function boldClump(c: Canvas, cx: number, cy: number, cellSize: number, o: { seed: number; radius: number; lobes: number; rim: number; inner: number; len: [number, number]; wid: number }) {
  const r = rng(o.seed);
  const ox = cx * cellSize;
  const oy = cy * cellSize;
  const mid = cellSize / 2;
  const R = cellSize * o.radius;
  // light from the top-left, in texel space (y grows downward)
  const lx = -0.42;
  const ly = -0.9;
  const lobes: { x: number; y: number; r: number }[] = [];
  for (let i = 0; i < o.lobes; i++) {
    const a = (i / o.lobes) * Math.PI * 2 + r() * 0.8;
    const d = (i === 0 ? 0 : 0.3 + r() * 0.25) * R;
    lobes.push({ x: mid + Math.cos(a) * d, y: mid + Math.sin(a) * d * 0.85, r: R * (i === 0 ? 0.62 : 0.4 + r() * 0.14) });
  }
  // bottom lobes first, so the upper ones overlap them like stacked foliage
  lobes.sort((p, q) => q.y - p.y);
  const x0 = Math.max(0, Math.floor(mid - R * 1.3));
  const x1 = Math.min(cellSize - 1, Math.ceil(mid + R * 1.3));
  for (const lb of lobes) {
    for (let py = x0; py <= x1; py++) {
      for (let px = x0; px <= x1; px++) {
        const dx = px + 0.5 - lb.x;
        const dy = py + 0.5 - lb.y;
        const d = Math.hypot(dx, dy);
        const i = (oy + py) * c.size + ox + px;
        // the lobe's soft shade on what is below and beside it
        if (d > lb.r - 1 && d < lb.r * 1.22 && dy > -lb.r * 0.2 && c.alpha[i] > 0) {
          const k = (1 - smooth01((d - lb.r) / (lb.r * 0.22))) * smooth01((dy + lb.r * 0.2) / (lb.r * 0.6));
          c.lum[i] *= 1 - 0.08 * k;
        }
        const cov = Math.min(1, Math.max(0, lb.r - d + 0.5));
        if (cov <= 0) continue;
        // only a hint of roundness: cards spin, so the crown's own lighting
        // (vertex normals) must do the shading, not paint baked into the cell
        const nx = dx / lb.r;
        const ny = dy / lb.r;
        const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
        const ndl = nx * lx + ny * ly + nz * 0.35;
        const l = 0.93 + 0.06 * Math.max(-1, Math.min(1, ndl));
        c.lum[i] = c.lum[i] * (1 - cov) + l * cov;
        c.alpha[i] = Math.max(c.alpha[i], cov);
      }
    }
  }
  const edgeAt = (ang: number) => {
    let d = R * 0.3;
    while (d < R * 1.4) {
      const px = Math.round(mid + Math.cos(ang) * d);
      const py = Math.round(mid + Math.sin(ang) * d * 0.9);
      if (px < 0 || py < 0 || px >= cellSize || py >= cellSize || c.alpha[(oy + py) * c.size + ox + px] < 0.5) break;
      d += 1;
    }
    return d;
  };
  // a few big, low-contrast leaves on the body, then the leafy rim on top
  const leaves: { x: number; y: number; a: number; len: number; tone: number; d: number }[] = [];
  for (let i = 0; i < o.inner + o.rim; i++) {
    const rim = i >= o.inner;
    const ang = r() * Math.PI * 2;
    // rim leaves sit on the body's actual edge, wherever the lobes put it
    const d = (rim ? edgeAt(ang) * (0.86 + r() * 0.12) : Math.sqrt(r()) * 0.7 * R);
    const x = mid + Math.cos(ang) * d;
    const y = mid + Math.sin(ang) * d * 0.9;
    const len = (o.len[0] + r() * (o.len[1] - o.len[0])) * cellSize;
    const a = ang + (r() - 0.5) * (rim ? 0.9 : 1.6);
    const tone = (rim ? 0.92 : 0.88) + r() * 0.1;
    leaves.push({ x, y, a, len, tone, d: rim ? 1 + d : d });
  }
  leaves.sort((p, q) => p.d - q.d);
  for (const l of leaves) leaf(c, ox, oy, l.x - l.len * Math.cos(l.a) * 0.3, l.y - l.len * Math.sin(l.a) * 0.3, l.a, l.len, l.len * o.wid, l.tone, cellSize, 0.93, 0.97);
}

/** Pine sprays painted for distance: solid, tapering fronds fringed by a few thick needles. */
function boldNeedles(c: Canvas, cx: number, cy: number, cellSize: number, seed: number) {
  const r = rng(seed);
  const ox = cx * cellSize;
  const oy = cy * cellSize;
  for (let b = 0; b < 7; b++) {
    const ang = -Math.PI / 2 + (b / 6 - 0.5) * 2.4 + (r() - 0.5) * 0.15;
    const tl = cellSize * (0.32 + r() * 0.1);
    const sx = cellSize * 0.5;
    const sy = cellSize * 0.56;
    // the frond's solid body: a leaf shape along the twig
    leaf(c, ox, oy, sx, sy, ang, tl, tl * 0.42, 0.72 + 0.12 * Math.sin(ang + 2.2), cellSize, 0.96, 1);
    const n = 9;
    for (let k = 1; k < n; k++) {
      const s = k / n;
      const px = sx + Math.cos(ang) * tl * s;
      const py = sy + Math.sin(ang) * tl * s;
      for (const side of [-1, 1]) {
        const na = ang + side * (0.6 + r() * 0.2);
        const nl = cellSize * (0.07 + 0.06 * Math.sin(Math.PI * s)) * (0.85 + r() * 0.3);
        const tone = 0.7 + 0.32 * s + (r() - 0.5) * 0.06;
        leaf(c, ox, oy, px, py, na, nl, nl * 0.3, tone, cellSize, 0.95, 1);
      }
    }
  }
}

/** Scale a leaf cell's shading so its coverage-weighted mean matches another's (the bold twin must not pop brighter or darker). */
function matchTone(c: Canvas, cellSize: number, from: readonly [number, number], to: readonly [number, number]) {
  const mean = ([cx, cy]: readonly [number, number]) => {
    let s = 0;
    let w = 0;
    for (let y = 0; y < cellSize; y++) {
      for (let x = 0; x < cellSize; x++) {
        const i = (cy * cellSize + y) * c.size + cx * cellSize + x;
        s += c.lum[i] * c.alpha[i];
        w += c.alpha[i];
      }
    }
    return w > 0 ? s / w : 1;
  };
  const k = mean(from) / mean(to);
  const [cx, cy] = to;
  for (let y = 0; y < cellSize; y++) for (let x = 0; x < cellSize; x++) c.lum[(cy * cellSize + y) * c.size + cx * cellSize + x] *= k;
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

/** Spread leaf colour into transparent texels (a few passes of a 4-neighbour fill). */
function dilate(c: Canvas, passes: number) {
  const n = c.size;
  const total = c.size * c.height;
  const filled = new Uint8Array(total);
  // only the still-empty texels are visited, so the (opaque) bark cells cost nothing
  let todo: number[] = [];
  for (let i = 0; i < total; i++) {
    if (c.alpha[i] > 0.02) filled[i] = 1;
    else {
      const x = i % n;
      const y = (i / n) | 0;
      if (x > 0 && x < n - 1 && y > 0 && y < c.height - 1) todo.push(i);
    }
  }
  const lum = c.lum;
  const add: number[] = [];
  for (let p = 0; p < passes && todo.length; p++) {
    const rest: number[] = [];
    add.length = 0;
    for (const i of todo) {
      let sum = 0;
      let k = 0;
      if (filled[i - 1]) (sum += lum[i - 1]), k++;
      if (filled[i + 1]) (sum += lum[i + 1]), k++;
      if (filled[i - n]) (sum += lum[i - n]), k++;
      if (filled[i + n]) (sum += lum[i + n]), k++;
      if (k) {
        lum[i] = sum / k;
        add.push(i);
      } else rest.push(i);
    }
    for (const i of add) filled[i] = 1;
    todo = rest;
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

/** Paint the whole atlas on the CPU (exported for the atlas preview tool). */
export function paintAtlas(cell = 512) {
  const width = cell * COLS;
  const height = cell * ROWS;
  const c: Canvas = { size: width, height, lum: new Float32Array(width * height), tint: new Float32Array(width * height * 3).fill(1), alpha: new Float32Array(width * height) };
  clump(c, 0, 0, cell, { count: 360, len: [0.05, 0.085], wid: 0.5, seed: 11, radius: 0.38 });
  clump(c, 1, 0, cell, { count: 500, len: [0.035, 0.06], wid: 0.75, seed: 23, radius: 0.4 });
  needles(c, 0, 1, cell, 37);
  boldClump(c, 0, 2, cell, { seed: 41, radius: 0.33, lobes: 6, rim: 70, inner: 18, len: [0.085, 0.13], wid: 0.5 });
  boldClump(c, 1, 2, cell, { seed: 53, radius: 0.34, lobes: 7, rim: 95, inner: 24, len: [0.06, 0.095], wid: 0.72 });
  boldNeedles(c, 2, 2, cell, 61);
  matchTone(c, cell, ATLAS_CELLS.broad, ATLAS_CELLS.broadBold);
  matchTone(c, cell, ATLAS_CELLS.round, ATLAS_CELLS.roundBold);
  matchTone(c, cell, ATLAS_CELLS.needle, ATLAS_CELLS.needleBold);
  // opaque canopy cores, cones and boulders sample this flat cell
  paintCell(c, 1, 1, cell, () => [0.86, 1, 1, 1]);
  paintCell(c, 3, 2, cell, () => [0.86, 1, 1, 1]);
  paintCell(c, 2, 0, cell, oakBark());
  paintCell(c, 3, 0, cell, pineBark());
  paintCell(c, 2, 1, cell, birchBark());
  paintCell(c, 3, 1, cell, cherryBark());
  dilate(c, 24);
  return { width, height, canvas: c, rgba: () => packMip(c.lum, c.tint, c.alpha, width * height) };
}

/** The shared foliage atlas (built once). */
export function getLeafAtlas(scene: Scene): Texture {
  if (cached && cached.getScene() === scene) return cached;
  const { width, height, canvas: c, rgba } = paintAtlas();
  // stored in sRGB space: the albedo sampler converts to linear
  const tex = RawTexture.CreateRGBATexture(rgba(), width, height, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  tex.name = 'leafAtlas';
  tex.wrapU = tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  tex.hasAlpha = true;
  tex.anisotropicFilteringLevel = 4;
  uploadCoverageMips(scene, tex, c);
  cached = tex;
  return tex;
}
