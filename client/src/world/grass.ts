// GPU grass and wildflowers. Each field is one instanced mesh whose blades
// live on a world-locked lattice that wraps around the camera, so there is
// zero per-frame CPU work no matter how far you run. Density comes from the
// terrain splat map, heights from the heightmap texture, and blades sway with
// rolling wind gusts and part around characters.
import {
  Color3,
  Effect,
  Mesh,
  ShaderMaterial,
  Vector3,
  Vector4,
  VertexBuffer,
  VertexData,
  type Scene,
  type Texture,
} from '@babylonjs/core';
import { SHRINE, VILLAGE } from '@kelia/shared';
import type { QualitySettings } from '../core/quality';
import type { Atmosphere } from './atmosphere';
import { GROUND, GROUND_GRASS_GLSL } from './palette';
import { drawFirst } from './drawOrder';
import { TOON_FOG_GLSL, TOON_FOG_UNIFORMS, bindToonFog, toon } from './toon';
import { PLAZA } from './village';

Effect.ShadersStore['keliaGrassVertexShader'] = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
attribute vec4 color;
attribute vec4 grassInst;
uniform mat4 viewProjection;
uniform vec4 field;   // x = period, y = fade radius, z = inner cut radius, w = density scale
uniform vec4 shape;   // x = height, y = width, z = flower mode, w = time
uniform vec3 camPos;
uniform vec4 wind;    // xy = dir, z = strength, w = gust scale
uniform vec4 pushers[4];
uniform sampler2D heightTex;
uniform sampler2D splatTex;
uniform sampler2D detailTex;
uniform vec3 grassA;
uniform vec3 grassB;
uniform vec3 grassDry;
uniform vec3 forestCol;
uniform vec3 sunDir;
varying vec3 vRoot;
varying float vBloom;
varying vec2 vUv;
varying vec4 vColor;
varying vec3 vPos;
varying float vGust;
varying vec4 vSplat;
varying float vRand;
varying float vPatch;
varying float vFar;
varying float vHue;
varying float vFace;
varying vec3 vBladeN;
#ifdef GSHADOW
uniform mat4 lightMatrix;
varying vec4 vLightPos;
#endif

float hash1(vec2 p) { p = fract(p * vec2(127.1, 311.7)); p += dot(p, p + 19.19); return fract(p.x * p.y); }
float vnoise1(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash1(i), hash1(i + vec2(1.0, 0.0)), u.x), mix(hash1(i + vec2(0.0, 1.0)), hash1(i + vec2(1.0, 1.0)), u.x), u.y);
}

${GROUND_GRASS_GLSL}
float terrainH(vec2 xz) {
  vec2 g = clamp(xz + 512.0, vec2(0.0), vec2(1023.99));
  vec2 i = floor(g);
  vec2 f = g - i;
  ivec2 ii = ivec2(i);
  float a = texelFetch(heightTex, ii, 0).r;
  float b = texelFetch(heightTex, ii + ivec2(1, 0), 0).r;
  float c = texelFetch(heightTex, ii + ivec2(0, 1), 0).r;
  float d = texelFetch(heightTex, ii + ivec2(1, 1), 0).r;
  // match the terrain mesh triangulation (diagonal from (0,0) to (1,1))
  return f.x > f.y ? a + (b - a) * f.x + (d - b) * f.y : a + (d - c) * f.x + (c - a) * f.y;
}

void main(void) {
  float P = field.x;
  vec2 base = camPos.xz - P * 0.5;
  vec2 wp = base + mod(grassInst.xy - base, P);
  float dist = length(wp - camPos.xz);

  // Most of the lattice is behind the camera, off to the sides, past the fade
  // or inside the near field's hole: collapse those tufts before any texture,
  // noise or wind work (every vertex of a tuft takes the same branch).
  vec4 OFF = vec4(2.0, 2.0, 2.0, 1.0);
  if (dist > field.y || dist < field.z * 0.7) { gl_Position = OFF; return; }
  vec4 cp = viewProjection * vec4(wp.x, texelFetch(heightTex, ivec2(clamp(wp + 512.0, vec2(0.0), vec2(1023.0))), 0).r + 0.5, wp.y, 1.0);
  float M = 4.0;
  if (cp.w < -1.5 || cp.x > cp.w + M || cp.x < -cp.w - M || cp.y > cp.w + M || cp.y < -cp.w - M) { gl_Position = OFF; return; }

  vec4 sp = texelFetch(splatTex, ivec2(clamp(wp + 512.5, vec2(0.0), vec2(1024.0))), 0);
  vSplat = sp;
  float dens = clamp((1.0 - sp.g * 1.6) * (1.0 - sp.b * 1.8) * (1.0 - sp.a * 1.4), 0.0, 1.0);
  // flowers grow in drifts: whole patches of one kind, open meadow between
  float drift = vnoise1(wp * 0.045 + 31.0) * 0.7 + vnoise1(wp * 0.13) * 0.3;
  vBloom = drift;
  if (shape.z > 0.5) dens *= (1.0 - sp.r) * smoothstep(0.42, 0.62, drift) * 1.6;
  else dens *= 1.0 - sp.r * 0.45;
  float keep = step(grassInst.z, dens * field.w);
  float fade = 1.0 - smoothstep(field.y * (field.z > 0.0 ? 0.6 : 0.7), field.y, dist);
  // the near and far fields cross-fade over a wide band so there is no seam
  float inner = field.z > 0.0 ? smoothstep(field.z * 0.7, field.z, dist) : 1.0;
  float s = keep * fade * inner * (0.55 + 0.9 * grassInst.w);
  if (s <= 0.0) { gl_Position = OFF; return; }
  // Past a few metres a blade or a flower is only a pixel or two wide: tone
  // its detail down so it reads as a soft mass instead of glittering.
  vFar = smoothstep(6.0, 28.0, dist);
  if (shape.z > 0.5) s *= 1.0 - 0.35 * vFar;
  // taller, lusher grass in the forest edge, short near paths
  s *= mix(1.0, 1.35, sp.r) * (1.0 - sp.a * 0.5);
  // kept short in the village and around the shrine
  s *= mix(0.6, 1.0, smoothstep(${VILLAGE.radius.toFixed(1)} - 12.0, ${VILLAGE.radius.toFixed(1)} + 6.0, length(wp - vec2(${VILLAGE.center[0].toFixed(1)}, ${VILLAGE.center[1].toFixed(1)}))));
  // none on the cobbled square
  s *= smoothstep(${(PLAZA.r + 0.1).toFixed(1)}, ${(PLAZA.r + 1.2).toFixed(1)}, length(wp - vec2(${PLAZA.x.toFixed(1)}, ${PLAZA.z.toFixed(1)})));
  s *= mix(0.5, 1.0, smoothstep(${SHRINE.radius.toFixed(1)} - 2.0, ${SHRINE.radius.toFixed(1)} + 6.0, length(wp - vec2(${SHRINE.center[0].toFixed(1)}, ${SHRINE.center[1].toFixed(1)}))));

  float ang = grassInst.z * 43.7 + grassInst.w * 17.0;
  vec3 lp;
  float hgt = uv.y;
  float bladeH = shape.x;
  if (shape.z > 0.5) {
    float ca = cos(ang); float sa = sin(ang);
    lp = vec3(position.x * shape.y, position.y * shape.x, position.z * shape.y);
    lp = vec3(lp.x * ca - lp.z * sa, lp.y, lp.x * sa + lp.z * ca);
    vHue = 0.5;
    vFace = 0.0;
    vBladeN = vec3(0.0, 1.0, 0.0);
  } else {
    // A tuft: every blade carries its own yaw, outward lean and height in the
    // vertex colour, so one instance is a little fan of blades. Tufts swell
    // into taller clumps and dip into short patches across the meadow.
    float clump = vnoise1(wp * 0.33 + 3.0) * 0.6 + vnoise1(wp * 1.1) * 0.4;
    ang += color.r * 6.2832;
    float ca = cos(ang); float sa = sin(ang);
    bladeH = shape.x * color.b * mix(0.62, 1.38, clump);
    // curvature scales with height, so long blades arc and short ones stand
    lp = vec3(position.x * shape.y * mix(0.85, 1.2, grassInst.w), position.y * bladeH, (position.z + color.g * position.y) * bladeH);
    lp = vec3(lp.x * ca - lp.z * sa, lp.y, lp.x * sa + lp.z * ca);
    vHue = fract(grassInst.z * 7.31 + color.r * 3.7);
    // the blade's concave face points along its arc
    vec2 D = vec2(-sa, ca);
    vFace = dot(D, normalize(sunDir.xz + vec2(1e-4)));
    vBladeN = normalize(vec3(D.x, 0.55 + 0.6 * hgt, D.y));
  }
  lp *= s;

  // Wind: steady sway + rolling gust bands that travel across the meadow.
  float t = shape.w;
  float bend = hgt * hgt;
  float along = dot(wp, wind.xy);
  float gust = sin(along * 0.07 * wind.w - t * 1.6) * 0.5 + 0.5;
  gust = gust * gust * (0.6 + 0.4 * sin(dot(wp, vec2(-wind.y, wind.x)) * 0.05 + t * 0.4));
  vGust = gust;
  float sway = sin(t * 2.3 + wp.x * 0.7 + wp.y * 0.5 + grassInst.z * 6.0) * 0.12;
  vec2 w = wind.xy * (wind.z * (0.25 + gust * 0.9)) + vec2(-wind.y, wind.x) * sway * wind.z;
  lp.xz += w * bend * s * bladeH * 0.75;

  // Characters push the grass aside.
  for (int i = 0; i < 4; i++) {
    vec2 d = wp - pushers[i].xz;
    float r = pushers[i].w;
    float l = length(d);
    float f = (1.0 - smoothstep(r * 0.3, r, l)) * step(0.001, r);
    lp.xz += (d / max(l, 0.001)) * f * bend * 0.9 * s;
    lp.y *= 1.0 - f * 0.55 * hgt;
  }

  vec3 wpos = vec3(wp.x, terrainH(wp) - 0.02, wp.y) + lp;
  vPos = wpos;
  vUv = uv;
  vColor = color;
  vRand = grassInst.z;
  vPatch = vnoise1(wp * 0.06) * 0.65 + vnoise1(wp * 0.21 + 7.0) * 0.35;
  vRoot = groundGrass(wp, sp);
#ifdef GSHADOW
  vLightPos = lightMatrix * vec4(wpos, 1.0);
#endif
  gl_Position = viewProjection * vec4(wpos, 1.0);
}
`;

Effect.ShadersStore['keliaGrassFragmentShader'] = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec4 vColor;
varying vec3 vPos;
varying float vGust;
varying vec4 vSplat;
varying float vRand;
varying float vPatch;
varying float vFar;
varying vec3 vRoot;
varying float vBloom;
varying float vHue;
varying float vFace;
varying vec3 vBladeN;
uniform vec4 shape;
uniform vec3 camPos;
${TOON_FOG_GLSL}
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 ambientColor;
uniform vec3 tipColor;
uniform vec3 dryColor;
#ifdef GSHADOW
varying vec4 vLightPos;
uniform highp sampler2DShadow shadowTex;
uniform vec4 shadowInfo; // x = strength, y = edge falloff
// One hardware-filtered tap of the sun's shadow map (same lookup Babylon's
// PCF uses), faded out toward the map's edge.
float grassShadow() {
  vec3 c = vLightPos.xyz / vLightPos.w;
  vec3 uvd = 0.5 * c + 0.5;
#ifdef IS_NDC_HALF_ZRANGE
  uvd.z = c.z;
#endif
  vec3 q = clamp(uvd, vec3(0.0005), vec3(0.9995));
  float s = texture2DLodEXT(shadowTex, q, 0.);
  float inside = step(abs(c.x), 1.0) * step(abs(c.y), 1.0) * step(uvd.z, 1.0);
  float edge = smoothstep(1.0 - shadowInfo.y, 1.0, clamp(dot(c.xy, c.xy), 0.0, 1.0));
  return mix(1.0, s, inside * (1.0 - edge) * shadowInfo.x);
}
#endif

vec3 flowerPalette(float r) {
  if (r < 0.22) return vec3(1.0, 0.98, 0.92);   // daisies
  if (r < 0.42) return vec3(1.0, 0.8, 0.18);    // buttercups
  if (r < 0.6) return vec3(0.62, 0.45, 1.0);    // violets
  if (r < 0.8) return vec3(1.0, 0.5, 0.66);     // pinks
  return vec3(0.42, 0.68, 1.0);                 // cornflowers
}

void main(void) {
  float h = vUv.y;
  vec3 col;
  float sideLit = 1.0;
  float glint = 0.0;
  vec3 V = normalize(camPos - vPos);
  float near = 1.0 - vFar;
  if (shape.z > 0.5) {
    // flowers: vertex colour alpha marks petals (1) and the heart (0.35)
    float kind = fract(vBloom * 3.7 + vRand * 0.18);
    vec3 petal = flowerPalette(kind);
    vec3 heart = kind < 0.22 ? vec3(1.0, 0.78, 0.15) : petal * 0.7 + vec3(0.25, 0.2, 0.0);
    vec3 stem = vRoot * 0.85;
    // distant flowers become soft dabs of colour, not bright pixel sparkles
    petal = mix(petal, mix(stem, petal, 0.55), vFar);
    col = vColor.a > 0.9 ? petal * petal : vColor.a > 0.2 ? heart * heart : stem;
  } else {
    // Each blade grows out of the ground colour: deep shade at the root, the
    // meadow's own green through the middle and a warm, sunny tip. Blades
    // differ a little in hue (cool blue-greens beside warm yellow-greens) and
    // some are sun-bleached.
    float dry = smoothstep(0.62, 0.95, fract(vRand * 3.7));
    vec3 warmCool = mix(vec3(0.86, 1.0, 1.1), vec3(1.14, 1.05, 0.78), vHue);
    vec3 tip = mix(vRoot * vec3(1.5, 1.5, 1.1) + vec3(0.045, 0.05, 0.0), tipColor, 0.24) * warmCool;
    tip = mix(tip, dryColor, dry * 0.5);
    vec3 mid = vRoot * mix(vec3(1.0), warmCool, 0.5);
    vec3 bse = vRoot * vec3(0.36, 0.42, 0.4);
    col = mix(bse, mid, smoothstep(0.0, 0.42, h));
    col = mix(col, tip, smoothstep(0.38, 1.0, h));
    // Folded blade: the half that faces the sun is bright, the other half
    // sits in its own shade, split along a soft mid-rib (anime two-tone).
    float side = (vUv.x - 0.5) * (gl_FrontFacing ? 1.0 : -1.0);
    float facing = vFace * (gl_FrontFacing ? 1.0 : -1.0);
    float hl = smoothstep(-0.06, 0.06, side * sign(facing + 1e-3));
    sideLit = mix(1.0, mix(0.8, 1.1, hl) * mix(0.9, 1.06, facing * 0.5 + 0.5), near);
    // a fine dark edge keeps neighbouring blades apart up close
    float edge = abs(vUv.x - 0.5) * 2.0;
    col *= 1.0 - 0.16 * smoothstep(0.55, 1.0, edge) * near * (1.0 - h * 0.5);
    // sunlit blades catch a glossy streak
    vec3 Hh = normalize(V + sunDir);
    vec3 N = normalize(vBladeN * (gl_FrontFacing ? 1.0 : -1.0));
    glint = pow(clamp(dot(N, Hh), 0.0, 1.0), 28.0) * smoothstep(0.35, 0.9, h) * near;
    col *= 0.94 + 0.12 * fract(vRand * 13.7) * near;
    // distant blades lean toward the field's average colour (less per-blade contrast)
    col = mix(col, mix(vRoot, tip, 0.5), vFar * 0.6);
  }
  // Lit like the ground it grows from (an up-facing surface under the toon
  // model), so roots melt into the terrain; tips glow when the sun is behind
  // them, and soft drifts of lighter and darker green roll over the meadow.
  col *= mix(0.9, 1.1, vPatch);
  float soft = 0.06;
  float litK = smoothstep(-soft, soft, sunDir.y) * (1.0 + 0.12 * smoothstep(0.5, 0.7, sunDir.y));
  float back = clamp(dot(-V, sunDir), 0.0, 1.0);
  float trans = (pow(back, 3.0) * 0.95 + pow(back, 12.0) * 0.6) * h * (1.0 - 0.7 * vFar);
  float ao = mix(mix(0.72, 1.0, h), 0.95, vFar * 0.6);
  float sh = 1.0;
#ifdef GSHADOW
  sh = grassShadow();
#endif
  float sun = litK * sh * (1.0 - vSplat.r * 0.25);
  vec3 lit3 = col * (sunColor * litK * sideLit * sh * (1.0 - vSplat.r * 0.25) + ambientColor) * ao;
  // backlit blades glow a warm, translucent yellow-green
  lit3 += col * vec3(1.15, 1.2, 0.6) * sunColor * trans * sun;
  lit3 += sunColor * vec3(1.0, 0.97, 0.8) * glint * 0.32 * sun;
  // rolling wind gusts catch the light: a silvery sheen sweeping over the field
  float sheen = vGust * vGust * vGust;
  lit3 += (col * 0.5 + vec3(0.05, 0.06, 0.03)) * sheen * 0.55 * sunColor * h * sh * (1.0 - 0.6 * vFar);
  vec3 lit = lit3;
  gl_FragColor = vec4(kFog(lit, vPos, camPos), 1.0);
}
`;

/**
 * A tuft of tapered, arcing blades: each blade is 4 segments (9 vertices),
 * and its vertex colour carries the blade's yaw (r, 0..1 of a turn), outward
 * lean (g) and height (b). One blade alone is the far field's tuft.
 */
function tuftGeometry(blades: { yaw: number; lean: number; h: number }[]): VertexData {
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const segs = 4;
  for (const bl of blades) {
    const o = positions.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      // widest a third of the way up, then a long taper to a sharp tip
      const w = 0.5 * Math.sin(Math.min(1, t * 1.5 + 0.35) * Math.PI * 0.5) * (1 - Math.pow(t, 1.8));
      const curve = t * t * 0.28;
      if (i < segs) {
        positions.push(-w, t, curve, w, t, curve);
        uvs.push(0, t, 1, t);
        colors.push(bl.yaw, bl.lean, bl.h, 0, bl.yaw, bl.lean, bl.h, 0);
      } else {
        positions.push(0, t, curve);
        uvs.push(0.5, 1);
        colors.push(bl.yaw, bl.lean, bl.h, 0);
      }
    }
    for (let i = 0; i < segs - 1; i++) {
      const a = o + i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const last = o + (segs - 1) * 2;
    indices.push(last, last + 2, last + 1);
  }
  const vd = new VertexData();
  vd.positions = positions;
  vd.uvs = uvs;
  vd.colors = colors;
  vd.indices = indices;
  return vd;
}

const NEAR_TUFT = [
  { yaw: 0.0, lean: 0.1, h: 1.0 },
  { yaw: 0.36, lean: 0.26, h: 0.8 },
  { yaw: 0.69, lean: 0.34, h: 0.66 },
];
const FAR_TUFT = [{ yaw: 0, lean: 0.08, h: 1 }];

function flowerGeometry(): VertexData {
  // A thin stem, a little leaf, and a cupped head of six rounded petals around
  // a raised heart (vertex alpha: 0 = stem/leaf, 0.35 = heart, 1 = petal).
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const vtx = (x: number, y: number, z: number, v: number, a: number) => {
    positions.push(x, y, z);
    uvs.push(0.5, v);
    colors.push(1, 1, 1, a);
    return positions.length / 3 - 1;
  };
  const sw = 0.035;
  const y = 0.82;
  {
    const a = vtx(-sw, 0, 0, 0, 0);
    const b = vtx(sw, 0, 0, 0, 0);
    const c = vtx(sw * 0.6, y, 0.04, y, 0);
    const d = vtx(-sw * 0.6, y, 0.04, y, 0);
    indices.push(a, b, c, a, c, d);
    // a leaf halfway up
    const l0 = vtx(0, 0.3, 0, 0.3, 0);
    const l1 = vtx(0.22, 0.42, 0.06, 0.42, 0);
    const l2 = vtx(0.1, 0.36, -0.07, 0.36, 0);
    indices.push(l0, l1, l2);
  }
  // petal fans start from their own centre vertex (pure petal colour); the heart covers it
  const heart = vtx(0, y + 0.05, 0.04, 1, 1);
  const petals = 6;
  for (let k = 0; k < petals; k++) {
    const a0 = (k / petals) * Math.PI * 2;
    // each petal: a rounded fan from the heart, tips curling up into a cup
    const fan = [-0.42, -0.22, 0, 0.22, 0.42];
    const ids = fan.map((o) => {
      const a = a0 + o;
      const r = 0.48 * Math.cos(o * 1.6);
      return vtx(Math.cos(a) * r, y + 0.03 + r * 0.28, 0.04 + Math.sin(a) * r, 1, 1);
    });
    for (let i = 0; i < ids.length - 1; i++) indices.push(heart, ids[i], ids[i + 1]);
  }
  // the heart sits proud of the petals
  const hr = 0.13;
  const ring: number[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    ring.push(vtx(Math.cos(a) * hr, y + 0.07, 0.04 + Math.sin(a) * hr, 1, 0.35));
  }
  const top = vtx(0, y + 0.11, 0.04, 1, 0.35);
  for (let k = 0; k < 6; k++) indices.push(top, ring[k], ring[(k + 1) % 6]);
  const vd = new VertexData();
  vd.positions = positions;
  vd.uvs = uvs;
  vd.colors = colors;
  vd.indices = indices;
  return vd;
}

interface Field {
  mesh: Mesh;
  mat: ShaderMaterial;
  shape: [number, number, number];
  fv: Vector4;
  /** Own vector per field: ShaderMaterial keeps a reference, not a copy. */
  sv: Vector4;
}

export class Grass {
  private fields: Field[] = [];
  private pushers = new Float32Array(16);
  readonly wind = new Vector4(0.8, 0.6, 0.55, 1);
  private sunCol = new Color3();
  private ambCol = new Color3();
  private dirV = new Vector3();
  private pushArr: number[] = [];
  private shadowV = new Vector4();

  constructor(private scene: Scene, private heightTex: Texture, private splatTex: Texture, private detailTex: Texture, private atmosphere: Atmosphere) {}

  applyQuality(q: QualitySettings) {
    for (const f of this.fields) {
      f.mesh.dispose();
      f.mat.dispose();
    }
    this.fields = [];
    const innerR = q.grassRadius * 0.34;
    // inner dense field, outer sparse field of bigger tufts, and flowers
    // near: dense tufts of three blades; far: bigger single blades
    this.addField('grassNear', tuftGeometry(NEAR_TUFT), innerR, 0, q.grassDensity * 0.45, { h: 0.5, w: 0.11, flower: false });
    this.addField('grassFar', tuftGeometry(FAR_TUFT), q.grassRadius, innerR, q.grassDensity * 0.3, { h: 0.62, w: 0.17, flower: false });
    this.addField('flowers', flowerGeometry(), Math.min(q.grassRadius, 46), 0, q.grassDensity * 0.09, { h: 0.38, w: 0.3, flower: true });
  }

  private addField(name: string, geo: VertexData, radius: number, innerCut: number, density: number, shape: { h: number; w: number; flower: boolean }) {
    const period = radius * 2;
    // jittered lattice
    const cell = 1 / Math.sqrt(density);
    const n = Math.max(1, Math.floor(period / cell));
    const count = n * n;
    const inst = new Float32Array(count * 4);
    let seed = 12345 + Math.round(radius * 31);
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let j = 0, k = 0; j < n; j++) {
      for (let i = 0; i < n; i++, k++) {
        inst[k * 4] = (i + rnd()) * (period / n);
        inst[k * 4 + 1] = (j + rnd()) * (period / n);
        inst[k * 4 + 2] = rnd();
        inst[k * 4 + 3] = rnd();
      }
    }
    const mesh = new Mesh(name, this.scene);
    geo.applyToMesh(mesh);
    const buf = new VertexBuffer(this.scene.getEngine(), inst, 'grassInst', { updatable: false, stride: 4, size: 4, instanced: true, divisor: 1 });
    mesh.setVerticesBuffer(buf);
    mesh.forcedInstanceCount = count;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.doNotSyncBoundingInfo = true;
    mesh.freezeWorldMatrix();
    drawFirst(mesh);
    const sg = this.atmosphere.shadows;
    const mat = new ShaderMaterial(name + 'Mat', this.scene, 'keliaGrass', {
      attributes: ['position', 'uv', 'color', 'grassInst'],
      uniforms: ['viewProjection', 'field', 'shape', 'camPos', 'wind', 'pushers', 'sunDir', 'sunColor', 'ambientColor', ...TOON_FOG_UNIFORMS, 'tipColor', 'dryColor', 'grassA', 'grassB', 'grassDry', 'forestCol', 'lightMatrix', 'shadowInfo'],
      samplers: ['heightTex', 'splatTex', 'detailTex', 'shadowTex'],
      defines: sg ? ['GSHADOW'] : [],
    });
    if (sg) {
      // Grass receives the sun's shadow map: bind its depth texture with the
      // comparison sampler, exactly like Babylon's own PCF receivers.
      mat.onBindObservable.add(() => {
        const map = sg.getShadowMap();
        const eff = mat.getEffect();
        if (map && eff) eff.setDepthStencilTexture('shadowTex', map);
      });
    }
    mat.backFaceCulling = false;
    mat.setTexture('heightTex', this.heightTex);
    mat.setTexture('splatTex', this.splatTex);
    mat.setTexture('detailTex', this.detailTex);
    mat.setColor3('tipColor', Color3.FromHexString('#c4e46a').toLinearSpace());
    mat.setColor3('dryColor', Color3.FromHexString('#e2d77a').toLinearSpace());
    for (const k of ['grassA', 'grassB', 'grassDry', 'forestCol'] as const) mat.setColor3(k, Color3.FromArray(GROUND[k]));
    mesh.material = mat;
    const fv = new Vector4(period, radius, innerCut, 1);
    this.fields.push({ mesh, mat, shape: [shape.h, shape.w, shape.flower ? 1 : 0], fv, sv: new Vector4() });
  }

  /** Up to four characters that bend the grass (x, z, radius). */
  setPushers(list: { x: number; z: number; r: number }[]) {
    this.pushers.fill(0);
    for (let i = 0; i < Math.min(4, list.length); i++) {
      this.pushers[i * 4] = list[i].x;
      this.pushers[i * 4 + 2] = list[i].z;
      this.pushers[i * 4 + 3] = list[i].r;
    }
  }

  update(time: number, cameraPos: Vector3) {
    const a = this.atmosphere;
    const sun = this.sunCol.set(toon.sun.x, toon.sun.y, toon.sun.z);
    const sh = toon.shade;
    // the same sky fill the toon model gives flat ground, so blades and soil match
    const amb = this.ambCol.set(toon.sky.x * sh.x, toon.sky.y * sh.y, toon.sky.z * sh.z);
    const dir = this.dirV.set(toon.sunDir.x, toon.sunDir.y, toon.sunDir.z);
    const sg = a.shadows;
    this.pushArr.length = 0;
    for (let i = 0; i < 16; i++) this.pushArr.push(this.pushers[i]);
    this.fields.forEach((f) => {
      const m = f.mat;
      m.setVector4('field', f.fv);
      m.setVector4('shape', f.sv.set(f.shape[0], f.shape[1], f.shape[2], time));
      m.setVector3('camPos', cameraPos);
      m.setVector4('wind', this.wind);
      m.setArray4('pushers', this.pushArr);
      m.setVector3('sunDir', dir);
      m.setColor3('sunColor', sun);
      m.setColor3('ambientColor', amb);
      bindToonFog(m);
      if (sg) {
        m.setMatrix('lightMatrix', sg.getTransformMatrix());
        m.setVector4('shadowInfo', this.shadowV.set(toon.sunDir.w, sg.frustumEdgeFalloff, 0, 0));
      }
    });
  }
}
