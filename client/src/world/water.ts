// Mirror Lake and the Silverrun river (with Silverfall), drawn as a cheap
// "volume" of water in two passes over the same surface and no extra scene
// renders: the depth below every pixel comes from the terrain heightmap, the
// view ray's path through the water gives per-channel absorption (glassy
// shallows, turquoise, then deep blue), and the surface adds scattered light,
// caustics on the bed, sunlit wave crests, foam and reflections of the sky,
// its clouds, the valley (marched through the heightmap) and the far ranges.
// Flow scrolls along the river and speeds up over the falls.
import {
  Color3,
  Effect,
  Mesh,
  ShaderMaterial,
  Vector3,
  Vector4,
  VertexData,
  type Scene,
  type Texture,
} from '@babylonjs/core';
import {
  FALL_S0,
  FALL_S1,
  LAKE,
  RIVER_POINTS,
  RIVER_TOTAL,
  WATER_LEVEL,
  riverHalfWidth,
  riverWaterY,
} from '@kelia/shared';
import type { Atmosphere } from './atmosphere';
import type { Terrain } from './terrain';
import type { QualitySettings } from '../core/quality';
import { GROUND } from './palette';
import { ROCK_COLOURS } from './mountains';
import { TOON_FOG_GLSL, TOON_FOG_UNIFORMS, bindToonFog, toon } from './toon';

Effect.ShadersStore['keliaWaterVertexShader'] = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
attribute vec4 flowData; // xy = flow dir, z = speed, w = falls factor
uniform mat4 viewProjection;
uniform vec4 params; // x = time
varying vec3 vPos;
varying vec2 vUv;
varying vec4 vFlow;
void main(void) {
  vec3 p = position;
  float t = params.x;
  // Gentle swell on open water only.
  float open = 1.0 - flowData.w;
  p.y += (sin(p.x * 0.21 + t * 1.1) * 0.5 + sin(p.z * 0.17 - t * 0.9) * 0.5) * 0.035 * open;
  vPos = p;
  vUv = uv;
  vFlow = flowData;
  gl_Position = viewProjection * vec4(p, 1.0);
}
`;

Effect.ShadersStore['keliaWaterFragmentShader'] = /* glsl */ `
precision highp float;
varying vec3 vPos;
varying vec2 vUv;
varying vec4 vFlow;
uniform sampler2D heightTex;
uniform sampler2D splatTex;
uniform sampler2D skylineTex;
uniform vec3 cameraPos;
uniform vec4 params;  // x = time, y = night, z = cloud cover, w = high quality
uniform vec4 params2; // x = sky time, yzw = lake centre x, z and radius
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 zenithColor;
uniform vec3 horizonColor;
uniform vec3 deepColor;
uniform vec3 shallowColor;
uniform vec3 ambientColor;
uniform vec3 absorbColor;
uniform vec3 cloudLight;
uniform vec3 cloudShade;
uniform vec3 landGrass;
uniform vec3 landForest;
uniform vec3 landRock;
uniform vec3 landSand;
${TOON_FOG_GLSL}

float terrainH(vec2 xz) {
  vec2 g = clamp(xz + 512.0, vec2(0.0), vec2(1023.99));
  vec2 i = floor(g);
  vec2 f = g - i;
  ivec2 ii = ivec2(i);
  float a = texelFetch(heightTex, ii, 0).r;
  float b = texelFetch(heightTex, ii + ivec2(1, 0), 0).r;
  float c = texelFetch(heightTex, ii + ivec2(0, 1), 0).r;
  float d = texelFetch(heightTex, ii + ivec2(1, 1), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float terrainH1(vec2 xz) {
  return texelFetch(heightTex, ivec2(clamp(xz + 512.5, vec2(0.0), vec2(1024.0))), 0).r;
}

float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float waves(vec2 p) {
  return vnoise(p) * 0.5 + vnoise(p * 2.13 + 7.1) * 0.3 + vnoise(p * 4.7 - 3.3) * 0.2;
}

// The sky dome's own cloud maths, so the lake mirrors the clouds overhead.
float sHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float sNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(sHash(i), sHash(i + vec2(1.0, 0.0)), u.x), mix(sHash(i + vec2(0.0, 1.0)), sHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float sFbm(vec2 p) {
  float s = 0.0; float a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * sNoise(p); p = p * 2.07 + vec2(17.1, 9.2); a *= 0.5; }
  return s / 0.9375;
}

vec3 skyRefl(vec3 R) {
  float up = clamp(R.y, 0.0, 1.0);
  vec3 col = mix(horizonColor, zenithColor, smoothstep(0.0, 0.62, pow(up, 0.7)));
  col = mix(col, horizonColor * 1.08 + vec3(0.02), exp(-up * 14.0) * 0.6);
  if (params.w > 0.5) {
    vec2 uv = R.xz / (up + 0.11) * 1.25;
    float st = params2.x;
    vec2 wind = vec2(st * 0.0042, st * 0.0015);
    float base = sFbm(uv + wind);
    float detail = sFbm(uv * 2.9 - wind * 1.6);
    float shape = base * 0.78 + detail * 0.32;
    float edge = 1.0 - params.z * 0.95;
    float dens = smoothstep(edge, edge + 0.05, shape) * smoothstep(0.0, 0.16, up);
    float lit = smoothstep(0.25, 0.75, clamp(0.55 + (shape - edge) * 1.4 + (detail - 0.5) * 0.35, 0.0, 1.0));
    col = mix(col, mix(cloudShade, cloudLight, lit), dens * 0.96);
  }
  col = mix(col, toonFog.rgb, exp(-up * 22.0) * 0.55);
  return col;
}

// What the water mirrors: the valley itself (marched through the heightmap),
// the far ranges (a baked skyline) or the sky.
vec3 reflection(vec3 P, vec3 R) {
  if (params.w > 0.5 && R.y < 0.4) {
    float tPrev = 0.0;
    float dPrev = 0.6;
    float tt = 3.0;
    for (int i = 0; i < 14; i++) {
      vec3 q = P + R * tt;
      if (abs(q.x) > 511.0 || abs(q.z) > 511.0) break;
      vec4 sp = textureLod(splatTex, (q.xz + 512.5) / 1025.0, 0.0);
      float dd = q.y - terrainH1(q.xz) - sp.r * 9.0; // canopy over the forest floor
      if (dd < 0.0) {
        float th = mix(tPrev, tt, dPrev / (dPrev - dd));
        vec3 h = P + R * th;
        sp = textureLod(splatTex, (h.xz + 512.5) / 1025.0, 0.0);
        vec3 alb = mix(landGrass, landForest, sp.r);
        alb = mix(alb, landRock, smoothstep(0.35, 0.6, sp.g));
        alb = mix(alb, landSand, sp.b * 0.7);
        alb = mix(alb, vec3(0.92, 0.95, 1.0), smoothstep(125.0, 140.0, h.y));
        vec3 c = alb * (ambientColor * 0.95 + sunColor * clamp(sunDir.y + 0.15, 0.0, 1.0) * 0.6);
        return kFog(c, h, P);
      }
      tPrev = tt;
      dPrev = dd;
      tt = tt * 1.45 + 2.0;
    }
  }
  // the far ranges
  float az = atan(R.z, R.x) * 0.15915494 + 1.0;
  vec4 sk = textureLod(skylineTex, vec2(az, 0.5), 0.0);
  float e = sk.r * 0.5;
  if (R.y < e) {
    float dist = sk.g * 2000.0;
    vec3 alb = mix(landRock * vec3(0.85, 0.9, 1.05), vec3(0.93, 0.96, 1.0), smoothstep(0.012, 0.0, e - R.y) * step(0.05, e));
    vec3 c = alb * (ambientColor + sunColor * clamp(sunDir.y + 0.15, 0.0, 1.0) * 0.55);
    return kFog(c, P + R * dist, P);
  }
  return skyRefl(R);
}

// Sunlight focused by the ripples onto the bed: two drifting ridge fields.
float caustic(vec2 p, float t) {
  vec2 q = p * 0.7;
  float a = 1.0 - abs(vnoise(q + vec2(t * 0.31, t * 0.17)) * 2.0 - 1.0);
  float b = 1.0 - abs(vnoise(mat2(0.8, -0.6, 0.6, 0.8) * q * 1.3 - vec2(t * 0.23, -t * 0.29) + 5.3) * 2.0 - 1.0);
  return smoothstep(0.7, 1.0, pow(a, 3.0) + pow(b, 3.0) * 0.8);
}

void main(void) {
  float t = params.x;
  float ground = terrainH(vPos.xz);
  float depth = vPos.y - ground;
  if (depth < -0.05) discard;
  // the river's mouth is drawn by the lake
  if (vFlow.z > 0.5 && distance(vPos.xz, params2.yz) < params2.w - 4.0) discard;

  vec2 dir = vFlow.xy;
  float speed = vFlow.z;
  float falls = vFlow.w;
  vec2 side = vec2(-dir.y, dir.x);
  // Coordinates that move with the current.
  vec2 fp = vec2(dot(vPos.xz, side), dot(vPos.xz, dir));
  vec2 p1 = fp * vec2(0.55, 0.35) - vec2(0.0, t * speed * 0.55);
  vec2 p2 = fp * vec2(1.1, 0.8) - vec2(t * 0.05, t * speed * 0.9);
  vec2 p3 = vPos.xz * 0.12 + vec2(t * 0.02, -t * 0.015);
  float e = 0.12;
  float camDist = length(cameraPos - vPos);
  // the fine ripple layers fade out with distance, before they can alias into glitter
  float w1 = 1.0 - smoothstep(60.0, 220.0, camDist);
  float w2 = (1.0 - smoothstep(18.0, 60.0, camDist)) * 0.6;
  float h0 = waves(p1) * w1 + waves(p2) * w2 + waves(p3) * 0.8;
  float hx = waves(p1 + vec2(e, 0.0)) * w1 + waves(p2 + vec2(e, 0.0)) * w2 + waves(p3 + vec2(e, 0.0)) * 0.8;
  float hz = waves(p1 + vec2(0.0, e)) * w1 + waves(p2 + vec2(0.0, e)) * w2 + waves(p3 + vec2(0.0, e)) * 0.8;
  h0 += (1.0 - w1) * 0.5 + (0.6 - w2) * 0.5;
  // calm and mirror-like far away, livelier in fast water
  float strength = mix(0.12, 0.9, clamp(speed / 3.0, 0.0, 1.0)) * mix(1.0, 0.4, smoothstep(20.0, 160.0, camDist));
  // at grazing angles a tiny tilt flips a reflection between sky and shore:
  // flatten the ripples there (a cheap stand-in for filtering the normal)
  float grazing = smoothstep(0.03, 0.35, normalize(cameraPos - vPos).y);
  strength *= mix(0.3, 1.0, grazing);
  vec3 n = normalize(vec3((h0 - hx) * strength * 2.0, 1.0, (h0 - hz) * strength * 2.0));
  // rotate the perturbation back from flow space to world
  n = normalize(vec3(n.x * side.x + n.z * dir.x, n.y, n.x * side.y + n.z * dir.y));

  vec3 V = normalize(cameraPos - vPos);
  float NdotV = max(dot(n, V), 0.0);
  float fresnel = 0.02 + 0.9 * pow(1.0 - NdotV, 5.0);

  // Optical path through the water along the view ray, refined once against
  // the bed: drives the colour absorption, so the shallows stay glassy and the
  // deep water turns to ink.
  float d = max(depth, 0.0);
  float vy = max(V.y, 0.06);
  float len = d / vy;
  vec2 bed = vPos.xz - V.xz * len;
  float dBed = max(vPos.y - terrainH(bed), 0.0);
  len = min(mix(len, dBed / vy, 0.7), 40.0);
  vec3 trans = exp(-absorbColor * len);

  // Foam: shorelines, rocks in the current and the falls.
  float foamNoise = vnoise(fp * vec2(2.2, 1.0) - vec2(0.0, t * speed * 1.6)) * 0.6 + vnoise(vPos.xz * 1.7 + t * 0.3) * 0.4;
  float shore = smoothstep(0.22, 0.0, d) * smoothstep(0.35, 0.75, foamNoise + 0.25);
  // soft rings of foam that wash in toward the beach
  float wash = smoothstep(0.82, 0.97, 0.5 + 0.5 * sin(d * 13.0 + t * 1.3 + foamNoise * 5.0)) * smoothstep(0.6, 0.12, d) * smoothstep(0.35, 0.6, foamNoise);
  float rapids = smoothstep(2.4, 4.5, speed) * smoothstep(0.45, 0.8, foamNoise);
  float fallsFoam = falls * smoothstep(0.55, 0.9, foamNoise) * 0.6;
  float foam = clamp(max(max(shore, wash * 0.75), max(rapids, fallsFoam)), 0.0, 1.0) * 0.9;

  // Fog: the bed behind is already fogged, so the water fades out by the same amount.
  float fogAmt = 1.0 - (kFog(vec3(1.0), vPos, cameraPos).g - kFog(vec3(0.0), vPos, cameraPos).g);

#ifdef ABSORB
  // Pass 1 (multiply): tint and dim what lies beneath, per colour channel.
  vec3 keep = trans * (1.0 - fresnel) * (1.0 - foam) * (1.0 - falls * 0.88);
  gl_FragColor = vec4(mix(keep, vec3(1.0), fogAmt), 0.0);
#else
  // Pass 2 (add): light scattered in the water body, reflections, sun and foam.
  float sunUp = smoothstep(-0.05, 0.08, sunDir.y);
  vec3 light = ambientColor + sunColor * clamp(sunDir.y + 0.2, 0.0, 1.0) * 0.55;
  float fill = 1.0 - exp(-len * 0.3);
  vec3 bodyCol = mix(shallowColor, deepColor, smoothstep(0.0, 1.0, 1.0 - exp(-len * 0.14)));
  vec3 body = bodyCol * light * fill;
  // sunlight through the wave crests when looking toward the sun
  vec2 toSun = sunDir.xz / max(length(sunDir.xz), 1e-3);
  float back = pow(max(dot(-V.xz / max(length(V.xz), 1e-3), toSun), 0.0), 4.0);
  float crest = smoothstep(1.1, 1.8, h0);
  vec3 sss = shallowColor * sunColor * back * crest * (0.25 + 0.75 * smoothstep(0.1, 1.5, d)) * 0.9 * sunUp;
  // caustics dancing on the bed, wobbled by the surface
  vec2 cp = bed + n.xz * min(d, 3.0) * 0.9;
  float caus = params.w > 0.5 ? caustic(cp, t) : 0.0;
  vec3 causCol = sunColor * caus * 0.7 * smoothstep(0.03, 0.3, d) * exp(-dBed * 0.4) * trans * sunUp;

  vec3 R = reflect(-V, n);
  R.y = abs(R.y);
  // reflections pick up a little of the water's own colour
  vec3 refl = reflection(vPos, R) * vec3(0.84, 0.95, 1.0);

  vec3 H = normalize(V + sunDir);
  float nh = max(dot(n, H), 0.0);
  // stylized glints: hard-edged sparkles fading with distance, a sun road and a soft sheen
  float glintFade = 1.0 - smoothstep(12.0, 45.0, camDist);
  float spec = smoothstep(0.992, 0.996, nh) * 4.0 * glintFade + pow(nh, 350.0) * 2.5 + pow(nh, 60.0) * 0.25;
  vec3 sun = sunColor * spec * step(0.0, sunDir.y);

  vec3 col = (body + causCol + sss) * (1.0 - fresnel) + refl * fresnel + sun;
  vec3 foamCol = vec3(0.95, 0.98, 1.0) * (ambientColor + sunColor * 0.8);
  col = col * (1.0 - foam) + foamCol * foam;
  // the falls: ribbons of white water streaming down a glassy turquoise sheet
  float fs = vnoise(vec2(fp.x * 2.2, vPos.y * 0.28 + t * 2.6)) * 0.65 + vnoise(vec2(fp.x * 5.3, vPos.y * 0.62 + t * 3.6)) * 0.35;
  vec3 sheet = mix(mix(shallowColor, vec3(0.8, 0.95, 1.0), 0.4) * light * 1.2 + refl * 0.2, foamCol, smoothstep(0.32, 0.66, fs));
  col = mix(col, sheet, falls * 0.92);
  gl_FragColor = vec4(col * (1.0 - fogAmt), 0.0);
#endif
}
`;

export function riverPointAt(s: number): { x: number; z: number; dx: number; dz: number } {
  let acc = 0;
  for (let i = 1; i < RIVER_POINTS.length; i++) {
    const [ax, az] = RIVER_POINTS[i - 1];
    const [bx, bz] = RIVER_POINTS[i];
    const len = Math.hypot(bx - ax, bz - az);
    if (s <= acc + len || i === RIVER_POINTS.length - 1) {
      const t = Math.min(1, Math.max(0, (s - acc) / len));
      return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, dx: (bx - ax) / len, dz: (bz - az) / len };
    }
    acc += len;
  }
  const [x, z] = RIVER_POINTS[RIVER_POINTS.length - 1];
  return { x, z, dx: 0, dz: -1 };
}

export class Water {
  /** The surface pass (scattering, reflections, foam); `absorb` tints what lies beneath. */
  readonly material: ShaderMaterial;
  readonly absorb: ShaderMaterial;
  readonly meshes: Mesh[] = [];
  private params = new Vector4();
  private params2 = new Vector4();
  private dir = new Vector3();
  private sunC = new Color3();
  private ambC = new Color3();
  private hq = 1;
  private colours: Record<string, Color3> = {
    deepColor: Color3.FromHexString('#0f4f86').toLinearSpace(),
    shallowColor: Color3.FromHexString('#3fd2c8').toLinearSpace(),
    // light lost per metre of water: red first, then green, so depth reads
    // clear -> turquoise -> deep blue
    absorbColor: new Color3(0.42, 0.13, 0.085),
    landGrass: Color3.FromArray(GROUND.grassA),
    landForest: Color3.FromArray(GROUND.forestCol).scale(0.62),
    landRock: Color3.FromArray(ROCK_COLOURS.rockWarm),
    landSand: Color3.FromArray(GROUND.sandCol),
  };

  constructor(private scene: Scene, terrain: Terrain, skyline: Texture, private atmosphere: Atmosphere) {
    const make = (name: string, defines: string[]) => {
      const mat = new ShaderMaterial(name, scene, 'keliaWater', {
        attributes: ['position', 'uv', 'flowData'],
        uniforms: [
          'viewProjection', 'params', 'params2', 'cameraPos', 'sunDir', 'sunColor', 'zenithColor', 'horizonColor', ...TOON_FOG_UNIFORMS,
          'deepColor', 'shallowColor', 'ambientColor', 'absorbColor', 'cloudLight', 'cloudShade', 'landGrass', 'landForest', 'landRock', 'landSand',
        ],
        samplers: ['heightTex', 'splatTex', 'skylineTex'],
        defines,
        needAlphaBlending: true,
      });
      mat.setTexture('heightTex', terrain.heightTexture);
      mat.setTexture('splatTex', terrain.splatTexture);
      mat.setTexture('skylineTex', skyline);
      mat.backFaceCulling = false;
      return mat;
    };
    // Two passes over the same surface: the first multiplies the ground and
    // rocks beneath by the water's per-channel transmittance (true coloured
    // depth, no scene copy needed), the second adds the light the water itself
    // gives off. Together they read as a clear, deep volume of water.
    this.absorb = make('waterAbsorb', ['#define ABSORB']);
    this.absorb.alphaMode = 4; // ALPHA_MULTIPLY
    this.absorb.disableDepthWrite = true;
    this.material = make('water', []);
    this.material.alphaMode = 6; // ALPHA_ONEONE
    const surfaces = [this.buildRiver(), this.buildLake()];
    for (const m of surfaces) {
      const under = m.clone(m.name + 'Absorb');
      under.material = this.absorb;
      under.alphaIndex = 0;
      m.material = this.material;
      m.alphaIndex = 1;
      for (const x of [under, m]) {
        x.isPickable = false;
        x.alwaysSelectAsActiveMesh = false;
        x.renderingGroupId = 0;
      }
      this.meshes.push(m, under);
    }
  }

  applyQuality(q: QualitySettings) {
    this.hq = q.level === 'low' ? 0 : 1;
  }

  private buildRiver(): Mesh {
    const positions: number[] = [];
    const uvs: number[] = [];
    const flow: number[] = [];
    const indices: number[] = [];
    const across = 9;
    let s = 0;
    let row = 0;
    while (s <= RIVER_TOTAL + 0.01) {
      const p = riverPointAt(s);
      const wy = riverWaterY(s);
      const hw = riverHalfWidth(s) + 6.5;
      const onFalls = s > FALL_S0 - 2 && s < FALL_S1 + 1;
      // speed: calm on the plateau, fast at the lip, churning at the foot
      const slope = Math.abs(riverWaterY(s + 1) - riverWaterY(s - 1)) / 2;
      const speed = Math.min(6, 0.7 + slope * 9);
      const fallsF = onFalls ? 1 : Math.max(0, 1 - Math.abs(s - FALL_S1) / 14) * 0.7;
      for (let k = 0; k < across; k++) {
        const u = (k / (across - 1)) * 2 - 1;
        const x = p.x + -p.dz * u * hw;
        const z = p.z + p.dx * u * hw;
        positions.push(x, wy, z);
        uvs.push(u, s);
        flow.push(p.dx, p.dz, speed, fallsF);
      }
      if (row > 0) {
        const a = (row - 1) * across;
        const b = row * across;
        for (let k = 0; k < across - 1; k++) indices.push(a + k, b + k, a + k + 1, a + k + 1, b + k, b + k + 1);
      }
      row++;
      s += onFalls ? 0.4 : 2;
    }
    const mesh = new Mesh('river', this.scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.uvs = uvs;
    vd.indices = indices;
    vd.applyToMesh(mesh);
    mesh.setVerticesData('flowData', flow, false, 4);
    return mesh;
  }

  private buildLake(): Mesh {
    const positions: number[] = [];
    const uvs: number[] = [];
    const flow: number[] = [];
    const indices: number[] = [];
    const rings = 24;
    const segs = 72;
    const R = LAKE.radius + 26;
    positions.push(LAKE.center[0], WATER_LEVEL, LAKE.center[1]);
    uvs.push(0, 0);
    flow.push(0.6, 0.8, 0.15, 0);
    for (let r = 1; r <= rings; r++) {
      const rad = (r / rings) * R;
      for (let k = 0; k < segs; k++) {
        const a = (k / segs) * Math.PI * 2;
        positions.push(LAKE.center[0] + Math.cos(a) * rad, WATER_LEVEL, LAKE.center[1] + Math.sin(a) * rad);
        uvs.push(r / rings, k / segs);
        flow.push(0.6, 0.8, 0.15, 0);
      }
    }
    for (let k = 0; k < segs; k++) indices.push(0, 1 + ((k + 1) % segs), 1 + k);
    for (let r = 1; r < rings; r++) {
      const a0 = 1 + (r - 1) * segs;
      const b0 = 1 + r * segs;
      for (let k = 0; k < segs; k++) {
        const k1 = (k + 1) % segs;
        indices.push(a0 + k, a0 + k1, b0 + k, a0 + k1, b0 + k1, b0 + k);
      }
    }
    const mesh = new Mesh('lake', this.scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.uvs = uvs;
    vd.indices = indices;
    vd.applyToMesh(mesh);
    mesh.setVerticesData('flowData', flow, false, 4);
    return mesh;
  }

  update(time: number, cameraPos: Vector3) {
    const a = this.atmosphere;
    this.params.set(time, a.state.night, a.cloudCover, this.hq);
    this.params2.set(a.time, LAKE.center[0], LAKE.center[1], LAKE.radius);
    this.dir.set(toon.sunDir.x, toon.sunDir.y, toon.sunDir.z);
    this.sunC.set(toon.sun.x, toon.sun.y, toon.sun.z);
    this.ambC.set(toon.sky.x * 0.9, toon.sky.y * 0.9, toon.sky.z * 0.9);
    for (const m of [this.material, this.absorb]) {
      m.setVector4('params', this.params);
      m.setVector4('params2', this.params2);
      m.setVector3('cameraPos', cameraPos);
      m.setVector3('sunDir', this.dir);
      m.setColor3('sunColor', this.sunC);
      m.setColor3('ambientColor', this.ambC);
      m.setColor3('zenithColor', a.state.zenith);
      m.setColor3('horizonColor', a.state.horizon);
      m.setColor3('cloudLight', a.state.cloudLight);
      m.setColor3('cloudShade', a.state.cloudShade);
      for (const k in this.colours) m.setColor3(k, this.colours[k]);
      bindToonFog(m);
    }
  }
}
