// GLSL for the effect layers (compiled once each; Babylon converts them for
// WebGPU). Every layer animates on the GPU from a spawn time and a duration
// stored per instance, so an effect costs one buffer write when it starts and
// nothing per frame after that.
import { Effect } from '@babylonjs/core';

const NOISE = /* glsl */ `
float fxHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float fxNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(fxHash(i), fxHash(i + vec2(1.0, 0.0)), u.x), mix(fxHash(i + vec2(0.0, 1.0)), fxHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fxFbm(vec2 p) {
  float v = 0.0; float a = 0.5;
  for (int i = 0; i < 4; i++) { v += fxNoise(p) * a; p = p * 2.03 + vec2(17.1, 3.7); a *= 0.5; }
  return v;
}
vec3 fxHot(vec3 col, float core, float hot) {
  float m = max(max(col.r, col.g), col.b);
  vec3 white = mix(col, vec3(m), 0.82) * 1.7 + vec3(0.25);
  return mix(col, white, clamp(core * hot, 0.0, 1.0));
}
`;

const TERRAIN = /* glsl */ `
uniform sampler2D heightTex;
uniform float useHeight;
float fxTerrainH(vec2 xz) {
  vec2 g = clamp(xz + 512.0, vec2(0.0), vec2(1022.99));
  vec2 i = floor(g);
  vec2 f = g - i;
  ivec2 ii = ivec2(i);
  float a = texelFetch(heightTex, ii, 0).r;
  float b = texelFetch(heightTex, ii + ivec2(1, 0), 0).r;
  float c = texelFetch(heightTex, ii + ivec2(0, 1), 0).r;
  float d = texelFetch(heightTex, ii + ivec2(1, 1), 0).r;
  return f.x > f.y ? a + (b - a) * f.x + (d - b) * f.y : a + (d - c) * f.x + (c - a) * f.y;
}
`;

// ------------------------------------------------------------------ sprites
Effect.ShadersStore['keliaFxSpriteVertexShader'] = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec4 spA; // p0.xyz, t0
attribute vec4 spB; // v.xyz, dur
attribute vec4 spC; // rgb (HDR), alpha
attribute vec4 spD; // size0, size1, cell, gravity
attribute vec4 spE; // drag, rot0, spin, mode
attribute vec4 spF; // axis.xyz, stretch
attribute vec4 spG; // fadeIn, fadeOutStart, hot, occlusion
attribute vec4 spH; // sizeEase, seed, flicker, -
uniform mat4 viewProjection;
uniform vec3 camPos;
uniform vec3 camRight;
uniform vec3 camUp;
uniform float fxTime;
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vP;   // cell, f, hot, occlusion
varying vec2 vM;   // seed, age

void main(void) {
  float age = fxTime - spA.w;
  float dur = spB.w;
  float f = age / max(dur, 1e-4);
  bool dead = dur <= 0.0 || age < 0.0 || f >= 1.0;
  f = clamp(f, 0.0, 1.0);
  age = max(age, 0.0);
  float k = spE.x;
  float tm = k > 0.001 ? (1.0 - exp(-k * age)) / k : age;
  vec3 p = spA.xyz + spB.xyz * tm;
  p.y -= 0.5 * spD.w * age * age;
  vec3 vel = spB.xyz * exp(-k * age);
  vel.y -= spD.w * age;
  float e = spH.x;
  float sf = e > 0.0 ? 1.0 - pow(1.0 - f, 1.0 + e * 3.0) : f;
  float size = mix(spD.x, spD.y, sf);
  float ang = spE.y + spE.z * age;
  float ca = cos(ang);
  float sa = sin(ang);
  vec2 c = position.xy;
  float mode = spE.w;
  vec3 wp;
  if (mode < 0.5) {
    vec3 r = camRight * ca + camUp * sa;
    vec3 u = -camRight * sa + camUp * ca;
    wp = p + (r * c.x + u * c.y) * size;
  } else if (mode < 1.5) {
    float sp = length(vel);
    vec3 dir = sp > 1e-3 ? vel / sp : vec3(0.0, 1.0, 0.0);
    float len = size * 2.0 + spF.w * sp;
    len = min(len, size * 2.0 + length(p - spA.xyz));
    vec3 side = cross(dir, normalize(camPos - p));
    float sl = length(side);
    side = sl > 1e-4 ? side / sl : camRight;
    wp = p + side * c.x * size + dir * (c.y - 1.0) * 0.5 * len;
  } else if (mode < 2.5) {
    vec3 n = normalize(spF.xyz + vec3(0.0, 1e-5, 0.0));
    vec3 t = normalize(cross(n, abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 b = cross(n, t);
    vec3 r = t * ca + b * sa;
    vec3 u = -t * sa + b * ca;
    wp = p + (r * c.x + u * c.y) * size;
  } else {
    vec3 toCam = camPos - p;
    vec3 r = normalize(vec3(toCam.z, 0.0, -toCam.x) + vec3(1e-4, 0.0, 0.0));
    wp = p + r * c.x * size + vec3(0.0, 1.0, 0.0) * c.y * size;
  }
  float fin = spG.x;
  float env = (fin > 0.0 ? smoothstep(0.0, fin, f) : 1.0) * (1.0 - smoothstep(spG.y, 1.0, f));
  if (spH.z > 0.0) env *= 1.0 - spH.z * (0.5 + 0.5 * sin(age * 38.0 + spH.y * 40.0));
  vUv = c * 0.5 + 0.5;
  vCol = vec4(spC.rgb, spC.a * env);
  vP = vec4(spD.z, f, spG.z, spG.w);
  vM = vec2(spH.y, age);
  gl_Position = dead ? vec4(2.0, 2.0, 2.0, 1.0) : viewProjection * vec4(wp, 1.0);
}
`;

Effect.ShadersStore['keliaFxSpriteFragmentShader'] = /* glsl */ `
precision highp float;
uniform sampler2D atlas;
uniform vec3 litTint;
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vP;
varying vec2 vM;
${NOISE}
void main(void) {
  float cell = vP.x;
  float f = vP.y;
  vec2 c = vUv * 2.0 - 1.0;
  float r = length(c);
  float core;
  float shape;
  vec3 col = vCol.rgb;
  float seed = vM.x;
  float age = vM.y;
  if (cell < 15.5) {
    vec2 cu = vec2(mod(cell, 4.0), floor(cell / 4.0 + 0.01));
    vec4 t = texture2D(atlas, (cu + clamp(vUv, 0.004, 0.996)) * 0.25);
    core = t.r;
    shape = t.a;
  } else if (cell < 16.5) {
    // fireball: noise-scrolled layered flame
    // fireball: noise-scrolled cel-shaded flame that erodes into wisps
    float n = fxFbm(c * 2.4 + vec2(seed * 13.0, -age * 3.2));
    float n2 = fxFbm(c * 5.0 + vec2(age * 1.3 + seed * 7.0, -age * 6.0));
    float d = r + (n * 0.6 + n2 * 0.3 - 0.45) * 0.75 + f * f * 0.6;
    shape = smoothstep(0.9, 0.82, d);
    float mid = smoothstep(0.68, 0.6, d);
    core = smoothstep(0.44, 0.36, d);
    col = col * mix(vec3(0.85, 0.2, 0.07), vec3(1.0), mid);
  } else if (cell < 17.5) {
    // arcane orb: swirling bands around a hot core
    float th = atan(c.y, c.x);
    float sw = sin(3.0 * (th + r * 5.0 - age * 7.0 + seed * 6.0));
    float bands = 0.5 + 0.5 * sw;
    shape = smoothstep(1.0, 0.45, r) * (0.45 + 0.55 * bands * smoothstep(0.15, 0.7, r)) + exp(-r * r * 9.0) * 0.8;
    core = exp(-r * r * 16.0) + bands * smoothstep(0.8, 0.5, r) * 0.25;
  } else if (cell < 18.5) {
    // crisp shock ring that thins as it expands
    float th = mix(0.22, 0.025, f);
    float d = abs(r - 0.82);
    shape = smoothstep(th, 0.0, d) * (1.0 - smoothstep(0.96, 1.0, r));
    core = smoothstep(th * 0.45, 0.0, d);
  } else {
    // soul wisp: flickering upright flame
    float yy = c.y * 0.5 + 0.5;
    float n = fxFbm(vec2(c.x * 3.0 + seed * 9.0, c.y * 2.0 - age * 4.0));
    float x = c.x + (n - 0.5) * 0.5 * yy + sin(c.y * 4.0 + age * 7.0 + seed * 20.0) * 0.12 * yy;
    float w = 0.55 * pow(max(0.0, 1.0 - yy), 0.6) * smoothstep(0.0, 0.3, yy + 0.05);
    shape = smoothstep(w, w * 0.4, abs(x)) * smoothstep(1.0, 0.8, yy) + exp(-dot(c + vec2(0.0, 0.45), c + vec2(0.0, 0.45)) * 6.0) * 0.5;
    core = smoothstep(w * 0.5, 0.0, abs(x)) * smoothstep(0.7, 0.1, yy);
  }
  float a = clamp(shape, 0.0, 1.0) * vCol.a;
  col = fxHot(col, core, vP.z);
  // smoke and dust (occluding, not glowing) take the scene's light
  col *= mix(vec3(1.0), litTint, clamp(vP.w * (1.0 - vP.z), 0.0, 1.0));
  if (a < 0.002) discard;
  gl_FragColor = vec4(col * a, a * vP.w);
}
`;

// ------------------------------------------------------------------ ground decals
Effect.ShadersStore['keliaFxDecalVertexShader'] = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec4 dcA; // center.xyz, t0
attribute vec4 dcB; // r0, r1, dur, rot0
attribute vec4 dcC; // rgb, alpha
attribute vec4 dcD; // cell, spin, mode, fadeIn
attribute vec4 dcE; // occlusion, fadeOutStart, hot, lift
uniform mat4 viewProjection;
uniform float fxTime;
${TERRAIN}
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vP; // cell, f, hot, occlusion

void main(void) {
  float age = fxTime - dcA.w;
  float dur = dcB.z;
  float f = age / max(dur, 1e-4);
  bool dead = dur <= 0.0 || age < 0.0 || f >= 1.0;
  f = clamp(f, 0.0, 1.0);
  age = max(age, 0.0);
  float mode = dcD.z;
  float fin = dcD.w;
  float r;
  float env;
  if (mode < 0.5) {
    float e = 1.0 - pow(1.0 - f, 3.0);
    r = mix(dcB.x, dcB.y, e);
    env = (fin > 0.0 ? smoothstep(0.0, fin, f) : 1.0) * (1.0 - smoothstep(dcE.y, 1.0, f));
  } else if (mode < 1.5) {
    r = mix(dcB.x, dcB.y, f);
    env = fin > 0.0 ? smoothstep(0.0, fin, f) : 1.0;
  } else {
    float g = fin > 0.0 ? clamp(f / fin, 0.0, 1.0) : 1.0;
    r = mix(dcB.x, dcB.y, 1.0 - pow(1.0 - g, 3.0));
    env = g * (1.0 - smoothstep(dcE.y, 1.0, f));
  }
  float ang = dcB.w + dcD.y * age;
  float ca = cos(ang);
  float sa = sin(ang);
  vec2 l = vec2(position.x * ca - position.z * sa, position.x * sa + position.z * ca) * max(r, 0.001);
  vec2 xz = dcA.xz + l;
  float y = useHeight > 0.5 ? max(fxTerrainH(xz), dcA.y - 1.5) : dcA.y;
  vUv = position.xz * 0.5 + 0.5;
  vCol = vec4(dcC.rgb, dcC.a * env);
  vP = vec4(dcD.x, f, dcE.z, dcE.x);
  vec3 wp = vec3(xz.x, y + dcE.w, xz.y);
  gl_Position = dead ? vec4(2.0, 2.0, 2.0, 1.0) : viewProjection * vec4(wp, 1.0);
}
`;

Effect.ShadersStore['keliaFxDecalFragmentShader'] = /* glsl */ `
precision highp float;
uniform sampler2D atlas;
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vP;
${NOISE}
void main(void) {
  float cell = vP.x;
  vec2 cu = vec2(mod(cell, 4.0), floor(cell / 4.0 + 0.01));
  vec4 t = texture2D(atlas, (cu + clamp(vUv, 0.002, 0.998)) * 0.25);
  float a = t.a * vCol.a;
  if (a < 0.002) discard;
  vec3 col = fxHot(vCol.rgb, t.r, vP.z);
  gl_FragColor = vec4(col * a, a * vP.w);
}
`;

// ------------------------------------------------------------------ ribbon shapes
// One template grid (u along, v across) bent into arcs, pillars, helices,
// cones and rings by the instance's mode.
Effect.ShadersStore['keliaFxShapeVertexShader'] = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec4 shA; // pos.xyz, t0
attribute vec4 shB; // yaw, tilt, dur, mode
attribute vec4 shC; // radius, length (arc angle / height), width, turns
attribute vec4 shD; // rgb, alpha
attribute vec4 shE; // spin, rise, grow, seed
attribute vec4 shF; // pitch, fadeOutStart, hot, headSpeed
attribute vec4 shG; // occlusion, stand (arc slant out of its plane), -, -
uniform mat4 viewProjection;
uniform vec3 camPos;
uniform float fxTime;
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vS;  // mode, f, hot, head
varying vec4 vE;  // edge (fresnel), seed, age, turns
varying float vO;

vec3 rotY(vec3 p, float a) { float c = cos(a); float s = sin(a); return vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c); }
vec3 rotX(vec3 p, float a) { float c = cos(a); float s = sin(a); return vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c); }
vec3 rotZ(vec3 p, float a) { float c = cos(a); float s = sin(a); return vec3(p.x * c - p.y * s, p.x * s + p.y * c, p.z); }

void main(void) {
  float age = fxTime - shA.w;
  float dur = shB.z;
  float f = age / max(dur, 1e-4);
  bool dead = dur <= 0.0 || age < 0.0 || f >= 1.0;
  f = clamp(f, 0.0, 1.0);
  age = max(age, 0.0);
  float u = position.x;
  float v = position.y;
  float mode = shB.w;
  float radius = shC.x;
  float len = shC.y;
  float width = shC.z;
  float turns = shC.w;
  float eo = 1.0 - pow(1.0 - f, 3.0);
  float grow = mix(1.0, shE.z, eo);
  float head = clamp(f * shF.w, 0.0, 2.0);
  head = head < 1.0 ? 1.0 - (1.0 - head) * (1.0 - head) : head;
  vec3 L;
  vec3 N = vec3(0.0, 1.0, 0.0);
  if (mode < 0.5) {
    // crescent arc in the XZ plane, thickest in the middle
    float a = (u - 0.5) * len;
    float tw = width * pow(max(sin(3.14159 * u), 0.0), 0.65);
    float off = tw * (1.0 - v);
    float rr = radius * grow - off * (1.0 - abs(shG.y) * 0.6);
    L = vec3(sin(a) * rr, shE.y * f - off * shG.y, cos(a) * rr);
  } else if (mode < 1.5) {
    // open cylinder (pillars, beams, vortex walls)
    float a = u * 6.28318;
    float rr = radius * grow * mix(1.0, width, v);
    L = vec3(sin(a) * rr, v * len + shE.y * f, cos(a) * rr);
    N = vec3(sin(a), 0.0, cos(a));
  } else if (mode < 2.5) {
    // helix ribbon rising around the axis
    float a = u * turns * 6.28318 + shE.w * 6.28318;
    float rr = radius * mix(1.0, shE.z, u);
    L = vec3(sin(a) * rr, u * len + (v - 0.5) * width + shE.y * f, cos(a) * rr);
    N = vec3(sin(a), 0.0, cos(a));
  } else if (mode < 3.5) {
    // forward cone (+Z) opening as it travels
    float a = (u - 0.5) * turns;
    float d = v * eo;
    float rr = radius * d;
    L = vec3(sin(a) * rr, cos(a) * rr, len * d);
    N = normalize(vec3(sin(a), cos(a), -radius / max(len, 0.01)));
  } else {
    // flat ring band rising
    float a = u * 6.28318;
    float rr = radius * grow + (v - 0.5) * width;
    L = vec3(sin(a) * rr, shE.y * eo, cos(a) * rr);
  }
  float yaw = shB.x + shE.x * eo;
  vec3 P = rotY(rotX(rotZ(L, shB.y), shF.x), yaw);
  N = rotY(rotX(rotZ(N, shB.y), shF.x), yaw);
  vec3 wp = shA.xyz + P;
  vec3 V = normalize(camPos - wp);
  float edge = 1.0 - abs(dot(normalize(N), V));
  float env = smoothstep(0.0, 0.06, f) * (1.0 - smoothstep(shF.y, 1.0, f));
  vUv = vec2(u, v);
  vCol = vec4(shD.rgb, shD.a * env);
  vS = vec4(mode, f, shF.z, head);
  vE = vec4(edge, shE.w, age, turns);
  vO = shG.x;
  gl_Position = dead ? vec4(2.0, 2.0, 2.0, 1.0) : viewProjection * vec4(wp, 1.0);
}
`;

Effect.ShadersStore['keliaFxShapeFragmentShader'] = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vS;
varying vec4 vE;
varying float vO;
${NOISE}
void main(void) {
  float u = vUv.x;
  float v = vUv.y;
  float mode = vS.x;
  float f = vS.y;
  float head = vS.w;
  float seed = vE.y;
  float age = vE.z;
  float shape;
  float core;
  if (mode < 0.5) {
    // slash: sweeping head, white-hot outer edge, soft inner body, speed lines
    float vis = step(u, head) * (0.35 + 0.65 * smoothstep(head - 1.0, head - 0.1, u)) * smoothstep(head - 1.25, head - 0.85, u);
    float nearHead = smoothstep(head - 0.35, head, u);
    float edge = smoothstep(0.6, 0.93, v) * (1.0 - smoothstep(0.965, 1.0, v));
    float body = pow(v, 1.8);
    float s = fxHash(vec2(floor(v * 11.0), seed * 31.0));
    float lines = step(0.45, s) * smoothstep(0.2, 0.9, v) * (0.55 + 0.45 * sin(u * 34.0 + s * 40.0 - age * 30.0));
    float tipFade = smoothstep(0.0, 0.08, u) * smoothstep(1.0, 0.9, u);
    shape = (body * 0.55 + lines * 0.35 + edge) * vis * tipFade;
    core = edge * (0.4 + 0.6 * nearHead) + body * nearHead * 0.3;
  } else if (mode < 1.5) {
    // pillar of light: vertical streaks scrolling upward, bright silhouette
    float vis = step(v, head);
    float n = fxFbm(vec2(u * 9.0 + seed * 5.0, v * 2.5 - age * 3.0));
    float stripes = pow(0.5 + 0.5 * sin(u * 6.28318 * max(vE.w, 1.0) + seed * 9.0 + n * 3.0), 3.0);
    float vfade = smoothstep(0.0, 0.06, v) * pow(1.0 - v, 1.4);
    float edge = pow(vE.x, 2.2);
    float streak = smoothstep(0.45, 0.85, n) * 0.7 + stripes * 0.5;
    shape = vfade * vis * (0.06 + 0.5 * edge + streak * (0.25 + 0.6 * edge));
    core = vfade * (edge * 0.6 + streak * 0.5);
  } else if (mode < 2.5) {
    // helix ribbon: bright centre line, glowing head
    float vis = step(u, head) * smoothstep(head - 0.55, head - 0.02, u);
    float band = 1.0 - abs(v - 0.5) * 2.0;
    float nearHead = smoothstep(head - 0.2, head, u);
    shape = pow(band, 1.3) * vis * (0.6 + 0.4 * nearHead) * smoothstep(0.0, 0.05, u);
    core = pow(band, 5.0) * (0.5 + 0.5 * nearHead);
  } else if (mode < 3.5) {
    // shock cone: rings racing outward, bright mouth
    float rings = pow(0.5 + 0.5 * sin(v * 26.0 - age * 40.0), 4.0);
    float mouth = smoothstep(0.7, 0.96, v) * (1.0 - smoothstep(0.96, 1.0, v));
    float side = smoothstep(0.0, 0.12, u) * smoothstep(1.0, 0.88, u);
    shape = (mouth + rings * 0.35 * v + 0.15 * v) * side * (0.5 + 0.5 * vE.x);
    core = mouth;
  } else {
    // rising ring band
    float band = 1.0 - abs(v - 0.5) * 2.0;
    float glint = 0.75 + 0.25 * sin(u * 6.28318 * 12.0 + age * 6.0 + seed * 10.0);
    shape = pow(band, 1.6) * glint;
    core = pow(band, 6.0);
  }
  float a = clamp(shape, 0.0, 1.0) * vCol.a;
  if (a < 0.002) discard;
  vec3 col = fxHot(vCol.rgb, core, vS.z);
  gl_FragColor = vec4(col * a, a * vO);
}
`;

// ------------------------------------------------------------------ crystals and debris
Effect.ShadersStore['keliaFxShardVertexShader'] = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec4 sdA; // base.xyz, t0
attribute vec4 sdB; // vel.xyz, dur
attribute vec4 sdC; // axis.xyz, length
attribute vec4 sdD; // rgb, style (0 ice, 1 rock, 2 thorn)
attribute vec4 sdE; // width, gravity, spin, growFraction
uniform mat4 viewProjection;
uniform float fxTime;
varying vec3 vN;
varying vec3 vW;
varying vec4 vC;
varying vec2 vF; // f, local height

vec3 rotAxis(vec3 p, vec3 a, float ang) {
  float c = cos(ang); float s = sin(ang);
  return p * c + cross(a, p) * s + a * dot(a, p) * (1.0 - c);
}
float easeOutBack(float x) { float c1 = 1.9; float c3 = c1 + 1.0; float t = x - 1.0; return 1.0 + c3 * t * t * t + c1 * t * t; }

void main(void) {
  float age = fxTime - sdA.w;
  float dur = sdB.w;
  float f = age / max(dur, 1e-4);
  bool dead = dur <= 0.0 || age < 0.0 || f >= 1.0;
  f = clamp(f, 0.0, 1.0);
  age = max(age, 0.0);
  float gf = sdE.w;
  float g = gf > 0.0 ? easeOutBack(clamp(f / gf, 0.0, 1.0)) : 1.0;
  float shrink = 1.0 - smoothstep(0.8, 1.0, f);
  vec3 local = position * vec3(sdE.x, sdC.w, sdE.x) * max(g, 0.0) * shrink;
  vec3 n = normal;
  float style = sdD.w;
  vec3 Y = normalize(sdC.xyz + vec3(0.0, 1e-5, 0.0));
  vec3 X = normalize(cross(Y, abs(Y.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 Z = cross(X, Y);
  vec3 wl = X * local.x + Y * local.y + Z * local.z;
  vec3 wn = X * n.x + Y * n.y + Z * n.z;
  float spin = sdE.z * age;
  if (style > 0.5 && style < 1.5) { wl = rotAxis(wl, X, spin); wn = rotAxis(wn, X, spin); }
  else { wl = rotAxis(wl, Y, spin); wn = rotAxis(wn, Y, spin); }
  vec3 base = sdA.xyz + sdB.xyz * age;
  base.y -= 0.5 * sdE.y * age * age;
  vec3 wp = base + wl;
  vN = wn;
  vW = wp;
  vC = sdD;
  vF = vec2(f, position.y);
  gl_Position = dead ? vec4(2.0, 2.0, 2.0, 1.0) : viewProjection * vec4(wp, 1.0);
}
`;

Effect.ShadersStore['keliaFxShardFragmentShader'] = /* glsl */ `
precision highp float;
uniform vec3 camPos;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 ambient;
varying vec3 vN;
varying vec3 vW;
varying vec4 vC;
varying vec2 vF;
void main(void) {
  vec3 N = normalize(vN);
  vec3 V = normalize(camPos - vW);
  float ndl = dot(N, sunDir);
  float fres = 1.0 - abs(dot(N, V));
  vec3 col;
  float a;
  if (vC.w < 0.5) {
    // ice: deep tinted body, white rim, a hard glint and a glowing tip
    float facet = 0.55 + 0.45 * smoothstep(-0.2, 0.6, ndl);
    float spec = pow(max(dot(reflect(-V, N), sunDir), 0.0), 28.0);
    col = vC.rgb * 0.22 * facet + vC.rgb * 1.6 * pow(fres, 2.2) + vec3(2.2) * spec + vC.rgb * 1.2 * smoothstep(0.55, 1.0, vF.y);
    col += vec3(0.7, 0.9, 1.0) * smoothstep(0.4, 0.95, fres) * 0.6;
    a = 0.62 + 0.38 * fres;
  } else if (vC.w < 1.5) {
    // rock debris: toon lit
    float lit = smoothstep(-0.05, 0.05, ndl);
    col = vC.rgb * (ambient + sunColor * lit * 0.9);
    a = 1.0;
  } else {
    // thorn: dark green body with a glowing rim
    float lit = smoothstep(-0.1, 0.2, ndl);
    col = vC.rgb * (0.25 + 0.4 * lit) + vC.rgb * 2.4 * pow(fres, 2.5) + vC.rgb * 1.5 * smoothstep(0.7, 1.0, vF.y);
    a = 0.95;
  }
  gl_FragColor = vec4(col * a, a);
}
`;

// ------------------------------------------------------------------ weapon trails
Effect.ShadersStore['keliaFxTrailVertexShader'] = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec4 trA; // stamp, v (0 grip .. 1 tip), along (0 newest .. 1 oldest), -
attribute vec4 color; // rgb (HDR), life
uniform mat4 viewProjection;
uniform float fxTime;
varying vec3 vT;
varying vec4 vCol;
void main(void) {
  float age = (fxTime - trA.x) / max(color.a, 1e-3);
  vT = vec3(age, trA.y, trA.z);
  vCol = color;
  gl_Position = viewProjection * vec4(position, 1.0);
}
`;

Effect.ShadersStore['keliaFxTrailFragmentShader'] = /* glsl */ `
precision highp float;
varying vec3 vT;
varying vec4 vCol;
${NOISE}
void main(void) {
  float age = clamp(vT.x, 0.0, 1.0);
  float v = vT.y;
  float fade = pow(1.0 - age, 1.6) * smoothstep(1.0, 0.8, vT.z);
  float body = smoothstep(0.0, 0.55, v) * smoothstep(1.0, 0.93, v);
  float edge = smoothstep(0.72, 0.9, v) * smoothstep(1.0, 0.94, v);
  float streak = 0.75 + 0.25 * sin(v * 40.0 + vT.z * 12.0);
  float a = clamp((body * 0.6 * streak + edge) * fade, 0.0, 1.0);
  if (a < 0.003) discard;
  vec3 col = fxHot(vCol.rgb, edge * (1.0 - age * 0.7) + (1.0 - vT.z) * 0.4 * body, 1.0);
  gl_FragColor = vec4(col * a, 0.0);
}
`;

// ------------------------------------------------------------------ afterimages
Effect.ShadersStore['keliaFxGhostVertexShader'] = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec4 ghA; // t0, dur, rise, -
attribute vec4 color; // rgb HDR, alpha
uniform mat4 viewProjection;
uniform float fxTime;
varying vec3 vN;
varying vec3 vW;
varying vec4 vCol;
varying float vF;
void main(void) {
  float age = max(fxTime - ghA.x, 0.0);
  float f = clamp(age / max(ghA.y, 1e-3), 0.0, 1.0);
  vec3 wp = position + vec3(0.0, ghA.z * age, 0.0) + normal * f * 0.04;
  vN = normal;
  vW = wp;
  vCol = color;
  vF = f;
  gl_Position = viewProjection * vec4(wp, 1.0);
}
`;

Effect.ShadersStore['keliaFxGhostFragmentShader'] = /* glsl */ `
precision highp float;
uniform vec3 camPos;
varying vec3 vN;
varying vec3 vW;
varying vec4 vCol;
varying float vF;
${NOISE}
void main(void) {
  vec3 N = normalize(vN);
  vec3 V = normalize(camPos - vW);
  float fres = pow(1.0 - abs(dot(N, V)), 2.0);
  float n = fxFbm(vW.xz * 3.0 + vec2(vW.y * 4.0, vW.y * 2.0));
  float dissolve = smoothstep(vF * 1.15 - 0.1, vF * 1.15, n);
  float burn = (1.0 - smoothstep(0.0, 0.08, n - (vF * 1.15 - 0.1))) * step(0.02, vF);
  float scan = 0.85 + 0.15 * sin(vW.y * 60.0);
  float a = (0.12 + fres * 0.9) * dissolve * vCol.a * scan * (1.0 - vF * 0.5);
  vec3 col = fxHot(vCol.rgb, fres * 0.6 + burn, 1.0);
  a += burn * 0.6 * dissolve * vCol.a;
  if (a < 0.003) discard;
  gl_FragColor = vec4(col * a, 0.0);
}
`;
