// GPU grass and wildflowers. Each field is one instanced mesh whose blades
// live on a world-locked lattice that wraps around the camera, so there is
// zero per-frame CPU work no matter how far you run. Density comes from the
// terrain splat map, heights from the heightmap texture, and blades sway with
// rolling wind gusts and part around characters.
//
// Grass comes in three rings: a dense carpet of fine blades close to the
// camera, thinner tufts through the middle distance and single blades out to
// the horizon, each cross-fading into the next. Every lattice only spans the
// square that can be on screen (it leads the camera's heading), so no work
// goes into the ground behind you.
import {
  Axis,
  Color3,
  Effect,
  Mesh,
  RawTexture,
  ShaderMaterial,
  Texture,
  Vector3,
  Vector4,
  VertexBuffer,
  VertexData,
  type Scene,
} from '@babylonjs/core';
import { SHRINE, VILLAGE, WORLD_HALF } from '@kelia/shared';
import type { QualitySettings } from '../core/quality';
import type { Atmosphere } from './atmosphere';
import { GROUND, GROUND_GRASS_GLSL } from './palette';
import { drawFirst } from './drawOrder';
import { TOON_FOG_GLSL, TOON_FOG_UNIFORMS, bindToonFog, toon } from './toon';
import { PLAZA } from './village';
import { WORLD_LIGHT_GLSL, worldLight } from './worldLight';

type RGB = [number, number, number];
interface Colourway {
  /** Picked while the colourway roll k is below this. */
  upTo: number;
  base: RGB;
  tip: RGB;
  heart?: RGB;
}

/**
 * Petal base, petal tip and heart colours of each flower species (1-based in
 * the shader), in a few colourways. A heart left out is the tip colour.
 */
const COLOURWAYS: { name: string; heartIsBase?: boolean; ways: Colourway[] }[] = [
  {
    name: 'daisies, pink daisies, asters',
    ways: [
      { upTo: 0.55, base: [0.96, 0.93, 0.84], tip: [1, 1, 1], heart: [1, 0.76, 0.14] },
      { upTo: 0.8, base: [0.98, 0.56, 0.74], tip: [1, 0.86, 0.92], heart: [1, 0.76, 0.14] },
      { upTo: 2, base: [0.58, 0.46, 0.98], tip: [0.8, 0.74, 1], heart: [1, 0.8, 0.2] },
    ],
  },
  {
    name: 'buttercups, red and orange poppies',
    ways: [
      { upTo: 0.45, base: [1, 0.7, 0.06], tip: [1, 0.92, 0.3], heart: [0.86, 0.72, 0.2] },
      { upTo: 0.78, base: [0.82, 0.08, 0.07], tip: [1, 0.32, 0.22], heart: [0.12, 0.08, 0.12] },
      { upTo: 2, base: [1, 0.42, 0.06], tip: [1, 0.68, 0.26], heart: [0.3, 0.18, 0.08] },
    ],
  },
  {
    name: 'bellflowers',
    ways: [
      { upTo: 0.5, base: [0.2, 0.26, 0.86], tip: [0.5, 0.62, 1] },
      { upTo: 0.8, base: [0.46, 0.24, 0.84], tip: [0.76, 0.58, 1] },
      { upTo: 2, base: [0.82, 0.8, 0.98], tip: [1, 1, 1] },
    ],
  },
  {
    name: 'lupins',
    ways: [
      { upTo: 0.4, base: [0.36, 0.22, 0.82], tip: [0.72, 0.58, 1] },
      { upTo: 0.7, base: [0.88, 0.3, 0.58], tip: [1, 0.72, 0.86] },
      { upTo: 0.92, base: [0.92, 0.9, 0.84], tip: [1, 1, 1] },
      { upTo: 2, base: [0.98, 0.66, 0.16], tip: [1, 0.9, 0.46] },
    ],
  },
  {
    name: 'clover',
    heartIsBase: true,
    ways: [
      { upTo: 0.62, base: [0.74, 0.26, 0.56], tip: [1, 0.62, 0.84] },
      { upTo: 2, base: [0.9, 0.88, 0.8], tip: [1, 1, 1] },
    ],
  },
];

const v3 = (c: RGB) => `vec3(${c.map((x) => x.toFixed(3)).join(', ')})`;

/** GLSL flowerColors(species, k, base, tip, heart), built from COLOURWAYS. */
function flowerColorsGlsl(): string {
  const body = COLOURWAYS.map((sp, i) => {
    const ways = sp.ways
      .map((w, j) => {
        const heart = w.heart ?? (sp.heartIsBase ? w.base : w.tip);
        const set = `base = ${v3(w.base)}; tip = ${v3(w.tip)}; heart = ${v3(heart)};`;
        return j === sp.ways.length - 1 ? `{ ${set} }` : `if (k < ${w.upTo.toFixed(2)}) { ${set} }`;
      })
      .join(' else ');
    return i === COLOURWAYS.length - 1 ? `{ // ${sp.name}\n    ${ways}\n  }` : `if (sp < ${(i + 1.5).toFixed(1)}) { // ${sp.name}\n    ${ways}\n  }`;
  }).join(' else ');
  return `void flowerColors(float sp, float k, out vec3 base, out vec3 tip, out vec3 heart) {\n  ${body}\n}\n`;
}

/** How much each species shows up as colour in the far grass of its drifts. */
const BLOOM_TINT = [1.0, 0.85, 0.75, 0.55, 0.5];

const BLOOM_GLSL = /* glsl */ `
${flowerColorsGlsl()}
// Drift maps: how much each species (daisy, cup, bell, spike in bloomA; clover
// in bloomB.r) flowers at a spot. Patches start at 0.5 and peak at 0.68.
vec4 driftA(vec2 wp) { return textureLod(bloomA, (wp + ${WORLD_HALF.toFixed(1)}) / ${(WORLD_HALF * 2).toFixed(1)}, 0.0); }
float driftB(vec2 wp) { return textureLod(bloomB, (wp + ${WORLD_HALF.toFixed(1)}) / ${(WORLD_HALF * 2).toFixed(1)}, 0.0).r; }
`;

Effect.ShadersStore['keliaGrassVertexShader'] = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
attribute vec4 color;
attribute vec4 grassInst;
uniform mat4 viewProjection;
uniform vec4 field;   // x = period, y = fade radius, z = inner cut radius, w = density scale
uniform vec4 shape;   // x = height, y = width, z = flower species (0 = grass), w = time
uniform vec4 look;    // xy = camera heading on the ground, z = how far the lattice leads it, w = flower radius
uniform vec3 camPos;
uniform float pxScale; // pixels per metre at 1 m from the camera
uniform vec4 wind;    // xy = dir, z = strength, w = gust scale
uniform vec4 pushers[4];
uniform sampler2D heightTex;
uniform sampler2D splatTex;
uniform sampler2D detailTex;
uniform sampler2D bloomA;
uniform sampler2D bloomB;
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
varying float vDetail;
varying float vHue;
varying float vFace;
varying vec3 vBladeN;
varying vec3 vGI;
varying vec3 vN;
varying vec4 vTint;
uniform sampler2D kLightMap;
uniform sampler2D kBounceMap;
uniform vec4 toonGI;
uniform vec4 toonGIShadow;
${WORLD_LIGHT_GLSL}
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
${BLOOM_GLSL}
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

// Grass in a flower drift: each blade picks one species, weighted by how
// strongly each blooms here, and carries that flower's colour (rgb) and the
// drift's strength (a).
vec4 bloomTint(vec4 dA, float dB, float r) {
  vec4 sA = smoothstep(0.5, 0.68, dA) * vec4(${BLOOM_TINT.slice(0, 4).map((x) => x.toFixed(2)).join(', ')});
  float s5 = smoothstep(0.5, 0.68, dB) * ${BLOOM_TINT[4].toFixed(2)};
  vec4 jA = sA * (0.4 + fract(r * vec4(13.1, 27.7, 41.3, 57.9)));
  float best = s5 * (0.4 + fract(r * 71.3));
  float sp = 5.0; float d = dB; float st = s5;
  if (jA.x > best) { best = jA.x; sp = 1.0; d = dA.x; st = sA.x; }
  if (jA.y > best) { best = jA.y; sp = 2.0; d = dA.y; st = sA.y; }
  if (jA.z > best) { best = jA.z; sp = 3.0; d = dA.z; st = sA.z; }
  if (jA.w > best) { best = jA.w; sp = 4.0; d = dA.w; st = sA.w; }
  vec3 b; vec3 t; vec3 h;
  flowerColors(sp, fract(d * 2.7 + r * 0.22), b, t, h);
  vec3 c = mix(b, t, 0.55);
  return vec4(c * c * 0.82, st);
}

void main(void) {
  float P = field.x;
  // the lattice window leads the camera, so it covers what can be on screen
  vec2 base = camPos.xz + look.xy * look.z - P * 0.5;
  vec2 wp = base + mod(grassInst.xy - base, P);
  float dist = length(wp - camPos.xz);

  // Most of the lattice is off to the sides, past the fade or inside the
  // near field's hole: collapse those tufts before any texture, noise or wind
  // work (every vertex of a tuft takes the same branch).
  vec4 OFF = vec4(2.0, 2.0, 2.0, 1.0);
  if (dist > field.y || dist < field.z * 0.7) { gl_Position = OFF; return; }
  vec4 cp = viewProjection * vec4(wp.x, texelFetch(heightTex, ivec2(clamp(wp + 512.0, vec2(0.0), vec2(1023.0))), 0).r + 0.5, wp.y, 1.0);
  float M = 4.0;
  if (cp.w < -1.5 || cp.x > cp.w + M || cp.x < -cp.w - M || cp.y > cp.w + M || cp.y < -cp.w - M) { gl_Position = OFF; return; }

  vec4 sp = texelFetch(splatTex, ivec2(clamp(wp + 512.5, vec2(0.0), vec2(1024.0))), 0);
  vSplat = sp;
  float dens = clamp((1.0 - sp.g * 1.6) * (1.0 - sp.b * 1.8) * (1.0 - sp.a * 1.4), 0.0, 1.0);
  vec4 dA = driftA(wp);
  float dB = driftB(wp);
  // Flowers grow in drifts: each species has its own patches (one colourway
  // per patch) that thicken toward their hearts and thin out at the edges,
  // open meadow between and the odd stray bloom anywhere.
  vec4 mA = max(1.0 - abs(vec4(1.0, 2.0, 3.0, 4.0) - shape.z), 0.0);
  float drift = dot(dA, mA) + dB * step(4.5, shape.z);
  vBloom = drift;
  float edge = dens;
  if (shape.z > 0.5) dens *= (1.0 - sp.r) * (smoothstep(0.5, 0.7, drift) * 1.15 + 0.025);
  else dens *= 1.0 - sp.r * 0.45;
  float keep = step(grassInst.z, dens * field.w);
  float fade = 1.0 - smoothstep(field.y * (field.z > 0.0 ? 0.6 : 0.7), field.y, dist);
  // the rings cross-fade over a wide band so there is no seam
  float inner = field.z > 0.0 ? smoothstep(field.z * 0.7, field.z, dist) : 1.0;
  float s = keep * fade * inner * (0.55 + 0.9 * grassInst.w);
  if (s <= 0.0) { gl_Position = OFF; return; }
  // Past a few metres a blade or a flower is only a pixel or two wide: tone
  // its detail down so it reads as a soft mass instead of glittering.
  vFar = smoothstep(6.0, 28.0, dist);
  if (shape.z > 0.5) s *= 1.0 - 0.2 * vFar;
  // How many pixels wide a blade (or a flower head) is on screen. Anything
  // thinner than a few pixels can't be drawn steadily: as it sways it lands
  // on a pixel one frame and misses it the next, so its sparkle (white
  // petals, sun glints, glowing tips) has to fade out before it gets there.
  // (shape.y is a blade's width, or a flower's scale: its head is ~8 cm)
  float pxW = shape.y * pxScale / max(dist, 0.3);
  float px = pxW * s * (shape.z > 0.5 ? 0.08 : 1.0);
  vDetail = shape.z > 0.5 ? smoothstep(2.0, 6.0, px) : smoothstep(2.0, 8.0, px);
  // taller, lusher grass in the forest edge, short near paths, and blades
  // shrink where the meadow thins out over sand and dirt so it feathers out
  s *= mix(1.0, 1.35, sp.r) * (1.0 - sp.a * 0.5);
  if (shape.z < 0.5) s *= mix(0.45, 1.0, smoothstep(0.05, 0.6, edge));
  // kept short in the village and around the shrine
  s *= mix(0.6, 1.0, smoothstep(${VILLAGE.radius.toFixed(1)} - 12.0, ${VILLAGE.radius.toFixed(1)} + 6.0, length(wp - vec2(${VILLAGE.center[0].toFixed(1)}, ${VILLAGE.center[1].toFixed(1)}))));
  // none on the cobbled square
  s *= smoothstep(${(PLAZA.r + 0.1).toFixed(1)}, ${(PLAZA.r + 1.2).toFixed(1)}, length(wp - vec2(${PLAZA.x.toFixed(1)}, ${PLAZA.z.toFixed(1)})));
  s *= mix(0.5, 1.0, smoothstep(${SHRINE.radius.toFixed(1)} - 2.0, ${SHRINE.radius.toFixed(1)} + 6.0, length(wp - vec2(${SHRINE.center[0].toFixed(1)}, ${SHRINE.center[1].toFixed(1)}))));

  float ang = grassInst.z * 43.7 + grassInst.w * 17.0;
  vec3 lp;
  float hgt = uv.y;
  float bladeH = shape.x;
  vN = vec3(0.0, 1.0, 0.0);
  vTint = vec4(0.0);
  if (shape.z > 0.5) {
    // A flower plant: its own stem height, head size and nod, and one, two
    // or three heads (extra heads are tagged 0.5 / 1 in colour r). uv.x is the
    // height a part hangs from: stems stretch, heads scale and tip about it.
    float roll = fract(grassInst.z * 91.7 + grassInst.w * 13.3);
    float show = color.r < 0.25 ? 1.0 : color.r < 0.75 ? step(0.4, roll) : step(0.72, roll);
    float stemK = mix(0.78, 1.25, fract(grassInst.w * 5.3)) * mix(0.88, 1.15, vnoise1(wp * 0.21 + 11.0));
    float headK = mix(0.8, 1.25, fract(grassInst.z * 17.9));
    float isHead = step(0.1, color.a);
    vec3 off = position - vec3(0.0, uv.x, 0.0);
    vec3 n = normal;
    float nod = (fract(grassInst.w * 29.1) - 0.5) * 0.8 * color.b;
    float cn = cos(nod); float sn = sin(nod);
    off.xy = vec2(off.x * cn - off.y * sn, off.x * sn + off.y * cn);
    n.xy = vec2(n.x * cn - n.y * sn, n.x * sn + n.y * cn);
    off *= shape.y * mix(1.0, headK, isHead);
    vec3 g = (vec3(0.0, uv.x * stemK * shape.x, 0.0) + off) * show;
    float ca = cos(ang); float sa = sin(ang);
    lp = vec3(g.x * ca - g.z * sa, g.y, g.x * sa + g.z * ca);
    vN = vec3(n.x * ca - n.z * sa, n.y, n.x * sa + n.z * ca);
    bladeH = 0.24 * shape.x;
    vHue = 0.5;
    vFace = 0.0;
    vBladeN = vec3(0.0, 1.0, 0.0);
  } else {
    // A tuft: every blade carries its own yaw, outward lean, height and how
    // far from the tuft's heart it roots in the vertex colour, so one
    // instance is a little clump of blades. Tufts swell into taller clumps
    // and dip into short patches across the meadow, and settle a little
    // lower inside flower drifts so the blooms stand clear of them.
    float clump = vnoise1(wp * 0.33 + 3.0) * 0.6 + vnoise1(wp * 1.1) * 0.4;
    float bloom = dot(smoothstep(0.5, 0.68, dA), vec4(1.0)) + smoothstep(0.5, 0.68, dB);
    ang += color.r * 6.2832;
    float ca = cos(ang); float sa = sin(ang);
    bladeH = shape.x * color.b * mix(0.62, 1.38, clump) * (1.0 - 0.35 * clamp(bloom, 0.0, 1.0) * (1.0 - sp.r));
    // a blade never gets thinner than about a pixel and a half on screen
    float wide = shape.y * mix(0.8, 1.2, fract(grassInst.w * 7.0 + color.r)) * clamp(1.5 / max(pxW, 1e-3), 1.0, 2.5);
    // curvature scales with height, so long blades arc and short ones stand
    lp = vec3(position.x * wide, position.y * bladeH, (position.z + color.g * position.y) * bladeH + color.a * shape.y * 1.8);
    lp = vec3(lp.x * ca - lp.z * sa, lp.y, lp.x * sa + lp.z * ca);
    vHue = fract(grassInst.z * 7.31 + color.r * 3.7);
    // the blade's concave face points along its arc
    vec2 D = vec2(-sa, ca);
    vFace = dot(D, normalize(sunDir.xz + vec2(1e-4)));
    vBladeN = normalize(vec3(D.x, 0.55 + 0.6 * hgt, D.y));
    // Out past the flowers, blades in a drift carry its colours instead.
    if (field.z > 0.0) {
      vTint = bloomTint(dA, dB, vHue);
      vTint.a *= (1.0 - sp.r) * smoothstep(look.w * 0.55, look.w * 0.95, dist);
    }
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
  // baked sky visibility and canopy at the tuft (blades sit within a few cm of the ground)
  vGI = kWorldLight(wpos);
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
varying float vDetail;
varying vec3 vRoot;
varying float vBloom;
varying float vHue;
varying float vFace;
varying vec3 vBladeN;
varying vec3 vGI;
varying vec3 vN;
varying vec4 vTint;
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

${flowerColorsGlsl()}

void main(void) {
  float h = vUv.y;
  vec3 col;
  float sideLit = 1.0;
  float skyLit = 1.0;
  float glint = 0.0;
  float petalGlow = 0.0;
  vec3 V = normalize(camPos - vPos);
  float near = 1.0 - vFar;
  if (shape.z > 0.5) {
    // flowers: vertex colour alpha marks petals (1) and the heart (0.35),
    // green runs from each petal's base to its tip
    vec3 pb; vec3 pt; vec3 heart;
    flowerColors(shape.z, fract(vBloom * 2.7 + vRand * 0.22), pb, pt, heart);
    vec3 petal = mix(pb, pt, smoothstep(0.0, 1.0, vColor.g)) * (0.9 + 0.2 * fract(vRand * 31.7));
    vec3 stem = vRoot * 0.85;
    // small flowers become soft dabs of colour, not bright pixel sparkles
    float dab = 1.0 - vDetail;
    petal = mix(petal, mix(stem, petal, 0.6), dab);
    heart = mix(heart, mix(stem, petal, 0.6), dab);
    // pure white petals would sit far above everything else in the meadow
    col = vColor.a > 0.9 ? petal * petal * 0.82 : vColor.a > 0.2 ? heart * heart : stem;
    if (vColor.a > 0.2) {
      // Petals are lit as real little surfaces: a soft two-tone turn from
      // sun to shade, the back of a petal a little darker and the inside of
      // a bell deep in its own shadow, and sun shining through from behind.
      // a normal half as long marks a hollow (the inside of a bell)
      float cavity = smoothstep(0.85, 0.6, length(vN));
      vec3 n = normalize(vN + vec3(0.0, 1e-4, 0.0));
      float inside = step(dot(n, V), 0.0);
      vec3 Nv = mix(n, -n, inside);
      float ndl = dot(Nv, sunDir);
      sideLit = mix(1.0, mix(0.62, 1.08, smoothstep(-0.2, 0.35, ndl)), vDetail);
      float hollow = mix(1.0, mix(0.74, 0.5, cavity), inside * vDetail);
      // the base of each petal sits in the flower's own shade
      hollow *= mix(0.78, 1.0, smoothstep(0.0, 0.5, vColor.g));
      col *= hollow;
      skyLit = hollow;
      petalGlow = pow(clamp(dot(-V, sunDir), 0.0, 1.0), 4.0) * 0.45 * vDetail;
    }
  } else {
    // Each blade grows out of the ground colour: the soil's own shade at
    // the root, the meadow's green through the middle and a warm, sunny tip.
    // Blades differ a little in hue (cool blue-greens beside warm
    // yellow-greens) and some are sun-bleached.
    float dry = smoothstep(0.62, 0.95, fract(vRand * 3.7));
    vec3 warmCool = mix(vec3(0.86, 1.0, 1.1), vec3(1.14, 1.05, 0.78), vHue);
    vec3 tip = mix(vRoot * vec3(1.45, 1.45, 1.1) + vec3(0.04, 0.045, 0.0), tipColor, 0.22) * warmCool;
    tip = mix(tip, dryColor, dry * 0.5);
    vec3 mid = vRoot * mix(vec3(1.0), warmCool, 0.5);
    vec3 bse = vRoot * vec3(0.62, 0.68, 0.64);
    col = mix(bse, mid, smoothstep(0.0, 0.45, h));
    col = mix(col, tip, smoothstep(0.4, 1.0, h));
    // Folded blade: the half that faces the sun is bright, the other half
    // sits in its own shade, split along a soft mid-rib (anime two-tone).
    float side = (vUv.x - 0.5) * (gl_FrontFacing ? 1.0 : -1.0);
    float facing = vFace * (gl_FrontFacing ? 1.0 : -1.0);
    float hl = smoothstep(-0.08, 0.08, side * sign(facing + 1e-3));
    sideLit = mix(1.0, mix(0.84, 1.08, hl) * mix(0.9, 1.06, facing * 0.5 + 0.5), near * vDetail);
    // a fine dark edge keeps neighbouring blades apart up close
    float edge = abs(vUv.x - 0.5) * 2.0;
    col *= 1.0 - 0.1 * smoothstep(0.6, 1.0, edge) * near * vDetail * (1.0 - h * 0.5);
    // sunlit blades catch a glossy streak
    vec3 Hh = normalize(V + sunDir);
    vec3 N = normalize(vBladeN * (gl_FrontFacing ? 1.0 : -1.0));
    glint = pow(clamp(dot(N, Hh), 0.0, 1.0), 28.0) * smoothstep(0.35, 0.9, h) * near * vDetail * vDetail;
    col *= 0.94 + 0.12 * fract(vRand * 13.7) * near;
    // distant blades lean toward the field's average colour (less per-blade contrast)
    col = mix(col, mix(vRoot, tip, 0.45), vFar * 0.65);
    // In a far flower drift, blade tips carry the flowers' colours: a few
    // crisp buds in the middle distance, a soft wash of colour further out.
    float dCam = length(vPos - camPos);
    float bud = mix(step(fract(vHue * 61.7 + vRand * 7.0), vTint.a * 0.55), vTint.a * 0.4, smoothstep(30.0, 60.0, dCam));
    col = mix(col, vTint.rgb, bud * smoothstep(0.62, 0.9, h));
  }
  // Lit like the ground it grows from (an up-facing surface under the toon
  // model), so roots melt into the terrain; tips glow when the sun is behind
  // them, and soft drifts of lighter and darker green roll over the meadow.
  col *= mix(0.9, 1.1, vPatch);
  float soft = 0.06;
  float litK = smoothstep(-soft, soft, sunDir.y) * (1.0 + 0.12 * smoothstep(0.5, 0.7, sunDir.y));
  float back = clamp(dot(-V, sunDir), 0.0, 1.0);
  float trans = (pow(back, 3.0) * 0.95 + pow(back, 12.0) * 0.6) * h * (1.0 - 0.7 * vFar) * mix(0.35, 1.0, vDetail);
  float ao = mix(mix(0.8, 1.0, h), 0.95, vFar * 0.6);
  float sh = 1.0;
#ifdef GSHADOW
  sh = grassShadow();
#endif
  sh *= vGI.y;
  float sun = litK * sh * (1.0 - vSplat.r * 0.25);
  vec3 sky = ambientColor * vGI.x * mix(vec3(1.0), vec3(0.82, 1.04, 0.78), vGI.z) * skyLit;
  vec3 lit3 = col * (sunColor * litK * sideLit * sh * (1.0 - vSplat.r * 0.25) + sky) * ao;
  // backlit blades and petals glow a warm, translucent colour
  lit3 += col * vec3(1.15, 1.2, 0.6) * sunColor * trans * sun;
  lit3 += col * sunColor * petalGlow * sun;
  lit3 += sunColor * vec3(1.0, 0.97, 0.8) * glint * 0.32 * sun;
  // rolling wind gusts catch the light: a silvery sheen sweeping over the field
  float sheen = vGust * vGust * vGust;
  lit3 += (col * 0.5 + vec3(0.05, 0.06, 0.03)) * sheen * 0.55 * sunColor * h * sh * (1.0 - 0.6 * vFar);
  // no blade or petal outshines the sky: single over-bright pixels are what flickers
  float peak = max(lit3.r, max(lit3.g, lit3.b));
  vec3 lit = lit3 * min(1.0, 1.5 / max(peak, 1e-4));
  gl_FragColor = vec4(kFog(lit, vPos, camPos), 1.0);
}
`;

interface Blade {
  yaw: number;
  lean: number;
  h: number;
  /** How far from the tuft's heart the blade roots (0..1 of the spread). */
  off: number;
}

/**
 * A tuft of tapered, arcing blades: each blade is `segs` segments, and its
 * vertex colour carries the blade's yaw (r, 0..1 of a turn), outward lean
 * (g), height (b) and root offset (a). Normals are unused by blades (the
 * shader bends its own), but every grass mesh carries the same attributes.
 */
function tuftGeometry(blades: Blade[], segs: number): VertexData {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (const bl of blades) {
    const o = positions.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      // widest a third of the way up, then a long taper to a sharp tip
      const w = 0.5 * Math.sin(Math.min(1, t * 1.5 + 0.35) * Math.PI * 0.5) * (1 - Math.pow(t, 1.8));
      const curve = t * t * 0.28;
      if (i < segs) {
        positions.push(-w, t, curve, w, t, curve);
        normals.push(0, 1, 0, 0, 1, 0);
        uvs.push(0, t, 1, t);
        colors.push(bl.yaw, bl.lean, bl.h, bl.off, bl.yaw, bl.lean, bl.h, bl.off);
      } else {
        positions.push(0, t, curve);
        normals.push(0, 1, 0);
        uvs.push(0.5, 1);
        colors.push(bl.yaw, bl.lean, bl.h, bl.off);
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
  vd.normals = normals;
  vd.uvs = uvs;
  vd.colors = colors;
  vd.indices = indices;
  return vd;
}

/** Close up: a clump of five fine blades of mixed heights. */
const NEAR_TUFT: Blade[] = [
  { yaw: 0.0, lean: 0.12, h: 1.0, off: 0.15 },
  { yaw: 0.21, lean: 0.32, h: 0.8, off: 0.85 },
  { yaw: 0.42, lean: 0.22, h: 0.92, off: 0.55 },
  { yaw: 0.63, lean: 0.4, h: 0.66, off: 1.0 },
  { yaw: 0.82, lean: 0.27, h: 0.76, off: 0.7 },
];
/** Middle distance: four blades. */
const MID_TUFT: Blade[] = [
  { yaw: 0.0, lean: 0.12, h: 1.0, off: 0.2 },
  { yaw: 0.27, lean: 0.3, h: 0.78, off: 0.9 },
  { yaw: 0.53, lean: 0.24, h: 0.88, off: 0.6 },
  { yaw: 0.78, lean: 0.36, h: 0.68, off: 1.0 },
];
/** Out to the horizon: single blades. */
const FAR_TUFT: Blade[] = [{ yaw: 0, lean: 0.08, h: 1, off: 0 }];

type N3 = [number, number, number];
const UP: N3 = [0, 1, 0];
const half = (n: N3): N3 => [n[0] * 0.5, n[1] * 0.5, n[2] * 0.5];
const norm = (x: number, y: number, z: number): N3 => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};

/**
 * Flower plants, built in metres. Vertex layout the grass shader reads:
 * uv.x = the height a part hangs from (a stem or leaf vertex: its own height;
 * a head: the head's centre), uv.y = height for the wind; colour r = extra
 * head tag (0 always shown, 0.5 often, 1 sometimes), g = petal base→tip,
 * b = 1 where the head may nod, a = part (0 stem/leaf, 0.35 heart, 1 petal).
 * Normals light the petals; a hollow (a bell) has half-length normals pointing
 * out of it, and is shaded darker where you see into it.
 */
class FlowerMesh {
  positions: number[] = [];
  normals: number[] = [];
  uvs: number[] = [];
  colors: number[] = [];
  indices: number[] = [];
  /** Extra-head tag for the parts added next. */
  tag = 0;
  private seed = 7;

  rnd() {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  v(x: number, y: number, z: number, anchor: number, g: number, a: number, n: N3 = UP, nod = 1) {
    this.positions.push(x, y, z);
    this.normals.push(n[0], n[1], n[2]);
    this.uvs.push(anchor, Math.min(1, y / 0.4));
    this.colors.push(this.tag, g, nod, a);
    return this.positions.length / 3 - 1;
  }

  /** A green part vertex: it hangs from its own height. */
  g(x: number, y: number, z: number) {
    return this.v(x, y, z, y, 0, 0, UP, 0);
  }

  tri(a: number, b: number, c: number) {
    this.indices.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number) {
    this.indices.push(a, b, c, a, c, d);
  }

  /** A tapering ribbon stem through a few points. */
  stem(pts: N3[], w: number) {
    let prev: number[] | null = null;
    pts.forEach(([x, y, z], i) => {
      const ww = w * (1 - 0.45 * (i / (pts.length - 1)));
      const cur = [this.g(x - ww, y, z), this.g(x + ww, y, z)];
      if (prev) this.quad(prev[0], prev[1], cur[1], cur[0]);
      prev = cur;
    });
  }

  /** A pointed leaf from (x, y, z) reaching len along yaw, rising then drooping. */
  leaf(x: number, y: number, z: number, len: number, yaw: number, wid = 0.3, rise = 0.5) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const at = (t: number, side: number, up: number) => this.g(x + c * len * t - s * side, y + up, z + s * len * t + c * side);
    const w = len * wid;
    const b = at(0, 0, 0);
    const l = at(0.45, w, len * rise * 0.5);
    const r = at(0.45, -w, len * rise * 0.5);
    const t = at(1, 0, len * rise * 0.15);
    this.quad(b, l, t, r);
  }

  /** A raised dome of heart colour. */
  heart(cx: number, cy: number, cz: number, r: number, h: number, n = 5) {
    const ring: number[] = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      ring.push(this.v(cx + Math.cos(a) * r, cy + h * 0.4, cz + Math.sin(a) * r, cy, 0, 0.35, norm(Math.cos(a), 0.7, Math.sin(a))));
    }
    const top = this.v(cx, cy + h, cz, cy, 0, 0.35);
    for (let k = 0; k < n; k++) this.tri(top, ring[k], ring[(k + 1) % n]);
  }

  /** A flat daisy head: a ring of slim, round-tipped petals round a raised heart. */
  daisy(cx: number, cy: number, cz: number, r: number, n: number) {
    const step = (Math.PI * 2) / n;
    for (let k = 0; k < n; k++) {
      const a = k * step + this.rnd() * 0.18;
      const rr = r * (0.88 + this.rnd() * 0.2);
      const droop = (this.rnd() - 0.35) * rr * 0.35;
      const hw = step * 0.5;
      const ca = Math.cos(a), sa = Math.sin(a);
      // petals tip down (or up) a little, so they catch the light differently
      const nn = norm(ca * -droop / rr, 1, sa * -droop / rr);
      const p = (ang: number, rad: number, y: number, g: number) => this.v(cx + Math.cos(ang) * rad, cy + y, cz + Math.sin(ang) * rad, cy, g, 1, nn);
      this.quad(p(a, r * 0.16, 0.003, 0), p(a - hw, rr * 0.6, droop * 0.45 + 0.004, 0.55), p(a, rr, droop, 1), p(a + hw * 1.0, rr * 0.6, droop * 0.45 + 0.004, 0.55));
    }
    this.heart(cx, cy, cz, r * 0.27, r * 0.34, 6);
  }

  /**
   * A cupped head of broad rounded petals (buttercup, poppy): a bowl that
   * curves up from the heart to a rim of n round petal lobes.
   */
  cup(cx: number, cy: number, cz: number, r: number, n: number, depth: number) {
    const centre = this.v(cx, cy, cz, cy, 0, 1);
    const m = n * 3;
    const ring = (rf: number, hf: number, lobe: number, g: number) => {
      const ids: number[] = [];
      for (let k = 0; k < m; k++) {
        const a = (k / m) * Math.PI * 2 + (k % 3 === 1 ? 0 : (k % 3 === 0 ? 0.08 : -0.08));
        // each petal is fullest in its middle, with a notch where two meet
        const lb = k % 3 === 1 ? 1 : lobe;
        const rad = r * rf * lb;
        const y = r * depth * hf * (k % 3 === 1 ? 1 : 0.92);
        // the inside of the cup faces up and in, steeper toward the rim
        const nn = norm(-Math.cos(a) * depth * (0.4 + hf), 1, -Math.sin(a) * depth * (0.4 + hf));
        ids.push(this.v(cx + Math.cos(a) * rad, cy + y, cz + Math.sin(a) * rad, cy, g, 1, nn));
      }
      return ids;
    };
    const mid = ring(0.55, 0.35, 0.96, 0.45);
    const rim = ring(1, 1, 0.84, 1);
    for (let k = 0; k < m; k++) {
      const k1 = (k + 1) % m;
      this.tri(centre, mid[k1], mid[k]);
      this.quad(mid[k], mid[k1], rim[k1], rim[k]);
    }
    this.heart(cx, cy + 0.004, cz, r * 0.24, r * 0.24, 5);
  }

  /** A five-lobed bell opening along (dx, dy, dz), its rim flaring back. */
  bell(cx: number, cy: number, cz: number, d: N3, len: number, r: number) {
    const ax = norm(d[0], d[1], d[2]);
    // two directions across the bell's axis
    let u: N3 = Math.abs(ax[1]) < 0.9 ? [ax[2], 0, -ax[0]] : [1, 0, 0];
    u = norm(u[0], u[1], u[2]);
    const w: N3 = [ax[1] * u[2] - ax[2] * u[1], ax[2] * u[0] - ax[0] * u[2], ax[0] * u[1] - ax[1] * u[0]];
    const n = 10;
    const rings: number[][] = [];
    // [along, radius, how far the surface turns back toward the stem]
    const prof: N3[] = [[0.08, 0.42, 0.5], [0.6, 0.8, 0.3], [1, 1, 0.9]];
    for (const [t, rf, tilt] of prof) {
      const ring: number[] = [];
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        // five pointed lobes, curling out and back at the rim
        const lobe = t === 1 ? (k % 2 === 0 ? 1.28 : 0.86) : 1;
        const back = t === 1 && k % 2 === 0 ? -len * 0.12 : 0;
        const rad = r * rf * lobe;
        const ca = Math.cos(a), sa = Math.sin(a);
        const along = len * t + back;
        const rd: N3 = [u[0] * ca + w[0] * sa, u[1] * ca + w[1] * sa, u[2] * ca + w[2] * sa];
        const nn = half(norm(rd[0] - ax[0] * tilt, rd[1] - ax[1] * tilt, rd[2] - ax[2] * tilt));
        ring.push(this.v(cx + ax[0] * along + rd[0] * rad, cy + ax[1] * along + rd[1] * rad, cz + ax[2] * along + rd[2] * rad, cy, t, 1, nn));
      }
      rings.push(ring);
    }
    const base = this.v(cx, cy, cz, cy, 0, 1, half([-ax[0], -ax[1], -ax[2]]));
    for (let k = 0; k < n; k++) this.tri(base, rings[0][k], rings[0][(k + 1) % n]);
    for (let j = 0; j < rings.length - 1; j++) {
      for (let k = 0; k < n; k++) this.quad(rings[j][k], rings[j][(k + 1) % n], rings[j + 1][(k + 1) % n], rings[j + 1][k]);
    }
  }

  /**
   * A tapering spike of small florets wound round the stem (lupin). Each
   * floret is folded along its keel, so its two halves catch the light
   * differently and the spike reads as a dense, textured cone.
   */
  spike(x: number, z: number, y0: number, y1: number, r: number, size: number, n: number) {
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const y = y0 + (y1 - y0) * t;
      const a = i * 2.39996;
      const rad = r * (1 - 0.6 * t);
      const sz = size * (1 - 0.45 * t);
      const ca = Math.cos(a), sa = Math.sin(a);
      const p = (along: number, side: number, up: number, g: number, nn: N3) => this.v(x + ca * along - sa * side, y + up, z + sa * along + ca * side, y, g, 1, nn, 0);
      const out = (sd: number, upn: number) => norm(ca - sa * sd, upn, sa + ca * sd);
      const g0 = t * 0.35;
      const base = p(rad * 0.6, 0, -sz * 0.45, g0, out(0, -0.3));
      const left = p(rad + sz * 0.2, sz * 0.62, sz * 0.05, 0.5 + t * 0.4, out(0.8, 0.3));
      const keel = p(rad + sz * 0.55, 0, sz * 0.1, 0.6 + t * 0.35, out(0, 0.2));
      const tip = p(rad + sz * 0.25, 0, sz * 0.75, 0.75 + t * 0.25, out(0, 0.9));
      const right = p(rad + sz * 0.2, -sz * 0.62, sz * 0.05, 0.5 + t * 0.4, out(-0.8, 0.3));
      this.tri(base, left, keel);
      this.tri(keel, left, tip);
      this.tri(keel, tip, right);
      this.tri(base, keel, right);
    }
    // a closed bud on top
    const tip = this.v(x, y1 + size * 1.3, z, y1, 1, 1, UP, 0);
    const ring = [0, 1, 2].map((k) => this.v(x + Math.cos(k * 2.1) * size * 0.4, y1, z + Math.sin(k * 2.1) * size * 0.4, y1, 0.7, 1, norm(Math.cos(k * 2.1), 0.3, Math.sin(k * 2.1)), 0));
    for (let k = 0; k < 3; k++) this.tri(tip, ring[k], ring[(k + 1) % 3]);
  }

  /** A round pom of tiny florets (clover). */
  pom(cx: number, cy: number, cz: number, r: number) {
    const ring = (y: number, rad: number, off: number, g: number) =>
      [0, 1, 2, 3, 4, 5].map((k) => {
        const a = k * 1.0472 + off;
        return this.v(cx + Math.cos(a) * rad, cy + y, cz + Math.sin(a) * rad, cy, g, 1, norm(Math.cos(a) * rad, y, Math.sin(a) * rad));
      });
    const top = this.v(cx, cy + r * 1.05, cz, cy, 1, 1);
    const up = ring(r * 0.55, r * 0.88, 0, 0.75);
    const lo = ring(-r * 0.2, r * 0.95, 0.52, 0.4);
    const bot = this.v(cx, cy - r * 0.7, cz, cy, 0, 1, [0, -1, 0]);
    for (let k = 0; k < 6; k++) {
      const k1 = (k + 1) % 6;
      this.tri(top, up[k], up[k1]);
      this.quad(up[k], lo[k], lo[k1], up[k1]);
      this.tri(bot, lo[k1], lo[k]);
    }
  }

  /** Three round leaflets (clover). */
  trefoil(x: number, y: number, z: number, r: number, yaw: number) {
    for (let k = 0; k < 3; k++) this.leaf(x, y, z, r, yaw + k * 2.094, 0.55, 0.15);
  }

  build(): VertexData {
    const vd = new VertexData();
    vd.positions = this.positions;
    vd.normals = this.normals;
    vd.uvs = this.uvs;
    vd.colors = this.colors;
    vd.indices = this.indices;
    return vd;
  }
}

/**
 * Flower species, matching COLOURWAYS (1-based in the shader). `h` scales
 * stem heights (so blooms clear the grass), `size` the whole plant's width
 * and heads; `density` is plants per m² at the heart of a drift, per unit of
 * the quality preset's grass density.
 */
const FLOWERS: { name: string; density: number; h: number; size: number; build: (m: FlowerMesh) => void }[] = [
  {
    name: 'daisy',
    h: 1.55,
    size: 1.3,
    density: 0.14,
    build: (m) => {
      m.stem([[0, 0, 0], [0.01, 0.17, 0.005], [0.02, 0.32, 0.01]], 0.005);
      m.leaf(0, 0.02, 0, 0.09, 0.4, 0.25, 0.5);
      m.daisy(0.02, 0.32, 0.01, 0.042, 13);
      m.tag = 0.5;
      m.stem([[0.006, 0.1, 0.003], [0.05, 0.19, 0.03], [0.065, 0.25, 0.04]], 0.004);
      m.daisy(0.065, 0.25, 0.04, 0.034, 11);
    },
  },
  {
    name: 'cup',
    h: 1.55,
    size: 1.3,
    density: 0.1,
    build: (m) => {
      m.stem([[0, 0, 0], [-0.008, 0.15, 0], [0.004, 0.29, 0.006]], 0.005);
      m.leaf(0, 0.03, 0, 0.08, 1.2, 0.4, 0.4);
      m.cup(0.004, 0.29, 0.006, 0.042, 5, 0.75);
      m.tag = 0.5;
      m.stem([[-0.006, 0.12, 0], [0.04, 0.18, -0.025], [0.06, 0.22, -0.035]], 0.004);
      m.cup(0.06, 0.22, -0.035, 0.034, 5, 0.85);
    },
  },
  {
    name: 'bell',
    h: 1.5,
    size: 1.3,
    density: 0.08,
    build: (m) => {
      // an arching stem with bells hanging along its top
      m.stem([[0, 0, 0], [0.01, 0.18, 0], [0.035, 0.31, 0], [0.07, 0.35, 0], [0.1, 0.335, 0]], 0.0045);
      m.leaf(0, 0.03, 0, 0.08, 0.9, 0.22, 0.6);
      m.bell(0.1, 0.335, 0, [0.3, -1, 0.05], 0.042, 0.02);
      m.tag = 0.5;
      m.stem([[0.062, 0.348, 0], [0.064, 0.34, 0.018]], 0.003);
      m.bell(0.064, 0.34, 0.018, [0.1, -1, 0.55], 0.038, 0.018);
      m.tag = 1;
      m.stem([[0.03, 0.305, 0], [0.03, 0.295, -0.018]], 0.003);
      m.bell(0.03, 0.295, -0.018, [-0.2, -1, -0.55], 0.034, 0.016);
    },
  },
  {
    name: 'spike',
    h: 1.35,
    size: 1.25,
    density: 0.045,
    build: (m) => {
      m.stem([[0, 0, 0], [0.004, 0.28, 0], [0, 0.56, 0]], 0.0065);
      for (let k = 0; k < 3; k++) m.leaf(0, 0.03, 0, 0.1, k * 2.094 + 0.3, 0.16, 0.45);
      m.spike(0, 0, 0.27, 0.55, 0.018, 0.026, 22);
      m.tag = 0.5;
      m.stem([[0.004, 0.05, 0], [0.045, 0.24, 0.02], [0.055, 0.43, 0.02]], 0.005);
      m.spike(0.055, 0.02, 0.26, 0.42, 0.016, 0.022, 13);
    },
  },
  {
    name: 'clover',
    h: 1.3,
    size: 1.3,
    density: 0.08,
    build: (m) => {
      m.stem([[0, 0, 0], [0.005, 0.08, 0], [0.01, 0.16, 0.004]], 0.0035);
      m.trefoil(0, 0.04, 0, 0.04, 0.3);
      m.pom(0.01, 0.17, 0.004, 0.024);
      m.tag = 0.5;
      m.stem([[0, 0, 0], [0.04, 0.07, 0.02], [0.06, 0.13, 0.03]], 0.0035);
      m.pom(0.06, 0.14, 0.03, 0.021);
    },
  },
];

/** Drift map resolution (texels across the world). */
const BLOOM_RES = 512;

/**
 * Where each flower species grows: two-octave value noise per species,
 * remapped so drifts begin (0.5) in about 45% of the meadow and reach their
 * dense hearts (0.68) in about 15%. Baked once into two small textures the
 * flowers and the far grass both read, so the colour washes in the distance
 * sit exactly where the flowers are.
 */
function bakeDrifts(): [Uint8Array, Uint8Array] {
  const N = BLOOM_RES;
  const hash = (x: number, y: number, s: number) => {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const vnoise = (x: number, y: number, s: number) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    let fx = x - ix, fy = y - iy;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy, s), b = hash(ix + 1, iy, s), c = hash(ix, iy + 1, s), d = hash(ix + 1, iy + 1, s);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  const A = new Uint8Array(N * N * 4);
  const B = new Uint8Array(N * N * 4);
  const vals = new Float32Array(N * N);
  const texel = (WORLD_HALF * 2) / N;
  for (let sp = 0; sp < 5; sp++) {
    for (let j = 0, k = 0; j < N; j++) {
      const z = -WORLD_HALF + (j + 0.5) * texel;
      for (let i = 0; i < N; i++, k++) {
        const x = -WORLD_HALF + (i + 0.5) * texel;
        vals[k] = vnoise(x * 0.045 + sp * 37.1, z * 0.045 - sp * 23.7, sp * 2 + 1) * 0.7 + vnoise(x * 0.13 + sp * 11.3, z * 0.13 + sp * 5.9, sp * 2 + 2) * 0.3;
      }
    }
    const sorted = Float32Array.from(vals).sort();
    const q = (p: number) => sorted[Math.floor(p * (sorted.length - 1))];
    const lo = q(0.55), hi = q(0.85);
    const scale = 0.18 / Math.max(hi - lo, 1e-4);
    const out = sp < 4 ? A : B;
    const ch = sp < 4 ? sp : 0;
    for (let k = 0; k < N * N; k++) out[k * 4 + ch] = Math.max(0, Math.min(255, Math.round((0.5 + (vals[k] - lo) * scale) * 255)));
  }
  return [A, B];
}

interface Field {
  mesh: Mesh;
  mat: ShaderMaterial;
  shape: [number, number, number];
  fv: Vector4;
  /** Own vectors per field: ShaderMaterial keeps a reference, not a copy. */
  sv: Vector4;
  lv: Vector4;
  /** How far ahead of the camera the lattice window's centre sits. */
  lead: number;
}

/** Lattice window side as a multiple of a field's radius (2 = a full circle round the camera). */
const WINDOW = 1.7;

export class Grass {
  private fields: Field[] = [];
  private pushers = new Float32Array(16);
  readonly wind = new Vector4(0.8, 0.6, 0.55, 1);
  /** Pixels per metre at 1 m from the camera (render height / (2·tan(fov/2))), set each frame. */
  pxScale = 900;
  private sunCol = new Color3();
  private ambCol = new Color3();
  private dirV = new Vector3();
  private fwdV = new Vector3();
  private pushArr: number[] = [];
  private shadowV = new Vector4();
  private bloomA: RawTexture;
  private bloomB: RawTexture;
  private flowerR = 24;

  constructor(private scene: Scene, private heightTex: Texture, private splatTex: Texture, private detailTex: Texture, private atmosphere: Atmosphere) {
    const [a, b] = bakeDrifts();
    const mk = (d: Uint8Array) => {
      const t = RawTexture.CreateRGBATexture(d, BLOOM_RES, BLOOM_RES, scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
      t.wrapU = t.wrapV = Texture.CLAMP_ADDRESSMODE;
      return t;
    };
    this.bloomA = mk(a);
    this.bloomB = mk(b);
  }

  applyQuality(q: QualitySettings) {
    for (const f of this.fields) {
      f.mesh.dispose();
      f.mat.dispose();
    }
    this.fields = [];
    const R = q.grassRadius;
    const D = q.grassDensity;
    // lighter presets draw fewer, slightly broader blades so meadows stay full
    const coarse = Math.min(2, Math.max(1, Math.sqrt(34 / D)));
    const nearR = Math.min(14, Math.max(6, R * 0.15));
    const midR = R * 0.42;
    this.flowerR = Math.min(26, Math.max(14, R * 0.28));
    // near: a carpet of fine five-blade clumps (~5·D blades per m²)
    this.addField('grassNear', tuftGeometry(NEAR_TUFT, 4), nearR, 0, D, { h: 0.48, w: 0.04 * coarse, flower: 0 });
    // middle distance: four-blade tufts; far: single blades to the horizon
    // (lighter presets keep these a little denser: they cover most of the view)
    this.addField('grassMid', tuftGeometry(MID_TUFT, 3), midR, nearR, D * 0.33 * coarse, { h: 0.52, w: 0.065 * coarse, flower: 0 });
    this.addField('grassFar', tuftGeometry(FAR_TUFT, 2), R, midR, D * 0.24 * coarse, { h: 0.6, w: 0.11 * coarse, flower: 0 });
    // one field per flower species (each its own shape and drifts)
    FLOWERS.forEach((f, i) => {
      const m = new FlowerMesh();
      f.build(m);
      this.addField('flowers_' + f.name, m.build(), this.flowerR, 0, D * f.density, { h: f.h, w: f.size, flower: i + 1 });
    });
  }

  private addField(name: string, geo: VertexData, radius: number, innerCut: number, density: number, shape: { h: number; w: number; flower: number }) {
    const period = radius * WINDOW;
    // jittered lattice
    const cell = 1 / Math.sqrt(density);
    const n = Math.max(1, Math.floor(period / cell));
    const count = n * n;
    const inst = new Float32Array(count * 4);
    let seed = 12345 + Math.round(radius * 31) + shape.flower * 7919;
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
      attributes: ['position', 'normal', 'uv', 'color', 'grassInst'],
      uniforms: ['viewProjection', 'field', 'shape', 'look', 'camPos', 'pxScale', 'wind', 'pushers', 'sunDir', 'sunColor', 'ambientColor', ...TOON_FOG_UNIFORMS, 'tipColor', 'dryColor', 'grassA', 'grassB', 'grassDry', 'forestCol', 'lightMatrix', 'shadowInfo', 'toonGI', 'toonGIShadow'],
      samplers: ['heightTex', 'splatTex', 'detailTex', 'bloomA', 'bloomB', 'shadowTex', 'kLightMap', 'kBounceMap'],
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
    mat.setTexture('bloomA', this.bloomA);
    mat.setTexture('bloomB', this.bloomB);
    if (worldLight.map) mat.setTexture('kLightMap', worldLight.map);
    if (worldLight.bounce) mat.setTexture('kBounceMap', worldLight.bounce);
    mat.setColor3('tipColor', Color3.FromHexString('#c4e46a').toLinearSpace());
    mat.setColor3('dryColor', Color3.FromHexString('#e2d77a').toLinearSpace());
    for (const k of ['grassA', 'grassB', 'grassDry', 'forestCol'] as const) mat.setColor3(k, Color3.FromArray(GROUND[k]));
    mesh.material = mat;
    const fv = new Vector4(period, radius, innerCut, 1);
    // lead the camera just far enough that the window still reaches `radius` straight ahead
    const lead = radius - period / 2;
    this.fields.push({ mesh, mat, shape: [shape.h, shape.w, shape.flower], fv, sv: new Vector4(), lv: new Vector4(), lead });
  }

  /** Vertices the grass and flower lattices submit per frame (most collapse at once). */
  get latticeVertices() {
    return this.fields.reduce((n, f) => n + f.mesh.getTotalVertices() * f.mesh.forcedInstanceCount, 0);
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
    // the camera's heading on the ground; looking straight down there is none,
    // and the window simply centres on the camera
    const fwd = this.fwdV.set(0, 0, 0);
    this.scene.activeCamera?.getDirectionToRef(Axis.Z, fwd);
    const fl = Math.hypot(fwd.x, fwd.z);
    const hx = fl > 1e-4 ? fwd.x / fl : 0;
    const hz = fl > 1e-4 ? fwd.z / fl : 0;
    const leadK = Math.min(1, Math.max(0, (fl - 0.1) / 0.2));
    this.pushArr.length = 0;
    for (let i = 0; i < 16; i++) this.pushArr.push(this.pushers[i]);
    this.fields.forEach((f) => {
      const m = f.mat;
      m.setVector4('field', f.fv);
      m.setVector4('shape', f.sv.set(f.shape[0], f.shape[1], f.shape[2], time));
      m.setVector4('look', f.lv.set(hx, hz, f.lead * leadK, this.flowerR));
      m.setVector3('camPos', cameraPos);
      m.setFloat('pxScale', this.pxScale);
      m.setVector4('wind', this.wind);
      m.setArray4('pushers', this.pushArr);
      m.setVector3('sunDir', dir);
      m.setColor3('sunColor', sun);
      m.setColor3('ambientColor', amb);
      bindToonFog(m);
      m.setVector4('toonGI', worldLight.strength);
      m.setVector4('toonGIShadow', worldLight.shadow);
      if (sg) {
        m.setMatrix('lightMatrix', sg.getTransformMatrix());
        m.setVector4('shadowInfo', this.shadowV.set(toon.sunDir.w, sg.frustumEdgeFalloff, 0, 0));
      }
    });
  }
}
