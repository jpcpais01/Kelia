// Outfits for the anime hero: how each one dresses the body (bands of colour
// on the body itself) and the garments layered on top (breastplates, vests,
// tunic skirts, belts, pauldrons, mantles, scarves, capes) plus headgear
// (helmet, hood, wizard hat, bear cap). Everything is code-built from the
// mesh kit and coloured from the outfit's own swatches.
import { Vector3 } from '@babylonjs/core';
import { along, bustBulge, torsoRing, torsoWeights, type Build, type Dress } from './body';
import { blend, clamp01, Geo, lerp, one, smooth, type Ring, type Weights } from './geo';
import { scalp, type LockRegion } from './hair';
import { SHEETS, sheetWeights, type ChainJoints } from './chains';
import type { HeroRest } from './rig';
import { SW, uvAlong, uvOf, type Swatch } from './palette';
import type { Headgear } from '@kelia/shared';

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);

export interface OutfitCtx {
  /** Main body (skinned, plum ink). */
  g: Geo;
  /** The cape (skinned to its own chains, which it lays out in `chains`). */
  cape: Geo;
  chains: ChainJoints;
  rest: HeroRest;
  build: Build;
  dress: Dress;
  /** Headgear is on (hoods come down when it is off). */
  hat: boolean;
}

export interface OutfitDef {
  colors: [Swatch, string][];
  dress: Omit<Dress, 'neck'> & { neck?: number };
  garments: (c: OutfitCtx) => void;
  /** Hair regions the headgear covers, and the headgear builder. */
  headgear?: { kind: Headgear; covers: LockRegion[]; build: (c: OutfitCtx, g: Geo) => void };
}

// ------------------------------------------------------------------ garments

/** A band hugging the torso: belts, sashes, plates' trims. */
function torsoBand(c: OutfitCtx, y0: number, y1: number, add: number, sw: Swatch, o: { n?: number; segs?: number } = {}) {
  const rings: Ring[] = [];
  const steps = 3;
  for (let i = 0; i <= steps; i++) {
    const y = lerp(y0, y1, i / steps);
    const t = torsoRing(y, c.build);
    const bulge = Math.sin((i / steps) * Math.PI) * 0.15 + 0.85;
    rings.push({
      c: new Vector3(0, y, 0),
      x: X,
      z: Z,
      a: t.a + add * bulge,
      f: t.f + add * bulge,
      b: t.b + add * bulge,
      n: o.n ?? t.n,
      r: bustBulge(t.bust),
      w: torsoWeights,
      uv: uvOf(sw),
    });
  }
  c.g.loft(rings, { segs: o.segs ?? 36, capStart: 0.001, capEnd: 0.001, t0: -Math.PI / 2 });
}

/** A layer over the torso from y0 to y1 (breastplate, vest), optionally open at the front. */
function torsoLayer(c: OutfitCtx, y0: number, y1: number, add: number, sw: Swatch, o: { open?: number; trim?: Swatch; inner?: Swatch; rows?: number } = {}) {
  const rows = o.rows ?? 10;
  const open = o.open ?? 0;
  if (!open) {
    const rings: Ring[] = [];
    for (let i = 0; i <= rows; i++) {
      const y = lerp(y0, y1, i / rows);
      const t = torsoRing(y, c.build);
      const k = add * (1 - 0.35 * smooth(1.43, 1.5, y));
      rings.push({ c: new Vector3(0, y, 0), x: X, z: Z, a: t.a + k, f: t.f + k, b: t.b + k, n: t.n, r: bustBulge(t.bust), w: torsoWeights, uv: uvAlong(sw, lerp(0.3, 0.78, i / rows)) });
    }
    c.g.loft(rings, { segs: 36, capStart: 0.001, capEnd: 0.001, t0: -Math.PI / 2 });
  } else {
    // a sheet round the body leaving a gap at the front (angle ±open)
    const cols = 30;
    const mid: Vector3[][] = [];
    for (let i = 0; i <= rows; i++) {
      const y = lerp(y0, y1, i / rows);
      const t = torsoRing(y, c.build);
      const row: Vector3[] = [];
      for (let j = 0; j <= cols; j++) {
        const ang = Math.PI / 2 + open + (j / cols) * (Math.PI * 2 - 2 * open);
        const cs = Math.cos(ang);
        const sn = Math.sin(ang);
        const e = 2 / t.n;
        const k = add * (1 - 0.35 * smooth(1.43, 1.5, y));
        const bu = bustBulge(t.bust);
        const m = bu ? bu(ang) : 1;
        row.push(new Vector3(Math.sign(cs) * Math.pow(Math.abs(cs), e) * (t.a + k) * m, y, Math.sign(sn) * Math.pow(Math.abs(sn), e) * ((sn > 0 ? t.f : t.b) + k) * m));
      }
      mid.push(row);
    }
    c.g.sheet(mid, 0.008, {
      uv: (i, j, outside) => uvOf(!outside && o.inner ? o.inner : o.trim && (j <= 1 || j >= cols - 1 || i === rows) ? o.trim : sw),
      w: torsoWeights,
      out: (p) => new Vector3(p.x, 0, p.z),
    });
  }
  if (o.trim && !open) {
    torsoBand(c, y0 - 0.004, y0 + 0.016, add + 0.006, o.trim);
  }
}

/**
 * A skirt hanging from the waist (tunic, robe, tassets): panels round the
 * body from `top` to `bottom`, flaring out; legs push the lower edge.
 */
function skirt(
  c: OutfitCtx,
  top: number,
  bottom: number,
  flare: number,
  sw: Swatch,
  o: { panels?: [number, number][]; trim?: Swatch; inner?: Swatch; thick?: number; rows?: number; frontCut?: number } = {},
) {
  const rows = o.rows ?? 10;
  const panels = o.panels ?? [[0, 360]];
  // the skirt hangs on a ring of chains from the hips (left, front, right, back) and swings on them
  const ring = SHEETS[1].chains;
  const at = (s: number, angDeg: number) => {
    const y = lerp(top, bottom, s);
    const t = torsoRing(Math.max(0.86, y), c.build);
    const ang = (angDeg * Math.PI) / 180;
    const cs = Math.cos(ang);
    const sn = Math.sin(ang);
    const out = 0.014 + flare * s * s * 0.6 + flare * s * 0.4;
    const ax = t.a + out + smooth(0.9, 0.6, y) * 0.03 * Math.abs(cs);
    const az = (sn > 0 ? t.f : t.b) + out;
    return new Vector3(Math.sign(cs) * Math.pow(Math.abs(cs), 0.9) * ax, y, Math.sign(sn) * Math.pow(Math.abs(sn), 0.9) * az);
  };
  if (!c.chains[ring[0]]) ring.forEach((name, k) => (c.chains[name] = [0, 1, 2, 3].map((r) => at(r / 3, k * 90))));
  const ringW = (p: Vector3): Weights => {
    const s = clamp01((top - p.y) / Math.max(0.05, top - bottom));
    const col = (Math.atan2(p.z, p.x) * 180) / Math.PI / 90;
    const hang = sheetWeights(ring, col, s * 3, torsoWeights(new Vector3(p.x, Math.max(p.y, 0.95), p.z)), 0.35, true);
    // the hem still follows the legs a little, so a striding leg never pokes out of a long robe
    const side = smooth(-0.07, 0.07, p.x);
    const legs: Weights = [
      ['upperleg.l', side],
      ['upperleg.r', 1 - side],
    ];
    return blend(hang, legs, 0.4 * smooth(top - 0.02, bottom, p.y));
  };
  for (const [a0, a1] of panels) {
    const wrap = a1 - a0 >= 360;
    const cols = Math.max(4, Math.round(((a1 - a0) / 360) * 40));
    const mid: Vector3[][] = [];
    for (let i = 0; i <= rows; i++) {
      const s = i / rows;
      const y = lerp(top, bottom, s);
      const t = torsoRing(Math.max(0.86, y), c.build);
      const legSpread = smooth(0.9, 0.6, y) * 0.03;
      const row: Vector3[] = [];
      const n = wrap ? cols : cols + 1;
      for (let j = 0; j < n; j++) {
        const ang = ((a0 + (j / cols) * (a1 - a0) + 90) * Math.PI) / 180;
        const cs = Math.cos(ang);
        const sn = Math.sin(ang);
        const out = 0.014 + flare * s * s * 0.6 + flare * s * 0.4;
        const ax = t.a + out + legSpread * Math.abs(cs);
        let az = (sn > 0 ? t.f : t.b) + out;
        // a robe's front edge dips toward the middle
        if (o.frontCut && sn > 0) az += 0;
        const drop = o.frontCut ? o.frontCut * Math.max(0, sn) * s : 0;
        row.push(new Vector3(Math.sign(cs) * Math.pow(Math.abs(cs), 0.9) * ax, y - drop, Math.sign(sn) * Math.pow(Math.abs(sn), 0.9) * az));
      }
      mid.push(row);
    }
    // folds: a gentle wave round the hem
    for (let i = 0; i <= rows; i++) {
      const s = i / rows;
      for (let j = 0; j < mid[i].length; j++) {
        const p = mid[i][j];
        const ang = Math.atan2(p.z, p.x);
        const k = 1 + 0.085 * s * Math.sin(ang * 9);
        p.x *= k;
        p.z *= k;
      }
    }
    c.g.sheet(mid, o.thick ?? 0.009, {
      wrap,
      // folds: the ridges catch the light, the hollows between them and the waist under the belt fall dark
      uv: (i, _j, outside, p) => {
        const s = i / rows;
        const t = 0.5 + 0.45 * Math.sin(Math.atan2(p.z, p.x) * 9) * smooth(0, 0.5, s) - 0.16 * (1 - smooth(0, 0.3, s));
        return uvAlong(o.trim && i >= rows - 1 ? o.trim : !outside && o.inner ? o.inner : sw, outside ? t : t - 0.2);
      },
      w: ringW,
      out: (p) => new Vector3(p.x, 0, p.z),
    });
  }
}

/** A band round a limb between two distances along its chain (cuffs, bracers, knee guards). */
function limbBand(c: OutfitCtx, names: string[], d0: number, d1: number, r0: number, r1: number, sw: Swatch, w: (d: number) => Weights, o: { n?: number; front?: number } = {}) {
  const pts = names.map((n) => c.rest.pos(n));
  const rings: Ring[] = [];
  for (let i = 0; i <= 4; i++) {
    const d = lerp(d0, d1, i / 4);
    const { p, t } = along(pts, d);
    const z = Z.subtract(t.scale(Vector3.Dot(Z, t))).normalize();
    const x = Vector3.Cross(t, z).normalize();
    const r = lerp(r0, r1, i / 4);
    rings.push({ c: p, x, z, a: r, f: r * (o.front ?? 1), b: r, n: o.n ?? 2.2, w: w(d), uv: uvOf(sw) });
  }
  c.g.loft(rings, { segs: 18, capStart: 0.002, capEnd: 0.002 });
}

const armNames = (s: string) => [`upperarm.${s}`, `lowerarm.${s}`, `wrist.${s}`];
const legNames = (s: string) => [`upperleg.${s}`, `lowerleg.${s}`, `foot.${s}`];

/** Shoulder plates: layered domes over the deltoid. */
function pauldron(c: OutfitCtx, sw: Swatch, trim: Swatch | null, layers = 2, size = 1) {
  for (const side of [-1, 1]) {
    const s = side > 0 ? 'l' : 'r';
    const j = c.rest.pos(`upperarm.${s}`);
    const k = size * lerp(1, c.build.shoulder, 0.6);
    for (let l = 0; l < layers; l++) {
      const cen = j.add(new Vector3(side * (0.02 + l * 0.035), 0.03 - l * 0.035, -0.004));
      const rows = 7;
      const cols = 16;
      const mid: Vector3[][] = [];
      const R = (0.088 - l * 0.012) * k;
      for (let i = 0; i <= rows; i++) {
        // from the top of the dome down to its rim
        const th = lerp(0.05, 1.25, i / rows);
        const row: Vector3[] = [];
        for (let jj = 0; jj <= cols; jj++) {
          const ph = lerp(-1.35, 1.35, jj / cols);
          // dome axis points up and out
          const ax = new Vector3(side * 0.55, 0.83, 0).normalize();
          const t1 = Z;
          const t2 = Vector3.Cross(ax, t1).normalize();
          const dir = ax.scale(Math.cos(th)).add(t1.scale(Math.sin(th) * Math.sin(ph))).add(t2.scale(Math.sin(th) * Math.cos(ph)));
          row.push(cen.add(dir.multiplyByFloats(R * 1.05, R * 0.75, R * 0.95)));
        }
        mid.push(row);
      }
      c.g.sheet(mid, 0.01, {
        uv: (i) => uvAlong(trim && i >= rows - 1 ? trim : sw, 0.85 - 0.6 * (i / rows)),
        w: (p) => blend(one('chest'), one(`upperarm.${s}`), clampW(0.55 + 0.6 * (side * p.x - j.x * side) / 0.08)),
        out: (p) => p.subtract(cen),
      });
    }
  }
}

const clampW = (x: number) => Math.max(0, Math.min(1, x));

/** A ring of fur (or a collar) round the shoulders and neck. */
function mantle(c: OutfitCtx, sw: Swatch, o: { tufts?: number; size?: number; drop?: number; height?: number; dark?: Swatch } = {}) {
  const size = o.size ?? 1;
  const rings: Ring[] = [];
  const tufts = o.tufts ?? 0;
  const ys = [1.36 - (o.drop ?? 0), 1.42, 1.48, 1.52 + (o.height ?? 0)];
  ys.forEach((y, i) => {
    const t = torsoRing(Math.min(y, 1.44), c.build);
    const k = [1.1, 1.07, 0.86, 0.62][i] * size;
    rings.push({
      c: new Vector3(0, y, -0.005),
      x: X,
      z: Z,
      a: Math.max(t.a, 0.16) * k + 0.018,
      f: Math.max(t.f, 0.09) * k + 0.018,
      b: Math.max(t.b, 0.09) * k + 0.022,
      n: 2,
      r: tufts ? (a) => 1 + (i === 0 ? 0.05 : 0.02) * Math.pow(Math.abs(Math.sin(a * tufts * 0.5)), 0.5) : undefined,
      w: (p) => blend(one('chest'), one(p.x > 0 ? 'upperarm.l' : 'upperarm.r'), 0.25 * smooth(0.12, 0.2, Math.abs(p.x))),
      uv: uvOf(i === 0 && o.dark ? o.dark : sw),
    });
  });
  c.g.loft(rings, { segs: 40, capStart: 0.004, capEnd: 0.002, t0: -Math.PI / 2 });
  if (tufts) {
    // fur: rows of tufts spilling over the edge and lying on top
    const ring = (y: number, k: number, lift: number) => (a: number) => {
      const t = torsoRing(Math.min(y, 1.44), c.build);
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      const ax = Math.max(t.a, 0.16) * k * size + 0.018;
      const az = (sn > 0 ? Math.max(t.f, 0.09) : Math.max(t.b, 0.09)) * k * size + 0.02;
      const p = new Vector3(cs * ax, y, sn * az - 0.005);
      const out = new Vector3(cs / ax, lift, sn / az).normalize();
      return { p, out, w: blend(one('chest'), one(p.x > 0 ? 'upperarm.l' : 'upperarm.r'), 0.25 * smooth(0.12, 0.2, Math.abs(p.x))) };
    };
    const y0 = 1.375 - (o.drop ?? 0);
    // a dark under-layer, then light fur spilling over the edge, then the shoulders and the collar
    if (o.dark) furTufts(c.g, tufts + 10, ring(y0 - 0.005, 1.05, -0.1), { len: 0.085, wid: 0.036, droop: 0.9, light: o.dark, seed: 4 });
    furTufts(c.g, tufts + 14, ring(y0 + 0.01, 1.1, 0), { len: 0.07, wid: 0.034, droop: 0.82, seed: 1 });
    furTufts(c.g, tufts + 8, ring(1.43, 1.07, 0.6), { len: 0.065, wid: 0.034, droop: 0.58, seed: 2 });
    furTufts(c.g, tufts, ring(1.49, 0.86, 1.6), { len: 0.05, wid: 0.03, droop: 0.3, seed: 3 });
  }
}

/** A repeatable 0..1 hash. */
const hash = (i: number) => {
  const j = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return j - Math.floor(j);
};

/**
 * Fur: a ring of short pointed tufts round `at(a)` (a point, its outward
 * direction and weights at angle a), each leaning out and down, shaded
 * from dark roots to light tips.
 */
function furTufts(
  g: Geo,
  n: number,
  at: (a: number) => { p: Vector3; out: Vector3; w: Weights },
  o: { len: number; wid: number; droop?: number; light?: Swatch; dark?: Swatch; seed?: number; arc?: [number, number] },
) {
  const droop = o.droop ?? 0.6;
  const [a0, a1] = o.arc ?? [0, Math.PI * 2];
  const full = a1 - a0 >= Math.PI * 2 - 1e-6;
  for (let i = 0; i < n; i++) {
    const r = hash(i + (o.seed ?? 0) * 31);
    const a = a0 + ((i + (full ? 0.35 * (r - 0.5) : 0.5)) / n) * (a1 - a0);
    const { p, out, w } = at(a);
    const len = o.len * (0.75 + 0.5 * r);
    const down = new Vector3(0, -1, 0);
    const dir = out.scale(1 - droop).add(down.scale(droop)).normalize();
    const side = Vector3.Cross(out, down).normalize().scale((hash(i * 7 + 3) - 0.5) * 0.8 * len);
    const pts = [p.subtract(dir.scale(0.006)), p.add(dir.scale(len * 0.45)).add(out.scale(len * 0.12)), p.add(dir.scale(len)).add(down.scale(len * 0.2 * droop)).add(side)];
    const col = o.dark && i % 3 === 1 ? o.dark : (o.light ?? SW.fur);
    g.ribbon(pts, {
      samples: 4,
      segs: 6,
      width: (s) => o.wid * (0.8 + 0.4 * r) * Math.pow(1 - s, 1.1) * lerp(0.75, 1, Math.min(1, s * 5)),
      thick: (s) => o.wid * 0.35 * (1 - 0.7 * s),
      normal: () => out,
      w: () => w,
      uv: (s) => uvAlong(col, 0.15 + 0.85 * s),
      cup: () => -o.wid * 0.12,
    });
  }
}

/** A cuff of fur round a limb at distance `d` along its chain (boot tops). */
function furCuff(c: OutfitCtx, names: string[], d: number, r: number, w: Weights, o: { light?: Swatch; dark?: Swatch; seed?: number } = {}) {
  const pts = names.map((n) => c.rest.pos(n));
  const { p, t } = along(pts, d);
  const z = Z.subtract(t.scale(Vector3.Dot(Z, t))).normalize();
  const x = Vector3.Cross(t, z).normalize();
  // a soft roll of fur under the tufts
  c.g.loft(
    [0, 0.5, 1].map((k) => ({ c: p.add(t.scale((k - 0.5) * 0.04)), x, z, a: r * (1 + 0.12 * Math.sin(k * Math.PI)), f: r * (1 + 0.12 * Math.sin(k * Math.PI)), b: r * (1 + 0.12 * Math.sin(k * Math.PI)), n: 2, w, uv: uvAlong(o.light ?? SW.fur, 0.5) })),
    { segs: 18, capStart: 0.003, capEnd: 0.003 },
  );
  furTufts(c.g, 14, (a) => {
    const out = x.scale(Math.cos(a)).add(z.scale(Math.sin(a)));
    return { p: p.add(out.scale(r * 1.05)).add(t.scale(-0.012)), out, w };
  }, { len: 0.045, wid: 0.03, droop: 0.75, light: o.light, dark: o.dark, seed: o.seed });
}

/** A belt buckle on the front of the waist at `y` (over a band `add` thick): a metal frame and its pin. */
function buckle(c: OutfitCtx, y: number, add: number, sw: Swatch, strap: Swatch, size = 1) {
  const z = torsoRing(y, c.build).f + add + 0.008;
  const w = 0.022 * size;
  const h = 0.019 * size;
  const t = 0.0045 * size;
  const at = (x: number, yy: number) => new Vector3(x, y + yy, z);
  const bar = (p: Vector3, r: [number, number, number], col: Swatch) => c.g.blob(p, [X, Y, Z], r, one('hips'), uvOf(col), { lat: 4, lon: 8, n: 5 });
  bar(at(0, h), [w + t, t, t], sw);
  bar(at(0, -h), [w + t, t, t], sw);
  bar(at(-w, 0), [t, h, t], sw);
  bar(at(w, 0), [t, h, t], sw);
  // the strap shows through the frame, the pin across it
  bar(at(0, 0).add(new Vector3(0, 0, -t * 0.6)), [w - t, h - t, t * 0.5], strap);
  bar(at(-w * 0.15, 0).add(new Vector3(0, 0, t * 0.4)), [w * 0.62, t * 0.55, t * 0.55], sw);
}

/** A leather pouch on the belt at `y`, `angDeg` round the waist (0 = left side, 90 = front). */
function pouch(c: OutfitCtx, y: number, angDeg: number, body: Swatch, flap: Swatch, size = 1) {
  const a = (angDeg * Math.PI) / 180;
  const t = torsoRing(y, c.build);
  const out = new Vector3(Math.cos(a) / t.a, 0, Math.sin(a) / t.f).normalize();
  const along = Vector3.Cross(Y, out).normalize();
  const k = size;
  const base = new Vector3(Math.cos(a) * t.a, y, Math.sin(a) * t.f).add(out.scale(0.028 * k));
  const w = one('hips');
  c.g.blob(base.add(new Vector3(0, -0.03 * k, 0)), [along, Y, out], [0.032 * k, 0.036 * k, 0.019 * k], w, uvAlong(body, 0.45), { lat: 6, lon: 10, n: 4 });
  // the flap over the top, a little proud of the body, with a stud
  c.g.blob(base.add(new Vector3(0, -0.006 * k, 0.0)).add(out.scale(0.006 * k)), [along, Y, out], [0.035 * k, 0.017 * k, 0.017 * k], w, uvAlong(flap, 0.6), { lat: 6, lon: 10, n: 4 });
  c.g.blob(base.add(new Vector3(0, -0.018 * k, 0)).add(out.scale(0.022 * k)), [along, Y, out], [0.005, 0.005, 0.003], w, uvOf(SW.gold(0)), { lat: 4, lon: 8 });
}

/** Where the front of the torso is at height y (over the bust), plus `add`. */
function frontZ(c: OutfitCtx, y: number, add = 0) {
  const t = torsoRing(y, c.build);
  const bu = bustBulge(t.bust);
  return (t.f + add) * (bu ? bu(Math.PI / 2) : 1);
}

/** A placket down the front of a tunic from y0 to y1 with buttons. */
function placket(c: OutfitCtx, y0: number, y1: number, sw: Swatch, button: Swatch, buttons = 3) {
  const pts = [0, 0.25, 0.5, 0.75, 1].map((k) => {
    const y = lerp(y0, y1, k);
    return new Vector3(0, y, frontZ(c, y, 0.003));
  });
  c.g.ribbon(pts, { samples: 4, segs: 8, width: () => 0.014, thick: () => 0.004, normal: () => Z, w: (_s, p) => torsoWeights(p), uv: () => uvAlong(sw, 0.4), tipPoint: false, n: 4 });
  for (let i = 0; i < buttons; i++) {
    const y = lerp(y0, y1, (i + 0.5) / buttons);
    c.g.blob(new Vector3(0, y, frontZ(c, y, 0.008)), [X, Y, Z], [0.007, 0.007, 0.0035], torsoWeights(new Vector3(0, y, 0)), uvOf(button), { lat: 4, lon: 8 });
  }
}

/** Fur cuffs over the tops of fur boots. */
function bootCuffs(c: OutfitCtx) {
  for (const side of [-1, 1] as const) {
    const s = side > 0 ? 'l' : 'r';
    const names = legNames(s);
    const pts = names.map((n) => c.rest.pos(n));
    const total = Vector3.Distance(pts[0], pts[1]) + Vector3.Distance(pts[1], pts[2]);
    furCuff(c, names, total - c.dress.boot + 0.008, 0.05 * lerp(1, c.build.limb, 0.7), one(`lowerleg.${s}`), { dark: SW.furDark, seed: side > 0 ? 5 : 6 });
  }
}

/** The cape: hangs from the shoulders behind the body, flaring to the calves. */
function cape(c: OutfitCtx, sw: Swatch, lining: Swatch, o: { bottom?: number; flare?: number; trim?: Swatch; width?: number } = {}) {
  const bottom = o.bottom ?? 0.42;
  const flare = o.flare ?? 0.14;
  const rows = 12;
  const cols = 16;
  const top = 1.47;
  /** Half the angle the cape wraps round the body at `s` (0 top .. 1 hem), and its radii there. */
  const span = (s: number) => lerp(1.62, 1.18, smooth(0, 0.4, s)) * (o.width ?? 1);
  const at = (s: number, a: number, fold = 1) => {
    const y = lerp(top, bottom, s);
    const t = torsoRing(Math.max(0.9, Math.min(1.42, y)), c.build);
    const rx = lerp(Math.max(t.a, 0.165) + 0.02, 0.2 + flare * 0.8, smooth(0.05, 1, s));
    const rz = lerp(Math.max(t.b, 0.08) + 0.03, 0.16 + flare, smooth(0.0, 1, s));
    return new Vector3(Math.sin(a) * rx * fold, y, -Math.cos(a) * rz * fold + 0.012);
  };
  const mid: Vector3[][] = [];
  for (let i = 0; i <= rows; i++) {
    const s = i / rows;
    const A = span(s);
    const row: Vector3[] = [];
    for (let j = 0; j <= cols; j++) {
      const a = lerp(-A, A, j / cols);
      row.push(at(s, a, 1 + 0.085 * s * Math.sin(a * 7)));
    }
    mid.push(row);
  }
  // three chains down the back (the cape swings, trails and folds on them)
  const sheet = SHEETS[0].chains;
  const reach = 0.62;
  sheet.forEach((name, k) => {
    c.chains[name] = [0, 1, 2, 3, 4].map((r) => at(r / 4, (k - 1) * span(r / 4) * reach));
  });
  c.cape.sheet(mid, 0.011, {
    uv: (i, j, outside) => {
      const s = i / rows;
      const a = lerp(-span(s), span(s), j / cols);
      const t = 0.5 + 0.42 * Math.sin(a * 7) * smooth(0, 0.5, s) - 0.12 * (1 - smooth(0, 0.25, s));
      return uvAlong(o.trim && i === rows ? o.trim : outside ? sw : lining, outside ? t : t - 0.18);
    },
    w: (p) => {
      const s = Math.max(0, Math.min(1, (top - p.y) / (top - bottom)));
      const a = Math.atan2(p.x, -(p.z - 0.012));
      return sheetWeights(sheet, a / (span(s) * reach) + 1, s * 4, one('chest'));
    },
    out: (p) => new Vector3(p.x, 0, p.z - 0.02),
  });
  // clasps at the collarbones
  for (const side of [-1, 1]) {
    c.g.blob(new Vector3(side * 0.12, 1.455, 0.06), [X, Y, Z], [0.016, 0.016, 0.008], one('chest'), uvOf(SW.gold(0)), { lat: 6, lon: 10 });
  }
}

/** A scarf wrapped twice round the neck, knotted at the front, its ends hanging over the chest and down the back. */
function scarf(c: OutfitCtx, sw: Swatch) {
  const rings: Ring[] = [];
  const keys = [[1.43, 0.09], [1.455, 0.1], [1.49, 0.094], [1.52, 0.082], [1.548, 0.07]] as const;
  keys.forEach(([y, r], i) => {
    rings.push({
      c: new Vector3(0, y, -0.004),
      x: X,
      z: Z,
      a: r,
      f: r * 1.04,
      b: r,
      n: 2.2,
      // two wraps: a soft crease between them, wavy folds round the neck
      r: (t) => 1 + 0.05 * Math.sin(t * 6 + i) - (i === 2 ? 0.035 : 0),
      w: blend(one('chest'), one('head'), smooth(1.5, 1.6, y) * 0.5),
      uv: uvAlong(sw, i === 2 ? 0.25 : 0.6 - 0.1 * (i % 2)),
    });
  });
  c.g.loft(rings, { segs: 32, capStart: 0.003, capEnd: 0.003 });
  // the knot, left of the throat
  const knot = new Vector3(0.035, 1.455, 0.088);
  c.g.blob(knot, [X, Y, Z], [0.03, 0.026, 0.022], one('chest'), uvAlong(sw, 0.55), { lat: 7, lon: 12 });
  // two ends over the chest, one longer, and the long tail down the back
  const end = (pts: Vector3[], wid: number, out: Vector3) =>
    c.g.ribbon(pts, {
      samples: 6,
      segs: 8,
      width: (s) => lerp(wid * 0.7, wid, Math.min(1, s * 3)) * (1 + 0.12 * Math.sin(s * 9)),
      thick: () => 0.009,
      normal: (s) => out.add(new Vector3(0.25 * Math.sin(s * 4), 0, 0)),
      w: () => one('chest'),
      uv: (s) => uvAlong(sw, 0.65 - 0.35 * s),
      cup: (s) => 0.012 * Math.min(1, s * 2),
      n: 2.6,
      tipPoint: false,
    });
  end([knot.add(new Vector3(0.0, -0.01, 0.01)), new Vector3(0.05, 1.38, 0.115), new Vector3(0.06, 1.3, 0.13), new Vector3(0.065, 1.2, 0.13)], 0.04, Z);
  end([knot.add(new Vector3(0.012, -0.012, 0.014)), new Vector3(0.09, 1.39, 0.11), new Vector3(0.105, 1.33, 0.125), new Vector3(0.112, 1.27, 0.125)], 0.036, Z);
  end([new Vector3(0.05, 1.5, -0.08), new Vector3(0.08, 1.42, -0.12), new Vector3(0.1, 1.3, -0.13), new Vector3(0.11, 1.12, -0.12)], 0.045, Z.scale(-1));
}

// ------------------------------------------------------------------ headgear

/** Helmet: a steel cap over the crown with a brow ridge, cheek guards and a crest. */
function helmet(c: OutfitCtx, g: Geo, sw: Swatch, trim: Swatch) {
  const rows = 10;
  const cols = 40;
  const edge = (phi: number) => {
    const a = Math.abs(phi);
    return a < 50 ? 33 : a < 100 ? lerp(33, 2, smooth(50, 100, a)) : lerp(2, -25, smooth(100, 180, a));
  };
  const outer: Vector3[][] = [];
  const inner: Vector3[][] = [];
  for (let i = 0; i <= rows; i++) {
    const ro: Vector3[] = [];
    const ri: Vector3[] = [];
    for (let j = 0; j < cols; j++) {
      const phi = -180 + (j / cols) * 360;
      const th = lerp(89.5, edge(phi), i / rows);
      ro.push(scalp(phi, th, 0.2));
      ri.push(scalp(phi, th, 0.1));
    }
    outer.push(ro);
    inner.push(ri);
  }
  g.shell(outer, inner, { wrap: true, uv: (i) => uvOf(i >= rows - 1 ? trim : sw), w: () => one('head') });
  // crest: a ridge from the brow over the crown
  const ridge = [scalp(0, 40, 0.24), scalp(0, 70, 0.27), scalp(180, 80, 0.27), scalp(180, 45, 0.25), scalp(180, 15, 0.23)];
  g.ribbon(ridge, { samples: 6, segs: 8, width: (s) => lerp(0.012, 0.008, s), thick: () => 0.016, normal: (_s, p) => new Vector3(p.x > 0 ? 1 : -1, 0, 0), w: () => one('head'), uv: () => uvOf(trim), tipPoint: false });
  // cheek guards
  for (const side of [-1, 1]) {
    const mid: Vector3[][] = [];
    for (let i = 0; i <= 4; i++) {
      const th = lerp(6, -38, i / 4);
      const row: Vector3[] = [];
      for (let j = 0; j <= 4; j++) row.push(scalp(side * lerp(58, 100, j / 4), th, 0.19 - i * 0.012));
      mid.push(row);
    }
    g.sheet(mid, 0.01, { uv: (i) => uvOf(i === 4 ? trim : sw), w: () => one('head'), out: (p) => new Vector3(p.x, 0, p.z * 0.3) });
  }
}

/** A hood up over the head, open at the face, draping onto the shoulders. */
function hood(c: OutfitCtx, g: Geo, sw: Swatch, lining: Swatch) {
  const rows = 14;
  const cols = 26;
  const mid: Vector3[][] = [];
  const opening = (th: number) => (th > 45 ? 18 : th > 10 ? lerp(18, 58, smooth(45, 10, th)) : lerp(58, 40, smooth(10, -60, th)));
  for (let i = 0; i <= rows; i++) {
    const th = lerp(86, -72, i / rows);
    const o = opening(th);
    const row: Vector3[] = [];
    for (let j = 0; j <= cols; j++) {
      const phi = lerp(o, 360 - o, j / cols);
      const pp = phi > 180 ? phi - 360 : phi;
      // roomier at the back, a point behind the crown, flowing onto the shoulders low down
      const back = Math.max(0, -Math.cos((pp * Math.PI) / 180));
      const off = 0.2 + back * 0.08 + smooth(-20, -72, th) * 0.5;
      const p = scalp(pp, th, off);
      if (th > 30) p.addInPlace(new Vector3(0, 0, -back * 0.05 * smooth(30, 70, th)));
      if (th < -30) p.y = lerp(p.y, Math.max(p.y, 1.46 - 0.02 * back), 0.6);
      row.push(p);
    }
    mid.push(row);
  }
  g.sheet(mid, 0.012, {
    uv: (_i, _j, outside) => uvOf(outside ? sw : lining),
    w: (p) => blend(one('head'), one('chest'), smooth(1.62, 1.5, p.y)),
    out: (p) => p.subtract(new Vector3(0, 1.69, -0.01)),
  });
}

/** The hood lying down round the neck when not worn. */
function hoodDown(c: OutfitCtx, sw: Swatch) {
  const rings: Ring[] = [];
  for (const [y, k, z] of [[1.43, 1.0, -0.02], [1.47, 1.08, -0.035], [1.51, 0.92, -0.05], [1.53, 0.66, -0.06]] as const) {
    rings.push({ c: new Vector3(0, y, z), x: X, z: Z, a: 0.1 * k, f: 0.085 * k, b: 0.12 * k, n: 2, w: one('chest'), uv: uvOf(sw) });
  }
  c.g.loft(rings, { segs: 30, capStart: 0.003, capEnd: 0.003 });
}

/** A wide-brimmed, tall, bent wizard's hat. */
function wizardHat(c: OutfitCtx, g: Geo, sw: Swatch, band: Swatch) {
  const base = new Vector3(0, 1.755, -0.012);
  const tilt = new Vector3(0, 0.97, -0.24).normalize();
  const side = X;
  const fwd = Vector3.Cross(side, tilt).normalize();
  // brim: a flat ring with a thick rolled edge
  const brim: Ring[] = [];
  for (const [h, r, th] of [[-0.008, 0.1, 0.012], [-0.006, 0.17, 0.008], [0.0, 0.215, 0.006]] as const) {
    void th;
    brim.push({ c: base.add(tilt.scale(h)), x: side, z: fwd, a: r, f: r, b: r * 1.04, n: 2, w: one('head'), uv: uvOf(sw) });
  }
  const brimTop: Ring[] = brim.map((r) => ({ ...r, c: r.c.add(tilt.scale(0.012)) })).reverse();
  g.loft([...brim, ...brimTop], { segs: 40, capStart: 0.001, capEnd: 0.001 });
  // cone: up, then bent back and drooping
  const pts = [base, base.add(tilt.scale(0.12)), base.add(tilt.scale(0.24)).add(new Vector3(0, 0, -0.04)), base.add(tilt.scale(0.31)).add(new Vector3(0, -0.02, -0.12))];
  g.ribbon(pts, {
    samples: 7,
    segs: 24,
    width: (s) => lerp(0.104, 0.0, Math.pow(s, 0.85)),
    thick: (s) => lerp(0.112, 0.0, Math.pow(s, 0.85)),
    normal: () => fwd,
    w: () => one('head'),
    uv: (s) => uvOf(s < 0.13 && s > 0.03 ? band : sw),
    n: 2,
  });
}

/** A fur cap with round ears. */
function bearHat(c: OutfitCtx, g: Geo) {
  const rows = 9;
  const cols = 40;
  const outer: Vector3[][] = [];
  const inner: Vector3[][] = [];
  for (let i = 0; i <= rows; i++) {
    const ro: Vector3[] = [];
    const ri: Vector3[] = [];
    for (let j = 0; j < cols; j++) {
      const phi = -180 + (j / cols) * 360;
      const a = Math.abs(phi);
      const edge = a < 60 ? 30 : lerp(30, -15, smooth(60, 150, a));
      const th = lerp(89.5, edge, i / rows);
      const tuft = i === rows ? 0.06 * Math.abs(Math.sin(j * 1.7)) : 0;
      ro.push(scalp(phi, th - tuft * 60, 0.24 + tuft));
      ri.push(scalp(phi, th, 0.12));
    }
    outer.push(ro);
    inner.push(ri);
  }
  g.shell(outer, inner, { wrap: true, uv: (i) => uvOf(i >= rows - 1 ? SW.fur : SW.furDark), w: () => one('head') });
  for (const side of [-1, 1]) {
    const c0 = scalp(side * 58, 62, 0.3);
    g.blob(c0, [X, Y, Z], [0.032, 0.03, 0.016], one('head'), uvOf(SW.furDark), { lat: 8, lon: 12 });
    g.blob(c0.add(new Vector3(0, -0.003, 0.012)), [X, Y, Z], [0.018, 0.017, 0.006], one('head'), uvOf(SW.fur), { lat: 6, lon: 10 });
  }
}

// ------------------------------------------------------------------ outfits

const steel = SW.metal(0);
const steelDark = SW.metal(1);
const gold = SW.gold(0);

export const OUTFIT_DEFS: OutfitDef[] = [
  // Squire's Plate: silver plate with gold trim over a navy tunic, crimson skirt and cape
  {
    colors: [
      [SW.cloth(0), '#2c3b6e'],
      [SW.cloth(1), '#262b40'],
      [SW.cloth(2), '#a3243b'],
      [SW.cloth(3), '#e9d9a8'],
      [SW.leather(0), '#5a3a28'],
      [steel, '#d3dbe6'],
      [steelDark, '#8d98ab'],
      [gold, '#d9a640'],
    ],
    dress: { top: SW.cloth(0), bottom: SW.cloth(1), waistY: 1.0, sleeve: 'long', sleeveColor: SW.cloth(0), glove: 'gauntlet', gloveColor: steel, gloveLen: 0.7, trousers: SW.cloth(1), boot: 0.34, bootColor: steel, bootSole: steelDark },
    garments: (c) => {
      torsoLayer(c, 1.05, 1.47, 0.016, steel, { trim: gold });
      torsoBand(c, 0.985, 1.025, 0.02, SW.leather(0));
      buckle(c, 1.005, 0.02, gold, SW.leather(0));
      pouch(c, 0.995, 35, SW.leather(0), SW.leather(0), 0.85);
      skirt(c, 1.0, 0.7, 0.045, SW.cloth(2), { panels: [[-62, 62], [70, 150], [158, 202], [210, 290]], trim: gold, inner: SW.cloth(3) });
      pauldron(c, steel, gold, 2);
      cape(c, SW.cloth(2), SW.cloth(3), { trim: gold });
      // knee guards
      for (const side of [-1, 1] as const) {
        const s = side > 0 ? 'l' : 'r';
        limbBand(c, legNames(s), 0.4, 0.47, 0.062, 0.058, steel, () => one(`lowerleg.${s}`), { front: 1.15 });
        limbBand(c, armNames(s), 0.43, 0.48, 0.046, 0.052, steel, () => one(`lowerarm.${s}`));
      }
    },
    headgear: { kind: 'helmet', covers: ['top', 'back', 'side', 'long', 'tail'], build: (c, g) => helmet(c, g, steel, gold) },
  },
  // Ranger Leathers: forest-green tunic, leather vest and bracers, a hooded cloak
  {
    colors: [
      [SW.cloth(0), '#3f7a45'],
      [SW.cloth(1), '#6b5640'],
      [SW.cloth(2), '#2f5a36'],
      [SW.cloth(3), '#c9b98a'],
      [SW.leather(0), '#7a4f2e'],
      [SW.leather(1), '#4b3121'],
      [gold, '#c79a52'],
    ],
    dress: { top: SW.cloth(0), bottom: SW.cloth(1), waistY: 1.0, sleeve: 'long', sleeveColor: SW.cloth(0), glove: 'fingerless', gloveColor: SW.leather(0), gloveLen: 0.85, trousers: SW.cloth(1), boot: 0.3, bootColor: SW.leather(0), bootSole: SW.leather(1) },
    garments: (c) => {
      torsoLayer(c, 1.03, 1.42, 0.012, SW.leather(0), { open: 0.32, inner: SW.leather(1) });
      skirt(c, 1.0, 0.76, 0.03, SW.cloth(0), { panels: [[-70, 70], [110, 250]], inner: SW.cloth(2) });
      torsoBand(c, 0.99, 1.02, 0.024, SW.leather(1));
      buckle(c, 1.005, 0.024, gold, SW.leather(1), 0.9);
      pouch(c, 1.0, 30, SW.leather(0), SW.leather(1));
      pouch(c, 1.0, 152, SW.leather(0), SW.leather(1), 0.8);
      for (const side of [-1, 1] as const) {
        const s = side > 0 ? 'l' : 'r';
        limbBand(c, legNames(s), 0.535, 0.575, 0.06, 0.063, SW.leather(1), () => one(`lowerleg.${s}`));
      }
      cape(c, SW.cloth(2), SW.cloth(3), { bottom: 0.82, flare: 0.08, width: 0.92 });
      if (!c.hat) hoodDown(c, SW.cloth(2));
    },
    headgear: { kind: 'hood', covers: ['top', 'back', 'long', 'tail'], build: (c, g) => hood(c, g, SW.cloth(2), SW.cloth(3)) },
  },
  // Arcanist Robes: a long twilight robe with brass trim, bell sleeves and a wizard's hat
  {
    colors: [
      [SW.cloth(0), '#3e3080'],
      [SW.cloth(1), '#241d3d'],
      [SW.cloth(2), '#2b2560'],
      [SW.cloth(3), '#e6d6a0'],
      [SW.leather(0), '#3c2a24'],
      [gold, '#d6a24a'],
      [SW.gem(0), '#7fd6ff'],
    ],
    dress: { top: SW.cloth(0), bottom: SW.cloth(0), waistY: 1.0, sleeve: 'long', sleeveColor: SW.cloth(0), glove: 'none', gloveColor: SW.cloth(0), gloveLen: 0, trousers: SW.cloth(1), boot: 0.12, bootColor: SW.leather(0), bootSole: SW.cloth(1) },
    garments: (c) => {
      skirt(c, 1.02, 0.14, 0.2, SW.cloth(0), { panels: [[-160, 160]], trim: gold, inner: SW.cloth(2), rows: 14 });
      torsoBand(c, 0.995, 1.04, 0.022, SW.cloth(3));
      c.g.blob(new Vector3(0, 1.018, torsoRing(1.02, c.build).f + 0.028), [X, Y, Z], [0.016, 0.016, 0.01], one('hips'), uvOf(SW.gem(0)), { lat: 6, lon: 10 });
      mantle(c, SW.cloth(2), { size: 0.92, drop: 0.02, dark: gold });
      for (const side of [-1, 1] as const) {
        const s = side > 0 ? 'l' : 'r';
        // bell sleeves
        limbBand(c, armNames(s), 0.36, 0.53, 0.046, 0.075, SW.cloth(0), (d) => blend(one(`lowerarm.${s}`), one(`hand.${s}`), smooth(0.5, 0.56, d) * 0.3));
        limbBand(c, armNames(s), 0.515, 0.535, 0.077, 0.079, gold, () => one(`lowerarm.${s}`));
      }
      cape(c, SW.cloth(2), SW.cloth(1), { bottom: 0.3, flare: 0.16, trim: gold });
    },
    headgear: { kind: 'wizard', covers: ['top', 'tail'], build: (c, g) => wizardHat(c, g, SW.cloth(0), gold) },
  },
  // Northman Furs: bare arms, a leather jerkin, fur mantle and boots
  {
    colors: [
      [SW.cloth(0), '#7c4b2c'],
      [SW.cloth(1), '#4a3a2e'],
      [SW.cloth(2), '#5e3a24'],
      [SW.leather(0), '#6e4429'],
      [SW.leather(1), '#3e281b'],
      [steel, '#b9c0c9'],
      [gold, '#c99a4a'],
    ],
    dress: { top: SW.leather(0), bottom: SW.cloth(1), waistY: 1.0, sleeve: 'none', sleeveColor: SW.leather(0), glove: 'fingerless', gloveColor: SW.leather(1), gloveLen: 1, trousers: SW.cloth(1), boot: 0.32, bootColor: SW.fur, bootSole: SW.leather(1) },
    garments: (c) => {
      mantle(c, SW.fur, { tufts: 22, size: 1.05, dark: SW.furDark });
      torsoBand(c, 0.97, 1.03, 0.026, SW.leather(1));
      buckle(c, 1.0, 0.026, steel, SW.leather(1), 1.2);
      pouch(c, 0.99, 140, SW.leather(0), SW.leather(1));
      bootCuffs(c);
      skirt(c, 0.99, 0.72, 0.06, SW.cloth(2), { panels: [[-35, 35], [145, 215]], inner: SW.leather(1) });
      for (const side of [-1, 1] as const) {
        const s = side > 0 ? 'l' : 'r';
        limbBand(c, armNames(s), 0.06, 0.1, 0.06, 0.06, SW.leather(1), () => one(`upperarm.${s}`));
      }
      cape(c, SW.furDark, SW.cloth(2), { bottom: 0.6, flare: 0.1, trim: SW.fur });
    },
    headgear: { kind: 'bearhat', covers: ['top', 'tail'], build: (c, g) => bearHat(c, g) },
  },
  // Wanderer: cream tunic, a long red scarf, wrapped forearms and fur boots
  {
    colors: [
      [SW.cloth(0), '#e2d4b0'],
      [SW.cloth(1), '#5d4636'],
      [SW.cloth(2), '#b8463a'],
      [SW.cloth(3), '#cbb894'],
      [SW.leather(0), '#7a5236'],
      [SW.leather(1), '#463024'],
      [steel, '#b9c0c9'],
      [gold, '#c99a4a'],
    ],
    dress: { top: SW.cloth(0), bottom: SW.cloth(1), waistY: 1.0, sleeve: 'elbow', sleeveColor: SW.cloth(0), glove: 'fingerless', gloveColor: SW.cloth(3), gloveLen: 0.9, trousers: SW.cloth(1), boot: 0.28, bootColor: SW.fur, bootSole: SW.leather(1) },
    garments: (c) => {
      skirt(c, 1.0, 0.74, 0.035, SW.cloth(0), { panels: [[-80, 80], [100, 260]], inner: SW.cloth(3) });
      torsoBand(c, 0.985, 1.02, 0.024, SW.leather(0));
      buckle(c, 1.0, 0.024, steel, SW.leather(0), 0.85);
      placket(c, 1.4, 1.05, SW.cloth(3), SW.leather(1));
      pouch(c, 0.995, 145, SW.leather(1), SW.leather(0));
      bootCuffs(c);
      scarf(c, SW.cloth(2));
    },
  },
  // Battlemage: robes under knightly steel, a crimson cape
  {
    colors: [
      [SW.cloth(0), '#3e3080'],
      [SW.cloth(1), '#241d3d'],
      [SW.cloth(2), '#a3243b'],
      [SW.cloth(3), '#e9d9a8'],
      [SW.leather(0), '#3c2a24'],
      [steel, '#d3dbe6'],
      [steelDark, '#8d98ab'],
      [gold, '#d9a640'],
      [SW.gem(0), '#b48cff'],
    ],
    dress: { top: SW.cloth(0), bottom: SW.cloth(0), waistY: 1.0, sleeve: 'long', sleeveColor: SW.cloth(0), glove: 'gauntlet', gloveColor: steel, gloveLen: 0.6, trousers: SW.cloth(1), boot: 0.3, bootColor: steel, bootSole: steelDark },
    garments: (c) => {
      skirt(c, 1.02, 0.36, 0.13, SW.cloth(0), { panels: [[-150, 150]], trim: gold, inner: SW.cloth(1), rows: 12 });
      torsoLayer(c, 1.12, 1.45, 0.012, steelDark, { trim: gold });
      torsoBand(c, 0.995, 1.04, 0.02, SW.leather(0));
      c.g.blob(new Vector3(0, 1.018, torsoRing(1.02, c.build).f + 0.026), [X, Y, Z], [0.016, 0.016, 0.01], one('hips'), uvOf(SW.gem(0)), { lat: 6, lon: 10 });
      pauldron(c, steel, gold, 2, 1.05);
      cape(c, SW.cloth(2), SW.cloth(3), { trim: gold, bottom: 0.38 });
    },
  },
];
