// Trees, bushes and rocks: procedurally modelled in a soft, stylized shape,
// scattered deterministically over the world and drawn as thin instances with
// three LODs. Only chunks inside the view cone are gathered (re-gathered when
// you move to a new cell or turn far enough), instance buffers never change
// size (so WebGPU can keep its cached render bundles), and shadows come from a
// separate set of low-poly proxies that exist only in the shadow map and only
// near the player.
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
import { freezeStatic } from './frozen';
import { setToon } from './toon';

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
  /** Not drawn beyond this distance (small things). */
  maxDist?: number;
}

const noise = new Simplex2(4242);

// LOD 0 = close-up, 1 = mid, 2 = far / shadow proxy.
function broadleaf(lod: number, variant: number): VertexData {
  const b = new MeshBuilder2();
  const rnd = mulberry(variant * 977 + 13);
  const trunkH = 3.2 + rnd() * 1.6;
  const lean: C3 = [(rnd() - 0.5) * 0.25, 1, (rnd() - 0.5) * 0.25];
  const bark = hex('#6e4a34');
  b.branch([0, -0.3, 0], lean, trunkH + 0.6, 0.38, 0.2, [8, 5, 4][lod], [3, 2, 1][lod], bark, 0, 0.05);
  const top: C3 = [lean[0] * trunkH, trunkH, lean[2] * trunkH];
  const r0 = rnd();
  const r1 = rnd();
  const r2 = rnd();
  if (lod === 0) {
    for (const a of [r0, r1, r2]) {
      const ang = a * Math.PI * 2;
      b.branch([top[0] * 0.7, trunkH * 0.7, top[2] * 0.7], [Math.cos(ang), 0.9, Math.sin(ang)], 1.8, 0.14, 0.06, 5, 1, bark, 0.05, 0.2);
    }
  }
  // anime foliage: deep teal-green undersides, sunny yellow-green crowns
  const leafA = variant % 3 === 2 ? hex('#2d5a2a') : hex('#1f4d32');
  const leafB = variant % 3 === 2 ? hex('#c2c048') : variant % 3 === 1 ? hex('#8fcf4a') : hex('#79c043');
  const canopyC: C3 = [top[0], trunkH + 1.6, top[2]];
  if (lod === 2) {
    b.blob(canopyC, [3.4, 2.7, 3.4], 1, noise, 0.2, leafA, leafB, canopyC, 0.5);
    return b.toVertexData();
  }
  b.blob(canopyC, [2.6, 2.1, 2.6], lod ? 1 : 2, noise, 0.22, leafA, leafB, canopyC, 0.5);
  const clumps = lod ? 3 : 5;
  for (let i = 0; i < clumps; i++) {
    const a = (i / clumps) * Math.PI * 2 + rnd();
    const r = 1.7 + rnd() * 0.6;
    const c: C3 = [canopyC[0] + Math.cos(a) * r, canopyC[1] + (rnd() - 0.4) * 1.4, canopyC[2] + Math.sin(a) * r];
    const s = 1.3 + rnd() * 0.6;
    b.blob(c, [s, s * 0.85, s], 1, noise, 0.25, leafA, leafB, canopyC, 0.8);
  }
  return b.toVertexData();
}

function pine(lod: number, variant: number): VertexData {
  const b = new MeshBuilder2();
  const rnd = mulberry(variant * 331 + 7);
  const h = 7 + rnd() * 3;
  b.branch([0, -0.3, 0], [0, 1, 0], h * 0.9, 0.32, 0.08, [7, 5, 4][lod], [2, 1, 1][lod], hex('#5e4232'), 0, 0.1);
  const layers = [5, 3, 2][lod];
  const segs = [11, 8, 6][lod];
  const dark = hex('#163f33');
  const light = hex('#4f9a4c');
  for (let i = 0; i < layers; i++) {
    const t = i / layers;
    const radius = 2.7 * (1 - t * 0.75) + rnd() * 0.3;
    const height = (2.6 - t * 0.6) * (0.55 + (0.45 * 5) / layers);
    b.cone(1.6 + t * h * 0.78, height, radius, segs, dark, light, 0.25 + t * 0.6, 0.18, rnd() * 6);
  }
  return b.toVertexData();
}

function birch(lod: number, variant: number): VertexData {
  const b = new MeshBuilder2();
  const rnd = mulberry(variant * 51 + 3);
  const h = 5 + rnd() * 1.5;
  b.branch([0, -0.3, 0], [(rnd() - 0.5) * 0.15, 1, (rnd() - 0.5) * 0.15], h, 0.2, 0.1, [7, 5, 4][lod], [3, 2, 1][lod], hex('#efebe2'), 0, 0.1);
  const c: C3 = [0, h + 0.4, 0];
  const leafA = hex('#2f6a2c');
  const leafB = hex('#c6d455');
  b.blob(c, lod === 2 ? [2.0, 2.6, 2.0] : [1.8, 2.4, 1.8], lod ? 1 : 2, noise, 0.3, leafA, leafB, c, 0.7);
  if (lod === 0) {
    b.blob([c[0] + 0.9, c[1] - 1.1, c[2] + 0.4], [1.1, 1.2, 1.1], 1, noise, 0.3, leafA, leafB, c, 0.8);
    b.blob([c[0] - 0.8, c[1] - 0.6, c[2] - 0.6], [1.0, 1.1, 1.0], 1, noise, 0.3, leafA, leafB, c, 0.8);
  }
  return b.toVertexData();
}

function bush(lod: number, variant: number): VertexData {
  const b = new MeshBuilder2();
  const rnd = mulberry(variant * 71 + 5);
  const c: C3 = [0, 0.5, 0];
  const a = variant % 2 ? hex('#1d4a2a') : hex('#24532a');
  const t = variant % 2 ? hex('#6fb03e') : hex('#8cc24a');
  b.blob(c, [1.2 + rnd() * 0.4, 0.95, 1.2 + rnd() * 0.4], lod === 2 ? 0 : 1, noise, 0.3, a, t, [0, -0.4, 0], 0.35, 0.5);
  if (lod === 0) b.blob([0.7, 0.35, 0.3], [0.7, 0.6, 0.7], 1, noise, 0.3, a, t, [0, -0.4, 0], 0.35, 0.5);
  return b.toVertexData();
}

function rock(lod: number, variant: number): VertexData {
  const b = new MeshBuilder2();
  const rnd = mulberry(variant * 17 + 1);
  const sub = lod === 2 ? 0 : 1;
  const stone = hex('#8f9098');
  const moss = hex('#6a9a3e');
  b.rock([0, 0, 0], [1 + rnd() * 0.4, 0.75 + rnd() * 0.3, 1 + rnd() * 0.4], noise, variant * 3.7, stone, moss, sub);
  if (variant % 2 === 0 && lod < 2) b.rock([0.9, -0.1, 0.5], [0.5, 0.45, 0.5], noise, variant * 5.1 + 2, stone, moss, sub);
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
  { id: 'bush0', build: (l) => bush(l, 0), collider: 0, shadow: true, wind: 0.6, maxDist: 220 },
  { id: 'bush1', build: (l) => bush(l, 1), collider: 0, shadow: true, wind: 0.6, maxDist: 220 },
  { id: 'rock0', build: (l) => rock(l, 0), collider: 1.0, shadow: true, wind: 0, maxDist: 320 },
  { id: 'rock1', build: (l) => rock(l, 1), collider: 1.0, shadow: true, wind: 0, maxDist: 320 },
  { id: 'rock2', build: (l) => rock(l, 2), collider: 1.0, shadow: true, wind: 0, maxDist: 320 },
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

/** One drawable set: a source mesh whose thin-instance buffer never changes size. */
interface Slot {
  mesh: Mesh;
  buf: Float32Array;
  count: number;
}

const LOD_NEAR = 40;
const LOD_MID = 140;
/** Layer only the shadow map renders (the camera's mask leaves this bit out). */
const SHADOW_ONLY_LAYER = 0x10000000;

export class Foliage {
  readonly colliders: Collider[] = [];
  private grid = new Map<number, Collider[]>();
  private chunks: Chunk[] = [];
  private lastKey = '';
  private lastYaw = 1e9;
  private lastShadowCell = '';
  private sources: { lods: Slot[]; shadow: Slot | null; mat: PBRMaterial; plugin: ShaderPlugin }[] = [];
  private totals: number[] = [];
  private q!: QualitySettings;
  private near: Chunk[] = [];
  private mid: Chunk[] = [];
  private far: Chunk[] = [];
  private shadowChunks: Chunk[] = [];
  /** Horizontal half field of view (radians), set by update(). */
  private halfFov = 0.9;

  constructor(private scene: Scene, private hm: Heightmap, private atmosphere: Atmosphere) {
    const placements = this.scatter();
    this.buildChunks(placements);
    this.buildSources();
  }

  private buildSources() {
    for (const [i, t] of TYPES.entries()) {
      const mat = new PBRMaterial('foliage_' + t.id, this.scene);
      mat.albedoColor = Color3.White();
      mat.metallic = 0;
      mat.roughness = 0.9;
      mat.backFaceCulling = true;
      const isRock = t.id.startsWith('rock');
      // leaves glow when the sun is behind them; rocks get a crisp rim
      setToon(mat, isRock ? { rim: 0.5, translucency: 0 } : { rim: 0.65, translucency: 0.5 });
      const plugin = createShaderPlugin(mat, {
        name: 'FoliageWind',
        uniforms: { windParams: 'vec4', windStrength: 'float' },
        glsl: { vertex: { CUSTOM_VERTEX_UPDATE_WORLDPOS: WIND_GLSL } },
        wgsl: { vertex: { CUSTOM_VERTEX_UPDATE_WORLDPOS: WIND_WGSL } },
      });
      plugin.values.windStrength = t.wind;
      freezeStatic(mat);
      const total = this.totals[i] ?? 0;
      const mk = (lod: number, name: string): Slot => {
        const m = new Mesh(name, this.scene);
        t.build(lod, i).applyToMesh(m);
        m.material = mat;
        m.useVertexColors = true;
        m.hasVertexAlpha = false;
        m.isPickable = false;
        m.receiveShadows = true;
        m.alwaysSelectAsActiveMesh = true;
        m.doNotSyncBoundingInfo = true;
        const buf = new Float32Array(Math.max(1, total) * 16);
        m.thinInstanceSetBuffer('matrix', buf, 16, false);
        m.thinInstanceCount = 0;
        m.isVisible = false;
        return { mesh: m, buf, count: 0 };
      };
      const lods = [mk(0, `${t.id}_L0`), mk(1, `${t.id}_L1`), mk(2, `${t.id}_L2`)];
      let shadow: Slot | null = null;
      if (t.shadow) {
        // low-poly stand-ins drawn only into the shadow map
        shadow = mk(t.id.startsWith('bush') || t.id.startsWith('rock') ? 2 : 1, `${t.id}_shadow`);
        shadow.mesh.layerMask = SHADOW_ONLY_LAYER;
        shadow.mesh.receiveShadows = false;
        this.atmosphere.addShadowCaster(shadow.mesh, false, true);
      }
      this.sources.push({ lods, shadow, mat, plugin });
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
    this.totals = TYPES.map((_, type) => list.filter((p) => p.type === type).length);
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
    this.lastKey = '';
    this.lastShadowCell = '';
  }

  update(time: number, cam: Vector3, wind: { x: number; y: number; z: number; w: number }, fwd?: Vector3, halfFov = 0.9) {
    for (const src of this.sources) src.plugin.values.windParams = [wind.x, wind.y, wind.z, time];
    this.halfFov = halfFov;
    const q = this.q;
    if (!q) return;

    // Shadow proxies: everything near the player, in every direction.
    const sCell = `${Math.floor(cam.x / 12)},${Math.floor(cam.z / 12)},${q.shadows}`;
    if (sCell !== this.lastShadowCell) {
      this.lastShadowCell = sCell;
      const r = q.shadows ? q.shadowDistance + 30 : -1;
      this.shadowChunks = this.chunks.filter((c) => Math.hypot(c.cx - cam.x, c.cz - cam.z) < r + 46);
      this.sources.forEach((src, type) => {
        if (src.shadow) this.fill(src.shadow, this.shadowChunks, type, cam, -1, r);
      });
    }

    // Visible instances: re-gather on a new 16 m cell or after turning ~10°.
    const yaw = fwd ? Math.atan2(fwd.x, fwd.z) : 0;
    let dYaw = Math.abs(yaw - this.lastYaw);
    if (dYaw > Math.PI) dYaw = Math.PI * 2 - dYaw;
    const key = `${Math.floor(cam.x / 16)},${Math.floor(cam.z / 16)}`;
    if (key === this.lastKey && dYaw < 0.17) return;
    this.lastKey = key;
    this.lastYaw = yaw;
    const maxDist = q.treeDistance;
    const near = (this.near.length = 0, this.near);
    const mid = (this.mid.length = 0, this.mid);
    const far = (this.far.length = 0, this.far);
    const cone = Math.cos(Math.min(Math.PI, this.halfFov + 0.25));
    for (const c of this.chunks) {
      const dx = c.cx - cam.x;
      const dz = c.cz - cam.z;
      const d = Math.hypot(dx, dz);
      if (d > maxDist + 46) continue;
      // keep chunks in (or touching) the view cone; everything close is kept
      if (fwd && d > 64) {
        const cosA = (dx * fwd.x + dz * fwd.z) / (d * Math.hypot(fwd.x, fwd.z) || 1);
        const pad = Math.atan(48 / d);
        if (Math.acos(Math.max(-1, Math.min(1, cosA))) > Math.acos(cone) + pad) continue;
      }
      if (d < LOD_NEAR + 46) near.push(c);
      if (d > LOD_NEAR - 46 && d < LOD_MID + 46) mid.push(c);
      if (d > LOD_MID - 46) far.push(c);
    }
    this.sources.forEach((src, type) => {
      const lim = Math.min(maxDist, TYPES[type].maxDist ?? 1e9);
      this.fill(src.lods[0], near, type, cam, 0, LOD_NEAR);
      this.fill(src.lods[1], mid, type, cam, LOD_NEAR, Math.min(LOD_MID, lim));
      this.fill(src.lods[2], far, type, cam, LOD_MID, lim);
    });
  }

  /** Copy the instances of `type` whose distance is in [d0, d1) into a slot. */
  private fill(slot: Slot, list: Chunk[], type: number, cam: Vector3, d0: number, d1: number) {
    const buf = slot.buf;
    const cap = buf.length / 16;
    let n = 0;
    const lo2 = d0 > 0 ? d0 * d0 : -1;
    const hi2 = d1 * d1;
    for (const c of list) {
      const m = c.mats[type];
      if (!m) continue;
      for (let o = 0; o < m.length && n < cap; o += 16) {
        const dx = m[o + 12] - cam.x;
        const dz = m[o + 14] - cam.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < lo2 || d2 >= hi2) continue;
        // plain copy: subarray() here allocated an object per instance and the garbage caused hitches
        const w = n * 16;
        for (let k = 0; k < 16; k++) buf[w + k] = m[o + k];
        n++;
      }
    }
    slot.count = n;
    const mesh = slot.mesh;
    mesh.isVisible = n > 0;
    mesh.thinInstanceCount = n;
    if (n > 0) mesh.thinInstanceBufferUpdated('matrix');
  }
}
