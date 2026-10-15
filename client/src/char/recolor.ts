// The character "surface" plugin: recolours skin, hair and eyes on the KayKit
// atlas in the shader (keeping the painted gradient of each swatch) and tells
// the toon lighting (world/toon.ts, kToonChar) what each fragment is made of:
// skin gets a smooth face normal and a blush, hair a root-to-tip gradient,
// eyes are repainted as anime eyes with catch-lights, atlas cells listed as
// metal or gold get a polished response, bone turns ivory, and glowing gear,
// boss seams and hit flashes add emission. One plugin per character material.
import { Color3, Matrix, Vector3, type Material } from '@babylonjs/core';
import { setToon } from '../world/toon';
import { createShaderPlugin, type ShaderPlugin } from '../world/shaderPlugin';
import type { SwatchRefs } from './library';

/**
 * What the cells of an 8×4 atlas are made of, one bitmask per row (bit n =
 * column n). Cells not listed are cloth or leather and stay matte.
 */
export interface AtlasSurfaces {
  metal: [number, number, number, number];
  gold?: [number, number, number, number];
  gem?: [number, number, number, number];
  bone?: [number, number, number, number];
}

const bits = (...cols: number[]) => cols.reduce((m, c) => m | (1 << c), 0);

export const ATLAS_SURFACES: Record<string, AtlasSurfaces> = {
  knight_texture: { metal: [bits(3, 4, 7), bits(1, 2, 3, 7), bits(0), 0], gold: [0, bits(4), 0, 0] },
  barbarian_texture: { metal: [bits(3, 4), bits(3), bits(0), 0], gold: [0, 0, bits(1), 0] },
  mage_texture: { metal: [bits(3, 4), bits(3, 4), 0, 0], gold: [0, 0, 0, bits(2)], gem: [0, 0, bits(2, 6), 0] },
  rogue_texture: { metal: [bits(3, 4), bits(2, 3, 4), 0, 0], gem: [0, 0, bits(2), 0] },
  skeleton: { metal: [bits(3, 4), bits(3, 4), 0, 0], gem: [0, 0, bits(1), 0], bone: [0, bits(1), 0, 0] },
};

/** Where the eye island sits inside the eye cell, per face (centre and half size in cell units). */
const EYE_BOX: Record<string, [number, number, number, number]> = {
  knight: [0.56, 0.465, 0.075, 0.29],
  barbarian: [0.56, 0.465, 0.075, 0.29],
  rogue: [0.41, 0.335, 0.125, 0.14],
  mage: [0.41, 0.335, 0.125, 0.14],
  hooded: [0.41, 0.335, 0.125, 0.14],
};

const GLSL = /* glsl */ `
  {
    vec2 kuv = vec2(vMainUV1.x * 8.0, vMainUV1.y * 4.0);
    vec2 kc = floor(kuv);
    vec2 kf = kuv - kc;
    vec4 krow = vec4(1.0) - step(vec4(0.5), abs(vec4(kc.y) - vec4(0.0, 1.0, 2.0, 3.0)));
    float kbit = exp2(kc.x);
    float kMetal = mod(floor(dot(rcMetal, krow) / kbit), 2.0);
    float kGold = mod(floor(dot(rcGold, krow) / kbit), 2.0);
    float kGem = mod(floor(dot(rcGem, krow) / kbit), 2.0);
    float kBone = mod(floor(dot(rcBone, krow) / kbit), 2.0);
    float kl = dot(surfaceAlbedo, vec3(0.2126, 0.7152, 0.0722));
    vec3 kD = vPositionW - rcHead.xyz;
    float kR = max(rcHead.w, 0.0001);
    float kDist = length(kD);
    if (kc.y < 0.5 && rcUp.w < 0.5) {
      if (kc.x < 0.5) {
        float g = clamp(kl / rcRefs.x, 0.45, 1.6);
        surfaceAlbedo = mix(rcSkin.rgb, vec3(dot(rcSkin.rgb, vec3(0.3, 0.55, 0.15))), 0.12) * mix(1.0, g, 0.35) * 1.08;
        float kin = 1.0 - smoothstep(kR * 0.95, kR * 1.3, kDist);
        kSurf.x = 1.0;
        kSurf2.w = 0.7 * kin;
        kSurfN.xyz = kD / max(kDist, 0.0001);
        vec3 kRt = cross(rcUp.xyz, rcFwd.xyz);
        vec3 kq = vec3(dot(kD, kRt), dot(kD, rcUp.xyz), dot(kD, rcFwd.xyz)) / kR;
        float bx = abs(kq.x) - rcBlush.x;
        float by = kq.y - rcBlush.y;
        float kb = exp(-(bx * bx * 26.0 + by * by * 70.0)) * smoothstep(0.3, 0.65, kq.z) * kin;
        surfaceAlbedo = mix(surfaceAlbedo, surfaceAlbedo * vec3(1.0, 0.56, 0.58), kb * rcBlush.z);
      } else if (kc.x < 1.5) {
        float g = clamp(kl / rcRefs.y, 0.35, 1.8);
        vec3 kh = rcHair.rgb * mix(1.0, g, 0.55);
        float tip = clamp((kR * 0.55 - dot(kD, rcUp.xyz)) / (kR * 1.8), 0.0, 1.0);
        kh = mix(kh, kh * 1.3 + rcHair.rgb * 0.3 + 0.012, tip * 0.75);
        surfaceAlbedo = kh;
        kSurf.y = 1.0;
      } else if (kc.x < 2.5) {
        vec2 e = (kf - rcEyeBox.xy) / rcEyeBox.zw;
        float inside = (1.0 - step(1.3, max(abs(e.x), abs(e.y)))) * step(0.001, rcEyeBox.z);
        vec3 iris = rcEye.rgb;
        float t = clamp(e.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 ec = mix(iris * 0.28, iris * 1.8 + 0.035, smoothstep(0.1, 0.95, t));
        float pd = length((e - vec2(0.0, 0.08)) * vec2(1.8, 1.3));
        ec = mix(ec, iris * 0.08, (1.0 - smoothstep(0.3, 0.4, pd)) * 0.85);
        ec = mix(ec, vec3(0.012, 0.01, 0.018), 1.0 - smoothstep(-0.8, -0.5, e.y));
        float c1 = 1.0 - smoothstep(0.2, 0.28, length((e - vec2(-0.32, -0.3)) * vec2(1.0, 0.8)));
        float c2 = 1.0 - smoothstep(0.08, 0.13, length(e - vec2(0.34, 0.46)));
        float kcat = max(c1, c2 * 0.8) * inside;
        surfaceAlbedo = mix(mix(surfaceAlbedo, rcEye.rgb * (0.35 + 5.0 * kl), rcEye.a), mix(ec, vec3(1.0), kcat), inside);
        kSurf.w = inside;
        kSurf2.z = kcat * 0.6;
      }
    }
    kSurf.z = kMetal * (1.0 - kGold);
    kSurf2.x = kGold;
    if (kBone > 0.5) {
      surfaceAlbedo = rcSkin.rgb * clamp(kl / rcRefs.x, 0.2, 1.3);
      kSurf2.y = 1.0;
    }
    kRimC = rcRim;
    float kPulse = 0.8 + 0.2 * sin(rcFx.x * 2.6);
    float kFlow = pow(0.5 + 0.5 * sin(vPositionW.y * 14.0 - rcFx.x * 4.5), 6.0);
    vec3 kE = rcGlow.rgb * rcGlow.a * (kGem * 0.5 * kPulse + kMetal * (0.12 + 0.9 * kFlow));
    kE += rcRim.rgb * rcFx.z * (1.0 - smoothstep(rcFx.w * 0.3, rcFx.w, kl)) * (0.65 + 0.35 * sin(rcFx.x * 3.1 + vPositionW.y * 6.0));
    kE += vec3(rcFx.y);
    kGlow = vec4(kE, 1.5 * rcGlow.a * (kMetal + kGem * 2.0) + 2.0 * rcFx.y);
    surfaceAlbedo = mix(surfaceAlbedo, surfaceAlbedo * rcTint.rgb, rcTint.a * (1.0 - kBone));
  }
`;

const WGSL = /* wgsl */ `
  {
    let kuv = vec2f(fragmentInputs.vMainUV1.x * 8.0, fragmentInputs.vMainUV1.y * 4.0);
    let kc = floor(kuv);
    let kf = kuv - kc;
    let krow = vec4f(1.0) - step(vec4f(0.5), abs(vec4f(kc.y) - vec4f(0.0, 1.0, 2.0, 3.0)));
    let kbit = exp2(kc.x);
    let kMetal = floor(dot(uniforms.rcMetal, krow) / kbit) % 2.0;
    let kGold = floor(dot(uniforms.rcGold, krow) / kbit) % 2.0;
    let kGem = floor(dot(uniforms.rcGem, krow) / kbit) % 2.0;
    let kBone = floor(dot(uniforms.rcBone, krow) / kbit) % 2.0;
    let kl = dot(surfaceAlbedo, vec3f(0.2126, 0.7152, 0.0722));
    let kD = fragmentInputs.vPositionW - uniforms.rcHead.xyz;
    let kR = max(uniforms.rcHead.w, 0.0001);
    let kDist = length(kD);
    if (kc.y < 0.5 && uniforms.rcUp.w < 0.5) {
      if (kc.x < 0.5) {
        let g = clamp(kl / uniforms.rcRefs.x, 0.45, 1.6);
        surfaceAlbedo = mix(uniforms.rcSkin.rgb, vec3f(dot(uniforms.rcSkin.rgb, vec3f(0.3, 0.55, 0.15))), 0.12) * mix(1.0, g, 0.35) * 1.08;
        let kin = 1.0 - smoothstep(kR * 0.95, kR * 1.3, kDist);
        kSurf.x = 1.0;
        kSurf2.w = 0.7 * kin;
        kSurfN = vec4f(kD / max(kDist, 0.0001), 0.0);
        let kRt = cross(uniforms.rcUp.xyz, uniforms.rcFwd.xyz);
        let kq = vec3f(dot(kD, kRt), dot(kD, uniforms.rcUp.xyz), dot(kD, uniforms.rcFwd.xyz)) / kR;
        let bx = abs(kq.x) - uniforms.rcBlush.x;
        let by = kq.y - uniforms.rcBlush.y;
        let kb = exp(-(bx * bx * 26.0 + by * by * 70.0)) * smoothstep(0.3, 0.65, kq.z) * kin;
        surfaceAlbedo = mix(surfaceAlbedo, surfaceAlbedo * vec3f(1.0, 0.56, 0.58), kb * uniforms.rcBlush.z);
      } else if (kc.x < 1.5) {
        let g = clamp(kl / uniforms.rcRefs.y, 0.35, 1.8);
        var kh = uniforms.rcHair.rgb * mix(1.0, g, 0.55);
        let tip = clamp((kR * 0.55 - dot(kD, uniforms.rcUp.xyz)) / (kR * 1.8), 0.0, 1.0);
        kh = mix(kh, kh * 1.3 + uniforms.rcHair.rgb * 0.3 + vec3f(0.012), tip * 0.75);
        surfaceAlbedo = kh;
        kSurf.y = 1.0;
      } else if (kc.x < 2.5) {
        let e = (kf - uniforms.rcEyeBox.xy) / uniforms.rcEyeBox.zw;
        let inside = (1.0 - step(1.3, max(abs(e.x), abs(e.y)))) * step(0.001, uniforms.rcEyeBox.z);
        let iris = uniforms.rcEye.rgb;
        let t = clamp(e.y * 0.5 + 0.5, 0.0, 1.0);
        var ec = mix(iris * 0.28, iris * 1.8 + vec3f(0.035), smoothstep(0.1, 0.95, t));
        let pd = length((e - vec2f(0.0, 0.08)) * vec2f(1.8, 1.3));
        ec = mix(ec, iris * 0.08, (1.0 - smoothstep(0.3, 0.4, pd)) * 0.85);
        ec = mix(ec, vec3f(0.012, 0.01, 0.018), 1.0 - smoothstep(-0.8, -0.5, e.y));
        let c1 = 1.0 - smoothstep(0.2, 0.28, length((e - vec2f(-0.32, -0.3)) * vec2f(1.0, 0.8)));
        let c2 = 1.0 - smoothstep(0.08, 0.13, length(e - vec2f(0.34, 0.46)));
        let kcat = max(c1, c2 * 0.8) * inside;
        surfaceAlbedo = mix(mix(surfaceAlbedo, uniforms.rcEye.rgb * (0.35 + 5.0 * kl), uniforms.rcEye.a), mix(ec, vec3f(1.0), kcat), inside);
        kSurf.w = inside;
        kSurf2.z = kcat * 0.6;
      }
    }
    kSurf.z = kMetal * (1.0 - kGold);
    kSurf2.x = kGold;
    if (kBone > 0.5) {
      surfaceAlbedo = uniforms.rcSkin.rgb * clamp(kl / uniforms.rcRefs.x, 0.2, 1.3);
      kSurf2.y = 1.0;
    }
    kRimC = uniforms.rcRim;
    let kPulse = 0.8 + 0.2 * sin(uniforms.rcFx.x * 2.6);
    let kFlow = pow(0.5 + 0.5 * sin(fragmentInputs.vPositionW.y * 14.0 - uniforms.rcFx.x * 4.5), 6.0);
    var kE = uniforms.rcGlow.rgb * uniforms.rcGlow.a * (kGem * 0.5 * kPulse + kMetal * (0.12 + 0.9 * kFlow));
    kE += uniforms.rcRim.rgb * uniforms.rcFx.z * (1.0 - smoothstep(uniforms.rcFx.w * 0.3, uniforms.rcFx.w, kl)) * (0.65 + 0.35 * sin(uniforms.rcFx.x * 3.1 + fragmentInputs.vPositionW.y * 6.0));
    kE += vec3f(uniforms.rcFx.y);
    kGlow = vec4f(kE, 1.5 * uniforms.rcGlow.a * (kMetal + kGem * 2.0) + 2.0 * uniforms.rcFx.y);
    surfaceAlbedo = mix(surfaceAlbedo, surfaceAlbedo * uniforms.rcTint.rgb, uniforms.rcTint.a * (1.0 - kBone));
  }
`;

const lin = (hex: string, out: number[], scale = 1) => {
  const c = Color3.FromHexString(hex).toLinearSpace();
  out[0] = c.r * scale;
  out[1] = c.g * scale;
  out[2] = c.b * scale;
};

const tmpM = new Matrix();
const tmpV = new Vector3();

/** One character material's surface plugin and its live inputs. */
export class RecolorPlugin {
  readonly plugin: ShaderPlugin;
  private v: Record<string, number[]>;

  constructor(material: Material, refs: SwatchRefs, surfaces: AtlasSurfaces | undefined, monster = false) {
    this.plugin = createShaderPlugin(material, {
      name: 'Recolor',
      uniforms: {
        rcSkin: 'vec4', rcHair: 'vec4', rcEye: 'vec4', rcRefs: 'vec4', rcTint: 'vec4',
        rcMetal: 'vec4', rcGold: 'vec4', rcGem: 'vec4', rcBone: 'vec4',
        rcEyeBox: 'vec4', rcHead: 'vec4', rcFwd: 'vec4', rcUp: 'vec4', rcBlush: 'vec4',
        rcGlow: 'vec4', rcRim: 'vec4', rcFx: 'vec4',
      },
      glsl: { fragment: { CUSTOM_FRAGMENT_BEFORE_LIGHTS: GLSL } },
      wgsl: { fragment: { CUSTOM_FRAGMENT_BEFORE_LIGHTS: WGSL } },
    });
    this.v = this.plugin.values as Record<string, number[]>;
    const v = this.v;
    v.rcRefs.splice(0, 4, refs.skin, refs.hair, refs.eye, 0);
    v.rcTint.splice(0, 4, 1, 1, 1, 0);
    const s = surfaces ?? { metal: [0, 0, 0, 0] };
    v.rcMetal.splice(0, 4, ...s.metal);
    if (s.gold) v.rcGold.splice(0, 4, ...s.gold);
    if (s.gem) v.rcGem.splice(0, 4, ...s.gem);
    if (s.bone) v.rcBone.splice(0, 4, ...s.bone);
    v.rcUp.splice(0, 4, 0, 1, 0, monster ? 1 : 0);
    v.rcFwd.splice(0, 4, 0, 0, 1, 0);
    v.rcHead.splice(0, 4, 0, -1000, 0, 0.0001);
    v.rcBlush.splice(0, 4, 0.46, -0.32, 0.55, 0);
    setToon(material, { char: true });
  }

  set(skin: string, hair: string, eye: string) {
    lin(skin, this.v.rcSkin);
    this.v.rcSkin[3] = 1;
    lin(hair, this.v.rcHair);
    this.v.rcHair[3] = 1;
    lin(eye, this.v.rcEye);
    this.v.rcEye[3] = 0.85;
  }

  /** Which face this material carries (positions the painted eyes). */
  setFace(face: string | null) {
    const b = face ? EYE_BOX[face] : null;
    this.v.rcEyeBox.splice(0, 4, ...(b ?? [0, 0, 0, 0]));
  }

  /** Ivory or tinted bone for monsters (uses the skin slot). */
  setBone(hex: string, ref: number) {
    lin(hex, this.v.rcSkin);
    this.v.rcRefs[0] = ref;
  }

  /** Glowing gear: gems glow, metal shimmers with energy (null = none). */
  setGlow(hex: string | null, strength = 1) {
    if (hex) lin(hex, this.v.rcGlow);
    this.v.rcGlow[3] = hex ? strength : 0;
  }

  /** Extra coloured rim (monsters: their eye colour). */
  setRim(hex: string | null, amount = 0.5) {
    if (hex) lin(hex, this.v.rcRim);
    this.v.rcRim[3] = hex ? amount : 0;
  }

  /** Glowing seams in creases darker than `depth` (atlas luminance): eye sockets, joints, armour gaps. */
  setSeams(amount: number, depth = 0.05) {
    this.v.rcFx[2] = amount;
    this.v.rcFx[3] = depth;
  }

  /** Multiply everything but bone by a colour (e.g. blackened armour). */
  setTint(hex: string | null) {
    if (hex) lin(hex, this.v.rcTint);
    this.v.rcTint[3] = hex ? 1 : 0;
  }

  setTime(t: number) {
    this.v.rcFx[0] = t % 1000;
  }

  /** White hit flash, 0..1. */
  setFlash(k: number) {
    this.v.rcFx[1] = k;
  }

  /**
   * Place the head for face shading: `local` is the head centre in the head
   * node's space, `fwd`/`up` the face's forward and up in that space.
   */
  setHead(world: Matrix, local: Vector3, radius: number, fwd: Vector3, up: Vector3) {
    const v = this.v;
    Vector3.TransformCoordinatesToRef(local, world, tmpV);
    v.rcHead[0] = tmpV.x;
    v.rcHead[1] = tmpV.y;
    v.rcHead[2] = tmpV.z;
    v.rcHead[3] = radius;
    Vector3.TransformNormalToRef(fwd, world, tmpV);
    tmpV.normalize();
    v.rcFwd[0] = tmpV.x;
    v.rcFwd[1] = tmpV.y;
    v.rcFwd[2] = tmpV.z;
    Vector3.TransformNormalToRef(up, world, tmpV);
    tmpV.normalize();
    v.rcUp[0] = tmpV.x;
    v.rcUp[1] = tmpV.y;
    v.rcUp[2] = tmpV.z;
  }
}

export function addRecolor(material: Material, refs: SwatchRefs, surfaces?: AtlasSurfaces): RecolorPlugin {
  return new RecolorPlugin(material, refs, surfaces ?? ATLAS_SURFACES[material.name.replace(/^Clone of /, '').replace(/\.\d+$/, '').replace(/_glow$/, '')]);
}

/** Matrix scratch for callers computing head-local vectors. */
export const scratchMatrix = tmpM;
