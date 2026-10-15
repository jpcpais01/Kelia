// Streaming, level-of-detail terrain built from the shared heightmap.
// 8×8 chunks of 128 m; each picks a resolution by camera distance and is
// (re)built a few per frame so movement never hitches.
import {
  Color3,
  Mesh,
  PBRMaterial,
  RawTexture,
  Texture,
  VertexData,
  type Scene,
  type Vector3,
} from '@babylonjs/core';
import { WORLD_HALF } from '@kelia/shared';
import type { TerrainData } from './terrainData';
import { createShaderPlugin } from './shaderPlugin';
import { createDetailTexture } from './textures';
import { freezeStatic } from './frozen';
import { setToon } from './toon';

// 8×8 chunks of 128 m: a quarter of the draw calls of 64 m chunks, with LOD
// distances matched so the same detail reaches the same range.
const CHUNK = 128;
const CHUNKS = (WORLD_HALF * 2) / CHUNK;
const LOD_STEPS = [1, 2, 4, 8];

const GLSL_FRAGMENT = /* glsl */ `
  vec2 kWuv = (vPositionW.xz + vec2(512.5)) / 1025.0;
  vec4 kSp = texture2D(splatMap, kWuv);
  vec4 kD = texture2D(detailTex, vPositionW.xz * 0.21);
  vec4 kD2 = texture2D(detailTex, vPositionW.xz * 0.027);
  vec4 kD3 = texture2D(detailTex, vPositionW.xz * 0.0041);
  // Height-aware blending: textures with more "height" win at borders.
  float kGrassW = clamp(1.0 - kSp.g - kSp.b - kSp.a, 0.0, 1.0);
  float kRock = kSp.g * (0.6 + kD.b * 0.8);
  float kSand = kSp.b * (0.7 + kD.r * 0.6);
  float kDirt = kSp.a * (0.5 + kD.g * 1.0);
  float kGrass = kGrassW * (0.7 + kD2.g * 0.6);
  vec3 kGrassCol = mix(grassA, grassB, smoothstep(0.25, 0.75, kD3.a));
  kGrassCol = mix(kGrassCol, grassDry, smoothstep(0.55, 0.85, kD2.a) * 0.6);
  kGrassCol *= 0.82 + 0.36 * kD.r;
  kGrassCol = mix(kGrassCol, forestCol * (0.8 + 0.45 * kD.g), kSp.r);
  vec3 kRockCol = rockCol * (0.68 + 0.55 * kD.b) * (0.85 + 0.3 * kD2.r);
  vec3 kSandCol = sandCol * (0.88 + 0.2 * kD.r);
  vec3 kDirtCol = dirtCol * (0.75 + 0.4 * kD.g) * (0.9 + 0.2 * kD2.r);
  float kSum = max(kGrass + kRock + kSand + kDirt, 0.0001);
  vec3 kCol = (kGrassCol * kGrass + kRockCol * kRock + kSandCol * kSand + kDirtCol * kDirt) / kSum;
  // Damp ground near water
  kCol *= mix(1.0, 0.78, smoothstep(0.35, 0.9, kSp.b) * 0.5);
  surfaceAlbedo = kCol;
`;

const WGSL_FRAGMENT = /* wgsl */ `
  let kWuv = (fragmentInputs.vPositionW.xz + vec2f(512.5)) / 1025.0;
  let kSp = textureSample(splatMap, splatMapSampler, kWuv);
  let kD = textureSample(detailTex, detailTexSampler, fragmentInputs.vPositionW.xz * 0.21);
  let kD2 = textureSample(detailTex, detailTexSampler, fragmentInputs.vPositionW.xz * 0.027);
  let kD3 = textureSample(detailTex, detailTexSampler, fragmentInputs.vPositionW.xz * 0.0041);
  let kGrassW = clamp(1.0 - kSp.g - kSp.b - kSp.a, 0.0, 1.0);
  let kRock = kSp.g * (0.6 + kD.b * 0.8);
  let kSand = kSp.b * (0.7 + kD.r * 0.6);
  let kDirt = kSp.a * (0.5 + kD.g * 1.0);
  let kGrass = kGrassW * (0.7 + kD2.g * 0.6);
  var kGrassCol = mix(uniforms.grassA, uniforms.grassB, smoothstep(0.25, 0.75, kD3.a));
  kGrassCol = mix(kGrassCol, uniforms.grassDry, smoothstep(0.55, 0.85, kD2.a) * 0.6);
  kGrassCol = kGrassCol * (0.82 + 0.36 * kD.r);
  kGrassCol = mix(kGrassCol, uniforms.forestCol * (0.8 + 0.45 * kD.g), kSp.r);
  let kRockCol = uniforms.rockCol * (0.68 + 0.55 * kD.b) * (0.85 + 0.3 * kD2.r);
  let kSandCol = uniforms.sandCol * (0.88 + 0.2 * kD.r);
  let kDirtCol = uniforms.dirtCol * (0.75 + 0.4 * kD.g) * (0.9 + 0.2 * kD2.r);
  let kSum = max(kGrass + kRock + kSand + kDirt, 0.0001);
  var kCol = (kGrassCol * kGrass + kRockCol * kRock + kSandCol * kSand + kDirtCol * kDirt) / kSum;
  kCol = kCol * mix(1.0, 0.78, smoothstep(0.35, 0.9, kSp.b) * 0.5);
  surfaceAlbedo = kCol;
`;

const lin = (hex: string) => {
  const c = Color3.FromHexString(hex).toLinearSpace();
  return [c.r, c.g, c.b];
};

interface Chunk {
  ci: number;
  cj: number;
  cx: number;
  cz: number;
  lod: number;
  meshes: (Mesh | null)[];
  pending: number;
}

export class Terrain {
  readonly material: PBRMaterial;
  readonly splatTexture: RawTexture;
  readonly detailTexture: Texture;
  /** Heightmap as a float texture (r = height), used by grass and water shaders. */
  readonly heightTexture: RawTexture;
  private chunks: Chunk[] = [];
  private queue: Chunk[] = [];
  lodScale = 1;

  constructor(private scene: Scene, private data: TerrainData) {
    const size = data.heightmap.size;
    this.splatTexture = RawTexture.CreateRGBATexture(data.splat, size, size, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
    this.splatTexture.wrapU = this.splatTexture.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.heightTexture = RawTexture.CreateRTexture(data.heightmap.data, size, size, scene, false, false, Texture.NEAREST_SAMPLINGMODE, 1 /* TEXTURETYPE_FLOAT */);
    this.heightTexture.wrapU = this.heightTexture.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.detailTexture = createDetailTexture(scene);

    const mat = new PBRMaterial('terrain', scene);
    mat.metallic = 0;
    mat.roughness = 0.97;
    mat.albedoColor = Color3.White();
    this.material = mat;
    freezeStatic(mat);
    // ground has no rim light (it would make every distant slope glow)
    setToon(mat, { rim: 0 });
    const plugin = createShaderPlugin(mat, {
      name: 'TerrainSplat',
      uniforms: { grassA: 'vec3', grassB: 'vec3', grassDry: 'vec3', forestCol: 'vec3', rockCol: 'vec3', sandCol: 'vec3', dirtCol: 'vec3' },
      samplers: ['splatMap', 'detailTex'],
      glsl: { fragment: { CUSTOM_FRAGMENT_BEFORE_LIGHTS: GLSL_FRAGMENT } },
      wgsl: { fragment: { CUSTOM_FRAGMENT_BEFORE_LIGHTS: WGSL_FRAGMENT } },
    });
    Object.assign(plugin.values, {
      grassA: lin('#3c7a2c'),
      grassB: lin('#5d9c37'),
      grassDry: lin('#b0ac58'),
      forestCol: lin('#2e6230'),
      rockCol: lin('#8d8e96'),
      sandCol: lin('#e3d3a2'),
      dirtCol: lin('#9a7a58'),
    });
    plugin.textures.splatMap = this.splatTexture;
    plugin.textures.detailTex = this.detailTexture;

    for (let cj = 0; cj < CHUNKS; cj++) {
      for (let ci = 0; ci < CHUNKS; ci++) {
        this.chunks.push({
          ci,
          cj,
          cx: -WORLD_HALF + (ci + 0.5) * CHUNK,
          cz: -WORLD_HALF + (cj + 0.5) * CHUNK,
          lod: -1,
          meshes: [null, null, null, null],
          pending: -1,
        });
      }
    }
  }

  private desiredLod(c: Chunk, cam: Vector3) {
    const d = Math.hypot(c.cx - cam.x, c.cz - cam.z) / this.lodScale;
    return d < 140 ? 0 : d < 260 ? 1 : d < 460 ? 2 : 3;
  }

  /** Build everything at a coarse LOD immediately, then refine near the camera. */
  buildInitial(cam: Vector3) {
    for (const c of this.chunks) {
      const lod = Math.max(2, this.desiredLod(c, cam));
      this.setLod(c, lod);
    }
    this.update(cam, 1e9);
  }

  update(cam: Vector3, budgetMs = 3) {
    for (const c of this.chunks) {
      const want = this.desiredLod(c, cam);
      if (want !== c.lod && c.pending !== want) {
        c.pending = want;
        this.queue.push(c);
      }
    }
    if (!this.queue.length) return;
    // Nearest first.
    this.queue.sort((a, b) => Math.hypot(a.cx - cam.x, a.cz - cam.z) - Math.hypot(b.cx - cam.x, b.cz - cam.z));
    const t0 = performance.now();
    while (this.queue.length && performance.now() - t0 < budgetMs) {
      const c = this.queue.shift()!;
      if (c.pending >= 0) this.setLod(c, c.pending);
      c.pending = -1;
    }
  }

  private setLod(c: Chunk, lod: number) {
    if (!c.meshes[lod]) c.meshes[lod] = this.buildChunk(c, lod);
    for (let l = 0; l < c.meshes.length; l++) {
      const m = c.meshes[l];
      if (!m) continue;
      m.setEnabled(l === lod);
      // Free detailed meshes we've walked far away from.
      if (l < lod - 1 && l <= 1) {
        m.dispose();
        c.meshes[l] = null;
      }
    }
    c.lod = lod;
  }

  private buildChunk(c: Chunk, lod: number): Mesh {
    const step = LOD_STEPS[lod];
    const hm = this.data.heightmap;
    const n = CHUNK / step + 1;
    const x0 = -WORLD_HALF + c.ci * CHUNK;
    const z0 = -WORLD_HALF + c.cj * CHUNK;
    const vCount = n * n + 4 * n;
    const positions = new Float32Array(vCount * 3);
    const normals = new Float32Array(vCount * 3);
    const indices: number[] = [];
    const nrm = { x: 0, y: 1, z: 0 };
    let v = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = x0 + i * step;
        const z = z0 + j * step;
        const gi = Math.round((x + WORLD_HALF) / hm.step);
        const gj = Math.round((z + WORLD_HALF) / hm.step);
        positions[v * 3] = x;
        positions[v * 3 + 1] = hm.at(gi, gj);
        positions[v * 3 + 2] = z;
        hm.normal(x, z, nrm);
        normals[v * 3] = nrm.x;
        normals[v * 3 + 1] = nrm.y;
        normals[v * 3 + 2] = nrm.z;
        v++;
      }
    }
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        const b = a + 1;
        const cc = a + n;
        const d = cc + 1;
        // Same diagonal as Heightmap.sample (a -> d).
        indices.push(a, b, d, a, d, cc);
      }
    }
    // Skirts hide cracks between neighbouring chunks at different LODs.
    const drop = step * 1.5 + 1;
    const edges: number[][] = [
      Array.from({ length: n }, (_, i) => i), // south row
      Array.from({ length: n }, (_, i) => (n - 1) * n + i), // north row
      Array.from({ length: n }, (_, j) => j * n), // west col
      Array.from({ length: n }, (_, j) => j * n + n - 1), // east col
    ];
    edges.forEach((edge, e) => {
      const start = v;
      for (const idx of edge) {
        positions[v * 3] = positions[idx * 3];
        positions[v * 3 + 1] = positions[idx * 3 + 1] - drop;
        positions[v * 3 + 2] = positions[idx * 3 + 2];
        normals[v * 3] = normals[idx * 3];
        normals[v * 3 + 1] = normals[idx * 3 + 1];
        normals[v * 3 + 2] = normals[idx * 3 + 2];
        v++;
      }
      for (let k = 0; k < n - 1; k++) {
        const t0 = edge[k];
        const t1 = edge[k + 1];
        const b0 = start + k;
        const b1 = start + k + 1;
        // Winding so the skirt faces outward.
        if (e === 0 || e === 3) indices.push(t0, b1, t1, t0, b0, b1);
        else indices.push(t0, t1, b1, t0, b1, b0);
      }
    });
    const mesh = new Mesh(`terrain_${c.ci}_${c.cj}_L${lod}`, this.scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.normals = normals;
    vd.indices = vCount > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
    vd.applyToMesh(mesh, false);
    mesh.material = this.material;
    mesh.receiveShadows = true;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;
    mesh.cullingStrategy = Mesh.CULLINGSTRATEGY_BOUNDINGSPHERE_ONLY;
    return mesh;
  }

  dispose() {
    for (const c of this.chunks) for (const m of c.meshes) m?.dispose();
    this.material.dispose();
  }
}
