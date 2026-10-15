// Loads the modular character rig once and prepares it for fast per-player
// assembly: heads are split into face and hair so any face can wear any
// hairstyle, atlas swatches are measured for recolouring, and locomotion
// clips are measured for stride length (so feet never slide).
import { Mesh, Vector3, VertexBuffer, type AssetContainer, type Scene, type TransformNode } from '@babylonjs/core';
import { loadContainer } from '../core/assets';

/** Swatch cells (column, row) in the 8×4 KayKit colour atlas. */
export const SKIN_CELL = [0, 0] as const;
export const HAIR_CELL = [1, 0] as const;
export const EYE_CELL = [2, 0] as const;

export interface SwatchRefs {
  skin: number;
  hair: number;
  eye: number;
}

export interface ClipInfo {
  /** Metres (in model units) covered by one loop of the clip. */
  stride: number;
  duration: number;
}

export class RigLibrary {
  heightUnits = 2.4;
  swatches: Record<string, SwatchRefs> = {};
  clips: Record<string, ClipInfo> = {};

  private constructor(readonly container: AssetContainer, readonly scene: Scene) {}

  static async load(scene: Scene, file: string, atlasNames: string[] = [], splitHeads = true): Promise<RigLibrary> {
    const c = await loadContainer(scene, file);
    const lib = new RigLibrary(c, scene);
    if (splitHeads) lib.splitHeads();
    await Promise.all(atlasNames.map((n) => lib.measureAtlas(n)));
    lib.measure();
    return lib;
  }

  /** Split every head_* mesh into <name>__face and <name>__hair by atlas cell. */
  private splitHeads() {
    const c = this.container;
    for (const m of [...c.meshes]) {
      if (!(m instanceof Mesh) || !m.name.startsWith('head_')) continue;
      const uv = m.getVerticesData(VertexBuffer.UVKind);
      const idx = m.getIndices();
      if (!uv || !idx) continue;
      const face: number[] = [];
      const hair: number[] = [];
      for (let t = 0; t < idx.length; t += 3) {
        const i = idx[t];
        const cx = Math.floor(uv[i * 2] * 8);
        const cy = Math.floor(uv[i * 2 + 1] * 4);
        const target = cx === HAIR_CELL[0] && cy === HAIR_CELL[1] ? hair : face;
        target.push(idx[t], idx[t + 1], idx[t + 2]);
      }
      for (const [suffix, ids] of [['__face', face], ['__hair', hair]] as const) {
        const part = m.clone(m.name + suffix, m.parent, true, false) as Mesh;
        part.makeGeometryUnique();
        part.setIndices(ids);
        part.skeleton = m.skeleton;
        if (suffix === '__face') enlargeEyes(part, ids);
        this.scene.removeMesh(part);
        c.meshes.push(part);
      }
    }
  }

  private async measureAtlas(name: string) {
    const img = new Image();
    img.src = `${import.meta.env.BASE_URL}assets/characters/atlas_${name}.png`;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width;
    cv.height = img.height;
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    const cell = (cx: number, cy: number) => {
      const w = img.width / 8;
      const h = img.height / 4;
      // centre-left of the swatch (the right edge has a lighter strip)
      const d = ctx.getImageData(cx * w + w * 0.15, cy * h + h * 0.1, w * 0.55, h * 0.8).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) {
        const lin = (v: number) => Math.pow(v / 255, 2.2);
        sum += 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
      }
      return Math.max(0.004, sum / (d.length / 4));
    };
    this.swatches[`${name}_texture`] = { skin: cell(...SKIN_CELL), hair: cell(...HAIR_CELL), eye: cell(...EYE_CELL) };
  }

  /** Bounding height and, for locomotion clips, stride per loop. */
  private measure() {
    const c = this.container;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const m of c.meshes) {
      if (!m.name.startsWith('body_') && !m.name.startsWith('head_') && !m.name.startsWith('legL_')) continue;
      m.computeWorldMatrix(true);
      const b = m.getBoundingInfo().boundingBox;
      minY = Math.min(minY, b.minimumWorld.y);
      maxY = Math.max(maxY, b.maximumWorld.y);
    }
    if (Number.isFinite(minY)) this.heightUnits = maxY - minY;
  }

  node(nodes: TransformNode[], name: string) {
    return nodes.find((n) => n.name === name || n.name.endsWith('_' + name));
  }
}

/**
 * Anime eyes: scale each eye (the eye-cell triangles, one island per side of
 * the face) about its own centre, a little more in height than in width, and
 * lift it off the face so the surrounding skin cannot swallow the new edge.
 */
function enlargeEyes(mesh: Mesh, ids: number[], sx = 1.28, sy = 1.42) {
  const uv = mesh.getVerticesData(VertexBuffer.UVKind);
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
  const nrm = mesh.getVerticesData(VertexBuffer.NormalKind);
  if (!uv || !pos || !nrm) return;
  const sides: Set<number>[] = [new Set(), new Set()];
  for (let t = 0; t < ids.length; t += 3) {
    const i = ids[t];
    if (Math.floor(uv[i * 2] * 8) !== EYE_CELL[0] || Math.floor(uv[i * 2 + 1] * 4) !== EYE_CELL[1]) continue;
    for (let k = 0; k < 3; k++) {
      const v = ids[t + k];
      sides[pos[v * 3] < 0 ? 0 : 1].add(v);
    }
  }
  const out = Float32Array.from(pos);
  for (const side of sides) {
    if (side.size < 3) continue;
    const c = new Vector3();
    const n = new Vector3();
    for (const v of side) {
      c.addInPlaceFromFloats(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
      n.addInPlaceFromFloats(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]);
    }
    c.scaleInPlace(1 / side.size);
    if (n.lengthSquared() < 1e-8) continue;
    n.normalize();
    const u = new Vector3(0, 1, 0).subtract(n.scale(n.y));
    if (u.lengthSquared() < 1e-6) continue;
    u.normalize();
    const r = Vector3.Cross(u, n);
    let size = 0;
    const d = new Vector3();
    for (const v of side) {
      d.set(pos[v * 3] - c.x, pos[v * 3 + 1] - c.y, pos[v * 3 + 2] - c.z);
      size = Math.max(size, Math.abs(Vector3.Dot(d, r)), Math.abs(Vector3.Dot(d, u)));
    }
    const push = size * 0.18;
    for (const v of side) {
      d.set(pos[v * 3] - c.x, pos[v * 3 + 1] - c.y, pos[v * 3 + 2] - c.z);
      const dn = Vector3.Dot(d, n) + push;
      const du = Vector3.Dot(d, u) * sy;
      const dr = Vector3.Dot(d, r) * sx;
      out[v * 3] = c.x + n.x * dn + u.x * du + r.x * dr;
      out[v * 3 + 1] = c.y + n.y * dn + u.y * du + r.y * dr;
      out[v * 3 + 2] = c.z + n.z * dn + u.z * du + r.z * dr;
    }
  }
  mesh.setVerticesData(VertexBuffer.PositionKind, out, false);
}
