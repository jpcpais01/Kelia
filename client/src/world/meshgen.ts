// Tiny procedural mesh toolkit for stylized trees, bushes and rocks.
import { VertexData } from '@babylonjs/core';
import { Simplex2 } from '@kelia/shared';

export class MeshBuilder2 {
  positions: number[] = [];
  normals: number[] = [];
  colors: number[] = [];
  indices: number[] = [];

  get vertexCount() {
    return this.positions.length / 3;
  }

  toVertexData(): VertexData {
    const vd = new VertexData();
    vd.positions = this.positions;
    vd.normals = this.normals;
    vd.colors = this.colors;
    vd.indices = this.indices;
    return vd;
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
  rock(center: [number, number, number], radius: [number, number, number], noise: Simplex2, seed: number, base: [number, number, number], moss: [number, number, number]) {
    const ico = icosphere(1);
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

function cross(a: number[], b: number[]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(a: number[]): [number, number, number] {
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
  let faces = [
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
