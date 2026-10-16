// Re-proportions the KayKit adventurer rig into an anime hero: the clips
// only key bone rotations (and the hips' position), so stretching the bones
// keeps every animation, while the body goes from a chibi (head half the
// height) to a ~7-head figure. Built in metres: the hero needs no scaling.
import { Matrix, Quaternion, Vector3, type AssetContainer, type Skeleton, type TransformNode } from '@babylonjs/core';

/** Hips rest height in the KayKit clips, and the hip joint's height above the ground there. */
const KAY_HIPS = 0.4056634306907654;
const KAY_LEG = 0.519;

/** Where the hero's hips rest, and the hip joint height (feet on the ground). */
export const HERO_HIPS = 0.95;
const HERO_LEG = 0.93;

/**
 * New local offsets (parent bone space). `len` keeps the KayKit direction
 * and sets the length (limb chains, so every angle in the clips reads the
 * same); `at` sets the offset outright (where a limb hangs off the torso).
 */
const BONES: Record<string, { len?: number; at?: [number, number, number] }> = {
  spine: { at: [0, 0.12, 0] },
  chest: { at: [0, 0.19, 0] },
  head: { at: [0, 0.245, 0] },
  'upperarm.l': { at: [0.158, 0.178, 0] },
  'upperarm.r': { at: [-0.158, 0.178, 0] },
  'lowerarm.l': { len: 0.285 },
  'lowerarm.r': { len: 0.285 },
  'wrist.l': { len: 0.245 },
  'wrist.r': { len: 0.245 },
  'hand.l': { len: 0.035 },
  'hand.r': { len: 0.035 },
  'handslot.l': { at: [0, 0.052, -0.026] },
  'handslot.r': { at: [0, 0.052, -0.026] },
  'upperleg.l': { at: [0.088, -0.02, 0] },
  'upperleg.r': { at: [-0.088, -0.02, 0] },
  'lowerleg.l': { len: 0.43 },
  'lowerleg.r': { len: 0.43 },
  'foot.l': { len: 0.418 },
  'foot.r': { len: 0.418 },
  'toes.l': { len: 0.112 },
  'toes.r': { len: 0.112 },
};

/** Rest pose of the stretched rig: every bone's world matrix in rig space (for building meshes). */
export interface HeroRest {
  world: Map<string, Matrix>;
  pos(name: string): Vector3;
}

/**
 * Stretch the rig in the container (bones, skeleton bind pose and the hips
 * track of every clip). Call once, before any character is instantiated.
 */
export function stretchRig(c: AssetContainer, skeleton: Skeleton): HeroRest {
  const nodes = new Map<string, TransformNode>();
  for (const n of c.transformNodes) nodes.set(n.name, n);
  for (const [name, b] of Object.entries(BONES)) {
    const n = nodes.get(name);
    if (!n) continue;
    if (b.at) n.position.set(...b.at);
    else if (b.len !== undefined) {
      const l = n.position.length();
      if (l > 1e-6) n.position.scaleInPlace(b.len / l);
    }
  }
  const hips = nodes.get('hips');
  hips?.position.set(0, HERO_HIPS, 0);

  // the clips' hips track: same motion about the new rest, scaled to the longer legs
  const k = HERO_LEG / KAY_LEG;
  for (const g of c.animationGroups) {
    for (const ta of g.targetedAnimations) {
      if ((ta.target as TransformNode)?.name !== 'hips' || ta.animation.targetProperty !== 'position') continue;
      for (const key of ta.animation.getKeys()) {
        const v = key.value as Vector3;
        key.value = new Vector3(v.x * k, HERO_HIPS + (v.y - KAY_HIPS) * k, v.z * k);
      }
    }
  }

  // new bind pose = the stretched rest pose (parents come before children in bones[])
  const local = new Matrix();
  for (const bone of skeleton.bones) {
    const n = bone.getTransformNode();
    if (!n) continue;
    Matrix.ComposeToRef(n.scaling, n.rotationQuaternion ?? Quaternion.FromEulerVector(n.rotation), n.position, local);
    bone.setRestMatrix(local);
    bone.updateMatrix(local, false, false);
    bone._updateAbsoluteBindMatrices(undefined, false);
  }

  const world = new Map<string, Matrix>();
  for (const bone of skeleton.bones) world.set(bone.name, bone.getAbsoluteInverseBindMatrix().clone().invert());
  return {
    world,
    pos(name: string) {
      const m = world.get(name);
      return m ? m.getTranslation() : Vector3.Zero();
    },
  };
}
