// GPU instance layers for the effects.
//
// Each layer is one mesh drawn with one ShaderMaterial (compiled once) and a
// fixed-size instance buffer used as a ring: spawning writes one slot, the
// vertex shader animates it from its spawn time, and dead slots collapse to
// nothing. Only the slots written this frame are uploaded.
import {
  Buffer,
  Constants,
  Mesh,
  ShaderMaterial,
  VertexBuffer,
  VertexData,
  type BaseTexture,
  type Scene,
  type TransformNode,
} from '@babylonjs/core';

export interface LayerOptions {
  name: string;
  shader: string;
  attributes: string[]; // instanced vec4 attributes, in buffer order
  capacity: number;
  template: VertexData;
  templateAttributes?: string[];
  uniforms?: string[];
  samplers?: string[];
  depthWrite?: boolean;
  cull?: boolean;
  zOffset?: number;
  alphaIndex: number;
}

export class InstanceLayer {
  readonly data: Float32Array;
  readonly stride: number;
  readonly capacity: number;
  readonly mesh: Mesh;
  readonly mat: ShaderMaterial;
  private buffer: Buffer;
  private head = 0;
  private lo = -1;
  private hi = -1;
  private wrapped = false;
  private singles: number[] = [];

  constructor(scene: Scene, parent: TransformNode, o: LayerOptions) {
    this.stride = o.attributes.length * 4;
    this.capacity = o.capacity;
    this.data = new Float32Array(this.capacity * this.stride);
    const engine = scene.getEngine();
    this.mesh = new Mesh(o.name, scene);
    o.template.applyToMesh(this.mesh, false);
    this.mesh.parent = parent;
    this.buffer = new Buffer(engine, this.data, true, this.stride, false, true);
    o.attributes.forEach((kind, i) => {
      const vb = this.buffer.createVertexBuffer(kind, i * 4, 4, this.stride, true);
      this.mesh.setVerticesBuffer(vb);
    });
    this.mesh.forcedInstanceCount = this.capacity;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.doNotSyncBoundingInfo = true;
    this.mesh.isPickable = false;
    this.mesh.alphaIndex = o.alphaIndex;
    const mat = new ShaderMaterial(o.name + 'Mat', scene, o.shader, {
      attributes: [...(o.templateAttributes ?? ['position']), ...o.attributes],
      uniforms: ['viewProjection', 'fxTime', 'camPos', ...(o.uniforms ?? [])],
      samplers: o.samplers ?? [],
      needAlphaBlending: true,
    });
    mat.alphaMode = Constants.ALPHA_PREMULTIPLIED;
    mat.backFaceCulling = !!o.cull;
    mat.disableDepthWrite = !o.depthWrite;
    if (o.zOffset) mat.zOffset = o.zOffset;
    this.mesh.material = mat;
    this.mat = mat;
  }

  /** Reserve the next slot; returns the float offset to write `stride` floats at. */
  alloc(): number {
    const slot = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (this.lo < 0) {
      this.lo = this.hi = slot;
    } else if (slot === 0 && this.hi === this.capacity - 1) {
      this.wrapped = true;
    } else {
      this.hi = slot;
    }
    return slot * this.stride;
  }

  /** Mark one slot (by float offset) for re-upload after editing it in place. */
  touch(offset: number) {
    this.singles.push(offset / this.stride);
  }

  flush() {
    if (this.wrapped) {
      this.buffer.updateDirectly(this.data, 0);
    } else if (this.lo >= 0) {
      const a = this.lo * this.stride;
      const b = (this.hi + 1) * this.stride;
      this.buffer.updateDirectly(this.data.subarray(a, b), a);
    }
    for (const s of this.singles) {
      const a = s * this.stride;
      this.buffer.updateDirectly(this.data.subarray(a, a + this.stride), a);
    }
    this.singles.length = 0;
    this.lo = this.hi = -1;
    this.wrapped = false;
  }

  setTexture(name: string, t: BaseTexture) {
    this.mat.setTexture(name, t);
  }
}

// ------------------------------------------------------------------ templates
export function quadTemplate() {
  const vd = new VertexData();
  vd.positions = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0];
  vd.indices = [0, 1, 2, 0, 2, 3];
  return vd;
}

/** Flat grid over [-1, 1]² in XZ (decals hug the terrain per vertex). */
export function gridTemplate(n: number) {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) pos.push((i / n) * 2 - 1, 0, (j / n) * 2 - 1);
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * (n + 1) + i;
      idx.push(k, k + n + 1, k + 1, k + 1, k + n + 1, k + n + 2);
    }
  }
  const vd = new VertexData();
  vd.positions = pos;
  vd.indices = idx;
  return vd;
}

/** Parametric strip: position = (u, v, 0), u ∈ [0, 1] along, v ∈ [0, 1] across. */
export function stripTemplate(nu: number, nv: number) {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) pos.push(i / nu, j / nv, 0);
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const k = j * (nu + 1) + i;
      idx.push(k, k + 1, k + nu + 1, k + 1, k + nu + 2, k + nu + 1);
    }
  }
  const vd = new VertexData();
  vd.positions = pos;
  vd.indices = idx;
  return vd;
}

/** Flat-shaded hexagonal crystal, base at y = -0.15, tip at y = 1. */
export function crystalTemplate() {
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  const ring = (y: number, r: number, k: number) => {
    const a = (k / 6) * Math.PI * 2;
    return [Math.cos(a) * r, y, Math.sin(a) * r];
  };
  const tri = (a: number[], b: number[], c: number[]) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const base = pos.length / 3;
    pos.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) nrm.push(nx, ny, nz);
    idx.push(base, base + 1, base + 2);
  };
  for (let k = 0; k < 6; k++) {
    const b0 = ring(-0.15, 1, k);
    const b1 = ring(-0.15, 1, k + 1);
    const m0 = ring(0.7, 0.82, k);
    const m1 = ring(0.7, 0.82, k + 1);
    const tip = [0, 1, 0];
    // outward-facing winding (Babylon is left-handed: clockwise front faces)
    tri(b0, m0, b1);
    tri(b1, m0, m1);
    tri(m0, tip, m1);
  }
  const vd = new VertexData();
  vd.positions = pos;
  vd.normals = nrm;
  vd.indices = idx;
  return vd;
}

export { VertexBuffer };
