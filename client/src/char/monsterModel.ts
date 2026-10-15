// A risen skeleton assembled from the KayKit Skeletons rig: body parts for its
// kind, weapon and shield in its hands, and the same blended, stride-matched
// locomotion the players use. Styled to read as a menace: ivory bone with
// cold shadows, a rim light in its eye colour, glowing eyes with a soft halo,
// an anime hit flash (white body and outline) and, for the boss, molten seams,
// a turning sigil underfoot, and embers and dark wisps rising off it.
import {
  Color3,
  Color4,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  ParticleSystem,
  StandardMaterial,
  TransformNode,
  Vector3,
  type AbstractMesh,
  type InstantiatedEntries,
  type Scene,
} from '@babylonjs/core';
import type { MonsterDef } from '@kelia/shared';
import { perf } from '../core/perf';
import { fxTextures } from './fxTextures';
import { ATLAS_SURFACES, RecolorPlugin } from './recolor';
import { InkScaler, inkCharacter } from './style';
import { Animator, measureStride } from './animator';
import type { RigLibrary } from './library';
import { CHARACTER_HEIGHT } from './model';

const LOCO = { idle: 'Idle', walk: 'Walking_D_Skeletons', run: 'Running_A' };
const strideCache = new WeakMap<RigLibrary, Record<string, number>>();
const FLASH = 0.16;
const INK_MONSTER = new Color3(0.085, 0.035, 0.075);
const WHITE = new Color3(1, 1, 1);
const haloMats = new Map<string, StandardMaterial>();

/** Shared additive halo material per eye colour. */
function haloMaterial(scene: Scene, hex: string) {
  const key = hex + scene.uid;
  let m = haloMats.get(key);
  if (!m) {
    m = new StandardMaterial('eyeHalo', scene);
    m.disableLighting = true;
    m.emissiveColor = Color3.FromHexString(hex).toLinearSpace().scale(1.6);
    m.diffuseColor = Color3.Black();
    m.opacityTexture = fxTextures(scene).dot;
    m.alphaMode = 1; // additive
    m.disableDepthWrite = true;
    m.alpha = 0.55;
    m.backFaceCulling = false;
    haloMats.set(key, m);
  }
  return m;
}

export class MonsterModel {
  readonly root: TransformNode;
  private body: TransformNode;
  private entries: InstantiatedEntries;
  private nodes = new Map<string, TransformNode>();
  readonly animator: Animator;
  meshes: AbstractMesh[] = [];
  private flashT = 0;
  private flashing = false;
  private eyeMats: PBRMaterial[] = [];
  private surfaces: RecolorPlugin[] = [];
  private inked: AbstractMesh[] = [];
  private inkScaler: InkScaler | null = null;
  private extras: Mesh[] = [];
  private particles: ParticleSystem[] = [];
  private emitAt = new Vector3();
  private sigil: Mesh | null = null;
  private time = Math.random() * 100;

  constructor(scene: Scene, lib: RigLibrary, readonly def: MonsterDef, name: string) {
    this.root = new TransformNode(name, scene);
    perf.tag(this.root, 'characters');
    this.body = new TransformNode(name + '_body', scene);
    this.body.parent = this.root;
    const wanted = new Set(def.parts);
    const held = new Set([def.weapon, def.offhand].filter(Boolean) as string[]);
    const entries = lib.container.instantiateModelsToScene((n) => n, true, {
      doNotInstantiate: true,
      predicate: (e: { name?: string; parent?: { name?: string } | null; getClassName?: () => string }) => {
        const cls = e.getClassName?.();
        if (cls === 'Mesh' || cls === 'InstancedMesh') return e.name === '__root__' || wanted.has(e.name!) || held.has(e.parent?.name ?? '');
        return true;
      },
    });
    this.entries = entries;
    const rootNode = entries.rootNodes[0] as TransformNode;
    rootNode.parent = this.body;
    for (const n of rootNode.getDescendants(false)) if (n instanceof TransformNode) this.nodes.set(n.name, n);
    // weapons are separate roots in the file: put them in the hands
    const put = (item: string | undefined, slot: string) => {
      const w = item ? this.nodes.get(item) : undefined;
      const s = this.nodes.get(slot);
      if (!w || !s) return;
      w.parent = s;
      w.position.setAll(0);
      w.rotationQuaternion = null;
      w.rotation.setAll(0);
      w.scaling.setAll(1);
    };
    put(def.weapon, 'handslot.r');
    put(def.offhand, 'handslot.l');
    // drop empty weapon roots we don't use
    for (const n of ['sw_blade', 'sw_axe', 'sw_staff', 'sw_crossbow', 'ssh_small', 'ssh_large']) {
      if (n !== def.weapon && n !== def.offhand) this.nodes.get(n)?.dispose();
    }
    const used = new Set(rootNode.getChildMeshes(false).map((m) => m.skeleton).filter(Boolean));
    for (const s of entries.skeletons) if (!used.has(s)) s.dispose();

    this.meshes = rootNode.getChildMeshes(false);
    const eye = Color3.FromHexString(def.eyeColor).toLinearSpace();
    const seen = new Set();
    for (const m of this.meshes) {
      m.isPickable = false;
      m.receiveShadows = true;
      const mat = m.material as PBRMaterial | null;
      if (!mat || seen.has(mat)) continue;
      seen.add(mat);
      if (mat.name.startsWith('Glow') || m.name.startsWith('eyes_')) {
        mat.emissiveColor = eye.scale(def.boss ? 5 : 4);
        this.eyeMats.push(mat);
      } else {
        mat.metallic = 0;
        mat.roughness = 0.7;
        if (mat.albedoTexture) {
          const rc = new RecolorPlugin(mat, { skin: 0.55, hair: 1, eye: 1 }, ATLAS_SURFACES.skeleton, true);
          rc.setBone(def.boss ? '#e6ddcc' : '#f1e8d4', 0.55);
          rc.setRim(def.eyeColor, def.boss ? 0.4 : 0.2);
          rc.setSeams(def.boss ? 1.4 : 0.15, def.boss ? 0.09 : 0.04);
          if (def.boss) rc.setTint('#a39aa6');
          this.surfaces.push(rc);
        }
      }
    }
    const s = (CHARACTER_HEIGHT * def.scale) / lib.heightUnits;
    this.body.scaling.setAll(s);
    this.inked = this.meshes.filter((m) => !(m.material && this.eyeMats.includes(m.material as PBRMaterial)));
    inkCharacter(this.inked, { color: INK_MONSTER, rim: 1.1, width: def.boss ? 0.024 : 0.017 });
    this.inkScaler = new InkScaler(this.inked);
    this.addEyeHalo(scene);
    if (def.boss) this.addBossPresence(scene);

    this.animator = new Animator(entries.animationGroups, LOCO);
    this.animator.scale = s;
    let cache = strideCache.get(lib);
    if (!cache) {
      cache = {};
      const fl = this.nodes.get('foot.l');
      const fr = this.nodes.get('foot.r');
      const r = this.nodes.get('root');
      if (fl && fr && r) {
        for (const key of ['walk', 'run'] as const) {
          const g = this.animator.locoGroup(key);
          if (g) cache[key] = measureStride(g, fl, fr, r);
        }
        for (const key of ['idle', 'walk', 'run'] as const) {
          const g = this.animator.locoGroup(key);
          if (g) g.goToFrame(g.from);
        }
      }
      strideCache.set(lib, cache);
    }
    for (const [k, v] of Object.entries(cache)) this.animator.setStride(k as 'walk', v);
  }

  /** Soft glow around the eyes (one billboard riding on the head). */
  private addEyeHalo(scene: Scene) {
    const eyes = this.meshes.find((m) => m.name.startsWith('eyes_'));
    const head = this.nodes.get('head');
    if (!eyes || !head) return;
    const chain: TransformNode[] = [];
    for (let n = head as TransformNode | null; n; n = n.parent as TransformNode | null) chain.unshift(n);
    for (const n of chain) n.computeWorldMatrix(true);
    eyes.computeWorldMatrix(true);
    const bb = eyes.getBoundingInfo().boundingBox;
    const inv = head.getWorldMatrix().clone().invert();
    const local = Vector3.TransformCoordinates(bb.centerWorld, inv);
    // head space is in model units: size and place the glow in metres
    const ws = Math.max(Vector3.TransformNormal(Vector3.Right(), head.getWorldMatrix()).length(), 1e-6);
    // just in front of the face, so the skull hides it from behind
    this.root.computeWorldMatrix(true);
    const fwd = Vector3.TransformNormal(Vector3.TransformNormal(new Vector3(0, 0, 1), this.root.getWorldMatrix()), inv).normalize();
    local.addInPlace(fwd.scale((0.16 * this.def.scale) / ws));
    const halo = MeshBuilder.CreatePlane('eyeHalo', { size: 1 }, scene);
    halo.billboardMode = Mesh.BILLBOARDMODE_ALL;
    halo.parent = head;
    halo.position.copyFrom(local);
    const k = (this.def.scale / ws) * (this.def.boss ? 0.85 : 1);
    halo.scaling.set(0.62 * k, 0.36 * k, 1);
    halo.material = haloMaterial(scene, this.def.eyeColor);
    halo.isPickable = false;
    this.extras.push(halo);
    this.meshes.push(halo);
  }

  /** The boss: a slowly turning sigil underfoot, rising embers and dark wisps. */
  private addBossPresence(scene: Scene) {
    const tex = fxTextures(scene);
    const col = Color3.FromHexString(this.def.eyeColor).toLinearSpace();
    const sig = MeshBuilder.CreateGround('bossSigil', { width: 1, height: 1 }, scene);
    sig.parent = this.root;
    sig.position.y = 0.06;
    const r = this.def.radius * 2.6;
    sig.scaling.set(r * 2, 1, r * 2);
    const sm = new StandardMaterial('bossSigil', scene);
    sm.disableLighting = true;
    sm.emissiveColor = col.scale(1.4);
    sm.diffuseColor = Color3.Black();
    sm.opacityTexture = tex.sigil;
    sm.alphaMode = 1;
    sm.disableDepthWrite = true;
    sm.alpha = 0.7;
    sm.backFaceCulling = false;
    sig.material = sm;
    sig.isPickable = false;
    this.sigil = sig;
    this.extras.push(sig);
    this.meshes.push(sig);

    const h = CHARACTER_HEIGHT * this.def.scale;
    const embers = new ParticleSystem('bossEmbers', 70, scene);
    embers.particleTexture = tex.dot;
    embers.emitter = this.emitAt;
    // around (not inside) the body, so they are not hidden by it
    const w = this.def.radius * 1.15;
    embers.minEmitBox = new Vector3(-w, 0.05 * h, -w);
    embers.maxEmitBox = new Vector3(w, 0.8 * h, w);
    // hot sparks that flare up, then cool and fade as they drift away
    embers.addColorGradient(0, new Color4(3, 1.1, 0.35, 0), new Color4(2.4, 0.8, 0.25, 0));
    embers.addColorGradient(0.12, new Color4(col.r * 3 + 0.6, col.g * 3 + 0.5, col.b * 3 + 0.15, 1), new Color4(2.6, 0.9, 0.25, 1));
    embers.addColorGradient(0.6, new Color4(col.r * 2.2, col.g * 2 + 0.1, col.b * 2, 0.8));
    embers.addColorGradient(1, new Color4(col.r * 0.6, 0, 0, 0));
    embers.minSize = 0.06;
    embers.maxSize = 0.14;
    embers.minLifeTime = 0.9;
    embers.maxLifeTime = 1.8;
    embers.emitRate = 34;
    embers.direction1 = new Vector3(-0.3, 1, -0.3);
    embers.direction2 = new Vector3(0.3, 1.3, 0.3);
    embers.minEmitPower = 0.25;
    embers.maxEmitPower = 0.6;
    embers.gravity = new Vector3(0, 0.12, 0);
    embers.blendMode = ParticleSystem.BLENDMODE_ADD;
    embers.updateSpeed = 1 / 60;

    const wisps = new ParticleSystem('bossWisps', 26, scene);
    wisps.particleTexture = tex.dot;
    wisps.emitter = this.emitAt;
    wisps.minEmitBox = new Vector3(-w, 0.0, -w);
    wisps.maxEmitBox = new Vector3(w, 0.6 * h, w);
    wisps.color1 = new Color4(0.07, 0.01, 0.06, 0.8);
    wisps.color2 = new Color4(0.03, 0.01, 0.05, 0.7);
    wisps.colorDead = new Color4(0.02, 0.0, 0.03, 0);
    wisps.minSize = 0.5;
    wisps.maxSize = 1.1;
    // (gradient values are sizes in metres)
    wisps.addSizeGradient(0, 0.3);
    wisps.addSizeGradient(1, 0.95);
    wisps.minLifeTime = 1.4;
    wisps.maxLifeTime = 2.6;
    wisps.emitRate = 9;
    wisps.direction1 = new Vector3(-0.2, 1, -0.2);
    wisps.direction2 = new Vector3(0.2, 1, 0.2);
    wisps.minEmitPower = 0.25;
    wisps.maxEmitPower = 0.5;
    wisps.minAngularSpeed = -0.6;
    wisps.maxAngularSpeed = 0.6;
    wisps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    wisps.updateSpeed = 1 / 60;
    // wisps first so the additive embers draw over them
    this.particles.push(wisps, embers);
    for (const p of this.particles) p.start();
  }

  setShadowCaster(add: (m: AbstractMesh) => void) {
    for (const m of this.meshes) if (!this.extras.includes(m as Mesh)) add(m);
  }

  node(name: string) {
    return this.nodes.get(name);
  }

  /** White flash when hit. */
  flash() {
    this.flashT = FLASH;
  }

  update(dt: number, vel: Vector3) {
    const yaw = this.root.rotation.y;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    this.animator.setMotion(vel.x * c - vel.z * s, vel.x * s + vel.z * c, dt);
    this.animator.update(dt);
    if (this.flashT > 0 || this.flashing) {
      this.flashT = Math.max(0, this.flashT - dt);
      // snap to white, then ease out
      const k = Math.pow(this.flashT / FLASH, 1.6);
      for (const rc of this.surfaces) rc.setFlash(k * 1.1);
      for (const m of this.inked) Color3.LerpToRef(INK_MONSTER, WHITE, k, m.outlineColor);
      this.flashing = this.flashT > 0;
    }
    this.time += dt;
    for (const rc of this.surfaces) rc.setTime(this.time);
    const cam = this.root.getScene().activeCamera;
    if (cam && this.inkScaler) this.inkScaler.update(this.root.position, cam.globalPosition);
    if (this.sigil) {
      this.sigil.rotation.y = this.time * 0.35;
      (this.sigil.material as StandardMaterial).alpha = 0.55 + 0.15 * Math.sin(this.time * 2.2);
    }
    if (this.particles.length) this.emitAt.copyFrom(this.root.position);
  }

  dispose() {
    for (const p of this.particles) p.dispose(false);
    this.particles = [];
    for (const rc of this.surfaces) rc.plugin.dispose();
    this.surfaces = [];
    // halos share their material; the sigil owns its own
    for (const m of this.extras) m.dispose(false, m === this.sigil);
    this.extras = [];
    this.animator.dispose();
    for (const r of this.entries.rootNodes) r.dispose(false, true);
    for (const s of this.entries.skeletons) s.dispose();
    this.root.dispose();
  }
}
