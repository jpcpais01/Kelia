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
} from '@babylonjs/core';
import {
  LAKE,
  RUINS,
  SHRINE,
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
import { LEAF_CUTOFF, getLeafAtlas } from './leafAtlas';
import { CARD_CORNER_KIND } from './meshgen';
import { birch, blossom, broadleaf, buildHorizon, bush, pine, rock, type Built } from './trees';
import { createShaderPlugin, type ShaderPlugin } from './shaderPlugin';
import { freezeStatic } from './frozen';
import { setToon } from './toon';
import type { Blob } from './worldLight';

const CHUNK = 64;

interface TreeType {
  id: string;
  build: (lod: number) => Built;
  collider: number; // trunk radius
  shadow: boolean;
  wind: number;
  /** Not drawn beyond this distance (small things). */
  maxDist?: number;
  /** Leaf cards (alpha-tested atlas, camera-facing); false = plain opaque (rocks). */
  cards: boolean;
}

const TYPES: TreeType[] = [
  { id: 'oak0', build: (l) => broadleaf(l, 0), collider: 0.55, shadow: true, wind: 1, cards: true },
  { id: 'oak1', build: (l) => broadleaf(l, 1), collider: 0.55, shadow: true, wind: 1, cards: true },
  { id: 'oak2', build: (l) => broadleaf(l, 2), collider: 0.55, shadow: true, wind: 1, cards: true },
  { id: 'pine0', build: (l) => pine(l, 0), collider: 0.45, shadow: true, wind: 0.6, cards: true },
  { id: 'pine1', build: (l) => pine(l, 1), collider: 0.45, shadow: true, wind: 0.6, cards: true },
  { id: 'birch', build: (l) => birch(l, 0), collider: 0.35, shadow: true, wind: 1.2, cards: true },
  { id: 'birch1', build: (l) => birch(l, 1), collider: 0.4, shadow: true, wind: 1.2, cards: true },
  { id: 'blossom0', build: (l) => blossom(l, 0), collider: 0.45, shadow: true, wind: 1.1, cards: true },
  { id: 'blossom1', build: (l) => blossom(l, 1), collider: 0.45, shadow: true, wind: 1.1, cards: true },
  { id: 'bush0', build: (l) => bush(l, 0), collider: 0, shadow: true, wind: 0.6, maxDist: 220, cards: true },
  { id: 'bush1', build: (l) => bush(l, 1), collider: 0, shadow: true, wind: 0.6, maxDist: 220, cards: true },
  { id: 'bush3', build: (l) => bush(l, 3), collider: 0, shadow: true, wind: 0.6, maxDist: 220, cards: true },
  { id: 'rock0', build: (l) => rock(l, 0), collider: 1.0, shadow: true, wind: 0, maxDist: 320, cards: false },
  { id: 'rock1', build: (l) => rock(l, 1), collider: 1.0, shadow: true, wind: 0, maxDist: 320, cards: false },
  { id: 'rock2', build: (l) => rock(l, 2), collider: 1.0, shadow: true, wind: 0, maxDist: 320, cards: false },
];
const T = Object.fromEntries(TYPES.map((t, i) => [t.id, i])) as Record<string, number>;

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

// Leaf cards: each card's four corners share its centre; spread them along the
// camera's right/up axes so the card always faces the viewer.
const CARD_DEFS_GLSL = /* glsl */ `
#ifdef KCARDS
attribute vec2 cardCorner;
#endif
`;
const CARD_DEFS_WGSL = /* wgsl */ `
#ifdef KCARDS
attribute cardCorner: vec2f;
#endif
`;

const WIND_GLSL = /* glsl */ `
#ifdef KCARDS
  {
    float kS = length(finalWorld[0].xyz);
    vec3 kRight = vec3(view[0][0], view[1][0], view[2][0]);
    vec3 kUp = vec3(view[0][1], view[1][1], view[2][1]);
    worldPos.xyz += (kRight * cardCorner.x + kUp * cardCorner.y) * kS;
  }
#endif
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
  vPositionW = vec3(worldPos);
`;

// Every tree is a little different: a per-instance hash (from its root
// position) shifts the bark (right half of the atlas) and the leaves toward
// warmer or cooler, lighter or darker, so no two neighbours match.
const TINT_GLSL = /* glsl */ `
#ifdef KCARDS
  {
    vec3 kP = fract(kRoot.xzx * vec3(0.1031, 0.1030, 0.0973));
    kP += dot(kP, kP.yzx + 33.33);
    vec3 kH3 = fract((kP.xxy + kP.yzz) * kP.zyx);
    vec3 kTint;
    if (uv.x > 0.5) kTint = mix(vec3(1.1, 1.0, 0.88), vec3(0.88, 0.93, 1.04), kH3.x) * (0.8 + 0.34 * kH3.y);
    else kTint = mix(vec3(1.07, 1.03, 0.84), vec3(0.9, 1.0, 1.07), kH3.x) * (0.88 + 0.22 * kH3.z);
    vColor.rgb *= kTint;
  }
#endif
`;
const TINT_WGSL = /* wgsl */ `
#ifdef KCARDS
  {
    var kP = fract(kRoot.xzx * vec3f(0.1031, 0.1030, 0.0973));
    kP += dot(kP, kP.yzx + 33.33);
    let kH3 = fract((kP.xxy + kP.yzz) * kP.zyx);
    var kTint: vec3f;
    if (vertexInputs.uv.x > 0.5) { kTint = mix(vec3f(1.1, 1.0, 0.88), vec3f(0.88, 0.93, 1.04), kH3.x) * (0.8 + 0.34 * kH3.y); }
    else { kTint = mix(vec3f(1.07, 1.03, 0.84), vec3f(0.9, 1.0, 1.07), kH3.x) * (0.88 + 0.22 * kH3.z); }
    vertexOutputs.vColor = vec4f(vertexOutputs.vColor.rgb * kTint, vertexOutputs.vColor.a);
  }
#endif
`;

const WIND_WGSL = /* wgsl */ `
#ifdef KCARDS
  {
    let kS = length(finalWorld[0].xyz);
    let kRight = vec3f(scene.view[0][0], scene.view[1][0], scene.view[2][0]);
    let kUp = vec3f(scene.view[0][1], scene.view[1][1], scene.view[2][1]);
    worldPos = vec4f(worldPos.xyz + (kRight * vertexInputs.cardCorner.x + kUp * vertexInputs.cardCorner.y) * kS, worldPos.w);
  }
#endif
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
  vertexOutputs.vPositionW = worldPos.xyz;
`;

/** One drawable set: a source mesh whose thin-instance buffer never changes size. */
interface Slot {
  mesh: Mesh;
  buf: Float32Array;
  count: number;
}

const LOD_NEAR = 40;
const LOD_MID = 140;
/** Past this, trees switch to their horizon LOD (no limbs, only the trunk). */
const LOD_HORIZON = 280;
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
  private horizon: Chunk[] = [];
  private shadowChunks: Chunk[] = [];
  /** Horizontal half field of view (radians), set by update(). */
  private halfFov = 0.9;
  private placements: Placement[];
  /** Per type: the crown (or rock) as an ellipsoid in model space. */
  private shapes: { x: number; y: number; z: number; r: number; ry: number }[] = [];

  constructor(private scene: Scene, private hm: Heightmap, private atmosphere: Atmosphere) {
    this.placements = this.scatter();
    this.buildChunks(this.placements);
    this.buildSources();
  }

  /** Every tree crown, bush and rock as an ellipsoid, for the baked world lighting. */
  occluders(): Blob[] {
    return this.placements.map((p) => {
      const sh = this.shapes[p.type];
      const c = Math.cos(p.rot);
      const s = Math.sin(p.rot);
      return {
        x: p.x + (sh.x * c + sh.z * s) * p.scale,
        y: p.y + sh.y * p.scale,
        z: p.z + (-sh.x * s + sh.z * c) * p.scale,
        r: sh.r * p.scale,
        ry: sh.ry * p.scale,
        canopy: TYPES[p.type].cards,
      };
    });
  }

  /** Bounds of the leaves (or of the whole rock) of a model. */
  private measureShape(m: Mesh, cards: boolean) {
    const pos = m.getVerticesData('position');
    const cor = cards ? m.getVerticesData(CARD_CORNER_KIND) : null;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    if (pos) {
      for (let v = 0; v < pos.length / 3; v++) {
        // leaf cards have a corner offset; trunks and limbs don't
        const pad = cor ? Math.hypot(cor[v * 2], cor[v * 2 + 1]) : 0;
        if (cor && pad === 0) continue;
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], pos[v * 3 + k] - pad);
          hi[k] = Math.max(hi[k], pos[v * 3 + k] + pad);
        }
      }
    }
    if (!Number.isFinite(lo[0])) return { x: 0, y: 0, z: 0, r: 0.01, ry: 0.01 };
    return {
      x: (lo[0] + hi[0]) / 2,
      y: (lo[1] + hi[1]) / 2,
      z: (lo[2] + hi[2]) / 2,
      r: Math.max(hi[0] - lo[0], hi[2] - lo[2]) / 2,
      ry: (hi[1] - lo[1]) / 2,
    };
  }

  private buildSources() {
    const atlas = getLeafAtlas(this.scene);
    // one plain material for every shadow-only stand-in (the shadow pass needs no textures)
    const proxyMat = new PBRMaterial('foliage_shadowProxy', this.scene);
    proxyMat.metallic = 0;
    proxyMat.roughness = 1;
    freezeStatic(proxyMat);
    for (const [i, t] of TYPES.entries()) {
      const mat = new PBRMaterial('foliage_' + t.id, this.scene);
      mat.albedoColor = Color3.White();
      mat.metallic = 0;
      mat.roughness = 0.9;
      if (t.cards) {
        // painted leaf clusters, alpha-tested (no blending, no sorting)
        mat.albedoTexture = atlas;
        mat.useAlphaFromAlbedoTexture = true;
        mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
        mat.alphaCutOff = LEAF_CUTOFF;
        mat.backFaceCulling = false;
      } else mat.backFaceCulling = true;
      // leaves glow when the sun is behind them; rocks get a crisp rim
      setToon(mat, t.cards ? { rim: 0.55, translucency: 0.6 } : { rim: 0.55, translucency: 0, spec: 0.15 });
      const plugin = createShaderPlugin(mat, {
        name: 'FoliageWind',
        uniforms: { windParams: 'vec4', windStrength: 'float' },
        attributes: t.cards ? [CARD_CORNER_KIND] : [],
        defines: t.cards ? { KCARDS: true } : {},
        glsl: { vertex: { CUSTOM_VERTEX_DEFINITIONS: CARD_DEFS_GLSL, CUSTOM_VERTEX_UPDATE_WORLDPOS: WIND_GLSL, CUSTOM_VERTEX_MAIN_END: TINT_GLSL } },
        wgsl: { vertex: { CUSTOM_VERTEX_DEFINITIONS: CARD_DEFS_WGSL, CUSTOM_VERTEX_UPDATE_WORLDPOS: WIND_WGSL, CUSTOM_VERTEX_MAIN_END: TINT_WGSL } },
      });
      plugin.values.windStrength = t.wind;
      freezeStatic(mat);
      const total = this.totals[i] ?? 0;
      const mk = (lod: number, name: string, build = () => t.build(lod)): Slot => {
        const m = new Mesh(name, this.scene);
        const built = build();
        built.data.applyToMesh(m);
        if (built.corners) m.setVerticesData(CARD_CORNER_KIND, built.corners, false, 2);
        m.material = lod === 3 ? proxyMat : mat;
        m.useVertexColors = true;
        m.hasVertexAlpha = false;
        m.isPickable = false;
        m.receiveShadows = true;
        m.alwaysSelectAsActiveMesh = true;
        m.doNotSyncBoundingInfo = true;
        m.freezeWorldMatrix();
        const buf = new Float32Array(Math.max(1, total) * 16);
        m.thinInstanceSetBuffer('matrix', buf, 16, false);
        m.thinInstanceCount = 0;
        m.isVisible = false;
        return { mesh: m, buf, count: 0 };
      };
      const lods = [mk(0, `${t.id}_L0`), mk(1, `${t.id}_L1`), mk(2, `${t.id}_L2`)];
      this.shapes[i] = this.measureShape(lods[1].mesh, t.cards);
      // trees seen across the valley get a stripped-down horizon LOD
      if (t.cards && t.maxDist === undefined) lods.push(mk(2, `${t.id}_L3`, () => buildHorizon(() => t.build(2))));
      let shadow: Slot | null = null;
      if (t.shadow) {
        // low-poly opaque stand-ins drawn only into the shadow map
        shadow = mk(t.cards ? 3 : 2, `${t.id}_shadow`);
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
        const dv = dist(x, z, VILLAGE.center);
        // a loose ring of flowering trees just outside the village
        const villageRing = dv > VILLAGE.radius + 12 && dv < VILLAGE.radius + 70;
        if (villageRing) pTree += 0.05;
        if (dv < VILLAGE.radius + 12) pTree = pBush = pRock = 0;
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
          // pines up north and on high ground, birches near water, blossoms
          // around the village and dotted over open meadows, oaks elsewhere
          const nearWater = waterAt(x + 12, z) > -Infinity || waterAt(x - 12, z) > -Infinity;
          let type: number;
          const r1 = hash2(i, j, 6);
          const r2 = hash2(i, j, 10);
          if (z > 180 || h > 40 || (f > 0.5 && r1 < 0.3)) type = r1 < 0.5 ? T.pine0 : T.pine1;
          else if (nearWater && r1 < 0.6) type = r2 < 0.45 ? T.birch1 : T.birch;
          else if ((villageRing || f < 0.2) && r2 < (villageRing ? 0.6 : 0.4)) type = r2 < 0.2 ? T.blossom1 : T.blossom0;
          else type = r1 < 0.34 ? T.oak0 : r1 < 0.67 ? T.oak1 : T.oak2;
          out.push({ type, x, y: h, z, rot, scale: sc });
        } else if (r0 < pTree + pBush) {
          const rb = hash2(i, j, 7);
          out.push({ type: rb < 0.45 ? T.bush0 : rb < 0.8 ? T.bush1 : T.bush3, x, y: h, z, rot, scale: sc });
        } else if (r0 < pTree + pBush + pRock) {
          const big = hills > 0.3 ? 1.5 + hash2(i, j, 8) * 2.5 : 0.6 + hash2(i, j, 8) * 0.9;
          out.push({ type: T.rock0 + Math.floor(hash2(i, j, 9) * 3), x, y: h - 0.2 * big, z, rot, scale: big });
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
          const t = TYPES[items[0].type];
          // trees also get their own proportions and a slight natural lean
          const vary = t.cards && t.collider > 0;
          items.forEach((p, k) => {
            const h1 = hash2(Math.floor(p.x * 7.3), Math.floor(p.z * 7.3), 21);
            const h2 = hash2(Math.floor(p.x * 7.3), Math.floor(p.z * 7.3), 22);
            const h3 = hash2(Math.floor(p.x * 7.3), Math.floor(p.z * 7.3), 23);
            const tall = vary ? 0.86 + h1 * 0.34 : 1;
            const wide = vary ? (0.9 + h2 * 0.22) / Math.sqrt(tall) : 1;
            Quaternion.RotationYawPitchRollToRef(p.rot, vary ? (h3 - 0.5) * 0.08 : 0, vary ? (h2 - 0.5) * 0.08 : 0, q);
            s.set(p.scale * wide, p.scale * tall, p.scale * wide);
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
    const horizon = (this.horizon.length = 0, this.horizon);
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
      if (d > LOD_HORIZON - 46) horizon.push(c);
    }
    this.sources.forEach((src, type) => {
      const lim = Math.min(maxDist, TYPES[type].maxDist ?? 1e9);
      this.fill(src.lods[0], near, type, cam, 0, LOD_NEAR);
      this.fill(src.lods[1], mid, type, cam, LOD_NEAR, Math.min(LOD_MID, lim));
      if (src.lods[3]) {
        this.fill(src.lods[2], far, type, cam, LOD_MID, Math.min(LOD_HORIZON, lim));
        this.fill(src.lods[3], horizon, type, cam, LOD_HORIZON, lim);
      } else this.fill(src.lods[2], far, type, cam, LOD_MID, lim);
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
