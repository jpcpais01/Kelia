// The four hidden places of the valley, built from primitives: the Fairy Ring,
// the lantern on Lantern Isle, the Old Watchtower and the Hidden Grotto.
import { Color3, Mesh, MeshBuilder, PBRMaterial, StandardMaterial, TransformNode, Vector3, type Scene } from '@babylonjs/core';
import { hash2, type Heightmap } from '@kelia/shared';
import type { Ambient } from './ambient';
import type { Atmosphere } from './atmosphere';
import type { Foliage } from './foliage';

export class Secrets {
  readonly root: TransformNode;
  private glow: { mat: StandardMaterial; base: Color3; phase: number }[] = [];

  constructor(private scene: Scene, private hm: Heightmap, private atmosphere: Atmosphere, private foliage: Foliage, private ambient: Ambient) {
    this.root = new TransformNode('secrets', scene);
    this.fairyRing(-318, 140);
    this.lantern(196, -276);
    this.watchtower(-210, -300);
    this.grotto(-36, 232);
  }

  private glowMat(name: string, c: Color3) {
    const m = new StandardMaterial(name, this.scene);
    m.diffuseColor = c.scale(0.3);
    m.emissiveColor = c;
    m.specularColor = Color3.Black();
    this.glow.push({ mat: m, base: c.clone(), phase: this.glow.length * 1.7 });
    return m;
  }

  private stoneMat(name: string, shade: number) {
    const m = new PBRMaterial(name, this.scene);
    m.albedoColor = new Color3(shade, shade * 0.97, shade * 0.92);
    m.metallic = 0;
    m.roughness = 0.95;
    m.environmentIntensity = 0.6;
    return m;
  }

  private add(mesh: Mesh, shadow = true) {
    mesh.parent = this.root;
    mesh.receiveShadows = true;
    if (shadow) this.atmosphere.addShadowCaster(mesh, false);
    return mesh;
  }

  private fairyRing(cx: number, cz: number) {
    const cap = this.glowMat('fairyCap', new Color3(0.55, 0.9, 1));
    const capPink = this.glowMat('fairyCapPink', new Color3(1, 0.5, 0.85));
    const stem = new StandardMaterial('fairyStem', this.scene);
    stem.diffuseColor = new Color3(0.85, 0.82, 0.72);
    stem.specularColor = Color3.Black();
    const n = 15;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = 5.2 + (hash2(i, 1, 5) - 0.5) * 0.5;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      const y = this.hm.sample(x, z);
      const s = 0.6 + hash2(i, 2, 5) * 0.6;
      const st = MeshBuilder.CreateCylinder('fstem' + i, { height: 0.5 * s, diameterTop: 0.12 * s, diameterBottom: 0.18 * s, tessellation: 6 }, this.scene);
      st.position.set(x, y + 0.25 * s, z);
      st.material = stem;
      this.add(st, false);
      const c = MeshBuilder.CreateSphere('fcap' + i, { diameter: 0.55 * s, segments: 6, slice: 0.5 }, this.scene);
      c.position.set(x, y + 0.48 * s, z);
      c.scaling.y = 0.75;
      c.material = i % 4 === 0 ? capPink : cap;
      this.add(c, false);
    }
    const y = this.hm.sample(cx, cz);
    this.ambient.addFireflyPatch(new Vector3(cx, y, cz), 5, 40, new Color3(0.55, 0.95, 1));
  }

  private lantern(cx: number, cz: number) {
    const y = this.hm.sample(cx, cz);
    const wood = new PBRMaterial('lanternWood', this.scene);
    wood.albedoColor = new Color3(0.32, 0.21, 0.12);
    wood.metallic = 0;
    wood.roughness = 0.9;
    const post = MeshBuilder.CreateBox('lanternPost', { width: 0.22, depth: 0.22, height: 2.6 }, this.scene);
    post.position.set(cx, y + 1.3, cz);
    post.material = wood;
    this.add(post);
    const arm = MeshBuilder.CreateBox('lanternArm', { width: 0.9, depth: 0.12, height: 0.12 }, this.scene);
    arm.position.set(cx + 0.4, y + 2.5, cz);
    arm.material = wood;
    this.add(arm);
    const frame = this.stoneMat('lanternIron', 0.12);
    const cage = MeshBuilder.CreateCylinder('lanternCage', { height: 0.5, diameterTop: 0.25, diameterBottom: 0.38, tessellation: 6 }, this.scene);
    cage.position.set(cx + 0.78, y + 2.1, cz);
    cage.material = frame;
    cage.visibility = 0.55;
    this.add(cage, false);
    const flameGlass = MeshBuilder.CreateSphere('lanternGlow', { diameter: 0.26, segments: 6 }, this.scene);
    flameGlass.position.copyFrom(cage.position);
    flameGlass.material = this.glowMat('lanternGlowMat', new Color3(1, 0.7, 0.3));
    this.add(flameGlass, false);
    this.ambient.addFlame(cage.position.add(new Vector3(0, -0.05, 0)), 0.45);
    this.foliage.addStaticCollider(cx, cz, 0.35);
  }

  private watchtower(cx: number, cz: number) {
    const y = this.hm.sample(cx, cz) - 0.4;
    const stone = this.stoneMat('towerStone', 0.46);
    const r = 3.2;
    const body = MeshBuilder.CreateCylinder('towerBody', { height: 11, diameterTop: r * 1.9, diameterBottom: r * 2.15, tessellation: 12 }, this.scene);
    body.convertToFlatShadedMesh();
    body.position.set(cx, y + 5.5, cz);
    body.material = stone;
    this.add(body);
    const ledge = MeshBuilder.CreateCylinder('towerLedge', { height: 0.5, diameter: r * 2.25, tessellation: 12 }, this.scene);
    ledge.convertToFlatShadedMesh();
    ledge.position.set(cx, y + 11.2, cz);
    ledge.material = stone;
    this.add(ledge);
    const n = 10;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const m = MeshBuilder.CreateBox('crenel' + i, { width: 0.8, height: 0.9, depth: 0.6 }, this.scene);
      m.position.set(cx + Math.cos(a) * (r - 0.1), y + 11.9, cz + Math.sin(a) * (r - 0.1));
      m.rotation.y = -a;
      m.material = stone;
      this.add(m);
    }
    const roof = MeshBuilder.CreateCylinder('towerRoof', { height: 3.4, diameterTop: 0, diameterBottom: r * 1.7, tessellation: 12 }, this.scene);
    roof.convertToFlatShadedMesh();
    roof.position.set(cx, y + 14.4, cz);
    const roofMat = new PBRMaterial('towerRoofMat', this.scene);
    roofMat.albedoColor = new Color3(0.38, 0.17, 0.12);
    roofMat.metallic = 0;
    roofMat.roughness = 0.85;
    roof.material = roofMat;
    this.add(roof);
    // roof posts holding it above the crenellations
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      const p = MeshBuilder.CreateBox('towerPost' + i, { width: 0.25, depth: 0.25, height: 2 }, this.scene);
      p.position.set(cx + Math.cos(a) * (r * 0.7), y + 12.5, cz + Math.sin(a) * (r * 0.7));
      p.material = roofMat;
      this.add(p);
    }
    const door = MeshBuilder.CreateBox('towerDoor', { width: 1.3, height: 2.2, depth: 0.3 }, this.scene);
    door.position.set(cx, y + 1.5, cz - r * 1.02);
    const dm = new PBRMaterial('towerDoorMat', this.scene);
    dm.albedoColor = new Color3(0.08, 0.06, 0.05);
    dm.metallic = 0;
    dm.roughness = 1;
    door.material = dm;
    this.add(door, false);
    // a few fallen stones around the base
    for (let i = 0; i < 6; i++) {
      const a = hash2(i, 7, 3) * Math.PI * 2;
      const d = r + 1.5 + hash2(i, 8, 3) * 3;
      const x = cx + Math.cos(a) * d;
      const z = cz + Math.sin(a) * d;
      const s = 0.35 + hash2(i, 9, 3) * 0.4;
      const b = MeshBuilder.CreateBox('towerRubble' + i, { width: s * 1.4, height: s, depth: s }, this.scene);
      b.position.set(x, this.hm.sample(x, z) + s * 0.35, z);
      b.rotation.set(hash2(i, 1, 1) * 0.6, a, hash2(i, 2, 1) * 0.6);
      b.material = stone;
      this.add(b);
    }
    this.foliage.addStaticCollider(cx, cz, r + 0.3);
  }

  private grotto(cx: number, cz: number) {
    const y = this.hm.sample(cx, cz);
    const mats = [this.glowMat('grottoA', new Color3(0.45, 0.6, 1.2)), this.glowMat('grottoB', new Color3(0.8, 0.45, 1.1))];
    for (let i = 0; i < 9; i++) {
      const a = hash2(i, 4, 11) * Math.PI * 2;
      const d = hash2(i, 5, 11) * 2.6;
      const x = cx + Math.cos(a) * d;
      const z = cz + Math.sin(a) * d;
      const s = 0.35 + hash2(i, 6, 11) * 0.5;
      const c = MeshBuilder.CreatePolyhedron('grottoCrystal' + i, { type: 1, size: s }, this.scene);
      c.scaling.set(0.6, 1.8 + hash2(i, 7, 11), 0.6);
      c.position.set(x, this.hm.sample(x, z) + s * 0.6, z);
      c.rotation.set((hash2(i, 8, 11) - 0.5) * 0.7, a, (hash2(i, 9, 11) - 0.5) * 0.7);
      c.material = mats[i % 2];
      this.add(c, false);
    }
    this.ambient.addFireflyPatch(new Vector3(cx, y, cz), 3, 18, new Color3(0.6, 0.65, 1));
  }

  /** Gentle breathing glow on the mushrooms, crystals and lantern. */
  update(time: number) {
    for (const g of this.glow) {
      const k = 0.78 + Math.sin(time * 1.5 + g.phase) * 0.22;
      g.mat.emissiveColor.copyFrom(g.base).scaleInPlace(k);
    }
  }
}
