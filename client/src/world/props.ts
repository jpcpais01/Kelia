// Hand-placed props: the village of Hearthmere, the ruins, the shrine's
// standing stones and lake plants. Models are CC0 KayKit packs (see
// public/assets/LICENSES.txt); the shrine is modelled in code.
import {
  Color3,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  StandardMaterial,
  TransformNode,
  Vector3,
  type AssetContainer,
  type Scene,
} from '@babylonjs/core';
import { LAKE, RUINS, RUINS_PROPS, SHRINE, Simplex2, VILLAGE_PROPS, hash2, waterAt, type Heightmap, type Placement } from '@kelia/shared';
import { loadContainer } from '../core/assets';
import type { Atmosphere } from './atmosphere';
import type { Foliage } from './foliage';
import { MeshBuilder2 } from './meshgen';

export interface Light {
  pos: Vector3;
  color: Color3;
  radius: number;
}

export class Props {
  readonly root: TransformNode;
  /** Warm light sources (torches, lanterns) used by the ambient-life effects. */
  readonly lights: Light[] = [];
  private templates = new Map<string, TransformNode>();
  /** The glTF __root__ node (right- to left-handed conversion), copied onto every placement. */
  private gltfRoot: TransformNode | null = null;
  shrineCrystal: Mesh | null = null;

  constructor(private scene: Scene, private hm: Heightmap, private atmosphere: Atmosphere, private foliage: Foliage) {
    this.root = new TransformNode('props', scene);
    this.buildShrine();
  }

  async load() {
    const c = await loadContainer(this.scene, 'props/props.glb');
    this.collectTemplates(c);
    for (const p of VILLAGE_PROPS) this.place(p, 0, 0);
    for (const p of RUINS_PROPS) this.place(p, RUINS.center[0], RUINS.center[1]);
    this.scatterLakePlants();
    this.root.getChildMeshes(false).forEach((m) => {
      if (m === this.shrineCrystal) return;
      m.computeWorldMatrix(true);
      m.freezeWorldMatrix();
      m.isPickable = false;
      m.doNotSyncBoundingInfo = true;
    });
  }

  private collectTemplates(c: AssetContainer) {
    c.addAllToScene();
    this.gltfRoot = c.meshes.find((m) => m.name === '__root__') ?? null;
    for (const node of c.transformNodes.concat(c.meshes as never[])) {
      const n = node as TransformNode;
      if (n.name.startsWith('prop_')) {
        this.templates.set(n.name.slice(5), n);
        n.setEnabled(false);
      }
    }
    for (const mat of c.materials) {
      if (mat instanceof PBRMaterial) {
        mat.environmentIntensity = 0.75;
        mat.metallic = 0;
        mat.roughness = Math.max(mat.roughness ?? 0.8, 0.75);
      }
    }
  }

  /** Clone a template under a fresh node that carries the placement transform. */
  private spawn(tpl: TransformNode, x: number, y: number, z: number, rot: number, scale: number) {
    const holder = new TransformNode('p_' + tpl.name, this.scene);
    holder.parent = this.root;
    holder.position.set(x, y, z);
    holder.rotation.set(0, rot, 0);
    holder.scaling.setAll(scale);
    const conv = new TransformNode('conv', this.scene);
    conv.parent = holder;
    if (this.gltfRoot) {
      conv.rotationQuaternion = this.gltfRoot.rotationQuaternion?.clone() ?? null;
      conv.scaling.copyFrom(this.gltfRoot.scaling);
    }
    const inst = tpl.instantiateHierarchy(conv, { doNotInstantiate: true }, (src, clone) => {
      clone.name = src.name;
    }) as TransformNode;
    inst.setEnabled(true);
    for (const m of inst.getChildMeshes(false)) {
      m.receiveShadows = true;
      m.setEnabled(true);
    }
    return holder;
  }

  private template(name: string) {
    return this.templates.get(name) ?? this.templates.get(name.replace(/_red$/, ''));
  }

  private place(p: Placement, ox: number, oz: number) {
    const tpl = this.template(p.prop);
    if (!tpl) {
      console.warn('[props] missing', p.prop);
      return;
    }
    const x = ox + p.x;
    const z = oz + p.z;
    // Sit on the lowest point of the footprint so nothing floats.
    const r = Math.max(0.6, (p.collide ?? 1) * 0.7);
    let y = this.hm.sample(x, z);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      y = Math.min(y, this.hm.sample(x + Math.cos(a) * r, z + Math.sin(a) * r));
    }
    const holder = this.spawn(tpl, x, y - 0.05, z, p.rot, p.scale);
    for (const m of holder.getChildMeshes(false)) this.atmosphere.addShadowCaster(m, false);
    if (p.collide) this.foliage.addStaticCollider(x, z, p.collide);
    if (p.prop.includes('torch')) this.lights.push({ pos: new Vector3(x, y + p.scale * 1.05, z), color: new Color3(1, 0.55, 0.2), radius: 9 });
  }

  /** Circle of mossy standing stones around a softly glowing crystal. */
  private buildShrine() {
    const [cx, cz] = SHRINE.center;
    const cy = this.hm.sample(cx, cz);
    const noise = new Simplex2(777);
    const b = new MeshBuilder2();
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.3;
      const r = SHRINE.radius - 1.2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const h = 2.6 + hash2(i, 3, 9) * 1.4;
      b.rock([x, h * 0.45, z], [0.55, h * 0.55, 0.42], noise, i * 2.3 + 1, [0.42, 0.41, 0.4], [0.22, 0.32, 0.12]);
    }
    const stones = new Mesh('shrineStones', this.scene);
    b.toVertexData().applyToMesh(stones);
    const mat = new PBRMaterial('shrineStone', this.scene);
    mat.albedoColor = Color3.White();
    mat.metallic = 0;
    mat.roughness = 0.92;
    mat.environmentIntensity = 0.7;
    stones.material = mat;
    stones.useVertexColors = true;
    stones.position.set(cx, cy, cz);
    stones.receiveShadows = true;
    stones.parent = this.root;
    this.atmosphere.addShadowCaster(stones, false);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.3;
      this.foliage.addStaticCollider(cx + Math.cos(a) * (SHRINE.radius - 1.2), cz + Math.sin(a) * (SHRINE.radius - 1.2), 0.7);
    }

    // a low, two-tier paved dais
    for (const [rad, top, i] of [[3.6, 0.07, 0], [2.3, 0.14, 1]] as const) {
      const d = MeshBuilder.CreateCylinder('dais' + i, { diameterTop: rad * 2 - 0.25, diameterBottom: rad * 2, height: 0.6, tessellation: 18 }, this.scene);
      d.convertToFlatShadedMesh();
      d.position.set(cx, cy + top - 0.3, cz);
      d.rotation.y = i * 0.17;
      d.material = mat;
      d.receiveShadows = true;
      d.parent = this.root;
      const n = d.getTotalVertices();
      const cols: number[] = [];
      for (let v = 0; v < n; v++) {
        const s = 0.42 + hash2(v, i, 31) * 0.1;
        cols.push(s, s * 0.97, s * 0.93, 1);
      }
      d.setVerticesData('color', cols);
      d.useVertexColors = true;
    }

    const crystal = MeshBuilder.CreatePolyhedron('shrineCrystal', { type: 1, size: 0.55 }, this.scene);
    crystal.scaling.set(0.8, 1.9, 0.8);
    crystal.position.set(cx, cy + 5.2, cz);
    const cm = new StandardMaterial('crystal', this.scene);
    cm.emissiveColor = new Color3(0.45, 0.85, 1.0);
    cm.diffuseColor = new Color3(0.2, 0.4, 0.5);
    cm.specularColor = new Color3(1, 1, 1);
    cm.disableLighting = false;
    crystal.material = cm;
    crystal.parent = this.root;
    this.shrineCrystal = crystal;
    this.lights.push({ pos: crystal.position.clone(), color: new Color3(0.45, 0.85, 1), radius: 10 });
  }

  private scatterLakePlants() {
    const lilies = ['waterlily_A', 'waterlily_B'];
    const reeds = ['waterplant_A', 'waterplant_B'];
    for (let i = 0; i < 70; i++) {
      const a = hash2(i, 1, 51) * Math.PI * 2;
      const r = LAKE.radius * (0.55 + hash2(i, 2, 51) * 0.5);
      const x = LAKE.center[0] + Math.cos(a) * r;
      const z = LAKE.center[1] + Math.sin(a) * r;
      const w = waterAt(x, z);
      const g = this.hm.sample(x, z);
      if (w === -Infinity) continue;
      const depth = w - g;
      if (depth > 0.15 && depth < 1.6 && i % 2 === 0) {
        this.placeRaw(lilies[i % 2], x, w + 0.02, z, hash2(i, 3, 51) * 6.28, 4.5 + hash2(i, 4, 51) * 2);
      } else if (depth > -0.4 && depth < 0.5) {
        this.placeRaw(reeds[i % 2], x, g - 0.05, z, hash2(i, 3, 51) * 6.28, 5 + hash2(i, 4, 51) * 2);
      }
    }
  }

  private placeRaw(name: string, x: number, y: number, z: number, rot: number, scale: number) {
    const tpl = this.template(name);
    if (!tpl) return;
    this.spawn(tpl, x, y, z, rot, scale);
  }

  update(time: number) {
    if (this.shrineCrystal) {
      this.shrineCrystal.rotation.y = time * 0.4;
      this.shrineCrystal.position.y = this.hm.sample(SHRINE.center[0], SHRINE.center[1]) + 5.2 + Math.sin(time * 1.3) * 0.12;
    }
  }
}
