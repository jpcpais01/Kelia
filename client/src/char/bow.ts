// Procedural bows (the KayKit pack has crossbows but no bows).
import { Color3, Mesh, MeshBuilder, PBRMaterial, Vector3, type Scene } from '@babylonjs/core';

interface BowStyle {
  length: number;
  depth: number; // how far the belly bows forward
  recurve: number; // tip curl
  thickness: number;
  wood: string;
  grip: string;
  glow?: string;
}

const STYLES: Record<string, BowStyle> = {
  hunter: { length: 1.25, depth: 0.2, recurve: 0, thickness: 0.032, wood: '#7a4f2c', grip: '#3b2a1d' },
  recurve: { length: 1.15, depth: 0.16, recurve: 0.12, thickness: 0.034, wood: '#4a2f1f', grip: '#8a2b22' },
  elven: { length: 1.45, depth: 0.22, recurve: 0.06, thickness: 0.026, wood: '#e2d6b0', grip: '#4c7a46' },
  starfall: { length: 1.4, depth: 0.24, recurve: 0.1, thickness: 0.03, wood: '#3b4b7a', grip: '#c9d6ff', glow: '#7fd7ff' },
};

/** Bow lying in its local XY plane: grip at origin, limbs along ±Y, belly towards +X. */
export function createBow(scene: Scene, variant: string): Mesh {
  const s = STYLES[variant] ?? STYLES.hunter;
  const n = 18;
  const path: Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n; // 0..1 bottom to top
    const y = (t - 0.5) * s.length;
    const k = Math.abs(t - 0.5) * 2; // 0 at grip, 1 at tips
    let x = s.depth * (1 - k * k) - s.depth;
    x -= s.recurve * Math.pow(Math.max(0, k - 0.75) / 0.25, 2);
    path.push(new Vector3(x, y, 0));
  }
  const limb = MeshBuilder.CreateTube('bowLimb', {
    path,
    radiusFunction: (i) => {
      const k = Math.abs(i / n - 0.5) * 2;
      return s.thickness * (1.15 - 0.6 * k);
    },
    tessellation: 6,
    cap: Mesh.CAP_ALL,
  }, scene);
  const grip = MeshBuilder.CreateCylinder('bowGrip', { height: 0.16, diameter: s.thickness * 2.9, tessellation: 8 }, scene);
  const tipTop = path[path.length - 1];
  const tipBot = path[0];
  const string = MeshBuilder.CreateTube('bowString', { path: [tipBot, new Vector3(tipBot.x - 0.02, 0, 0), tipTop], radius: 0.0045, tessellation: 3 }, scene);

  const wood = new PBRMaterial('bowWood', scene);
  wood.albedoColor = Color3.FromHexString(s.wood).toLinearSpace();
  wood.metallic = 0;
  wood.roughness = 0.55;
  if (s.glow) wood.emissiveColor = Color3.FromHexString(s.glow).toLinearSpace().scale(0.6);
  limb.material = wood;
  const gm = new PBRMaterial('bowGrip', scene);
  gm.albedoColor = Color3.FromHexString(s.grip).toLinearSpace();
  gm.metallic = 0;
  gm.roughness = 0.8;
  grip.material = gm;
  const sm = new PBRMaterial('bowString', scene);
  sm.albedoColor = new Color3(0.85, 0.82, 0.74);
  sm.metallic = 0;
  sm.roughness = 0.6;
  if (s.glow) sm.emissiveColor = Color3.FromHexString(s.glow).toLinearSpace();
  string.material = sm;
  const bow = Mesh.MergeMeshes([limb, grip, string], true, true, undefined, false, true)!;
  bow.name = 'bow_' + variant;
  return bow;
}
