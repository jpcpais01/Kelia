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
import { GROUND } from './palette';
import { setToon } from './toon';
import { ROCK_DEFAULTS, ROCK_GLSL, ROCK_GLSL_DEFS, ROCK_UNIFORMS, ROCK_WGSL, ROCK_WGSL_DEFS } from './rock';
import { ROCK_COLOURS } from './mountains';

// 8×8 chunks of 128 m: a quarter of the draw calls of 64 m chunks, with LOD
// distances matched so the same detail reaches the same range.
const CHUNK = 128;
const CHUNKS = (WORLD_HALF * 2) / CHUNK;
const LOD_STEPS = [1, 2, 4, 8];

// Small-scale ground detail: a precision-safe hash (world coordinates run to
// the thousands at pebble scale, too far for the sin() hash) and "specks",
// at most one round-ish blob per cell that never crosses its cell, so a
// whole scatter of pebbles or fallen leaves costs one cell lookup.
// Speck: x = coverage (anti-aliased, fades once sub-pixel), yz = position
// inside it (-1..1 across its radius, world axes), w = 0 for an empty cell, else a
// random 0.05..1.
const GROUND_GLSL_DEFS = /* glsl */ `
vec2 kHashG(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.103, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
vec4 kSpeck(vec2 c, float aa, float density, float seed) {
  vec2 i = floor(c);
  vec2 h = kHashG(i + seed);
  vec2 h2 = kHashG(i + seed + 31.7);
  float r = 0.16 + 0.16 * h2.x;
  vec2 o = i + 0.5 + (h - 0.5) * (1.0 - 2.4 * r);
  float a = h2.y * 6.2832;
  vec2 cs = vec2(cos(a), sin(a));
  vec2 d = c - o;
  vec2 q = vec2(dot(d, cs), dot(d, vec2(-cs.y, cs.x))) / (r * vec2(1.0, 0.62 + 0.3 * h.x));
  float on = step(fract(h.x * 7.13 + h2.x * 3.7), density);
  float e = max(aa, 0.001) / r;
  float m = (1.0 - smoothstep(1.0 - e, 1.0 + e, length(q))) * on * (1.0 - smoothstep(0.3, 0.8, e));
  // q back to world axes, so a pebble's dome faces the right way
  return vec4(m, q.x * cs + q.y * vec2(-cs.y, cs.x), on * (0.05 + 0.95 * fract(h.y * 13.7)));
}
`;

const GROUND_WGSL_DEFS = /* wgsl */ `
fn kHashG(p: vec2f) -> vec2f {
  var p3 = fract(vec3f(p.x, p.y, p.x) * vec3f(0.1031, 0.103, 0.0973));
  p3 = p3 + vec3f(dot(p3, p3.yzx + vec3f(33.33)));
  return fract((p3.xx + p3.yz) * p3.zy);
}
fn kSpeck(c: vec2f, aa: f32, density: f32, seed: f32) -> vec4f {
  let i = floor(c);
  let h = kHashG(i + vec2f(seed));
  let h2 = kHashG(i + vec2f(seed + 31.7));
  let r = 0.16 + 0.16 * h2.x;
  let o = i + vec2f(0.5) + (h - vec2f(0.5)) * (1.0 - 2.4 * r);
  let a = h2.y * 6.2832;
  let cs = vec2f(cos(a), sin(a));
  let d = c - o;
  let q = vec2f(dot(d, cs), dot(d, vec2f(-cs.y, cs.x))) / (r * vec2f(1.0, 0.62 + 0.3 * h.x));
  let on = step(fract(h.x * 7.13 + h2.x * 3.7), density);
  let e = max(aa, 0.001) / r;
  let m = (1.0 - smoothstep(1.0 - e, 1.0 + e, length(q))) * on * (1.0 - smoothstep(0.3, 0.8, e));
  return vec4f(m, q.x * cs + q.y * vec2f(-cs.y, cs.x), on * (0.05 + 0.95 * fract(h.y * 13.7)));
}
`;

const GLSL_FRAGMENT = /* glsl */ `
  vec3 kP = vPositionW;
  vec2 kWuv = (kP.xz + vec2(512.5)) / 1025.0;
  vec4 kSp = texture2D(splatMap, kWuv);
  vec4 kGm = texture2D(groundMap, kWuv);
  vec2 kDuv = kP.xz * 0.21;
  vec4 kD = texture2D(detailTex, kDuv);
  vec4 kD2 = texture2D(detailTex, kP.xz * 0.027);
  vec4 kD3 = texture2D(detailTex, kP.xz * 0.0041);
  // two neighbouring taps of the fine noise give it a slope: grain, clods, turf
  float kBx = texture2D(detailTex, kDuv + vec2(1.0 / 256.0, 0.0)).r;
  float kBz = texture2D(detailTex, kDuv + vec2(0.0, 1.0 / 256.0)).r;
  vec3 kNr = normalize(normalW);
${ROCK_GLSL}
  // ground data: distance from the waterline (negative under water), trail centre distance and direction
  float kShore = kGm.r * 16.0 - 4.0;
  float kPathD = kGm.g * 4.0;
  vec2 kPathDir = kGm.ba * 2.0 - 1.0;
  // derivatives up front, before anything data-dependent (WGSL uniformity)
  float kPaa = fwidth(kP.x) + fwidth(kP.z);
  vec2 kWarp = (kD2.rg - 0.5) * 5.0 + (kD3.gb - 0.5) * 14.0;
  float kRph = dot(kP.xz + kWarp, vec2(0.8, 0.6)) * 10.5;
  float kRaa = fwidth(kRph);

  // rock meets soil along a crisp, height-blended edge: grass caps the ledges
  float kRockA = smoothstep(0.42, 0.56, kSp.g + (kRockH - 0.5) * 0.45 + (kD.b - 0.5) * 0.12);
  // Height-aware blending: textures with more "height" win at borders.
  float kGrassW = clamp(1.0 - kSp.g - kSp.b - kSp.a, 0.0, 1.0);
  float kSand = kSp.b * (0.7 + kD.r * 0.6);
  float kDirt = kSp.a * (0.5 + kD.g * 1.0);
  float kGrass = kGrassW * (0.7 + kD2.g * 0.6);
  float kSum = max(kGrass + kSand + kDirt, 0.0001);
  float kSandN = kSand / kSum;
  float kDirtN = kDirt / kSum;
  float kGrassN = kGrass / kSum;
  vec3 kGrassCol = mix(grassA, grassB, smoothstep(0.25, 0.75, kD3.a));
  kGrassCol = mix(kGrassCol, grassDry, smoothstep(0.55, 0.85, kD2.a) * 0.6);
  kGrassCol *= 0.9 + 0.2 * kD.r;
  kGrassCol = mix(kGrassCol, forestCol * (0.8 + 0.45 * kD.g), kSp.r);
  // leaf litter on the forest floor
  vec4 kLeaf = kSpeck(kP.xz * 2.2, kPaa * 2.2, kSp.r * 0.55, 3.0);
  kGrassCol = mix(kGrassCol, mix(vec3(0.16, 0.075, 0.025), vec3(0.4, 0.22, 0.05), kLeaf.w) * (0.75 + 0.5 * kD.r), kLeaf.x * kSp.r * 0.8);

  // sand: big warm/cool drifts, wind ripples on the dry beach, darker heavy grains in the troughs
  float kDry = smoothstep(0.9, 2.0, kShore);
  float kRipK = smoothstep(0.22, 0.45, kD3.r + (kD2.b - 0.5) * 0.5) * kDry * smoothstep(0.86, 0.96, kNr.y) * (1.0 - smoothstep(0.9, 2.6, kRaa));
  float kRs = sin(kRph + 0.7 * sin(kRph));
  float kRds = cos(kRph + 0.7 * sin(kRph)) * (1.0 + 0.7 * cos(kRph));
  vec3 kSandCol = sandCol * (0.88 + 0.2 * kD.r) * mix(vec3(0.95, 0.97, 1.02), vec3(1.04, 1.0, 0.95), kD3.g);
  kSandCol *= 1.0 + kRipK * (0.09 * kRs - 0.1 * smoothstep(0.55, 0.85, kD.r) * (1.0 - kRs) * 0.5);

  // trails: a pale, trodden crown, two worn ruts, darker humus where they meet the grass
  float kRutX = (kPathD - 0.62) / 0.24;
  float kRut = exp(-kRutX * kRutX);
  float kWorn = 1.0 - smoothstep(0.15, 1.1, kPathD);
  vec3 kDirtCol = dirtCol * (0.75 + 0.4 * kD.g) * (0.9 + 0.2 * kD2.r);
  kDirtCol = mix(kDirtCol, dirtCol * vec3(1.28, 1.22, 1.1), kWorn * 0.6);
  kDirtCol *= 1.0 - 0.32 * kRut * smoothstep(0.3, 0.6, kD2.b + 0.2);
  kDirtCol = mix(kDirtCol, dirtCol * vec3(0.55, 0.5, 0.42), clamp(kDirtN * kGrassN * 4.0, 0.0, 1.0) * 0.5);

  vec3 kSoft = kGrassCol * kGrassN + kSandCol * kSandN + kDirtCol * kDirtN;

  // surface slope from every small-scale layer (m per m)
  vec2 kGrad = vec2(kBx - kD.r, kBz - kD.r) * 53.8 * (kGrassN * 0.03 + kSandN * 0.008 * (1.0 - kRipK) + kDirtN * 0.06);
  kGrad += vec2(0.8, 0.6) * kRds * 10.5 * 0.022 * kRipK * kSandN;
  kGrad += kPathDir * (0.07 * kRut * 2.0 * (kPathD - 0.62) / 0.0576) * kDirtN * (1.0 - smoothstep(1.2, 1.6, kPathD));

  // shoreline: dark wet sand along the water, a broken line of washed-up wrack above it
  float kWetEdge = 1.5 + (kD2.r - 0.5) * 1.6 + (kD.g - 0.5) * 0.3;
  float kWet = (1.0 - smoothstep(kWetEdge - 0.6, kWetEdge, kShore)) * mix(0.55, 1.0, smoothstep(-2.5, 0.0, kShore));
  float kSwashX = (kShore - kWetEdge - 0.12) / 0.1;
  float kSwash = exp(-kSwashX * kSwashX) * kSandN;
  float kWrackX = (kShore - 3.1 - (kD2.g - 0.5) * 1.4) / 0.12;
  float kWrack = exp(-kWrackX * kWrackX) * smoothstep(0.45, 0.7, kD.g + (kD2.b - 0.5) * 0.4) * kSandN;
  kSoft = mix(kSoft, kSoft * vec3(0.56, 0.58, 0.6), kWet) * (1.0 + 0.1 * kSwash);
  kSoft = mix(kSoft, vec3(0.13, 0.12, 0.07), kWrack * 0.55);
  kGrad *= 1.0 - 0.6 * kWet;

  // gravel down the trails, stones on the beaches, along trail edges and below the cliffs
  float kUnder = smoothstep(-2.0, 0.3, kShore);
  vec4 kGrv = kSpeck(kP.xz * 6.0, kPaa * 6.0, (kDirtN * 0.55 + kSandN * 0.25) * kUnder, 7.0);
  float kGrvL = length(kGrv.yz);
  kSoft *= mix(1.0, (0.62 + 0.75 * kGrv.w) * (0.8 + 0.3 * sqrt(max(1.0 - kGrvL * kGrvL, 0.0))), kGrv.x);
  float kStoneDen = kSandN * 0.07 * smoothstep(0.4, 0.7, kD2.b) + kDirtN * 0.2 * (1.0 - kWorn) + kSp.g * 0.3 * (1.0 - kRockA * 0.8);
  vec4 kSt = kSpeck(kP.xz * 1.9, kPaa * 1.9, kStoneDen * kUnder, 0.0);
  float kStL = length(kSt.yz);
  vec3 kStCol = mix(vec3(0.1, 0.09, 0.075), vec3(0.34, 0.31, 0.27), kSt.w) * mix(vec3(1.0), vec3(1.15, 1.0, 0.8), step(0.7, fract(kSt.w * 5.3)));
  kStCol *= (0.68 + 0.45 * sqrt(max(1.0 - kStL * kStL, 0.0))) * (0.85 + 0.3 * kD.r) * (1.0 - 0.4 * kWet);
  kSoft *= 1.0 - 0.4 * (1.0 - smoothstep(1.0, 1.45, kStL)) * step(0.01, kSt.w) * (1.0 - kSt.x);
  kSoft = mix(kSoft, kStCol, kSt.x);
  vec3 kNs = normalize(kNr - vec3(kGrad.x, 0.0, kGrad.y));
  kNs = normalize(mix(kNs, normalize(kNr * 0.8 + vec3(kGrv.y, 0.0, kGrv.z) * 0.4), kGrv.x * (1.0 - smoothstep(0.7, 1.0, kGrvL))));
  kNs = normalize(mix(kNs, normalize(kNr * 0.8 + vec3(kSt.y, 0.0, kSt.z) * 0.6), kSt.x * (1.0 - smoothstep(0.75, 1.0, kStL))));
  // the cel light is flat away from its terminator, so paint the small relief
  // into the colour as well: slopes toward the sun lighter, away darker
  kSoft *= clamp(1.0 + 1.6 * (dot(kNs, toonSunDir.xyz) - dot(kNr, toonSunDir.xyz)), 0.55, 1.35);

  vec3 kCol = mix(kSoft, kRockCol, kRockA);
  normalW = normalize(mix(kNs, kRockN, kRockA));
  // snow settles on whatever lies above the snow line
  float kSnowA = kSnow * max(kRockA, smoothstep(0.6, 0.8, kNr.y));
  kCol = mix(kCol, snowCol * (0.94 + 0.08 * kD.r), kSnowA);
  // sun-side value split on the cliffs and snow (see rock.ts)
  kCol *= mix(vec3(1.0), kRockSun, max(kRockA, kSnowA));
  surfaceAlbedo = kCol;
`;
const WGSL_FRAGMENT = /* wgsl */ `
  let kP = fragmentInputs.vPositionW;
  let kWuv = (kP.xz + vec2f(512.5)) / 1025.0;
  let kSp = textureSample(splatMap, splatMapSampler, kWuv);
  let kGm = textureSample(groundMap, groundMapSampler, kWuv);
  let kDuv = kP.xz * 0.21;
  let kD = textureSample(detailTex, detailTexSampler, kDuv);
  let kD2 = textureSample(detailTex, detailTexSampler, kP.xz * 0.027);
  let kD3 = textureSample(detailTex, detailTexSampler, kP.xz * 0.0041);
  let kBx = textureSample(detailTex, detailTexSampler, kDuv + vec2f(1.0 / 256.0, 0.0)).r;
  let kBz = textureSample(detailTex, detailTexSampler, kDuv + vec2f(0.0, 1.0 / 256.0)).r;
  let kNr = normalize(normalW);
${ROCK_WGSL}
  let kShore = kGm.r * 16.0 - 4.0;
  let kPathD = kGm.g * 4.0;
  let kPathDir = kGm.ba * 2.0 - vec2f(1.0);
  let kPaa = fwidth(kP.x) + fwidth(kP.z);
  let kWarp = (kD2.rg - vec2f(0.5)) * 5.0 + (kD3.gb - vec2f(0.5)) * 14.0;
  let kRph = dot(kP.xz + kWarp, vec2f(0.8, 0.6)) * 10.5;
  let kRaa = fwidth(kRph);

  let kRockA = smoothstep(0.42, 0.56, kSp.g + (kRockH - 0.5) * 0.45 + (kD.b - 0.5) * 0.12);
  let kGrassW = clamp(1.0 - kSp.g - kSp.b - kSp.a, 0.0, 1.0);
  let kSand = kSp.b * (0.7 + kD.r * 0.6);
  let kDirt = kSp.a * (0.5 + kD.g * 1.0);
  let kGrass = kGrassW * (0.7 + kD2.g * 0.6);
  let kSum = max(kGrass + kSand + kDirt, 0.0001);
  let kSandN = kSand / kSum;
  let kDirtN = kDirt / kSum;
  let kGrassN = kGrass / kSum;
  var kGrassCol = mix(uniforms.grassA, uniforms.grassB, smoothstep(0.25, 0.75, kD3.a));
  kGrassCol = mix(kGrassCol, uniforms.grassDry, smoothstep(0.55, 0.85, kD2.a) * 0.6);
  kGrassCol = kGrassCol * (0.9 + 0.2 * kD.r);
  kGrassCol = mix(kGrassCol, uniforms.forestCol * (0.8 + 0.45 * kD.g), kSp.r);
  let kLeaf = kSpeck(kP.xz * 2.2, kPaa * 2.2, kSp.r * 0.55, 3.0);
  kGrassCol = mix(kGrassCol, mix(vec3f(0.16, 0.075, 0.025), vec3f(0.4, 0.22, 0.05), kLeaf.w) * (0.75 + 0.5 * kD.r), kLeaf.x * kSp.r * 0.8);

  let kDry = smoothstep(0.9, 2.0, kShore);
  let kRipK = smoothstep(0.22, 0.45, kD3.r + (kD2.b - 0.5) * 0.5) * kDry * smoothstep(0.86, 0.96, kNr.y) * (1.0 - smoothstep(0.9, 2.6, kRaa));
  let kRs = sin(kRph + 0.7 * sin(kRph));
  let kRds = cos(kRph + 0.7 * sin(kRph)) * (1.0 + 0.7 * cos(kRph));
  var kSandCol = uniforms.sandCol * (0.88 + 0.2 * kD.r) * mix(vec3f(0.95, 0.97, 1.02), vec3f(1.04, 1.0, 0.95), kD3.g);
  kSandCol = kSandCol * (1.0 + kRipK * (0.09 * kRs - 0.1 * smoothstep(0.55, 0.85, kD.r) * (1.0 - kRs) * 0.5));

  let kRutX = (kPathD - 0.62) / 0.24;
  let kRut = exp(-kRutX * kRutX);
  let kWorn = 1.0 - smoothstep(0.15, 1.1, kPathD);
  var kDirtCol = uniforms.dirtCol * (0.75 + 0.4 * kD.g) * (0.9 + 0.2 * kD2.r);
  kDirtCol = mix(kDirtCol, uniforms.dirtCol * vec3f(1.28, 1.22, 1.1), kWorn * 0.6);
  kDirtCol = kDirtCol * (1.0 - 0.32 * kRut * smoothstep(0.3, 0.6, kD2.b + 0.2));
  kDirtCol = mix(kDirtCol, uniforms.dirtCol * vec3f(0.55, 0.5, 0.42), clamp(kDirtN * kGrassN * 4.0, 0.0, 1.0) * 0.5);

  var kSoft = kGrassCol * kGrassN + kSandCol * kSandN + kDirtCol * kDirtN;

  var kGrad = vec2f(kBx - kD.r, kBz - kD.r) * 53.8 * (kGrassN * 0.03 + kSandN * 0.008 * (1.0 - kRipK) + kDirtN * 0.06);
  kGrad = kGrad + vec2f(0.8, 0.6) * kRds * 10.5 * 0.022 * kRipK * kSandN;
  kGrad = kGrad + kPathDir * (0.07 * kRut * 2.0 * (kPathD - 0.62) / 0.0576) * kDirtN * (1.0 - smoothstep(1.2, 1.6, kPathD));

  let kWetEdge = 1.5 + (kD2.r - 0.5) * 1.6 + (kD.g - 0.5) * 0.3;
  let kWet = (1.0 - smoothstep(kWetEdge - 0.6, kWetEdge, kShore)) * mix(0.55, 1.0, smoothstep(-2.5, 0.0, kShore));
  let kSwashX = (kShore - kWetEdge - 0.12) / 0.1;
  let kSwash = exp(-kSwashX * kSwashX) * kSandN;
  let kWrackX = (kShore - 3.1 - (kD2.g - 0.5) * 1.4) / 0.12;
  let kWrack = exp(-kWrackX * kWrackX) * smoothstep(0.45, 0.7, kD.g + (kD2.b - 0.5) * 0.4) * kSandN;
  kSoft = mix(kSoft, kSoft * vec3f(0.56, 0.58, 0.6), kWet) * (1.0 + 0.1 * kSwash);
  kSoft = mix(kSoft, vec3f(0.13, 0.12, 0.07), kWrack * 0.55);
  kGrad = kGrad * (1.0 - 0.6 * kWet);

  let kUnder = smoothstep(-2.0, 0.3, kShore);
  let kGrv = kSpeck(kP.xz * 6.0, kPaa * 6.0, (kDirtN * 0.55 + kSandN * 0.25) * kUnder, 7.0);
  let kGrvL = length(kGrv.yz);
  kSoft = kSoft * mix(1.0, (0.62 + 0.75 * kGrv.w) * (0.8 + 0.3 * sqrt(max(1.0 - kGrvL * kGrvL, 0.0))), kGrv.x);
  let kStoneDen = kSandN * 0.07 * smoothstep(0.4, 0.7, kD2.b) + kDirtN * 0.2 * (1.0 - kWorn) + kSp.g * 0.3 * (1.0 - kRockA * 0.8);
  let kSt = kSpeck(kP.xz * 1.9, kPaa * 1.9, kStoneDen * kUnder, 0.0);
  let kStL = length(kSt.yz);
  var kStCol = mix(vec3f(0.1, 0.09, 0.075), vec3f(0.34, 0.31, 0.27), kSt.w) * mix(vec3f(1.0), vec3f(1.15, 1.0, 0.8), step(0.7, fract(kSt.w * 5.3)));
  kStCol = kStCol * (0.68 + 0.45 * sqrt(max(1.0 - kStL * kStL, 0.0))) * (0.85 + 0.3 * kD.r) * (1.0 - 0.4 * kWet);
  kSoft = kSoft * (1.0 - 0.4 * (1.0 - smoothstep(1.0, 1.45, kStL)) * step(0.01, kSt.w) * (1.0 - kSt.x));
  kSoft = mix(kSoft, kStCol, kSt.x);
  var kNs = normalize(kNr - vec3f(kGrad.x, 0.0, kGrad.y));
  kNs = normalize(mix(kNs, normalize(kNr * 0.8 + vec3f(kGrv.y, 0.0, kGrv.z) * 0.4), kGrv.x * (1.0 - smoothstep(0.7, 1.0, kGrvL))));
  kNs = normalize(mix(kNs, normalize(kNr * 0.8 + vec3f(kSt.y, 0.0, kSt.z) * 0.6), kSt.x * (1.0 - smoothstep(0.75, 1.0, kStL))));
  kSoft = kSoft * clamp(1.0 + 1.6 * (dot(kNs, uniforms.toonSunDir.xyz) - dot(kNr, uniforms.toonSunDir.xyz)), 0.55, 1.35);

  var kCol = mix(kSoft, kRockCol, kRockA);
  normalW = normalize(mix(kNs, kRockN, kRockA));
  let kSnowA = kSnow * max(kRockA, smoothstep(0.6, 0.8, kNr.y));
  kCol = mix(kCol, uniforms.snowCol * (0.94 + 0.08 * kD.r), kSnowA);
  kCol = kCol * mix(vec3f(1.0), kRockSun, max(kRockA, kSnowA));
  surfaceAlbedo = kCol;
`;

interface Chunk {
  ci: number;
  cj: number;
  cx: number;
  cz: number;
  lod: number;
  /** LOD distance multiplier: craggy mountain chunks keep their detail further out. */
  detail: number;
  meshes: (Mesh | null)[];
  pending: number;
}

export class Terrain {
  readonly material: PBRMaterial;
  readonly splatTexture: RawTexture;
  readonly detailTexture: Texture;
  /** Shoreline and trail data for the small ground detail (see terrainData.worker.ts). */
  readonly groundTexture: RawTexture;
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
    this.groundTexture = RawTexture.CreateRGBATexture(data.ground, size, size, scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
    this.groundTexture.wrapU = this.groundTexture.wrapV = Texture.CLAMP_ADDRESSMODE;

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
      uniforms: { grassA: 'vec3', grassB: 'vec3', grassDry: 'vec3', forestCol: 'vec3', sandCol: 'vec3', dirtCol: 'vec3', ...ROCK_UNIFORMS },
      samplers: ['splatMap', 'detailTex', 'groundMap'],
      glsl: { fragment: { CUSTOM_FRAGMENT_DEFINITIONS: ROCK_GLSL_DEFS + GROUND_GLSL_DEFS, CUSTOM_FRAGMENT_BEFORE_LIGHTS: GLSL_FRAGMENT } },
      wgsl: { fragment: { CUSTOM_FRAGMENT_DEFINITIONS: ROCK_WGSL_DEFS + GROUND_WGSL_DEFS, CUSTOM_FRAGMENT_BEFORE_LIGHTS: WGSL_FRAGMENT } },
    });
    Object.assign(plugin.values, GROUND, ROCK_DEFAULTS, ROCK_COLOURS);
    delete plugin.values.rockCol; // the rock palette lives in ROCK_COLOURS now
    plugin.textures.splatMap = this.splatTexture;
    plugin.textures.detailTex = this.detailTexture;
    plugin.textures.groundMap = this.groundTexture;

    for (let cj = 0; cj < CHUNKS; cj++) {
      for (let ci = 0; ci < CHUNKS; ci++) {
        this.chunks.push({
          ci,
          cj,
          cx: -WORLD_HALF + (ci + 0.5) * CHUNK,
          cz: -WORLD_HALF + (cj + 0.5) * CHUNK,
          lod: -1,
          detail: this.reliefDetail(ci, cj),
          meshes: [null, null, null, null],
          pending: -1,
        });
      }
    }
  }

  /** 1 for gentle ground, up to 1.8 for chunks with a lot of relief (cliffs, peaks). */
  private reliefDetail(ci: number, cj: number) {
    const hm = this.data.heightmap;
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 0; j <= CHUNK; j += 8) {
      for (let i = 0; i <= CHUNK; i += 8) {
        const h = hm.at(Math.round((ci * CHUNK + i) / hm.step), Math.round((cj * CHUNK + j) / hm.step));
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    return 1 + 0.8 * Math.min(1, Math.max(0, (hi - lo - 25) / 60));
  }

  private desiredLod(c: Chunk, cam: Vector3) {
    const d = Math.hypot(c.cx - cam.x, c.cz - cam.z) / (this.lodScale * c.detail);
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
    this.groundTexture.dispose();
    this.material.dispose();
  }
}
