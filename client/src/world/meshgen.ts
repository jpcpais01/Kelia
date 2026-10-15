// Tiny procedural mesh toolkit for stylized trees, bushes and rocks.
import { VertexData } from '@babylonjs/core';
import { Simplex2 } from '@kelia/shared';
import { cellUV, type AtlasCell } from './leafAtlas';

/** Vertex kind holding the camera-space corner offset of billboard leaf cards. */
export const CARD_CORNER_KIND = 'cardCorner';

export class MeshBuilder2 {
  positions: number[] = [];
  normals: number[] = [];
  colors: number[] = [];
  indices: number[] = [];
  /** Atlas UVs (vertices added without one sample the opaque bark cell). */
  uvs: number[] = [];
  /** Billboard corner offsets in metres (0 for ordinary geometry). */
  corners: number[] = [];
  private hasCards = false;

  get vertexCount() {
    return this.positions.length / 3;
  }

  /** Give every vertex added so far without UVs the default (opaque) UV and no card offset. */
  private pad() {
    const n = this.vertexCount;
    if (this.uvs.length / 2 < n) {
      const [u, v] = cellUV('solid', 0.5, 0.5);
      while (this.uvs.length / 2 < n) this.uvs.push(u, v);
    }
    while (this.corners.length / 2 < n) this.corners.push(0, 0);
  }

  toVertexData(): VertexData {
    this.pad();
    const vd = new VertexData();
    vd.positions = this.positions;
    vd.normals = this.normals;
    vd.colors = this.colors;
    vd.indices = this.indices;
    vd.uvs = this.uvs;
    return vd;
  }

  /** Billboard corner offsets for the mesh (null when there are no cards). */
  cornerData(): Float32Array | null {
    this.pad();
    return this.hasCards ? new Float32Array(this.corners) : null;
  }

  /**
   * One camera-facing leaf card centred on `center`. The vertex shader turns
   * it to face the camera; `normal` is the shading normal (usually pointing
   * away from the canopy centre, so a whole crown shades like one soft ball).
   */
  card(center: number[], size: number, normal: number[], color: number[], sway: number, cell: AtlasCell, rot: number) {
    this.pad();
    this.hasCards = true;
    const start = this.vertexCount;
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const h = size * 0.5;
    const n = normalize(normal);
    for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      this.positions.push(center[0], center[1], center[2]);
      this.normals.push(n[0], n[1], n[2]);
      this.colors.push(color[0], color[1], color[2], sway);
      const [u, v] = cellUV(cell, (cx + 1) / 2, (1 - cy) / 2);
      this.uvs.push(u, v);
      this.corners.push((cx * c - cy * s) * h, (cx * s + cy * c) * h);
    }
    this.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }

  /**
   * A smooth tapered tube through a polyline: curved trunks, limbs and twigs.
   * Frames are parallel-transported along the curve so the tube never twists,
   * and the bark UVs mirror-repeat so there is no seam around or along it.
   * Per point: radius and sway weight; `colorAt` can tint each ring.
   */
  tube(
    pts: number[][],
    radii: number[],
    sways: number[],
    segs: number,
    color: number[],
    o: {
      shade?: [number, number];
      /** Bark texture repeats per metre along the tube (default: from its girth, so the bark keeps its proportions). */
      bark?: number;
      /** Bark texture repeats around the tube. */
      around?: number;
      cell?: AtlasCell;
      colorAt?: (i: number) => number[];
      /** Per-vertex blend (0..1) toward `tintColor`: moss, lichen, wet bark. */
      tint?: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => number;
      tintColor?: number[];
    } = {},
  ) {
    const n = pts.length;
    if (n < 2) return;
    this.pad();
    const start = this.vertexCount;
    const [s0, s1] = o.shade ?? [0.72, 1];
    const around = o.around ?? 1;
    const meanR = radii.reduce((a, r) => a + r, 0) / n;
    // one texture height per half circumference / `around`, so plates and furrows stay in proportion
    const barkK = o.bark ?? Math.min(4, Math.max(0.3, around / (Math.PI * Math.max(meanR, 0.02))));
    const cell = o.cell ?? 'barkOak';
    const tc = o.tintColor ?? [1, 1, 1];
    const tan = (i: number) => {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      return normalize([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    };
    let T = tan(0);
    let u = normalize(cross(Math.abs(T[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0], T));
    let len = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        T = tan(i);
        const d = u[0] * T[0] + u[1] * T[1] + u[2] * T[2];
        u = normalize([u[0] - T[0] * d, u[1] - T[1] * d, u[2] - T[2] * d]);
        len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
      }
      const v = cross(T, u);
      const t = i / (n - 1);
      const shade = s0 + (s1 - s0) * t;
      const col = o.colorAt ? o.colorAt(i) : color;
      const f = (len * barkK) % 2;
      const bv = f < 1 ? f : 2 - f;
      for (let k = 0; k < segs; k++) {
        const a = (k / segs) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const nx = u[0] * ca + v[0] * sa;
        const ny = u[1] * ca + v[1] * sa;
        const nz = u[2] * ca + v[2] * sa;
        const r = radii[i];
        const px = pts[i][0] + nx * r;
        const py = pts[i][1] + ny * r;
        const pz = pts[i][2] + nz * r;
        this.positions.push(px, py, pz);
        this.normals.push(nx, ny, nz);
        const m = o.tint ? Math.min(1, Math.max(0, o.tint(px, py, pz, nx, ny, nz))) : 0;
        this.colors.push(
          (col[0] + (tc[0] - col[0]) * m) * shade,
          (col[1] + (tc[1] - col[1]) * m) * shade,
          (col[2] + (tc[2] - col[2]) * m) * shade,
          sways[i],
        );
        const ua = ((k / segs) * around * 2) % 2;
        const [bu, bvv] = cellUV(cell, ua < 1 ? ua : 2 - ua, bv);
        this.uvs.push(bu, bvv);
        this.corners.push(0, 0);
      }
    }
    for (let r = 0; r < n - 1; r++) {
      for (let k = 0; k < segs; k++) {
        const a = start + r * segs + k;
        const b = start + r * segs + ((k + 1) % segs);
        const c = a + segs;
        const d = b + segs;
        this.indices.push(a, c, b, b, c, d);
      }
    }
  }

  /** Tapered, slightly bent cylinder from `base` along `dir`. a = sway weight. */
  branch(
    base: [number, number, number],
    dir: [number, number, number],
    length: number,
    r0: number,
    r1: number,
    segs: number,
    rings: number,
    color: [number, number, number],
    sway0 = 0,
    sway1 = 0.15,
  ) {
    const [dx, dy, dz] = normalize(dir);
    // basis perpendicular to dir
    const up: [number, number, number] = Math.abs(dy) < 0.95 ? [0, 1, 0] : [1, 0, 0];
    const u = normalize(cross(up, [dx, dy, dz]));
    const v = cross([dx, dy, dz], u);
    this.pad();
    const start = this.vertexCount;
    for (let r = 0; r <= rings; r++) {
      const t = r / rings;
      const rad = r0 + (r1 - r0) * t;
      const cx = base[0] + dx * length * t;
      const cy = base[1] + dy * length * t;
      const cz = base[2] + dz * length * t;
      const shade = 0.75 + 0.25 * t;
      for (let s = 0; s < segs; s++) {
        const a = (s / segs) * Math.PI * 2;
        const nx = u[0] * Math.cos(a) + v[0] * Math.sin(a);
        const ny = u[1] * Math.cos(a) + v[1] * Math.sin(a);
        const nz = u[2] * Math.cos(a) + v[2] * Math.sin(a);
        this.positions.push(cx + nx * rad, cy + ny * rad, cz + nz * rad);
        this.normals.push(nx, ny, nz);
        this.colors.push(color[0] * shade, color[1] * shade, color[2] * shade, sway0 + (sway1 - sway0) * t);
        const [bu, bv] = cellUV('barkOak', s / segs, (t * length * 0.35) % 1);
        this.uvs.push(bu, bv);
        this.corners.push(0, 0);
      }
    }
    for (let r = 0; r < rings; r++) {
      for (let s = 0; s < segs; s++) {
        const a = start + r * segs + s;
        const b = start + r * segs + ((s + 1) % segs);
        const c = a + segs;
        const d = b + segs;
        this.indices.push(a, c, b, b, c, d);
      }
    }
  }

  /**
   * A chunky, faceted boulder: an icosphere cut by random planes, so it has a
   * few big flat faces and crisp edges (the stylized-rock look) instead of
   * noisy facets. Faces pointing up get a clean cap of moss.
   */
  boulder(
    center: number[],
    radius: number[],
    seed: number,
    stone: number[],
    stoneDark: number[],
    moss: number[],
    o: { cuts?: number; subdiv?: number; mossLine?: number; sway?: number } = {},
  ) {
    this.pad();
    const r = mulberry(seed * 7919 + 17);
    const ico = icosphere(o.subdiv ?? 2);
    const planes: number[][] = [];
    const cuts = o.cuts ?? 9;
    for (let i = 0; i < cuts; i++) {
      // a flat-ish top, steep sides and one or two slanted faces
      let n: number[];
      if (i === 0) n = [(r() - 0.5) * 0.5, 1, (r() - 0.5) * 0.5];
      else {
        const a = r() * Math.PI * 2;
        const y = (r() - 0.35) * 1.1;
        n = [Math.cos(a), y, Math.sin(a)];
      }
      n = normalize(n);
      planes.push([n[0], n[1], n[2], i === 0 ? 0.55 + r() * 0.2 : 0.6 + r() * 0.28]);
    }
    const pts: number[] = [];
    for (let i = 0; i < ico.positions.length; i += 3) {
      let x = ico.positions[i];
      let y = ico.positions[i + 1];
      let z = ico.positions[i + 2];
      for (const p of planes) {
        const d = x * p[0] + y * p[1] + z * p[2];
        if (d > p[3]) {
          x -= p[0] * (d - p[3]);
          y -= p[1] * (d - p[3]);
          z -= p[2] * (d - p[3]);
        }
      }
      if (y < -0.35) y = -0.35 + (y + 0.35) * 0.3; // sit flat on the ground
      pts.push(center[0] + x * radius[0], center[1] + y * radius[1], center[2] + z * radius[2]);
    }
    const mossLine = o.mossLine ?? 0.72;
    const sway = o.sway ?? 0;
    const minY = center[1] - radius[1] * 0.35;
    const spanY = radius[1] * 1.35;
    for (let i = 0; i < ico.indices.length; i += 3) {
      const ia = ico.indices[i] * 3;
      const ib = ico.indices[i + 1] * 3;
      const ic = ico.indices[i + 2] * 3;
      const a = [pts[ia], pts[ia + 1], pts[ia + 2]];
      const b = [pts[ib], pts[ib + 1], pts[ib + 2]];
      const c = [pts[ic], pts[ic + 1], pts[ic + 2]];
      const n = normalize(cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]));
      const nx = n[0];
      const ny = n[1];
      const nz = n[2];
      const cy = (a[1] + b[1] + c[1]) / 3;
      const hgt = Math.min(1, Math.max(0, (cy - minY) / spanY));
      // facets keyed by their direction, so a whole cut face shares one tone
      const facet = (0.84 + 0.22 * ny) * (0.86 + 0.28 * fract(Math.sin(Math.round(nx * 4) * 12.9898 + Math.round(ny * 4) * 78.233 + Math.round(nz * 4) * 37.719) * 43758.5453));
      const col = [0, 0, 0];
      for (let k = 0; k < 3; k++) col[k] = (stoneDark[k] + (stone[k] - stoneDark[k]) * (0.35 + 0.65 * hgt)) * facet;
      const m = Math.min(1, Math.max(0, (ny - mossLine) * 6));
      for (let k = 0; k < 3; k++) col[k] += (moss[k] * (0.92 + 0.16 * facet) - col[k]) * m;
      const start = this.vertexCount;
      for (const p of [a, b, c]) {
        this.positions.push(p[0], p[1], p[2]);
        this.normals.push(nx, ny, nz);
        this.colors.push(col[0], col[1], col[2], sway);
      }
      this.indices.push(start, start + 1, start + 2);
    }
  }

  /**
   * A puffy foliage clump: icosphere displaced by noise. Normals point away from
   * `normalCenter` (the canopy centre) which gives the soft, painterly shading
   * stylized trees are known for.
   */
  blob(
    center: [number, number, number],
    radius: [number, number, number],
    subdiv: number,
    noise: Simplex2,
    noiseAmp: number,
    colorBottom: [number, number, number],
    colorTop: [number, number, number],
    normalCenter: [number, number, number],
    sway: number,
    flatBottom = 0.35,
  ) {
    const ico = icosphere(subdiv);
    const start = this.vertexCount;
    for (let i = 0; i < ico.positions.length; i += 3) {
      let x = ico.positions[i];
      let y = ico.positions[i + 1];
      let z = ico.positions[i + 2];
      const n = noise.noise(x * 1.3 + center[0], z * 1.3 + y * 1.1 + center[2]) * noiseAmp * 0.55;
      x *= 1 + n;
      z *= 1 + n;
      y *= 1 + n * 0.6;
      if (y < -flatBottom) y = -flatBottom + (y + flatBottom) * 0.3;
      const px = center[0] + x * radius[0];
      const py = center[1] + y * radius[1];
      const pz = center[2] + z * radius[2];
      this.positions.push(px, py, pz);
      let nx = px - normalCenter[0];
      let ny = (py - normalCenter[1]) * 1.2 + 0.3;
      let nz = pz - normalCenter[2];
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      this.normals.push(nx, ny, nz);
      const t = Math.min(1, Math.max(0, (y + 1) / 2));
      const jitter = 0.92 + 0.16 * (noise.noise(px * 3.1, pz * 3.1 + py) * 0.5 + 0.5);
      this.colors.push(
        (colorBottom[0] + (colorTop[0] - colorBottom[0]) * t) * jitter,
        (colorBottom[1] + (colorTop[1] - colorBottom[1]) * t) * jitter,
        (colorBottom[2] + (colorTop[2] - colorBottom[2]) * t) * jitter,
        sway,
      );
    }
    for (const idx of ico.indices) this.indices.push(start + idx);
  }

  /** Stacked jagged cone layer for pines. */
  cone(
    baseY: number,
    height: number,
    radius: number,
    segs: number,
    color: [number, number, number],
    tipColor: [number, number, number],
    sway: number,
    jag: number,
    seed: number,
  ) {
    const start = this.vertexCount;
    // ring
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2 + seed;
      const r = radius * (1 + (s % 2 === 0 ? jag : -jag * 0.6));
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      this.positions.push(x, baseY - height * 0.08 * (s % 2), z);
      const nl = Math.hypot(x, height * 0.6, z);
      this.normals.push(x / nl, (height * 0.6) / nl, z / nl);
      this.colors.push(color[0], color[1], color[2], sway);
    }
    // tip
    this.positions.push(0, baseY + height, 0);
    this.normals.push(0, 1, 0);
    this.colors.push(tipColor[0], tipColor[1], tipColor[2], sway * 1.3);
    const tip = this.vertexCount - 1;
    // underside centre
    this.positions.push(0, baseY + height * 0.05, 0);
    this.normals.push(0, -1, 0);
    this.colors.push(color[0] * 0.5, color[1] * 0.5, color[2] * 0.5, sway);
    const under = this.vertexCount - 1;
    for (let s = 0; s < segs; s++) {
      const a = start + s;
      const b = start + ((s + 1) % segs);
      this.indices.push(a, tip, b);
      this.indices.push(a, b, under);
    }
  }

  /** Faceted rock: displaced icosphere with flat shading and mossy tops. */
  rock(center: [number, number, number], radius: [number, number, number], noise: Simplex2, seed: number, base: [number, number, number], moss: [number, number, number], subdiv = 1) {
    const ico = icosphere(subdiv);
    const pts: number[] = [];
    for (let i = 0; i < ico.positions.length; i += 3) {
      const x = ico.positions[i];
      const y = ico.positions[i + 1];
      const z = ico.positions[i + 2];
      const n = 1 + noise.noise(x * 1.7 + seed, z * 1.7 + y * 1.3 - seed) * 0.28;
      let yy = y * n;
      if (yy < -0.2) yy = -0.2 + (yy + 0.2) * 0.4;
      pts.push(center[0] + x * n * radius[0], center[1] + yy * radius[1], center[2] + z * n * radius[2]);
    }
    for (let i = 0; i < ico.indices.length; i += 3) {
      const ia = ico.indices[i] * 3;
      const ib = ico.indices[i + 1] * 3;
      const ic = ico.indices[i + 2] * 3;
      const a = [pts[ia], pts[ia + 1], pts[ia + 2]];
      const b = [pts[ib], pts[ib + 1], pts[ib + 2]];
      const c = [pts[ic], pts[ic + 1], pts[ic + 2]];
      const n = normalize(cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]));
      const mossy = Math.max(0, Math.min(1, (n[1] - 0.55) * 3));
      const shade = 0.85 + 0.3 * (noise.noise(a[0] * 0.9 + seed, a[2] * 0.9) * 0.5 + 0.5);
      const col: [number, number, number] = [
        (base[0] + (moss[0] - base[0]) * mossy) * shade,
        (base[1] + (moss[1] - base[1]) * mossy) * shade,
        (base[2] + (moss[2] - base[2]) * mossy) * shade,
      ];
      const start = this.vertexCount;
      for (const p of [a, b, c]) {
        this.positions.push(p[0], p[1], p[2]);
        this.normals.push(-n[0], -n[1], -n[2]);
        this.colors.push(col[0], col[1], col[2], 0);
      }
      this.indices.push(start, start + 1, start + 2);
    }
  }
}

function fract(x: number) {
  return x - Math.floor(x);
}

export function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cross(a: number[], b: number[]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function normalize(a: number[]): [number, number, number] {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

const icoCache = new Map<number, { positions: number[]; indices: number[] }>();
export function icosphere(subdiv: number) {
  const cached = icoCache.get(subdiv);
  if (cached) return cached;
  const t = (1 + Math.sqrt(5)) / 2;
  let verts: number[][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((v) => normalize(v));
  // subdiv < 0: an octahedron (8 faces), for blobs only a few pixels wide
  if (subdiv < 0) {
    verts = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  }
  let faces = subdiv < 0 ? [[2, 4, 0], [2, 1, 4], [2, 5, 1], [2, 0, 5], [3, 0, 4], [3, 4, 1], [3, 1, 5], [3, 5, 0]] : [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let s = 0; s < subdiv; s++) {
    const mid = new Map<string, number>();
    const getMid = (a: number, b: number) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      let idx = mid.get(key);
      if (idx === undefined) {
        const va = verts[a];
        const vb = verts[b];
        verts.push(normalize([(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2]));
        idx = verts.length - 1;
        mid.set(key, idx);
      }
      return idx;
    };
    const next: number[][] = [];
    for (const [a, b, c] of faces) {
      const ab = getMid(a, b);
      const bc = getMid(b, c);
      const ca = getMid(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  verts = verts.map((v) => v);
  const res = { positions: verts.flat(), indices: faces.flat() };
  icoCache.set(subdiv, res);
  return res;
}
