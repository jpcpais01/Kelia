// Hearthmere, built in code (see architecture.ts): the buildings stand where
// the layout puts them, each turned to face the well, around a cobbled square
// with lantern posts and bunting. The result is three meshes: one opaque
// village mesh, the window glass (a tiny shader that reflects the sky by day
// and glows warm at night, pane by pane as the evening goes on) and the
// windmill's sails.
import { Color3, Constants, Effect, Mesh, PBRMaterial, ShaderMaterial, Vector3, Vector4, VertexData, type Scene } from '@babylonjs/core';
import { VILLAGE_PROPS, type Heightmap } from '@kelia/shared';
import type { Atmosphere } from './atmosphere';
import type { Foliage } from './foliage';
import { freezeStatic } from './frozen';
import { setToon, toon, TOON_FOG_GLSL, TOON_FOG_UNIFORMS, bindToonFog } from './toon';
import { Kit, PAL, bunting, chapel, fence, house, lanternPost, market, smithy, stage, tavern, tower, well, windmill, type BuildCtx } from './architecture';

/** The cobbled square around the well. */
export const PLAZA = { x: 2, z: -42, r: 9.5 };

Effect.ShadersStore['keliaGlassVertexShader'] = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec4 color;
uniform mat4 world;
uniform mat4 viewProjection;
varying vec3 vPos;
varying vec3 vN;
varying vec4 vCol;
void main() {
  vec4 wp = world * vec4(position, 1.0);
  vPos = wp.xyz;
  vN = normalize(mat3(world) * normal);
  vCol = color;
  gl_Position = viewProjection * wp;
}`;

Effect.ShadersStore['keliaGlassFragmentShader'] = /* glsl */ `
precision highp float;
varying vec3 vPos;
varying vec3 vN;
varying vec4 vCol;
uniform vec3 camPos;
uniform vec4 glow; // x = night 0..1, y = time, z = day light level
uniform vec3 skyCol;
uniform vec3 sunCol;
${TOON_FOG_GLSL}
void main() {
  vec3 V = normalize(camPos - vPos);
  vec3 N = normalize(vN);
  float fres = pow(1.0 - clamp(abs(dot(N, V)), 0.0, 1.0), 3.0);
  // daytime glass: deep blue panes that pick up the sky toward grazing angles,
  // with a crisp diagonal glint, the anime way
  vec3 day = mix(vec3(0.05, 0.08, 0.15), skyCol * 1.1, 0.25 + 0.6 * fres);
  float diag = fract((vPos.x + vPos.z) * 1.6 + vPos.y * 1.6);
  day += sunCol * 0.9 * (smoothstep(0.0, 0.03, diag) - smoothstep(0.1, 0.13, diag));
  day *= glow.z;
  // night: warm light behind the glass; each pane switches on at its own moment
  float id = vCol.b;
  float hot = step(0.95, vCol.r) * step(vCol.g, 0.6);
  float on = max(smoothstep(id, id + 0.06, glow.x * 0.92), hot);
  float flick = 0.92 + 0.08 * sin(glow.y * 7.0 + id * 40.0) * sin(glow.y * 3.1 + id * 17.0);
  vec3 warm = mix(vec3(1.0, 0.62, 0.28), vec3(1.0, 0.42, 0.12), hot) * mix(1.6, 2.6, hot) * flick;
  vec3 col = mix(day, warm, on);
  gl_FragColor = vec4(kFog(col, vPos, camPos), 1.0);
}`;

// Soft glow around each lantern after dark: camera-facing quads expanded in
// the vertex shader, all lanterns in one additive draw.
Effect.ShadersStore['keliaLampGlowVertexShader'] = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 view;
uniform mat4 viewProjection;
uniform vec4 glow;
varying vec2 vUv;
varying float vFade;
void main() {
  vec3 right = vec3(view[0][0], view[1][0], view[2][0]);
  vec3 up = vec3(view[0][1], view[1][1], view[2][1]);
  float size = 0.75 + 0.05 * sin(glow.y * 5.0 + position.x * 3.0);
  vec3 wp = position + (right * uv.x + up * uv.y) * size;
  vUv = uv;
  vec3 eye = vec3(inverse(view)[3]);
  vFade = 1.0 - smoothstep(60.0, 110.0, distance(eye, position));
  gl_Position = viewProjection * vec4(wp, 1.0);
}`;

Effect.ShadersStore['keliaLampGlowFragmentShader'] = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying float vFade;
uniform vec4 glow;
void main() {
  float r = length(vUv);
  float a = pow(max(1.0 - r, 0.0), 2.2);
  gl_FragColor = vec4(vec3(1.0, 0.6, 0.26) * a * 0.55 * glow.x * vFade, 1.0);
}`;

/** Which builder (and look) each KayKit building placement becomes. */
type Kind = 'tavern' | 'home' | 'cottage' | 'townhouse' | 'smithy' | 'market' | 'chapel' | 'tower' | 'windmill' | 'well' | 'stage';
const KIND: Record<string, Kind> = {
  building_tavern: 'tavern',
  building_home_A: 'home',
  building_home_B: 'townhouse',
  building_blacksmith: 'smithy',
  building_market: 'market',
  building_church: 'chapel',
  building_tower_A: 'tower',
  building_windmill: 'windmill',
  building_well: 'well',
  building_stage_A: 'stage',
};

/** Footprints (w × d) used for grounding and collision. */
const FOOT: Record<Kind, [number, number]> = {
  tavern: [10.4, 8.2],
  home: [7.6, 6.2],
  cottage: [6.4, 5.4],
  townhouse: [7.2, 6],
  smithy: [8.6, 7],
  market: [10, 4],
  chapel: [8, 12],
  tower: [5.6, 5.6],
  windmill: [6.8, 6.8],
  well: [2.6, 2.6],
  stage: [6, 4],
};

export class Village {
  readonly lamps: Vector3[] = [];
  readonly chimneys: Vector3[] = [];
  private sails: Mesh | null = null;
  private glassMat: ShaderMaterial;
  private glassMesh: Mesh;
  private lampMat!: ShaderMaterial;
  private lampGlow!: Mesh;
  private glowV = new Vector4(0, 0, 1, 0);
  private skyC = new Color3();
  private sunC = new Color3();

  constructor(scene: Scene, private hm: Heightmap, private atmosphere: Atmosphere, private foliage: Foliage) {
    const kit = new Kit(4711);
    const ctx: BuildCtx = { kit, chimneys: this.chimneys, lamps: this.lamps };
    let sailHub: Vector3 | null = null;
    let sailYaw = 0;
    let homes = 0;
    for (const p of VILLAGE_PROPS) {
      let kind = KIND[p.prop];
      if (!kind) continue;
      if (kind === 'home' && homes++ > 0) kind = 'cottage';
      const yaw = kind === 'well' ? 0.3 : Math.atan2(-(PLAZA.x - p.x), -(PLAZA.z - p.z));
      const [w, d] = FOOT[kind];
      const y = this.ground(p.x, p.z, yaw, w, d);
      kit.push(p.x, y, p.z, yaw);
      switch (kind) {
        case 'tavern':
          tavern(ctx);
          break;
        case 'home':
          house(ctx, { w: 7, d: 5.6, floors: 2, roof: PAL.roofBlue, shutter: PAL.shutterBlue, jetty: true, dormer: true });
          break;
        case 'cottage':
          house(ctx, { w: 6, d: 5, floors: 1, roof: PAL.roofOchre, wall: PAL.plasterWarm, shutter: PAL.shutterGreen, dormer: true, rise: 3.6 });
          break;
        case 'townhouse':
          house(ctx, { w: 6.6, d: 5.4, floors: 2, roof: PAL.roofTeal, wall: PAL.plasterBlue, shutter: PAL.shutterRed, balcony: true, rise: 3.8 });
          break;
        case 'smithy':
          smithy(ctx);
          break;
        case 'market':
          market(ctx);
          break;
        case 'chapel':
          chapel(ctx);
          break;
        case 'tower':
          tower(ctx);
          break;
        case 'windmill':
          sailHub = windmill(ctx);
          sailYaw = yaw;
          break;
        case 'well':
          well(ctx);
          break;
        case 'stage':
          stage(ctx);
          break;
      }
      kit.pop();
      if (kind !== 'stage' && kind !== 'market') this.colliderRect(p.x, p.z, yaw, w, d);
    }
    this.buildPlaza(kit, ctx);

    // the opaque village
    const main = new Mesh('village', scene);
    kit.main.toVertexData().applyToMesh(main);
    const mat = new PBRMaterial('villageMat', scene);
    mat.albedoColor = Color3.White();
    mat.metallic = 0;
    mat.roughness = 0.88;
    setToon(mat, { rim: 0.4 });
    main.material = mat;
    main.useVertexColors = true;
    main.receiveShadows = true;
    main.isPickable = false;
    freezeStatic(mat);
    main.freezeWorldMatrix();
    atmosphere.addShadowCaster(main, false);

    // window glass, lanterns and forge coals
    this.glassMesh = new Mesh('villageGlass', scene);
    kit.glass.toVertexData().applyToMesh(this.glassMesh);
    this.glassMat = new ShaderMaterial('villageGlassMat', scene, 'keliaGlass', {
      attributes: ['position', 'normal', 'color'],
      uniforms: ['world', 'viewProjection', 'camPos', 'glow', 'skyCol', 'sunCol', ...TOON_FOG_UNIFORMS],
    });
    this.glassMesh.material = this.glassMat;
    this.glassMesh.isPickable = false;
    this.glassMesh.freezeWorldMatrix();

    // lantern glow (night only)
    {
      const pos: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      for (const l of this.lamps) {
        const base = pos.length / 3;
        for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          pos.push(l.x, l.y, l.z);
          uv.push(u, v);
        }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
      const vd = new VertexData();
      vd.positions = pos;
      vd.uvs = uv;
      vd.indices = idx;
      const glowMesh = new Mesh('lampGlow', scene);
      vd.applyToMesh(glowMesh);
      glowMesh.alwaysSelectAsActiveMesh = true;
      glowMesh.isPickable = false;
      glowMesh.doNotSyncBoundingInfo = true;
      this.lampMat = new ShaderMaterial('lampGlowMat', scene, 'keliaLampGlow', {
        attributes: ['position', 'uv'],
        uniforms: ['view', 'viewProjection', 'glow'],
        needAlphaBlending: true,
      });
      this.lampMat.alphaMode = Constants.ALPHA_ADD;
      this.lampMat.disableDepthWrite = true;
      this.lampMat.backFaceCulling = false;
      glowMesh.material = this.lampMat;
      this.lampGlow = glowMesh;
    }

    // windmill sails, turning about the hub
    if (sailHub) {
      const sails = new Mesh('windmillSails', scene);
      kit.sails.toVertexData().applyToMesh(sails);
      sails.position.copyFrom(sailHub);
      sails.rotation.set(0, sailYaw, 0);
      sails.material = mat;
      sails.useVertexColors = true;
      sails.receiveShadows = true;
      sails.isPickable = false;
      atmosphere.addShadowCaster(sails, false);
      this.sails = sails;
    }
  }

  /** Ground height for a footprint: low enough that no corner floats, the plinth hides the rest. */
  private ground(x: number, z: number, yaw: number, w: number, d: number) {
    let lo = Infinity;
    let hi = -Infinity;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    for (const fx of [-0.5, 0, 0.5]) {
      for (const fz of [-0.5, 0, 0.5]) {
        const lx = fx * w;
        const lz = fz * d;
        const h = this.hm.sample(x + lx * c + lz * s, z - lx * s + lz * c);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
    }
    return Math.max(lo, hi - 0.45) - 0.04;
  }

  /** Cover a rotated rectangle with a row of circles. */
  private colliderRect(x: number, z: number, yaw: number, w: number, d: number) {
    const r = Math.min(w, d) / 2;
    const long = Math.max(w, d);
    const alongX = w >= d;
    const n = Math.max(1, Math.round(long / (r * 1.4)));
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : (i / (n - 1) - 0.5) * (long - 2 * r);
      const lx = alongX ? t : 0;
      const lz = alongX ? 0 : t;
      this.foliage.addStaticCollider(x + lx * c + lz * s, z - lx * s + lz * c, r * 0.95);
    }
  }

  /** Cobbles round the well, a kerb, lantern posts strung with bunting, benches and flower tubs. */
  private buildPlaza(k: Kit, ctx: BuildCtx) {
    const { x: px, z: pz, r: R } = PLAZA;
    const stones = [PAL.stone, PAL.stoneWarm, PAL.stoneDark, PAL.stone];
    // rings of cobbles, each stone following the ground
    for (let ring = 0; ring * 0.46 < R; ring++) {
      const rr = 1.55 + ring * 0.46;
      if (rr > R) break;
      const n = Math.max(6, Math.floor((rr * Math.PI * 2) / 0.52));
      const off = k.rnd();
      for (let i = 0; i < n; i++) {
        const a = ((i + off) / n) * Math.PI * 2;
        const x = px + Math.cos(a) * rr;
        const z = pz + Math.sin(a) * rr;
        const y = this.hm.sample(x, z);
        k.box(x, y - 0.03, z, 0.44, 0.16, ((rr * Math.PI * 2) / n) * 0.9, stones[(i * 7 + ring * 3) % 4], { yaw: -a + (k.rnd() - 0.5) * 0.12 }, 0.16);
      }
    }
    // kerb ring
    const kn = Math.floor((R * Math.PI * 2) / 0.7);
    for (let i = 0; i < kn; i++) {
      const a = (i / kn) * Math.PI * 2;
      const x = px + Math.cos(a) * (R + 0.2);
      const z = pz + Math.sin(a) * (R + 0.2);
      k.box(x, this.hm.sample(x, z) + 0.02, z, 0.36, 0.24, 0.66, PAL.stoneDark, { yaw: -a }, 0.1);
    }
    // lantern posts round the edge, strung with bunting
    const posts: Vector3[] = [];
    const np = 6;
    for (let i = 0; i < np; i++) {
      const a = (i / np) * Math.PI * 2 + 0.25;
      const x = px + Math.cos(a) * (R + 0.9);
      const z = pz + Math.sin(a) * (R + 0.9);
      const y = this.hm.sample(x, z);
      // lantern arm pointing into the square
      k.push(x, y, z, Math.PI - a);
      lanternPost(k, ctx);
      k.pop();
      posts.push(new Vector3(x, y + 3.0, z));
      this.foliage.addStaticCollider(x, z, 0.3);
    }
    for (let i = 0; i < np; i++) {
      // skip the run in front of the stage so the bunting does not cross it
      if (i === 5) continue;
      bunting(k, posts[i], posts[(i + 1) % np], 0.7);
    }
    // benches facing the well, and flower tubs between them
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.8;
      const x = px + Math.cos(a) * (R - 1.6);
      const z = pz + Math.sin(a) * (R - 1.6);
      const y = this.hm.sample(x, z);
      k.push(x, y, z, Math.atan2(Math.cos(a), Math.sin(a)));
      k.box(0, 0.46, 0, 1.9, 0.08, 0.46, PAL.timberLight);
      k.box(0, 0.86, 0.23, 1.9, 0.3, 0.06, PAL.timberLight, { pitch: -0.15 });
      for (const sx of [-0.8, 0.8]) k.box(sx, 0.22, 0, 0.12, 0.44, 0.42, PAL.timber);
      k.pop();
      const b = a + Math.PI / 4;
      const tx = px + Math.cos(b) * (R - 1.1);
      const tz = pz + Math.sin(b) * (R - 1.1);
      const ty = this.hm.sample(tx, tz);
      k.cyl(tx, ty - 0.1, tz, 0.5, 0.58, 0.62, 10, PAL.timberLight);
      k.cyl(tx, ty + 0.1, tz, 0.6, 0.6, 0.07, 10, PAL.iron, false);
      k.cyl(tx, ty + 0.4, tz, 0.6, 0.6, 0.07, 10, PAL.iron, false);
      for (let f = 0; f < 9; f++) {
        const fa = (f / 9) * Math.PI * 2 + k.rnd();
        const fr = f === 0 ? 0 : 0.18 + k.rnd() * 0.22;
        const fx = tx + Math.cos(fa) * fr;
        const fz = tz + Math.sin(fa) * fr;
        k.box(fx, ty + 0.62 + k.rnd() * 0.1, fz, 0.3, 0.26, 0.3, PAL.leaf, { yaw: k.rnd() * 3, roll: (k.rnd() - 0.5) * 0.4 });
        k.box(fx, ty + 0.8 + k.rnd() * 0.12, fz, 0.13, 0.11, 0.13, PAL.flowers[(f + i) % PAL.flowers.length], { yaw: k.rnd() * 3 }, 0.05);
      }
      this.foliage.addStaticCollider(tx, tz, 0.55);
    }
    // a garden fence by the cottages
    for (const [x, z, yaw, len] of [[33, -66, 0.3, 6], [44, -33, -1.2, 5]] as number[][]) {
      k.push(x, this.hm.sample(x, z) - 0.05, z, yaw);
      fence(k, len);
      k.pop();
    }
  }

  update(time: number, cameraPos: Vector3) {
    if (this.sails) this.sails.rotation.z = time * 0.55;
    const s = this.atmosphere.state;
    const m = this.glassMat;
    const sky = toon.sky;
    this.glowV.x = Math.min(1, s.night * 1.25 + Math.max(0, 0.12 - this.atmosphere.sunDir.y) * 2.5);
    this.glowV.y = time;
    this.glowV.z = Math.min(1, 0.35 + toon.sun.x * 1.6 + sky.x);
    m.setVector3('camPos', cameraPos);
    m.setVector4('glow', this.glowV);
    m.setColor3('skyCol', this.skyC.set(sky.x * 1.4, sky.y * 1.4, sky.z * 1.5));
    m.setColor3('sunCol', this.sunC.set(toon.sun.x, toon.sun.y, toon.sun.z));
    bindToonFog(m);
    this.lampMat.setVector4('glow', this.glowV);
    this.lampGlow.setEnabled(this.glowV.x > 0.01);
  }
}

