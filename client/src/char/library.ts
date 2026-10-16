// Loads the modular character rig once and prepares it for fast per-player
// assembly: heads are split into face and hair so any face can wear any
// hairstyle, atlas swatches are measured for recolouring, and locomotion
// clips are measured for stride length (so feet never slide).
import { BoundingInfo, Matrix, Mesh, Vector3, VertexBuffer, type AbstractMesh, type AssetContainer, type Scene, type Skeleton, type TransformNode } from '@babylonjs/core';
import { loadContainer } from '../core/assets';
import { stretchRig, type HeroRest } from './hero/rig';
import { addChainBones } from './hero/chains';

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
  /** Anime hero rig (adventurers only): the stretched rest pose the hero is built in. */
  hero: HeroRest | null = null;
  /** The skeleton hero meshes skin to (one per character, cloned from this). */
  heroSkeleton: Skeleton | null = null;
  /** Winding of the rig's glTF meshes (hero meshes are built the same way). */
  heroSide = 0;
  /** Original bounds of parts whose vertices moved to the shared skeleton's bind space. */
  private bindBounds = new Map<string, [Vector3, Vector3]>();

  private constructor(readonly container: AssetContainer, readonly scene: Scene) {}

  static async load(scene: Scene, file: string, atlasNames: string[] = [], opts: { splitHeads?: boolean; hero?: boolean } = {}): Promise<RigLibrary> {
    const c = await loadContainer(scene, file);
    const lib = new RigLibrary(c, scene);
    if (opts.splitHeads) lib.splitHeads();
    lib.unifySkins();
    await Promise.all(atlasNames.map((n) => lib.measureAtlas(n)));
    if (opts.hero) lib.makeHero();
    else lib.measure();
    return lib;
  }

  /**
   * Stretch the rig into the anime hero's proportions (in metres). The
   * KayKit body parts are left unused; heroes are built in code (char/hero).
   */
  private makeHero() {
    const body = this.container.meshes.find((m) => m.name.startsWith('body_') && m.skeleton);
    if (!body?.skeleton) {
      this.measure();
      return;
    }
    this.heroSkeleton = body.skeleton;
    this.heroSide = (body as Mesh).sideOrientation ?? 0;
    this.hero = stretchRig(this.container, body.skeleton);
    // bones for the hair and cape to swing on (char/secondary)
    addChainBones(body.skeleton);
    // the hero is modelled in metres at its full height
    this.heightUnits = 1.85;
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

  /**
   * Every part of a rig is skinned to the same joints, but each glTF skin
   * brings its own skeleton, so a character used to prepare (and upload) one
   * bone set per body part every frame. A part's inverse bind matrices only
   * differ from the reference skin's by one constant transform; bake that into
   * its vertices and let every part share the reference skeleton.
   */
  private unifySkins() {
    const c = this.container;
    const refs: Skeleton[] = [];
    const inv = new Matrix();
    const x = new Matrix();
    const x0 = new Matrix();
    const v = new Vector3();
    const keep = new Set<Skeleton>();
    for (const m of c.meshes) {
      const s = m.skeleton;
      if (!(m instanceof Mesh) || !s) continue;
      const ref = refs.find((r) => r.bones.length === s.bones.length && r.bones.every((b, i) => b.getTransformNode() === s.bones[i].getTransformNode()));
      if (!ref || !s.bones.every((b) => b.getTransformNode())) {
        if (!ref) refs.push(s);
        keep.add(s);
        continue;
      }
      if (ref === s) continue;
      // X with IBM_part = X · IBM_ref, the same for every joint (checked)
      let ok = true;
      for (let i = 0; i < s.bones.length && ok; i++) {
        ref.bones[i].getAbsoluteInverseBindMatrix().invertToRef(inv);
        s.bones[i].getAbsoluteInverseBindMatrix().multiplyToRef(inv, i === 0 ? x0 : x);
        if (i > 0) for (let k = 0; k < 16; k++) if (Math.abs(x.m[k] - x0.m[k]) > 1e-3 * (k > 11 ? 10 : 1)) ok = false;
      }
      if (!ok) {
        keep.add(s);
        continue;
      }
      // the old bind-pose box is where the skinned part actually renders: keep it
      const bi = m.getBoundingInfo();
      const box: [Vector3, Vector3] = [bi.minimum.clone(), bi.maximum.clone()];
      this.bindBounds.set(m.name, box);
      if ((m.geometry?.meshes.length ?? 0) > 1) m.makeGeometryUnique();
      for (const [kind, normal] of [[VertexBuffer.PositionKind, false], [VertexBuffer.NormalKind, true], [VertexBuffer.TangentKind, true]] as const) {
        const data = m.getVerticesData(kind);
        if (!data) continue;
        const stride = kind === VertexBuffer.TangentKind ? 4 : 3;
        const out = Float32Array.from(data);
        for (let o = 0; o < out.length; o += stride) {
          v.set(out[o], out[o + 1], out[o + 2]);
          if (normal) Vector3.TransformNormalToRef(v, x0, v).normalize();
          else Vector3.TransformCoordinatesToRef(v, x0, v);
          out[o] = v.x;
          out[o + 1] = v.y;
          out[o + 2] = v.z;
        }
        m.setVerticesData(kind, out, false, stride);
      }
      m.skeleton = ref;
      m.setBoundingInfo(new BoundingInfo(box[0].clone(), box[1].clone()));
    }
    for (const r of refs) keep.add(r);
    // skeletons nobody uses any more would still be cloned with every character
    for (const s of [...c.skeletons]) {
      if (keep.has(s)) continue;
      c.skeletons.splice(c.skeletons.indexOf(s), 1);
      s.dispose();
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

  /** Give instantiated parts their real (rendered) bounds back after cloning recomputed them. */
  restoreBounds(meshes: AbstractMesh[]) {
    for (const m of meshes) {
      const box = this.bindBounds.get(m.name);
      if (box && m.skeleton) m.setBoundingInfo(new BoundingInfo(box[0].clone(), box[1].clone()));
    }
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
