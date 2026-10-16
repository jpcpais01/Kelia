// The anime head: a loft of horizontal sections from a small pointed chin up
// to a round crown (wide at the eyes, narrow jaw, flat face plane, a hint of
// a nose), ears, and the neck. Front-facing triangles inside the face box
// take the painted face; their normals are bent toward a smooth head shape
// so the face shades in clean anime planes (no blotches from the nose or jaw).
import { Vector3 } from '@babylonjs/core';
import { CHIN_Y, FACE_BOX, HEAD_H } from './face';
import { blend, Geo, lerp, one, smooth, type Ring } from './geo';
import { faceUV, SW, uvOf } from './palette';

const X = new Vector3(1, 0, 0);
const Z = new Vector3(0, 0, 1);

/** Piecewise-linear lookup through [u, value] pairs (smoothstepped between keys). */
export function curve(keys: [number, number][], u: number) {
  if (u <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (u <= keys[i][0]) {
      const [u0, v0] = keys[i - 1];
      const [u1, v1] = keys[i];
      const t = (u - u0) / (u1 - u0);
      return lerp(v0, v1, t * t * (3 - 2 * t));
    }
  }
  return keys[keys.length - 1][1];
}

/** Head profile by height u (0 chin, 1 crown): half width, front z, back z. */
export interface HeadShape {
  width: [number, number][];
  front: [number, number][];
  back: [number, number][];
}

export const HEAD_SHAPE: HeadShape = {
  width: [[0, 0.012], [0.04, 0.026], [0.1, 0.042], [0.18, 0.056], [0.27, 0.066], [0.36, 0.073], [0.45, 0.078], [0.54, 0.081], [0.66, 0.082], [0.78, 0.077], [0.88, 0.064], [0.95, 0.044], [1, 0.004]],
  front: [[0, 0.07], [0.05, 0.074], [0.14, 0.078], [0.24, 0.082], [0.34, 0.086], [0.46, 0.088], [0.56, 0.087], [0.66, 0.082], [0.78, 0.07], [0.88, 0.05], [0.95, 0.03], [1, 0.0]],
  back: [[0, 0.055], [0.05, 0.03], [0.12, -0.02], [0.2, -0.06], [0.3, -0.085], [0.42, -0.1], [0.56, -0.108], [0.7, -0.106], [0.82, -0.094], [0.92, -0.068], [0.97, -0.045], [1, -0.01]],
};

/** Surface point of the head at height u and section angle t (rig space). */
export function headRing(u: number, shape = HEAD_SHAPE): Ring {
  const a = curve(shape.width, u);
  const fz = curve(shape.front, u);
  const bz = curve(shape.back, u);
  const cz = (fz + bz) / 2;
  const nose = Math.exp(-(((u - 0.29) / 0.05) ** 2)) * 0.007 + Math.exp(-(((u - 0.4) / 0.07) ** 2)) * 0.002;
  return {
    c: new Vector3(0, CHIN_Y + u * HEAD_H, cz),
    x: X,
    z: Z,
    a,
    f: Math.max(0.002, fz - cz),
    b: Math.max(0.002, cz - bz),
    n: 2.25,
    // a soft nose on the centre line of the face
    r: (t) => 1 + (nose / Math.max(0.01, fz - cz)) * Math.exp(-(((t - Math.PI / 2) / 0.11) ** 2)),
    w: one('head'),
    uv: uvOf(SW.skin),
  };
}

/** Centre of the smooth shape the face shades as. */
const SHADE_C = new Vector3(0, CHIN_Y + 0.115, -0.012);

export function buildHead(g: Geo) {
  const rings: Ring[] = [];
  const N = 30;
  for (let i = 0; i <= N; i++) {
    // more sections low on the face (chin and jaw) and near the crown
    const s = i / N;
    const u = 0.004 + 0.992 * (s < 0.5 ? s * s * 2 : 1 - (1 - s) * (1 - s) * 2) * 0.5 + 0.992 * s * 0.5;
    rings.push(headRing(u));
  }
  const v0 = g.vertexCount;
  const i0 = g.idx.length;
  g.loft(rings, { segs: 40, capStart: 0.004, capEnd: 0.006, t0: -Math.PI / 2 });
  // anime face shading: normals lean toward a smooth ovoid, mostly on the face
  g.bendNormals(
    v0,
    (p) => p.subtract(SHADE_C).multiplyByFloats(1, 0.8, 1).normalize(),
    (p) => {
      const front = smooth(-0.02, 0.05, p.z);
      const low = smooth(CHIN_Y + 0.21, CHIN_Y + 0.15, p.y);
      return 0.85 * front * low;
    },
  );
  // the painted face on front-facing triangles inside the face box
  const fx = (x: number) => (x - FACE_BOX.x0) / (FACE_BOX.x1 - FACE_BOX.x0);
  const fy = (y: number) => (FACE_BOX.y1 - y) / (FACE_BOX.y1 - FACE_BOX.y0);
  const dup = new Map<number, number>();
  const P = g.pos;
  for (let t = i0; t < g.idx.length; t += 3) {
    const ids = [g.idx[t], g.idx[t + 1], g.idx[t + 2]];
    let cx = 0;
    let cy = 0;
    let nz = 0;
    for (const v of ids) {
      cx += P[v * 3] / 3;
      cy += P[v * 3 + 1] / 3;
      nz += P[v * 3 + 2] / 3;
    }
    const inBox = cx > FACE_BOX.x0 + 0.004 && cx < FACE_BOX.x1 - 0.004 && cy > FACE_BOX.y0 + 0.004 && cy < FACE_BOX.y1 - 0.004 && nz > 0.035;
    if (!inBox) continue;
    for (let k = 0; k < 3; k++) {
      const v = ids[k];
      let d = dup.get(v);
      if (d === undefined) {
        const p = new Vector3(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
        d = g.vert(p, faceUV(fx(p.x), fy(p.y)), g.wts[v]);
        g.nrm[d * 3] = g.nrm[v * 3];
        g.nrm[d * 3 + 1] = g.nrm[v * 3 + 1];
        g.nrm[d * 3 + 2] = g.nrm[v * 3 + 2];
        dup.set(v, d);
      }
      g.idx[t + k] = d;
    }
  }
  g.begin();

  // ears: small, tucked under the hair line
  for (const side of [-1, 1]) {
    const c = new Vector3(side * 0.075, CHIN_Y + 0.088, -0.018);
    const out = new Vector3(side, 0, -0.25).normalize();
    const up = new Vector3(0, 1, 0.12).normalize();
    const fwd = Vector3.Cross(out, up).scale(side).normalize();
    g.blob(c, [out, up, fwd], [0.008, 0.026, 0.016], one('head'), uvOf(SW.skin), {
      lat: 8,
      lon: 12,
      shape: (d) => 1 + 0.25 * Math.max(0, d.y) * Math.max(0, -d.z * side),
    });
  }
}

export function buildNeck(g: Geo, thick = 1) {
  const rings: Ring[] = [];
  for (const [y, r] of [[1.43, 0.05], [1.5, 0.044], [1.55, 0.041], [1.6, 0.04], [1.64, 0.04]] as const) {
    const t = smooth(1.49, 1.58, y);
    rings.push({
      c: new Vector3(0, y, -0.012 + (y - 1.5) * 0.08),
      x: X,
      z: Z,
      a: r * thick,
      f: r * 0.95 * thick,
      b: r * 1.05 * thick,
      w: blend(one('chest'), one('head'), t),
      uv: uvOf(SW.skin),
    });
  }
  g.loft(rings, { segs: 18, capStart: 0.01, capEnd: 0.01 });
}
