// A player (or NPC) character assembled from modular KayKit parts, recoloured
// to its appearance, animated with blended locomotion, and finished with
// two-bone foot IK on uneven ground, head look-at and turn lean, a
// spring-driven body layer that gives attacks their weight (coil, lean into
// the blow, plant the hips) and makes hits land (flinch away from the blow),
// and a glider: the body hangs from its handles (arms reaching up by IK,
// legs trailing), swinging under it as it banks.
import {
  BoundingInfo,
  Geometry,
  Matrix,
  Mesh,
  Node,
  PBRMaterial,
  Quaternion,
  Space,
  TransformNode,
  Vector3,
  VertexData,
  type AbstractMesh,
  type InstantiatedEntries,
  type Material,
  type Observer,
  type Scene,
  type Skeleton,
} from '@babylonjs/core';
import { BODY_TYPES, CLASSES, EYE_COLORS, HAIR_COLORS, ITEMS, SKIN_TONES, type Appearance, type ClassId } from '@kelia/shared';
import { perf } from '../core/perf';
import { Animator, measureStride } from './animator';
import { createBow } from './bow';
import { Glider, type GliderFit } from './glider';
import { BUILDS } from './hero/body';
import { buildHero } from './hero/build';
import { paintFace } from './hero/face';
import { Geo } from './hero/geo';
import { HeroAtlas, type PaletteColors } from './hero/palette';
import { HeroSurface } from './hero/surface';
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

/** The KayKit meshes a look still uses (weapons and shields), and the code-built bow. */
export function partsFor(look: Look): { meshes: Set<string>; bow: string | null } {
  const meshes = new Set<string>();
  let bow: string | null = null;
  for (const id of [look.weapon, look.offhand]) {
    const it = id ? ITEMS[id] : null;
    if (!it?.mesh) continue;
    if (it.mesh.startsWith('bow:')) bow = it.mesh.slice(4);
    else meshes.add(it.mesh);
  }
  return { meshes, bow };
}

/** The cape's vertices in the chest bone's space (it hangs rigidly from the chest and sways). */
const capeCache = new WeakMap<Geo, Geo>();
function capeLocal(cape: Geo, chestRest: Matrix): Geo {
  const hit = capeCache.get(cape);
  if (hit) return hit;
  const inv = chestRest.clone().invert();
  const g = new Geo();
  g.append(cape);
  const p = new Vector3();
  for (let v = 0; v < g.vertexCount; v++) {
    p.set(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]);
    Vector3.TransformCoordinatesToRef(p, inv, p);
    g.pos[v * 3] = p.x;
    g.pos[v * 3 + 1] = p.y;
    g.pos[v * 3 + 2] = p.z;
    p.set(g.nrm[v * 3], g.nrm[v * 3 + 1], g.nrm[v * 3 + 2]);
    Vector3.TransformNormalToRef(p, inv, p);
    p.normalize();
    g.nrm[v * 3] = p.x;
    g.nrm[v * 3 + 1] = p.y;
    g.nrm[v * 3 + 2] = p.z;
  }
  capeCache.set(cape, g);
  return g;
}

/** Weapons were sized for the chibi rig's hands: scale them to the hero's. */
const WEAPON_SCALE = 0.74;

/** Geometry uploaded once per built shape, shared by every character wearing it. */
const geometryCache = new WeakMap<Geo, Geometry>();

function heroMesh(scene: Scene, name: string, geo: Geo, skeleton: Skeleton | null, side: number): Mesh | null {
  if (!geo.idx.length) return null;
  let geometry = geometryCache.get(geo);
  if (!geometry || geometry.isDisposed()) {
    const vd = new VertexData();
    vd.positions = geo.pos;
    vd.normals = geo.nrm;
    vd.uvs = geo.uv;
    vd.indices = geo.idx;
    if (skeleton) {
      const mi = new Float32Array(geo.wts.length * 4);
      const mw = new Float32Array(geo.wts.length * 4);
      const index = new Map(skeleton.bones.map((b) => [b.name, b.getIndex()]));
      geo.wts.forEach((w, v) => {
        const top = w.filter(([n]) => index.has(n)).sort((x, y) => y[1] - x[1]).slice(0, 4);
        const sum = top.reduce((t, [, x]) => t + x, 0) || 1;
        top.forEach(([n, x], k) => {
          mi[v * 4 + k] = index.get(n)!;
          mw[v * 4 + k] = x / sum;
        });
      });
      vd.matricesIndices = mi;
      vd.matricesWeights = mw;
    }
    geometry = new Geometry(name + '_geo', scene, vd, false);
    geometryCache.set(geo, geometry);
  }
  const m = new Mesh(name, scene);
  geometry.applyToMesh(m);
  m.sideOrientation = side;
  if (skeleton) {
    m.skeleton = skeleton;
    m.numBoneInfluencers = 4;
    // bind-pose bounds plus room for raised arms and kicks
    const bi = m.getBoundingInfo();
    m.setBoundingInfo(new BoundingInfo(bi.minimum.add(new Vector3(-0.3, -0.2, -0.5)), bi.maximum.add(new Vector3(0.3, 0.6, 0.5))));
  }
  return m;
}

export class CharacterModel {
  /** World placement: position = feet, rotation.y = facing. */
  readonly root: TransformNode;
  /** Inner node for lean / hip drop. */
  private body: TransformNode;
  private entries: InstantiatedEntries | null = null;
  private nodes = new Map<string, TransformNode>();
  private recolors: RecolorPlugin[] = [];
  /** The hero's texture and surface plugin. */
  private atlas: HeroAtlas | null = null;
  private surface: HeroSurface | null = null;
  /** Recolour plugins of glowing weapons (animated). */
  private glowRecolors: RecolorPlugin[] = [];
  /** Head centre (head node space), radius (head node units) and face axes, for face shading. */
  private headLocal = new Vector3();
  private headRadius = 0;
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
  /** Gliding: the glider (made on first use), where it sits, and the pose. */
  private glider: Glider | null = null;
  private gliderMount: TransformNode | null = null;
  private gripPivot = new Vector3();
  private glideOn = false;
  private glideBank = 0;
  private glideDive = 0;
  /** How far into the hanging pose the body is (follows the glider's opening). */
  private glideW = 0;
  /** The body's own swing under the glider (pendulum lag behind the bank). */
  private hang = spring();
  private glidePitch = 0;
  private shadowAdd: ((m: AbstractMesh) => void) | null = null;
  /** Seconds of glide, for the legs' slow kick. */
  private glideT = 0;
  /** Airspeed for the canvas ripple and contrails. */
  private airspeed = 0;

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
    this.disposeGlider();
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
    // the hero's skeleton (cloned for this character); drop the rest
    const heroIdx = this.lib.heroSkeleton ? this.lib.container.skeletons.indexOf(this.lib.heroSkeleton) : -1;
    const skeleton = heroIdx >= 0 ? entries.skeletons[heroIdx] : null;
    for (const s of entries.skeletons) if (s !== skeleton) s.dispose();
    // (instantiation only relinks bones of skeletons whose meshes came along)
    if (skeleton) for (const b of skeleton.bones) b.linkTransformNode(this.nodes.get(b.name) ?? null);

    const a = look.appearance;
    // KayKit weapons and shields: scaled to the hero's hands, gear may glow
    const weapons = rootNode.getChildMeshes(false);
    for (const m of weapons) {
      const k = m.name.startsWith('sh_') ? WEAPON_SCALE * 0.72 : m.name.startsWith('oh_') ? WEAPON_SCALE * 0.85 : WEAPON_SCALE;
      m.scaling.scaleInPlace(k);
      m.position.scaleInPlace(k);
    }
    const glowOf = new Map<Material, string>();
    for (const id of [look.weapon, look.offhand]) {
      const it = id ? ITEMS[id] : null;
      if (!it?.glow || !it.mesh || it.mesh.startsWith('bow:')) continue;
      const wm = weapons.find((m) => m.name === it.mesh);
      if (wm && wm.material) {
        const gm = (wm.material as PBRMaterial).clone(wm.material.name + '_glow') as PBRMaterial;
        wm.material = gm;
        glowOf.set(gm, it.glow);
      }
    }
    const seen = new Set<Material>();
    this.glowRecolors = [];
    for (const m of weapons) {
      const mat = m.material;
      if (!mat || seen.has(mat)) continue;
      seen.add(mat);
      this.materials.push(mat);
      if (!(mat instanceof PBRMaterial)) continue;
      mat.metallic = 0;
      mat.roughness = 0.62;
      const baseName = mat.name.replace(/^Clone of /, '').replace(/\.\d+$/, '').replace(/_glow$/, '');
      const refs = this.lib.swatches[baseName] ?? this.lib.swatches[Object.keys(this.lib.swatches)[0]];
      if (!refs) continue;
      const rc = addRecolor(mat, refs);
      rc.set(SKIN_TONES[a.skin].color, HAIR_COLORS[a.hairColor].color, EYE_COLORS[a.eyes].color);
      this.recolors.push(rc);
      const glow = glowOf.get(mat);
      if (glow) {
        rc.setGlow(glow, 1);
        this.glowRecolors.push(rc);
      }
    }

    // the hero, built in code (char/hero) for this appearance
    const meshes: AbstractMesh[] = [...weapons];
    if (this.lib.hero) {
      const geo = buildHero(this.lib.hero, a);
      const atlas = new HeroAtlas(this.scene, this.root.name + '_atlas');
      this.atlas = atlas;
      this.paintAtlas(a, geo.colors);
      const mat = new PBRMaterial(this.root.name + '_hero', this.scene);
      mat.albedoTexture = atlas.texture;
      mat.metallic = 0;
      mat.roughness = 0.62;
      this.materials.push(mat);
      this.surface = new HeroSurface(mat);
      const side = this.lib.heroSide;
      for (const [part, g] of [['hero_body', geo.body], ['hero_hat', geo.hat], ['hero_head', geo.head], ['hero_hair', geo.hair]] as const) {
        const m = heroMesh(this.scene, `${this.root.name}_${part}`, g, skeleton, side);
        if (!m) continue;
        m.parent = rootNode;
        m.material = mat;
        meshes.push(m);
      }
      const chest = this.nodes.get('chest');
      const chestRest = this.lib.hero.world.get('chest');
      if (geo.cape.idx.length && chest && chestRest) {
        const m = heroMesh(this.scene, 'cape_hero', capeLocal(geo.cape, chestRest), null, side);
        if (m) {
          m.parent = chest;
          m.material = mat;
          meshes.push(m);
        }
      }
      const head = this.nodes.get('head');
      const headRest = this.lib.hero.world.get('head');
      if (head && headRest) {
        // the head (with hair) as a sphere in head-bone space, for the glider's fit
        Vector3.TransformCoordinatesToRef(new Vector3(0, 1.695, -0.01), headRest.clone().invert(), this.headLocal);
        this.headRadius = 0.13;
      }
    }
    for (const m of meshes) {
      m.isPickable = false;
      m.receiveShadows = true;
      m.alwaysSelectAsActiveMesh = false;
    }
    this.meshes = meshes;
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
      this.meshes = [...this.meshes, b];
    }

    // Body proportions: builds differ in shape (built in) and height.
    const bt = BODY_TYPES[a.body] ?? BODY_TYPES[1];
    const s = this.unitScale;
    this.body.scaling.setAll(s * bt.height);
    const head = this.nodes.get('head');
    if (head) this.headRest = (head.rotationQuaternion ?? Quaternion.FromEulerVector(head.rotation)).clone();

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

  /** Paint the character's texture: swatches and the face. */
  private paintAtlas(a: Appearance, colors: PaletteColors) {
    const atlas = this.atlas;
    if (!atlas) return;
    atlas.paintSwatches(colors);
    paintFace(atlas, {
      style: a.face,
      skin: colors.skin,
      hair: colors.hair,
      eye: EYE_COLORS[a.eyes]?.color ?? EYE_COLORS[0].color,
      soft: (BUILDS[a.body] ?? BUILDS[1]).bust > 0,
    });
    atlas.update();
  }

  /** Outline colours per part: hair and face lines take their own dark tone. */
  private inkColors(a: Appearance) {
    const hair = inkFor(HAIR_COLORS[a.hairColor].color);
    const skin = inkFor(SKIN_TONES[a.skin].color);
    // keep face lines warm and soft, never darker than the default ink
    skin.r = Math.max(skin.r, 0.06);
    for (const m of this.meshes) {
      const c = m.name.endsWith('hero_hair') ? hair : m.name.endsWith('hero_head') ? skin : INK;
      m.outlineColor.copyFrom(c);
    }
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
    this.look = { ...this.look, appearance: { ...this.look.appearance, skin: a.skin, hairColor: a.hairColor, eyes: a.eyes } };
    if (this.lib.hero) this.paintAtlas(this.look.appearance, buildHero(this.lib.hero, this.look.appearance).colors);
    this.inkColors(this.look.appearance);
  }

  setShadowCaster(add: (m: AbstractMesh) => void) {
    this.shadowAdd = add;
    for (const m of this.meshes) add(m);
    this.glider?.addShadows(add);
  }

  /**
   * Open or fold the glider. `bank` rolls it into turns (radians, right wing
   * down positive); `dive` tips it nose down.
   */
  glide(open: boolean, bank: number, dive: boolean) {
    this.glideOn = open;
    this.glideBank = bank;
    this.glideDive = dive ? 1 : 0;
  }

  get gliding() {
    return this.glideOn;
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
    this.animator.airborne = airborne || this.glideOn;
    this.animator.setMotion(localX, localZ, dt);
    this.animator.update(dt);
    const speed = Math.hypot(vel.x, vel.z);
    const targetLean = Math.max(-0.22, Math.min(0.22, -turnRate * speed * 0.018));
    this.lean += (targetLean - this.lean) * (1 - Math.exp(-dt * 6));
    this.body.rotation.z = this.lean;
    this.dt = dt;
    this.airspeed = speed;
    this.updateGlide(dt);
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
    if (this.glideOn && !this.glider) this.makeGlider();
    // with no clip writing the skeleton the bones still hold last frame's
    // layered pose: layering again would bend the torso a bit more every frame
    if (this.animator.posing) {
      this.applyArmDrop();
      this.applyBodyLayer();
      this.applyLookAt();
      if (this.glideW > 0.001) this.applyGlidePose();
      if (this.ikEnabled && this.groundAt && this.glideW < 0.5) this.applyFootIK();
    }
    if (this.glider) {
      const cam = this.scene.activeCamera;
      const emit = Math.max(0, Math.min(1, (this.airspeed - 4.5) / 4)) * Math.max(0, Math.min(1, this.glider.open));
      if (cam) this.glider.updateTrails(this.dt, emit, cam.globalPosition);
    }
    this.time += this.dt;
    for (const rc of this.glowRecolors) rc.setTime(this.time);
    this.surface?.setTime(this.time);
    const cam = this.scene.activeCamera;
    if (cam && this.ink) this.ink.update(this.root.position, cam.globalPosition);
  }

  /**
   * The clips were made for a stout chibi whose arms hang wide of a round
   * body; on the slim hero that reads as a scarecrow. Swing each upper arm
   * in toward the body (most at rest and on the move, less mid-attack).
   */
  private applyArmDrop() {
    const ry = this.root.rotation.y;
    const fwd = new Vector3(Math.sin(ry), 0, Math.cos(ry));
    const right = new Vector3(Math.cos(ry), 0, -Math.sin(ry));
    const k = 1 - 0.55 * this.animator.actionLevel;
    const keep = 0.42;
    for (const side of ['l', 'r'] as const) {
      const upper = this.nodes.get(`upperarm.${side}`);
      const lower = this.nodes.get(`lowerarm.${side}`);
      if (!upper || !lower) continue;
      const chain: TransformNode[] = [];
      for (let n: Node | null = lower; n; n = n.parent) if (n instanceof TransformNode) chain.unshift(n);
      for (const c of chain) c.computeWorldMatrix(true);
      const a = upper.getAbsolutePosition();
      const d = lower.getAbsolutePosition().subtract(a);
      const len = d.length();
      if (len < 1e-5) continue;
      d.scaleInPlace(1 / len);
      // which way is "out" for this shoulder
      const chest = this.nodes.get('chest');
      const out = chest ? a.subtract(chest.getAbsolutePosition()) : right.clone();
      const o = Vector3.Dot(out, right) >= 0 ? right : right.scale(-1);
      // abduction: the arm's angle out from hanging straight down, in the body's side plane
      const ab = Math.atan2(Vector3.Dot(d, o), -d.y);
      if (ab < 0.12 || ab > 2.2) continue;
      const target = 0.1 + (ab - 0.1) * keep;
      const delta = (ab - target) * k * smooth01((ab - 0.12) / 0.3);
      upper.rotate(fwd, delta, Space.WORLD);
      upper.computeWorldMatrix(true);
      lower.computeWorldMatrix(true);
      const d2 = lower.getAbsolutePosition().subtract(upper.getAbsolutePosition()).normalize();
      if (Vector3.Dot(d2, o) > Vector3.Dot(d, o)) {
        upper.rotate(fwd, -2 * delta, Space.WORLD);
        upper.computeWorldMatrix(true);
      }
    }
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

  // ------------------------------------------------------------------ gliding

  /**
   * Fit a glider to this body (from the current pose) and make it: the wing
   * roots clear of the head, the grips where the arms reach comfortably up
   * and out, the crossbar arcing behind the head.
   */
  private makeGlider() {
    const head = this.nodes.get('head');
    const arm = ['upperarm.r', 'lowerarm.r', 'wrist.r'].map((n) => this.nodes.get(n));
    const armL = this.nodes.get('upperarm.l');
    if (!head || !armL || arm.some((n) => !n)) return;
    const inv = this.root.computeWorldMatrix(true).clone().invert();
    const local = (n: TransformNode) => {
      const chain: TransformNode[] = [];
      for (let p: Node | null = n; p; p = p.parent) if (p instanceof TransformNode) chain.unshift(p);
      for (const c of chain) c.computeWorldMatrix(true);
      return Vector3.TransformCoordinates(n.getAbsolutePosition(), inv);
    };
    const [sR, eR, wR] = arm.map((n) => local(n!));
    const sL = local(armL);
    const reach = (Vector3.Distance(sR, eR) + Vector3.Distance(eR, wR)) * 0.92;
    const sx = (Math.abs(sR.x) + Math.abs(sL.x)) / 2;
    const sy = (sR.y + sL.y) / 2;
    const sz = (sR.z + sL.z) / 2;
    // head sphere (centre and radius) in root space
    local(head);
    const hw = head.getWorldMatrix();
    const hc = Vector3.TransformCoordinates(Vector3.TransformCoordinates(this.headLocal, hw), inv);
    const hr = this.headRadius > 0 ? this.headRadius * Vector3.TransformNormal(Vector3.Right(), hw).length() : 0.4;
    // grips up and out at the end of a comfortable reach; handles rise from there past the head
    const gx = sx + reach * 0.74;
    const gy = sy + reach * 0.67;
    this.gripPivot.set(0, gy, sz + 0.05);
    const fit: GliderFit = {
      halfGap: Math.max(hr * 1.08 + 0.05, gx),
      handle: Math.max(0.32, hc.y + 0.08 - gy),
      back: Math.max(0.2, this.gripPivot.z - hc.z + hr + 0.1),
    };
    const g = new Glider(this.scene, fit, CLASSES[this.look.cls]?.color ?? '#e0a64a');
    g.grips[0].x = gx;
    g.grips[1].x = -gx;
    const mount = new TransformNode('gliderMount', this.scene);
    mount.parent = this.root;
    mount.position.copyFrom(this.gripPivot);
    g.root.parent = mount;
    g.root.position.set(0, fit.handle, -0.05);
    this.glider = g;
    this.gliderMount = mount;
    if (this.shadowAdd) g.addShadows(this.shadowAdd);
    perf.tag(g.root, 'characters');
  }

  private disposeGlider() {
    this.glider?.dispose();
    this.gliderMount?.dispose();
    this.glider = null;
    this.gliderMount = null;
    this.glideW = 0;
    this.body.position.setAll(0);
    this.body.rotation.x = 0;
  }

  /** Glider fold, its attitude, and the body hanging (and swinging) beneath it. */
  private updateGlide(dt: number) {
    const g = this.glider;
    if (!g || !this.gliderMount) return;
    g.setTarget(this.glideOn);
    this.glideT += dt;
    const gust = this.glideDive * 0.8 + Math.max(0, Math.min(1, (this.airspeed - 7) / 4)) * 0.4;
    g.update(dt, this.airspeed, gust);
    const w = Math.max(0, Math.min(1, g.open));
    // the pose leads the canvas a little on the way in and lets go quickly on the way out
    this.glideW += (w - this.glideW) * (1 - Math.exp(-dt * (this.glideOn ? 10 : 16)));
    if (this.glideW < 0.001 && !this.glideOn) this.glideW = 0;
    // attitude: nose down in a dive, a slow porpoise otherwise; banked into turns
    const pitchT = this.glideDive * 0.28 + 0.04 + 0.025 * Math.sin(this.glideT * 1.3);
    this.glidePitch += (pitchT - this.glidePitch) * (1 - Math.exp(-dt * 3));
    const mount = this.gliderMount;
    mount.rotation.set(this.glidePitch * w, 0, -this.glideBank * w);
    // the body hangs from the grips, lagging behind the glider's roll like a pendulum
    stepSpring(this.hang, -this.glideBank * 0.6, dt, 3.2, 0.35);
    const ww = this.glideW;
    if (ww <= 0) {
      this.body.position.setAll(0);
      this.body.rotation.x = 0;
      return;
    }
    const pitch = ww * (0.3 + 0.22 * this.glideDive + 0.04 * Math.sin(this.glideT * 1.3 + 0.6));
    const roll = this.lean * (1 - ww) + this.hang.x * ww;
    this.body.rotation.x = pitch;
    this.body.rotation.z = roll;
    // rotate about the grips (they stay in the hands), not the feet
    const m = Matrix.RotationYawPitchRoll(0, pitch, roll);
    const pv = Vector3.TransformCoordinates(this.gripPivot, m);
    this.body.position.copyFrom(this.gripPivot.subtract(pv));
  }

  /** Hands on the grips, legs trailing with a lazy kick. */
  private applyGlidePose() {
    const g = this.glider;
    if (!g) return;
    const w = this.glideW;
    g.root.computeWorldMatrix(true);
    const ry = this.root.rotation.y;
    const right = new Vector3(Math.cos(ry), 0, -Math.sin(ry));
    // arms: reach for the grips (IK on the wrists), blending in with the pose
    const grip = new Vector3();
    for (const [i, side] of [[0, 'r'], [1, 'l']] as const) {
      const wrist = this.nodes.get(`wrist.${side}`);
      const upper = this.nodes.get(`upperarm.${side}`);
      if (!wrist || !upper) continue;
      // which grip is on this arm's side
      wrist.computeWorldMatrix(true);
      g.gripWorld(i, grip);
      const other = g.gripWorld(1 - i);
      const sh = upper.getAbsolutePosition();
      if (Vector3.DistanceSquared(sh, other) < Vector3.DistanceSquared(sh, grip)) grip.copyFrom(other);
      // the wrist sits just short of the grip so the hand closes round it
      const to = grip.subtract(sh);
      const target = grip.subtract(to.normalize().scale(0.04));
      const cur = wrist.getAbsolutePosition().clone();
      this.solveLeg([`upperarm.${side}`, `lowerarm.${side}`, `wrist.${side}`], Vector3.Lerp(cur, target, w));
    }
    // legs: swung back under the forward-leaning body, knees soft, a slow alternate kick
    const kick = Math.sin(this.glideT * 2.2) * 0.1 * (1 - this.glideDive * 0.7);
    for (const [i, side] of [[0, 'l'], [1, 'r']] as const) {
      const thigh = this.nodes.get(`upperleg.${side}`);
      const shin = this.nodes.get(`lowerleg.${side}`);
      if (!thigh || !shin) continue;
      const k = i === 0 ? kick : -kick;
      // (positive turns about the right axis swing a limb backwards)
      thigh.rotate(right, (0.12 + 0.15 * this.glideDive + k) * w, Space.WORLD);
      shin.rotate(right, (0.32 - 0.12 * this.glideDive + k * 0.6) * w, Space.WORLD);
    }
  }

  disposeModel() {
    this.animator?.dispose();
    for (const rc of this.recolors) rc.plugin.dispose();
    this.recolors = [];
    this.surface?.plugin.dispose();
    this.surface = null;
    this.atlas?.dispose();
    this.atlas = null;
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
    this.disposeGlider();
    this.root.dispose();
  }
}

function smooth01(x: number) {
  return smoothstep(x);
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
