// Kelia's stylized "anime" lighting model, shared by every lit surface.
//
// One material plugin is registered globally, so every PBR and Standard
// material in the game (code-built or loaded from glTF) is shaded the same
// way: a cel-shaded sun terminator with a soft edge, cool tinted shadows
// instead of black ones, a hemispheric sky/ground ambient, a fresnel rim
// light, optional leaf translucency and a hard stylized highlight. Fog is a
// painterly height fog that glows warm toward the sun. Image-based lighting,
// the PBR BRDF and Babylon's fog are all bypassed, which also makes every
// surface cheaper to shade.
//
// The custom ShaderMaterials (grass, water, sky) use the same fog through
// TOON_FOG_GLSL + bindToonFog() so the whole world sits in one atmosphere.
import {
  MaterialPluginBase,
  PBRMaterial,
  RegisterMaterialPlugin,
  ShaderLanguage,
  StandardMaterial,
  Vector4,
  type Material,
  type MaterialDefines,
  type ShaderMaterial,
  type UniformBuffer,
} from '@babylonjs/core';
import { WORLD_LIGHT_GLSL, WORLD_LIGHT_WGSL, worldLight } from './worldLight';

/** Lighting state for the whole frame, written by Atmosphere.update(). */
export const toon = {
  /** xyz = direction toward the key light (sun or moon), w = shadow strength. */
  sunDir: new Vector4(0, 1, 0, 1),
  /** rgb = key light colour × intensity. */
  sun: new Vector4(1, 1, 1, 0),
  /** rgb = sky ambient, w = global rim strength. */
  sky: new Vector4(0.4, 0.5, 0.7, 1),
  /** rgb = ground bounce ambient. */
  ground: new Vector4(0.25, 0.25, 0.2, 0),
  /** rgb = shadow tint multiplier, w = terminator softness. */
  shade: new Vector4(0.8, 0.8, 1, 0.08),
  /** rgb = fog colour, w = fog density per metre (at the base height). */
  fog: new Vector4(0.7, 0.8, 0.9, 0.002),
  /** x = height falloff, y = base height, z = sun-glow amount, w = max fog. */
  fog2: new Vector4(0.012, 0, 0.8, 0.96),
  /** rgb = fog colour looking toward the sun. */
  fogSun: new Vector4(1, 0.9, 0.7, 0),
  /** xyz = sun direction used for the fog glow. */
  fogDir: new Vector4(0, 1, 0, 0),
};

const UNIFORMS = ['toonSunDir', 'toonSun', 'toonSky', 'toonGround', 'toonShade', 'toonFog', 'toonFog2', 'toonFogSun', 'toonFogDir', 'toonGI', 'toonGIShadow'] as const;
const VALUES: Record<(typeof UNIFORMS)[number], Vector4> = {
  toonSunDir: toon.sunDir,
  toonSun: toon.sun,
  toonSky: toon.sky,
  toonGround: toon.ground,
  toonShade: toon.shade,
  toonFog: toon.fog,
  toonFog2: toon.fog2,
  toonFogSun: toon.fogSun,
  toonFogDir: toon.fogDir,
  toonGI: worldLight.strength,
  toonGIShadow: worldLight.shadow,
};
const SAMPLERS = ['kLightMap', 'kBounceMap'];

const FUNCS_GLSL = /* glsl */ `
${WORLD_LIGHT_GLSL}
vec3 kToon(vec3 albedo, vec3 N, vec3 V, float sh, vec3 emis, vec3 P) {
  vec3 L = toonSunDir.xyz;
  float ndl = dot(N, L);
  float soft = toonShade.w;
  vec3 gi = kWorldLight(P);
  float lit = smoothstep(-soft, soft, ndl) * mix(1.0, sh, toonSunDir.w) * gi.y;
  float up = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 amb = mix(toonGround.rgb * kBounce, toonSky.rgb, up) * gi.x * mix(vec3(1.0), vec3(0.82, 1.04, 0.78), gi.z);
  vec3 dark = amb * toonShade.rgb;
  vec3 light = dark + toonSun.rgb * lit * (1.0 + 0.12 * smoothstep(0.5, 0.7, ndl));
  vec3 col = albedo * light;
  float nv = clamp(dot(N, V), 0.0, 1.0);
  float rim = smoothstep(0.6, 0.95, 1.0 - nv) * toonSky.w * toonMat.y;
  col += rim * (amb * 0.55 + toonSun.rgb * 0.3 * lit) * (0.3 + albedo);
  float tr = pow(clamp(dot(-V, L), 0.0, 1.0), 5.0) * toonMat.x * (0.3 + 0.7 * sh) * gi.y;
  col += albedo * toonSun.rgb * tr;
  float sp = smoothstep(0.955, 0.975, dot(N, normalize(L + V))) * toonMat.z * lit;
  col += toonSun.rgb * sp;
  return col + emis;
}

// --- Character surfaces (KCHAR materials only) ---------------------------
// Per-fragment surface description, written by a character's surface plugin
// (char/recolor.ts) before lighting and read by kToonChar. Nothing else
// writes them, so they stay zero for every other material.
vec4 kSurf = vec4(0.0);  // skin, hair, metal, eye
vec4 kSurf2 = vec4(0.0); // gold, bone, catch-light, face-normal weight
vec4 kSurfN = vec4(0.0, 1.0, 0.0, 0.0); // smooth face normal
vec4 kRimC = vec4(0.0);  // rgb = extra rim colour, a = amount
vec4 kGlow = vec4(0.0);  // rgb = emission, a = extra emission at grazing angles

#ifdef KCHAR
vec3 kToonChar(vec3 albedo, vec3 N0, vec3 V, float sh, vec3 emis, vec3 P) {
  float skin = kSurf.x;
  float hair = kSurf.y;
  float eye = kSurf.w;
  float gold = kSurf2.x;
  float metal = max(max(kSurf.z, gold), toonMat.w);
  float bone = kSurf2.y;
  // faces are lit through a smooth head-shaped normal: clean, bright, no blotches
  vec3 N = normalize(mix(N0, kSurfN.xyz, kSurf2.w));
  vec3 L = toonSunDir.xyz;
  float ndl = dot(N, L);
  float soft = toonShade.w + skin * 0.2 + bone * 0.05;
  vec3 gi = kWorldLight(P);
  float shd = mix(1.0, sh, toonSunDir.w * (1.0 - 0.45 * skin)) * gi.y;
  float lit = smoothstep(-soft, soft, ndl + skin * 0.2) * shd;
  float up = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 amb = mix(toonGround.rgb * kBounce, toonSky.rgb, up) * gi.x * mix(vec3(1.0), vec3(0.86, 1.03, 0.82), gi.z);
  // skin shadows are rosy, bone shadows cold
  vec3 tint = toonShade.rgb;
  tint *= mix(vec3(1.0), vec3(1.25, 0.95, 0.9), skin);
  tint *= mix(vec3(1.0), vec3(0.8, 0.88, 1.15), bone);
  vec3 dark = amb * tint * (1.0 + 0.3 * skin);
  vec3 light = dark + toonSun.rgb * lit * (1.0 + 0.12 * smoothstep(0.5, 0.7, ndl));
  // warm scattering along the skin's terminator
  float band = lit * (1.0 - lit) * 4.0;
  light += toonSun.rgb * band * skin * vec3(0.32, 0.07, 0.03);
  // slightly more vivid cloth and leather; hair turns deeper and richer in shadow
  float alum = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
  vec3 albedoS = max(mix(vec3(alum), albedo, 1.0 + 0.14 * (1.0 - skin) * (1.0 - bone) * (1.0 - eye)), vec3(0.0));
  float amax = max(max(albedoS.r, albedoS.g), max(albedoS.b, 0.002));
  vec3 a = albedoS * mix(vec3(1.0), albedoS / amax, hair * (1.0 - lit) * 0.5);
  vec3 col = a * light;
  // eyes stay bright in any light
  col = mix(col, a * (light * 0.55 + (amb + toonSun.rgb) * 0.4), eye);
  float nv = clamp(dot(N0, V), 0.0, 1.0);
  float rimK = smoothstep(0.6, 0.95, 1.0 - nv) * toonSky.w * toonMat.y;
  col += rimK * (amb * 0.55 + toonSun.rgb * 0.3 * lit) * (0.3 + a) * (1.0 - eye);
  col += smoothstep(0.62, 0.92, 1.0 - nv) * kRimC.rgb * kRimC.a;
  // a crisp, sunlit rim line along the silhouette
  float rimH = smoothstep(0.7, 0.76, 1.0 - nv) * smoothstep(0.05, 0.35, dot(N0, L)) * shd * toonMat.y * (1.0 - eye);
  col += rimH * toonSun.rgb * (0.22 + 0.5 * a) * mix(vec3(1.0), vec3(1.15, 0.9, 0.8), skin);
  // metal: a stylised horizon reflection with one crisp bright band
  vec3 R = reflect(-V, N0);
  float env = smoothstep(-0.04, 0.04, R.y);
  float bandM = smoothstep(0.0, 0.05, R.y) * (1.0 - smoothstep(0.1, 0.26, R.y));
  vec3 skyRef = toonSky.rgb * 1.1 + toonSun.rgb * 0.3;
  vec3 tone = mix(vec3(1.0), a * 1.6 + 0.08, gold);
  vec3 metalCol = a * (dark * 0.55 + toonSun.rgb * lit * 0.6) + a * skyRef * env * 0.55 + skyRef * tone * bandM * (0.45 + 0.55 * lit);
  col = mix(col, metalCol, metal);
  vec3 Hs = normalize(L + V);
  float sp = smoothstep(0.955 - metal * 0.035, 0.975 - metal * 0.02, dot(N, Hs)) * (toonMat.z + metal * 1.1) * lit;
  col += toonSun.rgb * sp * tone;
  // hair: an anisotropic "angel ring" around the head that follows the view
  // (matcap style: a band where the normal points a little upward on screen)
  vec3 sUp = vec3(0.0, 1.0, 0.0) - V * V.y;
  float sl = length(sUp);
  sUp = sl > 0.001 ? sUp / sl : vec3(0.0, 0.0, 1.0);
  float su = dot(N0, sUp);
  float jag = 0.5 + 0.5 * sin((P.x * 1.3 + P.z * 0.9) * 70.0 + P.y * 9.0);
  float ring = smoothstep(0.3, 0.36, su) * (1.0 - smoothstep(0.5 + 0.1 * jag, 0.56 + 0.1 * jag, su)) * smoothstep(0.2, 0.45, nv);
  col += hair * ring * (0.45 + 0.55 * lit) * (toonSun.rgb * 0.5 + toonSky.rgb * 0.6) * (0.35 + a * 1.4);
  // catch-lights in the eyes and glowing runes, edges or embers
  col += kSurf2.z * (vec3(0.9) + toonSun.rgb * 0.2);
  col += kGlow.rgb * (1.0 + kGlow.a * (1.0 - nv) * (1.0 - nv));
  return col + emis;
}
#endif
`;

const FOG_GLSL_BODY = /* glsl */ `
vec3 kFog(vec3 col, vec3 P, vec3 E) {
  vec3 d = P - E;
  float dist = length(d);
  vec3 dir = d / max(dist, 0.001);
  float k = toonFog2.x;
  float dy = d.y * k;
  float integ = abs(dy) > 0.0005 ? (1.0 - exp(-dy)) / dy : 1.0;
  float od = toonFog.w * dist * exp(-k * max(E.y - toonFog2.y, -40.0)) * integ;
  float amt = min(1.0 - exp(-max(od, 0.0)), toonFog2.w);
  float sunA = pow(max(dot(dir, toonFogDir.xyz), 0.0), 6.0);
  vec3 fc = mix(toonFog.rgb, toonFogSun.rgb, sunA * toonFog2.z);
  return mix(col, fc, amt);
}
`;

const FUNCS_WGSL = /* wgsl */ `
${WORLD_LIGHT_WGSL}
fn kToon(albedo: vec3f, N: vec3f, V: vec3f, sh: f32, emis: vec3f, P: vec3f) -> vec3f {
  let L = uniforms.toonSunDir.xyz;
  let ndl = dot(N, L);
  let soft = uniforms.toonShade.w;
  let gi = kWorldLight(P);
  let lit = smoothstep(-soft, soft, ndl) * mix(1.0, sh, uniforms.toonSunDir.w) * gi.y;
  let up = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
  let amb = mix(uniforms.toonGround.rgb * kBounce, uniforms.toonSky.rgb, up) * gi.x * mix(vec3f(1.0), vec3f(0.82, 1.04, 0.78), gi.z);
  let dark = amb * uniforms.toonShade.rgb;
  let light = dark + uniforms.toonSun.rgb * lit * (1.0 + 0.12 * smoothstep(0.5, 0.7, ndl));
  var col = albedo * light;
  let nv = clamp(dot(N, V), 0.0, 1.0);
  let rim = smoothstep(0.6, 0.95, 1.0 - nv) * uniforms.toonSky.w * uniforms.toonMat.y;
  col += rim * (amb * 0.55 + uniforms.toonSun.rgb * 0.3 * lit) * (vec3f(0.3) + albedo);
  let tr = pow(clamp(dot(-V, L), 0.0, 1.0), 5.0) * uniforms.toonMat.x * (0.3 + 0.7 * sh) * gi.y;
  col += albedo * uniforms.toonSun.rgb * tr;
  let sp = smoothstep(0.955, 0.975, dot(N, normalize(L + V))) * uniforms.toonMat.z * lit;
  col += uniforms.toonSun.rgb * sp;
  return col + emis;
}

// Character surfaces (see the GLSL version for the meaning of each value).
var<private> kSurf: vec4f = vec4f(0.0);
var<private> kSurf2: vec4f = vec4f(0.0);
var<private> kSurfN: vec4f = vec4f(0.0, 1.0, 0.0, 0.0);
var<private> kRimC: vec4f = vec4f(0.0);
var<private> kGlow: vec4f = vec4f(0.0);

#ifdef KCHAR
fn kToonChar(albedo: vec3f, N0: vec3f, V: vec3f, sh: f32, emis: vec3f, P: vec3f) -> vec3f {
  let skin = kSurf.x;
  let hair = kSurf.y;
  let eye = kSurf.w;
  let gold = kSurf2.x;
  let metal = max(max(kSurf.z, gold), uniforms.toonMat.w);
  let bone = kSurf2.y;
  let N = normalize(mix(N0, kSurfN.xyz, kSurf2.w));
  let L = uniforms.toonSunDir.xyz;
  let ndl = dot(N, L);
  let soft = uniforms.toonShade.w + skin * 0.2 + bone * 0.05;
  let gi = kWorldLight(P);
  let shd = mix(1.0, sh, uniforms.toonSunDir.w * (1.0 - 0.45 * skin)) * gi.y;
  let lit = smoothstep(-soft, soft, ndl + skin * 0.2) * shd;
  let up = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
  let amb = mix(uniforms.toonGround.rgb * kBounce, uniforms.toonSky.rgb, up) * gi.x * mix(vec3f(1.0), vec3f(0.86, 1.03, 0.82), gi.z);
  var tint = uniforms.toonShade.rgb;
  tint *= mix(vec3f(1.0), vec3f(1.25, 0.95, 0.9), skin);
  tint *= mix(vec3f(1.0), vec3f(0.8, 0.88, 1.15), bone);
  let dark = amb * tint * (1.0 + 0.3 * skin);
  var light = dark + uniforms.toonSun.rgb * lit * (1.0 + 0.12 * smoothstep(0.5, 0.7, ndl));
  let band = lit * (1.0 - lit) * 4.0;
  light += uniforms.toonSun.rgb * band * skin * vec3f(0.32, 0.07, 0.03);
  let alum = dot(albedo, vec3f(0.2126, 0.7152, 0.0722));
  let albedoS = max(mix(vec3f(alum), albedo, 1.0 + 0.14 * (1.0 - skin) * (1.0 - bone) * (1.0 - eye)), vec3f(0.0));
  let amax = max(max(albedoS.r, albedoS.g), max(albedoS.b, 0.002));
  let a = albedoS * mix(vec3f(1.0), albedoS / amax, hair * (1.0 - lit) * 0.5);
  var col = a * light;
  col = mix(col, a * (light * 0.55 + (amb + uniforms.toonSun.rgb) * 0.4), eye);
  let nv = clamp(dot(N0, V), 0.0, 1.0);
  let rimK = smoothstep(0.6, 0.95, 1.0 - nv) * uniforms.toonSky.w * uniforms.toonMat.y;
  col += rimK * (amb * 0.55 + uniforms.toonSun.rgb * 0.3 * lit) * (vec3f(0.3) + a) * (1.0 - eye);
  col += smoothstep(0.62, 0.92, 1.0 - nv) * kRimC.rgb * kRimC.a;
  let rimH = smoothstep(0.7, 0.76, 1.0 - nv) * smoothstep(0.05, 0.35, dot(N0, L)) * shd * uniforms.toonMat.y * (1.0 - eye);
  col += rimH * uniforms.toonSun.rgb * (vec3f(0.22) + 0.5 * a) * mix(vec3f(1.0), vec3f(1.15, 0.9, 0.8), skin);
  let R = reflect(-V, N0);
  let env = smoothstep(-0.04, 0.04, R.y);
  let bandM = smoothstep(0.0, 0.05, R.y) * (1.0 - smoothstep(0.1, 0.26, R.y));
  let skyRef = uniforms.toonSky.rgb * 1.1 + uniforms.toonSun.rgb * 0.3;
  let tone = mix(vec3f(1.0), a * 1.6 + vec3f(0.08), gold);
  let metalCol = a * (dark * 0.55 + uniforms.toonSun.rgb * lit * 0.6) + a * skyRef * env * 0.55 + skyRef * tone * bandM * (0.45 + 0.55 * lit);
  col = mix(col, metalCol, metal);
  let Hs = normalize(L + V);
  let sp = smoothstep(0.955 - metal * 0.035, 0.975 - metal * 0.02, dot(N, Hs)) * (uniforms.toonMat.z + metal * 1.1) * lit;
  col += uniforms.toonSun.rgb * sp * tone;
  var sUp = vec3f(0.0, 1.0, 0.0) - V * V.y;
  let sl = length(sUp);
  if (sl > 0.001) { sUp = sUp / sl; } else { sUp = vec3f(0.0, 0.0, 1.0); }
  let su = dot(N0, sUp);
  let jag = 0.5 + 0.5 * sin((P.x * 1.3 + P.z * 0.9) * 70.0 + P.y * 9.0);
  let ring = smoothstep(0.3, 0.36, su) * (1.0 - smoothstep(0.5 + 0.1 * jag, 0.56 + 0.1 * jag, su)) * smoothstep(0.2, 0.45, nv);
  col += hair * ring * (0.45 + 0.55 * lit) * (uniforms.toonSun.rgb * 0.5 + uniforms.toonSky.rgb * 0.6) * (vec3f(0.35) + a * 1.4);
  col += kSurf2.z * (vec3f(0.9) + uniforms.toonSun.rgb * 0.2);
  col += kGlow.rgb * (1.0 + kGlow.a * (1.0 - nv) * (1.0 - nv));
  return col + emis;
}
#endif

fn kFog(col: vec3f, P: vec3f, E: vec3f) -> vec3f {
  let d = P - E;
  let dist = length(d);
  let dir = d / max(dist, 0.001);
  let k = uniforms.toonFog2.x;
  let dy = d.y * k;
  var integ = 1.0;
  if (abs(dy) > 0.0005) { integ = (1.0 - exp(-dy)) / dy; }
  let od = uniforms.toonFog.w * dist * exp(-k * max(E.y - uniforms.toonFog2.y, -40.0)) * integ;
  let amt = min(1.0 - exp(-max(od, 0.0)), uniforms.toonFog2.w);
  let sunA = pow(max(dot(dir, uniforms.toonFogDir.xyz), 0.0), 6.0);
  let fc = mix(uniforms.toonFog.rgb, uniforms.toonFogSun.rgb, sunA * uniforms.toonFog2.z);
  return mix(col, fc, amt);
}
`;

/** Fog for hand-written GLSL ShaderMaterials (declare the uniforms, call kFog). */
export const TOON_FOG_GLSL = /* glsl */ `
uniform vec4 toonFog;
uniform vec4 toonFog2;
uniform vec4 toonFogSun;
uniform vec4 toonFogDir;
${FOG_GLSL_BODY}`;

export const TOON_FOG_UNIFORMS = ['toonFog', 'toonFog2', 'toonFogSun', 'toonFogDir'];

/** Push the current fog state into a ShaderMaterial that includes TOON_FOG_GLSL. */
export function bindToonFog(mat: ShaderMaterial) {
  mat.setVector4('toonFog', toon.fog);
  mat.setVector4('toonFog2', toon.fog2);
  mat.setVector4('toonFogSun', toon.fogSun);
  mat.setVector4('toonFogDir', toon.fogDir);
}

/** Per-material look. */
export interface ToonOptions {
  /** Light shining through when seen against the sun (leaves): 0..1. */
  translucency?: number;
  /** Fresnel rim light multiplier. */
  rim?: number;
  /** Hard stylized highlight (metal, glass, wet stone). */
  spec?: number;
  /** Use the toon lighting (false keeps Babylon's own lighting, e.g. unlit FX). */
  lit?: boolean;
  /** Apply the world fog. */
  fog?: boolean;
  /**
   * Character shading (skin, hair, eyes, metal, bone... as described per
   * fragment by the character surface plugin in char/recolor.ts).
   */
  char?: boolean;
  /** Character shading only: treat the whole material as polished metal (0..1). */
  metal?: number;
}

export class ToonPlugin extends MaterialPluginBase {
  translucency = 0;
  rim = 1;
  spec = 0;
  lit = true;
  fog = true;
  char = false;
  metal = 0;

  constructor(material: Material) {
    super(material, 'KeliaToon', 400, { KTOON: false, KFOG: false, KCHAR: false });
    this._enable(true);
  }

  getClassName() {
    return 'KeliaToonPlugin';
  }

  isCompatible(lang: ShaderLanguage) {
    return lang === ShaderLanguage.GLSL || lang === ShaderLanguage.WGSL;
  }

  /** Change the per-material look (marks the material for re-compilation only if the variant changes). */
  set(o: ToonOptions) {
    if (o.translucency !== undefined) this.translucency = o.translucency;
    if (o.rim !== undefined) this.rim = o.rim;
    if (o.spec !== undefined) this.spec = o.spec;
    if (o.metal !== undefined) this.metal = o.metal;
    if ((o.lit !== undefined && o.lit !== this.lit) || (o.fog !== undefined && o.fog !== this.fog) || (o.char !== undefined && o.char !== this.char)) {
      if (o.lit !== undefined) this.lit = o.lit;
      if (o.fog !== undefined) this.fog = o.fog;
      if (o.char !== undefined) this.char = o.char;
      this.markAllDefinesAsDirty();
    }
  }

  prepareDefines(defines: MaterialDefines) {
    const m = this._material as Material & { disableLighting?: boolean; unlit?: boolean };
    const d = defines as unknown as Record<string, boolean>;
    d.KTOON = this.lit && !m.disableLighting && !m.unlit;
    // unlit materials are glows and effects (often additive): fogging them toward the fog colour would make them brighter
    d.KFOG = this.fog && !m.disableLighting;
    d.KCHAR = d.KTOON && this.char;
  }

  getSamplers(samplers: string[]) {
    for (const s of SAMPLERS) samplers.push(s);
  }

  getUniforms(lang?: ShaderLanguage) {
    const names = [...UNIFORMS, 'toonMat'];
    const ubo = names.map((name) => ({ name, size: 4, type: 'vec4' }));
    const decl = lang === ShaderLanguage.WGSL ? names.map((n) => `uniform ${n}: vec4f;`).join('\n') : names.map((n) => `uniform vec4 ${n};`).join('\n');
    return { ubo, vertex: decl, fragment: decl };
  }

  bindForSubMesh(ubo: UniformBuffer) {
    for (const name of UNIFORMS) {
      const v = VALUES[name];
      ubo.updateFloat4(name, v.x, v.y, v.z, v.w);
    }
    ubo.updateFloat4('toonMat', this.translucency, this.rim, this.spec, this.metal);
    if (worldLight.map) ubo.setTexture('kLightMap', worldLight.map);
    if (worldLight.bounce) ubo.setTexture('kBounceMap', worldLight.bounce);
  }

  getCustomCode(shaderType: string, lang?: ShaderLanguage): Record<string, string> | null {
    if (shaderType !== 'fragment') return null;
    const pbr = this._material instanceof PBRMaterial;
    if (lang === ShaderLanguage.WGSL) {
      const target = pbr ? 'finalColor' : 'color';
      const albedo = pbr ? 'baseColor' : 'baseColor.rgb * diffuseColor';
      const emis = pbr ? 'finalEmissive' : 'emissiveColor';
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: SAMPLERS.map((n) => `var ${n}Sampler: sampler;\nvar ${n}: texture_2d<f32>;`).join('\n') + FUNCS_WGSL,
        CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
#ifdef KCHAR
  ${target} = vec4f(kToonChar(${albedo}, normalW, viewDirectionW, shadow, ${emis}, fragmentInputs.vPositionW), ${target}.a);
#else
#ifdef KTOON
  ${target} = vec4f(kToon(${albedo}, normalW, viewDirectionW, shadow, ${emis}, fragmentInputs.vPositionW), ${target}.a);
#endif
#endif
#ifdef KFOG
  ${target} = vec4f(kFog(${target}.rgb, fragmentInputs.vPositionW, scene.vEyePosition.xyz), ${target}.a);
#endif
`,
      };
    }
    const target = pbr ? 'finalColor' : 'color';
    const albedo = pbr ? 'baseColor' : 'baseColor.rgb * diffuseColor';
    const emis = pbr ? 'finalEmissive' : 'emissiveColor';
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: SAMPLERS.map((n) => `uniform sampler2D ${n};`).join('\n') + FUNCS_GLSL + FOG_GLSL_BODY,
      CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
#ifdef KCHAR
  ${target}.rgb = kToonChar(${albedo}, normalW, viewDirectionW, shadow, ${emis}, vPositionW);
#else
#ifdef KTOON
  ${target}.rgb = kToon(${albedo}, normalW, viewDirectionW, shadow, ${emis}, vPositionW);
#endif
#endif
#ifdef KFOG
  ${target}.rgb = kFog(${target}.rgb, vPositionW, vEyePosition.xyz);
#endif
`,
    };
  }
}

let registered = false;

/** Attach the toon plugin to every PBR / Standard material created from now on. */
export function registerToon() {
  if (registered) return;
  registered = true;
  RegisterMaterialPlugin('KeliaToon', (material) => (material instanceof PBRMaterial || material instanceof StandardMaterial ? new ToonPlugin(material) : null));
}

/** The toon plugin of a material, if it has one. */
export function toonOf(material: Material | null | undefined): ToonPlugin | null {
  return (material?.pluginManager?.getPlugin('KeliaToon') as ToonPlugin | null) ?? null;
}

/** Set the look of a material (no-op for materials without the plugin). */
export function setToon(material: Material | null | undefined, o: ToonOptions) {
  toonOf(material)?.set(o);
}
