// Combat and magic effects, all generated in code: weapon arcs, missiles,
// explosions, rings, telegraphs, healing light, sparks and dust. Particles use
// one procedurally drawn texture; glowing parts are additive so the bloom
// pass picks them up.
import {
  Color3,
  Color4,
  Constants,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  StandardMaterial,
  TransformNode,
  Vector3,
  VertexData,
  type Scene,
} from '@babylonjs/core';
import { perf } from '../core/perf';

interface Live {
  t: number;
  dur: number;
  step(f: number, dt: number): void;
  end(): void;
}

export interface Missile {
  node: TransformNode;
  alive: boolean;
}

const hex = (h: string) => Color3.FromHexString(h);
const c4 = (c: Color3, a = 1) => new Color4(c.r, c.g, c.b, a);

export class Effects {
  private live: Live[] = [];
  private dot: DynamicTexture;
  private ringTex: DynamicTexture;
  private arcTex: DynamicTexture;
  private root: TransformNode;
  /** Ground height for telegraphs and impacts. */
  groundAt: (x: number, z: number) => number = () => 0;

  constructor(private scene: Scene) {
    this.root = new TransformNode('fx', scene);
    perf.tag(this.root, 'fx');
    this.dot = this.makeTexture('fxDot', 64, (ctx, s) => {
      const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    });
    this.ringTex = this.makeTexture('fxRing', 256, (ctx, s) => {
      const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0, 'rgba(255,255,255,0.08)');
      g.addColorStop(0.78, 'rgba(255,255,255,0.22)');
      g.addColorStop(0.93, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    });
    // weapon arc: bright leading edge (u=1) fading to the tail, soft across v
    this.arcTex = this.makeTexture('fxArc', 128, (ctx, s) => {
      const img = ctx.createImageData(s, s);
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const u = x / (s - 1);
          const v = y / (s - 1);
          const across = Math.pow(Math.sin(v * Math.PI), 0.7) * (0.35 + 0.65 * v);
          const a = Math.pow(u, 1.6) * across;
          const i = (y * s + x) * 4;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
          img.data[i + 3] = Math.round(a * 255);
        }
      }
      ctx.putImageData(img, 0, 0);
    });
  }

  private makeTexture(name: string, size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void) {
    const t = new DynamicTexture(name, { width: size, height: size }, this.scene, true);
    const ctx = t.getContext() as unknown as CanvasRenderingContext2D;
    draw(ctx, size);
    t.hasAlpha = true;
    t.update(false);
    return t;
  }

  update(dt: number) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const l = this.live[i];
      l.t += dt;
      const f = Math.min(1, l.t / l.dur);
      l.step(f, dt);
      if (l.t >= l.dur) {
        l.end();
        this.live.splice(i, 1);
      }
    }
  }

  private add(dur: number, step: Live['step'], end: Live['end']) {
    this.live.push({ t: 0, dur, step, end });
  }

  private glowMat(name: string, color: Color3, tex: DynamicTexture | null, intensity = 2.2) {
    const m = new StandardMaterial(name, this.scene);
    m.disableLighting = true;
    m.diffuseColor = Color3.Black();
    m.specularColor = Color3.Black();
    m.emissiveColor = color.scale(intensity);
    // shape from the texture's alpha; colour from emissiveColor (an emissive
    // texture would be added on top and wash the colour out to white)
    if (tex) m.opacityTexture = tex;
    m.alphaMode = Constants.ALPHA_ADD;
    m.backFaceCulling = false;
    m.disableDepthWrite = true;
    m.fogEnabled = false;
    return m;
  }

  // ---------------------------------------------------------------- particles
  burst(pos: Vector3, color: string, o: { count?: number; speed?: number; size?: number; life?: number; gravity?: number; spread?: number; up?: number; additive?: boolean; color2?: string; stretch?: boolean } = {}) {
    const ps = new ParticleSystem('burst', o.count ?? 24, this.scene);
    ps.particleTexture = this.dot;
    ps.emitter = pos.clone();
    const sp = o.spread ?? 0.15;
    ps.minEmitBox = new Vector3(-sp, -sp, -sp);
    ps.maxEmitBox = new Vector3(sp, sp, sp);
    const col = hex(color);
    const col2 = o.color2 ? hex(o.color2) : col;
    ps.color1 = c4(col.scale(o.additive === false ? 1 : 1.8));
    ps.color2 = c4(col2.scale(o.additive === false ? 1 : 1.8));
    ps.colorDead = new Color4(col.r * 0.2, col.g * 0.2, col.b * 0.2, 0);
    ps.minSize = (o.size ?? 0.18) * 0.5;
    ps.maxSize = o.size ?? 0.18;
    ps.minLifeTime = (o.life ?? 0.5) * 0.5;
    ps.maxLifeTime = o.life ?? 0.5;
    const s = o.speed ?? 5;
    ps.minEmitPower = s * 0.4;
    ps.maxEmitPower = s;
    const up = o.up ?? 0.4;
    ps.direction1 = new Vector3(-1, up - 0.6, -1);
    ps.direction2 = new Vector3(1, up + 0.6, 1);
    ps.gravity = new Vector3(0, -(o.gravity ?? 6), 0);
    ps.blendMode = o.additive === false ? ParticleSystem.BLENDMODE_STANDARD : ParticleSystem.BLENDMODE_ADD;
    if (o.stretch) ps.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
    ps.updateSpeed = 1 / 60;
    ps.manualEmitCount = o.count ?? 24;
    ps.targetStopDuration = 0.1;
    ps.disposeOnStop = true;
    ps.start();
    return ps;
  }

  /** Continuous emitter attached to a node (trails). */
  trail(node: TransformNode, color: string, o: { rate?: number; size?: number; life?: number; additive?: boolean; gravity?: number } = {}) {
    const ps = new ParticleSystem('trail', 120, this.scene);
    ps.particleTexture = this.dot;
    ps.emitter = node as unknown as Mesh;
    ps.minEmitBox = new Vector3(-0.05, -0.05, -0.05);
    ps.maxEmitBox = new Vector3(0.05, 0.05, 0.05);
    const col = hex(color);
    ps.color1 = c4(col.scale(o.additive === false ? 1 : 1.6));
    ps.color2 = c4(col.scale(o.additive === false ? 0.9 : 1.2));
    ps.colorDead = new Color4(0, 0, 0, 0);
    ps.minSize = (o.size ?? 0.25) * 0.5;
    ps.maxSize = o.size ?? 0.25;
    ps.minLifeTime = (o.life ?? 0.3) * 0.5;
    ps.maxLifeTime = o.life ?? 0.3;
    ps.emitRate = o.rate ?? 90;
    ps.minEmitPower = 0;
    ps.maxEmitPower = 0.3;
    ps.gravity = new Vector3(0, o.gravity ?? 0, 0);
    ps.blendMode = o.additive === false ? ParticleSystem.BLENDMODE_STANDARD : ParticleSystem.BLENDMODE_ADD;
    ps.updateSpeed = 1 / 60;
    ps.start();
    return ps;
  }

  // ---------------------------------------------------------------- shapes
  /** A flat glowing ring that expands from r0 to r1 and fades. */
  ring(pos: Vector3, r0: number, r1: number, color: string, dur = 0.5, intensity = 2.2) {
    const m = MeshBuilder.CreateGround('ring', { width: 2, height: 2 }, this.scene);
    m.parent = this.root;
    m.position.copyFrom(pos);
    m.position.y += 0.08;
    m.isPickable = false;
    const mat = this.glowMat('ringMat', hex(color), this.ringTex, intensity);
    m.material = mat;
    this.add(
      dur,
      (f) => {
        const e = 1 - Math.pow(1 - f, 3);
        const r = r0 + (r1 - r0) * e;
        m.scaling.set(r, 1, r);
        mat.alpha = 1 - f * f;
      },
      () => {
        m.dispose();
        mat.dispose();
      },
    );
  }

  /** Warning circle on the ground that fills up until the hit lands. */
  telegraph(x: number, z: number, radius: number, dur: number, color = '#ff3b2f') {
    const y = this.groundAt(x, z);
    const outer = MeshBuilder.CreateGround('tele', { width: 2, height: 2 }, this.scene);
    outer.parent = this.root;
    outer.position.set(x, y + 0.1, z);
    outer.scaling.set(radius, 1, radius);
    outer.isPickable = false;
    const om = this.glowMat('teleMat', hex(color), this.ringTex, 1.1);
    outer.material = om;
    const inner = MeshBuilder.CreateDisc('teleIn', { radius: 1, tessellation: 40 }, this.scene);
    inner.parent = this.root;
    inner.rotation.x = Math.PI / 2;
    inner.position.set(x, y + 0.11, z);
    inner.isPickable = false;
    const im = this.glowMat('teleInMat', hex(color), null, 0.5);
    inner.material = im;
    this.add(
      dur,
      (f) => {
        om.alpha = Math.min(1, f * 4) * 0.9;
        const r = radius * f;
        inner.scaling.set(Math.max(0.01, r), Math.max(0.01, r), 1);
        im.alpha = 0.25 + f * 0.2;
      },
      () => {
        outer.dispose();
        inner.dispose();
        om.dispose();
        im.dispose();
      },
    );
  }

  /** A sweeping weapon arc around `pos` facing `yaw`. */
  slash(pos: Vector3, yaw: number, color: string, o: { radius?: number; arc?: number; tilt?: number; dur?: number; width?: number; reverse?: boolean; spin?: number } = {}) {
    const radius = o.radius ?? 1.9;
    const arc = o.arc ?? 2.2;
    const width = o.width ?? 0.75;
    const segs = 24;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const a = (o.reverse ? 1 - u : u) * arc - arc / 2;
      for (const [r, v] of [[radius - width, 0], [radius, 1]] as const) {
        positions.push(Math.sin(a) * r, 0, Math.cos(a) * r);
        uvs.push(u, v);
      }
      if (i < segs) {
        const k = i * 2;
        indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    const m = new Mesh('slash', this.scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.uvs = uvs;
    vd.indices = indices;
    vd.applyToMesh(m);
    m.parent = this.root;
    m.isPickable = false;
    m.position.copyFrom(pos);
    m.rotation.set(0, yaw, o.tilt ?? 0);
    const mat = this.glowMat('slashMat', hex(color), this.arcTex, 2.6);
    m.material = mat;
    const dur = o.dur ?? 0.24;
    const spin = o.spin ?? 0;
    this.add(
      dur,
      (f) => {
        mat.alpha = f < 0.25 ? f / 0.25 : 1 - (f - 0.25) / 0.75;
        const s = 0.85 + f * 0.25;
        m.scaling.set(s, 1, s);
        m.rotation.y = yaw + (o.reverse ? -1 : 1) * f * 0.35 + spin * f;
      },
      () => {
        m.dispose();
        mat.dispose();
      },
    );
  }

  /**
   * A missile from `from` along `dir` (unit, may include y). `hit` is polled
   * each frame with the head position and returns true when it struck.
   */
  missile(
    from: Vector3,
    dir: Vector3,
    speed: number,
    range: number,
    kind: 'arrow' | 'bolt' | 'fire' | 'hex' | 'frost',
    color: string,
    hit: (p: Vector3) => boolean,
    onEnd?: (p: Vector3, struck: boolean) => void,
  ): Missile {
    const node = new TransformNode('missile', this.scene);
    node.parent = this.root;
    node.position.copyFrom(from);
    const meshes: Mesh[] = [];
    const mats: StandardMaterial[] = [];
    const col = hex(color);
    if (kind === 'arrow') {
      const shaft = MeshBuilder.CreateCylinder('arrow', { height: 0.9, diameter: 0.035, tessellation: 5 }, this.scene);
      shaft.rotation.x = Math.PI / 2;
      shaft.parent = node;
      const mat = this.glowMat('arrowMat', col, null, 1.6);
      mat.alphaMode = Constants.ALPHA_COMBINE;
      shaft.material = mat;
      meshes.push(shaft);
      mats.push(mat);
    } else {
      const s = kind === 'fire' ? 0.55 : kind === 'hex' ? 0.42 : 0.36;
      const core = MeshBuilder.CreateSphere('orb', { diameter: s, segments: 8 }, this.scene);
      core.parent = node;
      const mat = this.glowMat('orbMat', col, this.dot, 3);
      core.material = mat;
      meshes.push(core);
      mats.push(mat);
    }
    node.lookAt(from.add(dir));
    const trail = this.trail(node, color, kind === 'arrow' ? { rate: 60, size: 0.12, life: 0.2 } : kind === 'fire' ? { rate: 160, size: 0.55, life: 0.45, gravity: 1.5 } : { rate: 110, size: 0.35, life: 0.3 });
    const m: Missile = { node, alive: true };
    let travelled = 0;
    const dur = range / speed + 0.05;
    const step = dir.scale(speed);
    let ended = false;
    const finish = (struck: boolean) => {
      if (ended) return;
      ended = true;
      m.alive = false;
      trail.stop();
      trail.disposeOnStop = true;
      for (const x of meshes) x.setEnabled(false);
      onEnd?.(node.position.clone(), struck);
    };
    this.add(
      dur,
      (_f, dt) => {
        if (ended) return;
        node.position.addInPlace(step.scale(dt));
        travelled += speed * dt;
        if (kind === 'fire' || kind === 'hex') node.rotation.z += dt * 8;
        if (hit(node.position)) finish(true);
        else if (travelled >= range || node.position.y < this.groundAt(node.position.x, node.position.z) - 0.2) finish(false);
      },
      () => {
        finish(false);
        setTimeout(() => {
          node.dispose();
          for (const x of mats) x.dispose();
        }, 600);
      },
    );
    return m;
  }

  /** Arrows raining down on an area. */
  volley(x: number, z: number, radius: number, color: string, delay = 0.25) {
    const y = this.groundAt(x, z);
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      const tx = x + Math.cos(a) * r;
      const tz = z + Math.sin(a) * r;
      const from = new Vector3(tx - 2, y + 14, tz - 1);
      const to = new Vector3(tx, this.groundAt(tx, tz), tz);
      const dir = to.subtract(from).normalize();
      setTimeout(() => {
        this.missile(from, dir, 34, Vector3.Distance(from, to), 'arrow', color, () => false, (p) => this.burst(p, '#c9b48a', { count: 6, speed: 2, size: 0.14, life: 0.4, additive: false, gravity: 4 }));
      }, (delay + Math.random() * 0.35) * 1000);
    }
  }

  /** Rising motes of light (heals, level ups). */
  column(pos: Vector3, color: string, o: { radius?: number; count?: number; height?: number; dur?: number } = {}) {
    const ps = new ParticleSystem('column', o.count ?? 60, this.scene);
    ps.particleTexture = this.dot;
    ps.emitter = pos.clone();
    const r = o.radius ?? 0.8;
    ps.createCylinderEmitter(r, 0.1, r * 0.8, 0);
    const col = hex(color);
    ps.color1 = c4(col.scale(1.8));
    ps.color2 = c4(Color3.White().scale(1.4));
    ps.colorDead = new Color4(col.r, col.g, col.b, 0);
    ps.minSize = 0.06;
    ps.maxSize = 0.18;
    ps.minLifeTime = 0.6;
    ps.maxLifeTime = 1.2;
    ps.emitRate = (o.count ?? 60) * 2;
    ps.minEmitPower = 0.2;
    ps.maxEmitPower = 0.6;
    ps.gravity = new Vector3(0, (o.height ?? 2.4) * 1.4, 0);
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.updateSpeed = 1 / 60;
    ps.targetStopDuration = o.dur ?? 0.6;
    ps.disposeOnStop = true;
    ps.start();
  }

  /** Brief bright flash at a point (blink, impacts). */
  flash(pos: Vector3, color: string, size = 1.4, dur = 0.18) {
    const m = MeshBuilder.CreatePlane('flash', { size: 1 }, this.scene);
    m.billboardMode = Mesh.BILLBOARDMODE_ALL;
    m.parent = this.root;
    m.position.copyFrom(pos);
    m.isPickable = false;
    const mat = this.glowMat('flashMat', hex(color), this.dot, 3);
    m.material = mat;
    this.add(
      dur,
      (f) => {
        const s = size * (0.6 + f * 0.8);
        m.scaling.setAll(s);
        mat.alpha = 1 - f;
      },
      () => {
        m.dispose();
        mat.dispose();
      },
    );
  }

  dust(pos: Vector3, count = 10) {
    this.burst(pos.add(new Vector3(0, 0.1, 0)), '#b8a68a', { count, speed: 1.6, size: 0.55, life: 0.7, gravity: -0.4, additive: false, up: 0.2, spread: 0.3 });
  }
}
