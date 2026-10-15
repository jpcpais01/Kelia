// A small helper for writing Babylon material plugins that work on both
// WebGPU (WGSL) and WebGL2 (GLSL). We use it to add wind to foliage and
// splat texturing to terrain while keeping PBR lighting, IBL, shadows and fog.
import {
  MaterialPluginBase,
  ShaderLanguage,
  type AbstractEngine,
  type BaseTexture,
  type Material,
  type Scene,
  type SubMesh,
  type UniformBuffer,
} from '@babylonjs/core';

export interface PluginCode {
  vertex?: Record<string, string>;
  fragment?: Record<string, string>;
}

export interface PluginSpec {
  name: string;
  priority?: number;
  /** Uniforms in the material UBO, e.g. { windParams: 'vec4' }. */
  uniforms?: Record<string, 'float' | 'vec2' | 'vec3' | 'vec4'>;
  /** Texture samplers (2D). */
  samplers?: string[];
  glsl: PluginCode;
  wgsl: PluginCode;
  /** Extra attributes (e.g. per-instance data) the vertex shader reads. */
  attributes?: string[];
  defines?: Record<string, boolean | number>;
}

const SIZES = { float: 1, vec2: 2, vec3: 3, vec4: 4 } as const;

export interface ShaderPlugin extends MaterialPluginBase {
  readonly values: Record<string, number | number[]>;
  readonly textures: Record<string, BaseTexture | null>;
}

/**
 * Creates a plugin instance. (A class per spec, because Babylon queries the
 * plugin's code from inside the base constructor, before fields exist.)
 */
export function createShaderPlugin(material: Material, spec: PluginSpec): ShaderPlugin {
  const values: Record<string, number | number[]> = {};
  const textures: Record<string, BaseTexture | null> = {};
  for (const [k, t] of Object.entries(spec.uniforms ?? {})) values[k] = t === 'float' ? 0 : new Array(SIZES[t]).fill(0);
  for (const sname of spec.samplers ?? []) textures[sname] = null;

  class Plugin extends MaterialPluginBase {
  readonly values = values;
  readonly textures = textures;

  constructor(material: Material) {
    super(material, spec.name, spec.priority ?? 200, spec.defines ? { ...spec.defines } : {});
    this._enable(true);
  }

  isCompatible(lang: ShaderLanguage) {
    return lang === ShaderLanguage.GLSL || lang === ShaderLanguage.WGSL;
  }

  getClassName() {
    return 'KeliaShaderPlugin';
  }

  prepareDefines(defines: Record<string, unknown>) {
    for (const [k, v] of Object.entries(spec.defines ?? {})) defines[k] = v;
  }

  getAttributes(attributes: string[]) {
    for (const a of spec.attributes ?? []) if (!attributes.includes(a)) attributes.push(a);
  }

  getSamplers(samplers: string[]) {
    for (const s of spec.samplers ?? []) samplers.push(s);
  }

  getUniforms(lang?: ShaderLanguage) {
    const entries = Object.entries(spec.uniforms ?? {});
    const ubo = entries.map(([name, t]) => ({ name, size: SIZES[t], type: t }));
    const decl =
      lang === ShaderLanguage.WGSL
        ? entries.map(([n, t]) => `uniform ${n}: ${t === 'float' ? 'f32' : t + 'f'};`).join('\n')
        : entries.map(([n, t]) => `uniform ${t} ${n};`).join('\n');
    return { ubo, vertex: decl, fragment: decl };
  }

  bindForSubMesh(ubo: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh) {
    for (const [k, v] of Object.entries(this.values)) {
      if (typeof v === 'number') ubo.updateFloat(k, v);
      else if (v.length === 2) ubo.updateFloat2(k, v[0], v[1]);
      else if (v.length === 3) ubo.updateFloat3(k, v[0], v[1], v[2]);
      else ubo.updateFloat4(k, v[0], v[1], v[2], v[3]);
    }
    for (const [k, t] of Object.entries(this.textures)) if (t) ubo.setTexture(k, t);
  }

  getCustomCode(shaderType: string, lang?: ShaderLanguage) {
    const code = lang === ShaderLanguage.WGSL ? spec.wgsl : spec.glsl;
    const block = shaderType === 'vertex' ? code.vertex : code.fragment;
    if (!block) return null;
    const out: Record<string, string> = { ...block };
    // Texture declarations differ per language.
    if (spec.samplers?.length) {
      const decl =
        lang === ShaderLanguage.WGSL
          ? spec.samplers.map((s) => `var ${s}Sampler: sampler;\nvar ${s}: texture_2d<f32>;`).join('\n')
          : spec.samplers.map((s) => `uniform sampler2D ${s};`).join('\n');
      const key = shaderType === 'vertex' ? 'CUSTOM_VERTEX_DEFINITIONS' : 'CUSTOM_FRAGMENT_DEFINITIONS';
      out[key] = decl + '\n' + (out[key] ?? '');
    }
    return out;
  }
}
  return new Plugin(material);
}
