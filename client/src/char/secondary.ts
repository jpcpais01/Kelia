// Secondary motion: the hero's hair and cape hang on short bone chains
// (hero/chains.ts) simulated as particles in world space. Each particle is
// sprung towards where the chain would sit if it were rigid (so a look keeps
// its authored shape), lags behind through air drag (a cape streams out
// behind a runner, hair trails a turn), sags towards the ground when the body
// tilts, stays the same length (links are inextensible), holds together
// across a cape, and is pushed out of the head, torso, shoulders, arms and
// legs. The bones then follow the particles: each sits on its particle and
// turns to point at the next.
import { Matrix, Quaternion, Vector3, type Bone, type Skeleton, type TransformNode, type Node } from '@babylonjs/core';
import { CHAINS, SHEETS, chainBone, type ChainJoints, type ChainName } from './hero/chains';
import type { HeroRest } from './hero/rig';

interface Feel {
  /** Spring towards the rigid pose (Hz), damping of motion relative to it, and drag against the air (1/s). */
  freq: number;
  zeta: number;
  drag: number;
  /** How much the chain sags towards the ground when the body tilts (0..1). */
  hang: number;
  /** Furthest a particle strays from its rigid place, per metre of chain above it. */
  reach: number;
  colliders: string[];
}

const FEEL: Record<'hair' | 'cloth', Feel> = {
  hair: { freq: 2.6, zeta: 0.32, drag: 0.7, hang: 0.8, reach: 0.55, colliders: ['head', 'torso', 'shoulders'] },
  cloth: { freq: 1.25, zeta: 0.26, drag: 1.9, hang: 1, reach: 0.85, colliders: ['torso', 'shoulders', 'thigh.l', 'thigh.r', 'shin.l', 'shin.r', 'arm.l', 'arm.r'] },
};

/** Body capsules: two points (bone, rig-space position) and a radius in metres. */
const COLLIDERS: Record<string, { a: [string, (r: HeroRest) => Vector3]; b: [string, (r: HeroRest) => Vector3]; r: number }> = {
  head: { a: ['head', () => new Vector3(0, 1.7, -0.012)], b: ['head', () => new Vector3(0, 1.66, -0.0)], r: 0.105 },
  torso: { a: ['hips', (r) => r.pos('hips').add(new Vector3(0, 0.02, -0.01))], b: ['chest', () => new Vector3(0, 1.4, -0.015)], r: 0.125 },
  shoulders: { a: ['chest', (r) => r.pos('upperarm.l').add(new Vector3(-0.02, 0, -0.01))], b: ['chest', (r) => r.pos('upperarm.r').add(new Vector3(0.02, 0, -0.01))], r: 0.06 },
  'arm.l': { a: ['upperarm.l', (r) => r.pos('upperarm.l')], b: ['lowerarm.l', (r) => r.pos('lowerarm.l')], r: 0.05 },
  'arm.r': { a: ['upperarm.r', (r) => r.pos('upperarm.r')], b: ['lowerarm.r', (r) => r.pos('lowerarm.r')], r: 0.05 },
  'thigh.l': { a: ['upperleg.l', (r) => r.pos('upperleg.l')], b: ['lowerleg.l', (r) => r.pos('lowerleg.l')], r: 0.085 },
  'thigh.r': { a: ['upperleg.r', (r) => r.pos('upperleg.r')], b: ['lowerleg.r', (r) => r.pos('lowerleg.r')], r: 0.085 },
  'shin.l': { a: ['lowerleg.l', (r) => r.pos('lowerleg.l')], b: ['foot.l', (r) => r.pos('foot.l')], r: 0.065 },
  'shin.r': { a: ['lowerleg.r', (r) => r.pos('lowerleg.r')], b: ['foot.r', (r) => r.pos('foot.r')], r: 0.065 },
};

interface Collider {
  na: TransformNode;
  la: Vector3;
  nb: TransformNode;
  lb: Vector3;
  /** World endpoints this frame. */
  a: Vector3;
  b: Vector3;
}

interface Chain {
  name: ChainName;
  feel: Feel;
  parent: TransformNode;
  bones: Bone[];
  /** Joints in the parent bone's space (rest), and the rest gravity there. */
  local: Vector3[];
  down: Vector3;
  /** Particles (world), their velocities, and the rigid goals now and last frame. */
  x: Vector3[];
  v: Vector3[];
  old: Vector3[];
  goal: Vector3[];
  prev: Vector3[];
  /** Per particle and collider: the radius it keeps (shrunk where the rest pose sits closer). */
  radius: number[][];
  colliders: Collider[];
  len: number[];
}

const DOWN = new Vector3(0, -1, 0);
const tmpM = new Matrix();
const tmpQ = new Quaternion();
const tA = new Vector3();
const tB = new Vector3();
const tC = new Vector3();
const tD = new Vector3();

function closestOnSegment(p: Vector3, a: Vector3, b: Vector3, out: Vector3) {
  b.subtractToRef(a, tD);
  const l2 = tD.lengthSquared();
  const t = l2 > 1e-12 ? Math.max(0, Math.min(1, Vector3.Dot(p.subtract(a), tD) / l2)) : 0;
  out.copyFrom(a).addInPlace(tD.scaleInPlace(t));
  return out;
}

export class SecondaryMotion {
  private chains: Chain[] = [];
  private sheets: Chain[][] = [];
  private colliders = new Map<string, Collider>();
  /** Nodes to refresh before reading world matrices, parents first. */
  private refresh: TransformNode[] = [];
  private live = false;
  private t = Math.random() * 100;

  constructor(nodes: Map<string, TransformNode>, skeleton: Skeleton, rest: HeroRest, joints: ChainJoints) {
    const byName = new Map(skeleton.bones.map((b) => [b.name, b]));
    const used = new Set<TransformNode>();
    const collider = (key: string): Collider | null => {
      const hit = this.colliders.get(key);
      if (hit) return hit;
      const d = COLLIDERS[key];
      const na = nodes.get(d.a[0]);
      const nb = nodes.get(d.b[0]);
      const ra = rest.world.get(d.a[0]);
      const rb = rest.world.get(d.b[0]);
      if (!na || !nb || !ra || !rb) return null;
      const c: Collider = {
        na,
        la: Vector3.TransformCoordinates(d.a[1](rest), ra.clone().invert()),
        nb,
        lb: Vector3.TransformCoordinates(d.b[1](rest), rb.clone().invert()),
        a: new Vector3(),
        b: new Vector3(),
      };
      used.add(na).add(nb);
      this.colliders.set(key, c);
      return c;
    };
    for (const [name, pts] of Object.entries(joints) as [ChainName, Vector3[]][]) {
      const def = CHAINS[name];
      const parent = nodes.get(def.parent);
      const parentRest = rest.world.get(def.parent);
      const bones = Array.from({ length: def.bones }, (_, i) => byName.get(chainBone(name, i)));
      if (!parent || !parentRest || pts.length !== def.bones + 1 || bones.some((b) => !b)) continue;
      const inv = parentRest.clone().invert();
      const local = pts.map((p) => Vector3.TransformCoordinates(p, inv));
      // bind each bone where this look's chain hangs
      bones.forEach((b, i) => {
        const m = Matrix.Translation(local[i].x, local[i].y, local[i].z);
        b!.setRestMatrix(m.clone());
        b!.updateMatrix(m, true, true);
      });
      const feel = FEEL[def.kind];
      const cs: Collider[] = [];
      const radius: number[][] = pts.map(() => []);
      for (const key of feel.colliders) {
        const c = collider(key);
        if (!c) continue;
        const d = COLLIDERS[key];
        const a = d.a[1](rest);
        const b = d.b[1](rest);
        cs.push(c);
        pts.forEach((p, i) => {
          // keep clear of the body, but never push the chain off its own rest pose
          const dist = Vector3.Distance(p, closestOnSegment(p, a, b, new Vector3()));
          const r = Math.min(d.r, dist - 0.012);
          radius[i].push(r > 0.015 ? r : 0);
        });
      }
      used.add(parent);
      this.chains.push({
        name,
        feel,
        parent,
        bones: bones as Bone[],
        local,
        down: Vector3.TransformNormal(DOWN, inv),
        x: pts.map(() => new Vector3()),
        v: pts.map(() => new Vector3()),
        old: pts.map(() => new Vector3()),
        goal: pts.map(() => new Vector3()),
        prev: pts.map(() => new Vector3()),
        radius,
        colliders: cs,
        len: pts.slice(1).map(() => 0),
      });
    }
    for (const names of SHEETS) {
      const s = names.map((n) => this.chains.find((c) => c.name === n)).filter((c): c is Chain => !!c);
      if (s.length > 1) this.sheets.push(s);
    }
    // world matrices are read off these nodes: refresh them (and their ancestors) parents first
    const seen = new Set<TransformNode>();
    for (const n of used) {
      const chain: TransformNode[] = [];
      for (let p: Node | null = n; p; p = p.parent) if ((p as TransformNode).computeWorldMatrix) chain.unshift(p as TransformNode);
      for (const p of chain) {
        if (seen.has(p)) continue;
        seen.add(p);
        this.refresh.push(p);
      }
    }
  }

  get empty() {
    return this.chains.length === 0;
  }

  /** Forget the motion (after a teleport or a new look): the chains start at rest. */
  reset() {
    this.live = false;
  }

  /**
   * Step the chains. `active` = false parks them at rest (far away or
   * hidden). `wind` is a world-space breeze (m/s) the cloth flutters in.
   */
  update(dt: number, active: boolean, wind?: Vector3) {
    if (!this.chains.length) return;
    if (!active || dt <= 0) {
      if (this.live) this.park();
      this.live = false;
      return;
    }
    for (const n of this.refresh) n.computeWorldMatrix(true);
    for (const c of this.colliders.values()) {
      Vector3.TransformCoordinatesToRef(c.la, c.na.getWorldMatrix(), c.a);
      Vector3.TransformCoordinatesToRef(c.lb, c.nb.getWorldMatrix(), c.b);
    }
    // body scale (radii are in rig metres)
    const scale = Vector3.TransformNormal(new Vector3(1, 0, 0), this.chains[0].parent.getWorldMatrix()).length() || 1;
    dt = Math.min(dt, 0.05);
    const fresh = !this.live;
    for (const c of this.chains) {
      for (let i = 0; i < c.goal.length; i++) {
        c.prev[i].copyFrom(c.goal[i]);
        Vector3.TransformCoordinatesToRef(c.local[i], c.parent.getWorldMatrix(), c.goal[i]);
      }
      const jump = Vector3.DistanceSquared(c.goal[0], c.prev[0]) > 1.5 * 1.5;
      if (fresh || jump) {
        for (let i = 0; i < c.x.length; i++) {
          c.x[i].copyFrom(c.goal[i]);
          c.v[i].setAll(0);
          c.prev[i].copyFrom(c.goal[i]);
        }
      }
      for (let i = 0; i < c.len.length; i++) c.len[i] = Vector3.Distance(c.goal[i], c.goal[i + 1]);
    }
    this.live = true;
    this.t += dt;
    const steps = Math.min(4, Math.ceil(dt / (1 / 75)));
    const h = dt / steps;
    for (let s = 1; s <= steps; s++) this.substep(h, s / steps, dt, scale, wind);
    this.pose();
  }

  private substep(h: number, f: number, dt: number, scale: number, wind?: Vector3) {
    const g = 9.81;
    for (const c of this.chains) {
      const { freq, zeta, drag, hang } = c.feel;
      const w = 2 * Math.PI * freq;
      const k = w * w;
      const damp = 2 * zeta * w;
      // gravity relative to the body: zero at rest, a sag when the body tilts
      Vector3.TransformNormalToRef(c.down, c.parent.getWorldMatrix(), tC);
      tC.normalize();
      const sagX = (0 - tC.x) * g * hang;
      const sagY = (-1 - tC.y) * g * hang;
      const sagZ = (0 - tC.z) * g * hang;
      const n = c.x.length;
      for (let i = 0; i < n; i++) {
        // the rigid goal, partway through this frame
        Vector3.LerpToRef(c.prev[i], c.goal[i], f, tA);
        if (i === 0) {
          c.x[0].copyFrom(tA);
          continue;
        }
        const x = c.x[i];
        const v = c.v[i];
        // goal velocity, for damping relative to the body's own motion
        const gvx = (c.goal[i].x - c.prev[i].x) / dt;
        const gvy = (c.goal[i].y - c.prev[i].y) / dt;
        const gvz = (c.goal[i].z - c.prev[i].z) / dt;
        let ax = k * (tA.x - x.x) - damp * (v.x - gvx) - drag * v.x + sagX;
        let ay = k * (tA.y - x.y) - damp * (v.y - gvy) - drag * v.y + sagY;
        let az = k * (tA.z - x.z) - damp * (v.z - gvz) - drag * v.z + sagZ;
        if (c.feel === FEEL.cloth) {
          // flutter: the hem ripples in the breeze and when running
          const u = i / (n - 1);
          const wx = (wind?.x ?? 0) - v.x;
          const wz = (wind?.z ?? 0) - v.z;
          const air = Math.min(9, Math.hypot(wx, wz));
          const fl = u * u * (0.35 + air * 0.55);
          ax += fl * Math.sin(this.t * 7.3 + i * 1.7 + c.local[0].x * 40);
          ay += fl * 0.8 * Math.sin(this.t * 9.1 + i * 2.3);
          az += fl * Math.cos(this.t * 6.1 + i * 1.3 + c.local[0].x * 30);
          if (wind) {
            ax += wind.x * drag * 0.25 * u;
            az += wind.z * drag * 0.25 * u;
          }
        }
        v.x += ax * h;
        v.y += ay * h;
        v.z += az * h;
      }
    }
    // predict, then constrain
    for (const c of this.chains) {
      for (let i = 1; i < c.x.length; i++) {
        c.old[i].copyFrom(c.x[i]);
        c.x[i].addInPlace(c.v[i].scaleToRef(h, tB));
      }
    }
    for (let it = 0; it < 2; it++) {
      for (const sheet of this.sheets) {
        // hold the sheet together across (it may bunch a little, never tear)
        for (let k = 0; k + 1 < sheet.length; k++) {
          const A = sheet[k];
          const B = sheet[k + 1];
          for (let i = 1; i < A.x.length; i++) {
            const rest = Vector3.Distance(A.goal[i], B.goal[i]);
            B.x[i].subtractToRef(A.x[i], tA);
            const d = tA.length();
            if (d < 1e-6) continue;
            const target = d > rest ? rest : d < rest * 0.6 ? rest * 0.6 : d;
            if (target === d) continue;
            tA.scaleInPlace(((d - target) / d) * 0.5);
            A.x[i].addInPlace(tA);
            B.x[i].subtractInPlace(tA);
          }
        }
      }
      for (const c of this.chains) {
        this.leash(c);
        this.links(c);
      }
      for (const c of this.chains) this.collide(c, scale);
    }
    for (const c of this.chains) this.links(c);
    // the velocity is what the constrained step actually moved
    for (const c of this.chains) {
      for (let i = 1; i < c.x.length; i++) {
        c.x[i].subtractToRef(c.old[i], c.v[i]);
        c.v[i].scaleInPlace(1 / h);
      }
    }
  }

  /** Keep each particle within reach of its rigid place (no hair whipping out like a horn). */
  private leash(c: Chain) {
    let along = 0;
    for (let i = 1; i < c.x.length; i++) {
      along += c.len[i - 1];
      const max = along * c.feel.reach;
      c.x[i].subtractToRef(c.goal[i], tA);
      const d = tA.length();
      if (d > max) c.x[i].copyFrom(c.goal[i]).addInPlace(tA.scaleInPlace(max / d));
    }
  }

  /** Inextensible links, root to tip. */
  private links(c: Chain) {
    for (let i = 1; i < c.x.length; i++) {
      c.x[i].subtractToRef(c.x[i - 1], tA);
      const d = tA.length();
      if (d < 1e-6) continue;
      tA.scaleInPlace(c.len[i - 1] / d);
      c.x[i - 1].addToRef(tA, c.x[i]);
    }
  }

  private collide(c: Chain, scale: number) {
    for (let i = 1; i < c.x.length; i++) {
      const x = c.x[i];
      for (let k = 0; k < c.colliders.length; k++) {
        const r = c.radius[i][k] * scale;
        if (r <= 0) continue;
        const col = c.colliders[k];
        closestOnSegment(x, col.a, col.b, tB);
        x.subtractToRef(tB, tA);
        const d = tA.length();
        if (d >= r || d < 1e-6) continue;
        x.copyFrom(tB).addInPlace(tA.scaleInPlace(r / d));
      }
    }
  }

  /** Bones follow the particles: each sits on its own and points at the next. */
  private pose() {
    for (const c of this.chains) {
      c.parent.getWorldMatrix().invertToRef(tmpM);
      for (let i = 0; i < c.bones.length; i++) {
        Vector3.TransformCoordinatesToRef(c.x[i], tmpM, tA);
        Vector3.TransformCoordinatesToRef(c.x[i + 1], tmpM, tB);
        tB.subtractInPlace(tA).normalize();
        c.local[i + 1].subtractToRef(c.local[i], tC).normalize();
        Quaternion.FromUnitVectorsToRef(tC, tB, tmpQ);
        const b = c.bones[i];
        b.position = tA;
        b.rotationQuaternion = tmpQ;
      }
    }
  }

  /** Bones back to their rest (the chain hangs as built). */
  private park() {
    for (const c of this.chains) {
      for (let i = 0; i < c.bones.length; i++) {
        c.bones[i].position = c.local[i];
        c.bones[i].rotationQuaternion = Quaternion.Identity();
      }
    }
  }
}
