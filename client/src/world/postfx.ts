// Post-processing: one lean, hand-written chain instead of Babylon's stock
// pipelines. No pass re-renders the scene (the old SSAO, depth-of-field and
// light-shaft effects each drew the whole world again):
//
//   scene (HDR, optional MSAA)
//     -> prefilter  ¼ res: bright parts for bloom + the open-sky mask near the sun
//     -> blur H     ¼ res
//     -> blur V     ¼ res
//     -> sun shafts ¼ res: radial blur of the sky mask (trees and clouds occlude)
//     -> composite  full res: bloom, shafts, portrait focus blur, tone mapping,
//                   anime colour grade, vignette and FXAA, straight to screen.
//
// Eye adaptation runs beside the chain, on the GPU only (no read-back): right
// after the prefilter, the HDR scene is boiled down to a 32×18 grid of log
// luminance, and a single pixel eases toward its centre-weighted average each
// frame. The composite reads that pixel, so walking into a dark forest slowly
// opens the exposure up and stepping back into a sunny meadow or looking at
// the sky closes it down, around the artist-set exposure for the time of day.
//
// The sky writes "how open is the sky" into the scene's alpha channel, which is
// what lets shafts work without a depth or occlusion pass. Exposure and every
// other per-frame value are plain uniforms here, so nothing re-validates
// materials when the time of day changes.
import {
  Constants,
  Effect,
  EffectRenderer,
  EffectWrapper,
  PostProcess,
  type RenderTargetWrapper,
  Texture,
  Vector3,
  Vector4,
  type Camera,
  type Scene,
} from '@babylonjs/core';
import type { QualitySettings } from '../core/quality';

const LUM_W = 32;
const LUM_H = 18;

Effect.ShadersStore['keliaPrefilterFragmentShader'] = /* glsl */ `
precision highp float;
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform vec2 texel;      // scene texel size
uniform vec4 bloomP;     // x = threshold, y = knee, z = clamp
uniform vec4 sunP;       // xy = sun uv, z = aspect, w = sun visible
void main(void) {
  // 4 bilinear taps = a 4×4 box of the full-res scene
  vec4 a = texture2D(textureSampler, vUV + texel * vec2(-1.0, -1.0));
  vec4 b = texture2D(textureSampler, vUV + texel * vec2(1.0, -1.0));
  vec4 c = texture2D(textureSampler, vUV + texel * vec2(-1.0, 1.0));
  vec4 d = texture2D(textureSampler, vUV + texel * vec2(1.0, 1.0));
  vec4 s = (a + b + c + d) * 0.25;
  // Karis average: weight each tap by 1 / (1 + luma) so a single bright
  // sub-pixel (a petal, a blade tip, a water glint) cannot flicker the bloom
  float wa = 1.0 / (1.0 + max(a.r, max(a.g, a.b)));
  float wb = 1.0 / (1.0 + max(b.r, max(b.g, b.b)));
  float wc = 1.0 / (1.0 + max(c.r, max(c.g, c.b)));
  float wd = 1.0 / (1.0 + max(d.r, max(d.g, d.b)));
  vec3 k = (a.rgb * wa + b.rgb * wb + c.rgb * wc + d.rgb * wd) / (wa + wb + wc + wd);
  vec3 col = min(bloomP.x > 0.0 ? k : s.rgb, vec3(bloomP.z));
  float br = max(col.r, max(col.g, col.b));
  float soft = clamp(br - bloomP.x + bloomP.y, 0.0, 2.0 * bloomP.y);
  soft = soft * soft / (4.0 * bloomP.y + 1e-4);
  float contrib = max(soft, br - bloomP.x) / max(br, 1e-4);
  vec3 bloom = col * contrib;
  // open sky (alpha 0 = clear sky, 1 = solid) close to the sun
  vec2 dv = (vUV - sunP.xy) * vec2(sunP.z, 1.0);
  float near = exp(-dot(dv, dv) * 9.0);
  float open = clamp(1.0 - s.a, 0.0, 1.0);
  gl_FragColor = vec4(bloom, open * near * sunP.w);
}
`;

Effect.ShadersStore['keliaBlurFragmentShader'] = /* glsl */ `
precision highp float;
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform vec2 dir; // texel step along the blur axis
void main(void) {
  // 13-tap gaussian folded into 7 bilinear taps
  vec4 s = texture2D(textureSampler, vUV) * 0.1964825501511404;
  s += texture2D(textureSampler, vUV + dir * 1.411764705882353) * 0.2969069646728344;
  s += texture2D(textureSampler, vUV - dir * 1.411764705882353) * 0.2969069646728344;
  s += texture2D(textureSampler, vUV + dir * 3.2941176470588234) * 0.09447039785044732;
  s += texture2D(textureSampler, vUV - dir * 3.2941176470588234) * 0.09447039785044732;
  s += texture2D(textureSampler, vUV + dir * 5.176470588235294) * 0.010381362401148057;
  s += texture2D(textureSampler, vUV - dir * 5.176470588235294) * 0.010381362401148057;
  gl_FragColor = s;
}
`;

Effect.ShadersStore['keliaShaftsFragmentShader'] = /* glsl */ `
precision highp float;
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform vec4 sunP; // xy = sun uv, z = aspect, w = strength
void main(void) {
  vec4 here = texture2D(textureSampler, vUV);
  float shaft = 0.0;
  if (sunP.w > 0.001) {
    vec2 delta = (vUV - sunP.xy) * (0.9 / 24.0);
    vec2 p = vUV;
    float decay = 1.0;
    for (int i = 0; i < 24; i++) {
      p -= delta;
      shaft += texture2D(textureSampler, p).a * decay;
      decay *= 0.955;
    }
    shaft *= sunP.w / 12.0;
  }
  gl_FragColor = vec4(here.rgb, shaft);
}
`;

Effect.ShadersStore['keliaCompositeFragmentShader'] = /* glsl */ `
precision highp float;
varying vec2 vUV;
uniform sampler2D textureSampler; // ¼ res: rgb = blurred bloom, a = shafts
uniform sampler2D sceneSampler;   // full res HDR scene
uniform vec2 sceneTexel;
uniform vec2 bloomTexel;
uniform vec4 grade;      // x = exposure, y = saturation, z = contrast, w = vignette
uniform vec4 bloomC;     // rgb = bloom tint, w = bloom strength
uniform vec4 shaftC;     // rgb = shaft colour × strength
uniform vec4 focus;      // xy = focus uv, z = radius, w = amount (0 = off)
uniform vec4 tintShadow; // rgb = shadow lift tint
uniform vec4 tintLight;  // rgb = highlight tint
uniform sampler2D adaptSampler; // 1×1: r = adapted log2 luminance of the scene
uniform vec4 autoExp;    // x = target log2 luminance, y = strength, z = min / w = max log2 change

vec3 neutralTonemap(vec3 color) {
  const float start = 0.76;
  const float desat = 0.12;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < start) return color;
  float d = 1.0 - start;
  float newPeak = 1.0 - d * d / (peak + d - start);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (desat * (peak - newPeak) + 1.0);
  return mix(color, vec3(newPeak), g);
}

float lumaOf(vec3 c) {
  float l = dot(c, vec3(0.299, 0.587, 0.114)) * grade.x;
  return l / (1.0 + l);
}

vec3 sceneAt(vec2 uv) { return texture2D(sceneSampler, uv).rgb; }

void main(void) {
  vec3 col = sceneAt(vUV);
#ifdef FXAA
  {
    vec3 nw = sceneAt(vUV + vec2(-1.0, -1.0) * sceneTexel);
    vec3 ne = sceneAt(vUV + vec2(1.0, -1.0) * sceneTexel);
    vec3 sw = sceneAt(vUV + vec2(-1.0, 1.0) * sceneTexel);
    vec3 se = sceneAt(vUV + vec2(1.0, 1.0) * sceneTexel);
    float lNW = lumaOf(nw), lNE = lumaOf(ne), lSW = lumaOf(sw), lSE = lumaOf(se), lM = lumaOf(col);
    float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
    float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
    if (lMax - lMin > max(0.04, lMax * 0.12)) {
      vec2 dirv = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
      float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
      float rcpMin = 1.0 / (min(abs(dirv.x), abs(dirv.y)) + reduce);
      dirv = clamp(dirv * rcpMin, vec2(-8.0), vec2(8.0)) * sceneTexel;
      vec3 a = 0.5 * (sceneAt(vUV + dirv * (1.0 / 3.0 - 0.5)) + sceneAt(vUV + dirv * (2.0 / 3.0 - 0.5)));
      vec3 b = a * 0.5 + 0.25 * (sceneAt(vUV - dirv * 0.5) + sceneAt(vUV + dirv * 0.5));
      float lB = lumaOf(b);
      col = (lB < lMin || lB > lMax) ? a : b;
    }
  }
#endif
  // wide, soft bloom: the ¼-res blur sampled with a small cross for extra spread
  vec4 q = texture2D(textureSampler, vUV);
  vec3 blur = q.rgb * 0.4
    + texture2D(textureSampler, vUV + vec2(2.5, 0.0) * bloomTexel).rgb * 0.15
    + texture2D(textureSampler, vUV - vec2(2.5, 0.0) * bloomTexel).rgb * 0.15
    + texture2D(textureSampler, vUV + vec2(0.0, 2.5) * bloomTexel).rgb * 0.15
    + texture2D(textureSampler, vUV - vec2(0.0, 2.5) * bloomTexel).rgb * 0.15;
  if (focus.w > 0.0) {
    // portrait focus (character creator): the blur buffer holds the whole scene
    vec2 dv = (vUV - focus.xy) * vec2(sceneTexel.y / sceneTexel.x, 1.0);
    float m = smoothstep(focus.z, focus.z * 2.4, length(dv)) * focus.w;
    col = mix(col, blur, m);
    blur = max(blur - vec3(1.1), vec3(0.0)) * 0.6;
  }
  col += blur * bloomC.rgb * bloomC.w;
  col += shaftC.rgb * q.a;

  // eye adaptation: pull the exposed scene's average toward the target, partly
  float la = texture2D(adaptSampler, vec2(0.5)).r + log2(grade.x);
  col *= grade.x * exp2(clamp((autoExp.x - la) * autoExp.y, autoExp.z, autoExp.w));
  col = neutralTonemap(col);
  // anime grade: richer colour, cool lifted shadows, warm highlights
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, grade.y);
  col = max(col, 0.0);
  col += tintShadow.rgb * (1.0 - smoothstep(0.0, 0.45, l));
  col *= mix(vec3(1.0), tintLight.rgb, smoothstep(0.35, 1.0, l));
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  col = (col - 0.5) * grade.z + 0.5;
  vec2 vv = vUV - 0.5;
  col *= 1.0 - dot(vv, vv) * grade.w;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

Effect.ShadersStore['keliaLumFragmentShader'] = /* glsl */ `
precision highp float;
varying vec2 vUV;
uniform sampler2D textureSampler; // full res HDR scene
uniform vec2 span;                // one luminance cell, in uv
void main(void) {
  // 9 bilinear taps over the cell
  vec3 c = vec3(0.0);
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) c += texture2D(textureSampler, vUV + vec2(float(i), float(j)) * span * 0.33).rgb;
  float l = dot(c / 9.0, vec3(0.2126, 0.7152, 0.0722));
  // the sun disc and glints must not dominate the average
  gl_FragColor = vec4(log2(clamp(l, 0.002, 12.0)), 0.0, 0.0, 1.0);
}
`;

Effect.ShadersStore['keliaAdaptFragmentShader'] = /* glsl */ `
precision highp float;
varying vec2 vUV;
uniform sampler2D lumSampler;   // ${LUM_W}×${LUM_H} log luminance
uniform sampler2D prevSampler;  // 1×1 adapted value from last frame
uniform vec4 adaptP;            // x = blend toward the new value (0..1), y = 1 to snap
void main(void) {
  float s = 0.0;
  float w = 0.0;
  for (int j = 0; j < ${LUM_H}; j++) {
    for (int i = 0; i < ${LUM_W}; i++) {
      vec2 d = (vec2(float(i), float(j)) + 0.5) / vec2(${LUM_W}.0, ${LUM_H}.0) - 0.5;
      // what you look at counts most
      float k = exp(-dot(d * vec2(1.6, 2.0), d * vec2(1.6, 2.0)) * 3.0);
      s += texelFetch(lumSampler, ivec2(i, j), 0).r * k;
      w += k;
    }
  }
  float target = s / w;
  float prev = texelFetch(prevSampler, ivec2(0, 0), 0).r;
  gl_FragColor = vec4(adaptP.y > 0.5 ? target : mix(prev, target, adaptP.x), 0.0, 0.0, 1.0);
}
`;

const HALF = Constants.TEXTURETYPE_HALF_FLOAT;
const tmpV = new Vector3();

export class PostFX {
  private passes: PostProcess[] = [];
  private dofWanted = false;
  /** 0..1 strength of the light shafts (driven by sun visibility). */
  shaftStrength = 1;
  exposure = 1;
  /** Warm/cool shaft colour, set from the sky each frame. */
  readonly shaftColor = new Vector3(1, 0.85, 0.6);
  /** Where the sun (or moon) is, for the shafts. */
  readonly sunDir = new Vector3(0, 1, 0);
  private sunUv = new Vector4(0.5, 0.5, 1, 0);
  private focusV = new Vector4(0.5, 0.5, 0.2, 0);
  private focusWorld: Vector3 | null = null;
  private focusRadius = 0.2;
  /** Target exposed log2 luminance (from the time of day) and how much of the gap adaptation closes. */
  autoKey = -1.55;
  autoStrength = 0.55;
  private adapt: AutoExposure;

  constructor(private scene: Scene, private camera: Camera) {
    this.adapt = new AutoExposure(scene);
  }

  apply(q: QualitySettings) {
    this.dispose();
    const engine = this.scene.getEngine();
    const cam = this.camera;
    const BL = Texture.BILINEAR_SAMPLINGMODE;

    const pre = new PostProcess('bloomPrefilter', 'keliaPrefilter', ['texel', 'bloomP', 'sunP'], null, 1, cam, BL, engine, false, null, HALF);
    pre.samples = Math.max(1, q.msaa);
    // eye adaptation measures the HDR scene right after the prefilter has used it
    pre.onAfterRenderObservable.add(() => this.adapt.run(pre));
    pre.onApply = (e) => {
      e.setFloat2('texel', 1 / pre.width, 1 / pre.height);
      // creator portrait mode blurs the whole scene; otherwise only bright parts bloom
      if (this.dofWanted) e.setFloat4('bloomP', 0, 0.001, 8, 0);
      else e.setFloat4('bloomP', 0.9, 0.45, 12, 0);
      e.setVector4('sunP', this.sunUv);
    };
    const blurH = new PostProcess('bloomBlurH', 'keliaBlur', ['dir'], null, 0.25, cam, BL, engine, false, null, HALF);
    blurH.onApply = (e) => e.setFloat2('dir', 1 / blurH.width, 0);
    const blurV = new PostProcess('bloomBlurV', 'keliaBlur', ['dir'], null, 0.25, cam, BL, engine, false, null, HALF);
    blurV.onApply = (e) => e.setFloat2('dir', 0, 1 / blurV.height);
    this.passes.push(pre, blurH, blurV);
    if (q.sunShafts) {
      const sh = new PostProcess('sunShafts', 'keliaShafts', ['sunP'], null, 0.25, cam, BL, engine, false, null, HALF);
      sh.onApply = (e) => e.setFloat4('sunP', this.sunUv.x, this.sunUv.y, this.sunUv.z, this.sunUv.w * this.shaftStrength);
      this.passes.push(sh);
    }
    const comp = new PostProcess(
      'gradeComposite',
      'keliaComposite',
      ['sceneTexel', 'bloomTexel', 'grade', 'bloomC', 'shaftC', 'focus', 'tintShadow', 'tintLight', 'autoExp'],
      ['sceneSampler', 'adaptSampler'],
      0.25,
      cam,
      BL,
      engine,
      false,
      q.fxaa ? '#define FXAA' : null,
      Constants.TEXTURETYPE_UNSIGNED_BYTE,
    );
    comp.onApply = (e) => {
      e.setTextureFromPostProcess('sceneSampler', pre);
      e.setFloat2('sceneTexel', 1 / pre.width, 1 / pre.height);
      e.setFloat2('bloomTexel', 1 / comp.width, 1 / comp.height);
      e.setFloat4('grade', this.exposure, 1.14, 1.04, 0.32);
      e.setFloat4('bloomC', 1.0, 0.96, 0.92, q.bloom ? 0.55 : 0);
      e.setFloat4('shaftC', this.shaftColor.x, this.shaftColor.y, this.shaftColor.z, 0);
      e.setVector4('focus', this.focusV);
      e.setFloat4('tintShadow', 0.006, 0.01, 0.028, 0);
      e.setFloat4('tintLight', 1.03, 1.0, 0.95, 0);
      const live = this.adapt.bind(e, 'adaptSampler') && !this.dofWanted;
      // brighten by up to ~1.5×, darken by up to ~0.7×
      e.setFloat4('autoExp', this.autoKey, live ? this.autoStrength : 0, -0.5, 0.6);
    };
    this.passes.push(comp);
  }

  /** Portrait-style background blur (character creator). */
  setDepthOfField(on: boolean, _q?: QualitySettings) {
    this.dofWanted = on;
    if (!on) this.focusV.w = 0;
  }

  /** Keep this world point sharp; the screen blurs away from it. */
  setFocus(point: Vector3, radius = 0.2) {
    this.focusWorld = point;
    this.focusRadius = radius;
  }

  update(exposure: number) {
    this.exposure = exposure;
    const cam = this.camera;
    const scene = this.scene;
    const vp = cam.getTransformationMatrix();
    // sun position on screen
    const fwd = cam.getDirection(Vector3.Forward());
    const facing = Vector3.Dot(fwd, this.sunDir);
    if (facing > 0.05) {
      tmpV.copyFrom(cam.globalPosition).addInPlace(this.sunDir.scale(1000));
      const p = Vector3.TransformCoordinates(tmpV, vp);
      const aspect = scene.getEngine().getAspectRatio(cam);
      // fade as the sun leaves the screen
      const off = Math.max(Math.abs(p.x), Math.abs(p.y));
      const vis = Math.min(1, facing * 3) * (1 - Math.min(1, Math.max(0, (off - 1) / 0.6)));
      this.sunUv.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5, aspect, vis);
    } else this.sunUv.w = 0;
    if (this.dofWanted && this.focusWorld) {
      const p = Vector3.TransformCoordinates(this.focusWorld, vp);
      this.focusV.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5, this.focusRadius, 0.85);
    } else this.focusV.w = 0;
  }

  dispose() {
    for (const p of this.passes) p.dispose(this.camera);
    this.passes = [];
  }
}

/** The GPU-side luminance measure and the adapted value (ping-pong 1×1 targets). */
class AutoExposure {
  private renderer: EffectRenderer;
  private lumFx: EffectWrapper;
  private adaptFx: EffectWrapper;
  private lum: RenderTargetWrapper;
  private px: RenderTargetWrapper[];
  private cur = 0;
  private frames = 0;
  private last = 0;
  private source: PostProcess | null = null;

  constructor(private scene: Scene) {
    const engine = scene.getEngine();
    this.renderer = new EffectRenderer(engine);
    const opts = { generateMipMaps: false, generateDepthBuffer: false, generateStencilBuffer: false, type: HALF, samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE };
    this.lum = engine.createRenderTargetTexture({ width: LUM_W, height: LUM_H }, opts);
    this.px = [engine.createRenderTargetTexture({ width: 1, height: 1 }, opts), engine.createRenderTargetTexture({ width: 1, height: 1 }, opts)];
    this.lumFx = new EffectWrapper({ engine, name: 'keliaLum', fragmentShader: 'keliaLum', useShaderStore: true, uniformNames: ['span'], samplerNames: ['textureSampler'] });
    this.adaptFx = new EffectWrapper({ engine, name: 'keliaAdapt', fragmentShader: 'keliaAdapt', useShaderStore: true, uniformNames: ['adaptP'], samplerNames: ['lumSampler', 'prevSampler'] });
    this.lumFx.onApplyObservable.add(() => {
      const e = this.lumFx.effect;
      if (this.source) e.setTextureFromPostProcess('textureSampler', this.source);
      e.setFloat2('span', 1 / LUM_W, 1 / LUM_H);
    });
    this.adaptFx.onApplyObservable.add(() => {
      const e = this.adaptFx.effect;
      e._bindTexture('lumSampler', this.lum.texture);
      e._bindTexture('prevSampler', this.px[1 - this.cur].texture);
      const dt = Math.min(0.25, Math.max(0, this.scene.getEngine().getDeltaTime() / 1000));
      // eyes open up to the dark more slowly than they close down to the light
      e.setFloat4('adaptP', 1 - Math.exp(-dt * 1.4), this.frames < 3 ? 1 : 0, 0, 0);
    });
  }

  /** Measure the scene `pp` holds and step the adaptation. */
  run(pp: PostProcess) {
    if (!this.lumFx.isReady() || !this.adaptFx.isReady()) return;
    // once per frame, even if the chain renders twice
    const id = this.scene.getFrameId();
    if (id === this.last) return;
    this.last = id;
    this.source = pp;
    this.cur = 1 - this.cur;
    this.renderer.render(this.lumFx, this.lum);
    this.renderer.render(this.adaptFx, this.px[this.cur]);
    this.frames++;
  }

  /** Bind the adapted value; false until it holds a real measurement. */
  bind(e: Effect, name: string) {
    e._bindTexture(name, this.px[this.cur].texture);
    return this.frames >= 3;
  }
}
