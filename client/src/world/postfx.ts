// Post-processing: ACES tone mapping and colour grading, bloom, SSAO, depth of
// field, light shafts, vignette and a touch of film grain.
import {
  Color4,
  DefaultRenderingPipeline,
  DepthOfFieldEffectBlurLevel,
  ImageProcessingConfiguration,
  SSAO2RenderingPipeline,
  Texture,
  VolumetricLightScatteringPostProcess,
  type Camera,
  type Mesh,
  type Scene,
} from '@babylonjs/core';
import type { QualitySettings } from '../core/quality';

export class PostFX {
  pipeline: DefaultRenderingPipeline | null = null;
  ssao: SSAO2RenderingPipeline | null = null;
  shafts: VolumetricLightScatteringPostProcess | null = null;
  private dofWanted = false;
  /** 0..1 strength of the light shafts (driven by sun visibility). */
  shaftStrength = 1;

  constructor(private scene: Scene, private camera: Camera, private sunMesh: Mesh) {}

  apply(q: QualitySettings) {
    this.dispose();
    const scene = this.scene;
    const p = new DefaultRenderingPipeline('kelia', true, scene, [this.camera]);
    p.samples = q.msaa;
    p.fxaaEnabled = q.fxaa;
    p.imageProcessingEnabled = true;
    const ip = p.imageProcessing;
    ip.toneMappingEnabled = true;
    ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    ip.contrast = 1.12;
    ip.exposure = 1;
    ip.vignetteEnabled = true;
    ip.vignetteWeight = 1.4;
    ip.vignetteStretch = 0.2;
    ip.vignetteColor = new Color4(0.02, 0.02, 0.05, 0);
    ip.vignetteBlendMode = ImageProcessingConfiguration.VIGNETTEMODE_MULTIPLY;
    ip.colorCurvesEnabled = true;
    const curves = ip.colorCurves!;
    curves.globalSaturation = 6;
    curves.shadowsHue = 220;
    curves.shadowsDensity = 18;
    curves.shadowsSaturation = 25;
    curves.highlightsHue = 40;
    curves.highlightsDensity = 12;
    curves.highlightsSaturation = 20;
    p.bloomEnabled = q.bloom;
    p.bloomThreshold = 0.82;
    p.bloomWeight = 0.42;
    p.bloomKernel = 72;
    p.bloomScale = 0.5;
    p.sharpenEnabled = q.renderScale < 1;
    if (p.sharpenEnabled) p.sharpen.edgeAmount = 0.25;
    p.grainEnabled = q.level !== 'low';
    p.grain.intensity = 4;
    p.grain.animated = true;
    p.chromaticAberrationEnabled = q.level === 'high' || q.level === 'ultra';
    p.chromaticAberration.aberrationAmount = 12;
    p.chromaticAberration.radialIntensity = 1.4;
    this.pipeline = p;
    this.setDepthOfField(this.dofWanted, q);

    if (q.ssao) {
      try {
        const ssao = new SSAO2RenderingPipeline('ssao', scene, { ssaoRatio: 0.5, blurRatio: 0.5 }, [this.camera], true);
        ssao.radius = 1.6;
        ssao.totalStrength = 1.15;
        ssao.base = 0.12;
        ssao.samples = q.level === 'ultra' ? 16 : 12;
        ssao.maxZ = 120;
        ssao.minZAspect = 0.4;
        ssao.expensiveBlur = q.level === 'ultra';
        this.ssao = ssao;
      } catch (err) {
        console.warn('[postfx] SSAO unavailable', err);
      }
    }
    if (q.lightShafts) {
      const vls = new VolumetricLightScatteringPostProcess('shafts', 0.5, this.camera, this.sunMesh, q.level === 'ultra' ? 90 : 60, Texture.BILINEAR_SAMPLINGMODE, scene.getEngine(), false, scene);
      vls.exposure = 0.12;
      vls.decay = 0.965;
      vls.weight = 0.55;
      vls.density = 0.92;
      this.shafts = vls;
    }
  }

  setDepthOfField(on: boolean, q?: QualitySettings) {
    this.dofWanted = on;
    const p = this.pipeline;
    if (!p) return;
    p.depthOfFieldEnabled = on && (!q || q.dof);
    if (p.depthOfFieldEnabled) {
      p.depthOfFieldBlurLevel = DepthOfFieldEffectBlurLevel.Medium;
      p.depthOfField.fStop = 2.0;
      p.depthOfField.focalLength = 60;
    }
  }

  setFocus(distanceMeters: number, fStop = 2.0) {
    const p = this.pipeline;
    if (!p || !p.depthOfFieldEnabled) return;
    p.depthOfField.focusDistance = distanceMeters * 1000;
    p.depthOfField.fStop = fStop;
  }

  update(exposure: number) {
    if (this.pipeline) this.pipeline.imageProcessing.exposure = exposure;
    if (this.shafts) this.shafts.exposure = 0.13 * this.shaftStrength;
  }

  dispose() {
    this.pipeline?.dispose();
    this.ssao?.dispose();
    this.shafts?.dispose(this.camera);
    this.pipeline = null;
    this.ssao = null;
    this.shafts = null;
  }
}
