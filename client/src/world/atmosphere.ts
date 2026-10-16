// Sun/moon light, the shadow map and the stylized lighting + fog state, all
// driven by the time of day.
//
// Shadows: one stable shadow map that follows the player (no cascades). Only
// casters inside its radius are drawn into it, the map is snapped to whole
// texels so edges never shimmer, and the light direction moves in tiny steps
// so the sun's motion does not make shadows crawl. Beyond the radius the
// shadows fade out softly and cel shading carries the shape.
import {
  Color3,
  DirectionalLight,
  Mesh,
  Scene,
  ShadowGenerator,
  Vector3,
  type AbstractMesh,
  type Camera,
} from '@babylonjs/core';
import { sunDirection } from '@kelia/shared';
import type { QualitySettings } from '../core/quality';
import { Sky, skyStateAt, type SkyState } from './sky';
import { toon } from './toon';

interface Caster {
  /** Always drawn (instanced sets that manage their own range). */
  always: boolean;
}

const tmpA = new Vector3();
const tmpB = new Vector3();
const UP = new Vector3(0, 1, 0);

export class Atmosphere {
  readonly sun: DirectionalLight;
  readonly sky: Sky;
  shadows: ShadowGenerator | null = null;
  readonly sunDir = new Vector3(0, 1, 0);
  readonly moonDir = new Vector3(0, 1, 0);
  readonly state: SkyState;
  /** Visual time of day in [0,1). */
  dayTime = 0.4;
  cloudCover = 0.42;
  /** Seconds the sky has animated (cloud drift), shared with the water's reflections. */
  time = 0;
  fogScale = 1;
  /** Extra exposure multiplier (UI fades, creator lighting). */
  exposureBias = 1;
  private casters = new Map<AbstractMesh, Caster>();
  private renderList: AbstractMesh[] = [];
  private listAnchor: AbstractMesh;
  private shadowRadius = 60;
  private shadowTexel = 0.05;
  /** Where the shadow map is centred (the player, or the camera target). */
  readonly shadowFocus = new Vector3(0, 0, 0);
  private lightDir = new Vector3(0, -1, 0);

  constructor(scene: Scene) {
    scene.clearColor.set(0, 0, 0, 0);
    scene.ambientColor = new Color3(0, 0, 0);
    // Fog is done by the toon shading (height fog with sun glow), not Babylon.
    scene.fogMode = Scene.FOGMODE_NONE;
    this.sky = new Sky(scene);
    this.sun = new DirectionalLight('sun', new Vector3(-0.3, -1, 0.4), scene);
    this.sun.intensity = 1;
    this.sun.specular = Color3.Black();
    this.sun.autoUpdateExtends = false;
    this.sun.autoCalcShadowZBounds = false;
    this.sun.shadowMinZ = 0;
    this.sun.shadowMaxZ = 520;
    this.state = skyStateAt(this.dayTime);
    this.listAnchor = new Mesh('shadowListAnchor', scene);
    this.listAnchor.setEnabled(false);
  }

  applyQuality(q: QualitySettings) {
    if (this.shadows) {
      this.shadows.dispose();
      this.shadows = null;
    }
    if (!q.shadows) {
      toon.sunDir.w = 0;
      return;
    }
    this.shadowRadius = q.shadowDistance;
    this.shadowTexel = (q.shadowDistance * 2) / q.shadowMapSize;
    this.sun.shadowFrustumSize = q.shadowDistance * 2;
    const sg = new ShadowGenerator(q.shadowMapSize, this.sun, true);
    sg.usePercentageCloserFiltering = true;
    sg.filteringQuality = q.shadowSoft ? ShadowGenerator.QUALITY_MEDIUM : ShadowGenerator.QUALITY_LOW;
    sg.bias = 0.00045;
    sg.normalBias = 0.02;
    sg.darkness = 0;
    sg.frustumEdgeFalloff = 0.35;
    sg.transparencyShadow = false;
    const map = sg.getShadowMap()!;
    // Hand the casters over through getCustomRenderList, never by editing
    // map.renderList: Babylon watches that array, and every time it goes from
    // empty to non-empty it marks the lighting of every mesh in the scene as
    // dirty, which re-validates every material on the next draw. Refilling it
    // each frame did exactly that, costing milliseconds of CPU per frame.
    // The watched list keeps one permanent placeholder because materials only
    // enable shadow receiving while the shadow map's renderList is non-empty.
    map.renderList = [this.listAnchor];
    map.getCustomRenderList = () => this.renderList;
    this.shadows = sg;
  }

  /** Register a mesh that casts shadows. `always` = skip the range test (managed instanced sets). */
  addShadowCaster(mesh: AbstractMesh, includeDescendants = true, always = false) {
    const meshes = includeDescendants ? [mesh, ...mesh.getChildMeshes(false)] : [mesh];
    for (const m of meshes) {
      if (this.casters.has(m)) continue;
      this.casters.set(m, { always });
      m.onDisposeObservable.addOnce(() => this.casters.delete(m));
    }
  }

  removeShadowCaster(mesh: AbstractMesh) {
    for (const m of [mesh, ...mesh.getChildMeshes(false)]) this.casters.delete(m);
  }

  /** Fill the shadow map's render list with casters near the focus point. */
  private gatherCasters() {
    const list = this.renderList;
    list.length = 0;
    const fx = this.shadowFocus.x;
    const fz = this.shadowFocus.z;
    const r = this.shadowRadius;
    for (const [m, c] of this.casters) {
      if (!m.isEnabled() || !m.isVisible) continue;
      if (c.always) {
        list.push(m);
        continue;
      }
      const bs = m.getBoundingInfo().boundingSphere;
      const dx = bs.centerWorld.x - fx;
      const dz = bs.centerWorld.z - fz;
      const rr = r + bs.radiusWorld + 4;
      if (dx * dx + dz * dz < rr * rr) list.push(m);
    }
  }

  /** Centre the shadow map on the focus point, snapped to whole texels. */
  private placeShadowCamera() {
    const dir = this.lightDir;
    // the same basis Babylon's LookAtLH builds for the light view
    const xAxis = Vector3.CrossToRef(UP, dir, tmpA).normalize();
    const yAxis = Vector3.CrossToRef(dir, xAxis, tmpB);
    const c = this.shadowFocus;
    const t = this.shadowTexel;
    const cx = Vector3.Dot(c, xAxis);
    const cy = Vector3.Dot(c, yAxis);
    const sx = Math.round(cx / t) * t - cx;
    const sy = Math.round(cy / t) * t - cy;
    const p = this.sun.position;
    p.copyFrom(c);
    p.addInPlaceFromFloats(xAxis.x * sx + yAxis.x * sy, xAxis.y * sx + yAxis.y * sy, xAxis.z * sx + yAxis.z * sy);
    // and back along the light so tall things behind the player still cast
    p.addInPlaceFromFloats(-dir.x * 260, -dir.y * 260, -dir.z * 260);
  }

  update(dt: number, camera: Camera) {
    this.time += dt;
    const t = this.dayTime;
    const s = skyStateAt(t, this.state);
    const [sx, sy, sz] = sunDirection(t);
    this.sunDir.set(sx, sy, sz);
    this.moonDir.set(-sx * 0.9, Math.max(0.25, -sy), -sz * 0.9 + 0.2).normalize();

    // The key light is the sun by day and the moon by night.
    const sunUp = sy > -0.02;
    const key = sunUp ? this.sunDir : this.moonDir;
    // Keep the light from grazing exactly along the ground (long smeared shadows).
    const ly = Math.max(key.y, 0.2);
    tmpA.set(-key.x, -ly, -key.z).normalize();
    // Step the shadow direction so the moving sun does not make shadow edges crawl.
    if (Vector3.Dot(tmpA, this.lightDir) < 0.99998 || !sunUp !== this.wasNight) {
      this.lightDir.copyFrom(tmpA);
      this.sun.direction.copyFrom(tmpA);
      this.wasNight = !sunUp;
    }
    const twilight = Math.min(1, Math.abs(sy) / 0.08);

    // --- stylized lighting state
    const keyI = s.sunIntensity * (sunUp ? 0.3 : 0.42) * (0.35 + 0.65 * twilight);
    toon.sunDir.set(-this.lightDir.x, -this.lightDir.y, -this.lightDir.z, this.shadows ? (sunUp ? 0.97 : 0.62) * (0.4 + 0.6 * twilight) : 0);
    toon.sun.set(s.sun.r * keyI, s.sun.g * keyI, s.sun.b * keyI, 0);
    const amb = s.ambient;
    // sky light: a bright, slightly blue fill so shadowed sides keep their colour
    toon.sky.set(
      (s.horizon.r * 0.55 + s.zenith.r * 0.45) * amb * 0.95 + 0.04,
      (s.horizon.g * 0.55 + s.zenith.g * 0.45) * amb * 0.95 + 0.05,
      (s.horizon.b * 0.55 + s.zenith.b * 0.45) * amb * 0.95 + 0.07,
      0.55 + 0.45 * (1 - s.night),
    );
    toon.ground.set(s.fog.r * amb * 0.42 + s.sun.r * keyI * 0.05, s.fog.g * amb * 0.42 + s.sun.g * keyI * 0.05, s.fog.b * amb * 0.42 + s.sun.b * keyI * 0.04, 0);
    // shadow tint: shade is lit by the blue sky alone, so it sits deep and
    // cool (a clear step down from the sunlit side), deep blue at night
    toon.shade.set(0.62 - 0.06 * s.night, 0.69 - 0.04 * s.night, 0.93, 0.06);
    // Aerial perspective: a thin, blue haze. Distance turns things blue long
    // before it washes them out, so far mountains keep their sunlit and shaded
    // faces. By day the haze leans toward the sky's own blue; at sunrise and
    // sunset it keeps the warm fog colour.
    const day = Math.min(1, Math.max(0, (1.1 - s.glow) / 0.6)) * (1 - s.night);
    const blue = 0.32 * day;
    const skyR = s.horizon.r * 0.6 + s.zenith.r * 0.4;
    const skyG = s.horizon.g * 0.6 + s.zenith.g * 0.4;
    const skyB = s.horizon.b * 0.6 + s.zenith.b * 0.4;
    toon.fog.set(s.fog.r + (skyR - s.fog.r) * blue, s.fog.g + (skyG - s.fog.g) * blue, s.fog.b + (skyB - s.fog.b) * blue, s.fogDensity * 0.52 * this.fogScale);
    toon.fog2.set(0.011, 4, sunUp ? 0.9 : 0.35, 0.94);
    toon.fogSun.set(Math.min(1.6, s.fog.r * 0.45 + s.sun.r * 0.75), Math.min(1.6, s.fog.g * 0.45 + s.sun.g * 0.68), Math.min(1.6, s.fog.b * 0.45 + s.sun.b * 0.5), 0);
    const glowDir = sunUp ? this.sunDir : this.moonDir;
    toon.fogDir.set(glowDir.x, glowDir.y, glowDir.z, day);

    if (this.shadows) {
      this.placeShadowCamera();
      this.gatherCasters();
    }
    this.sky.update(s, this.sunDir, this.moonDir, this.time, this.cloudCover, camera.globalPosition);
  }

  private wasNight = false;

  get exposure() {
    return this.state.exposure * this.exposureBias;
  }
}
