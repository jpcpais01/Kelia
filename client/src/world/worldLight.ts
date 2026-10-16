// Baked world lighting: the "global illumination" layer under the toon model.
//
// Real-time ray tracing is out of reach in a browser at a playable frame rate,
// so the expensive part (where light is blocked and where it bounces) is
// worked out once, at load, from the world itself, and every lit surface reads
// it back with two texture taps:
//
//   light map  512² over the whole world (2 m texels), half float
//     r = sky visibility at ground level: valleys, building bases, rock and
//         wall corners get darker (horizon-based ambient occlusion, traced
//         over the terrain and every building, rock and prop in 8 directions)
//     g = ground height (so a surface knows how high above the ground it is:
//         occlusion fades out up a wall, roofs and tree tops stay open)
//     b = canopy cover (tree crowns and bushes overhead)
//     a = canopy top height
//   bounce map 128² (8 m texels): the colour of the ground nearby, which tints
//     the light bouncing up from it (green under meadows, warm near sand).
//   detail map 2048² (0.5 m texels), one byte: short-range contact occlusion
//     right at the foot of things (walls, fences, crates, rocks, tree trunks),
//     the dark crease that makes them sit on the ground instead of on it. It
//     is only traced near solids, so the open meadows cost nothing to bake.
//
// Under trees the sky light dims and turns green, and past the edge of the
// real-time shadow map the canopy keeps shading the forest floor, so distant
// woods no longer look lit from inside.
import { Constants, RawTexture, Texture, Vector4, type AbstractMesh, type Scene } from '@babylonjs/core';
import { WORLD_HALF, type Heightmap } from '@kelia/shared';
import { GROUND } from './palette';
import { ROCK_COLOURS } from './mountains';

export const LM_SIZE = 512;
const CELL = (WORLD_HALF * 2) / LM_SIZE;
export const BOUNCE_SIZE = 128;
export const DETAIL_SIZE = 2048;
const DCELL = (WORLD_HALF * 2) / DETAIL_SIZE;

/** An occluder stamped into the map: an ellipsoid (a tree crown, a bush, a rock). */
export interface Blob {
  x: number;
  y: number;
  z: number;
  /** Horizontal and vertical radius. */
  r: number;
  ry: number;
  /** Leaves (soft, see-through canopy) or solid (rocks). */
  canopy: boolean;
}

export const worldLight = {
  map: null as RawTexture | null,
  bounce: null as RawTexture | null,
  detail: null as RawTexture | null,
  /** xy = shadow-map centre (xz), z = shadow-map radius (0 = no real-time shadows), w = unused. */
  shadow: new Vector4(0, 0, 0, 0),
  /** x = ambient occlusion, y = canopy sky dimming, z = canopy sun dimming (past the shadow map), w = bounce tint. */
  strength: new Vector4(0, 0, 0, 0),
};

// --- half floats ------------------------------------------------------------
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(v: number) {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 127 + 15;
  const m = x & 0x7fffff;
  if (e <= 0) return sign;
  if (e >= 31) return sign | 0x7bff;
  // round to nearest
  let h = sign | (e << 10) | (m >>> 13);
  if (m & 0x1000) h++;
  return h;
}

/** Create neutral maps (nothing occluded) so every material can bind them from the first frame. */
export function createWorldLight(scene: Scene) {
  const n = LM_SIZE * LM_SIZE;
  const data = new Uint16Array(n * 4);
  const one = toHalf(1);
  const low = toHalf(-1000);
  for (let i = 0; i < n; i++) {
    data[i * 4] = one;
    data[i * 4 + 1] = low;
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = low;
  }
  const map = new RawTexture(data, LM_SIZE, LM_SIZE, Constants.TEXTUREFORMAT_RGBA, scene, false, false, Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_HALF_FLOAT);
  map.name = 'worldLight';
  map.wrapU = map.wrapV = Texture.CLAMP_ADDRESSMODE;
  const b = new Uint8Array(BOUNCE_SIZE * BOUNCE_SIZE * 4).fill(128);
  const bounce = RawTexture.CreateRGBATexture(b, BOUNCE_SIZE, BOUNCE_SIZE, scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
  bounce.name = 'worldBounce';
  bounce.wrapU = bounce.wrapV = Texture.CLAMP_ADDRESSMODE;
  const detail = new RawTexture(new Uint8Array(DETAIL_SIZE * DETAIL_SIZE).fill(255), DETAIL_SIZE, DETAIL_SIZE, Constants.TEXTUREFORMAT_R, scene, false, false, Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE);
  detail.name = 'worldDetailAO';
  detail.wrapU = detail.wrapV = Texture.CLAMP_ADDRESSMODE;
  worldLight.map = map;
  worldLight.bounce = bounce;
  worldLight.detail = detail;
  worldLight.strength.set(0, 0, 0, 0);
}

const idx = (i: number, j: number) => j * LM_SIZE + i;
const cellOf = (v: number, cell = CELL) => Math.floor((v + WORLD_HALF) / cell);

/** Max height of everything solid in each cell (buildings, walls, rocks, props), from their triangles. */
function stampMeshes(meshes: AbstractMesh[], solid: Float32Array, N = LM_SIZE, spacing = 0.5) {
  const cell = (WORLD_HALF * 2) / N;
  for (const m of meshes) {
    const pos = m.getVerticesData('position');
    const ind = m.getIndices();
    if (!pos || !ind) continue;
    const wm = m.computeWorldMatrix(true).m;
    const n = pos.length / 3;
    const w = new Float32Array(n * 3);
    for (let v = 0; v < n; v++) {
      const x = pos[v * 3];
      const y = pos[v * 3 + 1];
      const z = pos[v * 3 + 2];
      w[v * 3] = x * wm[0] + y * wm[4] + z * wm[8] + wm[12];
      w[v * 3 + 1] = x * wm[1] + y * wm[5] + z * wm[9] + wm[13];
      w[v * 3 + 2] = x * wm[2] + y * wm[6] + z * wm[10] + wm[14];
    }
    for (let t = 0; t < ind.length; t += 3) {
      const a = ind[t] * 3;
      const b = ind[t + 1] * 3;
      const c = ind[t + 2] * 3;
      const e1x = w[b] - w[a], e1y = w[b + 1] - w[a + 1], e1z = w[b + 2] - w[a + 2];
      const e2x = w[c] - w[a], e2y = w[c + 1] - w[a + 1], e2z = w[c + 2] - w[a + 2];
      // walk the triangle at `spacing` cells (vertical walls project to lines)
      const len = Math.max(Math.hypot(e1x, e1z), Math.hypot(e2x, e2z), Math.hypot(e2x - e1x, e2z - e1z));
      const steps = Math.min(96, Math.ceil(len / (cell * spacing)));
      for (let p = 0; p <= steps; p++) {
        for (let q = 0; q <= steps - p; q++) {
          const u = steps ? p / steps : 0;
          const v = steps ? q / steps : 0;
          const i = cellOf(w[a] + e1x * u + e2x * v, cell);
          const j = cellOf(w[a + 2] + e1z * u + e2z * v, cell);
          if (i < 0 || j < 0 || i >= N || j >= N) continue;
          const y = w[a + 1] + e1y * u + e2y * v;
          const k = j * N + i;
          if (y > solid[k]) solid[k] = y;
        }
      }
    }
  }
}

function stampBlobs(blobs: Blob[], solid: Float32Array, cover: Float32Array, top: Float32Array) {
  const N = LM_SIZE;
  for (const b of blobs) {
    const i0 = Math.max(0, cellOf(b.x - b.r));
    const i1 = Math.min(N - 1, cellOf(b.x + b.r));
    const j0 = Math.max(0, cellOf(b.z - b.r));
    const j1 = Math.min(N - 1, cellOf(b.z + b.r));
    for (let j = j0; j <= j1; j++) {
      const z = -WORLD_HALF + (j + 0.5) * CELL;
      for (let i = i0; i <= i1; i++) {
        const x = -WORLD_HALF + (i + 0.5) * CELL;
        const d2 = ((x - b.x) ** 2 + (z - b.z) ** 2) / (b.r * b.r);
        if (d2 >= 1) continue;
        const s = Math.sqrt(1 - d2);
        const k = idx(i, j);
        const h = b.y + b.ry * s;
        if (b.canopy) {
          // leaf cards leave gaps: a crown is never fully opaque
          const c = 0.85 * Math.min(1, s * 1.6);
          cover[k] = 1 - (1 - cover[k]) * (1 - c);
          if (h > top[k]) top[k] = h;
        } else if (h > solid[k]) solid[k] = h;
      }
    }
  }
}

/** 3×3 box blur, `passes` times. */
function blur(src: Float32Array, passes: number) {
  const N = LM_SIZE;
  let a: Float32Array = src;
  let b: Float32Array = new Float32Array(a.length);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        let s = 0;
        let n = 0;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= N) continue;
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            if (ii < 0 || ii >= N) continue;
            s += a[jj * N + ii];
            n++;
          }
        }
        b[j * N + i] = s / n;
      }
    }
    [a, b] = [b, a];
  }
  if (a !== src) src.set(a);
}

/** Horizon-based sky visibility at the ground, over terrain and solids. */
function traceOcclusion(ground: Float32Array, height: Float32Array, out: Float32Array) {
  const N = LM_SIZE;
  const DIRS = 8;
  const dist = [2, 4, 6, 9, 14, 22, 34, 52];
  const steps = dist.map((d) => d / CELL);
  const dx: number[] = [];
  const dz: number[] = [];
  for (let d = 0; d < DIRS; d++) {
    const a = (d / DIRS) * Math.PI * 2 + 0.2;
    dx.push(Math.cos(a));
    dz.push(Math.sin(a));
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const h0 = ground[k] + 0.4;
      let occ = 0;
      for (let d = 0; d < DIRS; d++) {
        let best = 0;
        for (let s = 0; s < steps.length; s++) {
          const ii = Math.round(i + dx[d] * steps[s]);
          const jj = Math.round(j + dz[d] * steps[s]);
          if (ii < 0 || jj < 0 || ii >= N || jj >= N) break;
          const t = (height[jj * N + ii] - h0) / dist[s];
          if (t > best) best = t;
        }
        // cosine-weighted: the share of sky light hidden below that horizon
        occ += (best * best) / (1 + best * best);
      }
      out[k] = 1 - occ / DIRS;
    }
  }
}

/**
 * Bake the maps from the terrain, the solid meshes (buildings, ruins, props)
 * and the scattered trees, bushes and rocks.
 */
export function bakeWorldLight(hm: Heightmap, splat: Uint8Array, meshes: AbstractMesh[], blobs: Blob[], posts: Post[] = []) {
  const N = LM_SIZE;
  const ground = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) ground[idx(i, j)] = hm.sample(-WORLD_HALF + (i + 0.5) * CELL, -WORLD_HALF + (j + 0.5) * CELL);
  }
  const solid = Float32Array.from(ground);
  const cover = new Float32Array(N * N);
  const top = new Float32Array(N * N).fill(-1000);
  stampMeshes(meshes, solid);
  stampBlobs(blobs, solid, cover, top);

  const vis = new Float32Array(N * N);
  traceOcclusion(ground, solid, vis);
  blur(vis, 1);
  blur(cover, 2);
  // canopy top: spread a little so crowns' edges keep a sensible height
  const topS = Float32Array.from(top);
  for (let j = 1; j < N - 1; j++) {
    for (let i = 1; i < N - 1; i++) {
      let t = top[idx(i, j)];
      for (let d = -1; d <= 1; d += 2) t = Math.max(t, top[idx(i + d, j)], top[idx(i, j + d)]);
      topS[idx(i, j)] = t;
    }
  }

  const data = new Uint16Array(N * N * 4);
  for (let k = 0; k < N * N; k++) {
    data[k * 4] = toHalf(vis[k]);
    data[k * 4 + 1] = toHalf(ground[k]);
    data[k * 4 + 2] = toHalf(topS[k] > -999 ? cover[k] : 0);
    data[k * 4 + 3] = toHalf(topS[k] > -999 ? topS[k] : ground[k]);
  }
  worldLight.map?.update(data);
  worldLight.bounce?.update(bakeBounce(hm, splat));
  worldLight.detail?.update(bakeDetail(hm, meshes, blobs, posts));
  worldLight.strength.set(1, 1, 1, 1);
}

/** Something narrow standing on the ground (a tree trunk, a post): a cylinder this tall. */
export interface Post {
  x: number;
  z: number;
  r: number;
  h: number;
}

/**
 * Short-range sky visibility at 0.5 m: the creases where walls, props, rocks
 * and trunks meet the ground. Traced only within a few metres of something
 * standing up; everywhere else stays fully open (255).
 */
function bakeDetail(hm: Heightmap, meshes: AbstractMesh[], blobs: Blob[], posts: Post[]): Uint8Array {
  const N = DETAIL_SIZE;
  const ground = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    const z = -WORLD_HALF + (j + 0.5) * DCELL;
    for (let i = 0; i < N; i++) ground[j * N + i] = hm.sample(-WORLD_HALF + (i + 0.5) * DCELL, z);
  }
  const solid = Float32Array.from(ground);
  stampMeshes(meshes, solid, N, 0.8);
  // rocks (solid blobs) as ellipsoids
  for (const b of blobs) {
    if (b.canopy) continue;
    const i0 = Math.max(0, cellOf(b.x - b.r, DCELL));
    const i1 = Math.min(N - 1, cellOf(b.x + b.r, DCELL));
    const j0 = Math.max(0, cellOf(b.z - b.r, DCELL));
    const j1 = Math.min(N - 1, cellOf(b.z + b.r, DCELL));
    for (let j = j0; j <= j1; j++) {
      const z = -WORLD_HALF + (j + 0.5) * DCELL;
      for (let i = i0; i <= i1; i++) {
        const x = -WORLD_HALF + (i + 0.5) * DCELL;
        const d2 = ((x - b.x) ** 2 + (z - b.z) ** 2) / (b.r * b.r);
        if (d2 >= 1) continue;
        const h = b.y + b.ry * Math.sqrt(1 - d2);
        const k = j * N + i;
        if (h > solid[k]) solid[k] = h;
      }
    }
  }
  // trunks and posts as upright cylinders (at least one texel wide)
  for (const p of posts) {
    const r = Math.max(p.r, DCELL * 0.5);
    const i0 = Math.max(0, cellOf(p.x - r, DCELL));
    const i1 = Math.min(N - 1, cellOf(p.x + r, DCELL));
    const j0 = Math.max(0, cellOf(p.z - r, DCELL));
    const j1 = Math.min(N - 1, cellOf(p.z + r, DCELL));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * N + i;
        const h = ground[k] + p.h;
        if (h > solid[k]) solid[k] = h;
      }
    }
  }

  // which texels have something standing within reach: a running window
  // count along each row, then down the columns (all sequential memory)
  const R = 5;
  const tall = new Uint8Array(N * N);
  for (let k = 0; k < N * N; k++) tall[k] = solid[k] - ground[k] > 0.12 ? 1 : 0;
  const rows = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) {
    const o = j * N;
    let c = 0;
    for (let i = 0; i < R && i < N; i++) c += tall[o + i];
    for (let i = 0; i < N; i++) {
      if (i + R < N) c += tall[o + i + R];
      if (i - R - 1 >= 0) c -= tall[o + i - R - 1];
      rows[o + i] = c > 0 ? 1 : 0;
    }
  }
  const near = new Uint8Array(N * N);
  const col = new Int32Array(N);
  for (let j = 0; j < R && j < N; j++) for (let i = 0; i < N; i++) col[i] += rows[j * N + i];
  for (let j = 0; j < N; j++) {
    const add = j + R < N ? (j + R) * N : -1;
    const sub = j - R - 1 >= 0 ? (j - R - 1) * N : -1;
    const o = j * N;
    for (let i = 0; i < N; i++) {
      if (add >= 0) col[i] += rows[add + i];
      if (sub >= 0) col[i] -= rows[sub + i];
      near[o + i] = col[i] > 0 ? 1 : 0;
    }
  }

  // integer texel offsets for each direction and step
  const DIRS = 8;
  const dist = [0.5, 1, 1.6, 2.4];
  const offs: number[] = [];
  const inv: number[] = [];
  for (let d = 0; d < DIRS; d++) {
    const a = (d / DIRS) * Math.PI * 2 + 0.39;
    for (const r of dist) {
      offs.push(Math.round((Math.sin(a) * r) / DCELL) * N + Math.round((Math.cos(a) * r) / DCELL));
      inv.push(1 / r);
    }
  }
  const S = dist.length;
  const M = R + 1;
  const vis = new Float32Array(N * N).fill(1);
  for (let j = M; j < N - M; j++) {
    for (let i = M; i < N - M; i++) {
      const k = j * N + i;
      if (!near[k] || tall[k]) continue;
      // (a texel inside a solid's footprint stays open: it is only seen on
      // the solid's own faces, well above the ground)
      const h0 = ground[k] + 0.15;
      let occ = 0;
      for (let d = 0, o = 0; d < DIRS; d++, o += S) {
        let best = 0;
        for (let s = 0; s < S; s++) {
          const t = (solid[k + offs[o + s]] - h0) * inv[o + s];
          if (t > best) best = t;
        }
        occ += (best * best) / (1 + best * best);
      }
      vis[k] = 1 - 0.85 * (occ / DIRS);
    }
  }
  // one soft 3×3 pass so the crease has no texel steps
  const out = new Uint8Array(N * N).fill(255);
  for (let j = 1; j < N - 1; j++) {
    for (let i = 1; i < N - 1; i++) {
      const k = j * N + i;
      if (!near[k]) continue;
      const a = k - N;
      const b = k + N;
      const s = vis[a - 1] + vis[a] + vis[a + 1] + vis[k - 1] + vis[k] + vis[k + 1] + vis[b - 1] + vis[b] + vis[b + 1];
      out[k] = Math.round(s * (255 / 9));
    }
  }
  return out;
}

/** Ground colour around each 8 m cell, relative to the world's average ground colour. */
function bakeBounce(hm: Heightmap, splat: Uint8Array): Uint8Array {
  const B = BOUNCE_SIZE;
  const size = hm.size;
  const cell = (WORLD_HALF * 2) / B;
  const grass = GROUND.grassA.map((v, c) => (v + GROUND.grassB[c]) * 0.5);
  const rock = ROCK_COLOURS.rockWarm.map((v, c) => (v + ROCK_COLOURS.rockCool[c]) * 0.5);
  const col = new Float32Array(B * B * 3);
  const mean = [0, 0, 0];
  for (let j = 0; j < B; j++) {
    for (let i = 0; i < B; i++) {
      const acc = [0, 0, 0];
      let n = 0;
      for (let sj = 0; sj < 4; sj++) {
        for (let si = 0; si < 4; si++) {
          const x = -WORLD_HALF + (i + (si + 0.5) / 4) * cell;
          const z = -WORLD_HALF + (j + (sj + 0.5) / 4) * cell;
          const gi = Math.min(size - 1, Math.max(0, Math.round((x + WORLD_HALF) / hm.step)));
          const gj = Math.min(size - 1, Math.max(0, Math.round((z + WORLD_HALF) / hm.step)));
          const o = (gj * size + gi) * 4;
          const forest = splat[o] / 255;
          const rk = splat[o + 1] / 255;
          const sand = splat[o + 2] / 255;
          const dirt = splat[o + 3] / 255;
          const g = Math.max(0, 1 - rk - sand - dirt);
          for (let c = 0; c < 3; c++) {
            const gc = grass[c] + (GROUND.forestCol[c] - grass[c]) * forest;
            acc[c] += gc * g + rock[c] * rk + GROUND.sandCol[c] * sand + GROUND.dirtCol[c] * dirt;
          }
          n++;
        }
      }
      for (let c = 0; c < 3; c++) {
        col[(j * B + i) * 3 + c] = acc[c] / n;
        mean[c] += acc[c] / n;
      }
    }
  }
  for (let c = 0; c < 3; c++) mean[c] /= B * B;
  const out = new Uint8Array(B * B * 4);
  for (let k = 0; k < B * B; k++) {
    for (let c = 0; c < 3; c++) {
      // stored as ratio / 2, so 128 = the average ground
      const r = Math.min(1.99, Math.max(0.4, col[k * 3 + c] / Math.max(mean[c], 1e-4)));
      out[k * 4 + c] = Math.round(r * 127.5);
    }
    out[k * 4 + 3] = 255;
  }
  return out;
}

// --- shader code ------------------------------------------------------------
// kWorldLight(P) returns x = sky/bounce light factor, y = sun factor,
// z = how deep under a canopy P is; kBounce is the ground bounce tint.
// Needs the samplers kLightMap, kBounceMap and kDetailMap and the uniforms
// toonGI and toonGIShadow.

export const WORLD_LIGHT_GLSL = /* glsl */ `
vec3 kBounce = vec3(1.0);
vec3 kWorldLight(vec3 P) {
  vec2 uv = (P.xz + ${WORLD_HALF.toFixed(1)}) / ${(WORLD_HALF * 2).toFixed(1)};
  float inW = step(abs(P.x), ${(WORLD_HALF - 1).toFixed(1)}) * step(abs(P.z), ${(WORLD_HALF - 1).toFixed(1)});
  vec4 lm = textureLod(kLightMap, uv, 0.0);
  float above = max(P.y - lm.g, 0.0);
  float ao = mix(1.0, lm.r, exp2(-above * 0.55) * toonGI.x);
  // the fine contact crease fades out within about a metre up a wall or rock
  ao *= mix(1.0, textureLod(kDetailMap, uv, 0.0).r, exp2(-above * 2.2) * toonGI.x);
  float under = lm.b * clamp((lm.a - P.y) * 0.3 + 0.2, 0.0, 1.0) * inW;
  vec2 dS = P.xz - toonGIShadow.xy;
  float far = toonGIShadow.z > 0.0 ? smoothstep(toonGIShadow.z * 0.6, toonGIShadow.z * 0.95, length(dS)) : 1.0;
  kBounce = mix(vec3(1.0), textureLod(kBounceMap, uv, 0.0).rgb * 2.0, toonGI.w * inW);
  ao = mix(1.0, ao, inW);
  // the sky light takes the full occlusion; direct light half of it (soft contact shading)
  return vec3(ao * ao * (1.0 - 0.5 * toonGI.y * under), (0.5 + 0.5 * ao) * (1.0 - 0.8 * toonGI.z * under * far), under * toonGI.y);
}
`;

export const WORLD_LIGHT_WGSL = /* wgsl */ `
var<private> kBounce: vec3f = vec3f(1.0);
fn kWorldLight(P: vec3f) -> vec3f {
  let uv = (P.xz + vec2f(${WORLD_HALF.toFixed(1)})) / ${(WORLD_HALF * 2).toFixed(1)};
  let inW = step(abs(P.x), ${(WORLD_HALF - 1).toFixed(1)}) * step(abs(P.z), ${(WORLD_HALF - 1).toFixed(1)});
  let lm = textureSampleLevel(kLightMap, kLightMapSampler, uv, 0.0);
  let above = max(P.y - lm.g, 0.0);
  let ao = mix(1.0, lm.r, exp2(-above * 0.55) * uniforms.toonGI.x) * mix(1.0, textureSampleLevel(kDetailMap, kDetailMapSampler, uv, 0.0).r, exp2(-above * 2.2) * uniforms.toonGI.x);
  let under = lm.b * clamp((lm.a - P.y) * 0.3 + 0.2, 0.0, 1.0) * inW;
  let dS = P.xz - uniforms.toonGIShadow.xy;
  var far = 1.0;
  if (uniforms.toonGIShadow.z > 0.0) { far = smoothstep(uniforms.toonGIShadow.z * 0.6, uniforms.toonGIShadow.z * 0.95, length(dS)); }
  kBounce = mix(vec3f(1.0), textureSampleLevel(kBounceMap, kBounceMapSampler, uv, 0.0).rgb * 2.0, uniforms.toonGI.w * inW);
  let aoW = mix(1.0, ao, inW);
  return vec3f(aoW * aoW * (1.0 - 0.5 * uniforms.toonGI.y * under), (0.5 + 0.5 * aoW) * (1.0 - 0.8 * uniforms.toonGI.z * under * far), under * uniforms.toonGI.y);
}
`;
