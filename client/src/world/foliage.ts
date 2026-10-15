// Trees, bushes and rocks: procedurally modelled, scattered deterministically
// over the world, drawn as thin instances per 64 m chunk with two LODs, and
// swaying in the same wind as the grass.
import {
  Color3,
  Matrix,
  Mesh,
  PBRMaterial,
  Quaternion,
  Vector3,
  type Scene,
  type VertexData,
} from '@babylonjs/core';
import {
  LAKE,
  RUINS,
  SHRINE,
  Simplex2,
  VILLAGE,
  WORLD_HALF,
  forestMask,
  hash2,
  hillsMask,
  pathDistance,
  waterAt,
  type Heightmap,
} from '@kelia/shared';
import type { QualitySettings } from '../core/quality';
import type { Atmosphere } from './atmosphere';
import { MeshBuilder2 } from './meshgen';
import { createShaderPlugin, type ShaderPlugin } from './shaderPlugin';

const CHUNK = 64;

type C3 = [number, number, number];
const hex = (h: string): C3 => {
  const c = Color3.FromHexString(h).toLinearSpace();
  return [c.r, c.g, c.b];
};

interface TreeType {
  id: string;
  build: (lod: number, seed: number) => VertexData;
  collider: number; // trunk radius
  shadow: boolean;
  wind: number;
}

const noise = new Simplex2(4242);

function broadleaf(lod: number, variant: number): VertexData {
  const b = new MeshBuilder2();
  const rnd = mulberry(variant * 977 + 13);
  const trunkH = 3.2 + rnd() * 1.6;
  const lean: C3 = [(rnd() - 0.5) * 0.25, 1, (rnd() - 0.5) * 0.25];
  b.branch([0, -0.3, 0], lean, trunkH + 0.6, 0.38, 0.2, lod ? 5 : 8, lod ? 2 : 4, hex('#6b4a33'), 0, 0.05);
  const top: C3 = [lean[0] * trunkH, trunkH, lean[2] * trunkH];
  if (!lod) {
    for (let i = 0; i < 3; i++) {
      const a = rnd() * Math.PI * 2;
      b.branch([top[0] * 0.7, trunkH * 0.7, top[2] * 0.7], [Math.cos(a), 0.9, Math.sin(a)], 1.8, 0.14, 0.06, 5, 2, hex('#6b4a33'), 0.05, 0.2);
    }
  }
  const leafA = variant % 3 === 2 ? hex('#3e5a1e') : hex('#2b4a1d');
  const leafB = variant % 3 === 2 ? hex('#9a8f36') : variant % 3 === 1 ? hex('#6f9236') : hex('#5f8a30');
  const canopyC: C3 = [top[0], trunkH + 1.6, top[2]];
  const clumps = lod ? 3 : 6;
  b.blob(canopyC, [2.6, 2.1, 2.6], lod ? 1 : 2, noise, 0.22, leafA, leafB, canopyC, 0.5);
  for (let i = 0; i < clumps; i++) {
    const a = (i / clumps) * Math.PI * 2 + rnd();
    const r = 1.7 + rnd() * 0.6;
    const c: C3 = [canopyC[0] + Math.cos(a) * r, canopyC[1] + (rnd() - 0.4) * 1.4, canopyC[2] + Math.sin(a) * r];
    const s = 1.3 + rnd() * 0.6;
    b.blob(c, [s, s * 0.85, s], lod ? 1 : 2, noise, 0.25, leafA, leafB, canopyC, 0.8);
  }
  return b.toVertexData();
}

function pine(lod: number, variant: number): VertexData {
  const b = new MeshBuilder2();
  const rnd = mulberry(variant * 331 + 7);
  const h = 7 + rnd() * 3;
  b.branch([0, -0.3, 0], [0, 1, 0], h * 0.9, 0.32, 0.08, lod ? 5 : 7, 2, hex('#5a4030'), 0, 0.1);
  const layers = lod ? 3 : 5;
  const dark = hex('#24452c');
  const light = hex('#4f7a3c');
  for (let i = 0; i < layers; i++) {
    const t = i / layers;
    const radius = 2.6 * (1 - t * 0.75) + rnd() * 0.3;
    b.cone(1.6 + t * h * 0.78, 2.6 - t * 0.6, radius, lod ? 7 : 11, dark, light, 0.25 + t * 0.6, 0.18, rnd() * 6);
  }
  return b.toVertexData();
}

function birch(lod: number, variant: number): VertexData {
  const b = new MeshBuilder2();
  const rnd = mulberry(variant * 51 + 3);
  const h = 5 + rnd() * 1.5;
  b.branch([0, -0.3, 0], [(rnd() - 0.5) * 0.15, 1, (rnd() - 0.5) * 0.15], h, 0.2, 0.1, lod ? 5 : 7, 3, hex('#e8e4dc'), 0, 0.1);
  const c: C3 = [0, h + 0.4, 0];
  const leafA = hex('#4a6e26');
  const leafB = hex('#a6a848');
  b.blob(c, [1.8, 2.4, 1.8], lod ? 1 : 2, noise, 0.3, leafA, leafB, c, 0.7);
  if (!lod) {
    b.blob([c[0] + 0.9, c[1] - 1.1, c[2] + 0.4], [1.1, 1.2, 1.1], 1, noise, 0.3, leafA, leafB, c, 0.8);
    b.blob([c[0] - 0.8, c[1] - 0.6, c[2] - 0.6], [1.0, 1.1, 1.0], 1, noise, 0.3, leafA, leafB, c, 0.8);
  }
  return b.toVertexData();
}

function bush(lod: number, variant: number): VertexData {
  const b = new MeshBuilder2();
  const rnd = mulberry(variant * 71 + 5);
  const c: C3 = [0, 0.5, 0];
  const a = variant % 2 ? hex('#25451c') : hex('#2d4f1f');
  const t = variant % 2 ? hex('#557a2c') : hex('#678b34');
  b.blob(c, [1.2 + rnd() * 0.4, 0.95, 1.2 + rnd() * 0.4], lod ? 1 : 2, noise, 0.3, a, t, [0, -0.4, 0], 0.35, 0.5);
  if (!lod) b.blob([0.7, 0.35, 0.3], [0.7, 0.6, 0.7], 1, noise, 0.3, a, t, [0, -0.4, 0], 0.35, 0.5);
  return b.toVertexData();
}

function rock(_lod: number, variant: number): VertexData {
  const b = new MeshBuilder2();
  const rnd = mulberry(variant * 17 + 1);
  b.rock([0, 0, 0], [1 + rnd() * 0.4, 0.75 + rnd() * 0.3, 1 + rnd() * 0.4], noise, variant * 3.7, hex('#8a8783'), hex('#5f7a3a'));
  if (variant % 2 === 0) b.rock([0.9, -0.1, 0.5], [0.5, 0.45, 0.5], noise, variant * 5.1 + 2, hex('#8a8783'), hex('#5f7a3a'));
  return b.toVertexData();
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPES: TreeType[] = [
  { id: 'oak0', build: (l) => broadleaf(l, 0), collider: 0.55, shadow: true, wind: 1 },
  { id: 'oak1', build: (l) => broadleaf(l, 1), collider: 0.55, shadow: true, wind: 1 },
  { id: 'oak2', build: (l) => broadleaf(l, 2), collider: 0.55, shadow: true, wind: 1 },
  { id: 'pine0', build: (l) => pine(l, 0), collider: 0.45, shadow: true, wind: 0.6 },
  { id: 'pine1', build: (l) => pine(l, 1), collider: 0.45, shadow: true, wind: 0.6 },
  { id: 'birch', build: (l) => birch(l, 0), collider: 0.35, shadow: true, wind: 1.2 },
  { id: 'bush0', build: (l) => bush(l, 0), collider: 0, shadow: false, wind: 0.6 },
  { id: 'bush1', build: (l) => bush(l, 1), collider: 0, shadow: false, wind: 0.6 },
  { id: 'rock0', build: (l) => rock(l, 0), collider: 1.0, shadow: true, wind: 0 },
  { id: 'rock1', build: (l) => rock(l, 1), collider: 1.0, shadow: true, wind: 0 },
  { id: 'rock2', build: (l) => rock(l, 2), collider: 1.0, shadow: true, wind: 0 },
];

export interface Collider {
  x: number;
  z: number;
  r: number;
}

interface Placement {
  type: number;
  x: number;
  y: number;
  z: number;
  rot: number;
  scale: number;
}

interface Chunk {
  cx: number;
  cz: number;
  /** Instance matrices per tree type. */
  mats: (Float32Array | null)[];
}

const WIND_GLSL = /* glsl */ `
  float kSway = color.a;
  vec3 kRoot = vec3(finalWorld[3][0], finalWorld[3][1], finalWorld[3][2]);
  float kT = windParams.w;
  float kGust = sin(dot(kRoot.xz, windParams.xy) * 0.07 - kT * 1.6) * 0.5 + 0.5;
  float kPhase = kRoot.x * 0.37 + kRoot.z * 0.21;
  vec2 kSide = vec2(-windParams.y, windParams.x);
  float kH = max(worldPos.y - kRoot.y, 0.0);
  vec2 kDisp = windParams.xy * (0.15 + kGust * 0.5) * windParams.z + kSide * sin(kT * 1.9 + kPhase) * 0.12 * windParams.z;
  kDisp += vec2(sin(kT * 4.1 + worldPos.y * 1.3 + kPhase), cos(kT * 3.7 + worldPos.x * 1.1)) * 0.05 * kSway;
  worldPos.xz += kDisp * kSway * min(kH * 0.12, 1.2) * windStrength;
`;

const WIND_WGSL = /* wgsl */ `
  let kSway = vertexInputs.color.a;
  let kRoot = vec3f(finalWorld[3][0], finalWorld[3][1], finalWorld[3][2]);
  let kT = uniforms.windParams.w;
  let kGust = sin(dot(kRoot.xz, uniforms.windParams.xy) * 0.07 - kT * 1.6) * 0.5 + 0.5;
  let kPhase = kRoot.x * 0.37 + kRoot.z * 0.21;
  let kSide = vec2f(-uniforms.windParams.y, uniforms.windParams.x);
  let kH = max(worldPos.y - kRoot.y, 0.0);
  var kDisp = uniforms.windParams.xy * (0.15 + kGust * 0.5) * uniforms.windParams.z + kSide * sin(kT * 1.9 + kPhase) * 0.12 * uniforms.windParams.z;
  kDisp += vec2f(sin(kT * 4.1 + worldPos.y * 1.3 + kPhase), cos(kT * 3.7 + worldPos.x * 1.1)) * 0.05 * kSway;
  worldPos = vec4f(worldPos.x + kDisp.x * kSway * min(kH * 0.12, 1.2) * uniforms.windStrength, worldPos.y, worldPos.z + kDisp.y * kSway * min(kH * 0.12, 1.2) * uniforms.windStrength, worldPos.w);
`;

export class Foliage {
  readonly colliders: Collider[] = [];
  private grid = new Map<number, Collider[]>();
  private chunks: Chunk[] = [];
  private lastCell = '';
  private bufs: { hi: Float32Array; lo: Float32Array }[] = [];
  private sources: { hi: Mesh; lo: Mesh; mat: PBRMaterial; plugin: ShaderPlugin }[] = [];
  private q!: QualitySettings;

  constructor(private scene: Scene, private hm: Heightmap, private atmosphere: Atmosphere) {
    this.buildSources();
    const placements = this.scatter();
    this.buildChunks(placements);
  }

  private buildSources() {
    for (const [i, t] of TYPES.entries()) {
      const mat = new PBRMaterial('foliage_' + t.id, this.scene);
      mat.albedoColor = Color3.White();
      mat.metallic = 0;
      mat.roughness = t.id.startsWith('rock') ? 0.9 : 0.85;
      mat.environmentIntensity = 0.6;
      mat.specularIntensity = 0.25;
      mat.backFaceCulling = true;
      // Soft subsurface-like brightening on foliage seen against the light.
      if (!t.id.startsWith('rock')) {
        mat.subSurface.isTranslucencyEnabled = true;
        mat.subSurface.translucencyIntensity = 0.35;
        mat.subSurface.tintColor = new Color3(0.6, 0.9, 0.3);
      }
      const plugin = createShaderPlugin(mat, {
        name: 'FoliageWind',
        uniforms: { windParams: 'vec4', windStrength: 'float' },
        glsl: { vertex: { CUSTOM_VERTEX_UPDATE_WORLDPOS: WIND_GLSL } },
        wgsl: { vertex: { CUSTOM_VERTEX_UPDATE_WORLDPOS: WIND_WGSL } },
      });
      plugin.values.windStrength = t.wind;
      const mk = (lod: number) => {
        const m = new Mesh(`${t.id}_L${lod}`, this.scene);
        t.build(lod, i).applyToMesh(m);
        m.material = mat;
        m.useVertexColors = true;
        m.hasVertexAlpha = false;
        m.isPickable = false;
        m.setEnabled(false);
        return m;
      };
      this.sources.push({ hi: mk(0), lo: mk(1), mat, plugin });
    }
  }

  private scatter(): Placement[] {
    const out: Placement[] = [];
    const cell = 6;
    const n = Math.floor((WORLD_HALF * 2) / cell);
    const dist = (x: number, z: number, c: readonly [number, number]) => Math.hypot(x - c[0], z - c[1]);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const r0 = hash2(i, j, 1);
        const x = -WORLD_HALF + (i + 0.15 + hash2(i, j, 2) * 0.7) * cell;
        const z = -WORLD_HALF + (j + 0.15 + hash2(i, j, 3) * 0.7) * cell;
        if (Math.abs(x) > WORLD_HALF - 30 || Math.abs(z) > WORLD_HALF - 30) continue;
        const f = forestMask(x, z);
        const hills = hillsMask(x, z);
        const h = this.hm.sample(x, z);
        const slope = 1 - this.hm.normal(x, z).y;
        let pTree = f * 0.62 + 0.012;
        let pRock = hills * 0.06 + (slope > 0.12 ? 0.05 : 0.004);
        let pBush = f * 0.18 + 0.01;
        // keep places clear
        if (waterAt(x, z) > h - 0.6) continue;
        if (dist(x, z, VILLAGE.center) < VILLAGE.radius + 12) pTree = pBush = pRock = 0;
        if (dist(x, z, SHRINE.center) < SHRINE.radius + 6) pTree = pBush = pRock = 0;
        if (dist(x, z, RUINS.center) < RUINS.radius + 4) pTree = pBush = 0;
        if (dist(x, z, LAKE.center) < LAKE.radius + 4) pTree = pBush = pRock = 0;
        const pd = pathDistance(x, z);
        if (pd < 3.5) pTree = pBush = pRock = 0;
        if (slope > 0.35) pTree = pBush = 0;
        if (h > 60) pTree *= 0.3;
        const rot = hash2(i, j, 4) * Math.PI * 2;
        const sc = 0.8 + hash2(i, j, 5) * 0.55;
        if (r0 < pTree) {
          // pines up north and on high ground, birches near water, oaks elsewhere
          const nearWater = waterAt(x + 12, z) > -Infinity || waterAt(x - 12, z) > -Infinity;
          let type: number;
          const r1 = hash2(i, j, 6);
          if (z > 180 || h > 40 || (f > 0.5 && r1 < 0.3)) type = 3 + (r1 < 0.5 ? 0 : 1);
          else if (nearWater && r1 < 0.6) type = 5;
          else type = Math.floor(r1 * 3);
          out.push({ type, x, y: h, z, rot, scale: sc });
        } else if (r0 < pTree + pBush) {
          out.push({ type: 6 + (hash2(i, j, 7) < 0.5 ? 0 : 1), x, y: h, z, rot, scale: sc });
        } else if (r0 < pTree + pBush + pRock) {
          const big = hills > 0.3 ? 1.5 + hash2(i, j, 8) * 2.5 : 0.6 + hash2(i, j, 8) * 0.9;
          out.push({ type: 8 + Math.floor(hash2(i, j, 9) * 3), x, y: h - 0.2 * big, z, rot, scale: big });
        }
      }
    }
    return out;
  }

  private buildChunks(list: Placement[]) {
    const per = new Map<number, Placement[][]>();
    const chunksPerSide = (WORLD_HALF * 2) / CHUNK;
    for (const p of list) {
      const ci = Math.floor((p.x + WORLD_HALF) / CHUNK);
      const cj = Math.floor((p.z + WORLD_HALF) / CHUNK);
      const key = cj * chunksPerSide + ci;
      let arr = per.get(key);
      if (!arr) {
        arr = TYPES.map(() => []);
        per.set(key, arr);
      }
      arr[p.type].push(p);
      const t = TYPES[p.type];
      if (t.collider > 0) this.addCollider({ x: p.x, z: p.z, r: t.collider * p.scale });
    }
    const m = new Matrix();
    const q = new Quaternion();
    const s = new Vector3();
    const tr = new Vector3();
    for (const [key, arr] of per) {
      const ci = key % chunksPerSide;
      const cj = Math.floor(key / chunksPerSide);
      const chunk: Chunk = {
        cx: -WORLD_HALF + (ci + 0.5) * CHUNK,
        cz: -WORLD_HALF + (cj + 0.5) * CHUNK,
        mats: arr.map((items) => {
          if (!items.length) return null;
          const buf = new Float32Array(items.length * 16);
          items.forEach((p, k) => {
            Quaternion.RotationYawPitchRollToRef(p.rot, 0, 0, q);
            s.set(p.scale, p.scale, p.scale);
            tr.set(p.x, p.y, p.z);
            Matrix.ComposeToRef(s, q, tr, m);
            m.copyToArray(buf, k * 16);
          });
          return buf;
        }),
      };
      this.chunks.push(chunk);
    }
    for (const [type, src] of this.sources.entries()) {
      for (const mesh of [src.hi, src.lo]) {
        mesh.receiveShadows = true;
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.thinInstanceSetBuffer('matrix', new Float32Array(16), 16, false);
        mesh.thinInstanceCount = 0;
        mesh.setEnabled(true);
        if (TYPES[type].shadow) this.atmosphere.addShadowCaster(mesh, false);
      }
      this.bufs.push({ hi: new Float32Array(0), lo: new Float32Array(0) });
    }
  }

  private addCollider(c: Collider) {
    this.colliders.push(c);
    const key = this.gridKey(c.x, c.z);
    let arr = this.grid.get(key);
    if (!arr) this.grid.set(key, (arr = []));
    arr.push(c);
  }

  private gridKey(x: number, z: number) {
    return Math.floor((x + WORLD_HALF) / 16) * 1000 + Math.floor((z + WORLD_HALF) / 16);
  }

  /** Colliders near a point (for character movement). */
  nearby(x: number, z: number, out: Collider[] = []): Collider[] {
    out.length = 0;
    const gi = Math.floor((x + WORLD_HALF) / 16);
    const gj = Math.floor((z + WORLD_HALF) / 16);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const arr = this.grid.get((gi + a) * 1000 + gj + b);
      if (arr) for (const c of arr) out.push(c);
    }
    return out;
  }

  /** Register an extra static collider (buildings, props). */
  addStaticCollider(x: number, z: number, r: number) {
    this.addCollider({ x, z, r });
  }

  applyQuality(q: QualitySettings) {
    this.q = q;
    this.lastCell = '';
  }

  update(time: number, cam: Vector3, wind: { x: number; y: number; z: number; w: number }) {
    for (const src of this.sources) {
      src.plugin.values.windParams = [wind.x, wind.y, wind.z, time];
    }
    // Re-gather visible instances whenever the camera moves to a new 16 m cell.
    const cell = `${Math.floor(cam.x / 16)},${Math.floor(cam.z / 16)}`;
    if (cell === this.lastCell) return;
    this.lastCell = cell;
    const maxDist = this.q?.treeDistance ?? 400;
    const hiDist = Math.min(150, maxDist * 0.32);
    const hiChunks: Chunk[] = [];
    const loChunks: Chunk[] = [];
    for (const c of this.chunks) {
      const d = Math.hypot(c.cx - cam.x, c.cz - cam.z);
      if (d > maxDist + 45) continue;
      (d < hiDist ? hiChunks : loChunks).push(c);
    }
    this.sources.forEach((src, type) => {
      const b = this.bufs[type];
      b.hi = this.gather(hiChunks, type, b.hi, src.hi);
      b.lo = this.gather(loChunks, type, b.lo, src.lo);
    });
  }

  private gather(list: Chunk[], type: number, buf: Float32Array, mesh: Mesh): Float32Array {
    let n = 0;
    for (const c of list) n += c.mats[type]?.length ?? 0;
    if (buf.length < n) buf = new Float32Array(Math.ceil(n * 1.25 / 16) * 16);
    let o = 0;
    for (const c of list) {
      const m = c.mats[type];
      if (m) {
        buf.set(m, o);
        o += m.length;
      }
    }
    if (n === 0) {
      mesh.thinInstanceCount = 0;
      mesh.isVisible = false;
      return buf;
    }
    mesh.isVisible = true;
    mesh.thinInstanceSetBuffer('matrix', buf, 16, false);
    mesh.thinInstanceCount = n / 16;
    return buf;
  }
}
