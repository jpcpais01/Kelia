// Sun/moon light, cascaded shadows, image-based lighting from HDRIs and fog,
// all driven by the time of day.
import {
  CascadedShadowGenerator,
  Color3,
  DirectionalLight,
  HDRCubeTexture,
  HemisphericLight,
  Scene,
  ShadowGenerator,
  Vector3,
  type Camera,
} from '@babylonjs/core';
import { sunDirection } from '@kelia/shared';
import type { QualitySettings } from '../core/quality';
import { Sky, skyStateAt, type SkyState } from './sky';

type EnvName = 'sky' | 'dawn' | 'sunset' | 'night';

export class Atmosphere {
  readonly sun: DirectionalLight;
  readonly fill: HemisphericLight;
  readonly sky: Sky;
  shadows: CascadedShadowGenerator | null = null;
  readonly sunDir = new Vector3(0, 1, 0);
  readonly moonDir = new Vector3(0, 1, 0);
  readonly state: SkyState;
  /** Visual time of day in [0,1). */
  dayTime = 0.4;
  cloudCover = 0.42;
  private envs = new Map<EnvName, HDRCubeTexture>();
  private currentEnv: EnvName | null = null;
  private time = 0;
  fogScale = 1;
  /** Extra exposure multiplier (UI fades, creator lighting). */
  exposureBias = 1;
  private shadowCasters = new Set<import('@babylonjs/core').AbstractMesh>();

  constructor(private scene: Scene) {
    scene.clearColor.set(0, 0, 0, 1);
    scene.ambientColor = new Color3(0, 0, 0);
    scene.fogMode = Scene.FOGMODE_EXP2;
    this.sky = new Sky(scene);
    this.sun = new DirectionalLight('sun', new Vector3(-0.3, -1, 0.4), scene);
    this.sun.intensity = 3;
    this.sun.shadowMinZ = 1;
    this.sun.shadowMaxZ = 600;
    // A gentle sky/ground bounce so shadowed sides never go flat black.
    this.fill = new HemisphericLight('fill', new Vector3(0, 1, 0), scene);
    this.fill.intensity = 0.12;
    this.fill.specular = Color3.Black();
    this.state = skyStateAt(this.dayTime);
    for (const name of ['sky', 'dawn', 'sunset', 'night'] as EnvName[]) {
      const tex = new HDRCubeTexture(`/assets/env/${name}.hdr`, scene, 128, false, true, false, true);
      tex.level = 1;
      this.envs.set(name, tex);
    }
  }

  applyQuality(q: QualitySettings) {
    if (this.shadows) {
      this.shadows.dispose();
      this.shadows = null;
    }
    if (!q.shadows) return;
    const csm = new CascadedShadowGenerator(q.shadowMapSize, this.sun);
    csm.numCascades = q.shadowCascades;
    csm.shadowMaxZ = q.shadowDistance;
    csm.lambda = 0.82;
    csm.stabilizeCascades = true;
    csm.cascadeBlendPercentage = 0.08;
    csm.bias = 0.0018;
    csm.normalBias = 0.018;
    csm.usePercentageCloserFiltering = true;
    csm.filteringQuality = q.level === 'low' ? ShadowGenerator.QUALITY_LOW : ShadowGenerator.QUALITY_MEDIUM;
    csm.depthClamp = true;
    csm.darkness = 0;
    csm.penumbraDarkness = 0.8;
    csm.transparencyShadow = true;
    for (const m of this.shadowCasters) csm.addShadowCaster(m, false);
    this.shadows = csm;
  }

  addShadowCaster(mesh: import('@babylonjs/core').AbstractMesh, includeDescendants = true) {
    const meshes = includeDescendants ? [mesh, ...mesh.getChildMeshes(false)] : [mesh];
    for (const m of meshes) {
      this.shadowCasters.add(m);
      this.shadows?.addShadowCaster(m, false);
      m.onDisposeObservable.addOnce(() => this.shadowCasters.delete(m));
    }
  }

  removeShadowCaster(mesh: import('@babylonjs/core').AbstractMesh) {
    for (const m of [mesh, ...mesh.getChildMeshes(false)]) {
      this.shadowCasters.delete(m);
      this.shadows?.removeShadowCaster(m, false);
    }
  }

  private envFor(t: number): EnvName {
    if (t < 0.205 || t > 0.81) return 'night';
    if (t < 0.29) return 'dawn';
    if (t > 0.71) return 'sunset';
    return 'sky';
  }

  update(dt: number, camera: Camera) {
    this.time += dt;
    const t = this.dayTime;
    const s = skyStateAt(t, this.state);
    const [sx, sy, sz] = sunDirection(t);
    this.sunDir.set(sx, sy, sz);
    this.moonDir.set(-sx * 0.9, Math.max(0.25, -sy), -sz * 0.9 + 0.2).normalize();

    // The directional light is the sun by day and the moon by night.
    const sunUp = sy > -0.02;
    const lightDir = sunUp ? this.sunDir : this.moonDir;
    // Keep the light from grazing exactly along the ground (harsh shadow acne).
    const ly = Math.max(lightDir.y, 0.12);
    this.sun.direction.set(-lightDir.x, -ly, -lightDir.z).normalize();
    const twilight = Math.min(1, Math.abs(sy) / 0.08);
    this.sun.intensity = s.sunIntensity * (sunUp ? 1 : 0.6) * (0.35 + 0.65 * twilight);
    this.sun.diffuse.copyFrom(s.sun);
    this.sun.specular.copyFrom(s.sun);
    this.fill.diffuse.copyFrom(s.zenith).scaleInPlace(1.5);
    this.fill.groundColor.copyFrom(s.fog).scaleInPlace(0.5);

    const env = this.envFor(t);
    if (env !== this.currentEnv) {
      const tex = this.envs.get(env)!;
      if (tex.isReady() || !this.currentEnv) {
        this.scene.environmentTexture = tex;
        this.currentEnv = env;
      }
    }
    this.scene.environmentIntensity = s.ambient;
    this.scene.fogColor.copyFrom(s.fog);
    this.scene.fogDensity = s.fogDensity * this.fogScale;
    this.sky.update(s, this.sunDir, this.moonDir, this.time, this.cloudCover, camera.globalPosition);
  }

  get exposure() {
    return this.state.exposure * this.exposureBias;
  }
}
