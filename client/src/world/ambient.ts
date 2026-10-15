// Ambient life that makes the valley feel inhabited: torch flames, chimney
// smoke, waterfall mist, fireflies at night, butterflies and birds by day,
// and leaves drifting down in the Whisperwood. Everything is procedural and
// only runs near the camera.
import {
  Color3,
  Color4,
  Matrix,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  StandardMaterial,
  TransformNode,
  Vector3,
  VertexData,
  type Scene,
  type Texture,
} from '@babylonjs/core';
import { FALL_S1, Simplex2, VILLAGE_PROPS, forestMask, hash2, riverWaterY, waterAt, type Heightmap } from '@kelia/shared';
import type { Atmosphere } from './atmosphere';
import type { Light } from './props';
import { freezeStatic } from './frozen';
import { createCloudSpriteTexture, createSoftDotTexture } from './textures';
import { riverPointAt } from './water';

interface Emitter {
  pos: Vector3;
  range: number;
  ps: ParticleSystem;
  on: boolean;
  /** Only while it's dark (torches burn brighter, but always burn). */
  nightOnly?: boolean;
}

interface Critter {
  pos: Vector3;
  yaw: number;
  flap: number;
  size: number;
  color: Color3;
  on: boolean;
  phase: number;
  speed: number;
  anchor: Vector3;
  radius: number;
  height: number;
}

const mY = new Matrix();
const mT = new Matrix();
const mBody = new Matrix();
const mS = new Matrix();
const mR = new Matrix();
const mA = new Matrix();
const mB = new Matrix();
const RY_PI = Matrix.RotationY(Math.PI);

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Ambient {
  private dot: Texture;
  private puff: Texture;
  private emitters: Emitter[] = [];
  private fireflies: ParticleSystem;
  private leaves: ParticleSystem;
  private butterflies: Critter[] = [];
  private birds: Critter[] = [];
  private checkT = 0;
  private noise = new Simplex2(4242);
  private time = 0;
  private root: TransformNode;
  /** Every butterfly and bird wing is one thin instance of a single mesh: one draw call for all of them. */
  private wings: Mesh | null = null;
  private wingBuf = new Float32Array(0);
  private haloMat: StandardMaterial | null = null;

  constructor(private scene: Scene, private hm: Heightmap, private atmosphere: Atmosphere, lights: Light[]) {
    this.root = new TransformNode('ambient', scene);
    this.dot = createSoftDotTexture(scene);
    this.puff = createCloudSpriteTexture(scene);

    for (const l of lights) if (l.color.b < 0.5) this.addFlame(l.pos);
    this.addChimneys();
    this.addWaterfallMist();

    this.fireflies = this.makeFireflies(new Vector3(0, 0, 0), 26, 70, new Color3(0.75, 1, 0.35));
    this.fireflies.start();
    this.leaves = this.makeLeaves();
    this.leaves.start();
    this.makeButterflies();
    this.makeBirds();
    this.makeWings();
  }

  // ---------------------------------------------------------------- emitters
  addFlame(pos: Vector3, scale = 1) {
    const ps = new ParticleSystem('flame', 50, this.scene);
    ps.particleTexture = this.dot;
    ps.emitter = pos.clone();
    ps.minEmitBox = new Vector3(-0.06, 0, -0.06).scale(scale);
    ps.maxEmitBox = new Vector3(0.06, 0.05, 0.06).scale(scale);
    ps.color1 = new Color4(1.9, 0.95, 0.3, 1);
    ps.color2 = new Color4(1.7, 0.55, 0.15, 1);
    ps.colorDead = new Color4(0.5, 0.05, 0, 0);
    ps.minSize = 0.12 * scale;
    ps.maxSize = 0.32 * scale;
    ps.minLifeTime = 0.25;
    ps.maxLifeTime = 0.55;
    ps.emitRate = 45;
    ps.direction1 = new Vector3(-0.15, 1, -0.15);
    ps.direction2 = new Vector3(0.15, 1, 0.15);
    ps.minEmitPower = 0.6 * scale;
    ps.maxEmitPower = 1.2 * scale;
    ps.addSizeGradient(0, 1);
    ps.addSizeGradient(1, 0.2);
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.updateSpeed = 1 / 60;
    // a soft glow halo that stays put
    const halo = MeshBuilder.CreatePlane('halo', { size: 1.6 * scale }, this.scene);
    halo.billboardMode = Mesh.BILLBOARDMODE_ALL;
    halo.position.copyFrom(pos).addInPlaceFromFloats(0, 0.15, 0);
    halo.parent = this.root;
    halo.isPickable = false;
    if (!this.haloMat) {
      // one shared material for every halo (fewer state changes per frame)
      const hm = new StandardMaterial('haloMat', this.scene);
      hm.disableLighting = true;
      hm.emissiveColor = new Color3(1, 0.5, 0.15);
      hm.opacityTexture = this.dot;
      hm.alphaMode = 1; // ALPHA_ADD
      hm.disableDepthWrite = true;
      hm.alpha = 0.35;
      this.haloMat = hm;
      freezeStatic(hm);
    }
    halo.material = this.haloMat;
    this.emitters.push({ pos, range: 80, ps, on: false });
    return ps;
  }

  private addSmoke(pos: Vector3, range = 140) {
    const ps = new ParticleSystem('smoke', 60, this.scene);
    ps.particleTexture = this.puff;
    ps.emitter = pos.clone();
    ps.minEmitBox = new Vector3(-0.2, 0, -0.2);
    ps.maxEmitBox = new Vector3(0.2, 0.1, 0.2);
    ps.color1 = new Color4(0.62, 0.62, 0.64, 0.38);
    ps.color2 = new Color4(0.5, 0.5, 0.54, 0.3);
    ps.colorDead = new Color4(0.55, 0.55, 0.6, 0);
    ps.minSize = 0.9;
    ps.maxSize = 1.6;
    ps.addSizeGradient(0, 0.5);
    ps.addSizeGradient(1, 3.2);
    ps.minLifeTime = 4;
    ps.maxLifeTime = 7;
    ps.emitRate = 6;
    ps.direction1 = new Vector3(0.1, 1, -0.05);
    ps.direction2 = new Vector3(0.35, 1, 0.15);
    ps.minEmitPower = 0.5;
    ps.maxEmitPower = 0.9;
    ps.gravity = new Vector3(0.25, 0.05, 0.1);
    ps.minAngularSpeed = -0.4;
    ps.maxAngularSpeed = 0.4;
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    ps.updateSpeed = 1 / 60;
    ps.preWarmCycles = 200;
    ps.preWarmStepOffset = 4;
    this.emitters.push({ pos, range, ps, on: false });
  }

  private addChimneys() {
    for (const p of VILLAGE_PROPS) {
      if (!/building_(tavern|home|blacksmith)/.test(p.prop)) continue;
      // chimneys sit towards the back of the roof
      const back = p.prop.includes('blacksmith') ? 0.25 : 0.15;
      const x = p.x - Math.sin(p.rot) * p.scale * back;
      const z = p.z - Math.cos(p.rot) * p.scale * back;
      const y = this.hm.sample(p.x, p.z) + p.scale * (p.prop.includes('tavern') ? 1.15 : 1.05);
      this.addSmoke(new Vector3(x, y, z));
    }
  }

  private addWaterfallMist() {
    const base = riverPointAt(FALL_S1);
    const y = riverWaterY(FALL_S1);
    const ps = new ParticleSystem('mist', 80, this.scene);
    ps.particleTexture = this.puff;
    const pos = new Vector3(base.x, y, base.z);
    ps.emitter = pos;
    ps.minEmitBox = new Vector3(-4, 0, -4);
    ps.maxEmitBox = new Vector3(4, 0.5, 4);
    ps.color1 = new Color4(0.95, 0.97, 1, 0.3);
    ps.color2 = new Color4(0.85, 0.9, 0.95, 0.22);
    ps.colorDead = new Color4(0.9, 0.95, 1, 0);
    ps.minSize = 2.5;
    ps.maxSize = 5;
    ps.addSizeGradient(0, 0.6);
    ps.addSizeGradient(1, 1.6);
    ps.minLifeTime = 2;
    ps.maxLifeTime = 3.5;
    ps.emitRate = 22;
    ps.direction1 = new Vector3(-0.6, 0.6, -0.6);
    ps.direction2 = new Vector3(0.6, 1.2, 0.6);
    ps.minEmitPower = 0.8;
    ps.maxEmitPower = 1.8;
    ps.gravity = new Vector3(0, -0.1, 0);
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    ps.updateSpeed = 1 / 60;
    this.emitters.push({ pos, range: 180, ps, on: false });
  }

  /** A firefly swarm that stays put (secret spots); runs only when the camera is near. */
  addFireflyPatch(pos: Vector3, box: number, count: number, color: Color3, range = 90) {
    const ps = this.makeFireflies(pos, box, count, color);
    this.emitters.push({ pos: pos.clone(), range, ps, on: false });
  }

  /** Blinking motes of light in a box around `pos` (moves with the camera unless fixed). */
  makeFireflies(pos: Vector3, box: number, count: number, color: Color3) {
    const ps = new ParticleSystem('fireflies', count, this.scene);
    ps.particleTexture = this.dot;
    ps.emitter = pos.clone();
    ps.minEmitBox = new Vector3(-box, 0.3, -box);
    ps.maxEmitBox = new Vector3(box, 2.6, box);
    const c = (a: number) => new Color4(color.r * 2.2, color.g * 2.2, color.b * 2.2, a);
    ps.addColorGradient(0, c(0));
    ps.addColorGradient(0.15, c(1));
    ps.addColorGradient(0.35, c(0.15));
    ps.addColorGradient(0.55, c(1));
    ps.addColorGradient(0.8, c(0.2));
    ps.addColorGradient(1, c(0));
    ps.minSize = 0.07;
    ps.maxSize = 0.13;
    ps.minLifeTime = 3;
    ps.maxLifeTime = 6;
    ps.emitRate = count / 4.5;
    ps.direction1 = new Vector3(-0.3, -0.1, -0.3);
    ps.direction2 = new Vector3(0.3, 0.25, 0.3);
    ps.minEmitPower = 0.2;
    ps.maxEmitPower = 0.5;
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.updateSpeed = 1 / 60;
    ps.preWarmCycles = 120;
    ps.preWarmStepOffset = 5;
    return ps;
  }

  private makeLeaves() {
    const ps = new ParticleSystem('leaves', 60, this.scene);
    ps.particleTexture = this.dot;
    ps.emitter = new Vector3();
    ps.minEmitBox = new Vector3(-16, 6, -16);
    ps.maxEmitBox = new Vector3(16, 12, 16);
    ps.color1 = new Color4(0.85, 0.55, 0.18, 1);
    ps.color2 = new Color4(0.45, 0.6, 0.2, 1);
    ps.colorDead = new Color4(0.5, 0.4, 0.2, 0);
    ps.minSize = 0.12;
    ps.maxSize = 0.2;
    ps.minScaleX = 1;
    ps.maxScaleX = 1.6;
    ps.minScaleY = 0.5;
    ps.maxScaleY = 0.8;
    ps.minLifeTime = 6;
    ps.maxLifeTime = 9;
    ps.emitRate = 0;
    ps.direction1 = new Vector3(-0.5, -0.4, -0.3);
    ps.direction2 = new Vector3(0.6, -0.8, 0.4);
    ps.minEmitPower = 0.5;
    ps.maxEmitPower = 1;
    ps.minAngularSpeed = -3;
    ps.maxAngularSpeed = 3;
    ps.gravity = new Vector3(0.15, -0.25, 0.05);
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    ps.updateSpeed = 1 / 60;
    return ps;
  }

  // ---------------------------------------------------------------- critters
  /** A flat unit wing hinged at x = 0, reaching out along +x. */
  private makeWings() {
    const all = [...this.butterflies, ...this.birds];
    const m = new Mesh('wings', this.scene);
    const vd = new VertexData();
    vd.positions = [0, 0, -0.4, 1, 0, -0.4, 1, 0, 0.4, 0, 0, 0.4];
    vd.normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
    vd.indices = [0, 2, 1, 0, 3, 2];
    vd.applyToMesh(m);
    const mat = new StandardMaterial('wingsMat', this.scene);
    // per-wing colour comes from the instance colour; a little over 1 keeps them as bright as before
    mat.diffuseColor = new Color3(1.3, 1.3, 1.3);
    mat.specularColor = Color3.Black();
    mat.backFaceCulling = false;
    m.material = mat;
    freezeStatic(mat);
    m.isPickable = false;
    m.alwaysSelectAsActiveMesh = true;
    m.doNotSyncBoundingInfo = true;
    this.wingBuf = new Float32Array(all.length * 2 * 16);
    const cols = new Float32Array(all.length * 2 * 4);
    all.forEach((c, i) => {
      for (let s = 0; s < 2; s++) cols.set([c.color.r, c.color.g, c.color.b, 1], (i * 2 + s) * 4);
    });
    m.thinInstanceSetBuffer('matrix', this.wingBuf, 16, false);
    m.thinInstanceSetBuffer('color', cols, 4, true);
    this.wings = m;
  }

  private critter(color: Color3, size: number, phase: number, speed: number, anchor: Vector3, radius: number, height: number): Critter {
    return { pos: new Vector3(), yaw: 0, flap: 0, size, color, on: false, phase, speed, anchor, radius, height };
  }

  /** Write both wings of every critter into the instance buffer. */
  private writeWings() {
    if (!this.wings) return;
    const buf = this.wingBuf;
    let o = 0;
    for (const c of [this.butterflies, this.birds]) {
      for (const b of c) {
        if (!b.on) {
          buf.fill(0, o, o + 32);
          o += 32;
          continue;
        }
        Matrix.RotationYToRef(b.yaw, mY);
        Matrix.TranslationToRef(b.pos.x, b.pos.y, b.pos.z, mT);
        mY.multiplyToRef(mT, mBody);
        for (let side = 0; side < 2; side++) {
          Matrix.ScalingToRef(b.size, b.size, b.size, mS);
          Matrix.RotationZToRef(b.flap, mR);
          mS.multiplyToRef(mR, mA);
          // the left wing is the right one turned half way round
          if (side === 1) mA.multiplyToRef(RY_PI, mB);
          else mB.copyFrom(mA);
          mB.multiplyToRef(mBody, mA);
          mA.copyToArray(buf, o);
          o += 16;
        }
      }
    }
    this.wings.thinInstanceBufferUpdated('matrix');
  }

  private makeButterflies() {
    const colors = ['#ffd24a', '#ff8fb8', '#8fd8ff', '#ffffff', '#ffa040', '#c8a8ff'];
    for (let i = 0; i < 12; i++) {
      this.butterflies.push(this.critter(Color3.FromHexString(colors[i % colors.length]), 0.09, hash2(i, 1, 9) * 100, 0.6 + hash2(i, 2, 9) * 0.6, new Vector3(), 3 + hash2(i, 3, 9) * 6, 0.5 + hash2(i, 4, 9)));
    }
  }

  private makeBirds() {
    for (let i = 0; i < 10; i++) {
      const flock = i < 5 ? 0 : 1;
      this.birds.push(this.critter(new Color3(0.12, 0.12, 0.14), 0.7, flock * 3 + (i % 5) * 0.08, 0.09 + flock * 0.03, new Vector3(flock ? 120 : -60, 0, flock ? -80 : 60), flock ? 70 : 95, 42 + (i % 5) * 1.6 + flock * 10));
    }
  }

  // ---------------------------------------------------------------- update
  update(dt: number, cam: Vector3) {
    this.time += dt;
    const night = smooth(0.06, -0.12, this.atmosphere.sunDir.y);
    const day = 1 - night;

    // start / stop distant emitters every half second
    this.checkT -= dt;
    if (this.checkT <= 0) {
      this.checkT = 0.5;
      for (const e of this.emitters) {
        const near = Vector3.DistanceSquared(e.pos, cam) < e.range * e.range;
        if (near && !e.on) e.ps.start();
        else if (!near && e.on) e.ps.stop();
        e.on = near;
      }
    }

    // fireflies follow the camera at night, away from open water
    const ground = this.hm.sample(cam.x, cam.z);
    (this.fireflies.emitter as Vector3).set(cam.x, ground, cam.z);
    const dry = waterAt(cam.x, cam.z) === -Infinity ? 1 : 0.3;
    this.fireflies.emitRate = night * dry * 16;

    // leaves inside the forest
    const fm = forestMask(cam.x, cam.z);
    (this.leaves.emitter as Vector3).set(cam.x, ground, cam.z);
    this.leaves.emitRate = smooth(0.3, 0.8, fm) * 7;

    // butterflies by day, near the camera
    const t = this.time;
    for (const b of this.butterflies) {
      const on = day > 0.4 && fm < 0.5;
      b.on = on;
      if (!on) continue;
      if (Vector3.DistanceSquared(b.anchor, cam) > 900 || b.anchor.lengthSquared() === 0) {
        b.anchor.set(cam.x + (Math.random() - 0.5) * 30, 0, cam.z + (Math.random() - 0.5) * 30);
      }
      const p = b.phase + t * b.speed;
      const x = b.anchor.x + Math.cos(p) * b.radius + this.noise.noise(p * 0.7, b.phase) * 1.5;
      const z = b.anchor.z + Math.sin(p * 1.3) * b.radius * 0.7 + this.noise.noise(b.phase, p * 0.7) * 1.5;
      const y = this.hm.sample(x, z) + b.height + Math.sin(p * 3.1) * 0.25;
      b.yaw = Math.atan2(x - b.pos.x, z - b.pos.z);
      b.pos.set(x, y, z);
      b.flap = Math.sin(t * 22 + b.phase) * 1.1;
    }

    // birds circling high above by day
    for (const b of this.birds) {
      b.on = day > 0.3;
      if (!b.on) continue;
      const a = b.phase + t * b.speed;
      const x = b.anchor.x + Math.cos(a) * b.radius;
      const z = b.anchor.z + Math.sin(a) * b.radius;
      const y = this.hm.sample(x, z) * 0.4 + b.height + Math.sin(t * 0.3 + b.phase) * 3;
      b.pos.set(x, y, z);
      b.yaw = Math.atan2(-Math.sin(a), Math.cos(a));
      // glide with an occasional flap
      b.flap = Math.sin(t * 9 + b.phase * 7) * (Math.sin(t * 0.7 + b.phase) > 0.4 ? 0.6 : 0.08) + 0.12;
    }
    this.writeWings();
  }
}
