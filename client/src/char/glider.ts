// The glider: a pair of canvas wings on a wooden frame, held by two
// handles above the shoulders, built in code. Each wing is a cambered sail
// stretched over five ribs with a scalloped trailing edge, a painted band in
// the class colour and a dark hem standing in for line art. It unfolds with
// a springy snap (sweeping out from behind the back, overshooting a little as
// the canvas fills), ripples in the airflow, and folds away again on landing.
// Wingtip contrails stream behind it at speed.
import {
  Color3,
  Constants,
  Effect,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  ShaderMaterial,
  TransformNode,
  Vector3,
  VertexData,
  type AbstractMesh,
  type Scene,
} from '@babylonjs/core';
import { setToon } from '../world/toon';
import { INK } from './style';

/** Where the glider sits on a particular body (root-local metres, measured by the model). */
export interface GliderFit {
  /** Half the distance between the wing roots (clear of the head). */
  halfGap: number;
  /** Height of the wing roots above the grips. */
  handle: number;
  /** How far behind the wing roots the crossbar arcs (behind the head). */
  back: number;
}

const NU = 12;
const NV = 5;
const SPAN = 1.7;
const RIBS = 4; // bays between ribs

/** Leading edge of the right wing at u (0 root .. 1 tip), wing space (x outward, z forward). */
function lead(u: number): Vector3 {
  return new Vector3(SPAN * u, 0.3 * u + 0.16 * u * u * u, 0.1 * Math.sin(Math.PI * u * 0.8) - 0.5 * u * u);
}
const chord = (u: number) => 0.14 + 0.92 * (1 - Math.pow(u, 1.8));
/** How far the canvas between two ribs is drawn in from the trailing edge. */
const scallop = (u: number) => {
  const f = u * RIBS - Math.floor(u * RIBS);
  return 0.17 * chord(u) * Math.sin(Math.PI * f) ** 2;
};

function sail(u: number, v: number, out: Vector3) {
  const L = lead(u);
  const c = chord(u) - scallop(u) * v;
  out.set(L.x + 0.06 * u * v, L.y - 0.04 * v + 0.07 * chord(u) * Math.sin(Math.PI * v) * (0.6 + 0.4 * (1 - u)), L.z - c * v);
  return out;
}

Effect.ShadersStore['keliaTrailVertexShader'] = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec4 color;
uniform mat4 viewProjection;
varying vec4 vCol;
void main() {
  vCol = color;
  gl_Position = viewProjection * vec4(position, 1.0);
}`;
Effect.ShadersStore['keliaTrailFragmentShader'] = /* glsl */ `
precision highp float;
varying vec4 vCol;
void main() {
  gl_FragColor = vCol;
}`;

const TRAIL_N = 26;

/** A thin camera-facing streak of condensed air behind a wingtip. */
class Contrail {
  readonly mesh: Mesh;
  private pts: Vector3[] = [];
  private ages: number[] = [];
  private pos = new Float32Array(TRAIL_N * 2 * 3);
  private col = new Float32Array(TRAIL_N * 2 * 4);

  constructor(scene: Scene, mat: ShaderMaterial) {
    this.mesh = new Mesh('contrail', scene);
    const idx: number[] = [];
    for (let i = 0; i < TRAIL_N - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const vd = new VertexData();
    vd.positions = this.pos;
    vd.indices = idx;
    vd.colors = this.col;
    vd.applyToMesh(this.mesh, true);
    this.mesh.material = mat;
    this.mesh.isPickable = false;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.doNotSyncBoundingInfo = true;
    this.mesh.hasVertexAlpha = true;
    this.mesh.setEnabled(false);
  }

  /** Add the tip's current position (when `emit`) and age the streak. */
  update(dt: number, tip: Vector3, emit: number, cam: Vector3) {
    for (let i = 0; i < this.ages.length; i++) this.ages[i] += dt;
    while (this.ages.length && this.ages[0] > 0.55) {
      this.ages.shift();
      this.pts.shift();
    }
    if (emit > 0.02) {
      const last = this.pts[this.pts.length - 1];
      if (!last || Vector3.DistanceSquared(last, tip) > 0.04) {
        this.pts.push(tip.clone());
        this.ages.push(0);
        if (this.pts.length > TRAIL_N) {
          this.pts.shift();
          this.ages.shift();
        }
      } else last.copyFrom(tip);
    }
    const n = this.pts.length;
    if (n < 2) {
      this.mesh.setEnabled(false);
      return;
    }
    this.mesh.setEnabled(true);
    const side = new Vector3();
    for (let i = 0; i < TRAIL_N; i++) {
      const j = Math.min(i, n - 1);
      const p = this.pts[j];
      const a = this.pts[Math.max(0, j - 1)];
      const b = this.pts[Math.min(n - 1, j + 1)];
      const tan = b.subtract(a);
      Vector3.CrossToRef(tan, cam.subtract(p), side);
      const l = side.length();
      // thin at the tip, widening and fading as it trails off
      const age = this.ages[j] / 0.55;
      const w = 0.025 + 0.05 * age;
      if (l > 1e-6) side.scaleInPlace(w / l);
      const k = i * 6;
      this.pos[k] = p.x - side.x;
      this.pos[k + 1] = p.y - side.y;
      this.pos[k + 2] = p.z - side.z;
      this.pos[k + 3] = p.x + side.x;
      this.pos[k + 4] = p.y + side.y;
      this.pos[k + 5] = p.z + side.z;
      const alpha = i < n ? emit * 0.55 * (1 - age) * (1 - age) * Math.min(1, (n - 1 - j) * 0.5) : 0;
      for (let s = 0; s < 2; s++) {
        const c = (i * 2 + s) * 4;
        this.col[c] = 1;
        this.col[c + 1] = 1;
        this.col[c + 2] = 1;
        this.col[c + 3] = alpha;
      }
    }
    this.mesh.updateVerticesData('position', this.pos);
    this.mesh.updateVerticesData('color', this.col);
  }

  clear() {
    this.pts.length = 0;
    this.ages.length = 0;
    this.mesh.setEnabled(false);
  }
}

export class Glider {
  /** Placed by the model: origin midway between the wing roots, x right, z forward. */
  readonly root: TransformNode;
  private wings: TransformNode[] = [];
  private sails: { mesh: Mesh; side: number; pos: Float32Array; base: Float32Array; uv: Float32Array; idx: number[]; nrm: Float32Array }[] = [];
  readonly meshes: AbstractMesh[] = [];
  private mats: (PBRMaterial | ShaderMaterial)[] = [];
  private trails: Contrail[] = [];
  /** Shown openness (springy, may overshoot 1) and its velocity. */
  open = 0;
  private openV = 0;
  private target = 0;
  private t = Math.random() * 10;
  /** Grip points in glider space (right, left). */
  readonly grips: [Vector3, Vector3];
  private tipLocal = lead(1).add(new Vector3(0, 0, -chord(1) * 0.5));

  constructor(scene: Scene, readonly fit: GliderFit, accent: string) {
    this.root = new TransformNode('glider', scene);
    const g = fit.halfGap;
    this.grips = [new Vector3(g, -fit.handle, 0.05), new Vector3(-g, -fit.handle, 0.05)];

    const canvas = pbr(scene, 'gliderCanvas', '#ffffff', 0.85);
    canvas.backFaceCulling = false;
    canvas.twoSidedLighting = true;
    setToon(canvas, { rim: 0.8, translucency: 0.65 });
    const wood = pbr(scene, 'gliderWood', '#6b4228', 0.7);
    setToon(wood, { rim: 0.6, spec: 0.2 });
    const brass = pbr(scene, 'gliderBrass', '#d8a650', 0.35);
    setToon(brass, { rim: 0.9, spec: 1.1 });
    this.mats.push(canvas, wood, brass);

    // vertex colours multiply the albedo in linear space
    const acc = Color3.FromHexString(accent).toLinearSpace();
    const ivory = Color3.FromHexString('#f6eedb').toLinearSpace();
    const hem = acc.scale(0.3);

    for (const side of [1, -1]) {
      const wing = new TransformNode('gliderWing', scene);
      wing.parent = this.root;
      wing.position.set(side * g, 0, 0);
      this.wings.push(wing);

      // the sail: a (NU+1) x (NV+1) grid, coloured per vertex
      const pos: number[] = [];
      const col: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      const p = new Vector3();
      for (let i = 0; i <= NU; i++) {
        for (let j = 0; j <= NV; j++) {
          const u = i / NU;
          const v = j / NV;
          sail(u, v, p);
          pos.push(p.x * side, p.y, p.z);
          uv.push(u, v);
          // a band of the class colour behind the spar, a darker hem, and coloured tips
          let c = ivory;
          if ((v > 0.12 && v < 0.3) || u > 0.86) c = acc;
          if (v > 0.9) c = hem;
          col.push(c.r, c.g, c.b, 1);
        }
      }
      for (let i = 0; i < NU; i++) {
        for (let j = 0; j < NV; j++) {
          const a = i * (NV + 1) + j;
          const b = a + NV + 1;
          if (side > 0) idx.push(a, b, a + 1, a + 1, b, b + 1);
          else idx.push(a, a + 1, b, a + 1, b + 1, b);
        }
      }
      const mesh = new Mesh('gliderSail', scene);
      const nrm: number[] = [];
      VertexData.ComputeNormals(pos, idx, nrm);
      const vd = new VertexData();
      vd.positions = pos;
      vd.indices = idx;
      vd.normals = nrm;
      vd.colors = col;
      vd.uvs = uv;
      vd.applyToMesh(mesh, true);
      mesh.material = canvas;
      mesh.parent = wing;
      this.sails.push({ mesh, side, pos: new Float32Array(pos), base: new Float32Array(pos), uv: new Float32Array(uv), idx, nrm: new Float32Array(nrm) });
      this.meshes.push(mesh);

      // the frame: leading-edge spar and ribs (wood), tip cap (brass)
      const frame: Mesh[] = [];
      const spar: Vector3[] = [];
      for (let i = 0; i <= 16; i++) {
        const q = lead(i / 16);
        spar.push(new Vector3(q.x * side, q.y + 0.012, q.z + 0.012));
      }
      frame.push(MeshBuilder.CreateTube('gliderSpar', { path: spar, radius: 0.024, tessellation: 6, cap: Mesh.CAP_ALL }, scene));
      for (let r = 0; r <= RIBS; r++) {
        const u = r / RIBS;
        const path: Vector3[] = [];
        for (let j = 0; j <= 6; j++) {
          sail(u, j / 6, p);
          path.push(new Vector3(p.x * side, p.y + 0.008, p.z));
        }
        frame.push(MeshBuilder.CreateTube('gliderRib', { path, radius: r === 0 ? 0.02 : 0.013, tessellation: 5, cap: Mesh.CAP_ALL }, scene));
      }
      const woodMesh = Mesh.MergeMeshes(frame, true, true)!;
      woodMesh.material = wood;
      woodMesh.parent = wing;
      const tip = MeshBuilder.CreateSphere('gliderTip', { diameter: 0.075, segments: 6 }, scene);
      const tp = lead(1);
      tip.position.set(tp.x * side, tp.y + 0.012, tp.z + 0.012);
      tip.material = brass;
      tip.parent = wing;
      this.meshes.push(woodMesh, tip);
    }

    // handles down to the grips, and the crossbar arcing behind the head
    const fixed: Mesh[] = [];
    const brassBits: Mesh[] = [];
    for (const gp of this.grips) {
      const top = new Vector3(gp.x, 0.02, 0);
      fixed.push(MeshBuilder.CreateTube('gliderHandle', { path: [top, new Vector3(gp.x, (top.y + gp.y) / 2, 0.03), gp.add(new Vector3(0, -0.07, 0))], radius: 0.018, tessellation: 6, cap: Mesh.CAP_ALL }, scene));
      const grip = MeshBuilder.CreateCylinder('gliderGrip', { height: 0.13, diameter: 0.05, tessellation: 8 }, scene);
      grip.position.copyFrom(gp);
      brassBits.push(grip);
      const joint = MeshBuilder.CreateSphere('gliderJoint', { diameter: 0.07, segments: 6 }, scene);
      joint.position.copyFrom(top);
      brassBits.push(joint);
    }
    const arc: Vector3[] = [];
    for (let i = 0; i <= 14; i++) {
      const a = (i / 14) * Math.PI;
      arc.push(new Vector3(-Math.cos(a) * g, 0.02 + Math.sin(a) * 0.1, -Math.sin(a) * fit.back));
    }
    fixed.push(MeshBuilder.CreateTube('gliderBar', { path: arc, radius: 0.022, tessellation: 6, cap: Mesh.CAP_ALL }, scene));
    const frameMesh = Mesh.MergeMeshes(fixed, true, true)!;
    frameMesh.material = wood;
    frameMesh.parent = this.root;
    const brassMesh = Mesh.MergeMeshes(brassBits, true, true)!;
    brassMesh.material = brass;
    brassMesh.parent = this.root;
    this.meshes.push(frameMesh, brassMesh);

    for (const m of this.meshes) {
      m.isPickable = false;
      m.receiveShadows = true;
      if (m.material !== canvas) {
        m.renderOutline = true;
        m.outlineColor = INK.clone();
        m.outlineWidth = 0.012;
      }
    }

    const trailMat = new ShaderMaterial('gliderTrail', scene, 'keliaTrail', { attributes: ['position', 'color'], uniforms: ['viewProjection'], needAlphaBlending: true });
    trailMat.backFaceCulling = false;
    trailMat.disableDepthWrite = true;
    trailMat.alphaMode = Constants.ALPHA_COMBINE;
    this.mats.push(trailMat);
    this.trails = [new Contrail(scene, trailMat), new Contrail(scene, trailMat)];
    this.root.setEnabled(false);
  }

  setTarget(open: boolean) {
    this.target = open ? 1 : 0;
  }

  get visible() {
    return this.root.isEnabled(false);
  }

  /** Grip `i` (0 right, 1 left) in world space (call after the root's world matrix is current). */
  gripWorld(i: number, out = new Vector3()) {
    return Vector3.TransformCoordinatesToRef(this.grips[i], this.root.getWorldMatrix(), out);
  }

  /**
   * Animate the fold and the canvas. `speed` is airspeed (m/s), `gust` adds
   * extra flutter (dives, updrafts).
   */
  update(dt: number, speed: number, gust: number) {
    this.t += dt;
    // a springy snap open (canvas filling), a quick tidy fold
    const opening = this.target > this.open;
    const w = opening ? 15 : 17;
    const z = opening ? 0.42 : 1;
    const h = Math.min(dt, 1 / 30);
    this.openV += (-(w * w) * (this.open - this.target) - 2 * z * w * this.openV) * h;
    this.open += this.openV * h;
    if (this.target === 0 && this.open < 0.02) {
      this.open = 0;
      this.openV = 0;
    }
    const shown = this.open > 0.01 || this.target > 0;
    if (shown !== this.root.isEnabled(false)) this.root.setEnabled(shown);
    if (!shown) {
      for (const t of this.trails) t.clear();
      return;
    }
    const o = Math.max(0, this.open);
    const oc = Math.min(1, o);
    // pops out of nothing: the whole frame grows in over the first part of the motion
    const grow = Math.min(1, oc * 2.4);
    this.root.scaling.setAll(Math.max(0.001, grow * grow * (3 - 2 * grow)));
    const fold = 1 - oc;
    for (let i = 0; i < 2; i++) {
      const wing = this.wings[i];
      const side = i === 0 ? 1 : -1;
      // folded: swept back behind the shoulders and drooping; open: spread wide
      wing.rotation.set(0.25 * fold, side * 1.65 * fold, -side * 0.55 * fold);
      const stretch = 1 + Math.max(-0.1, Math.min(0.08, (o - 1) * 0.5));
      wing.scaling.set(0.22 + 0.78 * oc * stretch, 1, 0.55 + 0.45 * oc);
      // a gentle flex with the airflow
      wing.rotation.z += side * (0.03 * Math.sin(this.t * 2.1 + i) + 0.02 * gust * Math.sin(this.t * 7.3 + i * 2));
    }
    this.ripple(Math.min(1, speed / 9) * oc, gust);
  }

  /** Ripple the canvas toward the trailing edge, more at speed. */
  private ripple(amount: number, gust: number) {
    const amp = 0.012 + 0.03 * amount + 0.025 * gust;
    const t = this.t;
    for (const s of this.sails) {
      const { pos, base, uv } = s;
      for (let k = 0, n = pos.length / 3; k < n; k++) {
        const u = uv[k * 2];
        const v = uv[k * 2 + 1];
        const wave = Math.sin(t * (11 + 6 * amount) - u * 9 + v * 2.5) + 0.5 * Math.sin(t * 17.3 + u * 13);
        // billow: the sail fills more as it opens
        pos[k * 3 + 1] = base[k * 3 + 1] + amp * v * v * wave + 0.03 * amount * Math.sin(Math.PI * v) * (1 - u);
      }
      VertexData.ComputeNormals(pos, s.idx, s.nrm);
      s.mesh.updateVerticesData('position', pos);
      s.mesh.updateVerticesData('normal', s.nrm);
    }
  }

  /** Stream contrails off the wingtips (call once world matrices are current). */
  updateTrails(dt: number, emit: number, cam: Vector3) {
    const tip = new Vector3();
    for (let i = 0; i < 2; i++) {
      const local = this.tipLocal.clone();
      local.x *= i === 0 ? 1 : -1;
      this.wings[i].computeWorldMatrix(true);
      Vector3.TransformCoordinatesToRef(local, this.wings[i].getWorldMatrix(), tip);
      this.trails[i].update(dt, tip, this.root.isEnabled(false) ? emit : 0, cam);
    }
  }

  addShadows(add: (m: AbstractMesh) => void) {
    for (const m of this.meshes) add(m);
  }

  dispose() {
    for (const t of this.trails) t.mesh.dispose();
    this.root.dispose(false, false);
    for (const m of this.mats) m.dispose();
  }
}

function pbr(scene: Scene, name: string, hex: string, rough: number) {
  const m = new PBRMaterial(name, scene);
  m.albedoColor = Color3.FromHexString(hex).toLinearSpace();
  m.metallic = 0;
  m.roughness = rough;
  return m;
}
