// The hero's surface plugin: tells the toon character lighting (world/toon.ts,
// kToonChar) what each fragment is made of, read from where it samples the
// hero's texture: the swatch row (skin, hair, cloth, leather, metal, gold,
// gems) or the painted face, whose eyes are marked in the alpha channel and
// stay bright in any light. Also carries the white hit flash.
import type { Material } from '@babylonjs/core';
import { setToon } from '../../world/toon';
import { createShaderPlugin, type ShaderPlugin } from '../../world/shaderPlugin';

const GLSL = /* glsl */ `
  {
    vec2 hu = vMainUV1;
    float hFace = step(0.5, hu.x);
    vec2 hc = floor(vec2(hu.x * 16.0, (1.0 - hu.y) * 8.0));
    float hRow = mix(hc.y, 0.0, hFace);
    vec4 hRows = vec4(1.0) - step(vec4(0.5), abs(vec4(hRow) - vec4(0.0, 1.0, 5.0, 6.0)));
    float hGem = (1.0 - step(0.5, abs(hRow - 7.0))) * step(3.5, hc.x) * (1.0 - hFace);
    kSurf.x = hRows.x;
    kSurf.y = hRows.y;
    kSurf.z = hRows.z;
    kSurf2.x = hRows.w;
    kSurf.w = hFace * clamp((1.0 - albedoTexture.a) * 2.55, 0.0, 1.0);
    float hPulse = 0.75 + 0.25 * sin(hsFx.x * 2.4);
    kGlow = vec4(surfaceAlbedo * hGem * 0.9 * hPulse + vec3(hsFx.y), hGem * 1.5 + 2.0 * hsFx.y);
  }
`;

const WGSL = /* wgsl */ `
  {
    let hu = fragmentInputs.vMainUV1;
    let hFace = step(0.5, hu.x);
    let hc = floor(vec2f(hu.x * 16.0, (1.0 - hu.y) * 8.0));
    let hRow = mix(hc.y, 0.0, hFace);
    let hRows = vec4f(1.0) - step(vec4f(0.5), abs(vec4f(hRow) - vec4f(0.0, 1.0, 5.0, 6.0)));
    let hGem = (1.0 - step(0.5, abs(hRow - 7.0))) * step(3.5, hc.x) * (1.0 - hFace);
    kSurf.x = hRows.x;
    kSurf.y = hRows.y;
    kSurf.z = hRows.z;
    kSurf2.x = hRows.w;
    kSurf.w = hFace * clamp((1.0 - albedoTexture.a) * 2.55, 0.0, 1.0);
    let hPulse = 0.75 + 0.25 * sin(uniforms.hsFx.x * 2.4);
    kGlow = vec4f(surfaceAlbedo * hGem * 0.9 * hPulse + vec3f(uniforms.hsFx.y), hGem * 1.5 + 2.0 * uniforms.hsFx.y);
  }
`;

export class HeroSurface {
  readonly plugin: ShaderPlugin;
  private fx: number[];

  constructor(material: Material) {
    this.plugin = createShaderPlugin(material, {
      name: 'HeroSurface',
      uniforms: { hsFx: 'vec4' },
      glsl: { fragment: { CUSTOM_FRAGMENT_BEFORE_LIGHTS: GLSL } },
      wgsl: { fragment: { CUSTOM_FRAGMENT_BEFORE_LIGHTS: WGSL } },
    });
    this.fx = this.plugin.values.hsFx as number[];
    setToon(material, { char: true });
  }

  setTime(t: number) {
    this.fx[0] = t % 1000;
  }

  /** White hit flash, 0..1. */
  setFlash(k: number) {
    this.fx[1] = k;
  }
}
