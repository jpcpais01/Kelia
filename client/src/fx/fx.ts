// Combat and magic effects in a crisp anime style, all generated in code.
//
// Everything is drawn by a handful of GPU layers (see layers.ts), each one
// mesh with one shader compiled at start-up:
//   sprites  billboards, velocity-stretched sparks, oriented rings, flames
//   decals   terrain-hugging ground patterns: magic circles, telegraphs,
//            shockwaves, scorch marks, cracks, frost
//   shapes   swept ribbons: slash crescents, light pillars, helices, cones
//   shards   ice crystals and rock debris
// plus pooled weapon-trail ribbons and dissolving afterimages. Spawning an
// effect writes a few instance slots; the GPU animates them from there, so
// nothing creates materials or particle systems at runtime. Glowing parts are
// HDR (> 1) and additive so the bloom picks them up.
import {
  Mesh,
  ShaderMaterial,
  TransformNode,
  Vector3,
  VertexData,
  Constants,
  Color3,
  type AbstractMesh,
  type Scene,
  type Texture,
} from '@babylonjs/core';
import { perf } from '../core/perf';
import { toon } from '../world/toon';
import './shaders';
import { InstanceLayer, crystalTemplate, gridTemplate, quadTemplate, stripTemplate } from './layers';
import { D, S, createDecalAtlas, createSpriteAtlas } from './textures';

export { D, S };

export type RGB = [number, number, number];

export interface Missile {
  pos: Vector3;
  alive: boolean;
}

export type MissileKind = 'arrow' | 'arrow_heavy' | 'pierce' | 'snare' | 'bolt' | 'bolt_big' | 'fire' | 'hex' | 'frost';

interface SpriteO {
  v?: Vector3;
  dur: number;
  size: number;
  size1?: number;
  cell: number;
  color: RGB;
  alpha?: number;
  gravity?: number;
  drag?: number;
  rot?: number;
  spin?: number;
  /** 0 billboard, 1 stretched along velocity, 2 facing `axis`, 3 upright billboard. */
  mode?: number;
  axis?: Vector3;
  stretch?: number;
  fadeIn?: number;
  fadeOut?: number;
  hot?: number;
  occl?: number;
  ease?: number;
  flicker?: number;
  delay?: number;
}

interface DecalO {
  r0?: number;
  r: number;
  dur: number;
  cell: number;
  color: RGB;
  alpha?: number;
  rot?: number;
  spin?: number;
  /** 0 expand and fade, 1 linear fill, 2 appear, hold, fade. */
  mode?: number;
  fadeIn?: number;
  fadeOut?: number;
  hot?: number;
  occl?: number;
  lift?: number;
  delay?: number;
}

interface ShapeO {
  /** 0 arc, 1 cylinder, 2 helix, 3 cone, 4 ring band. */
  mode: number;
  yaw?: number;
  tilt?: number;
  pitch?: number;
  dur: number;
  radius: number;
  len: number;
  width: number;
  turns?: number;
  color: RGB;
  alpha?: number;
  spin?: number;
  rise?: number;
  grow?: number;
  seed?: number;
  fadeOut?: number;
  hot?: number;
  head?: number;
  occl?: number;
  /** Arc only: slants the crescent out of its plane so it reads from any angle. */
  stand?: number;
  delay?: number;
}

interface ShardO {
  v?: Vector3;
  dur: number;
  axis: Vector3;
  len: number;
  width: number;
  color: RGB;
  style: number;
  gravity?: number;
  spin?: number;
  grow?: number;
  delay?: number;
}

interface Handle {
  layer: InstanceLayer;
  off: number;
  t0: number;
}

interface MissileState {
  m: Missile;
  dir: Vector3;
  speed: number;
  range: number;
  travelled: number;
  kind: MissileKind;
  color: RGB;
  heads: Handle[];
  emit: number;
  hit: (p: Vector3) => boolean;
  onEnd?: (p: Vector3, struck: boolean) => void;
  ended: boolean;
}

interface Trail {
  mesh: Mesh;
  pos: Float32Array;
  tr: Float32Array;
  col: Float32Array;
  samples: { b: Vector3; t: Vector3; time: number }[];
  raw: { b: Vector3; t: Vector3 }[];
  start: number;
  until: number;
  life: number;
  hand: TransformNode | null;
  weapon: AbstractMesh | null;
  local: [Vector3, Vector3] | null;
  color: RGB;
  busy: boolean;
}

const TRAIL_POINTS = 72;
const linCache = new Map<string, Color3>();
function lin(hex: string) {
  let c = linCache.get(hex);
  if (!c) {
    c = Color3.FromHexString(hex).toLinearSpace();
    linCache.set(hex, c);
  }
  return c;
}
/** Hex colour → linear RGB × intensity. */
export const C = (hex: string, k = 1): RGB => {
  const c = lin(hex);
  return [c.r * k, c.g * k, c.b * k];
};
const scale = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const TAU = Math.PI * 2;
const UP = new Vector3(0, 1, 0);

/** A random unit vector, optionally biased upward. */
function randDir(up = 0) {
  const z = rand(-1, 1) * (1 - up) + up * rand(0, 1);
  const a = rand(0, TAU);
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return new Vector3(Math.cos(a) * r, z, Math.sin(a) * r);
}

export class Effects {
  private root: TransformNode;
  private sprites: InstanceLayer;
  private decals: InstanceLayer;
  private shapes: InstanceLayer;
  private shards: InstanceLayer;
  private trailMat: ShaderMaterial;
  private ghostMat: ShaderMaterial;
  private trails: Trail[] = [];
  private ghosts: { mesh: Mesh; end: number }[] = [];
  private missiles: MissileState[] = [];
  private timers: { t: number; fn: () => void }[] = [];
  private camRight = new Vector3();
  private camUp = new Vector3();
  private sunDir = new Vector3();
  private sunCol = new Vector3();
  private amb = new Vector3();
  private lit = new Vector3(1, 1, 1);
  private weaponCache = new WeakMap<AbstractMesh, [Vector3, Vector3]>();
  /** Effect clock (seconds). */
  time = 0;
  /** Multiplies dt (the dev view freezes effects mid-flight with 0). */
  timeScale = 1;
  /** Ground height for telegraphs and impacts. */
  groundAt: (x: number, z: number) => number = () => 0;

  constructor(private scene: Scene, heightTex?: Texture) {
    this.root = new TransformNode('fx', scene);
    perf.tag(this.root, 'fx');
    const spriteTex = createSpriteAtlas(scene);
    const decalTex = createDecalAtlas(scene);

    this.decals = new InstanceLayer(scene, this.root, {
      name: 'fxDecals',
      shader: 'keliaFxDecal',
      attributes: ['dcA', 'dcB', 'dcC', 'dcD', 'dcE'],
      capacity: 96,
      template: gridTemplate(22),
      uniforms: ['useHeight'],
      samplers: ['atlas', 'heightTex'],
      zOffset: -2,
      alphaIndex: 40,
    });
    this.decals.setTexture('atlas', decalTex);
    if (heightTex) this.decals.setTexture('heightTex', heightTex);
    else this.decals.setTexture('heightTex', decalTex);
    this.decals.mat.setFloat('useHeight', heightTex ? 1 : 0);

    this.shards = new InstanceLayer(scene, this.root, {
      name: 'fxShards',
      shader: 'keliaFxShard',
      attributes: ['sdA', 'sdB', 'sdC', 'sdD', 'sdE'],
      capacity: 160,
      template: crystalTemplate(),
      templateAttributes: ['position', 'normal'],
      uniforms: ['sunDir', 'sunColor', 'ambient'],
      depthWrite: true,
      alphaIndex: 41,
    });

    this.shapes = new InstanceLayer(scene, this.root, {
      name: 'fxShapes',
      shader: 'keliaFxShape',
      attributes: ['shA', 'shB', 'shC', 'shD', 'shE', 'shF', 'shG'],
      capacity: 96,
      template: stripTemplate(64, 4),
      alphaIndex: 42,
    });

    this.sprites = new InstanceLayer(scene, this.root, {
      name: 'fxSprites',
      shader: 'keliaFxSprite',
      attributes: ['spA', 'spB', 'spC', 'spD', 'spE', 'spF', 'spG', 'spH'],
      capacity: 8192,
      template: quadTemplate(),
      uniforms: ['camRight', 'camUp', 'litTint'],
      samplers: ['atlas'],
      alphaIndex: 44,
    });
    this.sprites.setTexture('atlas', spriteTex);

    const mk = (name: string, shader: string, attrs: string[]) => {
      const m = new ShaderMaterial(name, scene, shader, { attributes: attrs, uniforms: ['viewProjection', 'fxTime', 'camPos'], needAlphaBlending: true });
      m.alphaMode = Constants.ALPHA_PREMULTIPLIED;
      m.backFaceCulling = false;
      m.disableDepthWrite = true;
      return m;
    };
    this.trailMat = mk('fxTrailMat', 'keliaFxTrail', ['position', 'trA', 'color']);
    this.ghostMat = mk('fxGhostMat', 'keliaFxGhost', ['position', 'normal', 'ghA', 'color']);
    for (let i = 0; i < 8; i++) this.trails.push(this.makeTrail(i));

    // weapon trails sample the animated pose: after animations, before drawing
    scene.onBeforeRenderObservable.add(() => this.sampleTrails());
  }

  // ================================================================ core
  update(dt: number) {
    dt *= this.timeScale;
    this.time += dt;
    const t = this.time;
    for (let i = this.timers.length - 1; i >= 0; i--) {
      if (this.timers[i].t <= t) {
        const fn = this.timers[i].fn;
        this.timers.splice(i, 1);
        fn();
      }
    }
    if (dt > 0) this.updateMissiles(dt);
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      if (t > this.ghosts[i].end) {
        this.ghosts[i].mesh.dispose();
        this.ghosts.splice(i, 1);
      }
    }
    const cam = this.scene.activeCamera;
    if (cam) {
      cam.getDirectionToRef(Vector3.Right(), this.camRight);
      cam.getDirectionToRef(Vector3.Up(), this.camUp);
    }
    const cp = cam ? cam.globalPosition : Vector3.Zero();
    this.sunDir.set(toon.sunDir.x, toon.sunDir.y, toon.sunDir.z);
    this.sunCol.set(toon.sun.x, toon.sun.y, toon.sun.z);
    this.amb.set(toon.sky.x * 0.8, toon.sky.y * 0.8, toon.sky.z * 0.8);
    for (const l of [this.sprites, this.decals, this.shapes, this.shards]) {
      l.flush();
      l.mat.setFloat('fxTime', t);
      l.mat.setVector3('camPos', cp);
    }
    this.sprites.mat.setVector3('camRight', this.camRight);
    this.sprites.mat.setVector3('camUp', this.camUp);
    const lt = (v: number) => Math.max(0.05, Math.min(1.4, v));
    this.lit.set(lt(toon.sky.x * 0.9 + toon.sun.x * 0.45), lt(toon.sky.y * 0.9 + toon.sun.y * 0.45), lt(toon.sky.z * 0.9 + toon.sun.z * 0.45));
    this.sprites.mat.setVector3('litTint', this.lit);
    this.shards.mat.setVector3('sunDir', this.sunDir);
    this.shards.mat.setVector3('sunColor', this.sunCol);
    this.shards.mat.setVector3('ambient', this.amb);
    for (const m of [this.trailMat, this.ghostMat]) {
      m.setFloat('fxTime', t);
      m.setVector3('camPos', cp);
    }
  }

  /** Run `fn` after `sec` seconds of effect time. */
  after(sec: number, fn: () => void) {
    if (sec <= 0) fn();
    else this.timers.push({ t: this.time + sec, fn });
  }

  // ================================================================ primitives
  sprite(p: Vector3, o: SpriteO): Handle {
    const L = this.sprites;
    const off = L.alloc();
    const d = L.data;
    const t0 = this.time + (o.delay ?? 0);
    const v = o.v;
    d[off] = p.x;
    d[off + 1] = p.y;
    d[off + 2] = p.z;
    d[off + 3] = t0;
    d[off + 4] = v ? v.x : 0;
    d[off + 5] = v ? v.y : 0;
    d[off + 6] = v ? v.z : 0;
    d[off + 7] = o.dur;
    d[off + 8] = o.color[0];
    d[off + 9] = o.color[1];
    d[off + 10] = o.color[2];
    d[off + 11] = o.alpha ?? 1;
    d[off + 12] = o.size;
    d[off + 13] = o.size1 ?? o.size;
    d[off + 14] = o.cell;
    d[off + 15] = o.gravity ?? 0;
    d[off + 16] = o.drag ?? 0;
    d[off + 17] = o.rot ?? 0;
    d[off + 18] = o.spin ?? 0;
    d[off + 19] = o.mode ?? 0;
    const ax = o.axis;
    d[off + 20] = ax ? ax.x : 0;
    d[off + 21] = ax ? ax.y : 1;
    d[off + 22] = ax ? ax.z : 0;
    d[off + 23] = o.stretch ?? 0;
    d[off + 24] = o.fadeIn ?? 0.05;
    d[off + 25] = o.fadeOut ?? 0.5;
    d[off + 26] = o.hot ?? 0.6;
    d[off + 27] = o.occl ?? 0;
    d[off + 28] = o.ease ?? 0;
    d[off + 29] = Math.random();
    d[off + 30] = o.flicker ?? 0;
    d[off + 31] = 0;
    return { layer: L, off, t0 };
  }

  decal(x: number, y: number, z: number, o: DecalO): Handle {
    const L = this.decals;
    const off = L.alloc();
    const d = L.data;
    const t0 = this.time + (o.delay ?? 0);
    d[off] = x;
    d[off + 1] = y;
    d[off + 2] = z;
    d[off + 3] = t0;
    d[off + 4] = o.r0 ?? o.r;
    d[off + 5] = o.r;
    d[off + 6] = o.dur;
    d[off + 7] = o.rot ?? Math.random() * TAU;
    d[off + 8] = o.color[0];
    d[off + 9] = o.color[1];
    d[off + 10] = o.color[2];
    d[off + 11] = o.alpha ?? 1;
    d[off + 12] = o.cell;
    d[off + 13] = o.spin ?? 0;
    d[off + 14] = o.mode ?? 2;
    d[off + 15] = o.fadeIn ?? 0.12;
    d[off + 16] = o.occl ?? 0;
    d[off + 17] = o.fadeOut ?? 0.6;
    d[off + 18] = o.hot ?? 0.7;
    d[off + 19] = o.lift ?? 0.07;
    return { layer: L, off, t0 };
  }

  shape(p: Vector3, o: ShapeO): Handle {
    const L = this.shapes;
    const off = L.alloc();
    const d = L.data;
    const t0 = this.time + (o.delay ?? 0);
    d[off] = p.x;
    d[off + 1] = p.y;
    d[off + 2] = p.z;
    d[off + 3] = t0;
    d[off + 4] = o.yaw ?? 0;
    d[off + 5] = o.tilt ?? 0;
    d[off + 6] = o.dur;
    d[off + 7] = o.mode;
    d[off + 8] = o.radius;
    d[off + 9] = o.len;
    d[off + 10] = o.width;
    d[off + 11] = o.turns ?? 1;
    d[off + 12] = o.color[0];
    d[off + 13] = o.color[1];
    d[off + 14] = o.color[2];
    d[off + 15] = o.alpha ?? 1;
    d[off + 16] = o.spin ?? 0;
    d[off + 17] = o.rise ?? 0;
    d[off + 18] = o.grow ?? 1;
    d[off + 19] = o.seed ?? Math.random();
    d[off + 20] = o.pitch ?? 0;
    d[off + 21] = o.fadeOut ?? 0.55;
    d[off + 22] = o.hot ?? 0.7;
    d[off + 23] = o.head ?? 100;
    d[off + 24] = o.occl ?? 0;
    d[off + 25] = o.stand ?? 0;
    d[off + 26] = 0;
    d[off + 27] = 0;
    return { layer: L, off, t0 };
  }

  shard(p: Vector3, o: ShardO): Handle {
    const L = this.shards;
    const off = L.alloc();
    const d = L.data;
    const t0 = this.time + (o.delay ?? 0);
    const v = o.v;
    d[off] = p.x;
    d[off + 1] = p.y;
    d[off + 2] = p.z;
    d[off + 3] = t0;
    d[off + 4] = v ? v.x : 0;
    d[off + 5] = v ? v.y : 0;
    d[off + 6] = v ? v.z : 0;
    d[off + 7] = o.dur;
    d[off + 8] = o.axis.x;
    d[off + 9] = o.axis.y;
    d[off + 10] = o.axis.z;
    d[off + 11] = o.len;
    d[off + 12] = o.color[0];
    d[off + 13] = o.color[1];
    d[off + 14] = o.color[2];
    d[off + 15] = o.style;
    d[off + 16] = o.width;
    d[off + 17] = o.gravity ?? 0;
    d[off + 18] = o.spin ?? 0;
    d[off + 19] = o.grow ?? 0;
    return { layer: L, off, t0 };
  }

  /** End an instance now (missile heads that struck something). */
  private kill(h: Handle) {
    const L = h.layer;
    const durIdx = L === this.sprites ? 7 : L === this.decals ? 6 : 7;
    if (L.data[h.off + 3] !== h.t0) return; // slot was reused
    L.data[h.off + durIdx] = Math.max(1e-4, this.time - h.t0);
    L.touch(h.off);
  }

  private ground(x: number, z: number) {
    return this.groundAt(x, z);
  }

  // ================================================================ building blocks
  /** Radial spray of velocity-stretched sparks. */
  sparks(p: Vector3, color: RGB, o: { n?: number; speed?: number; size?: number; dur?: number; gravity?: number; up?: number; dir?: Vector3; cone?: number; drag?: number; stretch?: number; delay?: number } = {}) {
    const n = o.n ?? 10;
    const sp = o.speed ?? 9;
    for (let i = 0; i < n; i++) {
      let d = randDir(o.up ?? 0);
      if (o.dir) d = o.dir.add(d.scale(o.cone ?? 0.6)).normalize();
      this.sprite(p, {
        v: d.scale(sp * rand(0.45, 1)),
        dur: (o.dur ?? 0.35) * rand(0.6, 1),
        size: (o.size ?? 0.06) * rand(0.7, 1.2),
        cell: S.spark,
        color,
        mode: 1,
        stretch: o.stretch ?? 0.045,
        drag: o.drag ?? 6,
        gravity: o.gravity ?? 5,
        hot: 1,
        fadeOut: 0.4,
        delay: o.delay,
      });
    }
  }

  /** Star-shaped flash with a glow halo. */
  flash(p: Vector3, color: string | RGB, size = 1.4, dur = 0.18) {
    const c = typeof color === 'string' ? C(color, 3) : color;
    this.sprite(p, { dur, size: size * 0.25, size1: size * 0.75, cell: S.star8, color: c, rot: rand(0, TAU), hot: 1, ease: 1, fadeIn: 0, fadeOut: 0.35 });
    this.sprite(p, { dur: dur * 1.4, size: size * 0.35, size1: size * 0.9, cell: S.glow, color: scale(c, 0.5), alpha: 0.9, hot: 0.6, ease: 1, fadeIn: 0, fadeOut: 0.2 });
  }

  /** Thin crisp expanding ring sprite (camera-facing or facing `axis`). */
  shockRing(p: Vector3, color: RGB, s0: number, s1: number, dur: number, axis?: Vector3, delay?: number) {
    this.sprite(p, { dur, size: s0, size1: s1, cell: S.shock, color, ease: 1.5, hot: 0.8, fadeIn: 0, fadeOut: 0.3, mode: axis ? 2 : 0, axis, delay });
  }

  /** Smoke puffs (alpha-blended, they occlude). */
  smoke(p: Vector3, color: RGB, o: { n?: number; size?: number; dur?: number; spread?: number; rise?: number; speed?: number; alpha?: number; delay?: number } = {}) {
    const n = o.n ?? 6;
    for (let i = 0; i < n; i++) {
      const d = randDir(0.2);
      const sp = o.spread ?? 0.3;
      const q = p.add(new Vector3(d.x * sp, Math.abs(d.y) * sp * 0.5, d.z * sp));
      const s = (o.size ?? 0.6) * rand(0.7, 1.2);
      this.sprite(q, {
        v: new Vector3(d.x * (o.speed ?? 1.2), (o.rise ?? 0.8) * rand(0.5, 1.2), d.z * (o.speed ?? 1.2)),
        dur: (o.dur ?? 1.2) * rand(0.7, 1.1),
        size: s * 0.6,
        size1: s * 1.6,
        cell: S.smoke,
        color,
        alpha: o.alpha ?? 0.55,
        drag: 2.2,
        rot: rand(0, TAU),
        spin: rand(-1, 1),
        hot: 0,
        occl: 1,
        ease: 1,
        fadeIn: 0.12,
        fadeOut: 0.35,
        delay: o.delay,
      });
    }
  }

  /** Twinkling motes drifting upward. */
  motes(p: Vector3, color: RGB, o: { n?: number; radius?: number; height?: number; dur?: number; size?: number; cell?: number; delay?: number; spread?: number } = {}) {
    const n = o.n ?? 16;
    const r = o.radius ?? 0.8;
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU);
      const rr = Math.sqrt(Math.random()) * r;
      const q = new Vector3(p.x + Math.cos(a) * rr, p.y + rand(0, 0.4), p.z + Math.sin(a) * rr);
      const h = (o.height ?? 2.2) * rand(0.5, 1.1);
      const dur = (o.dur ?? 1.0) * rand(0.6, 1.2);
      this.sprite(q, {
        v: new Vector3(Math.cos(a) * (o.spread ?? 0.2), h / dur, Math.sin(a) * (o.spread ?? 0.2)),
        dur,
        size: (o.size ?? 0.07) * rand(0.6, 1.3),
        cell: o.cell ?? (Math.random() < 0.35 ? S.star4 : S.glow),
        color,
        rot: rand(0, TAU),
        spin: rand(-3, 3),
        hot: 1,
        flicker: 0.4,
        fadeIn: 0.15,
        fadeOut: 0.55,
        delay: (o.delay ?? 0) + rand(0, 0.25),
      });
    }
  }

  // ================================================================ impacts
  /** Hit spark: star flash, shock ring and stretched sparks. Crits are bigger and gold. */
  impact(p: Vector3, color: string, o: { crit?: boolean; scale?: number; dir?: Vector3 } = {}) {
    const s = (o.scale ?? 1) * (o.crit ? 1.45 : 1);
    const c = o.crit ? C('#ffd76a', 4) : C(color, 3);
    this.sprite(p, { dur: 0.13, size: 0.3 * s, size1: 0.95 * s, cell: S.star8, color: c, rot: rand(0, TAU), hot: 1, ease: 1.2, fadeIn: 0, fadeOut: 0.35 });
    this.sprite(p, { dur: 0.22, size: 0.35 * s, size1: 1.05 * s, cell: S.glow, color: scale(c, 0.45), alpha: 0.8, hot: 0.5, ease: 1, fadeIn: 0, fadeOut: 0.15 });
    this.shockRing(p, scale(c, 0.7), 0.15 * s, 0.85 * s, 0.2);
    this.sparks(p, c, { n: o.crit ? 16 : 9, speed: 11 * s, size: 0.05 * s, dur: 0.32, dir: o.dir, cone: 1.1 });
    if (o.crit) {
      this.sprite(p, { dur: 0.38, size: 0.5 * s, size1: 1.5 * s, cell: S.star4, color: C('#fff0b0', 5), rot: rand(0, 1), spin: 2.5, hot: 1, ease: 1, fadeIn: 0, fadeOut: 0.3 });
      this.sprite(p, { dur: 0.3, size: 1.6 * s, size1: 2.4 * s, cell: S.cross, color: C('#ffe08a', 3), rot: 0.785, hot: 1, ease: 1, fadeIn: 0, fadeOut: 0.2 });
      this.shockRing(p, C('#ffd76a', 2.4), 0.3, 1.3 * s, 0.24, undefined, 0.04);
    }
  }

  /** A weapon arc: soft glow, bright crescent, white-hot edge and spark streaks flung along it. */
  slash(pos: Vector3, yaw: number, color: string, o: { radius?: number; arc?: number; tilt?: number; dur?: number; width?: number; reverse?: boolean; spin?: number; pitch?: number; intensity?: number; sparks?: boolean } = {}) {
    const r = o.radius ?? 1.9;
    const arc = (o.arc ?? 2.2) * (o.reverse ? -1 : 1);
    const w = o.width ?? 0.75;
    const dur = o.dur ?? 0.26;
    const tilt = o.tilt ?? 0;
    const pitch = o.pitch ?? 0;
    const k = o.intensity ?? 1;
    const head = 1.9;
    const base = { mode: 0, yaw, tilt, pitch, dur, len: arc, head, spin: o.spin ?? 0, fadeOut: 0.5 } as const;
    this.shape(pos, { ...base, radius: r * 1.04, width: w * 1.5, color: C(color, 1.0 * k), alpha: 0.4, hot: 0.05, grow: 1.08, stand: -0.55 });
    this.shape(pos, { ...base, radius: r, width: w, color: C(color, 2.2 * k), hot: 0.6, grow: 1.1, occl: 0.45, stand: 0.45 });
    this.shape(pos, { ...base, radius: r * 1.015, width: w * 0.2, color: C(color, 4.5 * k), hot: 1, grow: 1.1 });
    if (o.sparks === false || o.spin) return;
    // sparks thrown off the edge as the head passes
    const c = C(color, 3.5 * k);
    for (let i = 0; i < 7; i++) {
      const u = (i + 0.5) / 7;
      const f = (1 - Math.sqrt(1 - u)) / head;
      const a = (u - 0.5) * arc;
      const lp = new Vector3(Math.sin(a) * r, 0, Math.cos(a) * r);
      const dir = Math.sign(arc);
      const lt = new Vector3(Math.cos(a) * dir, 0, -Math.sin(a) * dir);
      const wp = this.rotLocal(lp, yaw, tilt, pitch).addInPlace(pos);
      const wt = this.rotLocal(lt, yaw, tilt, pitch);
      const out = wp.subtract(pos).normalize();
      this.sprite(wp, {
        v: wt.scale(rand(5, 10)).addInPlace(out.scale(rand(1, 3))),
        dur: rand(0.18, 0.32),
        size: rand(0.035, 0.06),
        cell: S.spark,
        color: c,
        mode: 1,
        stretch: 0.05,
        drag: 5,
        gravity: 4,
        hot: 1,
        delay: f * dur,
      });
    }
    // twinkle where the arc ends
    const ae = arc / 2;
    const tip = this.rotLocal(new Vector3(Math.sin(ae) * r, 0, Math.cos(ae) * r), yaw, tilt, pitch).addInPlace(pos);
    this.sprite(tip, { dur: 0.2, size: 0.15, size1: 0.45, cell: S.star4, color: C(color, 4 * k), rot: rand(0, 1), spin: 4, hot: 1, delay: dur * 0.42, fadeIn: 0 });
  }

  /** Same rotation order as the shape shader: roll, then pitch, then yaw. */
  private rotLocal(p: Vector3, yaw: number, tilt: number, pitch: number) {
    let x = p.x * Math.cos(tilt) - p.y * Math.sin(tilt);
    let y = p.x * Math.sin(tilt) + p.y * Math.cos(tilt);
    let z = p.z;
    const y2 = y * Math.cos(pitch) - z * Math.sin(pitch);
    const z2 = y * Math.sin(pitch) + z * Math.cos(pitch);
    y = y2;
    z = z2;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const x3 = x * c + z * s;
    const z3 = -x * s + z * c;
    x = x3;
    return new Vector3(x, y, z3);
  }

  /** Ground shockwave: crisp bright rim racing outward. */
  ring(pos: Vector3, r0: number, r1: number, color: string, dur = 0.5, intensity = 2.2) {
    this.decal(pos.x, pos.y, pos.z, { r0, r: r1, dur, cell: D.shock, color: C(color, intensity), mode: 0, fadeIn: 0, fadeOut: 0.3, hot: 0.8 });
  }

  /** A rotating magic circle on the ground. */
  magicCircle(pos: Vector3, color: string, o: { radius?: number; dur?: number; cell?: number; spin?: number; delay?: number; intensity?: number; inner?: boolean } = {}) {
    const r = o.radius ?? 1.6;
    const dur = o.dur ?? 1.1;
    const k = o.intensity ?? 2.4;
    const cell = o.cell ?? D.arcane;
    const spin = o.spin ?? 1.2;
    this.decal(pos.x, pos.y, pos.z, { r0: r * 0.55, r, dur, cell, color: C(color, k), spin, fadeIn: 0.14, fadeOut: 0.65, hot: 0.85, delay: o.delay });
    if (o.inner !== false) {
      this.decal(pos.x, pos.y, pos.z, { r0: r * 0.2, r: r * 0.62, dur: dur * 0.95, cell: D.dashes, color: C(color, k * 0.8), spin: -spin * 1.8, fadeIn: 0.2, fadeOut: 0.6, hot: 0.6, delay: (o.delay ?? 0) + 0.03 });
    }
    this.decal(pos.x, pos.y, pos.z, { r0: r * 0.5, r: r * 1.15, dur, cell: D.soft, color: C(color, k * 0.25), fadeIn: 0.2, fadeOut: 0.6, hot: 0, delay: o.delay });
  }

  /** Motes converging on a point (charging a cast). */
  gather(p: Vector3, color: string, dur = 0.3, n = 12, radius = 0.9) {
    const c = C(color, 3);
    for (let i = 0; i < n; i++) {
      const d = randDir();
      const off = d.scale(radius * rand(0.6, 1));
      const t = dur * rand(0.6, 1);
      this.sprite(p.add(off), { v: off.scale(-1 / t), dur: t, size: rand(0.03, 0.06), cell: S.spark, color: c, mode: 1, stretch: 0.04, hot: 1, fadeIn: 0.3, fadeOut: 0.85 });
    }
    this.sprite(p, { dur: dur * 1.1, size: 0.05, size1: 0.35, cell: S.glow, color: c, ease: 0, fadeIn: 0.3, fadeOut: 0.8, hot: 1 });
  }

  // ================================================================ weapon trails
  private makeTrail(i: number): Trail {
    const n = TRAIL_POINTS * 2;
    const mesh = new Mesh('fxTrail' + i, this.scene);
    mesh.parent = this.root;
    const pos = new Float32Array(n * 3);
    const tr = new Float32Array(n * 4);
    const col = new Float32Array(n * 4);
    const idx: number[] = [];
    for (let k = 0; k < TRAIL_POINTS - 1; k++) {
      const a = k * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const vd = new VertexData();
    vd.positions = pos;
    vd.indices = idx;
    vd.applyToMesh(mesh, true);
    mesh.setVerticesData('trA', tr, true, 4);
    mesh.setVerticesData('color', col, true, 4);
    mesh.material = this.trailMat;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
    mesh.isPickable = false;
    mesh.alphaIndex = 43;
    mesh.setEnabled(false);
    return { mesh, pos, tr, col, samples: [], raw: [], start: 0, until: 0, life: 0.2, hand: null, weapon: null, local: null, color: [1, 1, 1], busy: false };
  }

  /**
   * A ribbon swept by the weapon held in `hand` (a hand-slot node) from
   * `delay` for `dur` seconds: white-hot at the blade's edge, fading to
   * `color` toward the grip and along its tail.
   */
  weaponTrail(hand: TransformNode | null | undefined, color: string, delay: number, dur: number, o: { life?: number; intensity?: number } = {}) {
    if (!hand) return;
    const weapon = this.findWeapon(hand);
    if (!weapon) return;
    const tr = this.trails.find((t) => !t.busy) ?? this.trails.reduce((a, b) => (a.until < b.until ? a : b));
    tr.busy = true;
    tr.hand = hand;
    tr.weapon = weapon;
    tr.local = this.weaponEnds(weapon, hand);
    tr.start = this.time + delay;
    tr.until = tr.start + dur;
    tr.life = o.life ?? 0.24;
    tr.color = C(color, 2.6 * (o.intensity ?? 1));
    tr.samples.length = 0;
    tr.raw.length = 0;
    const c = tr.col;
    for (let k = 0; k < c.length; k += 4) {
      c[k] = tr.color[0];
      c[k + 1] = tr.color[1];
      c[k + 2] = tr.color[2];
      c[k + 3] = tr.life;
    }
    tr.mesh.updateVerticesData('color', c);
  }

  private findWeapon(hand: TransformNode): AbstractMesh | null {
    let best: AbstractMesh | null = null;
    let bestLen = 0;
    for (const m of hand.getChildMeshes(false)) {
      if (!m.isEnabled() || m.getTotalVertices() === 0) continue;
      const bb = m.getBoundingInfo().boundingBox;
      const ext = bb.maximum.subtract(bb.minimum).multiply(m.absoluteScaling);
      const l = Math.max(ext.x, ext.y, ext.z);
      if (l > bestLen) {
        bestLen = l;
        best = m;
      }
    }
    return best;
  }

  /** Grip-side and tip points of a weapon in its local space (longest axis; the tip is the end away from the hand). */
  private weaponEnds(m: AbstractMesh, hand: TransformNode): [Vector3, Vector3] {
    const cached = this.weaponCache.get(m);
    if (cached) return cached;
    const bb = m.getBoundingInfo().boundingBox;
    const mn = bb.minimum;
    const mx = bb.maximum;
    const ext = mx.subtract(mn);
    const axis = ext.x > ext.y && ext.x > ext.z ? 'x' : ext.y > ext.z ? 'y' : 'z';
    const a = bb.center.clone();
    const b = bb.center.clone();
    a[axis] = mn[axis];
    b[axis] = mx[axis];
    const wm = m.computeWorldMatrix(true);
    const hp = hand.getAbsolutePosition();
    const da = Vector3.Distance(Vector3.TransformCoordinates(a, wm), hp);
    const db = Vector3.Distance(Vector3.TransformCoordinates(b, wm), hp);
    const tip = da > db ? a : b;
    const near = da > db ? b : a;
    // stretch the ribbon a little past the blade so chibi-sized weapons still sweep a bold arc
    const grip = Vector3.Lerp(near, tip, 0.2);
    const r: [Vector3, Vector3] = [grip, tip.add(tip.subtract(near).scale(0.3))];
    this.weaponCache.set(m, r);
    return r;
  }

  private sampleTrails() {
    const now = this.time;
    for (const tr of this.trails) {
      if (!tr.busy) continue;
      const w = tr.weapon;
      if (!w || w.isDisposed() || now > tr.until + tr.life) {
        tr.busy = false;
        tr.mesh.setEnabled(false);
        continue;
      }
      if (now < tr.start) continue;
      if (now <= tr.until && tr.local) {
        const wm = w.computeWorldMatrix(true);
        const b = Vector3.TransformCoordinates(tr.local[0], wm);
        const t = Vector3.TransformCoordinates(tr.local[1], wm);
        const last = tr.raw[tr.raw.length - 1];
        if (!last || Vector3.DistanceSquared(last.t, t) > 1e-5) {
          tr.raw.push({ b, t });
          if (tr.raw.length > 4) tr.raw.shift();
          this.addTrailSamples(tr, now);
        }
      }
      // drop old samples
      while (tr.samples.length && now - tr.samples[0].time > tr.life) tr.samples.shift();
      this.writeTrail(tr, now);
    }
  }

  /** Catmull-Rom between the last two raw samples so fast swings stay round at low frame rates. */
  private addTrailSamples(tr: Trail, now: number) {
    const r = tr.raw;
    const n = r.length;
    const p2 = r[n - 1];
    if (n === 1) {
      tr.samples.push({ b: p2.b.clone(), t: p2.t.clone(), time: now });
      return;
    }
    const p1 = r[n - 2];
    const p0 = n > 2 ? r[n - 3] : p1;
    const p3 = { b: p2.b.add(p2.b.subtract(p1.b)), t: p2.t.add(p2.t.subtract(p1.t)) };
    const dist = Vector3.Distance(p1.t, p2.t);
    const steps = Math.min(8, Math.max(1, Math.ceil(dist / 0.07)));
    const prevTime = tr.samples.length ? tr.samples[tr.samples.length - 1].time : now;
    for (let i = 1; i <= steps; i++) {
      const s = i / steps;
      tr.samples.push({
        b: Vector3.CatmullRom(p0.b, p1.b, p2.b, p3.b, s),
        t: Vector3.CatmullRom(p0.t, p1.t, p2.t, p3.t, s),
        time: prevTime + (now - prevTime) * s,
      });
    }
    while (tr.samples.length > TRAIL_POINTS) tr.samples.shift();
  }

  private writeTrail(tr: Trail, now: number) {
    const s = tr.samples;
    const n = s.length;
    if (n < 2) {
      tr.mesh.setEnabled(false);
      return;
    }
    tr.mesh.setEnabled(true);
    const pos = tr.pos;
    const ta = tr.tr;
    for (let i = 0; i < TRAIL_POINTS; i++) {
      const smp = s[Math.max(0, n - 1 - i)];
      const k = i * 2;
      const along = Math.min(1, i / Math.max(1, n - 1));
      pos[k * 3] = smp.b.x;
      pos[k * 3 + 1] = smp.b.y;
      pos[k * 3 + 2] = smp.b.z;
      pos[k * 3 + 3] = smp.t.x;
      pos[k * 3 + 4] = smp.t.y;
      pos[k * 3 + 5] = smp.t.z;
      const stamp = i < n ? smp.time : now - 10;
      ta[k * 4] = stamp;
      ta[k * 4 + 1] = 0;
      ta[k * 4 + 2] = along;
      ta[k * 4 + 4] = stamp;
      ta[k * 4 + 5] = 1;
      ta[k * 4 + 6] = along;
    }
    tr.mesh.updateVerticesData('position', pos);
    tr.mesh.updateVerticesData('trA', ta);
  }

  // ================================================================ afterimages
  /**
   * A glowing copy of a character frozen in its current pose that dissolves
   * (blink afterimages, departing souls). Skinning is done once on the CPU.
   */
  afterimage(meshes: AbstractMesh[], color: string, o: { dur?: number; rise?: number; intensity?: number; alpha?: number } = {}) {
    if (this.ghosts.length >= 4) {
      this.ghosts[0].mesh.dispose();
      this.ghosts.shift();
    }
    const dur = o.dur ?? 0.6;
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    const tmpP = new Vector3();
    const tmpN = new Vector3();
    for (const m of meshes) {
      if (!m.isEnabled() || !(m instanceof Mesh) || m.getTotalVertices() === 0) continue;
      const p = m.getPositionData(true, true);
      const nr = m.getNormalsData(true, true);
      const ind = m.getIndices();
      if (!p || !nr || !ind) continue;
      const wm = m.computeWorldMatrix(true);
      const base = positions.length / 3;
      for (let i = 0; i < p.length; i += 3) {
        Vector3.TransformCoordinatesFromFloatsToRef(p[i], p[i + 1], p[i + 2], wm, tmpP);
        Vector3.TransformNormalFromFloatsToRef(nr[i], nr[i + 1], nr[i + 2], wm, tmpN);
        tmpN.normalize();
        positions.push(tmpP.x, tmpP.y, tmpP.z);
        normals.push(tmpN.x, tmpN.y, tmpN.z);
      }
      for (let i = 0; i < ind.length; i++) indices.push(ind[i] + base);
    }
    if (!positions.length) return;
    const nv = positions.length / 3;
    const gh = new Float32Array(nv * 4);
    const col = new Float32Array(nv * 4);
    const c = C(color, o.intensity ?? 2.2);
    for (let i = 0; i < nv; i++) {
      gh[i * 4] = this.time;
      gh[i * 4 + 1] = dur;
      gh[i * 4 + 2] = o.rise ?? 0;
      col[i * 4] = c[0];
      col[i * 4 + 1] = c[1];
      col[i * 4 + 2] = c[2];
      col[i * 4 + 3] = o.alpha ?? 1;
    }
    const mesh = new Mesh('fxGhost', this.scene);
    mesh.parent = this.root;
    const vd = new VertexData();
    vd.positions = positions;
    vd.normals = normals;
    vd.indices = indices;
    vd.applyToMesh(mesh, false);
    mesh.setVerticesData('ghA', gh, false, 4);
    mesh.setVerticesData('color', col, false, 4);
    mesh.material = this.ghostMat;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.alphaIndex = 43;
    this.ghosts.push({ mesh, end: this.time + dur });
  }

  // ================================================================ missiles
  /**
   * A missile from `from` along `dir` (unit, may include y). `hit` is polled
   * each frame with the head position and returns true when it struck.
   */
  missile(from: Vector3, dir: Vector3, speed: number, range: number, kind: MissileKind, color: string, hit: (p: Vector3) => boolean, onEnd?: (p: Vector3, struck: boolean) => void): Missile {
    const m: Missile = { pos: from.clone(), alive: true };
    const c = C(color, 1);
    const life = range / speed + 0.1;
    const v = dir.scale(speed);
    const heads: Handle[] = [];
    const head = (o: Omit<SpriteO, 'v' | 'dur'>) => heads.push(this.sprite(from, { ...o, v, dur: life, fadeIn: 0, fadeOut: 0.97 }));
    switch (kind) {
      case 'arrow':
      case 'arrow_heavy':
      case 'pierce':
      case 'snare': {
        const big = kind !== 'arrow';
        head({ size: big ? 0.09 : 0.06, cell: S.spark, color: scale(c, 5), mode: 1, stretch: big ? 0.032 : 0.026, hot: 1 });
        head({ size: big ? 0.3 : 0.2, cell: S.spark, color: scale(c, 1.6), alpha: 0.7, mode: 1, stretch: big ? 0.05 : 0.035, hot: 0.3 });
        head({ size: big ? 0.38 : 0.22, cell: S.glow, color: scale(c, 1.8), alpha: 0.9, hot: 0.8 });
        if (kind === 'arrow_heavy') head({ size: 0.45, cell: S.star4, color: scale(c, 3), spin: 6, hot: 1 });
        if (kind === 'pierce') head({ size: 0.55, cell: S.cross, color: scale(c, 2.5), spin: 3, hot: 1 });
        break;
      }
      case 'fire':
        head({ size: 0.55, cell: S.fire, color: C('#ff9a3a', 3.2), hot: 1, rot: 0, spin: 4 });
        head({ size: 1.4, cell: S.glow, color: C('#ff7a1a', 1.4), alpha: 0.75, hot: 0.4 });
        head({ size: 0.3, cell: S.glow, color: C('#fff0c0', 4), hot: 1 });
        break;
      case 'hex':
        head({ size: 0.42, cell: S.orb, color: C(color, 3), hot: 0.9 });
        head({ size: 0.9, cell: S.glow, color: C(color, 1.2), alpha: 0.7, hot: 0.3 });
        head({ size: 0.5, cell: S.runeA, color: C(color, 2.5), spin: 5, hot: 0.7 });
        break;
      default: {
        const big = kind === 'bolt_big';
        head({ size: big ? 0.48 : 0.32, cell: S.orb, color: scale(c, 3.2), hot: 0.9 });
        head({ size: big ? 1.1 : 0.7, cell: S.glow, color: scale(c, 1.4), alpha: 0.8, hot: 0.3 });
        head({ size: big ? 0.75 : 0.5, cell: S.star4, color: scale(c, 3), spin: 7, hot: 1 });
        if (big) head({ size: 0.8, cell: S.ring, color: scale(c, 2), spin: -3, hot: 0.6 });
        break;
      }
    }
    this.missiles.push({ m, dir: dir.clone(), speed, range, travelled: 0, kind, color: c, heads, emit: 0, hit, onEnd, ended: false });
    return m;
  }

  private updateMissiles(dt: number) {
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const s = this.missiles[i];
      const step = Math.min(s.speed * dt, s.range - s.travelled);
      const prev = s.m.pos.clone();
      // swept test in short hops so fast arrows can't tunnel through a target at low frame rates
      const hops = Math.max(1, Math.ceil(step / 0.3));
      let struck = false;
      let done = false;
      let moved = 0;
      for (let k = 1; k <= hops && !done; k++) {
        moved = (step * k) / hops;
        const q = prev.add(s.dir.scale(moved));
        if (s.hit(q)) struck = done = true;
        else if (q.y < this.ground(q.x, q.z) - 0.2) done = true;
      }
      s.m.pos.copyFrom(prev.add(s.dir.scale(moved)));
      s.travelled += moved;
      this.emitTrail(s, prev, moved);
      const p = s.m.pos;
      if (s.travelled >= s.range - 1e-4) done = true;
      if (done) {
        s.ended = true;
        s.m.alive = false;
        for (const h of s.heads) this.kill(h);
        this.missiles.splice(i, 1);
        s.onEnd?.(p.clone(), struck);
      }
    }
  }

  private emitTrail(s: MissileState, prev: Vector3, step: number) {
    const spacing = s.kind === 'fire' ? 0.22 : s.kind === 'pierce' ? 0.18 : s.kind.startsWith('bolt') || s.kind === 'hex' || s.kind === 'frost' ? 0.2 : 0.32;
    s.emit += step;
    const c = s.color;
    while (s.emit >= spacing) {
      s.emit -= spacing;
      const back = s.emit; // distance behind the head
      const along = s.travelled - back;
      const p = prev.add(s.dir.scale(step - back));
      switch (s.kind) {
        case 'arrow':
        case 'arrow_heavy':
        case 'snare':
          this.sprite(p.add(randDir().scale(0.05)), { v: randDir().scale(0.4), dur: rand(0.2, 0.4), size: rand(0.03, 0.06), cell: s.kind === 'snare' && Math.random() < 0.3 ? S.leaf : S.glow, color: scale(c, 3), hot: 1, spin: rand(-4, 4), rot: rand(0, TAU) });
          if (s.kind === 'arrow_heavy' && Math.random() < 0.4) this.sprite(p, { dur: 0.3, size: 0.12, size1: 0.02, cell: S.star4, color: scale(c, 4), hot: 1, rot: rand(0, 1) });
          break;
        case 'pierce': {
          // two-strand spiralling wind ribbon around the flight line
          const side = Vector3.Cross(s.dir, UP).normalize();
          const up = Vector3.Cross(side, s.dir).normalize();
          for (const ph of [0, Math.PI]) {
            const a = along * 2.6 + ph;
            const r = 0.24;
            const q = p.add(side.scale(Math.cos(a) * r)).addInPlace(up.scale(Math.sin(a) * r));
            this.sprite(q, { v: side.scale(Math.cos(a) * 0.8).addInPlace(up.scale(Math.sin(a) * 0.8)), dur: 0.45, size: 0.07, size1: 0.02, cell: S.glow, color: scale(c, 3), hot: 1, fadeIn: 0 });
          }
          if (Math.floor(along / 2.4) !== Math.floor((along - spacing) / 2.4)) {
            this.sprite(p, { dur: 0.35, size: 0.15, size1: 0.75, cell: S.shock, color: scale(c, 2.4), mode: 2, axis: s.dir, ease: 1.5, hot: 0.8, fadeIn: 0 });
          }
          break;
        }
        case 'fire':
          this.sprite(p.add(randDir().scale(0.1)), { v: new Vector3(0, 1.2, 0).addInPlace(randDir().scale(0.6)), dur: rand(0.25, 0.4), size: rand(0.35, 0.5), size1: 0.08, cell: S.fire, color: C('#ff8a2a', 2.6), hot: 0.8, fadeIn: 0 });
          this.sprite(p, { v: new Vector3(0, 1.4, 0).addInPlace(randDir().scale(0.4)), dur: rand(0.6, 0.9), size: 0.2, size1: 0.7, cell: S.smoke, color: [0.09, 0.07, 0.06], alpha: 0.5, occl: 1, hot: 0, drag: 1.5, rot: rand(0, TAU), spin: rand(-1, 1), ease: 1, fadeIn: 0.15, delay: 0.08 });
          if (Math.random() < 0.6) this.sprite(p, { v: randDir(0.3).scale(rand(1.5, 4)), dur: rand(0.4, 0.7), size: 0.03, cell: S.spark, color: C('#ffb04a', 4), mode: 1, stretch: 0.04, gravity: -1, drag: 2, hot: 1 });
          break;
        case 'hex':
          this.sprite(p, { v: randDir().scale(0.3), dur: 0.6, size: 0.15, size1: 0.45, cell: S.smoke, color: [0.05, 0.01, 0.08], alpha: 0.5, occl: 1, hot: 0, rot: rand(0, TAU), ease: 1, fadeIn: 0.1 });
          this.sprite(p.add(randDir().scale(0.12)), { v: randDir().scale(0.5), dur: 0.35, size: 0.05, cell: S.glow, color: scale(c, 3), hot: 1 });
          break;
        default: {
          // arcane bolt: twin spiral of motes plus sparkle dust
          const side = Vector3.Cross(s.dir, UP).normalize();
          const up = Vector3.Cross(side, s.dir).normalize();
          const big = s.kind === 'bolt_big';
          for (const ph of [0, Math.PI]) {
            const a = along * (big ? 5 : 7) + ph;
            const r = big ? 0.24 : 0.16;
            const q = p.add(side.scale(Math.cos(a) * r)).addInPlace(up.scale(Math.sin(a) * r));
            this.sprite(q, { dur: 0.32, size: big ? 0.09 : 0.065, size1: 0.01, cell: S.glow, color: scale(c, 3.2), hot: 1, fadeIn: 0 });
          }
          if (Math.random() < 0.5) this.sprite(p.add(randDir().scale(0.15)), { v: randDir().scale(0.6), dur: 0.4, size: 0.06, cell: s.kind === 'frost' ? S.snow : S.star4, color: scale(c, 3), hot: 1, rot: rand(0, TAU), spin: rand(-4, 4) });
          break;
        }
      }
    }
  }

  // ================================================================ signature effects
  /** Fireball explosion: flame bloom, embers, rolling smoke, shockwave and a scorch mark. */
  explosion(g: Vector3, radius = 3.5) {
    const up = (h: number) => new Vector3(g.x, g.y + h, g.z);
    this.flash(up(1), C('#ffe0a0', 5), radius * 1.2, 0.22);
    this.sprite(up(0.9), { dur: 0.16, size: 0.6, size1: radius * 0.9, cell: S.glow, color: C('#fff4d8', 6), hot: 1, ease: 2, fadeIn: 0, fadeOut: 0.1 });
    for (let i = 0; i < 6; i++) {
      const d = randDir(0.55);
      this.sprite(up(0.7).addInPlace(d.scale(0.3)), { v: d.scale(rand(3, 5.5)), drag: 4, dur: rand(0.55, 0.8), size: 0.5, size1: radius * rand(0.36, 0.5), cell: S.fire, color: C('#ff8a2a', 3.0), hot: 0.9, occl: 0.55, ease: 1.4, fadeIn: 0, fadeOut: 0.8, spin: rand(-1.5, 1.5), rot: rand(0, TAU) });
    }
    this.sprite(up(0.9), { dur: 0.55, size: 0.6, size1: radius * 0.62, cell: S.fire, color: C('#ffb050', 3.4), hot: 1, occl: 0.4, ease: 2, fadeIn: 0, fadeOut: 0.8 });
    this.shockRing(up(0.25), C('#ffb04a', 2.2), 0.4, radius * 1.25, 0.32, UP);
    this.shockRing(up(1.0), C('#fff0c0', 2.4), 0.3, radius * 0.9, 0.22);
    // embers
    for (let i = 0; i < 36; i++) {
      const d = randDir(0.45);
      this.sprite(up(0.5), { v: d.scale(rand(5, 13)), dur: rand(0.6, 1.2), size: rand(0.03, 0.06), cell: S.spark, color: C(Math.random() < 0.5 ? '#ffb04a' : '#ff6a1a', 4), mode: 1, stretch: 0.035, drag: 2.5, gravity: 7, hot: 1, flicker: 0.3 });
    }
    // flame tongues licking up
    for (let i = 0; i < 10; i++) {
      const a = rand(0, TAU);
      const r = rand(0.3, radius * 0.6);
      this.sprite(new Vector3(g.x + Math.cos(a) * r, g.y + 0.3, g.z + Math.sin(a) * r), { v: new Vector3(0, rand(2, 4), 0), drag: 2, dur: rand(0.4, 0.7), size: rand(0.4, 0.7), size1: 0.1, cell: S.flame, color: C('#ff9a3a', 3), mode: 3, hot: 1, delay: rand(0, 0.15) });
    }
    this.smoke(up(0.8), [0.06, 0.05, 0.045], { n: 12, size: radius * 0.42, dur: 1.9, spread: radius * 0.3, rise: 1.8, speed: 2.8, alpha: 0.7, delay: 0.18 });
    this.decal(g.x, g.y, g.z, { r0: radius * 0.4, r: radius * 1.25, dur: 0.5, cell: D.shock, color: C('#ff9a3a', 3), mode: 0, fadeIn: 0, fadeOut: 0.25 });
    this.decal(g.x, g.y, g.z, { r0: radius * 0.6, r: radius, dur: 0.9, cell: D.soft, color: C('#ff7a1a', 2.2), fadeIn: 0, fadeOut: 0.2, hot: 0.5 });
    this.decal(g.x, g.y, g.z, { r0: radius * 0.8, r: radius * 0.95, dur: 5, cell: D.scorch, color: [0.02, 0.015, 0.012], alpha: 0.85, occl: 1, hot: 0, fadeIn: 0.02, fadeOut: 0.6 });
    this.decal(g.x, g.y, g.z, { r0: radius * 0.8, r: radius * 0.95, dur: 2.2, cell: D.scorch, color: C('#ff6a1a', 2.5), fadeIn: 0.05, fadeOut: 0.2, hot: 1, lift: 0.08 });
  }

  /** Frost nova: crystals burst from the ground in a ring, then shatter. */
  frostNova(c: Vector3, radius = 6) {
    const ice = C('#8fe8ff', 1);
    this.flash(c.add(new Vector3(0, 1, 0)), C('#d8f8ff', 4), 3.2, 0.3);
    this.decal(c.x, c.y, c.z, { r0: 0.5, r: radius, dur: 0.7, cell: D.shock, color: C('#bff4ff', 3), mode: 0, fadeIn: 0, fadeOut: 0.3 });
    this.decal(c.x, c.y, c.z, { r0: radius * 0.3, r: radius * 1.02, dur: 2.2, cell: D.frost, color: C('#8fe8ff', 2.4), spin: 0.15, fadeIn: 0.12, fadeOut: 0.6, hot: 0.8 });
    this.decal(c.x, c.y, c.z, { r0: radius * 0.5, r: radius * 1.1, dur: 2.0, cell: D.soft, color: C('#bff4ff', 0.5), fadeIn: 0.1, fadeOut: 0.5, hot: 0 });
    this.shockRing(c.add(new Vector3(0, 0.3, 0)), C('#bff4ff', 1.6), 0.4, radius * 1.05, 0.38, UP);
    const life = 1.25;
    const rings = [
      { n: 9, r: radius * 0.42, len: [0.7, 1.1] },
      { n: 14, r: radius * 0.78, len: [1.0, 1.9] },
    ];
    for (const ring of rings) {
      for (let i = 0; i < ring.n; i++) {
        const a = (i / ring.n) * TAU + rand(-0.15, 0.15);
        const r = ring.r * rand(0.85, 1.1);
        const x = c.x + Math.sin(a) * r;
        const z = c.z + Math.cos(a) * r;
        const y = this.ground(x, z);
        const out = new Vector3(Math.sin(a), 0, Math.cos(a));
        const axis = out.scale(rand(0.35, 0.8)).addInPlace(new Vector3(0, 1, 0)).normalize();
        const delay = (r / radius) * 0.14;
        const len = rand(ring.len[0], ring.len[1]);
        const p = new Vector3(x, y, z);
        this.shard(p, { dur: life, axis, len, width: len * rand(0.16, 0.24), color: ice, style: 0, grow: 0.12, delay });
        // little side crystals
        if (Math.random() < 0.6) {
          const ax2 = axis.add(randDir().scale(0.5)).normalize();
          this.shard(p, { dur: life * 0.95, axis: ax2, len: len * 0.5, width: len * 0.12, color: ice, style: 0, grow: 0.14, delay: delay + 0.03 });
        }
        this.sprite(p.add(new Vector3(0, 0.2, 0)), { v: axis.scale(3), dur: 0.3, size: 0.06, cell: S.spark, color: C('#e8fcff', 4), mode: 1, stretch: 0.05, drag: 4, hot: 1, delay });
        // shatter
        this.after(delay + life * 0.8, () => {
          const top = p.add(axis.scale(len * 0.6));
          for (let k = 0; k < 4; k++) {
            const d = randDir(0.4);
            this.sprite(top, { v: d.scale(rand(2, 5)), dur: rand(0.4, 0.7), size: rand(0.06, 0.12), cell: S.shard, color: C('#bff4ff', 2.6), gravity: 9, drag: 1, rot: rand(0, TAU), spin: rand(-12, 12), hot: 0.8, fadeIn: 0 });
          }
          this.sprite(top, { dur: 0.25, size: 0.1, size1: 0.5, cell: S.star4, color: C('#e8fcff', 4), hot: 1, rot: rand(0, 1), fadeIn: 0 });
          if (Math.random() < 0.5) this.smoke(top, [0.75, 0.88, 0.95], { n: 1, size: 0.6, dur: 0.8, spread: 0.1, rise: 0.4, alpha: 0.25 });
        });
      }
    }
    // cold mist and drifting snow
    this.smoke(c.add(new Vector3(0, 0.3, 0)), [0.8, 0.92, 1], { n: 10, size: 1.0, dur: 1.6, spread: radius * 0.5, rise: 0.3, speed: 3, alpha: 0.28 });
    for (let i = 0; i < 24; i++) {
      const d = randDir(0.3);
      this.sprite(c.add(new Vector3(0, 0.6, 0)), { v: d.scale(rand(3, 8)), drag: 2.5, gravity: -0.4, dur: rand(0.8, 1.5), size: rand(0.06, 0.13), cell: S.snow, color: C('#e8fcff', 3), rot: rand(0, TAU), spin: rand(-3, 3), hot: 0.8, flicker: 0.2 });
    }
    this.sparks(c.add(new Vector3(0, 0.4, 0)), C('#bff4ff', 3.5), { n: 24, speed: 12, up: 0.1, dur: 0.45, gravity: 3 });
  }

  /** Healing light: lotus circle, spiralling ribbons of light, leaves and sparkles. */
  heal(c: Vector3, color = '#ffe58a', radius = 10) {
    const k = C(color, 1);
    this.magicCircle(c, color, { radius: 2.0, dur: 1.5, cell: D.sun, spin: 0.6, intensity: 2.2 });
    this.decal(c.x, c.y, c.z, { r0: 0.6, r: radius, dur: 0.9, cell: D.shock, color: C(color, 2.2), mode: 0, fadeIn: 0, fadeOut: 0.3 });
    for (let i = 0; i < 3; i++) {
      this.shape(c, { mode: 2, dur: 1.3, radius: 0.85, len: 2.8, width: 0.16, turns: 1.6, color: scale(k, i === 1 ? 3.5 : 2.6), seed: i / 3, head: 1.6, rise: 0.4, grow: 0.55, spin: 1.2, hot: 0.9, fadeOut: 0.6, delay: i * 0.05 });
    }
    this.shape(c, { mode: 1, dur: 1.0, radius: 0.95, len: 3.2, width: 0.6, turns: 9, color: scale(k, 1.0), alpha: 0.5, head: 3, hot: 0.4, fadeOut: 0.4 });
    this.motes(c, scale(k, 3), { n: 20, radius: 1.2, height: 3, dur: 1.3 });
    for (let i = 0; i < 10; i++) {
      const a = rand(0, TAU);
      const r = rand(0.3, 1.3);
      this.sprite(new Vector3(c.x + Math.cos(a) * r, c.y + rand(0.2, 1.5), c.z + Math.sin(a) * r), {
        v: new Vector3(Math.cos(a) * 0.4, rand(0.6, 1.4), Math.sin(a) * 0.4),
        dur: rand(1.0, 1.6),
        size: rand(0.07, 0.12),
        cell: Math.random() < 0.5 ? S.leaf : S.petal,
        color: Math.random() < 0.5 ? C('#b8ff9a', 2.4) : scale(k, 2.4),
        rot: rand(0, TAU),
        spin: rand(-3, 3),
        mode: 0,
        hot: 0.4,
        fadeIn: 0.15,
        delay: rand(0, 0.3),
      });
    }
    this.flash(c.add(new Vector3(0, 1.9, 0)), C('#fff2b0', 3), 2.2, 0.35);
  }

  /** Blink: dissolving afterimage, a stream of light between both points, circles at each end. */
  blink(from: Vector3, to: Vector3, color = '#b49bff', meshes?: AbstractMesh[]) {
    if (meshes) this.afterimage(meshes, color, { dur: 0.55, intensity: 2.6 });
    const c = C(color, 3);
    const a = from.add(new Vector3(0, 1, 0));
    const b = to.add(new Vector3(0, 1, 0));
    this.flash(a, c, 2.0, 0.22);
    this.sprite(a, { dur: 0.3, size: 0.3, size1: 1.4, cell: S.star4, color: scale(c, 1.4), hot: 1, rot: 0.2, spin: 3, fadeIn: 0 });
    this.shape(from, { mode: 1, dur: 0.35, radius: 0.5, len: 2.4, width: 0.2, turns: 5, color: scale(c, 0.9), head: 6, grow: 0.2, hot: 0.7, fadeOut: 0.3 });
    const d = b.subtract(a);
    for (let i = 0; i < 26; i++) {
      const s = Math.random();
      const p = a.add(d.scale(s * 0.3)).addInPlace(randDir().scale(0.35));
      this.sprite(p, { v: d.scale(rand(2.2, 3.4)), drag: 3.5, dur: rand(0.3, 0.5), size: rand(0.03, 0.06), cell: S.spark, color: c, mode: 1, stretch: 0.05, hot: 1, delay: s * 0.05 });
    }
    this.magicCircle(to, color, { radius: 1.3, dur: 0.6, spin: 3, intensity: 2.6, inner: false });
    this.flash(b, C('#e4dcff', 3.5), 2.4, 0.26);
    this.shockRing(b, scale(c, 0.8), 0.2, 1.6, 0.3);
    this.motes(to, c, { n: 10, radius: 0.6, height: 1.6, dur: 0.6 });
  }

  /** Level up: a tall pillar of light with rings rising through it. */
  levelUp(c: Vector3) {
    const gold = C('#ffd27a', 1);
    this.shape(c, { mode: 1, dur: 1.9, radius: 1.05, len: 16, width: 0.75, turns: 8, color: scale(gold, 1.6), head: 4, hot: 0.6, fadeOut: 0.55 });
    this.shape(c, { mode: 1, dur: 1.6, radius: 0.32, len: 18, width: 0.6, turns: 4, color: C('#fff4d0', 4), head: 5, hot: 1, fadeOut: 0.5 });
    for (let i = 0; i < 5; i++) {
      this.shape(c, { mode: 4, dur: 1.3, radius: 1.5 - i * 0.12, len: 0, width: 0.14, turns: 1, color: scale(gold, 3), rise: 5 + i * 1.2, grow: 0.65, hot: 1, delay: 0.1 + i * 0.16, fadeOut: 0.5 });
    }
    this.magicCircle(c, '#ffd27a', { radius: 3, dur: 2.2, cell: D.ascend, spin: 0.5, intensity: 2.6 });
    this.decal(c.x, c.y, c.z, { r0: 0.5, r: 6, dur: 1.0, cell: D.shock, color: C('#ffd27a', 2.6), mode: 0, fadeIn: 0, fadeOut: 0.3 });
    this.motes(c, scale(gold, 3), { n: 40, radius: 1.4, height: 7, dur: 1.8, size: 0.09 });
    this.flash(c.add(new Vector3(0, 1.2, 0)), C('#fff2b0', 4), 4, 0.45);
    this.sparks(c.add(new Vector3(0, 0.3, 0)), C('#ffe08a', 4), { n: 20, speed: 10, up: 0.8, gravity: 4, dur: 0.8 });
  }

  /** Rallying cry: golden banner-like pillar, shield crest and a wide ring. */
  rally(c: Vector3) {
    const gold = C('#ffd27a', 1);
    this.shape(c, { mode: 1, dur: 1.4, radius: 1.25, len: 6, width: 0.85, turns: 6, color: scale(gold, 1.3), alpha: 0.8, head: 3, hot: 0.5, fadeOut: 0.5 });
    for (let i = 0; i < 4; i++) {
      this.shape(c, { mode: 2, dur: 1.2, radius: 1.3, len: 5, width: 0.3, turns: 0.35, color: scale(gold, 2.2), seed: i / 4, head: 1.8, spin: 0.8, grow: 0.85, hot: 0.7, fadeOut: 0.5, occl: 0.3 });
    }
    this.magicCircle(c, '#ffd27a', { radius: 2.6, dur: 1.6, cell: D.shield, spin: 0, intensity: 2.6, inner: false });
    this.decal(c.x, c.y, c.z, { r0: 0.5, r: 10, dur: 1.0, cell: D.shock, color: C('#ffd27a', 2.6), mode: 0, fadeIn: 0, fadeOut: 0.3 });
    this.decal(c.x, c.y, c.z, { r0: 0.5, r: 7, dur: 0.85, cell: D.shock, color: C('#fff2b0', 2.0), mode: 0, fadeIn: 0, fadeOut: 0.3, delay: 0.1 });
    this.shape(c, { mode: 4, dur: 0.9, radius: 1.3, len: 0, width: 0.2, color: scale(gold, 3), rise: 2.2, grow: 1.5, hot: 1 });
    this.shape(c, { mode: 4, dur: 0.9, radius: 1.0, len: 0, width: 0.16, color: scale(gold, 3), rise: 3.0, grow: 1.3, hot: 1, delay: 0.12 });
    this.flash(c.add(new Vector3(0, 1.6, 0)), C('#ffe9a8', 2.6), 2.2, 0.3);
    this.motes(c, scale(gold, 3), { n: 30, radius: 1.6, height: 4, dur: 1.3 });
  }

  /** Shield bash: a shock cone thrown forward with a burst of sparks. */
  bash(chest: Vector3, yaw: number, color = '#ffe1a0') {
    const fwd = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const p = chest.add(fwd.scale(0.9));
    const c = C(color, 1);
    this.shape(chest.add(fwd.scale(0.3)), { mode: 3, yaw, dur: 0.32, radius: 1.5, len: 3.0, width: 0, turns: TAU, color: scale(c, 2.6), hot: 0.8, fadeOut: 0.35 });
    this.flash(p, scale(c, 3), 1.8, 0.18);
    this.shockRing(p, scale(c, 2.6), 0.2, 1.8, 0.28, fwd);
    this.shockRing(p.add(fwd.scale(0.8)), scale(c, 1.8), 0.2, 2.4, 0.35, fwd, 0.05);
    this.sparks(p, scale(c, 4), { n: 22, speed: 14, dir: fwd, cone: 0.7, dur: 0.35, gravity: 6 });
    const g = new Vector3(p.x, this.ground(p.x, p.z), p.z);
    this.decal(g.x, g.y, g.z, { r0: 0.3, r: 2.6, dur: 0.45, cell: D.shock, color: scale(c, 2.2), mode: 0, fadeIn: 0, fadeOut: 0.3 });
    this.dust(g.add(fwd.scale(0.8)), 6);
  }

  /** Whirlwind: a spinning vortex of blade arcs and wind streaks. */
  whirlwind(base: Vector3, yaw: number, color: string, radius = 3.6) {
    const c = C(color, 1);
    const dur = 0.5;
    const layers = [
      { h: 0.55, r: radius * 0.85, tilt: 0.12, k: 2.4, w: 1.0 },
      { h: 1.0, r: radius * 0.95, tilt: -0.08, k: 3.0, w: 1.2 },
      { h: 1.45, r: radius * 0.75, tilt: 0.18, k: 2.0, w: 0.8 },
    ];
    layers.forEach((l, i) => {
      const p = base.add(new Vector3(0, l.h, 0));
      const s = { mode: 0, yaw: yaw + i * 2.1, tilt: l.tilt, dur, len: 4.6, head: 1.7, spin: 7.5, fadeOut: 0.55 } as const;
      this.shape(p, { ...s, radius: l.r * 1.03, width: l.w * 1.5, color: scale(c, l.k * 0.4), alpha: 0.3, hot: 0.05, stand: -0.5 });
      this.shape(p, { ...s, radius: l.r, width: l.w * 0.75, color: scale(c, l.k), hot: 0.5, occl: 0.4, stand: 0.4 });
      this.shape(p, { ...s, radius: l.r * 1.01, width: l.w * 0.18, color: scale(c, l.k * 1.8), hot: 1 });
    });
    // translucent wind wall
    this.shape(base, { mode: 1, dur: 0.55, radius: radius * 0.8, len: 2.0, width: 1.2, turns: 11, color: scale(c, 0.8), alpha: 0.45, spin: 6, head: 6, hot: 0.4, fadeOut: 0.4 });
    // wind streaks flung outward
    for (let i = 0; i < 18; i++) {
      const a = rand(0, TAU);
      const r = rand(0.6, radius * 0.9);
      const p = new Vector3(base.x + Math.sin(a) * r, base.y + rand(0.3, 1.8), base.z + Math.cos(a) * r);
      const tan = new Vector3(Math.cos(a), rand(-0.1, 0.2), -Math.sin(a));
      this.sprite(p, { v: tan.scale(rand(9, 16)).addInPlace(new Vector3(Math.sin(a), 0, Math.cos(a)).scale(3)), dur: rand(0.2, 0.35), size: rand(0.04, 0.07), cell: S.spark, color: scale(c, 3), mode: 1, stretch: 0.06, drag: 3, hot: 1, delay: rand(0, 0.25) });
    }
    this.decal(base.x, base.y, base.z, { r0: 0.6, r: radius + 0.4, dur: 0.55, cell: D.shock, color: scale(c, 2.4), mode: 0, fadeIn: 0, fadeOut: 0.3 });
    this.decal(base.x, base.y, base.z, { r0: radius * 0.7, r: radius, dur: 0.7, cell: D.dashes, color: scale(c, 1.6), spin: -9, fadeIn: 0.05, fadeOut: 0.4 });
    this.dust(base, 14, radius * 0.6);
  }

  /** Arrows raining down on an area. */
  volley(x: number, z: number, radius: number, color: string, delay = 0.25) {
    const c = C(color, 1);
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * TAU;
      const r = Math.sqrt(Math.random()) * radius;
      const tx = x + Math.cos(a) * r;
      const tz = z + Math.sin(a) * r;
      const ty = this.ground(tx, tz);
      const from = new Vector3(tx - 3, ty + 15, tz - 1.5);
      const to = new Vector3(tx, ty, tz);
      const d = to.subtract(from);
      const dist = d.length();
      const speed = 40;
      const t = dist / speed;
      const wait = delay + Math.random() * 0.35;
      const v = d.scale(1 / t);
      this.sprite(from, { v, dur: t, size: 0.06, cell: S.spark, color: scale(c, 5), mode: 1, stretch: 0.035, hot: 1, fadeIn: 0, fadeOut: 0.98, delay: wait });
      this.sprite(from, { v, dur: t, size: 0.22, cell: S.spark, color: scale(c, 1.5), alpha: 0.6, mode: 1, stretch: 0.05, hot: 0.3, fadeIn: 0, fadeOut: 0.98, delay: wait });
      this.after(wait + t, () => {
        this.sprite(to.add(new Vector3(0, 0.1, 0)), { dur: 0.16, size: 0.1, size1: 0.5, cell: S.star8, color: scale(c, 3.5), rot: rand(0, TAU), hot: 1, fadeIn: 0 });
        this.sparks(to.add(new Vector3(0, 0.1, 0)), scale(c, 3), { n: 4, speed: 5, up: 0.6, dur: 0.25, gravity: 8 });
        this.decal(tx, ty, tz, { r0: 0.1, r: 0.9, dur: 0.35, cell: D.shock, color: scale(c, 2), mode: 0, fadeIn: 0, fadeOut: 0.3 });
        if (Math.random() < 0.4) this.dust(to, 2, 0.1);
      });
    }
  }

  /** Volley target: a reticle that locks on while it fills. */
  reticle(x: number, z: number, radius: number, dur: number, color: string) {
    const y = this.ground(x, z);
    this.decal(x, y, z, { r0: radius * 1.5, r: radius, dur: dur + 0.35, cell: D.reticle, color: C(color, 2.4), spin: 0.6, fadeIn: 0.25, fadeOut: 0.8, rot: 0 });
    this.decal(x, y, z, { r0: radius * 0.4, r: radius * 0.75, dur: dur + 0.3, cell: D.dashes, color: C(color, 1.8), spin: -2.2, fadeIn: 0.3, fadeOut: 0.8 });
    this.decal(x, y, z, { r0: 0.1, r: radius, dur, cell: D.fill, color: C(color, 0.9), mode: 1, fadeIn: 0.2, hot: 0.4 });
  }

  /** Snare: glowing vines wrap the target over a rune ring. */
  snare(p: Vector3, size = 1, color = '#7dff8a') {
    const g = new Vector3(p.x, this.ground(p.x, p.z), p.z);
    const c = C(color, 1);
    this.magicCircle(g, color, { radius: 1.5 * size, dur: 2.6, cell: D.vines, spin: 0.4, intensity: 2.4, inner: false });
    for (let i = 0; i < 3; i++) {
      this.shape(g, { mode: 2, dur: 2.4, radius: 0.55 * size, len: 1.9 * size, width: 0.08, turns: 1.4, color: scale(c, 2.6), seed: i / 3, head: 2.5, grow: 0.6, hot: 0.8, fadeOut: 0.8 });
    }
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU + rand(-0.2, 0.2);
      const r = rand(0.4, 0.8) * size;
      const q = new Vector3(g.x + Math.sin(a) * r, g.y, g.z + Math.cos(a) * r);
      q.y = this.ground(q.x, q.z);
      const axis = new Vector3(-Math.sin(a) * 0.5, 1, -Math.cos(a) * 0.5).normalize();
      this.shard(q, { dur: 2.4, axis, len: rand(0.5, 0.9) * size, width: 0.07 * size, color: C('#3fdc5a', 1), style: 2, grow: 0.12, delay: i * 0.02 });
    }
    this.flash(p, scale(c, 3), 1.6, 0.2);
    this.motes(g, scale(c, 3), { n: 12, radius: 0.8 * size, height: 1.6, dur: 1.2, cell: S.leaf, size: 0.09 });
  }

  /** Arcane bolt impact. */
  arcaneBurst(p: Vector3, color: string, big: boolean, struck: boolean) {
    const c = C(color, 3);
    const s = big ? 1.6 : 1;
    this.flash(p, c, 1.4 * s, 0.2);
    this.shockRing(p, scale(c, 0.9), 0.2, 1.4 * s, 0.3);
    this.sprite(p, { dur: 0.32, size: 0.3 * s, size1: 1.1 * s, cell: S.star4, color: scale(c, 1.3), spin: 3, hot: 1, fadeIn: 0 });
    for (let i = 0; i < (big ? 18 : 10); i++) {
      const d = randDir();
      this.sprite(p, { v: d.scale(rand(2, 5) * s), drag: 3, dur: rand(0.3, 0.55), size: rand(0.04, 0.08), cell: Math.random() < 0.4 ? S.star4 : S.glow, color: c, hot: 1, rot: rand(0, TAU), spin: rand(-6, 6) });
    }
    if (big && struck) {
      const g = new Vector3(p.x, this.ground(p.x, p.z), p.z);
      this.magicCircle(g, color, { radius: 1.8, dur: 0.6, spin: 4, intensity: 2.4, inner: false });
      this.decal(g.x, g.y, g.z, { r0: 0.3, r: 2.4, dur: 0.4, cell: D.shock, color: C(color, 2.4), mode: 0, fadeIn: 0, fadeOut: 0.3 });
    }
  }

  /**
   * Enemy warning on the ground: a menacing rune ring that appears, and a
   * disc that fills to its edge as the strike lands.
   */
  telegraph(x: number, z: number, radius: number, dur: number, color = '#ff3b2f', cell: number = D.telegraph) {
    const y = this.ground(x, z);
    this.decal(x, y, z, { r0: radius * 1.25, r: radius, dur, cell, color: C(color, 2.2), spin: 0.5, fadeIn: 0.15, fadeOut: 0.97, hot: 0.6 });
    this.decal(x, y, z, { r0: 0, r: radius, dur, cell: D.fill, color: C(color, 1.3), mode: 1, fadeIn: 0.1, hot: 0.6 });
    this.decal(x, y, z, { r0: radius, r: radius, dur, cell: D.soft, color: C(color, 0.35), fadeIn: 0.3, fadeOut: 0.97, hot: 0 });
  }

  /** Ground slam: shockwaves, cracks with a glowing core, flying debris and dust. */
  slam(g: Vector3, radius: number, color: string, boss: boolean) {
    const c = C(color, 1);
    this.flash(g.add(new Vector3(0, 0.6, 0)), scale(c, 4), radius * 1.1, 0.25);
    this.decal(g.x, g.y, g.z, { r0: 0.4, r: radius + 0.6, dur: 0.5, cell: D.shock, color: scale(c, 3), mode: 0, fadeIn: 0, fadeOut: 0.3 });
    this.decal(g.x, g.y, g.z, { r0: 0.4, r: radius * 1.6, dur: 0.75, cell: D.shock, color: scale(c, 1.6), mode: 0, fadeIn: 0, fadeOut: 0.3, delay: 0.08 });
    this.shockRing(g.add(new Vector3(0, 0.3, 0)), scale(c, 2), 0.4, radius * 1.3, 0.4, UP);
    const cr = radius * (boss ? 1.05 : 0.8);
    this.decal(g.x, g.y, g.z, { r0: cr * 0.85, r: cr, dur: boss ? 4.5 : 3, cell: D.cracks, color: [0.025, 0.02, 0.018], alpha: 0.9, occl: 1, hot: 0, fadeIn: 0.02, fadeOut: 0.65 });
    this.decal(g.x, g.y, g.z, { r0: cr * 0.85, r: cr, dur: boss ? 2.6 : 1.6, cell: D.cracks, color: scale(c, 3), fadeIn: 0.02, fadeOut: 0.2, hot: 1, lift: 0.08 });
    const rock = C('#7a6a58', 1);
    for (let i = 0; i < (boss ? 16 : 9); i++) {
      const a = rand(0, TAU);
      const r = rand(0.3, radius * 0.7);
      const p = new Vector3(g.x + Math.cos(a) * r, g.y, g.z + Math.sin(a) * r);
      p.y = this.ground(p.x, p.z);
      const v = new Vector3(Math.cos(a) * rand(1, 4), rand(4, 9), Math.sin(a) * rand(1, 4));
      const s = rand(0.12, 0.3) * (boss ? 1.3 : 1);
      this.shard(p, { v, dur: rand(0.9, 1.3), axis: randDir(), len: s * 1.6, width: s, color: rock, style: 1, gravity: 20, spin: rand(-10, 10), grow: 0.05 });
    }
    this.sparks(g.add(new Vector3(0, 0.3, 0)), scale(c, 3.5), { n: 26, speed: 11, up: 0.7, dur: 0.6, gravity: 9 });
    this.smoke(g.add(new Vector3(0, 0.2, 0)), [0.42, 0.37, 0.31], { n: boss ? 16 : 10, size: 1.1, dur: 1.5, spread: radius * 0.5, rise: 0.6, speed: 4, alpha: 0.5 });
  }

  /** A defeated enemy: its frame lingers as a dissolving soul, wisps rise away. */
  soulRelease(p: Vector3, scaleK: number, eye: string, meshes?: AbstractMesh[]) {
    const c = C(eye, 3);
    if (meshes) this.afterimage(meshes, eye, { dur: 1.1, rise: 0.9, intensity: 1.8, alpha: 0.8 });
    const chest = p.add(new Vector3(0, 1.1 * scaleK, 0));
    this.flash(chest, c, 1.6 * scaleK, 0.3);
    for (let i = 0; i < 8; i++) {
      const a = rand(0, TAU);
      const q = chest.add(new Vector3(Math.cos(a) * 0.3, rand(-0.4, 0.4), Math.sin(a) * 0.3).scale(scaleK));
      this.sprite(q, { v: new Vector3(Math.cos(a) * 0.5, rand(1.5, 2.6), Math.sin(a) * 0.5), drag: 0.6, dur: rand(1.0, 1.6), size: 0.22 * scaleK, size1: 0.08 * scaleK, cell: S.wisp, color: c, mode: 3, hot: 0.9, fadeIn: 0.1, delay: rand(0, 0.3) });
    }
    this.motes(p, scale(c, 1), { n: 14, radius: 0.6 * scaleK, height: 2.5, dur: 1.4 });
    this.smoke(p.add(new Vector3(0, 0.6 * scaleK, 0)), [0.5, 0.48, 0.45], { n: 8, size: 0.6 * scaleK, dur: 1.3, spread: 0.4 * scaleK, rise: 0.6, alpha: 0.45 });
    const g = new Vector3(p.x, this.ground(p.x, p.z), p.z);
    this.decal(g.x, g.y, g.z, { r0: 0.3, r: 2 * scaleK, dur: 0.8, cell: D.shock, color: scale(c, 0.8), mode: 0, fadeIn: 0, fadeOut: 0.3 });
  }

  /** Loot of note: a beam in the rarity colour. */
  lootBeam(p: Vector3, color: string, epic: boolean) {
    const c = C(color, 1);
    this.shape(p, { mode: 1, dur: epic ? 1.8 : 1.1, radius: 0.35, len: epic ? 7 : 4, width: 0.5, turns: 5, color: scale(c, 2.2), head: 4, hot: 0.8, fadeOut: 0.5 });
    this.motes(p, scale(c, 3), { n: epic ? 30 : 14, radius: 0.5, height: 3.5, dur: 1.2 });
    if (epic) {
      this.magicCircle(p, color, { radius: 1.5, dur: 1.6, cell: D.ascend, spin: 1, intensity: 2.4 });
      this.flash(p.add(new Vector3(0, 1.2, 0)), scale(c, 4), 2.6, 0.35);
    }
  }

  /** Rising motes of light (potions, respawns, equipping). */
  column(pos: Vector3, color: string, o: { radius?: number; count?: number; height?: number; dur?: number } = {}) {
    const c = C(color, 1);
    const n = Math.round((o.count ?? 60) * 0.45);
    this.motes(pos, scale(c, 3), { n, radius: o.radius ?? 0.8, height: o.height ?? 2.4, dur: (o.dur ?? 0.6) + 0.6 });
    this.shape(pos, { mode: 1, dur: (o.dur ?? 0.6) + 0.5, radius: (o.radius ?? 0.8) * 0.9, len: o.height ?? 2.4, width: 0.75, turns: 7, color: scale(c, 1.1), alpha: 0.7, head: 3, hot: 0.5, fadeOut: 0.4 });
    this.decal(pos.x, pos.y, pos.z, { r0: 0.2, r: (o.radius ?? 0.8) * 1.6, dur: (o.dur ?? 0.6) + 0.4, cell: D.soft, color: scale(c, 1.2), fadeIn: 0.1, fadeOut: 0.5, hot: 0.3 });
  }

  /** Generic burst of sparks (compatibility helper). */
  burst(pos: Vector3, color: string, o: { count?: number; speed?: number; size?: number; life?: number; gravity?: number; up?: number; additive?: boolean; stretch?: boolean } = {}) {
    if (o.additive === false) {
      this.smoke(pos, C(color, 0.7), { n: Math.ceil((o.count ?? 10) / 3), size: o.size ?? 0.5, dur: o.life ?? 0.8, speed: o.speed ?? 1.5 });
      return;
    }
    this.sparks(pos, C(color, 3), { n: o.count ?? 12, speed: o.speed ?? 5, size: (o.size ?? 0.15) * 0.4, dur: o.life ?? 0.4, gravity: o.gravity ?? 5, up: o.up ?? 0.3 });
  }

  /** Kicked-up dust. */
  dust(pos: Vector3, count = 10, spread = 0.3) {
    this.smoke(pos.add(new Vector3(0, 0.15, 0)), [0.5, 0.44, 0.35], { n: Math.ceil(count * 0.6), size: 0.55, dur: 0.9, spread, rise: 0.35, speed: 1.6, alpha: 0.45 });
  }
}
