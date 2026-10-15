// Hearthmere's buildings, modelled in code: half-timbered houses with jettied
// upper floors, stepped tile roofs, flower boxes and shuttered windows; a
// tavern with a hanging sign, an open-fronted smithy with a glowing forge, a
// stone chapel with a bell tower, a round watchtower, a windmill with turning
// sails, a covered well, market stalls with striped awnings, lantern posts,
// bunting and a cobbled square.
//
// Everything is plain boxes and prisms with per-vertex colour (flat normals,
// so the cel shading draws crisp planes), collected into a few big buffers:
// the whole village is one opaque mesh, one window mesh that glows at night,
// and the windmill's sails.
import { Matrix, Vector3, VertexData } from '@babylonjs/core';

type C3 = [number, number, number];

const srgb = (h: string): C3 => {
  const n = parseInt(h.slice(1), 16);
  // to linear (vertex colours are used as linear albedo)
  const f = (v: number) => Math.pow(v / 255, 2.2);
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
};

export const PAL = {
  plaster: srgb('#f1e8d6'),
  plasterWarm: srgb('#f3dcc0'),
  plasterBlue: srgb('#dfe6ec'),
  timber: srgb('#5a3b2a'),
  timberLight: srgb('#7a5236'),
  stone: srgb('#a9a197'),
  stoneDark: srgb('#7d766f'),
  stoneWarm: srgb('#b9a68f'),
  roofRed: srgb('#c4553f'),
  roofTeal: srgb('#3f7f86'),
  roofBlue: srgb('#4a6aa8'),
  roofSlate: srgb('#5d6476'),
  roofOchre: srgb('#c88a45'),
  door: srgb('#6e4a2e'),
  iron: srgb('#3b3b42'),
  gold: srgb('#d9a845'),
  shutterGreen: srgb('#4f8a5c'),
  shutterBlue: srgb('#4d78a8'),
  shutterRed: srgb('#b2504a'),
  leaf: srgb('#4f8f3a'),
  flowers: [srgb('#ff6f8a'), srgb('#ffd34d'), srgb('#ffffff'), srgb('#b07cff'), srgb('#ff8a3d')],
  cloth: [srgb('#d94c4c'), srgb('#f2ead8'), srgb('#3f74c4'), srgb('#e8b73c'), srgb('#4f9a63')],
  ember: srgb('#ff7a2a'),
};

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

/** One growable vertex-coloured buffer. */
export class Geo {
  positions: number[] = [];
  normals: number[] = [];
  colors: number[] = [];
  indices: number[] = [];
  get count() {
    return this.positions.length / 3;
  }
  toVertexData() {
    const vd = new VertexData();
    vd.positions = this.positions;
    vd.normals = this.normals;
    vd.colors = this.colors;
    vd.indices = this.indices;
    return vd;
  }
}

const tmpV = new Vector3();
const tmpN = new Vector3();
const BOX_FACES: [number[], number[][]][] = [
  [[1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]],
  [[-1, 0, 0], [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]]],
  [[0, 1, 0], [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]]],
  [[0, -1, 0], [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]]],
  [[0, 0, 1], [[1, -1, 1], [1, 1, 1], [-1, 1, 1], [-1, -1, 1]]],
  [[0, 0, -1], [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]]],
];

/**
 * Builds geometry under a transform stack (translate / rotate), with gentle
 * per-piece colour jitter so nothing looks machine-made.
 */
export class Kit {
  readonly main = new Geo();
  readonly glass = new Geo();
  readonly sails = new Geo();
  private stack: Matrix[] = [Matrix.Identity()];
  rnd: () => number;
  /** Colour jitter amount (0 = exact colours). */
  jitter = 0.08;
  /** Where push/pop'd geometry goes. */
  target: 'main' | 'glass' | 'sails' = 'main';

  constructor(seed = 1) {
    this.rnd = rng(seed);
  }

  private get top() {
    return this.stack[this.stack.length - 1];
  }

  push(x = 0, y = 0, z = 0, yaw = 0, pitch = 0, roll = 0) {
    const local = Matrix.RotationYawPitchRoll(yaw, pitch, roll).multiply(Matrix.Translation(x, y, z));
    this.stack.push(local.multiply(this.top));
    return this;
  }

  pop() {
    if (this.stack.length > 1) this.stack.pop();
    return this;
  }

  /** A point in the current frame, in world space. */
  world(x: number, y: number, z: number) {
    return Vector3.TransformCoordinatesFromFloatsToRef(x, y, z, this.top, new Vector3());
  }

  /** Build into a fresh identity frame (geometry that moves on its own, like sails). */
  isolate(fn: () => void) {
    const keep = this.stack;
    this.stack = [Matrix.Identity()];
    fn();
    this.stack = keep;
  }

  /** A window pane: the blue channel is a per-window id that decides when it lights up at night. */
  pane(x: number, y: number, z: number, sx: number, sy: number, sz: number, id = this.rnd() * 0.85 + 0.1) {
    const keep = this.target;
    this.target = 'glass';
    this.box(x, y, z, sx, sy, sz, [1, 1, id], undefined, 0);
    this.target = keep;
  }

  private geo(): Geo {
    return this.target === 'glass' ? this.glass : this.target === 'sails' ? this.sails : this.main;
  }

  private tint(c: C3, amount = this.jitter): C3 {
    const j = 1 - amount + this.rnd() * amount * 2;
    return [c[0] * j, c[1] * j, c[2] * j];
  }

  /** Axis-aligned (in the current frame) box centred on (x, y, z), optionally rotated about its centre. */
  box(x: number, y: number, z: number, sx: number, sy: number, sz: number, color: C3, rot?: { yaw?: number; pitch?: number; roll?: number }, jitter?: number) {
    const g = this.geo();
    const m = rot ? Matrix.RotationYawPitchRoll(rot.yaw ?? 0, rot.pitch ?? 0, rot.roll ?? 0).multiply(Matrix.Translation(x, y, z)).multiply(this.top) : Matrix.Translation(x, y, z).multiply(this.top);
    const c = this.tint(color, jitter);
    for (const [n, corners] of BOX_FACES) {
      const start = g.count;
      Vector3.TransformNormalFromFloatsToRef(n[0], n[1], n[2], m, tmpN);
      tmpN.normalize();
      for (const k of corners) {
        Vector3.TransformCoordinatesFromFloatsToRef((k[0] * sx) / 2, (k[1] * sy) / 2, (k[2] * sz) / 2, m, tmpV);
        g.positions.push(tmpV.x, tmpV.y, tmpV.z);
        g.normals.push(tmpN.x, tmpN.y, tmpN.z);
        g.colors.push(c[0], c[1], c[2], 1);
      }
      g.indices.push(start, start + 2, start + 1, start, start + 3, start + 2);
    }
  }

  /** A flat polygon (in the current frame), wound clockwise as seen from the side it faces. */
  poly(points: number[][], color: C3, jitter?: number) {
    const g = this.geo();
    const m = this.top;
    const p = points.map((q) => Vector3.TransformCoordinatesFromFloatsToRef(q[0], q[1], q[2], m, new Vector3()));
    const n = Vector3.Cross(p[1].subtract(p[0]), p[2].subtract(p[0])).normalize();
    const c = this.tint(color, jitter);
    const start = g.count;
    for (const q of p) {
      g.positions.push(q.x, q.y, q.z);
      g.normals.push(-n.x, -n.y, -n.z);
      g.colors.push(c[0], c[1], c[2], 1);
    }
    for (let i = 1; i < p.length - 1; i++) g.indices.push(start, start + i, start + i + 1);
  }

  /** Double-sided flat polygon. */
  poly2(points: number[][], color: C3, jitter?: number) {
    const keep = this.rnd;
    const s = this.rnd();
    this.rnd = () => s; // same tint on both sides
    this.poly(points, color, jitter);
    this.poly(points.slice().reverse(), color, jitter);
    this.rnd = keep;
  }

  /** A faceted cylinder or cone (y up, base at y0). */
  cyl(x: number, y0: number, z: number, r0: number, r1: number, h: number, segs: number, color: C3, cap = true, phase = 0) {
    const g = this.geo();
    const m = this.top;
    const c = this.tint(color);
    for (let i = 0; i < segs; i++) {
      const a0 = phase + (i / segs) * Math.PI * 2;
      const a1 = phase + ((i + 1) / segs) * Math.PI * 2;
      const am = (a0 + a1) / 2;
      const slope = (r0 - r1) / h;
      const pts = [
        [x + Math.cos(a0) * r0, y0, z + Math.sin(a0) * r0],
        [x + Math.cos(a1) * r0, y0, z + Math.sin(a1) * r0],
        [x + Math.cos(a1) * r1, y0 + h, z + Math.sin(a1) * r1],
        [x + Math.cos(a0) * r1, y0 + h, z + Math.sin(a0) * r1],
      ];
      Vector3.TransformNormalFromFloatsToRef(Math.cos(am), slope, Math.sin(am), m, tmpN);
      tmpN.normalize();
      const start = g.count;
      for (const q of pts) {
        Vector3.TransformCoordinatesFromFloatsToRef(q[0], q[1], q[2], m, tmpV);
        g.positions.push(tmpV.x, tmpV.y, tmpV.z);
        g.normals.push(tmpN.x, tmpN.y, tmpN.z);
        g.colors.push(c[0], c[1], c[2], 1);
      }
      g.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
    }
    if (cap && r1 > 0.001) {
      const ring = Array.from({ length: segs }, (_, i) => {
        const a = phase + (i / segs) * Math.PI * 2;
        return [x + Math.cos(a) * r1, y0 + h, z + Math.sin(a) * r1];
      });
      this.poly(ring, color, 0);
    }
  }

  /** Gable roof: two tiled slopes over a w (along x) × d (along z) footprint, ridge along x, eaves at y0. */
  gableRoof(w: number, d: number, y0: number, rise: number, color: C3, o: { overhang?: number; rows?: number; gableColor?: C3; timber?: C3 } = {}) {
    const ov = o.overhang ?? 0.5;
    const half = d / 2 + ov;
    const run = half;
    const slopeLen = Math.hypot(run, rise + ov * (rise / (d / 2)));
    const ang = Math.atan2(rise, d / 2);
    const len = w + ov * 2 + 0.2;
    const rows = o.rows ?? Math.max(4, Math.round(slopeLen / 0.42));
    const eaveDrop = ov * Math.tan(ang);
    for (const side of [-1, 1]) {
      for (let r = 0; r < rows; r++) {
        const t0 = r / rows;
        // rows are laid from the eave up, each overlapping the one below
        const along = (t0 + 0.5 / rows) * slopeLen;
        const zc = side * (half - Math.cos(ang) * along);
        const yc = y0 - eaveDrop + Math.sin(ang) * along;
        const rowCol = r % 2 ? color : ([color[0] * 0.92, color[1] * 0.92, color[2] * 0.92] as C3);
        // tiles split into short runs with small gaps for a hand-laid look
        const tiles = Math.max(2, Math.round(len / 1.1));
        const off = r % 2 ? 0.5 : 0;
        for (let k = -1; k < tiles; k++) {
          const a = Math.max(-len / 2, -len / 2 + (k + off) * (len / tiles));
          const b = Math.min(len / 2, -len / 2 + (k + 1 + off) * (len / tiles));
          if (b - a < 0.05) continue;
          this.box((a + b) / 2, yc, zc, b - a - 0.04, 0.09, (slopeLen / rows) * 1.25, rowCol, { pitch: side * ang - side * 0.06 });
        }
      }
    }
    // ridge cap
    this.box(0, y0 + rise + 0.06, 0, len + 0.1, 0.18, 0.34, [color[0] * 0.7, color[1] * 0.7, color[2] * 0.7]);
    // gable ends
    const gc = o.gableColor ?? PAL.plaster;
    for (const end of [-1, 1]) {
      const x = end * (w / 2);
      const tri = [
        [x, y0, -d / 2],
        [x, y0 + rise, 0],
        [x, y0, d / 2],
      ];
      if (end < 0) this.poly(tri, gc, 0.03);
      else this.poly(tri.slice().reverse(), gc, 0.03);
      if (o.timber) {
        // king post and rafters drawn on the gable
        // (kept just under the tiles so they never poke through)
        const tx = x + end * 0.03;
        this.box(tx, y0 + rise * 0.5 - 0.1, 0, 0.06, rise - 0.2, 0.16, o.timber);
        const raf = Math.hypot(d / 2, rise) - 0.1;
        for (const s of [-1, 1]) this.box(tx, y0 + rise * 0.5 - 0.16, (s * d) / 4, 0.06, 0.14, raf, o.timber, { pitch: s * ang });
      }
    }
  }

  /** Conical tiled roof (towers, windmill): stacked rings of tiles. */
  coneRoof(x: number, y0: number, z: number, r: number, h: number, color: C3, rows = 6, segs = 12) {
    for (let i = 0; i < rows; i++) {
      const t0 = i / rows;
      const t1 = (i + 1.25) / rows;
      const c: C3 = i % 2 ? color : [color[0] * 0.9, color[1] * 0.9, color[2] * 0.9];
      this.cyl(x, y0 + t0 * h, z, r * (1 - t0) + 0.05, Math.max(0.02, r * (1 - Math.min(1, t1))), h * (t1 - t0), segs, c, false, i * 0.2);
    }
    this.cyl(x, y0 + h - 0.1, z, 0.08, 0.02, 0.9, 6, PAL.gold, false);
    this.box(x, y0 + h + 0.55, z, 0.22, 0.22, 0.22, PAL.gold, { yaw: 0.78, roll: 0.6 });
  }
}

// ---------------------------------------------------------------- pieces

/** Stone plinth: a row of irregular blocks around a rectangle. */
function plinth(k: Kit, w: number, d: number, h: number, color: C3) {
  k.box(0, h / 2 - 0.3, 0, w + 0.3, h + 0.6, d + 0.3, color, undefined, 0.04);
  // blocks proud of the base, running round the footprint
  for (const [len, along, fixed, rot] of [
    [w, 'x', d / 2 + 0.17, 0],
    [w, 'x', -d / 2 - 0.17, 0],
    [d, 'z', w / 2 + 0.17, 0],
    [d, 'z', -w / 2 - 0.17, 0],
  ] as [number, string, number, number][]) {
    let p = -len / 2;
    let row = 0;
    while (p < len / 2 - 0.1) {
      const bl = Math.min(len / 2 - p, 0.5 + k.rnd() * 0.6);
      const c = along === 'x' ? [p + bl / 2, fixed] : [fixed, p + bl / 2];
      const bh = h * (0.45 + k.rnd() * 0.15);
      for (let lv = 0; lv < 2; lv++) {
        const y = lv === 0 ? bh / 2 - 0.05 : bh + (h - bh) / 2 - 0.02;
        const hh = lv === 0 ? bh : h - bh - 0.04;
        if (hh < 0.08) continue;
        const sl = lv === 1 ? bl * (0.5 + k.rnd() * 0.5) : bl;
        const cc = lv === 1 ? (along === 'x' ? [p + sl / 2 + (bl - sl) * k.rnd(), fixed] : [fixed, p + sl / 2 + (bl - sl) * k.rnd()]) : c;
        k.box(cc[0], y, cc[1], along === 'x' ? sl - 0.05 : 0.12, hh, along === 'x' ? 0.12 : sl - 0.05, color, { yaw: rot }, 0.12);
      }
      p += bl;
      row++;
    }
  }
}

interface WallOpts {
  w: number;
  h: number;
  /** Plaster colour. */
  wall: C3;
  timber?: C3 | null;
  braces?: boolean;
  windows?: number;
  shutter?: C3;
  flowerBoxes?: boolean;
  door?: boolean;
  /** Window sill height above the wall's bottom. */
  sill?: number;
  /** Arched stone windows (chapel). */
  tall?: boolean;
}

/**
 * One wall face in the XY plane at z = 0, facing -z (toward the street), from
 * x = -w/2..w/2 and y = 0..h. Timber frame, windows and door sit on its face.
 */
function wallFace(k: Kit, o: WallOpts) {
  const { w, h } = o;
  const t = o.timber;
  const fz = -0.04;
  if (t) {
    // sill and head beams, corner posts, studs between windows
    k.box(0, 0.08, fz, w + 0.1, 0.16, 0.12, t);
    k.box(0, h - 0.08, fz, w + 0.1, 0.16, 0.12, t);
    k.box(-w / 2, h / 2, fz, 0.18, h, 0.14, t);
    k.box(w / 2, h / 2, fz, 0.18, h, 0.14, t);
  }
  const n = o.windows ?? 0;
  const slots: number[] = [];
  const doorAt = o.door ? (n % 2 === 0 ? 0 : -w * 0.22) : null;
  for (let i = 0; i < n; i++) {
    let x = -w / 2 + ((i + 0.5) / n) * w;
    if (doorAt !== null && Math.abs(x - doorAt) < 0.9) x += x < doorAt ? -0.6 : 0.6;
    slots.push(x);
  }
  if (t) {
    // studs between openings, braces in the wide panels
    const posts = [-w / 2, ...slots.flatMap((x) => [x - 0.62, x + 0.62]), ...(doorAt !== null ? [doorAt - 0.72, doorAt + 0.72] : []), w / 2].sort((a, b) => a - b);
    for (let i = 0; i < posts.length - 1; i++) {
      const a = posts[i];
      const b = posts[i + 1];
      const span = b - a;
      const mid = (a + b) / 2;
      const isOpening = slots.some((x) => Math.abs(x - mid) < 0.1) || (doorAt !== null && Math.abs(doorAt - mid) < 0.1);
      if (span > 0.25 && i > 0) k.box(a, h / 2, fz, 0.13, h - 0.2, 0.12, t);
      if (!isOpening && span > 0.9 && o.braces) {
        const len = Math.hypot(span, h - 0.3);
        const ang = Math.atan2(h - 0.3, span);
        k.box(mid, h / 2, fz - 0.01, len, 0.12, 0.1, t, { roll: (i % 2 ? 1 : -1) * ang });
      }
    }
  }
  const sill = o.sill ?? h * 0.38;
  for (const x of slots) {
    const ww = o.tall ? 0.7 : 0.82;
    const wh = o.tall ? Math.min(h - sill - 0.3, 2.0) : Math.min(1.05, h - sill - 0.35);
    const cy = sill + wh / 2;
    const frame = t ?? PAL.timber;
    // frame, mullions, sill
    k.box(x, cy + wh / 2 + 0.06, fz - 0.03, ww + 0.24, 0.12, 0.14, frame);
    k.box(x, sill - 0.05, fz - 0.06, ww + 0.34, 0.1, 0.22, o.tall ? PAL.stone : frame);
    k.box(x - ww / 2 - 0.06, cy, fz - 0.03, 0.1, wh + 0.1, 0.13, frame);
    k.box(x + ww / 2 + 0.06, cy, fz - 0.03, 0.1, wh + 0.1, 0.13, frame);
    k.box(x, cy, fz - 0.05, 0.05, wh, 0.05, frame);
    k.box(x, cy, fz - 0.05, ww, 0.05, 0.05, frame);
    if (o.tall) {
      // pointed arch over a tall window
      k.box(x, cy + wh / 2 + 0.2, fz - 0.04, 0.5, 0.12, 0.13, PAL.stone, { roll: 0.5 });
      k.box(x, cy + wh / 2 + 0.2, fz - 0.04, 0.5, 0.12, 0.13, PAL.stone, { roll: -0.5 });
    }
    // glass, glowing at night
    k.pane(x, cy, fz + 0.03, ww, wh, 0.04);
    if (o.shutter && !o.tall) {
      // open shutters with a diagonal plank
      for (const s of [-1, 1]) {
        const sx = x + s * (ww / 2 + 0.36);
        k.box(sx, cy, fz - 0.07, ww * 0.5, wh + 0.04, 0.05, o.shutter);
        k.box(sx, cy, fz - 0.1, ww * 0.5 - 0.06, 0.06, 0.02, [o.shutter[0] * 0.7, o.shutter[1] * 0.7, o.shutter[2] * 0.7]);
      }
    }
    if (o.flowerBoxes && k.rnd() < 0.8) {
      const by = sill - 0.2;
      k.box(x, by, fz - 0.2, ww + 0.2, 0.22, 0.26, PAL.timberLight);
      for (let f = 0; f < 6; f++) {
        const fx = x - ww / 2 + ((f + 0.5) / 6) * ww;
        k.box(fx, by + 0.2, fz - 0.2 + (k.rnd() - 0.5) * 0.1, 0.22, 0.2, 0.22, PAL.leaf, { yaw: k.rnd() * 2 });
        k.box(fx + (k.rnd() - 0.5) * 0.08, by + 0.3 + k.rnd() * 0.06, fz - 0.22, 0.12, 0.1, 0.12, PAL.flowers[Math.floor(k.rnd() * PAL.flowers.length)], { yaw: k.rnd() * 2 }, 0.05);
      }
    }
  }
  if (doorAt !== null) {
    const dh = Math.min(2.25, h - 0.3);
    const dw = 1.15;
    const frame = t ?? PAL.timber;
    k.box(doorAt, dh / 2, fz + 0.02, dw, dh, 0.06, PAL.door);
    // planks and iron straps
    for (let i = 1; i < 4; i++) k.box(doorAt - dw / 2 + (i * dw) / 4, dh / 2, fz - 0.02, 0.025, dh - 0.1, 0.02, [PAL.door[0] * 0.7, PAL.door[1] * 0.7, PAL.door[2] * 0.7]);
    for (const y of [0.45, dh - 0.45]) k.box(doorAt, y, fz - 0.035, dw - 0.1, 0.07, 0.02, PAL.iron);
    k.box(doorAt + dw * 0.32, dh * 0.48, fz - 0.06, 0.08, 0.08, 0.06, PAL.gold);
    k.box(doorAt, dh + 0.08, fz - 0.03, dw + 0.3, 0.16, 0.16, frame);
    k.box(doorAt - dw / 2 - 0.08, dh / 2, fz - 0.03, 0.14, dh, 0.14, frame);
    k.box(doorAt + dw / 2 + 0.08, dh / 2, fz - 0.03, 0.14, dh, 0.14, frame);
    // step
    k.box(doorAt, -0.08, fz - 0.35, dw + 0.5, 0.2, 0.6, PAL.stone);
  }
}

/** Four walls of a storey: front (-z) gets the door, others windows. */
function storey(k: Kit, w: number, d: number, h: number, o: Omit<WallOpts, 'w' | 'h'> & { backWindows?: number; sideWindows?: number }) {
  k.box(0, h / 2, 0, w, h, d, o.wall, undefined, 0.03);
  const faces: [number, number, number, number, boolean][] = [
    [0, -d / 2, 0, o.windows ?? 2, !!o.door],
    [0, d / 2, Math.PI, o.backWindows ?? Math.max(1, (o.windows ?? 2) - 1), false],
    [-w / 2, 0, Math.PI / 2, o.sideWindows ?? 1, false],
    [w / 2, 0, -Math.PI / 2, o.sideWindows ?? 1, false],
  ];
  for (const [x, z, yaw, wins, door] of faces) {
    const fw = Math.abs(yaw) === Math.PI / 2 ? d : w;
    k.push(x, 0, z, yaw);
    wallFace(k, { ...o, w: fw, h, windows: wins, door });
    k.pop();
  }
}

function chimney(k: Kit, x: number, y0: number, z: number, h: number, chimneys: Vector3[]) {
  k.box(x, y0 + h / 2, z, 0.75, h, 0.75, PAL.stone, undefined, 0.05);
  for (let i = 0; i < Math.floor(h / 0.45); i++) k.box(x + (i % 2 ? 0.02 : -0.02), y0 + 0.25 + i * 0.45, z - 0.38, 0.6, 0.18, 0.04, PAL.stoneDark, undefined, 0.1);
  k.box(x, y0 + h + 0.06, z, 0.92, 0.14, 0.92, PAL.stoneDark);
  chimneys.push(k.world(x, y0 + h + 0.3, z));
}

// ---------------------------------------------------------------- buildings

export interface BuildCtx {
  kit: Kit;
  /** Chimney tops (world space), for smoke. */
  chimneys: Vector3[];
  /** Lantern positions (world space). */
  lamps: Vector3[];
}

interface HouseOpts {
  w: number;
  d: number;
  floors: number;
  roof: C3;
  wall?: C3;
  shutter?: C3;
  jetty?: boolean;
  rise?: number;
  balcony?: boolean;
  dormer?: boolean;
}

export function house(c: BuildCtx, o: HouseOpts) {
  const k = c.kit;
  const base = 0.55;
  plinth(k, o.w, o.d, base, PAL.stone);
  const h0 = 2.9;
  // ground floor: stone or plaster
  k.push(0, base, 0);
  storey(k, o.w, o.d, h0, { wall: o.wall ?? PAL.plaster, timber: PAL.timber, braces: false, windows: Math.max(1, Math.round(o.w / 2.6)), door: true, shutter: o.shutter, flowerBoxes: true, sideWindows: o.d > 5 ? 2 : 1 });
  k.pop();
  let y = base + h0;
  let w = o.w;
  let d = o.d;
  for (let f = 1; f < o.floors; f++) {
    const jet = o.jetty ? 0.35 : 0;
    // floor beam ends sticking out under a jettied storey
    if (jet) for (let i = 0; i <= Math.round(w / 0.8); i++) k.box(-w / 2 + (i * w) / Math.round(w / 0.8), y + 0.06, -d / 2 - jet / 2, 0.16, 0.18, jet + 0.2, PAL.timber);
    w += jet * 2;
    d += jet * 2;
    k.push(0, y, 0);
    storey(k, w, d, 2.6, { wall: o.wall ?? PAL.plaster, timber: PAL.timber, braces: true, windows: Math.max(2, Math.round(w / 2.2)), shutter: o.shutter, flowerBoxes: true, sideWindows: 1, sill: 0.9 });
    k.pop();
    y += 2.6;
  }
  if (o.balcony) {
    const by = base + h0 + 0.05;
    k.box(0, by, -d / 2 - 0.55, w * 0.55, 0.12, 1.0, PAL.timberLight);
    for (let i = 0; i <= 8; i++) k.box(-w * 0.275 + (i * w * 0.55) / 8, by + 0.45, -d / 2 - 1.02, 0.06, 0.8, 0.06, PAL.timber);
    k.box(0, by + 0.86, -d / 2 - 1.02, w * 0.55 + 0.1, 0.08, 0.1, PAL.timber);
    for (const s of [-1, 1]) k.box((s * w * 0.55) / 2, by - 0.5, -d / 2 - 0.9, 0.12, 1.0, 0.12, PAL.timber, { pitch: s * 0 + 0.6 });
  }
  const rise = o.rise ?? d * 0.62;
  k.gableRoof(w, d, y, rise, o.roof, { gableColor: o.wall ?? PAL.plaster, timber: PAL.timber, overhang: 0.55 });
  if (o.dormer) {
    // a little dormer window on the front slope
    const dz = -d / 4 - 0.1;
    const dy = y + rise * 0.42;
    k.box(0, dy + 0.55, dz, 1.4, 1.1, 1.2, o.wall ?? PAL.plaster);
    k.pane(0, dy + 0.55, dz - 0.61, 0.7, 0.7, 0.04);
    for (const s of [-1, 1]) {
      k.box(s * 0.4, dy + 0.55, dz - 0.63, 0.08, 0.86, 0.06, PAL.timber);
      k.box(0, dy + 0.55 + s * 0.4, dz - 0.63, 0.86, 0.08, 0.06, PAL.timber);
    }
    k.box(0, dy + 0.55, dz - 0.64, 0.04, 0.7, 0.03, PAL.timber);
    k.push(0, dy + 1.1, dz, 0);
    k.gableRoof(1.4, 1.3, 0, 0.6, o.roof, { overhang: 0.18, rows: 3, gableColor: o.wall ?? PAL.plaster });
    k.pop();
  }
  chimney(k, w * 0.28, y + rise * 0.3, d * 0.18, rise * 0.85 + 0.9, c.chimneys);
  // a lantern beside the door
  lamp(k, c, -0.95, base + 2.4, -o.d / 2 - 0.25);
}

/** A small wall lantern on a bracket (glass glows at night). */
function lamp(k: Kit, c: BuildCtx, x: number, y: number, z: number) {
  k.box(x, y + 0.25, z + 0.12, 0.05, 0.05, 0.3, PAL.iron);
  k.box(x, y, z - 0.05, 0.26, 0.04, 0.26, PAL.iron);
  k.box(x, y + 0.36, z - 0.05, 0.3, 0.06, 0.3, PAL.iron);
  for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) k.box(x + dx * 0.12, y + 0.18, z - 0.05 + dz * 0.12, 0.03, 0.34, 0.03, PAL.iron);
  k.pane(x, y + 0.18, z - 0.05, 0.2, 0.3, 0.2, 0);
  c.lamps.push(k.world(x, y + 0.18, z - 0.05));
}

export function tavern(c: BuildCtx) {
  const k = c.kit;
  house(c, { w: 9.5, d: 7, floors: 3, roof: PAL.roofRed, wall: PAL.plasterWarm, shutter: PAL.shutterGreen, jetty: true, balcony: true, dormer: true, rise: 4.6 });
  // hanging sign: a tankard on a board
  const sx = 3.2;
  const sy = 3.2;
  const sz = -3.5 - 0.1;
  k.box(sx, sy + 0.6, sz - 0.5, 0.08, 0.08, 1.2, PAL.iron);
  k.box(sx, sy, sz - 0.95, 0.9, 0.7, 0.07, PAL.timberLight);
  k.box(sx, sy, sz - 0.99, 0.95, 0.75, 0.02, PAL.timber);
  k.box(sx - 0.05, sy - 0.03, sz - 1.01, 0.3, 0.38, 0.02, PAL.gold);
  k.box(sx + 0.16, sy, sz - 1.01, 0.1, 0.2, 0.02, PAL.gold);
  for (const s of [-0.38, 0.38]) k.box(sx + s, sy + 0.45, sz - 0.95, 0.02, 0.25, 0.02, PAL.iron);
  // barrels by the door
  for (let i = 0; i < 3; i++) {
    const bx = -3.6 + i * 0.75;
    k.cyl(bx, 0.55, -4.1, 0.34, 0.34, 0.9, 10, PAL.timberLight);
    k.cyl(bx, 0.7, -4.1, 0.36, 0.36, 0.08, 10, PAL.iron, false);
    k.cyl(bx, 1.25, -4.1, 0.36, 0.36, 0.08, 10, PAL.iron, false);
  }
  // benches and a table out front
  k.box(1.8, 0.78, -5.4, 1.8, 0.1, 0.9, PAL.timberLight);
  for (const dx of [-0.75, 0.75]) k.box(1.8 + dx, 0.36, -5.4, 0.1, 0.8, 0.7, PAL.timber);
  for (const dz of [-0.85, 0.85]) {
    k.box(1.8, 0.46, -5.4 + dz, 1.8, 0.08, 0.32, PAL.timberLight);
    for (const dx of [-0.7, 0.7]) k.box(1.8 + dx, 0.2, -5.4 + dz, 0.08, 0.44, 0.08, PAL.timber);
  }
}

export function smithy(c: BuildCtx) {
  const k = c.kit;
  const w = 8;
  const d = 6.5;
  plinth(k, w, d, 0.4, PAL.stoneDark);
  // stone back half
  k.push(0, 0.4, d / 4);
  k.box(0, 1.6, 0, w, 3.2, d / 2, PAL.stone, undefined, 0.04);
  for (let i = 0; i < 18; i++) k.box(-w / 2 + k.rnd() * w, 0.4 + k.rnd() * 2.6, -d / 4 - 0.03, 0.5 + k.rnd() * 0.4, 0.28, 0.06, PAL.stoneDark, undefined, 0.15);
  k.pop();
  // open front under a lean-to roof on posts
  for (const x of [-w / 2 + 0.2, 0, w / 2 - 0.2]) k.box(x, 0.4 + 1.6, -d / 2 + 0.25, 0.28, 3.2, 0.28, PAL.timber);
  k.box(0, 3.45, -d / 2 + 0.25, w + 0.4, 0.3, 0.32, PAL.timber);
  k.push(0, 3.6, 0);
  k.gableRoof(w, d, 0, 2.6, PAL.roofSlate, { gableColor: PAL.stone, timber: PAL.timber, overhang: 0.6 });
  k.pop();
  // forge: stone hearth with glowing coals, a hood and chimney
  const fx = -2.2;
  const fz = 0.6;
  k.box(fx, 0.9, fz, 1.8, 1.0, 1.4, PAL.stoneDark);
  // coals (red-orange in the glass buffer: always glowing)
  k.target = 'glass';
  k.box(fx, 1.42, fz, 1.3, 0.06, 0.9, [1, 0.4, 0], undefined, 0);
  k.target = 'main';
  k.box(fx, 2.8, fz + 0.2, 1.5, 0.9, 1.0, PAL.stone, { pitch: -0.2 });
  chimney(k, fx, 3.0, fz + 0.4, 3.2, c.chimneys);
  // anvil and quench barrel
  k.box(0.6, 0.75, -1.2, 0.4, 0.5, 0.4, PAL.timber);
  k.box(0.6, 1.1, -1.2, 0.8, 0.22, 0.32, PAL.iron);
  k.box(1.05, 1.13, -1.2, 0.25, 0.14, 0.2, PAL.iron);
  k.cyl(2.2, 0.4, -1.4, 0.42, 0.4, 0.8, 10, PAL.timberLight);
  // tools on the back wall
  for (let i = 0; i < 4; i++) k.box(1.2 + i * 0.5, 2.5, 0.37, 0.06, 0.9, 0.04, PAL.iron, { roll: 0.1 * (i - 1.5) });
  c.lamps.push(k.world(fx, 1.6, fz));
}

export function market(c: BuildCtx) {
  const k = c.kit;
  // three stalls in an arc, each with a striped cloth awning and wares
  for (let i = 0; i < 3; i++) {
    const a = (i - 1) * 0.55;
    k.push(Math.sin(a) * 4.2, 0, -Math.cos(a) * 1.4 + 1.4, -a);
    const sw = 3.0;
    const sd = 2.0;
    // counter
    k.box(0, 0.5, -sd / 2 + 0.2, sw, 1.0, 0.6, PAL.timberLight);
    k.box(0, 1.03, -sd / 2 + 0.2, sw + 0.15, 0.08, 0.75, PAL.timber);
    for (const sx of [-sw / 2, sw / 2]) for (const sz of [-sd / 2, sd / 2]) k.box(sx, 1.25, sz, 0.12, sz < 0 ? 2.5 : 2.9, 0.12, PAL.timber);
    // awning stripes, sloping toward the front
    const stripes = 8;
    const col1 = PAL.cloth[i % PAL.cloth.length];
    const col2 = PAL.cloth[1];
    for (let s = 0; s < stripes; s++) {
      const x = -sw / 2 - 0.15 + ((s + 0.5) / stripes) * (sw + 0.3);
      k.box(x, 2.6, 0, (sw + 0.3) / stripes, 0.05, sd + 0.6, s % 2 ? col1 : col2, { pitch: -0.32 }, 0.03);
      // scalloped valance
      k.box(x, 2.25, -sd / 2 - 0.42, (sw + 0.3) / stripes - 0.04, 0.32, 0.03, s % 2 ? col1 : col2, undefined, 0.03);
    }
    // wares: fruit, cloth bolts, pots
    for (let j = 0; j < 7; j++) {
      const wx = -sw / 2 + 0.3 + j * 0.4;
      const ware = i === 0 ? PAL.flowers[j % 5] : i === 1 ? PAL.cloth[(j + 2) % 5] : PAL.stoneWarm;
      if (i === 2) k.cyl(wx, 1.07, -sd / 2 + 0.2, 0.13, 0.09, 0.28, 7, ware);
      else k.box(wx, 1.15, -sd / 2 + 0.2 + (k.rnd() - 0.5) * 0.2, 0.26, 0.16, 0.26, ware, { yaw: k.rnd() }, 0.1);
    }
    // crates beside
    k.box(sw / 2 + 0.5, 0.3, 0.3, 0.6, 0.6, 0.6, PAL.timberLight, { yaw: 0.3 });
    k.pop();
  }
}

export function chapel(c: BuildCtx) {
  const k = c.kit;
  const w = 7;
  const d = 11;
  plinth(k, w, d, 0.6, PAL.stoneDark);
  k.push(0, 0.6, 0);
  // stone nave, long axis along z (door on the -z gable)
  k.box(0, 2.3, 0, w, 4.6, d, PAL.stoneWarm, undefined, 0.03);
  // ashlar coursing
  for (let r = 0; r < 9; r++) {
    for (const [x, z, yaw, len] of [[0, -d / 2 - 0.02, 0, w], [0, d / 2 + 0.02, 0, w], [-w / 2 - 0.02, 0, Math.PI / 2, d], [w / 2 + 0.02, 0, Math.PI / 2, d]] as number[][]) {
      k.push(x, 0, z, yaw);
      k.box(0, 0.25 + r * 0.5, 0, len + 0.04, 0.04, 0.02, PAL.stone, undefined, 0.05);
      k.pop();
    }
  }
  // buttresses
  for (const side of [-1, 1]) for (let i = -1; i <= 1; i++) k.box(side * (w / 2 + 0.25), 1.6, i * 3.4, 0.5, 3.2, 0.6, PAL.stone, { roll: side * -0.08 });
  // tall windows down the sides
  for (const side of [-1, 1]) {
    k.push(side * (w / 2), 0, 0, side < 0 ? Math.PI / 2 : -Math.PI / 2);
    wallFace(k, { w: d, h: 4.6, wall: PAL.stoneWarm, timber: null, windows: 3, tall: true, sill: 1.4 });
    k.pop();
  }
  // front: door and a round rose window
  k.push(0, 0, -d / 2, 0);
  wallFace(k, { w, h: 4.6, wall: PAL.stoneWarm, timber: null, windows: 0, door: true });
  k.pop();
  k.target = 'glass';
  k.push(0, 5.4, -d / 2 - 0.02, 0, -Math.PI / 2);
  k.cyl(0, 0, 0, 0.75, 0.75, 0.04, 12, [1, 1, 0.05]);
  k.pop();
  k.target = 'main';
  k.push(0, 5.4, -d / 2 - 0.05, 0, -Math.PI / 2);
  k.cyl(0, 0, 0, 0.9, 0.9, 0.06, 12, PAL.stone, false);
  k.pop();
  // roof: steep slate, ridge along z
  k.push(0, 4.6, 0, Math.PI / 2);
  k.gableRoof(d, w, 0, 3.8, PAL.roofTeal, { gableColor: PAL.stoneWarm, overhang: 0.45 });
  k.pop();
  // bell tower over the door with a spire
  k.push(0, 4.6, -d / 2 + 1.2);
  k.box(0, 1.5, 0, 2.0, 3.0, 2.0, PAL.stoneWarm);
  for (const [x, z] of [[0, -1.01], [0, 1.01], [-1.01, 0], [1.01, 0]]) k.box(x, 2.0, z, Math.abs(x) > 0 ? 0.04 : 0.7, 1.2, Math.abs(z) > 0 ? 0.04 : 0.7, srgb('#2a2630'));
  k.cyl(0, 1.5, 0, 0.35, 0.25, 0.6, 8, PAL.gold);
  k.box(0, 3.05, 0, 2.3, 0.15, 2.3, PAL.stone);
  k.cyl(0, 3.1, 0, 1.15, 0.0, 4.2, 4, PAL.roofTeal, false, Math.PI / 4);
  k.box(0, 7.6, 0, 0.08, 0.9, 0.08, PAL.gold);
  k.box(0, 7.7, 0, 0.5, 0.08, 0.08, PAL.gold);
  k.pop();
  k.pop();
}

export function tower(c: BuildCtx) {
  const k = c.kit;
  const r = 2.6;
  const h = 9;
  // round stone shaft in courses of staggered blocks
  k.cyl(0, -0.4, 0, r + 0.15, r, h + 0.4, 16, PAL.stone);
  for (let row = 0; row < h / 0.55; row++) {
    const y = row * 0.55 + 0.27;
    const n = 14;
    for (let i = 0; i < n; i++) {
      if (k.rnd() < 0.35) continue;
      const a = ((i + (row % 2) * 0.5) / n) * Math.PI * 2;
      // keep the doorway clear
      if (y < 2.7 && Math.abs(Math.cos(a)) < 0.3 && Math.sin(a) < 0) continue;
      k.box(Math.cos(a) * (r + 0.03), y, Math.sin(a) * (r + 0.03), 0.12, 0.42, 0.9, PAL.stoneDark, { yaw: -a }, 0.15);
    }
  }
  // arrow slits and a door
  for (let i = 0; i < 3; i++) {
    const a = i * 2.1 + 0.4;
    k.box(Math.cos(a) * (r + 0.02), 3.5 + i * 1.8, Math.sin(a) * (r + 0.02), 0.06, 0.9, 0.18, srgb('#25212b'), { yaw: -a });
  }
  k.box(0, 1.05, -r - 0.1, 1.1, 2.1, 0.12, PAL.door);
  for (let i = 1; i < 4; i++) k.box(-0.55 + i * 0.275, 1.05, -r - 0.17, 0.025, 2.0, 0.02, PAL.timber);
  for (const y of [0.5, 1.6]) k.box(0, y, -r - 0.18, 1.0, 0.07, 0.02, PAL.iron);
  k.box(0, 2.25, -r - 0.12, 1.5, 0.3, 0.22, PAL.stoneDark);
  for (const sx of [-1, 1]) k.box(sx * 0.68, 1.05, -r - 0.12, 0.26, 2.1, 0.22, PAL.stoneDark);
  // crenellated wooden hoarding and a cone roof
  k.cyl(0, h, 0, r + 0.5, r + 0.5, 0.25, 16, PAL.timber);
  // corbels under the gallery
  for (let i = 0; i < 16; i++) {
    const a = ((i + 0.5) / 16) * Math.PI * 2;
    k.box(Math.cos(a) * (r + 0.2), h - 0.25, Math.sin(a) * (r + 0.2), 0.7, 0.3, 0.2, PAL.timber, { yaw: -a, roll: 0.5 });
  }
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    k.box(Math.cos(a) * (r + 0.45), h + 0.75, Math.sin(a) * (r + 0.45), 0.14, 1.1, 0.14, PAL.timber);
  }
  // plank parapet and rail
  k.cyl(0, h + 0.25, 0, r + 0.46, r + 0.46, 0.6, 16, PAL.timberLight, false);
  k.cyl(0, h + 1.2, 0, r + 0.5, r + 0.5, 0.1, 16, PAL.timber, false);
  // a pennant from the spire
  const ft = h + 1.3 + 4.2 + 0.6;
  k.box(0, ft + 0.5, 0, 0.05, 1.0, 0.05, PAL.iron);
  k.poly2([[0, ft + 0.95, 0], [0, ft + 0.6, 0], [1.3, ft + 0.82, 0.15]], PAL.cloth[0], 0.03);
  k.coneRoof(0, h + 1.3, 0, r + 0.9, 4.2, PAL.roofBlue, 7, 14);
  lamp(k, c, 0.9, 2.2, -r - 0.1);
}

/** Builds the windmill; returns the sail hub in world space (sails are built around the origin). */
export function windmill(c: BuildCtx): Vector3 {
  const k = c.kit;
  // tapered plaster body on a stone base, conical cap, gallery
  k.cyl(0, -0.4, 0, 3.4, 3.2, 1.6, 12, PAL.stoneDark);
  k.cyl(0, 1.2, 0, 3.0, 2.1, 7.4, 12, PAL.plaster);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    k.box(Math.cos(a) * 2.6, 4.9, Math.sin(a) * 2.6, 0.14, 7.4, 0.12, PAL.timber, { yaw: -a, roll: 0.122 });
  }
  k.cyl(0, 4.4, 0, 3.0, 3.0, 0.14, 14, PAL.timber);
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    k.box(Math.cos(a) * 2.95, 4.85, Math.sin(a) * 2.95, 0.06, 0.8, 0.06, PAL.timber);
  }
  k.cyl(0, 5.25, 0, 3.0, 3.0, 0.08, 20, PAL.timber, false);
  k.box(0, 0.75, -3.36, 1.0, 1.5, 0.1, PAL.door);
  k.box(0, 1.58, -3.38, 1.4, 0.18, 0.16, PAL.stoneDark);
  for (const s of [-1, 1]) k.box(s * 0.6, 0.75, -3.38, 0.18, 1.5, 0.16, PAL.stoneDark);
  k.pane(0, 6.6, -2.33, 0.6, 0.8, 0.05);
  k.coneRoof(0, 8.5, 0, 2.6, 3.0, PAL.roofRed, 5, 12);
  // sails: built around the hub, rotated as one mesh at runtime
  k.box(0, 8.0, -2.4, 0.5, 0.5, 1.2, PAL.timber);
  const hub = k.world(0, 8.0, -3.1);
  k.target = 'sails';
  k.isolate(() => {
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      k.push(0, 0, 0, 0, 0, a);
      k.box(0, 3.4, 0, 0.18, 7.0, 0.14, PAL.timber);
      for (let j = 0; j < 6; j++) k.box(0.5, 1.4 + j * 0.9, -0.02, 1.0, 0.06, 0.06, PAL.timber);
      k.box(0.55, 4.0, 0.02, 0.95, 5.2, 0.03, PAL.cloth[1], undefined, 0.02);
      k.box(-0.2, 4.0, 0, 0.06, 5.4, 0.06, PAL.timber);
      k.pop();
    }
    k.box(0, 0, 0, 0.6, 0.6, 0.3, PAL.iron);
  });
  k.target = 'main';
  return hub;
}

export function well(c: BuildCtx) {
  const k = c.kit;
  // round stone ring, water inside, a little roof on two posts
  k.cyl(0, -0.3, 0, 1.25, 1.25, 1.2, 14, PAL.stone);
  for (let i = 0; i < 14; i++) {
    const a = ((i + 0.5) / 14) * Math.PI * 2;
    k.box(Math.cos(a) * 1.22, 0.92, Math.sin(a) * 1.22, 0.52, 0.2, 0.3, PAL.stoneDark, { yaw: -a + Math.PI / 2 }, 0.12);
  }
  k.cyl(0, 0.6, 0, 1.0, 1.0, 0.05, 14, srgb('#2b5f74'));
  for (const s of [-1, 1]) k.box(s * 1.1, 1.6, 0, 0.18, 2.4, 0.18, PAL.timber);
  k.box(0, 2.1, 0, 2.4, 0.14, 0.14, PAL.timber);
  k.cyl(0, 2.0, 0, 0.04, 0.04, 0.1, 6, PAL.iron);
  k.box(0, 1.55, 0, 0.32, 0.32, 0.32, PAL.timberLight);
  k.push(0, 2.75, 0, Math.PI / 2);
  k.gableRoof(1.2, 2.6, 0, 0.9, PAL.roofRed, { overhang: 0.25, rows: 3, gableColor: PAL.timberLight });
  k.pop();
}

export function stage(c: BuildCtx) {
  const k = c.kit;
  k.box(0, 0.4, 0, 6, 0.8, 4, PAL.timberLight);
  for (let i = 0; i < 12; i++) k.box(-3 + (i + 0.5) * 0.5, 0.81, 0, 0.47, 0.03, 4, PAL.timberLight, undefined, 0.1);
  k.box(0, 0.25, -2.4, 1.6, 0.25, 0.8, PAL.timber);
  for (const x of [-2.9, 2.9]) for (const z of [-1.9, 1.9]) k.box(x, 2.0, z, 0.16, 2.6, 0.16, PAL.timber);
  // bunting around the top
  const pts: [number, number][] = [[-2.9, -1.9], [2.9, -1.9], [2.9, 1.9], [-2.9, 1.9], [-2.9, -1.9]];
  for (let s = 0; s < 4; s++) bunting(k, new Vector3(pts[s][0], 3.25, pts[s][1]), new Vector3(pts[s + 1][0], 3.25, pts[s + 1][1]), 0.25);
}

/** A string of triangular pennants hanging between two points (in the current frame). */
export function bunting(k: Kit, a: Vector3, b: Vector3, sag: number) {
  const len = Vector3.Distance(a, b);
  const n = Math.max(3, Math.round(len / 0.55));
  const yaw = Math.atan2(b.x - a.x, b.z - a.z);
  const at = (t: number) => {
    const p = Vector3.Lerp(a, b, t);
    p.y -= Math.sin(t * Math.PI) * sag;
    return p;
  };
  for (let i = 0; i < n; i++) {
    const p0 = at(i / n);
    const p1 = at((i + 1) / n);
    const mid = Vector3.Lerp(p0, p1, 0.5);
    k.box(mid.x, mid.y, mid.z, 0.02, 0.02, Vector3.Distance(p0, p1), PAL.timber, { yaw, pitch: Math.atan2(p0.y - p1.y, Vector3.Distance(p0, p1)) });
    const q0 = at((i + 0.15) / n);
    const q1 = at((i + 0.85) / n);
    const tip = Vector3.Lerp(q0, q1, 0.5);
    tip.y -= 0.38;
    k.poly2([[q0.x, q0.y, q0.z], [q1.x, q1.y, q1.z], [tip.x, tip.y, tip.z]], PAL.cloth[i % PAL.cloth.length], 0.04);
  }
}

/** A tall lantern post. */
export function lanternPost(k: Kit, c: BuildCtx) {
  k.box(0, 0.15, 0, 0.5, 0.3, 0.5, PAL.stone);
  k.box(0, 1.6, 0, 0.14, 3.0, 0.14, PAL.timber);
  k.box(0.35, 2.95, 0, 0.8, 0.08, 0.08, PAL.timber);
  k.box(0.22, 2.75, 0, 0.06, 0.4, 0.06, PAL.timber, { roll: 0.8 });
  const lx = 0.62;
  k.box(lx, 2.82, 0, 0.03, 0.18, 0.03, PAL.iron);
  k.box(lx, 2.66, 0, 0.32, 0.06, 0.32, PAL.iron);
  k.box(lx, 2.2, 0, 0.26, 0.05, 0.26, PAL.iron);
  for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) k.box(lx + dx * 0.12, 2.43, dz * 0.12, 0.03, 0.44, 0.03, PAL.iron);
  k.pane(lx, 2.43, 0, 0.21, 0.4, 0.21, 0);
  c.lamps.push(k.world(lx, 2.43, 0));
}

/** A short run of picket fence from (0,0,0) along +x. */
export function fence(k: Kit, len: number) {
  const n = Math.round(len / 0.32);
  for (const y of [0.35, 0.75]) k.box(len / 2, y, 0, len, 0.08, 0.05, PAL.timberLight);
  for (let i = 0; i <= n; i++) {
    const x = (i / n) * len;
    k.box(x, 0.45, -0.04, 0.1, 0.9 + (i % 2) * 0.08, 0.04, i % 4 === 0 ? PAL.timber : PAL.plaster, undefined, 0.05);
  }
}
