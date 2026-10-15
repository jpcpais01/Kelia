// Loads the modular character rig once and prepares it for fast per-player
// assembly: heads are split into face and hair so any face can wear any
// hairstyle, atlas swatches are measured for recolouring, and locomotion
// clips are measured for stride length (so feet never slide).
import { Mesh, VertexBuffer, type AssetContainer, type Scene, type TransformNode } from '@babylonjs/core';
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
