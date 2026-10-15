// A risen skeleton assembled from the KayKit Skeletons rig: body parts for its
// kind, weapon and shield in its hands, glowing eyes, and the same blended,
// stride-matched locomotion the players use.
import { Color3, PBRMaterial, TransformNode, Vector3, type AbstractMesh, type InstantiatedEntries, type Scene } from '@babylonjs/core';
import type { MonsterDef } from '@kelia/shared';
import { Animator, measureStride } from './animator';
import type { RigLibrary } from './library';
import { CHARACTER_HEIGHT } from './model';

const LOCO = { idle: 'Idle', walk: 'Walking_D_Skeletons', run: 'Running_A' };
const strideCache = new WeakMap<RigLibrary, Record<string, number>>();

export class MonsterModel {
  readonly root: TransformNode;
  private body: TransformNode;
  private entries: InstantiatedEntries;
  private nodes = new Map<string, TransformNode>();
  readonly animator: Animator;
  meshes: AbstractMesh[] = [];
  private flashT = 0;
  private eyeMats: PBRMaterial[] = [];
  private bodyMats: PBRMaterial[] = [];

  constructor(scene: Scene, lib: RigLibrary, readonly def: MonsterDef, name: string) {
    this.root = new TransformNode(name, scene);
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
        mat.emissiveColor = eye.scale(3);
        this.eyeMats.push(mat);
      } else {
        mat.metallic = 0;
        mat.roughness = 0.7;
        mat.environmentIntensity = 0.8;
        this.bodyMats.push(mat);
      }
    }
    const s = (CHARACTER_HEIGHT * def.scale) / lib.heightUnits;
    this.body.scaling.setAll(s);

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

  setShadowCaster(add: (m: AbstractMesh) => void) {
    for (const m of this.meshes) add(m);
  }

  node(name: string) {
    return this.nodes.get(name);
  }

  /** White flash when hit. */
  flash() {
    this.flashT = 0.14;
  }

  update(dt: number, vel: Vector3) {
    const yaw = this.root.rotation.y;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    this.animator.setMotion(vel.x * c - vel.z * s, vel.x * s + vel.z * c, dt);
    this.animator.update(dt);
    if (this.flashT > 0 || this.flashing) {
      this.flashT = Math.max(0, this.flashT - dt);
      const k = this.flashT / 0.14;
      for (const m of this.bodyMats) m.emissiveColor.set(k * 0.9, k * 0.85, k * 0.8);
      this.flashing = this.flashT > 0;
    }
  }

  private flashing = false;

  dispose() {
    this.animator.dispose();
    for (const r of this.entries.rootNodes) r.dispose(false, true);
    for (const s of this.entries.skeletons) s.dispose();
    this.root.dispose();
  }
}
