// The far ranges: a ring of tall, snow-capped peaks beyond the valley's own
// mountain wall, so every vista ends in layered, hazy summits instead of sky.
//
// One mesh, one draw call. It uses the same painted-rock shading as the
// terrain (at a far larger scale) and the world's height fog does the aerial
// perspective: the bases melt into the haze while the sunlit peaks stand out.
// The ring's skyline is also baked into a tiny texture so the lake can
// reflect it without rendering anything twice.
import {
  Color3,
  Mesh,
  PBRMaterial,
  RawTexture,
  Texture,
  VertexData,
  type Scene,
} from '@babylonjs/core';
import { Simplex2, WORLD_HALF, WORLD_SEED, smoothstep } from '@kelia/shared';
import { createShaderPlugin } from './shaderPlugin';
import { freezeStatic } from './frozen';
import { setToon } from './toon';
import { ROCK_GLSL, ROCK_GLSL_DEFS, ROCK_UNIFORMS, ROCK_WGSL, ROCK_WGSL_DEFS } from './rock';

const lin = (hex: string): [number, number, number] => {
  const c = Color3.FromHexString(hex).toLinearSpace();
  return [c.r, c.g, c.b];
};

/** Rock palette shared with the terrain. */
export const ROCK_COLOURS = {
  rockWarm: lin('#978a74'),
  rockCool: lin('#7c8796'),
  // a touch below white so sunlit snow keeps its shading instead of clipping
  snowCol: lin('#e6edf7'),
  mossCol: lin('#5f9a42'),
};

const SEGS = 320;
const RINGS = 26;
const OUTER = 1750;
/** Skyline texture resolution (azimuth bins). */
export const SKYLINE_BINS = 256;

const GLSL_FRAGMENT = /* glsl */ `
  vec3 kP = vPositionW;
  vec4 kD = texture2D(detailTex, kP.xz * 0.045);
  vec4 kD2 = texture2D(detailTex, kP.xz * 0.0065);
  vec4 kD3 = texture2D(detailTex, kP.xz * 0.0011);
  vec3 kNr = normalize(normalW);
${ROCK_GLSL}
  // forested foothills on the gentle lower slopes
  float kLow = 1.0 - smoothstep(rangeP.x - 30.0, rangeP.x + 30.0, kP.y + (kD3.a - 0.5) * 80.0);
  float kGreen = smoothstep(0.72, 0.82, kNr.y + (kD2.g - 0.5) * 0.3) * kLow;
  vec3 kGreenCol = mix(forestFar, meadowFar, smoothstep(0.3, 0.7, kD2.a)) * (0.85 + 0.3 * kD.r);
  vec3 kCol = mix(kRockCol, kGreenCol, kGreen);
  normalW = normalize(mix(kRockN, kNr, kGreen * 0.6));
  kCol = mix(kCol, snowCol * (0.95 + 0.06 * kD.r), kSnow);
  // light and shadow masses (rock.ts) keep every buttress readable through the haze
  kCol *= mix(vec3(1.0), kRockSun, 1.0 - kGreen * 0.5);
  // painterly distance: the farthest ranges cool toward blue before the fog,
  // keeping their chiselled faces so they still read as forms
  float kFar = smoothstep(800.0, 1700.0, distance(kP, vEyePosition.xyz)) * (1.0 - kSnow * 0.6);
  kCol = mix(kCol, hazeCol * (0.9 + 0.2 * kCol), kFar * 0.3);
  surfaceAlbedo = kCol;
`;

const WGSL_FRAGMENT = /* wgsl */ `
  let kP = fragmentInputs.vPositionW;
  let kD = textureSample(detailTex, detailTexSampler, kP.xz * 0.045);
  let kD2 = textureSample(detailTex, detailTexSampler, kP.xz * 0.0065);
  let kD3 = textureSample(detailTex, detailTexSampler, kP.xz * 0.0011);
  let kNr = normalize(normalW);
${ROCK_WGSL}
  let kLow = 1.0 - smoothstep(uniforms.rangeP.x - 30.0, uniforms.rangeP.x + 30.0, kP.y + (kD3.a - 0.5) * 80.0);
  let kGreen = smoothstep(0.72, 0.82, kNr.y + (kD2.g - 0.5) * 0.3) * kLow;
  let kGreenCol = mix(uniforms.forestFar, uniforms.meadowFar, smoothstep(0.3, 0.7, kD2.a)) * (0.85 + 0.3 * kD.r);
  var kCol = mix(kRockCol, kGreenCol, kGreen);
  normalW = normalize(mix(kRockN, kNr, kGreen * 0.6));
  kCol = mix(kCol, uniforms.snowCol * (0.95 + 0.06 * kD.r), kSnow);
  kCol = kCol * mix(vec3f(1.0), kRockSun, 1.0 - kGreen * 0.5);
  let kFar = smoothstep(800.0, 1700.0, distance(kP, scene.vEyePosition.xyz)) * (1.0 - kSnow * 0.6);
  kCol = mix(kCol, uniforms.hazeCol * (vec3f(0.9) + 0.2 * kCol), kFar * 0.3);
  surfaceAlbedo = kCol;
`;

const N1 = new Simplex2(WORLD_SEED + 707);
const N2 = new Simplex2(WORLD_SEED + 808);

/** A few named summits that tower over the rest (azimuth in radians, height in m). */
const HEROES: [number, number, number][] = [
  [0.55, 1150, 210], // north-east, behind Greyspine
  [1.85, 1300, 250], // north, above the plateau
  [3.6, 1200, 190], // west, over Whisperwood
  [4.9, 1250, 230], // south
];

function ridged(x: number, z: number, oct: number) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let w = 1;
  for (let o = 0; o < oct; o++) {
    let n = 1 - Math.abs(N1.noise(x, z));
    n *= n * w;
    w = Math.min(1, n * 2);
    sum += n * amp;
    norm += amp;
    amp *= 0.5;
    x *= 2.03;
    z *= 2.03;
  }
  return sum / norm;
}

/** Inner edge of the ring at angle a: just outside the square world. */
function innerRadius(a: number) {
  return WORLD_HALF / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a))) + 30;
}

function rangeHeight(x: number, z: number, r: number, a: number, r0: number) {
  const wx = x + N2.noise(x * 0.0016, z * 0.0016) * 160;
  const wz = z + N2.noise(x * 0.0016 + 9.3, z * 0.0016 - 3.1) * 160;
  const rid = Math.pow(ridged(wx * 0.0019, wz * 0.0019, 4), 1.3);
  // rises from behind the valley wall, crests, then rolls away into the haze
  const env = smoothstep(r0, r0 + 320, r) * (1 - 0.35 * smoothstep(1250, OUTER, r));
  let h = 25 + env * (60 + rid * 270);
  for (const [ha, hr, hh] of HEROES) {
    let da = Math.abs(a - ha);
    da = Math.min(da, Math.PI * 2 - da) * hr;
    const dr = r - hr;
    h += hh * Math.exp(-(da * da + dr * dr) / (2 * 150 * 150)) * (0.7 + 0.6 * rid);
  }
  return h;
}

export class Mountains {
  readonly mesh: Mesh;
  readonly material: PBRMaterial;
  /** r = skyline elevation (sin) × 2, g = distance to the skyline / 2000, per azimuth bin. */
  readonly skyline: RawTexture;

  constructor(scene: Scene, detailTex: Texture) {
    const positions = new Float32Array((SEGS + 1) * RINGS * 3);
    const indices: number[] = [];
    const sky = new Float32Array(SKYLINE_BINS);
    const skyDist = new Float32Array(SKYLINE_BINS).fill(1200);
    const eye = 12;
    let v = 0;
    for (let k = 0; k <= SEGS; k++) {
      const a = (k / SEGS) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const r0 = innerRadius(a);
      for (let ri = 0; ri < RINGS; ri++) {
        const u = ri / (RINGS - 1);
        const r = r0 + (OUTER - r0) * Math.pow(u, 1.35);
        const x = ca * r;
        const z = sa * r;
        // the seam vertex repeats the first column exactly
        const h = rangeHeight(x, z, r, k === SEGS ? 0 : a, r0);
        positions[v * 3] = x;
        positions[v * 3 + 1] = h;
        positions[v * 3 + 2] = z;
        v++;
        if (k < SEGS) {
          const bin = Math.floor((k / SEGS) * SKYLINE_BINS);
          const e = (h - eye) / Math.hypot(r, h - eye);
          if (e > sky[bin]) {
            sky[bin] = e;
            skyDist[bin] = r;
          }
        }
      }
    }
    for (let k = 0; k < SEGS; k++) {
      for (let ri = 0; ri < RINGS - 1; ri++) {
        const a = k * RINGS + ri;
        const b = (k + 1) * RINGS + ri;
        indices.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    const mesh = new Mesh('farRanges', scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.normals = normals;
    vd.indices = indices;
    vd.applyToMesh(mesh, false);
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.receiveShadows = false;
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;
    this.mesh = mesh;

    const mat = new PBRMaterial('farRanges', scene);
    mat.metallic = 0;
    mat.roughness = 1;
    mat.albedoColor = Color3.White();
    // Babylon winds the ring the other way round from what we built
    mat.backFaceCulling = false;
    setToon(mat, { rim: 0 });
    const plugin = createShaderPlugin(mat, {
      name: 'FarRanges',
      uniforms: { ...ROCK_UNIFORMS, rangeP: 'vec4', forestFar: 'vec3', meadowFar: 'vec3', hazeCol: 'vec3' },
      samplers: ['detailTex'],
      glsl: { fragment: { CUSTOM_FRAGMENT_DEFINITIONS: ROCK_GLSL_DEFS, CUSTOM_FRAGMENT_BEFORE_LIGHTS: GLSL_FRAGMENT } },
      wgsl: { fragment: { CUSTOM_FRAGMENT_DEFINITIONS: ROCK_WGSL_DEFS, CUSTOM_FRAGMENT_BEFORE_LIGHTS: WGSL_FRAGMENT } },
    });
    Object.assign(plugin.values, ROCK_COLOURS, {
      // huge planes, high snow line, softer facets, long gullies
      rockP: [110, 235, 0.8, 0.35],
      rangeP: [150, 0, 0, 0],
      forestFar: lin('#3d6e45'),
      meadowFar: lin('#6f9a52'),
      hazeCol: lin('#8ea6c8'),
    });
    plugin.textures.detailTex = detailTex;
    mesh.material = mat;
    freezeStatic(mat);
    this.material = mat;

    const px = new Uint8Array(SKYLINE_BINS * 4);
    for (let i = 0; i < SKYLINE_BINS; i++) {
      px[i * 4] = Math.round(Math.min(1, Math.max(0, sky[i] * 2)) * 255);
      px[i * 4 + 1] = Math.round(Math.min(1, skyDist[i] / 2000) * 255);
      px[i * 4 + 3] = 255;
    }
    this.skyline = RawTexture.CreateRGBATexture(px, SKYLINE_BINS, 1, scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
    this.skyline.wrapU = Texture.WRAP_ADDRESSMODE;
    this.skyline.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.skyline.name = 'skyline';
  }
}
