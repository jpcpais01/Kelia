// Assembles the 3D world: scene, camera, sky & lighting, terrain, water,
// vegetation, props and ambient life.
import { Color4, Scene, UniversalCamera, Vector3, type AbstractEngine } from '@babylonjs/core';
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
  private updaters: ((dt: number) => void)[] = [];
  time = 0;

  constructor(readonly engine: AbstractEngine, readonly data: TerrainData, quality: QualitySettings) {
    const scene = new Scene(engine);
    this.scene = scene;
    scene.clearColor = new Color4(0, 0, 0, 1);
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
    this.postfx = new PostFX(scene, this.camera, this.atmosphere.sky.sunBillboard);
    this.water = perf.scope('water', () => new Water(scene, this.terrain.heightTexture, this.atmosphere));
    this.grass = perf.scope('grass', () => new Grass(scene, this.terrain.heightTexture, this.terrain.splatTexture, this.atmosphere));
    this.foliage = perf.scope('foliage', () => new Foliage(scene, data.heightmap, this.atmosphere));
    this.props = perf.scope('props', () => new Props(scene, data.heightmap, this.atmosphere, this.foliage));
    this.applyQuality(quality);
    perf.scope('terrain', () => this.terrain.buildInitial(this.camera.position));
  }

  applyQuality(q: QualitySettings) {
    this.quality = q;
    this.engine.setHardwareScalingLevel(1 / (q.renderScale * Math.min(window.devicePixelRatio || 1, 1.5)));
    perf.scope('sky', () => this.atmosphere.applyQuality(q));
    this.terrain.setShadowGenerator(this.atmosphere.shadows);
    this.postfx.apply(q);
    perf.scope('grass', () => this.grass?.applyQuality(q));
    perf.scope('foliage', () => this.foliage?.applyQuality(q));
    this.camera.maxZ = q.viewDistance + 1000;
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
    this.foliage.update(this.time, cam, this.grass.wind);
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
    this.postfx.update(this.atmosphere.exposure);
    perf.end('postfx');
    const sunVis = Math.max(0, Math.min(1, (this.atmosphere.sunDir.y + 0.02) / 0.12));
    this.postfx.shaftStrength = sunVis;
  }
}
