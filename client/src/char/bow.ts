// Procedural bows (the KayKit pack has crossbows but no bows): flat, tapered
// limbs with recurved tips, a wrapped grip between metal ferrules, capped
// nocks, and for the finer bows inlays, a vine of gilt or a glowing crystal.
// Everything is merged into one mesh with at most four materials.
import { Color3, Mesh, MeshBuilder, PBRMaterial, Quaternion, Vector3, VertexData, type Scene } from '@babylonjs/core';
import { setToon } from '../world/toon';

interface BowStyle {
  length: number;
  depth: number; // how far the belly bows forward
  recurve: number; // tip curl
  thickness: number;
  wood: string;
  grip: string;
  metal: string;
  glow?: string;
  /** Gilt vine spiralling up the limbs. */
  vine?: boolean;
  /** A crystal set in the riser. */
  crystal?: boolean;
}

const STYLES: Record<string, BowStyle> = {
  hunter: { length: 1.25, depth: 0.2, recurve: 0.03, thickness: 0.032, wood: '#8a5a32', grip: '#3b2a1d', metal: '#a9b0b6' },
  recurve: { length: 1.15, depth: 0.16, recurve: 0.14, thickness: 0.034, wood: '#4a2f1f', grip: '#8a2b22', metal: '#d9a441' },
  elven: { length: 1.45, depth: 0.22, recurve: 0.08, thickness: 0.027, wood: '#ece0bb', grip: '#4c7a46', metal: '#e0b35a', vine: true },
  starfall: { length: 1.4, depth: 0.24, recurve: 0.12, thickness: 0.031, wood: '#2f3d6e', grip: '#c9d6ff', metal: '#dfe8ff', glow: '#7fd7ff', crystal: true, vine: true },
};

/** Centre line of the limbs: grip at the origin, tips along ±Y, belly towards +X. */
function limbPoint(s: BowStyle, t: number): Vector3 {
  const y = (t - 0.5) * s.length;
  const k = Math.abs(t - 0.5) * 2; // 0 at grip, 1 at tips
  let x = s.depth * (1 - k * k) - s.depth;
  x -= s.recurve * Math.pow(Math.max(0, k - 0.72) / 0.28, 2);
  return new Vector3(x, y, 0);
}

/** A limb with an elliptical, tapering cross-section (wide side to side, thin in the draw direction). */
function buildLimb(scene: Scene, s: BowStyle): Mesh {
  const n = 40;
  const ring = 10;
  const positions: number[] = [];
  const indices: number[] = [];
  const uvs: number[] = [];
  const side = new Vector3(0, 0, 1);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = limbPoint(s, t);
    const tan = limbPoint(s, Math.min(1, t + 0.01)).subtract(limbPoint(s, Math.max(0, t - 0.01))).normalize();
    const nrm = Vector3.Cross(tan, side).normalize();
    const k = Math.abs(t - 0.5) * 2;
    // thick at the riser, tapering to slim tips; flat limbs
    const w = s.thickness * (1.25 - 0.75 * Math.pow(k, 1.2));
    const d = w * (k < 0.15 ? 1.1 : 0.55);
    for (let j = 0; j < ring; j++) {
      const a = (j / ring) * Math.PI * 2;
      const q = p.add(nrm.scale(Math.cos(a) * d)).add(side.scale(Math.sin(a) * w));
      positions.push(q.x, q.y, q.z);
      uvs.push(j / ring, t);
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < ring; j++) {
      const a = i * ring + j;
      const b = i * ring + ((j + 1) % ring);
      const c = a + ring;
      const d = b + ring;
      indices.push(a, c, b, b, c, d);
    }
  }
  // close the tips
  const endCap = (base: number, centre: Vector3, flip: boolean) => {
    const ci = positions.length / 3;
    positions.push(centre.x, centre.y, centre.z);
    uvs.push(0.5, flip ? 1 : 0);
    for (let j = 0; j < ring; j++) {
      const a = base + j;
      const b = base + ((j + 1) % ring);
      if (flip) indices.push(ci, a, b);
      else indices.push(ci, b, a);
    }
  };
  endCap(0, limbPoint(s, 0), false);
  endCap(n * ring, limbPoint(s, 1), true);
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.normals = normals;
  vd.uvs = uvs;
  const m = new Mesh('bowLimb', scene);
  vd.applyToMesh(m);
  return m;
}

function material(scene: Scene, name: string, hex: string, metal = 0, glow?: string, glowK = 0) {
  const m = new PBRMaterial(name, scene);
  m.albedoColor = Color3.FromHexString(hex).toLinearSpace();
  m.metallic = 0;
  m.roughness = 0.6;
  if (glow) m.emissiveColor = Color3.FromHexString(glow).toLinearSpace().scale(glowK);
  setToon(m, { char: true, metal });
  return m;
}

/** Bow lying in its local XY plane: grip at origin, limbs along ±Y, belly towards +X. */
export function createBow(scene: Scene, variant: string): Mesh {
  const s = STYLES[variant] ?? STYLES.hunter;
  const wood: Mesh[] = [buildLimb(scene, s)];
  const grip: Mesh[] = [];
  const metal: Mesh[] = [];
  const string: Mesh[] = [];

  // wrapped grip with a ferrule above and below
  const gw = s.thickness * 2.9;
  grip.push(MeshBuilder.CreateCylinder('bowGrip', { height: 0.15, diameter: gw, tessellation: 10 }, scene));
  for (const y of [-0.085, 0.085]) {
    const f = MeshBuilder.CreateCylinder('bowFerrule', { height: 0.022, diameter: gw * 1.12, tessellation: 10 }, scene);
    f.position.y = y;
    metal.push(f);
  }
  // capped nocks at both tips
  for (const t of [0, 1]) {
    const p = limbPoint(s, t);
    const tip = MeshBuilder.CreateCylinder('bowNock', { height: 0.07, diameterTop: t ? 0 : s.thickness * 1.1, diameterBottom: t ? s.thickness * 1.1 : 0, tessellation: 8 }, scene);
    const tan = limbPoint(s, t ? 1 : 0).subtract(limbPoint(s, t ? 0.97 : 0.03)).normalize();
    tip.rotationQuaternion = Quaternion.FromUnitVectorsToRef(Vector3.Up(), tan, new Quaternion());
    tip.position.copyFrom(p.add(tan.scale(0.025)));
    metal.push(tip);
  }
  // gilt vine spiralling around the limbs near the grip
  if (s.vine) {
    for (const dir of [-1, 1]) {
      const path: Vector3[] = [];
      for (let i = 0; i <= 30; i++) {
        const u = i / 30;
        const t = 0.5 + dir * (0.07 + u * 0.3);
        const p = limbPoint(s, t);
        const a = u * Math.PI * 7;
        const k = Math.abs(t - 0.5) * 2;
        const r = s.thickness * (1.25 - 0.75 * k) * 1.05;
        path.push(new Vector3(p.x + Math.cos(a) * r * 0.6, p.y, Math.sin(a) * r));
      }
      metal.push(MeshBuilder.CreateTube('bowVine', { path, radius: s.thickness * 0.16, tessellation: 4 }, scene));
    }
  }
  // a crystal in the riser
  if (s.crystal) {
    const c = MeshBuilder.CreatePolyhedron('bowCrystal', { type: 1, size: s.thickness * 1.5 }, scene);
    c.scaling.set(0.8, 1.6, 0.8);
    c.position.set(s.thickness * 1.6, 0, 0);
    string.push(c);
  }
  const tipTop = limbPoint(s, 1);
  const tipBot = limbPoint(s, 0);
  string.push(MeshBuilder.CreateTube('bowString', { path: [tipBot, new Vector3(tipBot.x - 0.02, 0, 0), tipTop], radius: 0.0045, tessellation: 4 }, scene));

  const parts: Mesh[] = [];
  const mats: PBRMaterial[] = [];
  const add = (meshes: Mesh[], mat: PBRMaterial) => {
    if (!meshes.length) {
      mat.dispose();
      return;
    }
    const merged = meshes.length > 1 ? Mesh.MergeMeshes(meshes, true, true)! : meshes[0];
    merged.material = mat;
    parts.push(merged);
    mats.push(mat);
  };
  add(wood, material(scene, 'bowWood', s.wood, 0, s.glow, 0.08));
  add(grip, material(scene, 'bowGrip', s.grip));
  add(metal, material(scene, 'bowMetal', s.metal, 1, s.glow, 0.15));
  add(string, material(scene, 'bowString', s.glow ? '#e8f6ff' : '#e0d9c6', 0, s.glow, 1.6));
  const bow = Mesh.MergeMeshes(parts, true, true, undefined, false, true)!;
  bow.name = 'bow_' + variant;
  return bow;
}
