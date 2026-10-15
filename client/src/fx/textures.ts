// Procedural textures for the effects, generated once at start-up.
//
// Sprite atlas (1024², 4×4 cells): small shapes for particles, computed per
// pixel. Red holds the "white-hot core" mask, alpha the full shape, so the
// shader can tint the shape and burn the core towards white.
//
// Decal atlas (2048², 4×4 cells): large ground patterns drawn with canvas 2D
// (magic circles, telegraphs, shockwaves, scorch, cracks, frost, reticles...).
// Same channel layout: white strokes become the bright core, black strokes
// with alpha are the tinted body.
import { Constants, RawTexture, type Scene } from '@babylonjs/core';

/** Sprite atlas cells (0..15 come from the atlas, 16+ are procedural in the shader). */
export const S = {
  glow: 0,
  star4: 1,
  star8: 2,
  spark: 3,
  ring: 4,
  smoke: 5,
  shard: 6,
  leaf: 7,
  snow: 8,
  flame: 9,
  runeA: 10,
  runeB: 11,
  petal: 12,
  crescent: 13,
  bokeh: 14,
  cross: 15,
  fire: 16,
  orb: 17,
  shock: 18,
  wisp: 19,
} as const;

/** Decal atlas cells. */
export const D = {
  arcane: 0,
  telegraph: 1,
  fill: 2,
  shock: 3,
  scorch: 4,
  cracks: 5,
  frost: 6,
  reticle: 7,
  sun: 8,
  vines: 9,
  hex: 10,
  soft: 11,
  ascend: 12,
  shield: 13,
  dashes: 14,
  rays: 15,
} as const;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// --------------------------------------------------------------- value noise
function hash2(x: number, y: number) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x: number, y: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm(x: number, y: number) {
  let v = 0;
  let amp = 0.5;
  for (let o = 0; o < 4; o++) {
    v += vnoise(x, y) * amp;
    x = x * 2.03 + 17.1;
    y = y * 2.03 + 3.7;
    amp *= 0.5;
  }
  return v;
}

/** Distance from p to segment ab. */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1));
  const qx = ax + dx * t - px;
  const qy = ay + dy * t - py;
  return Math.sqrt(qx * qx + qy * qy);
}

// Rune glyphs as polylines on a [-1, 1] grid (shared by sprites and decals).
const RUNES: number[][][] = [
  [[0, -1, 0, 1], [0, 0.2, 0.6, 0.8], [0, -0.2, 0.6, -0.8]],
  [[-0.4, -1, -0.4, 1], [-0.4, 1, 0.5, 0.4], [0.5, 0.4, -0.4, 0], [-0.4, 0, 0.5, -0.6]],
  [[0, -1, 0, 1], [0, 0.4, -0.6, 1], [0, 0.4, 0.6, 1]],
  [[-0.5, -1, -0.5, 1], [0.5, -1, 0.5, 1], [-0.5, 0.6, 0.5, -0.2]],
  [[0, 1, 0.6, 0.2], [0.6, 0.2, 0, -0.6], [0, -0.6, -0.6, 0.2], [-0.6, 0.2, 0, 1], [0, -0.6, -0.6, -1], [0, -0.6, 0.6, -1]],
  [[-0.5, 1, 0.5, -1], [0.5, 1, -0.5, -1], [-0.5, 1, 0.5, 1]],
  [[0, -1, 0, 1], [-0.6, 0.5, 0.6, 0.5], [-0.6, 0.5, -0.6, 0], [0.6, 0.5, 0.6, 0]],
  [[-0.5, -1, -0.5, 1], [-0.5, 1, 0.5, 0.5], [0.5, 0.5, -0.5, 0], [-0.5, 0, 0.5, -0.5], [0.5, -0.5, -0.5, -1]],
  [[-0.6, 1, 0.6, 1], [0.6, 1, -0.6, -1], [-0.6, -1, 0.6, -1]],
  [[0, 1, 0, -1], [-0.6, 0, 0, 1], [0.6, 0, 0, 1], [-0.6, -0.6, 0.6, -0.6]],
  [[-0.6, -1, -0.6, 0.3], [-0.6, 0.3, 0, 1], [0, 1, 0.6, 0.3], [0.6, 0.3, 0.6, -1]],
  [[0, -1, 0, 1], [-0.6, 1, 0, 0.3], [0.6, -1, 0, -0.3]],
];

function runeDist(idx: number, x: number, y: number) {
  let d = 9;
  for (const s of RUNES[idx % RUNES.length]) d = Math.min(d, segDist(x, y, s[0], s[1], s[2], s[3]));
  return d;
}

// --------------------------------------------------------------- sprite cells
type Cell = (x: number, y: number) => [number, number];

const CELLS: Cell[] = [
  // 0 glow
  (x, y) => {
    const r2 = x * x + y * y;
    const r = Math.sqrt(r2);
    return [Math.exp(-r2 * 26), Math.exp(-r2 * 4.2) * (1 - sstep(0.82, 1, r))];
  },
  // 1 four-point sparkle
  (x, y) => {
    const ax = Math.abs(x);
    const ay = Math.abs(y);
    const r2 = x * x + y * y;
    const m = Math.pow(ax, 0.42) + Math.pow(ay, 0.42);
    const star = sstep(1.02, 0.78, m);
    const halo = Math.exp(-r2 * 9) * 0.45;
    const edge = 1 - sstep(0.9, 1, Math.sqrt(r2));
    return [clamp01(sstep(0.82, 0.35, m) + Math.exp(-r2 * 70)), Math.max(star, halo) * edge];
  },
  // 2 eight-ray impact burst
  (x, y) => {
    const r = Math.sqrt(x * x + y * y);
    const th = Math.atan2(y, x);
    const ray = Math.pow(Math.abs(Math.cos(4 * th)), 26);
    const longer = 0.55 + 0.45 * Math.pow(Math.abs(Math.cos(2 * th)), 6);
    const len = 0.2 + 0.78 * ray * longer;
    const shape = sstep(len, len * 0.55, r);
    const disc = sstep(0.32, 0.12, r);
    const halo = Math.exp(-r * r * 14) * 0.5;
    return [clamp01(sstep(len * 0.55, 0, r) * 1.2 + disc * 0.6), clamp01(Math.max(shape, disc, halo)) * (1 - sstep(0.94, 1, r))];
  },
  // 3 spark streak (head at +y)
  (x, y) => {
    const t = 1 - Math.abs(y);
    const w = 0.012 + 0.11 * t * t;
    const prof = Math.exp(-(x * x) / (w * w));
    const head = 0.3 + 0.7 * sstep(-1, 0.6, y);
    const a = prof * sstep(0, 0.25, t) * head;
    return [a * a * sstep(0.2, 0.7, t), a];
  },
  // 4 thin ring
  (x, y) => {
    const r = Math.sqrt(x * x + y * y);
    const d = r - 0.8;
    return [Math.exp(-(d * d) / 0.0012), clamp01(Math.exp(-(d * d) / 0.006) + Math.exp(-(d * d) / 0.05) * 0.25) * (1 - sstep(0.95, 1, r))];
  },
  // 5 smoke puff
  (x, y) => {
    const r = Math.sqrt(x * x + y * y);
    const n = fbm(x * 2.2 + 10, y * 2.2 + 4);
    const n2 = fbm(x * 5 + 3, y * 5 + 9);
    const a = sstep(1.0, 0.25, r + (n - 0.5) * 0.8) * (0.5 + 0.5 * n2);
    return [0, a * (1 - sstep(0.9, 1, r))];
  },
  // 6 crystal shard (rhombus with a lit facet)
  (x, y) => {
    const d = Math.abs(x) / 0.32 + Math.abs(y);
    const a = sstep(1, 0.92, d);
    const facet = x > 0 ? 0.9 : 0.35;
    return [a * sstep(0.85, 0.2, d) * facet + a * 0.15, a];
  },
  // 7 leaf with a midrib
  (x, y) => {
    const yy = y * 0.5 + 0.5;
    const w = 0.44 * Math.pow(Math.max(0, Math.sin(Math.PI * yy)), 0.85) * (1 - 0.25 * yy);
    const xx = x - 0.06 * Math.sin(y * 2.5);
    const a = sstep(w, w - 0.05, Math.abs(xx)) * sstep(1, 0.9, Math.abs(y));
    const rib = Math.exp(-(xx * xx) * 900) * (1 - yy * 0.5);
    return [clamp01(rib + a * 0.25), a];
  },
  // 8 snowflake
  (x, y) => {
    const r = Math.sqrt(x * x + y * y);
    let th = Math.atan2(y, x);
    const sec = Math.PI / 3;
    th = ((th % sec) + sec) % sec;
    if (th > sec / 2) th = sec - th;
    const px = Math.cos(th) * r;
    const py = Math.sin(th) * r;
    let d = segDist(px, py, 0, 0, 0.9, 0);
    for (const b of [0.38, 0.62]) {
      const l = 0.32 * (1 - b * 0.6);
      d = Math.min(d, segDist(px, py, b, 0, b + Math.cos(sec) * l, Math.sin(sec) * l));
    }
    const hex = Math.abs(r - 0.18) < 0.04 ? 0 : 9;
    d = Math.min(d, hex);
    return [sstep(0.035, 0.0, d), sstep(0.075, 0.035, d) * (1 - sstep(0.95, 1, r))];
  },
  // 9 flame tongue (tip at +y)
  (x, y) => {
    const yy = y * 0.5 + 0.5;
    const n = fbm(x * 3 + 2, y * 3 + 7);
    const w = 0.62 * Math.pow(Math.max(0, 1 - yy), 0.65) * sstep(0, 0.22, yy + 0.05);
    const xx = x + (n - 0.5) * 0.25 * yy;
    const a = sstep(w, w * 0.6, Math.abs(xx)) * sstep(1, 0.85, yy);
    const wc = w * 0.5;
    const core = sstep(wc, wc * 0.2, Math.abs(xx)) * sstep(0.75, 0.2, yy);
    return [core, a];
  },
  // 10 rune A in a circle
  (x, y) => {
    const r = Math.sqrt(x * x + y * y);
    const d = Math.min(runeDist(0, x * 1.7, y * 1.7) / 1.7, Math.abs(r - 0.82));
    return [sstep(0.03, 0.0, d), sstep(0.07, 0.025, d)];
  },
  // 11 rune B in a circle
  (x, y) => {
    const r = Math.sqrt(x * x + y * y);
    const d = Math.min(runeDist(4, x * 1.7, y * 1.7) / 1.7, Math.abs(r - 0.82));
    return [sstep(0.03, 0.0, d), sstep(0.07, 0.025, d)];
  },
  // 12 petal
  (x, y) => {
    const yy = y * 0.5 + 0.5;
    const w = 0.5 * Math.sin(Math.PI * Math.pow(yy, 0.7)) * (1 - 0.15 * yy);
    const notch = yy > 0.85 ? Math.abs(x) * 0.6 : 0;
    const a = sstep(w, w - 0.06, Math.abs(x) + notch) * sstep(1, 0.92, Math.abs(y));
    return [a * (0.15 + 0.6 * (1 - yy)), a];
  },
  // 13 crescent
  (x, y) => {
    const r1 = Math.sqrt(x * x + y * y);
    const r2 = Math.sqrt((x - 0.32) ** 2 + (y - 0.12) ** 2);
    const a = sstep(0.9, 0.86, r1) * sstep(0.74, 0.8, r2);
    return [a * sstep(0.6, 0.86, r1), a];
  },
  // 14 bokeh disc with a bright rim
  (x, y) => {
    const r = Math.sqrt(x * x + y * y);
    const disc = sstep(0.82, 0.78, r);
    return [disc * sstep(0.6, 0.8, r), disc * (0.3 + 0.7 * sstep(0.45, 0.8, r))];
  },
  // 15 cross twinkle
  (x, y) => {
    const ax = Math.abs(x);
    const ay = Math.abs(y);
    const h = Math.exp(-(y * y) * 1400) * Math.pow(1 - ax, 2);
    const v = Math.exp(-(x * x) * 1400) * Math.pow(1 - ay, 2);
    const g = Math.exp(-(x * x + y * y) * 40);
    return [clamp01((h + v) * 0.9 + g), clamp01(h + v + g * 0.8)];
  },
];

export function createSpriteAtlas(scene: Scene) {
  const S2 = 1024;
  const C = 256;
  const data = new Uint8Array(S2 * S2 * 4);
  for (let ci = 0; ci < 16; ci++) {
    const fn = CELLS[ci];
    const ox = (ci % 4) * C;
    const oy = Math.floor(ci / 4) * C;
    for (let j = 0; j < C; j++) {
      const y = ((j + 0.5) / C) * 2 - 1;
      for (let i = 0; i < C; i++) {
        const x = ((i + 0.5) / C) * 2 - 1;
        const [core, a] = fn(x * 1.04, y * 1.04);
        const k = ((oy + j) * S2 + ox + i) * 4;
        const cv = Math.round(clamp01(core) * 255);
        data[k] = cv;
        data[k + 1] = cv;
        data[k + 2] = cv;
        data[k + 3] = Math.round(clamp01(a) * 255);
      }
    }
  }
  const t = new RawTexture(data, S2, S2, Constants.TEXTUREFORMAT_RGBA, scene, true, false, Constants.TEXTURE_TRILINEAR_SAMPLINGMODE);
  t.name = 'fxSprites';
  t.wrapU = t.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  t.hasAlpha = true;
  return t;
}

// --------------------------------------------------------------- decal atlas
type Ctx = CanvasRenderingContext2D;
const W = 'rgba(255,255,255,1)';
const B = (a: number) => `rgba(0,0,0,${a})`;

function ring(ctx: Ctx, r: number, width: number, style: string) {
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.lineWidth = width;
  ctx.strokeStyle = style;
  ctx.stroke();
}

function softRing(ctx: Ctx, r: number, width: number, a: number) {
  const g = ctx.createRadialGradient(0, 0, Math.max(0, r - width), 0, 0, r + width);
  g.addColorStop(0, B(0));
  g.addColorStop(0.5, B(a));
  g.addColorStop(1, B(0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r + width, 0, Math.PI * 2);
  ctx.fill();
}

function disc(ctx: Ctx, r: number, inner: number, outer: number, stops?: [number, number][]) {
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  if (stops) for (const [o, a] of stops) g.addColorStop(o, B(a));
  else {
    g.addColorStop(0, B(inner));
    g.addColorStop(1, B(outer));
  }
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
}

function polygon(ctx: Ctx, n: number, r: number, rot: number, step = 1) {
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = rot + ((i * step) / n) * Math.PI * 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
}

function rune(ctx: Ctx, idx: number, x: number, y: number, size: number, rot: number, width: number, style: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.beginPath();
  for (const s of RUNES[idx % RUNES.length]) {
    ctx.moveTo(s[0] * size, -s[1] * size);
    ctx.lineTo(s[2] * size, -s[3] * size);
  }
  ctx.lineWidth = width;
  ctx.strokeStyle = style;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();
}

function runeBand(ctx: Ctx, r: number, count: number, size: number, width: number, seed: number) {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    rune(ctx, (i * 7 + seed) % RUNES.length, Math.cos(a) * r, Math.sin(a) * r, size, a + Math.PI / 2, width, W);
  }
}

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const DECALS: ((ctx: Ctx, R: number) => void)[] = [
  // 0 arcane magic circle
  (ctx, R) => {
    disc(ctx, R, 0, 0, [[0, 0.1], [0.7, 0.16], [0.95, 0.3], [1, 0]]);
    softRing(ctx, R * 0.93, 18, 0.5);
    ring(ctx, R * 0.97, 3, W);
    ring(ctx, R * 0.9, 6, W);
    runeBand(ctx, R * 0.8, 18, R * 0.04, 3.5, 1);
    ring(ctx, R * 0.7, 4, W);
    ring(ctx, R * 0.66, 2, W);
    // hexagram
    polygon(ctx, 3, R * 0.66, -Math.PI / 2);
    ctx.lineWidth = 4;
    ctx.strokeStyle = W;
    ctx.stroke();
    polygon(ctx, 3, R * 0.66, Math.PI / 2);
    ctx.stroke();
    polygon(ctx, 6, R * 0.33, 0);
    ctx.lineWidth = 3;
    ctx.stroke();
    ring(ctx, R * 0.24, 3, W);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
      ctx.save();
      ctx.translate(Math.cos(a) * R * 0.66, Math.sin(a) * R * 0.66);
      ring(ctx, R * 0.055, 3, W);
      ctx.restore();
    }
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const l = i % 4 === 0 ? 0.06 : 0.025;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * R * 0.9, Math.sin(a) * R * 0.9);
      ctx.lineTo(Math.cos(a) * R * (0.9 - l), Math.sin(a) * R * (0.9 - l));
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = W;
      ctx.stroke();
    }
    ring(ctx, R * 0.07, 6, W);
  },
  // 1 menacing telegraph ring
  (ctx, R) => {
    disc(ctx, R, 0, 0, [[0, 0.12], [0.75, 0.2], [0.92, 0.45], [1, 0]]);
    ring(ctx, R * 0.96, 7, W);
    ring(ctx, R * 0.88, 3, W);
    // inward teeth
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const a0 = a - 0.07;
      const a1 = a + 0.07;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a0) * R * 0.88, Math.sin(a0) * R * 0.88);
      ctx.lineTo(Math.cos(a) * R * (i % 2 ? 0.8 : 0.74), Math.sin(a) * R * (i % 2 ? 0.8 : 0.74));
      ctx.lineTo(Math.cos(a1) * R * 0.88, Math.sin(a1) * R * 0.88);
      ctx.fillStyle = W;
      ctx.fill();
    }
    runeBand(ctx, R * 0.64, 14, R * 0.045, 4, 5);
    ring(ctx, R * 0.54, 2.5, W);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * R * 0.5, Math.sin(a) * R * 0.5);
      ctx.lineTo(Math.cos(a) * R * 0.2, Math.sin(a) * R * 0.2);
      ctx.lineWidth = 4;
      ctx.strokeStyle = W;
      ctx.stroke();
    }
    ring(ctx, R * 0.16, 3, W);
  },
  // 2 fill disc with a bright advancing rim
  (ctx, R) => {
    disc(ctx, R, 0, 0, [[0, 0.18], [0.8, 0.32], [0.93, 0.7], [0.985, 1], [1, 0]]);
    ring(ctx, R * 0.975, 5, W);
  },
  // 3 shockwave ring
  (ctx, R) => {
    disc(ctx, R, 0, 0, [[0, 0], [0.55, 0.0], [0.82, 0.25], [0.95, 0.9], [1, 0]]);
    softRing(ctx, R * 0.94, 10, 0.6);
    ring(ctx, R * 0.95, 4, W);
  },
  // 4 scorch mark
  (ctx, R) => {
    const rnd = seeded(91);
    for (let i = 0; i < 70; i++) {
      const a = rnd() * Math.PI * 2;
      const d = Math.pow(rnd(), 0.8) * R * 0.6;
      const r = R * (0.1 + rnd() * 0.28) * (1 - d / R);
      const g = ctx.createRadialGradient(Math.cos(a) * d, Math.sin(a) * d, 0, Math.cos(a) * d, Math.sin(a) * d, r);
      g.addColorStop(0, B(0.22));
      g.addColorStop(1, B(0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * d, Math.sin(a) * d, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // splatter streaks
    for (let i = 0; i < 26; i++) {
      const a = rnd() * Math.PI * 2;
      const d0 = R * (0.35 + rnd() * 0.2);
      const d1 = d0 + R * (0.15 + rnd() * 0.3);
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * d0, Math.sin(a) * d0);
      ctx.lineTo(Math.cos(a) * d1, Math.sin(a) * d1);
      ctx.lineWidth = 3 + rnd() * 10;
      ctx.lineCap = 'round';
      ctx.strokeStyle = B(0.35);
      ctx.stroke();
    }
    // glowing embers in the middle (core)
    for (let i = 0; i < 40; i++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * R * 0.45;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * d, Math.sin(a) * d, 1.5 + rnd() * 3, 0, Math.PI * 2);
      ctx.fillStyle = W;
      ctx.fill();
    }
  },
  // 5 ground cracks (core = glowing fissures)
  (ctx, R) => {
    const rnd = seeded(7);
    disc(ctx, R * 0.5, 0.35, 0);
    const branch = (x: number, y: number, a: number, len: number, w: number, depth: number) => {
      let px = x;
      let py = y;
      const steps = 6;
      ctx.beginPath();
      ctx.moveTo(px, py);
      for (let i = 0; i < steps; i++) {
        a += (rnd() - 0.5) * 0.7;
        px += Math.cos(a) * (len / steps);
        py += Math.sin(a) * (len / steps);
        ctx.lineTo(px, py);
      }
      ctx.lineWidth = w * 2.6;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = B(0.6);
      ctx.stroke();
      ctx.lineWidth = w;
      ctx.strokeStyle = W;
      ctx.stroke();
      if (depth > 0) {
        const n = 1 + Math.floor(rnd() * 2);
        for (let k = 0; k < n; k++) branch(px, py, a + (rnd() - 0.5) * 1.6, len * 0.6, w * 0.65, depth - 1);
      }
    };
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + rnd() * 0.4;
      branch(Math.cos(a) * R * 0.08, Math.sin(a) * R * 0.08, a, R * (0.38 + rnd() * 0.15), 5, 2);
    }
    ring(ctx, R * 0.09, 6, W);
  },
  // 6 frost ring: crystal spikes radiating around a ring
  (ctx, R) => {
    const rnd = seeded(33);
    disc(ctx, R, 0, 0, [[0, 0.1], [0.6, 0.2], [0.9, 0.4], [1, 0]]);
    ring(ctx, R * 0.92, 4, W);
    ring(ctx, R * 0.6, 3, W);
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2 + rnd() * 0.05;
      const l = R * (i % 3 === 0 ? 0.36 : 0.2 + rnd() * 0.08);
      const r0 = R * 0.6;
      const w = i % 3 === 0 ? 0.05 : 0.035;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a - w) * r0, Math.sin(a - w) * r0);
      ctx.lineTo(Math.cos(a) * (r0 + l), Math.sin(a) * (r0 + l));
      ctx.lineTo(Math.cos(a + w) * r0, Math.sin(a + w) * r0);
      ctx.closePath();
      ctx.fillStyle = B(0.55);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = W;
      ctx.stroke();
    }
    // snowflake core
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a) * R * 0.5, Math.sin(a) * R * 0.5);
      for (const b of [0.22, 0.36]) {
        const bx = Math.cos(a) * R * b;
        const by = Math.sin(a) * R * b;
        for (const s of [-1, 1]) {
          ctx.moveTo(bx, by);
          ctx.lineTo(bx + Math.cos(a + s * 1.0) * R * 0.1, by + Math.sin(a + s * 1.0) * R * 0.1);
        }
      }
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.strokeStyle = W;
      ctx.stroke();
    }
    polygon(ctx, 6, R * 0.14, 0);
    ctx.lineWidth = 3;
    ctx.stroke();
  },
  // 7 target reticle
  (ctx, R) => {
    disc(ctx, R, 0, 0, [[0, 0.06], [0.8, 0.12], [0.96, 0.3], [1, 0]]);
    ring(ctx, R * 0.95, 5, W);
    ring(ctx, R * 0.86, 2, W);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      ctx.save();
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(R * 0.98, 0);
      ctx.lineTo(R * 0.72, -R * 0.06);
      ctx.lineTo(R * 0.72, R * 0.06);
      ctx.closePath();
      ctx.fillStyle = W;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(R * 0.55, 0);
      ctx.lineTo(R * 0.25, 0);
      ctx.lineWidth = 4;
      ctx.strokeStyle = W;
      ctx.stroke();
      ctx.restore();
    }
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.62, a + 0.04, a + Math.PI / 8 - 0.08);
      ctx.lineWidth = 6;
      ctx.strokeStyle = W;
      ctx.stroke();
    }
    ring(ctx, R * 0.1, 4, W);
  },
  // 8 healing sun lotus
  (ctx, R) => {
    disc(ctx, R, 0, 0, [[0, 0.35], [0.5, 0.2], [0.9, 0.18], [1, 0]]);
    ring(ctx, R * 0.94, 4, W);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ctx.save();
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(R * 0.2, 0);
      ctx.quadraticCurveTo(R * 0.5, R * 0.16, R * 0.8, 0);
      ctx.quadraticCurveTo(R * 0.5, -R * 0.16, R * 0.2, 0);
      ctx.fillStyle = B(0.35);
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = W;
      ctx.stroke();
      ctx.restore();
    }
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * R * 0.87, Math.sin(a) * R * 0.87, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = W;
      ctx.fill();
    }
    ring(ctx, R * 0.2, 4, W);
    ring(ctx, R * 0.1, 8, W);
  },
  // 9 vine rune ring
  (ctx, R) => {
    disc(ctx, R, 0, 0, [[0, 0.12], [0.8, 0.2], [0.95, 0.3], [1, 0]]);
    const rnd = seeded(5);
    for (const ph of [0, Math.PI]) {
      ctx.beginPath();
      for (let i = 0; i <= 200; i++) {
        const a = (i / 200) * Math.PI * 2;
        const r = R * (0.84 + 0.05 * Math.sin(a * 9 + ph));
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.lineWidth = 5;
      ctx.strokeStyle = W;
      ctx.stroke();
    }
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + rnd() * 0.1;
      const r = R * (0.84 + (i % 2 ? 0.08 : -0.08));
      ctx.save();
      ctx.translate(Math.cos(a) * r, Math.sin(a) * r);
      ctx.rotate(a + (i % 2 ? 0.6 : -0.6));
      ctx.beginPath();
      ctx.ellipse(0, 0, R * 0.05, R * 0.02, 0, 0, Math.PI * 2);
      ctx.fillStyle = B(0.8);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = W;
      ctx.stroke();
      ctx.restore();
    }
    runeBand(ctx, R * 0.58, 8, R * 0.06, 4, 3);
    ring(ctx, R * 0.42, 3, W);
  },
  // 10 hex sigil (monster magic)
  (ctx, R) => {
    disc(ctx, R, 0, 0, [[0, 0.2], [0.85, 0.25], [0.95, 0.5], [1, 0]]);
    ring(ctx, R * 0.95, 6, W);
    ring(ctx, R * 0.82, 3, W);
    polygon(ctx, 5, R * 0.82, -Math.PI / 2, 2);
    ctx.lineWidth = 5;
    ctx.strokeStyle = W;
    ctx.stroke();
    runeBand(ctx, R * 0.89, 20, R * 0.025, 2.5, 9);
    ring(ctx, R * 0.3, 4, W);
  },
  // 11 soft glow pool
  (ctx, R) => {
    disc(ctx, R, 0, 0, [[0, 1], [0.35, 0.55], [0.7, 0.15], [1, 0]]);
  },
  // 12 ascension circle (level up)
  (ctx, R) => {
    disc(ctx, R, 0, 0, [[0, 0.3], [0.6, 0.15], [0.95, 0.35], [1, 0]]);
    ring(ctx, R * 0.97, 3, W);
    ring(ctx, R * 0.92, 7, W);
    runeBand(ctx, R * 0.82, 24, R * 0.035, 3, 2);
    ring(ctx, R * 0.73, 3, W);
    // eight-point star
    ctx.beginPath();
    for (let i = 0; i <= 16; i++) {
      const a = (i / 16) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 === 0 ? R * 0.72 : R * 0.3;
      if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.fillStyle = B(0.35);
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = W;
    ctx.stroke();
    ring(ctx, R * 0.24, 4, W);
    ring(ctx, R * 0.12, 10, W);
  },
  // 13 shield crest with laurels (rally)
  (ctx, R) => {
    disc(ctx, R, 0, 0, [[0, 0.25], [0.8, 0.18], [0.95, 0.35], [1, 0]]);
    ring(ctx, R * 0.95, 5, W);
    ring(ctx, R * 0.88, 2, W);
    // shield
    ctx.beginPath();
    ctx.moveTo(0, -R * 0.5);
    ctx.quadraticCurveTo(R * 0.38, -R * 0.42, R * 0.4, -R * 0.36);
    ctx.quadraticCurveTo(R * 0.4, R * 0.15, 0, R * 0.5);
    ctx.quadraticCurveTo(-R * 0.4, R * 0.15, -R * 0.4, -R * 0.36);
    ctx.quadraticCurveTo(-R * 0.38, -R * 0.42, 0, -R * 0.5);
    ctx.fillStyle = B(0.4);
    ctx.fill();
    ctx.lineWidth = 7;
    ctx.strokeStyle = W;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -R * 0.36);
    ctx.lineTo(0, R * 0.34);
    ctx.moveTo(-R * 0.26, -R * 0.12);
    ctx.lineTo(R * 0.26, -R * 0.12);
    ctx.lineWidth = 5;
    ctx.stroke();
    // laurels
    for (const s of [-1, 1]) {
      for (let i = 0; i < 9; i++) {
        const a = Math.PI / 2 + s * (0.5 + i * 0.22);
        ctx.save();
        ctx.translate(Math.cos(a) * R * 0.72, Math.sin(a) * R * 0.72);
        ctx.rotate(a + s * 0.9);
        ctx.beginPath();
        ctx.ellipse(0, 0, R * 0.07, R * 0.025, 0, 0, Math.PI * 2);
        ctx.fillStyle = W;
        ctx.fill();
        ctx.restore();
      }
    }
  },
  // 14 dashed ring
  (ctx, R) => {
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.92, a, a + Math.PI / 24);
      ctx.lineWidth = 10;
      ctx.strokeStyle = W;
      ctx.stroke();
    }
    ring(ctx, R * 0.82, 2, W);
  },
  // 15 ground ray burst
  (ctx, R) => {
    const rnd = seeded(12);
    disc(ctx, R * 0.4, 0.7, 0);
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2 + rnd() * 0.1;
      const l = R * (0.5 + rnd() * 0.45);
      const w = 0.02 + rnd() * 0.03;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a - w) * R * 0.1, Math.sin(a - w) * R * 0.1);
      ctx.lineTo(Math.cos(a) * l, Math.sin(a) * l);
      ctx.lineTo(Math.cos(a + w) * R * 0.1, Math.sin(a + w) * R * 0.1);
      ctx.closePath();
      ctx.fillStyle = i % 2 ? W : B(0.6);
      ctx.fill();
    }
  },
];

export function createDecalAtlas(scene: Scene) {
  const S2 = 2048;
  const C = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S2;
  const ctx = canvas.getContext('2d') as Ctx;
  ctx.clearRect(0, 0, S2, S2);
  DECALS.forEach((draw, i) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect((i % 4) * C, Math.floor(i / 4) * C, C, C);
    ctx.clip();
    ctx.translate((i % 4) * C + C / 2, Math.floor(i / 4) * C + C / 2);
    draw(ctx, C / 2 - 10);
    ctx.restore();
  });
  const img = ctx.getImageData(0, 0, S2, S2).data;
  const data = new Uint8Array(S2 * S2 * 4);
  for (let k = 0; k < data.length; k += 4) {
    const a = img[k + 3];
    // un-premultiplied canvas: white strokes are the core, alpha the shape
    const core = a > 0 ? img[k] : 0;
    data[k] = core;
    data[k + 1] = core;
    data[k + 2] = core;
    data[k + 3] = a;
  }
  const t = new RawTexture(data, S2, S2, Constants.TEXTUREFORMAT_RGBA, scene, true, false, Constants.TEXTURE_TRILINEAR_SAMPLINGMODE);
  t.name = 'fxDecals';
  t.wrapU = t.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  t.anisotropicFilteringLevel = 8;
  t.hasAlpha = true;
  return t;
}
