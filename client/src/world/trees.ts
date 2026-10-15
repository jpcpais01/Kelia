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
  clumps: { c: C3; r: number }[];
}

/** Spread clumps over the upper part of an ellipsoid crown. */
function makeCrown(center: C3, radius: C3, count: number, rnd: () => number, clumpR: [number, number]): Crown {
  const clumps: { c: C3; r: number }[] = [{ c: [center[0], center[1] + radius[1] * 0.45, center[2]], r: clumpR[1] }];
  const rings = [
    { n: Math.max(3, Math.round(count * 0.55)), y: 0.12, rr: 0.7 },
    { n: Math.max(2, Math.round(count * 0.3)), y: -0.4, rr: 0.55 },
  ];
  for (const ring of rings) {
    const off = rnd() * Math.PI * 2;
    for (let i = 0; i < ring.n; i++) {
      const a = off + (i / ring.n) * Math.PI * 2 + (rnd() - 0.5) * 0.5;
      const rr = ring.rr * (0.85 + rnd() * 0.3);
      clumps.push({
        c: [center[0] + Math.cos(a) * radius[0] * rr, center[1] + radius[1] * (ring.y + (rnd() - 0.5) * 0.25), center[2] + Math.sin(a) * radius[2] * rr],
        r: clumpR[0] + rnd() * (clumpR[1] - clumpR[0]),
      });
    }
  }
  return { center, radius, clumps };
}

/** Fill a crown with leaf cards. `per` = cards per clump, `grow` = card size × clump radius. */
function leafCards(b: MeshBuilder2, crown: Crown, pal: Palette, per: number, grow: number, cell: AtlasCell, rnd: () => number, sway: number, accent?: { color: C3; share: number }) {
  const { center, radius } = crown;
  for (const cl of crown.clumps) {
    const tint = 0.9 + rnd() * 0.2;
    for (let i = 0; i < per; i++) {
      // biased toward the clump surface, so the cards build the silhouette
      const u = rnd() * 2 - 1;
      const th = rnd() * Math.PI * 2;
      const sq = Math.sqrt(1 - u * u);
      const d = (0.35 + 0.5 * Math.cbrt(rnd())) * cl.r;
      const p: C3 = [cl.c[0] + sq * Math.cos(th) * d, cl.c[1] + u * d * 0.85, cl.c[2] + sq * Math.sin(th) * d];
      // shading normal: mostly the whole crown, a little the clump
      const nc = [(p[0] - center[0]) / radius[0], (p[1] - center[1]) / radius[1], (p[2] - center[2]) / radius[2]];
      const nl = [(p[0] - cl.c[0]) / cl.r, (p[1] - cl.c[1]) / cl.r, (p[2] - cl.c[2]) / cl.r];
      const n = normalize([nc[0] * 0.62 + nl[0] * 0.38, nc[1] * 0.62 + nl[1] * 0.38 + 0.12, nc[2] * 0.62 + nl[2] * 0.38]);
      const h = Math.min(1, Math.max(0, (p[1] - (center[1] - radius[1])) / (radius[1] * 2)));
      let col = mix3(pal.low, pal.high, Math.pow(h, 0.85));
      // the outer shell catches more light than the inner leaves
      col = scale3(col, tint * (0.82 + 0.25 * (d / cl.r)));
      if (accent && rnd() < accent.share) col = scale3(accent.color, 0.9 + rnd() * 0.2);
      b.card(p, cl.r * grow * (0.8 + rnd() * 0.4), n, col, sway, cell, rnd() * Math.PI * 2);
    }
  }
  // a thin shell over the whole crown closes the gaps between clumps
  const shell = Math.round(per * crown.clumps.length * 0.3);
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

// ------------------------------------------------------------------ broadleaf

const OAK_PALETTES: Palette[] = [
  { low: hex('#1f5a3a'), high: hex('#9ad24e'), core: hex('#1c4a30') },
  { low: hex('#2a6234'), high: hex('#b4d84e'), core: hex('#22502c') },
  { low: hex('#1b5444'), high: hex('#7fcb5a'), core: hex('#18463a') },
];

export function broadleaf(lod: number, variant: number): Built {
  const b = new MeshBuilder2();
  const rnd = mulberry(variant * 977 + 13);
  const trunkH = 3.1 + rnd() * 1.2;
  const lean: C3 = [(rnd() - 0.5) * 0.22, 1, (rnd() - 0.5) * 0.22];
  const bark = hex('#7a573f');
  const pal = OAK_PALETTES[variant % OAK_PALETTES.length];
  const top: C3 = [lean[0] * trunkH, trunkH, lean[2] * trunkH];
  b.branch([0, -0.4, 0], lean, trunkH + 0.9, 0.46, 0.22, [9, 6, 5, 4][lod], [4, 2, 1, 1][lod], bark, 0, 0.05);
  if (lod === 0) {
    // root flare
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + rnd();
      b.branch([0, 0.5, 0], [Math.cos(a), -0.55, Math.sin(a)], 1.1, 0.2, 0.05, 5, 1, scale3(bark, 0.85), 0, 0);
    }
  }
  const center: C3 = [top[0], trunkH + 2.1, top[2]];
  const radius: C3 = [3.1 + rnd() * 0.5, 2.5 + rnd() * 0.3, 3.1 + rnd() * 0.5];
  const crown = makeCrown(center, radius, 7, rnd, [1.35, 1.85]);
  if (lod <= 1) {
    // limbs reaching into the lower clumps
    for (let i = 1; i < crown.clumps.length; i += 2) {
      const c = crown.clumps[i].c;
      const from: C3 = [top[0] * 0.75, trunkH * 0.78, top[2] * 0.75];
      const dir: C3 = [c[0] - from[0], c[1] - from[1], c[2] - from[2]];
      b.branch(from, dir, Math.hypot(...dir) * 0.85, 0.17, 0.06, lod ? 4 : 5, 1, bark, 0.05, 0.3);
    }
  }
  if (lod === 3) {
    b.blob(center, [radius[0] * 0.95, radius[1] * 0.9, radius[2] * 0.95], 1, noise, 0.2, pal.core, pal.core, center, 0.5);
    return done(b);
  }
  core(b, crown, pal, 0.62, 0.5);
  leafCards(b, crown, pal, [16, 7, 3][lod], [1.3, 1.7, 2.3][lod], 'broad', rnd, 0.75);
  return done(b);
}

// ------------------------------------------------------------------ blossom

const BLOSSOM: Palette = { low: hex('#ee8c9a'), high: hex('#ffe6ea'), core: hex('#c76a7a') };

/** A flowering tree: a wide, soft pink crown over a dark twisting trunk. */
export function blossom(lod: number, variant: number): Built {
  const b = new MeshBuilder2();
  const rnd = mulberry(variant * 3331 + 71);
  const trunkH = 2.6 + rnd() * 0.8;
  const lean: C3 = [(rnd() - 0.5) * 0.45, 1, (rnd() - 0.5) * 0.45];
  const bark = hex('#6a463c');
  b.branch([0, -0.4, 0], lean, trunkH + 0.6, 0.36, 0.18, [8, 6, 5, 4][lod], [4, 2, 1, 1][lod], bark, 0, 0.05);
  const top: C3 = [lean[0] * trunkH, trunkH, lean[2] * trunkH];
  const center: C3 = [top[0], trunkH + 1.6, top[2]];
  const radius: C3 = [3.4, 1.9, 3.4];
  const crown = makeCrown(center, radius, 7, rnd, [1.2, 1.6]);
  if (lod <= 1) {
    for (let i = 1; i < crown.clumps.length; i++) {
      const c = crown.clumps[i].c;
      const from: C3 = [top[0] * 0.9, trunkH * 0.85, top[2] * 0.9];
      const dir: C3 = [c[0] - from[0], c[1] - from[1] - 0.4, c[2] - from[2]];
      b.branch(from, dir, Math.hypot(...dir) * 0.8, 0.13, 0.04, lod ? 4 : 5, lod ? 1 : 2, bark, 0.05, 0.3);
    }
  }
  if (lod === 3) {
    b.blob(center, [radius[0] * 0.9, radius[1] * 0.9, radius[2] * 0.9], 1, noise, 0.2, BLOSSOM.core, BLOSSOM.core, center, 0.5);
    return done(b);
  }
  core(b, crown, BLOSSOM, 0.6, 0.5);
  leafCards(b, crown, BLOSSOM, [16, 7, 3][lod], [1.25, 1.7, 2.3][lod], 'round', rnd, 0.8, { color: hex('#fff4f8'), share: 0.14 });
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
  const h = 5.2 + rnd() * 1.6;
  const lean: C3 = [(rnd() - 0.5) * 0.15, 1, (rnd() - 0.5) * 0.15];
  // white bark with dark bands: alternate short rings
  const bands = lod === 0 ? 7 : 3;
  for (let i = 0; i < bands; i++) {
    const t0 = i / bands;
    const len = h / bands;
    const r0 = 0.21 - 0.1 * t0;
    const col = i % 2 === 1 && lod === 0 ? hex('#cfc8bb') : hex('#f4f0e6');
    b.branch([lean[0] * h * t0, -0.3 + h * t0, lean[2] * h * t0], lean, len + 0.02, r0, r0 - 0.1 / bands, [7, 5, 4, 4][lod], 1, col, t0 * 0.1, (t0 + 1 / bands) * 0.1);
  }
  const center: C3 = [lean[0] * h, h + 0.5, lean[2] * h];
  const radius: C3 = [1.9, 2.6, 1.9];
  const crown = makeCrown(center, radius, 5, rnd, [1.0, 1.35]);
  if (lod === 3) {
    b.blob(center, radius, 1, noise, 0.3, BIRCH.core, BIRCH.core, center, 0.7);
    return done(b);
  }
  core(b, crown, BIRCH, 0.6, 0.7);
  leafCards(b, crown, BIRCH, [14, 6, 3][lod], [1.25, 1.65, 2.2][lod], 'round', rnd, 0.9);
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
