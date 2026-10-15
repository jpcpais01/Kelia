// Recolours skin, hair and eyes on the KayKit atlas in the shader, keeping
// the painted gradient of each swatch. One plugin per character material.
import { Color3, type Material } from '@babylonjs/core';
import { createShaderPlugin, type ShaderPlugin } from '../world/shaderPlugin';
import type { SwatchRefs } from './library';

const GLSL = /* glsl */ `
  {
    vec2 kc = floor(vec2(vMainUV1.x * 8.0, vMainUV1.y * 4.0));
    float kl = dot(surfaceAlbedo, vec3(0.2126, 0.7152, 0.0722));
    if (kc.y < 0.5) {
      if (kc.x < 0.5) surfaceAlbedo = rcSkin.rgb * clamp(kl / rcRefs.x, 0.45, 1.6);
      else if (kc.x < 1.5) surfaceAlbedo = rcHair.rgb * clamp(kl / rcRefs.y, 0.35, 1.8);
      else if (kc.x < 2.5) surfaceAlbedo = mix(surfaceAlbedo, rcEye.rgb * (0.35 + 5.0 * kl), rcEye.a);
    }
    surfaceAlbedo = mix(surfaceAlbedo, surfaceAlbedo * rcTint.rgb, rcTint.a);
  }
`;

const WGSL = /* wgsl */ `
  {
    let kc = floor(vec2f(fragmentInputs.vMainUV1.x * 8.0, fragmentInputs.vMainUV1.y * 4.0));
    let kl = dot(surfaceAlbedo, vec3f(0.2126, 0.7152, 0.0722));
    if (kc.y < 0.5) {
      if (kc.x < 0.5) { surfaceAlbedo = uniforms.rcSkin.rgb * clamp(kl / uniforms.rcRefs.x, 0.45, 1.6); }
      else if (kc.x < 1.5) { surfaceAlbedo = uniforms.rcHair.rgb * clamp(kl / uniforms.rcRefs.y, 0.35, 1.8); }
      else if (kc.x < 2.5) { surfaceAlbedo = mix(surfaceAlbedo, uniforms.rcEye.rgb * (0.35 + 5.0 * kl), uniforms.rcEye.a); }
    }
    surfaceAlbedo = mix(surfaceAlbedo, surfaceAlbedo * uniforms.rcTint.rgb, uniforms.rcTint.a);
  }
`;

export interface RecolorPlugin {
  plugin: ShaderPlugin;
  set(skin: string, hair: string, eye: string): void;
}

const lin = (hex: string) => {
  const c = Color3.FromHexString(hex).toLinearSpace();
  return [c.r, c.g, c.b];
};

export function addRecolor(material: Material, refs: SwatchRefs): RecolorPlugin {
  const plugin = createShaderPlugin(material, {
    name: 'Recolor',
    uniforms: { rcSkin: 'vec4', rcHair: 'vec4', rcEye: 'vec4', rcRefs: 'vec4', rcTint: 'vec4' },
    glsl: { fragment: { CUSTOM_FRAGMENT_BEFORE_LIGHTS: GLSL } },
    wgsl: { fragment: { CUSTOM_FRAGMENT_BEFORE_LIGHTS: WGSL } },
  });
  plugin.values.rcRefs = [refs.skin, refs.hair, refs.eye, 0];
  plugin.values.rcTint = [1, 1, 1, 0];
  return {
    plugin,
    set(skin, hair, eye) {
      // Skin swatches are bright; normalise so the tone reads at the same value.
      plugin.values.rcSkin = [...lin(skin), 1];
      plugin.values.rcHair = [...lin(hair), 1];
      plugin.values.rcEye = [...lin(eye), 0.85];
    },
  };
}
