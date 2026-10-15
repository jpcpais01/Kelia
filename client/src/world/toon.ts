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

const UNIFORMS = ['toonSunDir', 'toonSun', 'toonSky', 'toonGround', 'toonShade', 'toonFog', 'toonFog2', 'toonFogSun', 'toonFogDir'] as const;
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
};

const FUNCS_GLSL = /* glsl */ `
vec3 kToon(vec3 albedo, vec3 N, vec3 V, float sh, vec3 emis) {
  vec3 L = toonSunDir.xyz;
  float ndl = dot(N, L);
  float soft = toonShade.w;
  float lit = smoothstep(-soft, soft, ndl) * mix(1.0, sh, toonSunDir.w);
  float up = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 amb = mix(toonGround.rgb, toonSky.rgb, up);
  vec3 dark = amb * toonShade.rgb;
  vec3 light = dark + toonSun.rgb * lit * (1.0 + 0.12 * smoothstep(0.5, 0.7, ndl));
  vec3 col = albedo * light;
  float nv = clamp(dot(N, V), 0.0, 1.0);
  float rim = smoothstep(0.6, 0.95, 1.0 - nv) * toonSky.w * toonMat.y;
  col += rim * (amb * 0.55 + toonSun.rgb * 0.3 * lit) * (0.3 + albedo);
  float tr = pow(clamp(dot(-V, L), 0.0, 1.0), 5.0) * toonMat.x * (0.3 + 0.7 * sh);
  col += albedo * toonSun.rgb * tr;
  float sp = smoothstep(0.955, 0.975, dot(N, normalize(L + V))) * toonMat.z * lit;
  col += toonSun.rgb * sp;
  return col + emis;
}
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
fn kToon(albedo: vec3f, N: vec3f, V: vec3f, sh: f32, emis: vec3f) -> vec3f {
  let L = uniforms.toonSunDir.xyz;
  let ndl = dot(N, L);
  let soft = uniforms.toonShade.w;
  let lit = smoothstep(-soft, soft, ndl) * mix(1.0, sh, uniforms.toonSunDir.w);
  let up = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
  let amb = mix(uniforms.toonGround.rgb, uniforms.toonSky.rgb, up);
  let dark = amb * uniforms.toonShade.rgb;
  let light = dark + uniforms.toonSun.rgb * lit * (1.0 + 0.12 * smoothstep(0.5, 0.7, ndl));
  var col = albedo * light;
  let nv = clamp(dot(N, V), 0.0, 1.0);
  let rim = smoothstep(0.6, 0.95, 1.0 - nv) * uniforms.toonSky.w * uniforms.toonMat.y;
  col += rim * (amb * 0.55 + uniforms.toonSun.rgb * 0.3 * lit) * (vec3f(0.3) + albedo);
  let tr = pow(clamp(dot(-V, L), 0.0, 1.0), 5.0) * uniforms.toonMat.x * (0.3 + 0.7 * sh);
  col += albedo * uniforms.toonSun.rgb * tr;
  let sp = smoothstep(0.955, 0.975, dot(N, normalize(L + V))) * uniforms.toonMat.z * lit;
  col += uniforms.toonSun.rgb * sp;
  return col + emis;
}

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
}

export class ToonPlugin extends MaterialPluginBase {
  translucency = 0;
  rim = 1;
  spec = 0;
  lit = true;
  fog = true;

  constructor(material: Material) {
    super(material, 'KeliaToon', 400, { KTOON: false, KFOG: false });
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
    if ((o.lit !== undefined && o.lit !== this.lit) || (o.fog !== undefined && o.fog !== this.fog)) {
      if (o.lit !== undefined) this.lit = o.lit;
      if (o.fog !== undefined) this.fog = o.fog;
      this.markAllDefinesAsDirty();
    }
  }

  prepareDefines(defines: MaterialDefines) {
    const m = this._material as Material & { disableLighting?: boolean; unlit?: boolean };
    const d = defines as unknown as Record<string, boolean>;
    d.KTOON = this.lit && !m.disableLighting && !m.unlit;
    // unlit materials are glows and effects (often additive): fogging them toward the fog colour would make them brighter
    d.KFOG = this.fog && !m.disableLighting;
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
    ubo.updateFloat4('toonMat', this.translucency, this.rim, this.spec, 0);
  }

  getCustomCode(shaderType: string, lang?: ShaderLanguage): Record<string, string> | null {
    if (shaderType !== 'fragment') return null;
    const pbr = this._material instanceof PBRMaterial;
    if (lang === ShaderLanguage.WGSL) {
      const target = pbr ? 'finalColor' : 'color';
      const albedo = pbr ? 'baseColor' : 'baseColor.rgb * diffuseColor';
      const emis = pbr ? 'finalEmissive' : 'emissiveColor';
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: FUNCS_WGSL,
        CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
#ifdef KTOON
  ${target} = vec4f(kToon(${albedo}, normalW, viewDirectionW, shadow, ${emis}), ${target}.a);
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
      CUSTOM_FRAGMENT_DEFINITIONS: FUNCS_GLSL + FOG_GLSL_BODY,
      CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
#ifdef KTOON
  ${target}.rgb = kToon(${albedo}, normalW, viewDirectionW, shadow, ${emis});
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
