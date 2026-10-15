// The foliage atlas, painted in code at startup: hand-drawn-looking leaf
// clusters for the stylized trees. Each cell is a fluffy clump of leaves in
// greyscale (the trees tint it with vertex colour), lit from the top so every
// clump already reads as a little ball of leaves before any lighting runs.
//
//   ┌──────────────┬──────────────┐
//   │ broad leaves │ round leaves │   row 0
//   ├──────────────┼──────────────┤
//   │ pine needles │ bark (solid) │   row 1
//   └──────────────┴──────────────┘
//
// Transparent texels keep the colour of the nearest leaf, so mipmaps never
// bleed dark fringes into the alpha-tested edges.
import { RawTexture, Texture, type Scene } from '@babylonjs/core';

export const ATLAS_CELLS = {
  broad: [0, 0],
  round: [1, 0],
  needle: [0, 1],
  bark: [1, 1],
} as const;

export type AtlasCell = keyof typeof ATLAS_CELLS;

/** UV rectangle of a cell, inset a little so bilinear taps never cross into a neighbour. */
export function cellUV(cell: AtlasCell, u: number, v: number): [number, number] {
  const [cx, cy] = ATLAS_CELLS[cell];
  const inset = 0.012;
  const uu = inset + u * (1 - 2 * inset);
  const vv = inset + v * (1 - 2 * inset);
  return [(cx + uu) * 0.5, (cy + vv) * 0.5];
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
  size: number;
  lum: Float32Array;
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

/** Opaque bark: soft vertical streaks and knots (also used for opaque canopy cores). */
function bark(c: Canvas, cx: number, cy: number, cellSize: number) {
  const r = rng(99);
  const ox = cx * cellSize;
  const oy = cy * cellSize;
  const streaks = Array.from({ length: 40 }, () => ({ x: r(), w: 0.004 + r() * 0.012, d: 0.12 + r() * 0.2 }));
  for (let y = 0; y < cellSize; y++) {
    for (let x = 0; x < cellSize; x++) {
      const u = x / cellSize;
      const v = y / cellSize;
      let l = 0.86 + 0.08 * Math.sin(v * 37 + Math.sin(u * 23) * 2);
      for (const s of streaks) {
        const wob = s.x + Math.sin(v * 9 + s.x * 40) * 0.01;
        const dd = Math.abs(u - wob);
        if (dd < s.w) l -= s.d * (1 - dd / s.w);
      }
      const i = (oy + y) * c.size + ox + x;
      c.lum[i] = Math.max(0.35, l);
      c.alpha[i] = 1;
    }
  }
}

/** Spread leaf colour into transparent texels (a few passes of a 3×3 max-alpha fill). */
function dilate(c: Canvas, passes: number) {
  const n = c.size;
  const filled = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) filled[i] = c.alpha[i] > 0.02 ? 1 : 0;
  for (let p = 0; p < passes; p++) {
    const next = filled.slice();
    for (let y = 1; y < n - 1; y++) {
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
  for (let i = 0; i < n * n; i++) if (!filled[i]) c.lum[i] = 0.7;
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
  const coverage = (alpha: Float32Array, n: number, qx: number, qy: number, s: number) => {
    const h = n / 2;
    let k = 0;
    for (let y = qy * h; y < (qy + 1) * h; y++) for (let x = qx * h; x < (qx + 1) * h; x++) if (alpha[y * n + x] * s > LEAF_CUTOFF) k++;
    return k / (h * h);
  };
  const target = [0, 1, 2, 3].map((q) => coverage(c.alpha, c.size, q % 2, q >> 1, 1));
  let lum = c.lum;
  let alpha = c.alpha;
  let n = c.size;
  for (let lod = 1; n > 1; lod++) {
    const m = n / 2;
    const nl = new Float32Array(m * m);
    const na = new Float32Array(m * m);
    for (let y = 0; y < m; y++) {
      for (let x = 0; x < m; x++) {
        let a = 0;
        let l = 0;
        let lw = 0;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const i = (y * 2 + dy) * n + x * 2 + dx;
          a += alpha[i];
          // colour averaged by coverage, so empty texels don't grey the leaves
          l += lum[i] * (alpha[i] + 0.02);
          lw += alpha[i] + 0.02;
        }
        nl[y * m + x] = l / lw;
        na[y * m + x] = a / 4;
      }
    }
    // rescale each cell's alpha back to its full-size coverage
    const scaled = new Float32Array(na);
    if (m >= 4) {
      for (let q = 0; q < 4; q++) {
        const qx = q % 2;
        const qy = q >> 1;
        let lo = 0.5;
        let hi = 4;
        for (let it = 0; it < 14; it++) {
          const mid = (lo + hi) / 2;
          if (coverage(na, m, qx, qy, mid) < target[q]) lo = mid;
          else hi = mid;
        }
        const sc = (lo + hi) / 2;
        const h = m / 2;
        for (let y = qy * h; y < (qy + 1) * h; y++) for (let x = qx * h; x < (qx + 1) * h; x++) scaled[y * m + x] = Math.min(1, na[y * m + x] * sc);
      }
    }
    engine.updateTextureData(internal, packMip(nl, scaled, m), 0, 0, m, m, 0, lod, false);
    lum = nl;
    alpha = na;
    n = m;
  }
}

function packMip(lum: Float32Array, alpha: Float32Array, n: number) {
  const out = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    const l = Math.round(Math.min(1, Math.max(0, lum[i])) * 255);
    out[i * 4] = l;
    out[i * 4 + 1] = l;
    out[i * 4 + 2] = l;
    out[i * 4 + 3] = Math.round(Math.min(1, alpha[i]) * 255);
  }
  return out;
}

let cached: Texture | null = null;

/** The shared foliage atlas (built once). */
export function getLeafAtlas(scene: Scene): Texture {
  if (cached && cached.getScene() === scene) return cached;
  const size = 1024;
  const cell = size / 2;
  const c: Canvas = { size, lum: new Float32Array(size * size), alpha: new Float32Array(size * size) };
  clump(c, 0, 0, cell, { count: 300, len: [0.05, 0.085], wid: 0.5, seed: 11, radius: 0.38 });
  clump(c, 1, 0, cell, { count: 420, len: [0.035, 0.06], wid: 0.75, seed: 23, radius: 0.4 });
  needles(c, 0, 1, cell, 37);
  bark(c, 1, 1, cell);
  dilate(c, 24);
  // stored in sRGB space: the albedo sampler converts to linear
  const tex = RawTexture.CreateRGBATexture(packMip(c.lum, c.alpha, size), size, size, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  tex.name = 'leafAtlas';
  tex.wrapU = tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  tex.hasAlpha = true;
  tex.anisotropicFilteringLevel = 4;
  uploadCoverageMips(scene, tex, c);
  cached = tex;
  return tex;
}
