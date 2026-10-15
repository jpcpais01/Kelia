// A player (or NPC) character assembled from modular KayKit parts, recoloured
// to its appearance, animated with blended locomotion, and finished with
// two-bone foot IK on uneven ground, head look-at and turn lean, and a
// spring-driven body layer that gives attacks their weight (coil, lean into
// the blow, plant the hips) and makes hits land (flinch away from the blow).
import {
  Mesh,
  Node,
  PBRMaterial,
  Quaternion,
  Space,
  TransformNode,
  Vector3,
  type AbstractMesh,
  type InstantiatedEntries,
  type Material,
  type Observer,
  type Scene,
} from '@babylonjs/core';
import {
  BODY_TYPES,
  EYE_COLORS,
  FACES,
  HAIR_COLORS,
  HAIR_STYLES,
  ITEMS,
  OUTFITS,
  SKIN_TONES,
  type Appearance,
  type ClassId,
} from '@kelia/shared';
import { perf } from '../core/perf';
import { Animator, measureStride } from './animator';
import { createBow } from './bow';
import type { RigLibrary } from './library';
import { addRecolor, type RecolorPlugin } from './recolor';
import { setToon } from '../world/toon';
import { INK, InkScaler, inkCharacter, inkFor } from './style';
import { spring, stepSpring } from './spring';

export interface Look {
  appearance: Appearance;
  cls: ClassId;
  weapon: string | null;
  offhand: string | null;
}

export const CHARACTER_HEIGHT = 1.85;

const LOCO = {
  idle: 'Idle',
  walk: 'Walking_A',
  run: 'Running_A',
  sprint: 'Running_B',
  back: 'Walking_Backwards',
  left: 'Running_Strafe_Left',
  right: 'Running_Strafe_Right',
  air: 'Jump_Idle',
};

/**
 * Natural cadence per gait ([loops per second, at m/s]; one loop = two steps).
 * About 150 steps a minute walking and 210 running: brisk, but calm enough to
 * read as a person rather than the clips' tiny strides played back at 3-5x.
 */
const CADENCE = {
  walk: [1.25, 2.1],
  back: [1.15, 2.6],
  run: [1.75, 5.4],
  left: [1.7, 5.4],
  right: [1.7, 5.4],
  sprint: [1.95, 8.0],
} satisfies Record<string, [number, number]>;

const strideCache = new WeakMap<RigLibrary, Record<string, number>>();

/** Which part meshes to show for a look. */
export function partsFor(look: Look): { meshes: Set<string>; bow: string | null; headgear: string | null } {
  const a = look.appearance;
  const o = OUTFITS[a.outfit] ?? OUTFITS[0];
  const meshes = new Set<string>([`body_${o.body}`, `armL_${o.arms}`, `armR_${o.arms}`, `legL_${o.legs}`, `legR_${o.legs}`]);
  if (o.cape) meshes.add(`cape_${o.cape}`);
  const hg = a.headgear ? o.headgear : 'none';
  if (hg === 'hood') {
    meshes.add('head_hooded__face');
    meshes.add('head_hooded__hair');
  } else {
    meshes.add(`head_${FACES[a.face]?.id ?? 'knight'}__face`);
    const hair = HAIR_STYLES[a.hair]?.id ?? 'none';
    if (hair !== 'none' && hg !== 'helmet') meshes.add(`head_${hair}__hair`);
    if (hg === 'helmet') meshes.add('hat_knight');
    if (hg === 'bearhat') meshes.add('hat_barbarian');
    if (hg === 'wizard') meshes.add('hat_mage');
  }
  let bow: string | null = null;
  for (const id of [look.weapon, look.offhand]) {
    const it = id ? ITEMS[id] : null;
    if (!it?.mesh) continue;
    if (it.mesh.startsWith('bow:')) bow = it.mesh.slice(4);
    else meshes.add(it.mesh);
  }
  return { meshes, bow, headgear: hg };
}

export class CharacterModel {
  /** World placement: position = feet, rotation.y = facing. */
  readonly root: TransformNode;
  /** Inner node for lean / hip drop. */
  private body: TransformNode;
  private entries: InstantiatedEntries | null = null;
  private nodes = new Map<string, TransformNode>();
  private recolors: RecolorPlugin[] = [];
  /** Recolour plugins of the materials that carry the face. */
  private faceRecolors: RecolorPlugin[] = [];
  /** Recolour plugins of glowing weapons (animated). */
  private glowRecolors: RecolorPlugin[] = [];
  /** Head centre (head node space), radius (head node units) and face axes, for face shading. */
  private headLocal = new Vector3();
  private headRadius = 0;
  private faceFwd = new Vector3(0, 0, 1);
  private faceUp = new Vector3(0, 1, 0);
  /** The head node and its ancestors, root first (refreshed each frame for face shading). */
  private headChain: TransformNode[] = [];
  private ink: InkScaler | null = null;
  private cape: { mesh: AbstractMesh; base: Quaternion; axis: Vector3; angle: number; vel: number } | null = null;
  private capeT = Math.random() * 10;
  /** Portrait lighting (character creator): a stronger rim to model the figure. */
  private showcase = false;
  private time = Math.random() * 100;
  private extra: Mesh[] = [];
  private materials: Material[] = [];
  animator!: Animator;
  look!: Look;
  private obs: Observer<Scene> | null = null;
  private headRest: Quaternion | null = null;
  private lookYaw = 0;
  private lookPitch = 0;
  private lean = 0;
  private hipDrop = 0;
  /** Rest rotations of the spine and chest (the base their motion is exaggerated from). */
  private torsoRest: [Quaternion | null, Quaternion | null] = [null, null];
  /** Body layer springs: forward lean and twist (radians), crouch (metres). */
  private pitch = spring();
  private twist = spring();
  private crouch = spring();
  /** How much the clip's own torso motion is exaggerated right now (0 = as authored). */
  private torsoGain = 0;
  /** Running average of each thigh's animated rotation: the centre the stride swings around. */
  private thighMean: [Quaternion | null, Quaternion | null] = [null, null];
  /** World-space point to look at (null = straight ahead). */
  lookTarget: Vector3 | null = null;
  /** Ground height sampler for foot IK (null disables IK). */
  groundAt: ((x: number, z: number) => number) | null = null;
  ikEnabled = true;
  visible = true;
  meshes: AbstractMesh[] = [];

  constructor(private scene: Scene, private lib: RigLibrary, look: Look, name = 'character') {
    this.root = new TransformNode(name, scene);
    perf.tag(this.root, 'characters');
    this.body = new TransformNode(name + '_body', scene);
    this.body.parent = this.root;
    this.setLook(look);
    this.obs = scene.onAfterAnimationsObservable.add(() => this.postAnimate());
  }

  /** Rebuild the model for a new look (outfit, weapon, appearance...). */
  setLook(look: Look, keepAction = false) {
    const prevAction = keepAction ? this.animator?.currentAction : null;
    this.disposeModel();
    this.look = look;
    const { meshes: wanted, bow } = partsFor(look);
    const entries = this.lib.container.instantiateModelsToScene((n) => n, true, {
      doNotInstantiate: true,
      predicate: (e: { name?: string; getClassName?: () => string }) => {
        const cls = e.getClassName?.();
        if (cls === 'Mesh' || cls === 'InstancedMesh') return e.name === '__root__' || wanted.has(e.name!);
        return true;
      },
    });
    this.entries = entries;
    const rootNode = entries.rootNodes[0] as TransformNode;
    rootNode.parent = this.body;
    this.nodes.clear();
    for (const n of rootNode.getDescendants(false)) {
      if (n instanceof TransformNode) this.nodes.set(n.name, n);
    }
    // Drop skeletons no visible mesh uses.
    const used = new Set(rootNode.getChildMeshes(false).map((m) => m.skeleton).filter(Boolean));
    for (const s of entries.skeletons) if (!used.has(s)) s.dispose();

    // Materials: recolour skin/hair/eyes; weapon glow.
    const a = look.appearance;
    const meshes = rootNode.getChildMeshes(false);
    this.meshes = meshes;
    // Weapon glow needs its own material (cloned before any plugin is attached).
    const glowOf = new Map<Material, string>();
    for (const id of [look.weapon, look.offhand]) {
      const it = id ? ITEMS[id] : null;
      if (!it?.glow || !it.mesh || it.mesh.startsWith('bow:')) continue;
      const wm = meshes.find((m) => m.name === it.mesh);
      if (wm && wm.material) {
        const gm = (wm.material as PBRMaterial).clone(wm.material.name + '_glow') as PBRMaterial;
        wm.material = gm;
        glowOf.set(gm, it.glow);
      }
    }
    const faceMesh = meshes.find((m) => m.name.endsWith('__face'));
    const faceId = faceMesh ? faceMesh.name.slice(5, -6) : null;
    const seen = new Set<Material>();
    this.faceRecolors = [];
    this.glowRecolors = [];
    for (const m of meshes) {
      m.isPickable = false;
      m.receiveShadows = true;
      m.alwaysSelectAsActiveMesh = false;
      const mat = m.material;
      if (!mat || seen.has(mat)) continue;
      seen.add(mat);
      this.materials.push(mat);
      if (mat instanceof PBRMaterial) {
        mat.metallic = 0;
        mat.roughness = 0.62;
        const baseName = mat.name.replace(/^Clone of /, '').replace(/\.\d+$/, '').replace(/_glow$/, '');
        const refs = this.lib.swatches[baseName] ?? this.lib.swatches[Object.keys(this.lib.swatches)[0]];
        if (refs) {
          const rc = addRecolor(mat, refs);
          rc.set(SKIN_TONES[a.skin].color, HAIR_COLORS[a.hairColor].color, EYE_COLORS[a.eyes].color);
          this.recolors.push(rc);
          if (faceMesh && faceMesh.material === mat) {
            rc.setFace(faceId);
            this.faceRecolors.push(rc);
          }
          const glow = glowOf.get(mat);
          if (glow) {
            rc.setGlow(glow, 1);
            this.glowRecolors.push(rc);
          }
        }
      }
    }
    this.measureHead(faceMesh ?? null);
    this.setupCape();
    if (bow) {
      const b = createBow(this.scene, bow);
      const slot = this.nodes.get('handslot.l');
      if (slot) {
        b.parent = slot;
        // Slot space is in model units; bows are built in metres.
        const s = 1 / this.unitScale;
        b.scaling.setAll(s * 0.95);
        b.rotationQuaternion = Quaternion.FromEulerAngles(0, 0, Math.PI / 2);
        b.position.set(0, 0, 0);
      }
      b.isPickable = false;
      this.extra.push(b);
      this.meshes = [...meshes, b];
    }

    // Body proportions.
    const bt = BODY_TYPES[a.body] ?? BODY_TYPES[1];
    const s = this.unitScale;
    this.body.scaling.set(s * bt.width, s * bt.height, s * bt.width);
    const head = this.nodes.get('head');
    if (head) {
      head.scaling.set(bt.head / bt.width, bt.head / bt.height, bt.head / bt.width);
      this.headRest = (head.rotationQuaternion ?? Quaternion.FromEulerVector(head.rotation)).clone();
    }

    const rq = (n: string) => {
      const t = this.nodes.get(n);
      return t?.rotationQuaternion ? t.rotationQuaternion.clone() : null;
    };
    this.torsoRest = [rq('spine'), rq('chest')];

    const groups = entries.animationGroups;
    this.animator = new Animator(groups, LOCO);
    this.animator.scale = s * bt.height;
    this.animator.cadence = CADENCE;
    this.thighMean = [null, null];
    this.applyStrides();
    if (prevAction) this.animator.play(prevAction, { loop: true });
    inkCharacter(this.meshes, { rim: this.showcase ? 2.1 : 1.3 });
    this.inkColors(a);
    this.ink = new InkScaler(this.meshes);
    this.headChain = [];
    for (let n: Node | null = head ?? null; n; n = n.parent) if (n instanceof TransformNode) this.headChain.unshift(n);
    this.setVisible(this.visible);
  }

  /** Outline colours per part: hair and face lines take their own dark tone. */
  private inkColors(a: Appearance) {
    const hair = inkFor(HAIR_COLORS[a.hairColor].color);
    const skin = inkFor(SKIN_TONES[a.skin].color);
    // keep face lines warm and soft, never darker than the default ink
    skin.r = Math.max(skin.r, 0.06);
    for (const m of this.meshes) {
      const c = m.name.endsWith('__hair') ? hair : m.name.endsWith('__face') && !m.name.startsWith('head_hooded') ? skin : INK;
      m.outlineColor.copyFrom(c);
    }
  }

  /**
   * Find the head's centre and size from the face mesh in its rest pose, in
   * head-node space, plus which way the face looks (for face shading, blush
   * and the hair gradient).
   */
  private measureHead(face: AbstractMesh | null) {
    const head = this.nodes.get('head');
    this.headRadius = 0;
    if (!head || !face) return;
    const chain: TransformNode[] = [];
    for (let n: Node | null = head; n; n = n.parent) if (n instanceof TransformNode) chain.unshift(n);
    for (const n of chain) n.computeWorldMatrix(true);
    face.computeWorldMatrix(true);
    const bb = face.getBoundingInfo().boundingBox;
    const inv = head.getWorldMatrix().clone().invert();
    Vector3.TransformCoordinatesToRef(bb.centerWorld, inv, this.headLocal);
    const ext = bb.extendSizeWorld;
    const headScale = Vector3.TransformNormal(Vector3.Right(), head.getWorldMatrix()).length();
    // a sphere a bit smaller than the box: KayKit heads are rounded cubes
    this.headRadius = ((ext.x + ext.y + ext.z) / 3) * 0.95 / Math.max(headScale, 1e-6);
    const rootW = this.root.getWorldMatrix();
    const fwd = Vector3.TransformNormal(new Vector3(0, 0, 1), rootW);
    const up = Vector3.TransformNormal(new Vector3(0, 1, 0), rootW);
    Vector3.TransformNormalToRef(fwd, inv, this.faceFwd);
    Vector3.TransformNormalToRef(up, inv, this.faceUp);
    this.faceFwd.normalize();
    this.faceUp.normalize();
  }

  /** Move the face-shading sphere with the head (after animation and IK). */
  private updateFace() {
    if (!this.recolors.length || this.headRadius <= 0) return;
    const chain = this.headChain;
    if (!chain.length) return;
    for (let i = 0; i < chain.length; i++) chain[i].computeWorldMatrix(true);
    const w = chain[chain.length - 1].getWorldMatrix();
    const m = w.m;
    const scale = Math.hypot(m[0], m[1], m[2]);
    // every material: skin near the head, hair and face may each sit in a different atlas
    for (const rc of this.recolors) rc.setHead(w, this.headLocal, this.headRadius * scale, this.faceFwd, this.faceUp);
  }

  /** Model units → metres. */
  get unitScale() {
    return CHARACTER_HEIGHT / this.lib.heightUnits;
  }

  private applyStrides() {
    let cache = strideCache.get(this.lib);
    if (!cache) {
      cache = {};
      const fl = this.nodes.get('foot.l');
      const fr = this.nodes.get('foot.r');
      const rootNode = this.nodes.get('root');
      if (fl && fr && rootNode) {
        for (const key of ['walk', 'run', 'sprint', 'back', 'left', 'right'] as const) {
          const g = this.animator.locoGroup(key);
          if (g) cache[key] = measureStride(g, fl, fr, rootNode);
        }
        // restart loops in phase
        for (const key of Object.keys(LOCO) as (keyof typeof LOCO)[]) {
          const g = this.animator.locoGroup(key);
          if (g) g.goToFrame(g.from);
        }
      }
      strideCache.set(this.lib, cache);
    }
    for (const [k, v] of Object.entries(cache)) this.animator.setStride(k as 'walk', v);
  }

  setVisible(v: boolean) {
    this.visible = v;
    for (const m of this.meshes) m.setEnabled(v);
  }

  /** Portrait lighting for the character creator stage (stronger rim light). */
  setShowcase(on: boolean) {
    this.showcase = on;
    for (const m of this.meshes) setToon(m.material, { rim: on ? 2.1 : 1.3 });
  }

  /** Recolour without rebuilding (live preview in the creator). */
  setColors(a: Appearance) {
    for (const rc of this.recolors) rc.set(SKIN_TONES[a.skin].color, HAIR_COLORS[a.hairColor].color, EYE_COLORS[a.eyes].color);
    this.inkColors(a);
    this.look = { ...this.look, appearance: { ...this.look.appearance, skin: a.skin, hairColor: a.hairColor, eyes: a.eyes } };
  }

  setShadowCaster(add: (m: AbstractMesh) => void) {
    for (const m of this.meshes) add(m);
  }

  node(name: string) {
    return this.nodes.get(name);
  }

  /**
   * Per-frame update. `vel` is world-space planar velocity (m/s), `turnRate`
   * the yaw rate (rad/s) used for leaning into turns.
   */
  update(dt: number, vel: Vector3, turnRate: number, airborne: boolean) {
    const yaw = this.root.rotation.y;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const localX = vel.x * c - vel.z * s;
    const localZ = vel.x * s + vel.z * c;
    this.animator.airborne = airborne;
    this.animator.setMotion(localX, localZ, dt);
    this.animator.update(dt);
    const speed = Math.hypot(vel.x, vel.z);
    const targetLean = Math.max(-0.22, Math.min(0.22, -turnRate * speed * 0.018));
    this.lean += (targetLean - this.lean) * (1 - Math.exp(-dt * 6));
    this.body.rotation.z = this.lean;
    this.dt = dt;
    this.updateBodyLayer(dt);
    this.swayCape(dt, Math.max(0, localZ), Math.abs(localX));
  }

  /**
   * Find the cape (a rigid mesh hung from the chest), pivot it at its top edge
   * and work out which local axis swings its hem backwards.
   */
  private setupCape() {
    this.cape = null;
    const cape = this.meshes.find((m) => m.name.startsWith('cape_'));
    if (!cape || cape.skeleton) return;
    cape.computeWorldMatrix(true);
    const bb = cape.getBoundingInfo().boundingBox;
    const top = new Vector3((bb.minimum.x + bb.maximum.x) / 2, bb.maximum.y, (bb.minimum.z + bb.maximum.z) / 2);
    const hem = new Vector3(top.x, bb.minimum.y, top.z);
    cape.setPivotPoint(top);
    if (!cape.rotationQuaternion) cape.rotationQuaternion = Quaternion.FromEulerVector(cape.rotation);
    const inv = cape.getWorldMatrix().clone().invert();
    const back = Vector3.TransformNormal(Vector3.TransformNormal(new Vector3(0, 0, -1), this.root.getWorldMatrix()), inv).normalize();
    const axis = Vector3.Cross(hem.subtract(top), back);
    if (axis.lengthSquared() < 1e-10) return;
    axis.normalize();
    const base = cape.rotationQuaternion.clone();
    // check the sign: the hem must move backwards
    const before = Vector3.TransformCoordinates(hem, cape.computeWorldMatrix(true));
    cape.rotate(axis, 0.3, Space.LOCAL);
    const after = Vector3.TransformCoordinates(hem, cape.computeWorldMatrix(true));
    cape.rotationQuaternion.copyFrom(base);
    cape.computeWorldMatrix(true);
    const backW = Vector3.TransformNormal(new Vector3(0, 0, -1), this.root.getWorldMatrix());
    if (Vector3.Dot(after.subtract(before), backW) < 0) axis.scaleInPlace(-1);
    this.cape = { mesh: cape, base, axis, angle: 0, vel: 0 };
  }

  /** Cheap secondary motion: the cape lifts behind a running character and breathes at rest. */
  private swayCape(dt: number, forward: number, sideways: number) {
    const c = this.cape;
    if (!c || !c.mesh.rotationQuaternion || dt <= 0) return;
    this.capeT += dt;
    const target = Math.min(0.75, forward * 0.085 + sideways * 0.03) + 0.035 * Math.sin(this.capeT * 1.7) + 0.02 * Math.sin(this.capeT * 2.9 + 1.3) + (forward > 0.5 ? 0.05 * Math.sin(this.capeT * 9) : 0);
    // a damped spring, so it settles back with a little swing
    const k = 60;
    const damp = 9;
    const h = Math.min(dt, 0.05);
    c.vel += ((target - c.angle) * k - c.vel * damp) * h;
    c.angle = Math.max(-0.05, Math.min(0.9, c.angle + c.vel * h));
    c.mesh.rotationQuaternion.copyFrom(c.base);
    c.mesh.rotate(c.axis, c.angle, Space.LOCAL);
  }

  private dt = 0.016;

  /**
   * Knock the body layer: `pitch` leans forward (negative: back), `twist`
   * turns the torso, `crouch` drops the hips (metres per second of impulse).
   */
  impulse(pitch: number, twist = 0, crouch = 0) {
    this.pitch.v += pitch;
    this.twist.v += twist;
    this.crouch.v += crouch;
  }

  /** React to a blow from world direction `from` (pointing at us) of strength 0..1. */
  flinch(from: Vector3 | null, amount: number) {
    const a = Math.min(1.2, amount);
    let side = Math.random() - 0.5;
    if (from) {
      const ry = this.root.rotation.y;
      // hit on the right side turns us left, and the other way round
      side = from.x * Math.cos(ry) - from.z * Math.sin(ry);
    }
    this.impulse(-(5 + 6 * a), Math.sign(side || 1) * (2.5 + 3.5 * a), 0.8 + 1.2 * a);
  }

  /**
   * Targets for the body layer from the current attack's timeline: settle
   * into the wind-up, drive through the strike, and let the springs carry
   * the momentum (and overshoot) into the follow-through.
   */
  private updateBodyLayer(dt: number) {
    const ph = this.animator.phase();
    let gain = 0;
    let pitch = 0;
    let crouch = 0;
    if (ph) {
      const p = ph.power;
      const w = Math.min(1, ph.weight);
      const t = ph.t;
      const lerp = (a: number, b: number, k: number) => a + (b - a) * Math.max(0, Math.min(1, k));
      // [wind-up lean, strike lean, plant] per style
      const [back, through, plant] = ph.style === 'strike' ? [-0.09, 0.22, 0.1] : ph.style === 'release' ? [0.05, -0.1, 0.035] : [-0.05, 0.12, 0.05];
      const coil = ph.style === 'strike' ? 0.28 : 0.15;
      const drive = ph.style === 'strike' ? 0.42 : 0.2;
      if (t < ph.strikeAt) {
        const k = smoothstep(t / Math.max(1e-3, ph.strikeAt));
        gain = coil * k;
        pitch = back * k;
        crouch = plant * 0.4 * k;
      } else if (t < ph.contactAt) {
        const k = (t - ph.strikeAt) / Math.max(1e-3, ph.contactAt - ph.strikeAt);
        gain = lerp(coil, drive, k);
        pitch = lerp(back, through, k * k);
        crouch = lerp(plant * 0.4, plant, k);
      } else if (t < ph.settleAt) {
        const k = (t - ph.contactAt) / Math.max(1e-3, ph.settleAt - ph.contactAt);
        gain = lerp(drive, drive * 0.6, k);
        pitch = lerp(through, through * 0.7, k);
        crouch = plant;
      } else {
        const k = 1 - smoothstep((t - ph.settleAt) / Math.max(1e-3, ph.duration - ph.settleAt));
        gain = drive * 0.6 * k;
        pitch = through * 0.7 * k;
        crouch = plant * k;
      }
      gain *= w * (0.6 + 0.4 * p);
      pitch *= w * (0.5 + 0.5 * p);
      crouch *= w * (0.4 + 0.6 * p);
    }
    this.torsoGain += (gain - this.torsoGain) * (1 - Math.exp(-dt * 30));
    // frozen with the clip during hit-stop
    if (ph?.stopped) return;
    stepSpring(this.pitch, pitch, dt, 8, 0.42);
    stepSpring(this.twist, 0, dt, 6, 0.38);
    stepSpring(this.crouch, crouch, dt, 7, 0.5);
  }

  /** Exaggerate the attack clip's own torso motion, then lean and twist the body layer. */
  private applyBodyLayer() {
    const spine = this.nodes.get('spine');
    const chest = this.nodes.get('chest');
    if (!spine || !chest) return;
    const gain = this.torsoGain;
    if (gain > 0.005) {
      for (const [i, n] of [spine, chest].entries()) {
        const rest = this.torsoRest[i];
        if (rest && n.rotationQuaternion) scaleFromRest(rest, n.rotationQuaternion, 1 + gain);
      }
    }
    const pitch = this.pitch.x;
    const twist = this.twist.x;
    if (Math.abs(pitch) < 1e-3 && Math.abs(twist) < 1e-3) return;
    const ry = this.root.rotation.y;
    const right = new Vector3(Math.cos(ry), 0, -Math.sin(ry));
    const up = Vector3.Up();
    spine.rotate(right, pitch * 0.45, Space.WORLD);
    chest.rotate(right, pitch * 0.55, Space.WORLD);
    if (Math.abs(twist) > 1e-3) {
      spine.rotate(up, twist * 0.4, Space.WORLD);
      chest.rotate(up, twist * 0.6, Space.WORLD);
    }
  }

  private postAnimate() {
    // (bones are only reset by playing animations: layering on a frozen pose would accumulate)
    if (!this.visible || !this.entries || !this.scene.animationsEnabled) return;
    this.applyBodyLayer();
    this.applyLookAt();
    if (this.ikEnabled && this.groundAt) this.applyFootIK();
    this.updateFace();
    this.time += this.dt;
    for (const rc of this.glowRecolors) rc.setTime(this.time);
    const cam = this.scene.activeCamera;
    if (cam && this.ink) this.ink.update(this.root.position, cam.globalPosition);
  }

  private applyLookAt() {
    const head = this.nodes.get('head');
    if (!head || !this.headRest) return;
    // the head keeps its eyes on the fight while the body layer leans (look-at turns on top)
    const tilt = this.pitch.x;
    head.rotationQuaternion = this.headRest.clone();
    if (Math.abs(tilt) > 1e-3) {
      const ry = this.root.rotation.y;
      head.rotate(new Vector3(Math.cos(ry), 0, -Math.sin(ry)), -tilt * 0.5, Space.WORLD);
    }
    let yaw = 0;
    let pitch = 0;
    if (this.lookTarget) {
      head.computeWorldMatrix(true);
      const hp = head.getAbsolutePosition();
      const d = this.lookTarget.subtract(hp);
      const ry = this.root.rotation.y;
      const lx = d.x * Math.cos(ry) - d.z * Math.sin(ry);
      const lz = d.x * Math.sin(ry) + d.z * Math.cos(ry);
      yaw = Math.atan2(lx, lz);
      pitch = -Math.atan2(d.y, Math.hypot(lx, lz));
      if (Math.abs(yaw) > 1.9) yaw = 0; // behind: don't owl-turn
      yaw = Math.max(-1.0, Math.min(1.0, yaw));
      pitch = Math.max(-0.5, Math.min(0.45, pitch));
    }
    const k = 1 - Math.exp(-this.dt * 8);
    this.lookYaw += (yaw - this.lookYaw) * k;
    this.lookPitch += (pitch - this.lookPitch) * k;
    if (!Number.isFinite(this.lookYaw) || !Number.isFinite(this.lookPitch)) {
      this.lookYaw = 0;
      this.lookPitch = 0;
      return;
    }
    if (Math.abs(this.lookYaw) < 1e-3 && Math.abs(this.lookPitch) < 1e-3) return;
    const up = Vector3.Up();
    const right = new Vector3(Math.cos(this.root.rotation.y), 0, -Math.sin(this.root.rotation.y));
    head.rotate(up, this.lookYaw, Space.WORLD);
    head.rotate(right, this.lookPitch, Space.WORLD);
    const chest = this.nodes.get('chest');
    if (chest) chest.rotate(up, this.lookYaw * 0.25, Space.WORLD);
  }

  private applyFootIK() {
    const ground = this.groundAt!;
    const rootY = this.root.position.y;
    const legs: [string, string, string][] = [
      ['upperleg.l', 'lowerleg.l', 'foot.l'],
      ['upperleg.r', 'lowerleg.r', 'foot.r'],
    ];
    const rise = this.warpStride(legs);
    const offsets: number[] = [];
    const feet: Vector3[] = [];
    for (const [, , f] of legs) {
      const foot = this.nodes.get(f);
      if (!foot) return;
      foot.computeWorldMatrix(true);
      const p = foot.getAbsolutePosition().clone();
      feet.push(p);
      const h = ground(p.x, p.z);
      offsets.push(Math.max(-0.45, Math.min(0.45, h - rootY)));
    }
    // Lower the hips so the lower foot can reach its ground.
    // (and to take back the height a longer stride lifts the planted foot by)
    const drop = Math.min(0, offsets[0], offsets[1]) - rise - Math.max(-0.03, Math.min(0.16, this.crouch.x));
    this.hipDrop += (drop - this.hipDrop) * (1 - Math.exp(-this.dt * 12));
    const hips = this.nodes.get('hips');
    if (hips && Math.abs(this.hipDrop) > 0.002) {
      hips.computeWorldMatrix(true);
      // hips local space is in model units under the scaled body
      hips.position.y += this.hipDrop / this.body.scaling.y;
    }
    for (let i = 0; i < 2; i++) {
      const target = feet[i].clone();
      target.y += offsets[i] - rise;
      if (Math.abs(offsets[i] - rise - this.hipDrop) < 0.01) continue;
      this.solveLeg(legs[i], target);
    }
  }

  /**
   * Lengthen the stride by swinging each thigh further around its average
   * pose, so a natural cadence still covers the ground. Returns how far that
   * lifted the lower foot (metres), for the hips to sink back down.
   */
  private warpStride(legs: [string, string, string][]): number {
    const gain = this.animator.strideGain;
    const k = 1 - Math.exp(-this.dt / 0.45);
    const before = this.lowestFoot(legs);
    let warped = false;
    for (let i = 0; i < 2; i++) {
      const thigh = this.nodes.get(legs[i][0]);
      const q = thigh?.rotationQuaternion;
      if (!thigh || !q) continue;
      let mean = this.thighMean[i];
      if (!mean) mean = this.thighMean[i] = q.clone();
      else Quaternion.SlerpToRef(mean, q, k, mean);
      if (gain < 1.005) continue;
      // delta = mean⁻¹·q, scaled in angle, re-applied on the mean
      const delta = Quaternion.Inverse(mean).multiply(q);
      if (delta.w < 0) delta.scaleInPlace(-1);
      const half = Math.acos(Math.min(1, delta.w));
      const sinHalf = Math.sin(half);
      if (sinHalf < 1e-5) continue;
      const nh = Math.min(half * gain, 1.2);
      const f = Math.sin(nh) / sinHalf;
      const scaled = new Quaternion(delta.x * f, delta.y * f, delta.z * f, Math.cos(nh));
      mean.multiplyToRef(scaled, q);
      warped = true;
    }
    if (!warped || before === null) return 0;
    const after = this.lowestFoot(legs);
    return after === null ? 0 : Math.max(0, Math.min(0.08, after - before));
  }

  /** World height of the lower foot, with its whole parent chain refreshed. */
  private lowestFoot(legs: [string, string, string][]): number | null {
    let low = Infinity;
    for (const [, , f] of legs) {
      const foot = this.nodes.get(f);
      if (!foot) return null;
      const chain: TransformNode[] = [];
      for (let n: Node | null = foot; n; n = n.parent) if (n instanceof TransformNode) chain.push(n);
      for (let j = chain.length - 1; j >= 0; j--) chain[j].computeWorldMatrix(true);
      low = Math.min(low, foot.getAbsolutePosition().y);
    }
    return low;
  }

  /** Analytic two-bone IK in world space, bending in the leg's current plane. */
  private solveLeg([u, l, f]: [string, string, string], target: Vector3) {
    const upper = this.nodes.get(u)!;
    const lower = this.nodes.get(l)!;
    const foot = this.nodes.get(f)!;
    upper.computeWorldMatrix(true);
    lower.computeWorldMatrix(true);
    foot.computeWorldMatrix(true);
    const A = upper.getAbsolutePosition().clone();
    const B = lower.getAbsolutePosition().clone();
    const C = foot.getAbsolutePosition().clone();
    const lab = Vector3.Distance(A, B);
    const lbc = Vector3.Distance(B, C);
    const toT = target.subtract(A);
    const lat = Math.max(0.05, Math.min(lab + lbc - 0.002, toT.length()));
    const d = toT.normalize();
    // keep the knee on the same side (pole = current knee offset from the hip-foot line)
    const ac = C.subtract(A).normalize();
    const ab = B.subtract(A);
    let pole = ab.subtract(ac.scale(Vector3.Dot(ab, ac)));
    if (pole.lengthSquared() < 1e-8) pole = new Vector3(Math.sin(this.root.rotation.y), 0, Math.cos(this.root.rotation.y));
    pole.normalize();
    pole = pole.subtract(d.scale(Vector3.Dot(pole, d))).normalize();
    const cosA = Math.max(-1, Math.min(1, (lab * lab + lat * lat - lbc * lbc) / (2 * lab * lat)));
    const sinA = Math.sqrt(1 - cosA * cosA);
    const knee = A.add(d.scale(lab * cosA)).add(pole.scale(lab * sinA));
    aimBone(upper, lower, knee);
    aimBone(lower, foot, target);
  }

  disposeModel() {
    this.animator?.dispose();
    for (const rc of this.recolors) rc.plugin.dispose();
    this.recolors = [];
    for (const m of this.extra) m.dispose(false, true);
    this.extra = [];
    if (this.entries) {
      for (const r of this.entries.rootNodes) r.dispose(false, false);
      for (const s of this.entries.skeletons) s.dispose();
    }
    for (const m of this.materials) m.dispose();
    this.materials = [];
    this.entries = null;
  }

  dispose() {
    if (this.obs) this.scene.onAfterAnimationsObservable.remove(this.obs);
    this.disposeModel();
    this.root.dispose();
  }
}

function smoothstep(x: number) {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}

/** Scale the rotation `q` makes away from `rest` by `gain` (in place). */
function scaleFromRest(rest: Quaternion, q: Quaternion, gain: number) {
  const delta = Quaternion.Inverse(rest).multiply(q);
  if (delta.w < 0) delta.scaleInPlace(-1);
  const half = Math.acos(Math.min(1, delta.w));
  const sinHalf = Math.sin(half);
  if (sinHalf < 1e-5) return;
  const nh = Math.min(half * gain, 1.3);
  const f = Math.sin(nh) / sinHalf;
  rest.multiplyToRef(new Quaternion(delta.x * f, delta.y * f, delta.z * f, Math.cos(nh)), q);
}

/** Rotate `bone` in world space so the direction bone→child points at `target`. */
function aimBone(bone: TransformNode, child: TransformNode, target: Vector3) {
  bone.computeWorldMatrix(true);
  child.computeWorldMatrix(true);
  const pivot = bone.getAbsolutePosition().clone();
  const from = child.getAbsolutePosition().subtract(pivot).normalize();
  const to = target.subtract(pivot).normalize();
  const dot = Vector3.Dot(from, to);
  if (dot > 0.99999) return;
  const axis = Vector3.Cross(from, to);
  if (axis.lengthSquared() < 1e-10) return;
  axis.normalize();
  const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
  bone.rotate(axis, angle, Space.WORLD);
  // Handedness: check the result and flip the rotation if it went the wrong way.
  bone.computeWorldMatrix(true);
  child.computeWorldMatrix(true);
  const now = child.getAbsolutePosition().subtract(pivot).normalize();
  if (Vector3.Dot(now, to) < dot) {
    bone.rotate(axis, -2 * angle, Space.WORLD);
    bone.computeWorldMatrix(true);
  }
}
