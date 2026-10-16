// A small modelling kit for building the hero in code: lofted cross-sections
// (superellipse rings with separate front and back depth, so a torso can have
// a chest and a back), ellipsoids, and tapered ribbons for hair, all skinned
// to named bones and coloured by atlas swatches. Parts are closed shells;
// their winding is fixed by signed volume and their normals are smoothed
// across seams (coincident vertices), so colour bands never crease the
// shading.
import { Vector3 } from '@babylonjs/core';

/** Bone influences: [bone name, weight]. */
export type Weights = [string, number][];

export interface Ring {
  /** Centre. */
  c: Vector3;
  /** Unit axes: side (+x of the section) and front (+z of the section). */
  x: Vector3;
  z: Vector3;
  /** Half width (along x), front depth (along +z), back depth (along -z). */
  a: number;
  f: number;
  b: number;
  /** Superellipse exponent: 2 = ellipse, higher = boxier. */
  n?: number;
  /** Optional radial multiplier by angle (0 = +x, π/2 = front). */
  r?: (t: number) => number;
  w: Weights | ((p: Vector3, t: number) => Weights);
  uv: [number, number] | ((t: number, p: Vector3) => [number, number]);
}

export interface LoftOpts {
  segs?: number;
  /** Close the ends with a rounded cap (distance the cap pole sticks out). */
  capStart?: number;
  capEnd?: number;
  /** Angle where the ring starts (rotates the seam). */
  t0?: number;
}

const sgnpow = (v: number, e: number) => Math.sign(v) * Math.pow(Math.abs(v), e);

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Blend two bone sets: t = 0 all `a`, 1 all `b`. */
export function blend(a: Weights, b: Weights, t: number): Weights {
  const out: Weights = [];
  for (const [n, w] of a) out.push([n, w * (1 - t)]);
  for (const [n, w] of b) {
    const e = out.find((o) => o[0] === n);
    if (e) e[1] += w * t;
    else out.push([n, w * t]);
  }
  return out.filter((o) => o[1] > 1e-4);
}

export const one = (bone: string): Weights => [[bone, 1]];

export class Geo {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  wts: Weights[] = [];
  /** Normals to keep as given (custom-shaded parts) instead of smoothing. */
  private fixed = new Set<number>();
  private partV = 0;
  private partI = 0;

  get vertexCount() {
    return this.pos.length / 3;
  }

  vert(p: Vector3, uv: [number, number], w: Weights): number {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(0, 0, 0);
    this.uv.push(uv[0], uv[1]);
    this.wts.push(w);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, a, c, d);
  }

  /** Start a new part (a closed shell that gets its own winding fix and normals). */
  begin() {
    this.partV = this.vertexCount;
    this.partI = this.idx.length;
  }

  /**
   * Finish the current part: make its triangles face outwards (positive
   * volume) and give it smooth normals, welded across coincident vertices.
   */
  end(opts: { flip?: boolean; keepNormals?: boolean } = {}) {
    const p = this.pos;
    const I = this.idx;
    let vol = 0;
    for (let t = this.partI; t < I.length; t += 3) {
      const a = I[t] * 3;
      const b = I[t + 1] * 3;
      const c = I[t + 2] * 3;
      vol +=
        p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
        p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
        p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
    if ((vol < 0) !== !!opts.flip) {
      for (let t = this.partI; t < I.length; t += 3) {
        const s = I[t + 1];
        I[t + 1] = I[t + 2];
        I[t + 2] = s;
      }
    }
    if (!opts.keepNormals) this.smoothNormals(this.partV, this.partI);
    this.begin();
  }

  private smoothNormals(v0: number, i0: number) {
    const p = this.pos;
    const I = this.idx;
    const key = (i: number) => `${Math.round(p[i * 3] * 4000)},${Math.round(p[i * 3 + 1] * 4000)},${Math.round(p[i * 3 + 2] * 4000)}`;
    const acc = new Map<string, [number, number, number]>();
    for (let t = i0; t < I.length; t += 3) {
      const a = I[t];
      const b = I[t + 1];
      const c = I[t + 2];
      const ux = p[b * 3] - p[a * 3];
      const uy = p[b * 3 + 1] - p[a * 3 + 1];
      const uz = p[b * 3 + 2] - p[a * 3 + 2];
      const vx = p[c * 3] - p[a * 3];
      const vy = p[c * 3 + 1] - p[a * 3 + 1];
      const vz = p[c * 3 + 2] - p[a * 3 + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      for (const v of [a, b, c]) {
        const k = key(v);
        const s = acc.get(k);
        if (s) {
          s[0] += nx;
          s[1] += ny;
          s[2] += nz;
        } else acc.set(k, [nx, ny, nz]);
      }
    }
    const n = this.nrm;
    for (let v = v0; v < this.vertexCount; v++) {
      if (this.fixed.has(v)) continue;
      const s = acc.get(key(v));
      if (!s) continue;
      const l = Math.hypot(s[0], s[1], s[2]) || 1;
      n[v * 3] = s[0] / l;
      n[v * 3 + 1] = s[1] / l;
      n[v * 3 + 2] = s[2] / l;
    }
  }

  /** Bend the normals of vertices [from, count) toward `dir(p)` by `k(p)` (anime face shading). */
  bendNormals(from: number, dir: (p: Vector3) => Vector3, k: (p: Vector3) => number) {
    const p = new Vector3();
    for (let v = from; v < this.vertexCount; v++) {
      p.set(this.pos[v * 3], this.pos[v * 3 + 1], this.pos[v * 3 + 2]);
      const t = k(p);
      if (t <= 0) continue;
      const d = dir(p);
      const nx = lerp(this.nrm[v * 3], d.x, t);
      const ny = lerp(this.nrm[v * 3 + 1], d.y, t);
      const nz = lerp(this.nrm[v * 3 + 2], d.z, t);
      const l = Math.hypot(nx, ny, nz) || 1;
      this.nrm[v * 3] = nx / l;
      this.nrm[v * 3 + 1] = ny / l;
      this.nrm[v * 3 + 2] = nz / l;
    }
  }

  /** Point on a ring at angle t. */
  static ringPoint(r: Ring, t: number, out = new Vector3()) {
    const e = 2 / (r.n ?? 2);
    const c = Math.cos(t);
    const s = Math.sin(t);
    const m = r.r ? r.r(t) : 1;
    const dx = sgnpow(c, e) * r.a * m;
    const dz = sgnpow(s, e) * (s > 0 ? r.f : r.b) * m;
    out.set(r.c.x + r.x.x * dx + r.z.x * dz, r.c.y + r.x.y * dx + r.z.y * dz, r.c.z + r.x.z * dx + r.z.z * dz);
    return out;
  }

  /** A closed loft through `rings` (one part). */
  loft(rings: Ring[], o: LoftOpts = {}) {
    this.begin();
    const segs = o.segs ?? 24;
    const t0 = o.t0 ?? 0;
    const ids: number[][] = [];
    const p = new Vector3();
    for (const r of rings) {
      const row: number[] = [];
      for (let s = 0; s < segs; s++) {
        const t = t0 + (s / segs) * Math.PI * 2;
        Geo.ringPoint(r, t, p);
        const uv = typeof r.uv === 'function' ? r.uv(t, p) : r.uv;
        const w = typeof r.w === 'function' ? r.w(p, t) : r.w;
        row.push(this.vert(p, uv, w));
      }
      ids.push(row);
    }
    for (let i = 0; i + 1 < ids.length; i++) {
      const A = ids[i];
      const B = ids[i + 1];
      for (let s = 0; s < segs; s++) {
        const s1 = (s + 1) % segs;
        this.quad(A[s], A[s1], B[s1], B[s]);
      }
    }
    const cap = (r: Ring, row: number[], out: number, prev: Ring, rev: boolean) => {
      const q = (a: number, b: number, c: number, d: number) => (rev ? this.quad(d, c, b, a) : this.quad(a, b, c, d));
      const axis = r.c.subtract(prev.c);
      if (axis.lengthSquared() < 1e-12) axis.copyFrom(Vector3.Cross(r.x, r.z));
      axis.normalize();
      // two shrinking rings and a pole: a rounded end
      let last = row;
      for (const [k, d] of [[0.72, 0.55], [0.38, 0.88]] as const) {
        const rr: Ring = { ...r, c: r.c.add(axis.scale(out * d)), a: r.a * k, f: r.f * k, b: r.b * k };
        const nrow: number[] = [];
        for (let s = 0; s < segs; s++) {
          const t = t0 + (s / segs) * Math.PI * 2;
          Geo.ringPoint(rr, t, p);
          const uv = typeof r.uv === 'function' ? r.uv(t, p) : r.uv;
          const w = typeof r.w === 'function' ? r.w(p, t) : r.w;
          nrow.push(this.vert(p, uv, w));
        }
        for (let s = 0; s < segs; s++) {
          const s1 = (s + 1) % segs;
          q(last[s], last[s1], nrow[s1], nrow[s]);
        }
        last = nrow;
      }
      const pole = r.c.add(axis.scale(out));
      const uv = typeof r.uv === 'function' ? r.uv(0, pole) : r.uv;
      const w = typeof r.w === 'function' ? r.w(pole, 0) : r.w;
      const c = this.vert(pole, uv, w);
      for (let s = 0; s < segs; s++) {
        if (rev) this.tri(c, last[(s + 1) % segs], last[s]);
        else this.tri(last[s], last[(s + 1) % segs], c);
      }
    };
    if (rings.length > 1) {
      if (o.capStart !== undefined) cap(rings[0], ids[0], o.capStart, rings[1], true);
      if (o.capEnd !== undefined) cap(rings[rings.length - 1], ids[ids.length - 1], o.capEnd, rings[rings.length - 2], false);
    }
    this.end();
    return ids;
  }

  /**
   * A tube along a path of points (Catmull-Rom smoothed), with a width and
   * thickness profile: hair locks, braids, straps, trims. `up(i)` gives the
   * direction the flat side faces at each sample.
   */
  ribbon(
    pts: Vector3[],
    o: {
      samples?: number;
      segs?: number;
      width: (s: number) => number;
      thick: (s: number) => number;
      /** Face direction of the ribbon (its thin axis) at s. */
      normal: (s: number, p: Vector3, tangent: Vector3) => Vector3;
      w: (s: number, p: Vector3) => Weights;
      uv: (s: number) => [number, number];
      /** Exponent of the cross-section (2 = lens/ellipse, bigger = flatter edges). */
      n?: number;
      /** Bend the section into a curve (positive = edges curl toward the normal), metres. */
      cup?: (s: number) => number;
      tipPoint?: boolean;
    },
  ) {
    const curve = catmull(pts, o.samples ?? 10);
    const rings: (Ring & { cupK?: number })[] = [];
    for (let i = 0; i < curve.length; i++) {
      const s = i / (curve.length - 1);
      const p = curve[i];
      const tan = curve[Math.min(curve.length - 1, i + 1)].subtract(curve[Math.max(0, i - 1)]).normalize();
      let nz = o.normal(s, p, tan);
      nz = nz.subtract(tan.scale(Vector3.Dot(nz, tan)));
      if (nz.lengthSquared() < 1e-8) nz = Vector3.Cross(tan, Vector3.Right());
      nz.normalize();
      const nx = Vector3.Cross(nz, tan).normalize();
      const cup = o.cup ? o.cup(s) : 0;
      const wd = Math.max(1e-4, o.width(s));
      const th = Math.max(1e-4, o.thick(s));
      const ring: Ring & { cupK?: number } = { c: p, x: nx, z: nz, a: wd, f: th, b: th, n: o.n ?? 2, w: o.w(s, p), uv: o.uv(s) };
      if (cup) ring.cupK = cup;
      rings.push(ring);
    }
    return this.loftCupped(rings, o.segs ?? 8, o.tipPoint ?? true);
  }

  /** Loft that bends each ring's section by its `cupK` (edges toward +z) and ends in a point. */
  private loftCupped(rings: (Ring & { cupK?: number })[], segs: number, tip: boolean) {
    this.begin();
    const ids: number[][] = [];
    const p = new Vector3();
    const last = rings.length - 1;
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i];
      const row: number[] = [];
      if (tip && i === last) {
        const uv = typeof r.uv === 'function' ? r.uv(0, r.c) : r.uv;
        const w = typeof r.w === 'function' ? r.w(r.c, 0) : r.w;
        const v = this.vert(r.c, uv, w);
        for (let s = 0; s < segs; s++) row.push(v);
      } else {
        for (let s = 0; s < segs; s++) {
          const t = (s / segs) * Math.PI * 2;
          Geo.ringPoint(r, t, p);
          if (r.cupK) {
            const e = Math.cos(t);
            p.addInPlace(r.z.scale(r.cupK * e * e));
          }
          const uv = typeof r.uv === 'function' ? r.uv(t, p) : r.uv;
          const w = typeof r.w === 'function' ? r.w(p, t) : r.w;
          row.push(this.vert(p, uv, w));
        }
      }
      ids.push(row);
    }
    for (let i = 0; i + 1 < ids.length; i++) {
      const A = ids[i];
      const B = ids[i + 1];
      for (let s = 0; s < segs; s++) {
        const s1 = (s + 1) % segs;
        if (tip && i + 1 === last) this.tri(A[s], A[s1], B[s]);
        else this.quad(A[s], A[s1], B[s1], B[s]);
      }
    }
    // close the root end with a fan
    const r0 = rings[0];
    const uv0 = typeof r0.uv === 'function' ? r0.uv(0, r0.c) : r0.uv;
    const w0 = typeof r0.w === 'function' ? r0.w(r0.c, 0) : r0.w;
    const c0 = this.vert(r0.c, uv0, w0);
    for (let s = 0; s < segs; s++) this.tri(ids[0][(s + 1) % segs], ids[0][s], c0);
    this.end();
  }

  /** An ellipsoid (or superellipsoid) centred at c with axes ax, ay, az scaled by rx, ry, rz. */
  blob(
    c: Vector3,
    axes: [Vector3, Vector3, Vector3],
    r: [number, number, number],
    w: Weights | ((p: Vector3) => Weights),
    uv: [number, number] | ((p: Vector3, n: Vector3) => [number, number]),
    o: { lat?: number; lon?: number; n?: number; shape?: (d: Vector3) => number } = {},
  ) {
    this.begin();
    const lat = o.lat ?? 10;
    const lon = o.lon ?? 16;
    const e = 2 / (o.n ?? 2);
    const p = new Vector3();
    const d = new Vector3();
    const rows: number[][] = [];
    for (let i = 0; i <= lat; i++) {
      const th = (i / lat) * Math.PI;
      const row: number[] = [];
      const cnt = i === 0 || i === lat ? 1 : lon;
      for (let j = 0; j < cnt; j++) {
        const ph = (j / lon) * Math.PI * 2;
        const sy = sgnpow(Math.cos(th), e);
        const sr = sgnpow(Math.sin(th), e);
        d.set(sr * sgnpow(Math.cos(ph), e), sy, sr * sgnpow(Math.sin(ph), e));
        const m = o.shape ? o.shape(d) : 1;
        p.copyFrom(c)
          .addInPlace(axes[0].scale(d.x * r[0] * m))
          .addInPlace(axes[1].scale(d.y * r[1] * m))
          .addInPlace(axes[2].scale(d.z * r[2] * m));
        const ww = typeof w === 'function' ? w(p) : w;
        const uu = typeof uv === 'function' ? uv(p, d) : uv;
        row.push(this.vert(p, uu, ww));
      }
      rows.push(row);
    }
    for (let i = 0; i < lat; i++) {
      const A = rows[i];
      const B = rows[i + 1];
      for (let j = 0; j < lon; j++) {
        const j1 = (j + 1) % lon;
        if (A.length === 1) this.tri(A[0], B[j1], B[j]);
        else if (B.length === 1) this.tri(A[j], A[j1], B[0]);
        else this.quad(A[j], A[j1], B[j1], B[j]);
      }
    }
    this.end();
  }

  /**
   * A closed shell between two grids of points (rows × columns): the outer
   * surface, the inner one, and strips joining them along the open edges.
   * `wrap` joins the last column back to the first (hoods, caps, skirts).
   */
  shell(
    outer: Vector3[][],
    inner: Vector3[][],
    o: { wrap?: boolean; uv: (i: number, j: number, outside: boolean, p: Vector3) => [number, number]; w: (p: Vector3) => Weights },
  ) {
    this.begin();
    const R = outer.length;
    const C = outer[0].length;
    const O: number[][] = [];
    const I: number[][] = [];
    for (let i = 0; i < R; i++) {
      O.push(outer[i].map((p, j) => this.vert(p, o.uv(i, j, true, p), o.w(p))));
      I.push(inner[i].map((p, j) => this.vert(p, o.uv(i, j, false, p), o.w(p))));
    }
    const cols = o.wrap ? C : C - 1;
    for (let i = 0; i + 1 < R; i++) {
      for (let j = 0; j < cols; j++) {
        const j1 = (j + 1) % C;
        this.quad(O[i][j], O[i][j1], O[i + 1][j1], O[i + 1][j]);
        this.quad(I[i][j], I[i + 1][j], I[i + 1][j1], I[i][j1]);
      }
    }
    // edges: first and last rows, and the side columns when open
    for (const i of [0, R - 1]) {
      const s = i === 0 ? 1 : -1;
      for (let j = 0; j < cols; j++) {
        const j1 = (j + 1) % C;
        if (s > 0) this.quad(O[i][j1], O[i][j], I[i][j], I[i][j1]);
        else this.quad(O[i][j], O[i][j1], I[i][j1], I[i][j]);
      }
    }
    if (!o.wrap) {
      for (let i = 0; i + 1 < R; i++) {
        this.quad(O[i][0], O[i + 1][0], I[i + 1][0], I[i][0]);
        this.quad(O[i + 1][C - 1], O[i][C - 1], I[i][C - 1], I[i + 1][C - 1]);
      }
    }
    this.end();
  }

  /** A cloth sheet with thickness from a grid of mid-surface points (normals from the grid). */
  sheet(
    mid: Vector3[][],
    thick: number | ((i: number, j: number) => number),
    o: { wrap?: boolean; uv: (i: number, j: number, outside: boolean, p: Vector3) => [number, number]; w: (p: Vector3) => Weights; out?: (p: Vector3) => Vector3 },
  ) {
    const R = mid.length;
    const C = mid[0].length;
    const outer: Vector3[][] = [];
    const inner: Vector3[][] = [];
    for (let i = 0; i < R; i++) {
      const ro: Vector3[] = [];
      const ri: Vector3[] = [];
      for (let j = 0; j < C; j++) {
        const du = mid[Math.min(R - 1, i + 1)][j].subtract(mid[Math.max(0, i - 1)][j]);
        const jn = o.wrap ? (j + 1) % C : Math.min(C - 1, j + 1);
        const jp = o.wrap ? (j - 1 + C) % C : Math.max(0, j - 1);
        const dv = mid[i][jn].subtract(mid[i][jp]);
        let n = Vector3.Cross(dv, du);
        if (n.lengthSquared() < 1e-12) n = Vector3.Up();
        n.normalize();
        // orient by a hint: away from the body
        if (o.out && Vector3.Dot(n, o.out(mid[i][j])) < 0) n.scaleInPlace(-1);
        const t = (typeof thick === 'number' ? thick : thick(i, j)) / 2;
        ro.push(mid[i][j].add(n.scale(t)));
        ri.push(mid[i][j].subtract(n.scale(t)));
      }
      outer.push(ro);
      inner.push(ri);
    }
    this.shell(outer, inner, o);
  }

  /** Append another Geo. */
  append(g: Geo) {
    const base = this.vertexCount;
    this.pos.push(...g.pos);
    this.nrm.push(...g.nrm);
    this.uv.push(...g.uv);
    this.wts.push(...g.wts);
    for (const i of g.idx) this.idx.push(i + base);
  }
}

/** Catmull-Rom through points, `per` samples per span (ends included). */
export function catmull(pts: Vector3[], per: number): Vector3[] {
  if (pts.length < 2) return pts.map((p) => p.clone());
  const out: Vector3[] = [];
  const P = (i: number) => pts[Math.max(0, Math.min(pts.length - 1, i))];
  const spans = pts.length - 1;
  const total = Math.max(2, Math.round(per * spans));
  for (let k = 0; k <= total; k++) {
    const u = (k / total) * spans;
    const i = Math.min(spans - 1, Math.floor(u));
    const t = u - i;
    out.push(Vector3.CatmullRom(P(i - 1), P(i), P(i + 1), P(i + 2), t));
  }
  return out;
}
