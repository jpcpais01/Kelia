// Chains of extra bones for secondary motion: long hair, ponytails, the
// locks framing the face and capes hang from the head or chest on short
// chains that char/secondary.ts simulates. Every hero skeleton carries every
// chain (the skeleton is shared by all looks); each look says where its
// chains' joints are (rig space) and weights its hair and cape to them.
import { Bone, Matrix, Vector3, type Skeleton } from '@babylonjs/core';
import { blend, clamp01, smooth, type Weights } from './geo';

export const CHAINS = {
  'hair.back': { parent: 'head', bones: 4, kind: 'hair' },
  'hair.tail': { parent: 'head', bones: 3, kind: 'hair' },
  'hair.side.l': { parent: 'head', bones: 3, kind: 'hair' },
  'hair.side.r': { parent: 'head', bones: 3, kind: 'hair' },
  'cape.l': { parent: 'chest', bones: 4, kind: 'cloth' },
  'cape.c': { parent: 'chest', bones: 4, kind: 'cloth' },
  'cape.r': { parent: 'chest', bones: 4, kind: 'cloth' },
  'skirt.l': { parent: 'hips', bones: 3, kind: 'skirt' },
  'skirt.f': { parent: 'hips', bones: 3, kind: 'skirt' },
  'skirt.r': { parent: 'hips', bones: 3, kind: 'skirt' },
  'skirt.b': { parent: 'hips', bones: 3, kind: 'skirt' },
} as const;

export type ChainName = keyof typeof CHAINS;

/** Chains laid side by side as one sheet (held together across; `wrap` closes it into a ring). */
export const SHEETS: { chains: ChainName[]; wrap: boolean }[] = [
  { chains: ['cape.l', 'cape.c', 'cape.r'], wrap: false },
  { chains: ['skirt.l', 'skirt.f', 'skirt.r', 'skirt.b'], wrap: true },
];

/** Joint positions (rig space, one more than the chain has bones) per chain a look uses. */
export type ChainJoints = Partial<Record<ChainName, Vector3[]>>;

export const chainBone = (c: ChainName, i: number) => `${c}.${i}`;

/** Add every chain's bones to the hero skeleton (bind pose is set per look). */
export function addChainBones(skeleton: Skeleton) {
  for (const [name, def] of Object.entries(CHAINS) as [ChainName, (typeof CHAINS)[ChainName]][]) {
    const parent = skeleton.bones.find((b) => b.name === def.parent);
    if (!parent) continue;
    for (let i = 0; i < def.bones; i++) new Bone(chainBone(name, i), skeleton, parent, Matrix.Translation(0, -0.1 * i, -0.1));
  }
}

/** Tent weights over a chain's bones at `u` (in bones: 0 = first joint, n = the tip). */
function tents(c: ChainName, u: number): Weights {
  const n = CHAINS[c].bones;
  const uc = Math.max(0.5, Math.min(n - 0.5, u)) - 0.5;
  const k = Math.min(n - 1, Math.floor(uc));
  const f = uc - k;
  const w: Weights = [[chainBone(c, k), 1 - f]];
  if (f > 1e-4 && k + 1 < n) w.push([chainBone(c, k + 1), f]);
  return w;
}

/** Where `p` falls along a polyline, in segments (negative before the first joint). */
export function alongChain(joints: Vector3[], p: Vector3) {
  let best = Infinity;
  let u = 0;
  for (let k = 0; k < joints.length - 1; k++) {
    const a = joints[k];
    const d = joints[k + 1].subtract(a);
    const l2 = d.lengthSquared();
    let t = l2 > 1e-12 ? Vector3.Dot(p.subtract(a), d) / l2 : 0;
    if (k > 0) t = Math.max(0, t);
    if (k < joints.length - 2) t = Math.min(1, t);
    const dist = Vector3.DistanceSquared(p, a.add(d.scale(t)));
    if (dist < best) {
      best = dist;
      u = k + t;
    }
  }
  return u;
}

/**
 * Weights for a point hanging on a chain: by where it projects along the
 * joints, blending from `base` over `fade` segments before the first joint.
 */
export function chainWeights(c: ChainName, joints: Vector3[], p: Vector3, base: Weights, fade = 0.5): Weights {
  const u = alongChain(joints, p);
  return blend(base, tents(c, u), smooth(-fade, 0, u));
}

/**
 * Weights on a sheet of chains: `col` runs 0..chains-1 across, `u` down (in
 * bones); the top edge (u below `pin`) stays on `base`.
 */
export function sheetWeights(chains: ChainName[], col: number, u: number, base: Weights, pin = 0.3, wrap = false): Weights {
  const n = chains.length;
  let k: number;
  let f: number;
  if (wrap) {
    const cc = ((col % n) + n) % n;
    k = Math.floor(cc);
    f = cc - k;
  } else {
    const cc = Math.max(0, Math.min(n - 1, col));
    k = Math.min(n - 2, Math.floor(cc));
    f = clamp01(cc - k);
  }
  const w = blend(tents(chains[k], u), tents(chains[(k + 1) % n], u), f);
  return blend(base, w, smooth(0, pin, u));
}
