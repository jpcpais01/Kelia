// Assembles the 3D world: scene, camera, sky & lighting, terrain, water,
// vegetation, props and ambient life.
import { Color4, Scene, UniversalCamera, Vector3, type AbstractEngine } from '@babylonjs/core';
import { refreshStatics } from './frozen';
import { perf } from '../core/perf';
import type { QualitySettings } from '../core/quality';
import { Atmosphere } from './atmosphere';
import { PostFX } from './postfx';
import { Props } from './props';
import { Ambient } from './ambient';
import { Secrets } from './secrets';
import { Foliage } from './foliage';
import { Grass } from './grass';
import { Terrain } from './terrain';
import { Water } from './water';
import type { TerrainData } from './terrainData';
import { registerToon } from './toon';
import { setOutlines } from '../char/style';

export class World {
  readonly scene: Scene;
  readonly camera: UniversalCamera;
  readonly atmosphere: Atmosphere;
  readonly terrain: Terrain;
  readonly postfx: PostFX;
  readonly water: Water;
  readonly grass: Grass;
  readonly foliage: Foliage;
  readonly props: Props;
  ambient: Ambient | null = null;
  secrets: Secrets | null = null;
  quality!: QualitySettings;
  private userRenderScale = 0;
  private updaters: ((dt: number) => void)[] = [];
  time = 0;

  constructor(readonly engine: AbstractEngine, readonly data: TerrainData, quality: QualitySettings) {
    // every PBR/Standard material made from here on gets the stylized lighting
    registerToon();
    const scene = new Scene(engine);
    this.scene = scene;
    scene.clearColor = new Color4(0, 0, 0, 0);
    // materials output linear HDR; tone mapping and grading happen in PostFX
    scene.imageProcessingConfiguration.applyByPostProcess = true;
    scene.imageProcessingConfiguration.toneMappingEnabled = false;
    scene.skipPointerMovePicking = true;
    scene.autoClear = true;
    scene.autoClearDepthAndStencil = true;
    scene.blockMaterialDirtyMechanism = false;
    perf.watch(scene);

    this.camera = new UniversalCamera('cam', new Vector3(0, 30, -120), scene);
    this.camera.inputs.clear();
    this.camera.minZ = 0.15;
    this.camera.maxZ = 2500;
    this.camera.fov = (60 * Math.PI) / 180;

    // Scopes tag the meshes each system creates, so the profiler can say what costs what.
    this.atmosphere = perf.scope('sky', () => new Atmosphere(scene));
    this.terrain = perf.scope('terrain', () => new Terrain(scene, data));
    this.postfx = new PostFX(scene, this.camera);
    this.water = perf.scope('water', () => new Water(scene, this.terrain.heightTexture, this.atmosphere));
    this.grass = perf.scope('grass', () => new Grass(scene, this.terrain.heightTexture, this.terrain.splatTexture, this.terrain.detailTexture, this.atmosphere));
    this.foliage = perf.scope('foliage', () => new Foliage(scene, data.heightmap, this.atmosphere));
    this.props = perf.scope('props', () => new Props(scene, data.heightmap, this.atmosphere, this.foliage));
    this.applyQuality(quality);
    perf.scope('terrain', () => this.terrain.buildInitial(this.camera.position));
  }

  applyQuality(q: QualitySettings) {
    this.quality = q;
    this.applyResolution();
    perf.scope('sky', () => this.atmosphere.applyQuality(q));
    this.postfx.apply(q);
    setOutlines(q.outlines);
    // MSAA sample counts changed: WebGPU's cached render bundles must be rebuilt
    this.scene.resetDrawCache();
    // shadows on/off and map changes alter shader variants: let static materials re-derive once
    refreshStatics(this.scene);
    perf.scope('grass', () => this.grass?.applyQuality(q));
    perf.scope('foliage', () => this.foliage?.applyQuality(q));
    this.camera.maxZ = q.viewDistance + 1000;
  }

  /** Player-chosen rendering resolution (fraction of native pixels); 0 = from the quality preset. */
  setRenderScale(scale: number) {
    this.userRenderScale = scale;
    this.applyResolution();
    this.scene.resetDrawCache();
  }

  private applyResolution() {
    const dpr = window.devicePixelRatio || 1;
    // automatic: the preset's scale, capped at 1.5× device pixels so HiDPI
    // screens don't render 4K; chosen: exactly that share of native pixels
    const s = this.userRenderScale > 0 ? this.userRenderScale * dpr : this.quality.renderScale * Math.min(dpr, 1.5);
    this.engine.setHardwareScalingLevel(1 / s);
  }

  /** e.g. "85% scale" (chosen) or "auto 100% scale" (from the preset). */
  scaleLabel() {
    return this.userRenderScale > 0 ? `${Math.round(this.userRenderScale * 100)}% scale` : `auto ${Math.round(this.quality.renderScale * 100)}% scale`;
  }

  /** The size the scene is rendered at, in pixels. */
  renderSize(): [number, number] {
    return [this.engine.getRenderWidth(), this.engine.getRenderHeight()];
  }

  /** Load streamed glTF content (props). Safe to call once. */
  async loadAssets() {
    await this.props.load();
    perf.claimUntagged('props');
    this.ambient = perf.scope('ambient', () => new Ambient(this.scene, this.data.heightmap, this.atmosphere, this.props.lights));
    this.secrets = perf.scope('secrets', () => new Secrets(this.scene, this.data.heightmap, this.atmosphere, this.foliage, this.ambient!));
  }

  onUpdate(fn: (dt: number) => void) {
    this.updaters.push(fn);
  }

  /** Height of the rendered ground at (x, z). */
  groundAt(x: number, z: number) {
    return this.data.heightmap.sample(x, z);
  }

  update(dt: number) {
    this.time += dt;
    const cam = this.camera.globalPosition;
    perf.begin('sky');
    // shadows follow the camera's focus, pushed a little ahead of the view
    const focus = this.camera.getTarget();
    const fwd = this.camera.getDirection(Vector3.Forward());
    const lead = this.quality.shadowDistance * 0.25;
    this.atmosphere.shadowFocus.set(focus.x + fwd.x * lead, focus.y, focus.z + fwd.z * lead);
    this.atmosphere.update(dt, this.camera);
    perf.end('sky');
    perf.begin('terrain');
    this.terrain.update(cam);
    perf.end('terrain');
    perf.begin('water');
    this.water.update(this.time, cam);
    perf.end('water');
    perf.begin('grass');
    this.grass.update(this.time, cam);
    perf.end('grass');
    perf.begin('foliage');
    {
      const fwd = this.camera.getDirection(Vector3.Forward());
      const aspect = this.engine.getAspectRatio(this.camera);
      const halfFov = Math.atan(Math.tan(this.camera.fov / 2) * aspect);
      this.foliage.update(this.time, cam, this.grass.wind, fwd, halfFov);
    }
    perf.end('foliage');
    perf.begin('props');
    this.props.update(this.time);
    perf.end('props');
    perf.begin('ambient');
    this.ambient?.update(dt, cam);
    perf.end('ambient');
    perf.begin('secrets');
    this.secrets?.update(this.time);
    perf.end('secrets');
    perf.begin('game');
    for (const fn of this.updaters) fn(dt);
    perf.end('game');
    perf.begin('postfx');
    const a = this.atmosphere;
    const sunUp = a.sunDir.y > -0.02;
    this.postfx.sunDir.copyFrom(sunUp ? a.sunDir : a.moonDir);
    const s = a.state;
    // warm golden shafts by day, faint silver ones under the moon
    if (sunUp) this.postfx.shaftColor.set(s.sun.r * 0.55, s.sun.g * 0.48, s.sun.b * 0.36);
    else this.postfx.shaftColor.set(0.1, 0.13, 0.2);
    this.postfx.shaftStrength = sunUp ? Math.min(1, (a.sunDir.y + 0.02) / 0.1) * (1 - a.cloudCover * 0.4) : 0.5 * s.night;
    this.postfx.update(a.exposure);
    perf.end('postfx');
  }
}
