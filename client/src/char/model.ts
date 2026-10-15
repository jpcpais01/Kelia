// A player (or NPC) character assembled from modular KayKit parts, recoloured
// to its appearance, animated with blended locomotion, and finished with
// two-bone foot IK on uneven ground, head look-at and turn lean.
import {
  Color3,
  Mesh,
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
import { Animator, measureStride } from './animator';
import { createBow } from './bow';
import type { RigLibrary } from './library';
import { addRecolor, type RecolorPlugin } from './recolor';

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
  /** World-space point to look at (null = straight ahead). */
  lookTarget: Vector3 | null = null;
  /** Ground height sampler for foot IK (null disables IK). */
  groundAt: ((x: number, z: number) => number) | null = null;
  ikEnabled = true;
  visible = true;
  meshes: AbstractMesh[] = [];

  constructor(private scene: Scene, private lib: RigLibrary, look: Look, name = 'character') {
    this.root = new TransformNode(name, scene);
    this.body = new TransformNode(name + '_body', scene);
    this.body.parent = this.root;
    this.setLook(look);
    this.obs = scene.onAfterAnimationsObservable.add(() => this.postAnimate());
  }

  /** Rebuild the model for a new look (outfit, weapon, appearance...). */
  setLook(look: Look) {
    const prevAction = this.animator?.currentAction;
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
    for (const id of [look.weapon, look.offhand]) {
      const it = id ? ITEMS[id] : null;
      if (!it?.glow || !it.mesh || it.mesh.startsWith('bow:')) continue;
      const wm = meshes.find((m) => m.name === it.mesh);
      if (wm && wm.material) {
        const gm = (wm.material as PBRMaterial).clone(wm.material.name + '_glow') as PBRMaterial;
        gm.emissiveColor = Color3.FromHexString(it.glow).toLinearSpace().scale(0.9);
        wm.material = gm;
      }
    }
    const seen = new Set<Material>();
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
        mat.environmentIntensity = 0.85;
        const baseName = mat.name.replace(/^Clone of /, '').replace(/\.\d+$/, '');
        const refs = this.lib.swatches[baseName] ?? this.lib.swatches[Object.keys(this.lib.swatches)[0]];
        if (refs) {
          const rc = addRecolor(mat, refs);
          rc.set(SKIN_TONES[a.skin].color, HAIR_COLORS[a.hairColor].color, EYE_COLORS[a.eyes].color);
          this.recolors.push(rc);
        }
      }
    }
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

    const groups = entries.animationGroups;
    this.animator = new Animator(groups, LOCO);
    this.animator.scale = s * bt.height;
    this.applyStrides();
    if (prevAction) this.animator.play(prevAction, { loop: true });
    this.setVisible(this.visible);
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

  /** Recolour without rebuilding (live preview in the creator). */
  setColors(a: Appearance) {
    for (const rc of this.recolors) rc.set(SKIN_TONES[a.skin].color, HAIR_COLORS[a.hairColor].color, EYE_COLORS[a.eyes].color);
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
  }

  private dt = 0.016;

  private postAnimate() {
    if (!this.visible || !this.entries) return;
    this.applyLookAt();
    if (this.ikEnabled && this.groundAt) this.applyFootIK();
  }

  private applyLookAt() {
    const head = this.nodes.get('head');
    if (!head || !this.headRest) return;
    head.rotationQuaternion = this.headRest.clone();
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
    const drop = Math.min(0, offsets[0], offsets[1]);
    this.hipDrop += (drop - this.hipDrop) * (1 - Math.exp(-this.dt * 12));
    const hips = this.nodes.get('hips');
    if (hips && Math.abs(this.hipDrop) > 0.002) {
      hips.computeWorldMatrix(true);
      // hips local space is in model units under the scaled body
      hips.position.y += this.hipDrop / this.body.scaling.y;
    }
    for (let i = 0; i < 2; i++) {
      const target = feet[i].clone();
      target.y += offsets[i];
      if (Math.abs(offsets[i] - this.hipDrop) < 0.01) continue;
      this.solveLeg(legs[i], target);
    }
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
