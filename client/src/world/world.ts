// Assembles the 3D world: scene, camera, sky & lighting, terrain, water,
// vegetation, props and ambient life.
import { Color4, Scene, UniversalCamera, Vector3, type AbstractEngine } from '@babylonjs/core';
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

    this.camera = new UniversalCamera('cam', new Vector3(0, 30, -120), scene);
    this.camera.inputs.clear();
    this.camera.minZ = 0.15;
    this.camera.maxZ = 2500;
    this.camera.fov = (60 * Math.PI) / 180;

    this.atmosphere = new Atmosphere(scene);
    this.terrain = new Terrain(scene, data);
    this.postfx = new PostFX(scene, this.camera, this.atmosphere.sky.sunBillboard);
    this.water = new Water(scene, this.terrain.heightTexture, this.atmosphere);
    this.grass = new Grass(scene, this.terrain.heightTexture, this.terrain.splatTexture, this.atmosphere);
    this.foliage = new Foliage(scene, data.heightmap, this.atmosphere);
    this.props = new Props(scene, data.heightmap, this.atmosphere, this.foliage);
    this.applyQuality(quality);
    this.terrain.buildInitial(this.camera.position);
  }

  applyQuality(q: QualitySettings) {
    this.quality = q;
    this.engine.setHardwareScalingLevel(1 / (q.renderScale * Math.min(window.devicePixelRatio || 1, 1.5)));
    this.atmosphere.applyQuality(q);
    this.terrain.setShadowGenerator(this.atmosphere.shadows);
    this.postfx.apply(q);
    this.grass?.applyQuality(q);
    this.foliage?.applyQuality(q);
    this.camera.maxZ = q.viewDistance + 1000;
  }

  /** Load streamed glTF content (props). Safe to call once. */
  async loadAssets() {
    await this.props.load();
    this.ambient = new Ambient(this.scene, this.data.heightmap, this.atmosphere, this.props.lights);
    this.secrets = new Secrets(this.scene, this.data.heightmap, this.atmosphere, this.foliage, this.ambient);
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
    this.atmosphere.update(dt, this.camera);
    this.terrain.update(this.camera.globalPosition);
    this.water.update(this.time, this.camera.globalPosition);
    this.grass.update(this.time, this.camera.globalPosition);
    this.foliage.update(this.time, this.camera.globalPosition, this.grass.wind);
    this.props.update(this.time);
    this.ambient?.update(dt, this.camera.globalPosition);
    this.secrets?.update(this.time);
    for (const fn of this.updaters) fn(dt);
    this.postfx.update(this.atmosphere.exposure);
    const sunVis = Math.max(0, Math.min(1, (this.atmosphere.sunDir.y + 0.02) / 0.12));
    this.postfx.shaftStrength = sunVis;
  }
}
