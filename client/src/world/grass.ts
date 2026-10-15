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
import { WORLD_LIGHT_GLSL, worldLight } from './worldLight';

Effect.ShadersStore['keliaGrassVertexShader'] = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
attribute vec4 color;
attribute vec4 grassInst;
uniform mat4 viewProjection;
uniform vec4 field;   // x = period, y = fade radius, z = inner cut radius, w = density scale
uniform vec4 shape;   // x = height, y = width, z = flower species (0 = grass), w = time
uniform vec3 camPos;
uniform float pxScale; // pixels per metre at 1 m from the camera
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
varying float vDetail;
varying float vHue;
varying float vFace;
varying vec3 vBladeN;
varying vec3 vGI;
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
  // flowers grow in drifts: each species has its own patches (one colourway
  // per patch), open meadow between and the odd stray bloom anywhere
  float so = shape.z * 17.3;
  float drift = vnoise1(wp * 0.045 + 31.0 + so) * 0.7 + vnoise1(wp * 0.13 + so * 0.37) * 0.3;
  vBloom = drift;
  if (shape.z > 0.5) dens *= (1.0 - sp.r) * (smoothstep(0.5, 0.68, drift) * 2.2 + 0.06);
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
  // How many pixels wide a blade (or a flower head) is on screen. Anything
  // thinner than a few pixels can't be drawn steadily: as it sways it lands
  // on a pixel one frame and misses it the next, so its sparkle (white
  // petals, sun glints, glowing tips) has to fade out before it gets there.
  // (shape.y is a flower's size, about 7× its head; or a blade's width)
  float px = shape.y * s * pxScale / max(dist, 0.3);
  vDetail = shape.z > 0.5 ? smoothstep(40.0, 100.0, px) : smoothstep(2.0, 8.0, px);
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
    // A flower plant: its own stem height, head size and nod, and one, two
    // or three heads (extra heads are tagged 0.5 / 1 in colour r). uv.x is the
    // height a part hangs from: stems stretch, heads scale and tip about it.
    float roll = fract(grassInst.z * 91.7 + grassInst.w * 13.3);
    float show = color.r < 0.25 ? 1.0 : color.r < 0.75 ? step(0.4, roll) : step(0.72, roll);
    float stemK = mix(0.7, 1.35, fract(grassInst.w * 5.3)) * mix(0.85, 1.2, vnoise1(wp * 0.21 + 11.0));
    float headK = mix(0.75, 1.3, fract(grassInst.z * 17.9));
    float isHead = step(0.1, color.a);
    vec3 off = position - vec3(0.0, uv.x, 0.0);
    float nod = (fract(grassInst.w * 29.1) - 0.5) * 0.8 * color.b;
    float cn = cos(nod); float sn = sin(nod);
    off.xy = vec2(off.x * cn - off.y * sn, off.x * sn + off.y * cn);
    off *= mix(1.0, headK, isHead);
    vec3 g = (vec3(0.0, uv.x * stemK, 0.0) + off) * show;
    float ca = cos(ang); float sa = sin(ang);
    lp = vec3(g.x * shape.y, g.y * shape.x, g.z * shape.y);
    lp = vec3(lp.x * ca - lp.z * sa, lp.y, lp.x * sa + lp.z * ca);
    bladeH = 0.38 * shape.x / 1.6;
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

// Petal base, petal tip and heart colours of each species, in a few colourways.
void flowerColors(float sp, float k, out vec3 base, out vec3 tip, out vec3 heart) {
  if (sp < 1.5) {          // daisies, pink daisies, asters
    heart = vec3(1.0, 0.76, 0.14);
    if (k < 0.55) { base = vec3(0.96, 0.93, 0.84); tip = vec3(1.0); }
    else if (k < 0.8) { base = vec3(0.98, 0.56, 0.74); tip = vec3(1.0, 0.86, 0.92); }
    else { base = vec3(0.58, 0.46, 0.98); tip = vec3(0.8, 0.74, 1.0); }
  } else if (sp < 2.5) {   // buttercups, red and orange poppies
    if (k < 0.45) { base = vec3(1.0, 0.7, 0.06); tip = vec3(1.0, 0.92, 0.3); heart = vec3(0.86, 0.72, 0.2); }
    else if (k < 0.78) { base = vec3(0.82, 0.08, 0.07); tip = vec3(1.0, 0.32, 0.22); heart = vec3(0.12, 0.08, 0.12); }
    else { base = vec3(1.0, 0.42, 0.06); tip = vec3(1.0, 0.68, 0.26); heart = vec3(0.3, 0.18, 0.08); }
  } else if (sp < 3.5) {   // bellflowers
    if (k < 0.5) { base = vec3(0.26, 0.32, 0.92); tip = vec3(0.56, 0.68, 1.0); }
    else if (k < 0.8) { base = vec3(0.52, 0.28, 0.88); tip = vec3(0.8, 0.62, 1.0); }
    else { base = vec3(0.86, 0.84, 1.0); tip = vec3(1.0); }
    heart = tip;
  } else if (sp < 4.5) {   // lupins
    if (k < 0.4) { base = vec3(0.36, 0.22, 0.82); tip = vec3(0.72, 0.58, 1.0); }
    else if (k < 0.7) { base = vec3(0.88, 0.3, 0.58); tip = vec3(1.0, 0.72, 0.86); }
    else if (k < 0.92) { base = vec3(0.92, 0.9, 0.84); tip = vec3(1.0); }
    else { base = vec3(0.98, 0.66, 0.16); tip = vec3(1.0, 0.9, 0.46); }
    heart = tip;
  } else {                 // clover
    if (k < 0.62) { base = vec3(0.74, 0.26, 0.56); tip = vec3(1.0, 0.62, 0.84); }
    else { base = vec3(0.9, 0.88, 0.8); tip = vec3(1.0); }
    heart = base;
  }
}

void main(void) {
  float h = vUv.y;
  vec3 col;
  float sideLit = 1.0;
  float glint = 0.0;
  vec3 V = normalize(camPos - vPos);
  float near = 1.0 - vFar;
  if (shape.z > 0.5) {
    // flowers: vertex colour alpha marks petals (1) and the heart (0.35),
    // green runs from each petal's base to its tip
    vec3 pb; vec3 pt; vec3 heart;
    flowerColors(shape.z, fract(vBloom * 2.7 + vRand * 0.22), pb, pt, heart);
    vec3 petal = mix(pb, pt, vColor.g) * (0.9 + 0.2 * fract(vRand * 31.7));
    vec3 stem = vRoot * 0.85;
    // small flowers become soft dabs of colour, not bright pixel sparkles
    float dab = max(vFar, 1.0 - vDetail);
    petal = mix(petal, mix(stem, petal, 0.45), dab);
    heart = mix(heart, mix(stem, petal, 0.45), dab);
    // pure white petals would sit far above everything else in the meadow
    col = vColor.a > 0.9 ? petal * petal * 0.82 : vColor.a > 0.2 ? heart * heart : stem;
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
    glint = pow(clamp(dot(N, Hh), 0.0, 1.0), 28.0) * smoothstep(0.35, 0.9, h) * near * vDetail * vDetail;
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
  float trans = (pow(back, 3.0) * 0.95 + pow(back, 12.0) * 0.6) * h * (1.0 - 0.7 * vFar) * mix(0.35, 1.0, vDetail);
  float ao = mix(mix(0.72, 1.0, h), 0.95, vFar * 0.6);
  float sh = 1.0;
#ifdef GSHADOW
  sh = grassShadow();
#endif
  sh *= vGI.y;
  float sun = litK * sh * (1.0 - vSplat.r * 0.25);
  vec3 sky = ambientColor * vGI.x * mix(vec3(1.0), vec3(0.82, 1.04, 0.78), vGI.z);
  vec3 lit3 = col * (sunColor * litK * sideLit * sh * (1.0 - vSplat.r * 0.25) + sky) * ao;
  // backlit blades glow a warm, translucent yellow-green
  lit3 += col * vec3(1.15, 1.2, 0.6) * sunColor * trans * sun;
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

/**
 * Flower plants, built in metres. Vertex layout the grass shader reads:
 * uv.x = the height a part hangs from (a stem or leaf vertex: its own height;
 * a head: the head's centre), uv.y = height for the wind; colour r = extra
 * head tag (0 always shown, 0.5 often, 1 sometimes), g = petal base→tip,
 * b = 1 where the head may nod, a = part (0 stem/leaf, 0.35 heart, 1 petal).
 */
class FlowerMesh {
  positions: number[] = [];
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

  v(x: number, y: number, z: number, anchor: number, g: number, a: number, nod = 1) {
    this.positions.push(x, y, z);
    this.uvs.push(anchor, Math.min(1, y / 0.4));
    this.colors.push(this.tag, g, nod, a);
    return this.positions.length / 3 - 1;
  }

  /** A green part vertex: it hangs from its own height. */
  g(x: number, y: number, z: number) {
    return this.v(x, y, z, y, 0, 0, 0);
  }

  tri(a: number, b: number, c: number) {
    this.indices.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number) {
    this.indices.push(a, b, c, a, c, d);
  }

  /** A tapering ribbon stem through a few points. */
  stem(pts: [number, number, number][], w: number) {
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
  heart(cx: number, cy: number, cz: number, r: number, h: number, n = 6) {
    const ring: number[] = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      ring.push(this.v(cx + Math.cos(a) * r, cy + h * 0.4, cz + Math.sin(a) * r, cy, 0, 0.35));
    }
    const top = this.v(cx, cy + h, cz, cy, 0, 0.35);
    for (let k = 0; k < n; k++) this.tri(top, ring[k], ring[(k + 1) % n]);
  }

  /** A flat daisy head: many thin petals round a raised heart. */
  daisy(cx: number, cy: number, cz: number, r: number, n: number) {
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + this.rnd() * 0.2;
      const rr = r * (0.85 + this.rnd() * 0.25);
      const droop = (this.rnd() - 0.4) * rr * 0.3;
      const hw = Math.PI / n * 0.62;
      const p = (ang: number, rad: number, y: number, g: number) => this.v(cx + Math.cos(ang) * rad, cy + y, cz + Math.sin(ang) * rad, cy, g, 1);
      this.quad(p(a, r * 0.15, 0.004, 0), p(a - hw, rr * 0.62, droop * 0.5 + 0.01, 0.6), p(a, rr, droop, 1), p(a + hw, rr * 0.62, droop * 0.5 + 0.01, 0.6));
    }
    this.heart(cx, cy, cz, r * 0.26, r * 0.32, 5);
  }

  /** A cupped head of broad rounded petals (buttercup, poppy). */
  cup(cx: number, cy: number, cz: number, r: number, n: number, depth: number) {
    const centre = this.v(cx, cy, cz, cy, 0, 1);
    const fan = [-0.5, -0.25, 0, 0.25, 0.5];
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2 + this.rnd() * 0.3;
      const ids = fan.map((o) => {
        const a = a0 + o * (Math.PI * 2 / n) * 1.15;
        const rad = r * Math.cos(o * 1.5) * (0.9 + this.rnd() * 0.15);
        return this.v(cx + Math.cos(a) * rad, cy + rad * depth, cz + Math.sin(a) * rad, cy, Math.min(1, rad / r), 1);
      });
      for (let i = 0; i < ids.length - 1; i++) this.tri(centre, ids[i], ids[i + 1]);
    }
    this.heart(cx, cy + 0.006, cz, r * 0.24, r * 0.22, 5);
  }

  /** A scalloped bell opening along (dx, dy, dz). */
  bell(cx: number, cy: number, cz: number, d: [number, number, number], len: number, r: number) {
    const [dx, dy, dz] = d;
    const dl = Math.hypot(dx, dy, dz);
    const ax = [dx / dl, dy / dl, dz / dl];
    // two directions across the bell's axis
    let u = Math.abs(ax[1]) < 0.9 ? [ax[2], 0, -ax[0]] : [1, 0, 0];
    const ul = Math.hypot(u[0], u[1], u[2]);
    u = [u[0] / ul, u[1] / ul, u[2] / ul];
    const w = [ax[1] * u[2] - ax[2] * u[1], ax[2] * u[0] - ax[0] * u[2], ax[0] * u[1] - ax[1] * u[0]];
    const n = 10;
    const rings: number[][] = [];
    const prof = [[0, 0.3], [0.55, 0.72], [1, 1]];
    for (const [t, rf] of prof) {
      const ring: number[] = [];
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        // five lobes, flaring out at the rim
        const lobe = t === 1 ? (k % 2 === 0 ? 1.12 : 0.84) : 1;
        const rad = r * rf * lobe;
        const ca = Math.cos(a) * rad, sa = Math.sin(a) * rad;
        const back = t === 1 && k % 2 === 0 ? -len * 0.08 : 0;
        ring.push(this.v(cx + ax[0] * (len * t + back) + u[0] * ca + w[0] * sa, cy + ax[1] * (len * t + back) + u[1] * ca + w[1] * sa, cz + ax[2] * (len * t + back) + u[2] * ca + w[2] * sa, cy, t, 1));
      }
      rings.push(ring);
    }
    const base = this.v(cx, cy, cz, cy, 0, 1);
    for (let k = 0; k < n; k++) this.tri(base, rings[0][k], rings[0][(k + 1) % n]);
    for (let j = 0; j < rings.length - 1; j++) {
      for (let k = 0; k < n; k++) this.quad(rings[j][k], rings[j][(k + 1) % n], rings[j + 1][(k + 1) % n], rings[j + 1][k]);
    }
  }

  /** A tapering spike of small florets wound round the stem (lupin). */
  spike(x: number, z: number, y0: number, y1: number, r: number, size: number, n: number) {
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const y = y0 + (y1 - y0) * t;
      const a = i * 2.39996;
      const rad = r * (1 - 0.6 * t);
      const sz = size * (1 - 0.5 * t);
      const ca = Math.cos(a), sa = Math.sin(a);
      const p = (along: number, side: number, up: number, g: number) => this.v(x + ca * along - sa * side, y + up, z + sa * along + ca * side, y, g, 1, 0);
      // each floret faces outward, a little cupped, so the spike reads from the side
      this.quad(p(rad, 0, -sz * 0.6, t * 0.4), p(rad + sz * 0.3, sz * 0.75, 0, 0.5 + t * 0.4), p(rad + sz * 0.15, 0, sz * 0.7, 0.7 + t * 0.3), p(rad + sz * 0.3, -sz * 0.75, 0, 0.5 + t * 0.4));
    }
    // a closed bud on top
    const tip = this.v(x, y1 + size * 1.3, z, y1, 1, 1, 0);
    const ring = [0, 1, 2].map((k) => this.v(x + Math.cos(k * 2.1) * size * 0.4, y1, z + Math.sin(k * 2.1) * size * 0.4, y1, 0.7, 1, 0));
    for (let k = 0; k < 3; k++) this.tri(tip, ring[k], ring[(k + 1) % 3]);
  }

  /** A round pom of tiny florets (clover). */
  pom(cx: number, cy: number, cz: number, r: number) {
    const ring = (y: number, rad: number, off: number, g: number) =>
      [0, 1, 2, 3, 4, 5].map((k) => this.v(cx + Math.cos(k * 1.0472 + off) * rad, cy + y, cz + Math.sin(k * 1.0472 + off) * rad, cy, g, 1));
    const top = this.v(cx, cy + r * 1.05, cz, cy, 1, 1);
    const up = ring(r * 0.55, r * 0.88, 0, 0.75);
    const lo = ring(-r * 0.2, r * 0.95, 0.52, 0.4);
    const bot = this.v(cx, cy - r * 0.7, cz, cy, 0, 1);
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
    vd.uvs = this.uvs;
    vd.colors = this.colors;
    vd.indices = this.indices;
    return vd;
  }
}

/** Flower species, matching flowerColors() in the shader (1-based). */
const FLOWERS: { name: string; density: number; size: number; build: (m: FlowerMesh) => void }[] = [
  {
    name: 'daisy',
    size: 1.5,
    density: 0.026,
    build: (m) => {
      m.stem([[0, 0, 0], [0.01, 0.18, 0.005], [0.025, 0.34, 0.01]], 0.007);
      m.leaf(0, 0.02, 0, 0.11, 0.4);
      m.leaf(0, 0.04, 0, 0.09, 3.3);
      m.daisy(0.025, 0.34, 0.01, 0.1, 12);
      m.tag = 0.5;
      m.stem([[0.008, 0.12, 0.003], [0.06, 0.2, 0.03], [0.08, 0.26, 0.04]], 0.005);
      m.daisy(0.08, 0.26, 0.04, 0.075, 9);
      m.tag = 1;
      m.stem([[0.004, 0.08, 0.002], [-0.05, 0.16, -0.03], [-0.065, 0.21, -0.045]], 0.005);
      m.daisy(-0.065, 0.21, -0.045, 0.065, 8);
    },
  },
  {
    name: 'cup',
    size: 1.6,
    density: 0.026,
    build: (m) => {
      m.stem([[0, 0, 0], [-0.01, 0.16, 0], [0.005, 0.3, 0.008]], 0.007);
      m.leaf(0, 0.03, 0, 0.1, 1.2, 0.4, 0.4);
      m.leaf(0, 0.05, 0, 0.08, 4.0, 0.4, 0.4);
      m.cup(0.005, 0.3, 0.008, 0.085, 5, 0.6);
      m.tag = 0.5;
      m.stem([[-0.008, 0.13, 0], [0.05, 0.19, -0.03], [0.07, 0.23, -0.04]], 0.005);
      m.cup(0.07, 0.23, -0.04, 0.065, 5, 0.65);
      m.tag = 1;
      m.stem([[-0.006, 0.1, 0], [-0.05, 0.15, 0.04], [-0.06, 0.17, 0.05]], 0.005);
      m.cup(-0.06, 0.17, 0.05, 0.05, 5, 0.8);
    },
  },
  {
    name: 'bell',
    size: 1.7,
    density: 0.017,
    build: (m) => {
      m.stem([[0, 0, 0], [0.01, 0.2, 0], [0.04, 0.36, 0], [0.07, 0.4, 0]], 0.006);
      m.leaf(0, 0.03, 0, 0.1, 0.9, 0.22, 0.6);
      m.leaf(0, 0.05, 0, 0.09, 3.9, 0.22, 0.6);
      m.bell(0.07, 0.4, 0, [0.45, -1, 0.1], 0.09, 0.05);
      m.tag = 0.5;
      m.stem([[0.012, 0.24, 0], [-0.03, 0.29, 0.02], [-0.045, 0.29, 0.03]], 0.004);
      m.bell(-0.045, 0.29, 0.03, [-0.6, -1, 0.3], 0.075, 0.042);
      m.tag = 1;
      m.stem([[0.02, 0.29, 0], [0.04, 0.31, -0.04], [0.05, 0.3, -0.055]], 0.004);
      m.bell(0.05, 0.3, -0.055, [0.2, -1, -0.6], 0.065, 0.036);
    },
  },
  {
    name: 'spike',
    size: 1.5,
    density: 0.012,
    build: (m) => {
      m.stem([[0, 0, 0], [0.005, 0.3, 0], [0, 0.58, 0]], 0.008);
      for (let k = 0; k < 5; k++) m.leaf(0, 0.03, 0, 0.12, k * 1.257 + 0.3, 0.16, 0.45);
      m.spike(0, 0, 0.3, 0.56, 0.026, 0.04, 14);
      m.tag = 0.5;
      m.stem([[0.004, 0.05, 0], [0.05, 0.25, 0.02], [0.06, 0.44, 0.02]], 0.006);
      m.spike(0.06, 0.02, 0.26, 0.42, 0.022, 0.034, 9);
    },
  },
  {
    name: 'clover',
    size: 1.8,
    density: 0.026,
    build: (m) => {
      m.stem([[0, 0, 0], [0.005, 0.08, 0], [0.01, 0.15, 0.004]], 0.004);
      m.trefoil(0, 0.04, 0, 0.045, 0.3);
      m.trefoil(0.03, 0.03, 0.02, 0.04, 1.9);
      m.pom(0.01, 0.16, 0.004, 0.032);
      m.tag = 0.5;
      m.stem([[0, 0, 0], [0.04, 0.07, 0.02], [0.06, 0.12, 0.03]], 0.004);
      m.pom(0.06, 0.13, 0.03, 0.028);
      m.tag = 1;
      m.stem([[0, 0, 0], [-0.04, 0.06, -0.03], [-0.05, 0.1, -0.04]], 0.004);
      m.trefoil(-0.05, 0.03, -0.035, 0.04, 4.0);
      m.pom(-0.05, 0.11, -0.04, 0.026);
    },
  },
];

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
  /** Pixels per metre at 1 m from the camera (render height / (2·tan(fov/2))), set each frame. */
  pxScale = 900;
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
    this.addField('grassNear', tuftGeometry(NEAR_TUFT), innerR, 0, q.grassDensity * 0.45, { h: 0.5, w: 0.11, flower: 0 });
    this.addField('grassFar', tuftGeometry(FAR_TUFT), q.grassRadius, innerR, q.grassDensity * 0.3, { h: 0.62, w: 0.17, flower: 0 });
    // one field per flower species (each its own shape and drifts)
    FLOWERS.forEach((f, i) => {
      const m = new FlowerMesh();
      f.build(m);
      this.addField('flowers_' + f.name, m.build(), Math.min(q.grassRadius, 34), 0, q.grassDensity * f.density, { h: f.size, w: f.size, flower: i + 1 });
    });
  }

  private addField(name: string, geo: VertexData, radius: number, innerCut: number, density: number, shape: { h: number; w: number; flower: number }) {
    const period = radius * 2;
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
      attributes: ['position', 'uv', 'color', 'grassInst'],
      uniforms: ['viewProjection', 'field', 'shape', 'camPos', 'pxScale', 'wind', 'pushers', 'sunDir', 'sunColor', 'ambientColor', ...TOON_FOG_UNIFORMS, 'tipColor', 'dryColor', 'grassA', 'grassB', 'grassDry', 'forestCol', 'lightMatrix', 'shadowInfo', 'toonGI', 'toonGIShadow'],
      samplers: ['heightTex', 'splatTex', 'detailTex', 'shadowTex', 'kLightMap', 'kBounceMap'],
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
    if (worldLight.map) mat.setTexture('kLightMap', worldLight.map);
    if (worldLight.bounce) mat.setTexture('kBounceMap', worldLight.bounce);
    mat.setColor3('tipColor', Color3.FromHexString('#c4e46a').toLinearSpace());
    mat.setColor3('dryColor', Color3.FromHexString('#e2d77a').toLinearSpace());
    for (const k of ['grassA', 'grassB', 'grassDry', 'forestCol'] as const) mat.setColor3(k, Color3.FromArray(GROUND[k]));
    mesh.material = mat;
    const fv = new Vector4(period, radius, innerCut, 1);
    this.fields.push({ mesh, mat, shape: [shape.h, shape.w, shape.flower], fv, sv: new Vector4() });
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
