// Procedural locomotion for humanoid rigs: feet that really plant.
//
// The clips were made for a chibi with tiny steps; played on a tall hero they
// skate, and they know nothing about the ground. This layer runs after the
// clips each frame and takes the lower body (and, while nothing else needs
// them, the arms) over whenever the character moves:
//
//  - A gait cycle whose cadence and duty factor follow speed (walk: long
//    double support, run: short stance with a flight phase). Each foot plants
//    at a world point and stays exactly there while it carries weight, so it
//    never slides; it rolls heel to toe over the stance (heel strike, flat,
//    heel rise around the ball of the foot) and swings along an arc to the
//    next footfall, predicted from the velocity so it lands under the body.
//  - Footfalls, heights and foot pitch follow the terrain; the hips sink as
//    far as the legs need to reach (which also gives walking its natural dip
//    in double support), bob, sway over the standing foot, tilt, rotate with
//    the legs, and lean into acceleration and back when braking.
//  - The chest counter-rotates against the hips and the arms swing against
//    the legs (relaxed when walking, pumped with bent elbows when running).
//  - Starting takes a first step at once; stopping finishes the step in the
//    air and brings the other foot alongside; turning on the spot shuffles
//    the feet round once they twist too far.
//
// Standing still the clips own the pose again, with the feet set onto the
// ground (and the hips lowered for the lower foot) as before.
import { Matrix, Quaternion, Vector3, type Node, TransformNode } from '@babylonjs/core';
import { spring, stepSpring } from './spring';

type Ground = (x: number, z: number) => number;

const UP = Vector3.Up();
const TAU = Math.PI * 2;

export interface GaitInput {
  /** World planar velocity (m/s), without lunges and dashes. */
  vel: Vector3;
  ground: Ground;
  /** 0..1 how much the gait may take over (0 in the air, gliding, mid full-body action). */
  allow: number;
  /** 0..1 how much the arms are free for the gait (0 while an upper-body action plays). */
  arms: number;
  /** Extra hip drop from the body layer (metres). */
  crouch: number;
  /** Standing still on the idle clip: the moment to learn the idle stance. */
  calm: boolean;
  /** Yaw rate (rad/s). */
  turnRate: number;
  /** Arm-swing scale for the weapon hand ('l' / 'r' → 0..1). */
  armScale: { l: number; r: number };
  /** Full detail (arms, foot pitch); off far from the camera. */
  detail: boolean;
  /**
   * Mid attack or cast: the feet stay planted while the body lunges and
   * turns, then step to catch up.
   */
  lock?: boolean;
  /**
   * 0..1 how much to square up the idle clip: it stands bladed, hips and
   * chest turned well off to one side, which reads as a twist. Squared, the
   * body faces ahead over feet set side by side.
   */
  square?: number;
  /** What the right hand carries, so the gait can hold it sensibly on the move. */
  grip?: 'blade' | 'staff' | null;
}

interface Leg {
  side: 'l' | 'r';
  upper: TransformNode;
  lower: TransformNode;
  foot: TransformNode;
  toes: TransformNode | null;
  /** Planted ground point (under the ankle with the foot flat) and heading. */
  g: Vector3;
  yaw: number;
  swing: boolean;
  /** Ankle, heading and pitch at lift-off. */
  lift: Vector3;
  liftYaw: number;
  liftPitch: number;
  /** Predicted footfall. */
  target: Vector3;
  targetYaw: number;
  prevP: number;
  /** This frame's result. */
  ankle: Vector3;
  pitch: number;
  heading: number;
  /** Ground slope under a standing foot (radians, toes up positive). */
  slope: number;
  /** Idle stance: ankle offset from the root in the root's frame (x right, z forward). */
  restX: number;
  restZ: number;
  restYaw: number;
  /** Lateral side of the body (+1 right, -1 left). */
  sign: number;
}

interface Arm {
  side: 'l' | 'r';
  upper: TransformNode;
  lower: TransformNode;
  wrist: TransformNode;
}

export class Gait {
  private legs: Leg[] = [];
  private arms: Arm[] = [];
  private hips: TransformNode;
  private spine: TransformNode | null;
  private chest: TransformNode | null;
  private hipsRest: Quaternion;
  private slot: TransformNode | null;
  private ready = false;
  /** Measured once from the rig. */
  private thigh = 0.43;
  private shin = 0.42;
  private ankleH = 0.08;
  private ballFwd = 0.11;
  private ballDown = 0.05;
  private upperArm = 0.28;
  private foreArm = 0.25;
  /** Idle hips height above the root, and its offset in the root frame. */
  private hipH = 0.9;
  private hipX = 0;
  private hipZ = 0;
  /** Leg length relative to the hero's (speeds and sizes scale with it). */
  private ls = 1;

  private active = false;
  private w = 0;
  private phase = 0;
  private vs = new Vector3();
  private fwdSpeed = 0;
  private lean = spring();
  private hipY = 0;
  private idleDrop = 0;
  /** Footwork: each foot's offset from the clip's (world, planar), its step (0..1, -1 = planted) and where that started. */
  private plantO = [new Vector3(), new Vector3()];
  private stepT = [-1, -1];
  private stepFrom = [new Vector3(), new Vector3()];
  private stepLift = [0, 0];
  /** Seconds since each foot last stepped (footwork). */
  private sinceStep = [9, 9];
  private prevRoot: Vector3 | null = null;
  private armW = 0;
  /** Per-frame trace for tests (set to [] to record). */
  debug: unknown[] | null = null;

  constructor(nodes: Map<string, TransformNode>, private root: TransformNode) {
    this.hips = nodes.get('hips')!;
    this.spine = nodes.get('spine') ?? null;
    this.chest = nodes.get('chest') ?? null;
    this.slot = nodes.get('handslot.r') ?? null;
    this.hipsRest = (this.hips.rotationQuaternion ?? Quaternion.FromEulerVector(this.hips.rotation)).clone();
    for (const side of ['l', 'r'] as const) {
      const upper = nodes.get(`upperleg.${side}`);
      const lower = nodes.get(`lowerleg.${side}`);
      const foot = nodes.get(`foot.${side}`);
      if (!upper || !lower || !foot) continue;
      for (const n of [upper, lower, foot]) if (!n.rotationQuaternion) n.rotationQuaternion = Quaternion.FromEulerVector(n.rotation);
      const toes = nodes.get(`toes.${side}`) ?? null;
      if (toes && !toes.rotationQuaternion) toes.rotationQuaternion = Quaternion.FromEulerVector(toes.rotation);
      this.legs.push({
        side, upper, lower, foot, toes,
        g: new Vector3(), yaw: 0, swing: false, lift: new Vector3(), liftYaw: 0, liftPitch: 0,
        target: new Vector3(), targetYaw: 0, prevP: 0, ankle: new Vector3(), pitch: 0, heading: 0, slope: 0,
        restX: side === 'l' ? -0.1 : 0.1, restZ: 0, restYaw: 0, sign: side === 'l' ? -1 : 1,
      });
    }
    for (const side of ['l', 'r'] as const) {
      const upper = nodes.get(`upperarm.${side}`);
      const lower = nodes.get(`lowerarm.${side}`);
      const wrist = nodes.get(`wrist.${side}`);
      if (upper && lower && wrist) this.arms.push({ side, upper, lower, wrist });
    }
    if (!this.hips.rotationQuaternion) this.hips.rotationQuaternion = this.hipsRest.clone();
    // sizes from the rest pose (before any clip runs)
    if (this.valid) {
      for (const l of this.legs) refreshChain(l.toes ?? l.foot);
      for (const a of this.arms) refreshChain(a.wrist);
      this.measure(root.rotation.y);
    }
  }

  get valid() {
    return this.legs.length === 2;
  }

  /** How much the gait drives the body right now (0..1). */
  get weight() {
    return this.w;
  }

  /** Where the cycle is (0..1, left foot down at 0), or null when not walking. */
  get cycle() {
    return this.active && this.w > 0.02 ? this.phase : null;
  }

  /** Forget planted feet (teleports, respawns, new looks). */
  reset() {
    this.active = false;
    this.w = 0;
    this.armW = 0;
  }

  private measure(yaw: number) {
    const [a, b] = this.legs;
    this.thigh = Vector3.Distance(a.upper.absolutePosition, a.lower.absolutePosition);
    this.shin = Vector3.Distance(a.lower.absolutePosition, a.foot.absolutePosition);
    this.ls = Math.max(0.3, (this.thigh + this.shin) / 0.85);
    if (a.toes) {
      const d = a.toes.absolutePosition.subtract(a.foot.absolutePosition);
      this.ballDown = Math.max(0, -d.y);
      this.ballFwd = Math.max(0.03, Math.hypot(d.x, d.z));
    } else this.ballFwd = 0.1 * this.ls;
    const arm = this.arms[0];
    if (arm) {
      this.upperArm = Vector3.Distance(arm.upper.absolutePosition, arm.lower.absolutePosition);
      this.foreArm = Vector3.Distance(arm.lower.absolutePosition, arm.wrist.absolutePosition);
    }
    this.learnIdle(yaw, 1);
    const R = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    for (const l of [a, b]) l.sign = Vector3.Dot(l.upper.absolutePosition.subtract(this.hips.absolutePosition), R) >= 0 ? 1 : -1;
    if (a.sign === b.sign) b.sign = -a.sign;
    this.ready = true;
  }

  /** Track the idle clip's stance (feet, ankle height, hips). */
  private learnIdle(yaw: number, k: number) {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const r = this.root.position;
    for (const l of this.legs) {
      const p = l.foot.absolutePosition;
      const dx = p.x - r.x;
      const dz = p.z - r.z;
      l.restX += (dx * c - dz * s - l.restX) * k;
      l.restZ += (dx * s + dz * c - l.restZ) * k;
      l.restYaw += (angleDiff(footYaw(l, yaw), yaw) - l.restYaw) * k;
      this.ankleH += (Math.max(0.03, Math.min(0.2, p.y - r.y)) - this.ankleH) * k;
    }
    const h = this.hips.absolutePosition;
    this.hipH += (h.y - r.y - this.hipH) * k;
    const hx = h.x - r.x;
    const hz = h.z - r.z;
    this.hipX += (hx * c - hz * s - this.hipX) * k;
    this.hipZ += (hx * s + hz * c - this.hipZ) * k;
  }

  /** Run after the clips (and before look-at and attack layers). */
  apply(dt: number, o: GaitInput) {
    if (!this.valid || dt <= 0) return;
    const root = this.root;
    const rootY = root.position.y;
    const yaw = root.rotation.y;
    const F = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const R = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    for (const l of this.legs) refreshChain(l.toes ?? l.foot);
    for (const a of this.arms) refreshChain(a.wrist);
    if (!this.ready) this.measure(yaw);
    else {
      this.squareUp(Math.min(1, o.square ?? 0), yaw, F, R, rootY);
      if (o.calm && !this.active) this.learnIdle(yaw, 1 - Math.exp(-dt * 2));
    }
    const ls = this.ls;
    // ground under a point, ignoring terrain far below or above us (bridges, floors)
    const gnd = (x: number, z: number) => {
      const h = o.ground(x, z);
      return Number.isFinite(h) && Math.abs(h - rootY) < 0.5 ? h : rootY;
    };

    // ---- the clips' pose
    const Hc = this.hips.absolutePosition.clone();
    const clipAnkles = this.legs.map((l) => l.foot.absolutePosition.clone());
    const clipKnees = this.legs.map((l) => l.lower.absolutePosition.clone());
    const clipHipJoints = this.legs.map((l) => l.upper.absolutePosition.clone());

    // ---- velocity, gait parameters
    const kv = 1 - Math.exp(-dt * 10);
    this.vs.x += (o.vel.x - this.vs.x) * kv;
    this.vs.z += (o.vel.z - this.vs.z) * kv;
    this.vs.y = 0;
    const speed = this.vs.length();
    const fwd = Vector3.Dot(this.vs, F);
    const accel = (fwd - this.fwdSpeed) / dt;
    this.fwdSpeed = fwd;
    const vn = speed / ls;
    const moving = vn > 0.18;
    const run = smooth(2.5, 3.9, vn);
    const sprint = smooth(5.8, 8, vn);
    const backward = fwd < -0.3 * speed ? 1 : 0;
    const duty = lerp(0.58, 0.35, run) - 0.04 * sprint;

    // idle stance for each foot, in the world
    const restOf = (l: Leg) => {
      const p = root.position.add(R.scale(l.restX)).add(F.scale(l.restZ));
      p.y = gnd(p.x, p.z);
      return p;
    };
    const far = (l: Leg) => {
      const rp = restOf(l);
      const d = Math.hypot(l.g.x - rp.x, l.g.z - rp.z);
      return d > 0.09 * ls || Math.abs(angleDiff(l.yaw, yaw + clampAbs(l.restYaw, 0.45))) > 0.6;
    };
    const anySwing = this.legs.some((l) => l.swing);
    const allow = o.allow;
    const need = allow > 0.5 && (moving || (this.active && (anySwing || this.legs.some(far))));

    // teleported (respawn, a snapped remote player): start over from the clip's feet
    if (this.active && this.legs.some((l) => Math.hypot(l.g.x - root.position.x, l.g.z - root.position.z) > 2.5 * ls)) {
      this.active = false;
      this.w = 0;
    }
    if (need && !this.active) this.start(yaw, gnd, F, duty);
    const want = this.active && allow > 0.01 && (need || anySwing) ? allow : 0;
    this.w += (want - this.w) * (1 - Math.exp(-dt * (allow < 0.5 ? 16 : want > this.w ? 9 : 6)));
    if (this.active && this.w < 0.004 && want === 0) this.active = false;

    // ---- idle: the clip, with its feet set on the ground
    const offsets = clipAnkles.map((p) => Math.max(-0.45, Math.min(0.45, o.ground(p.x, p.z) - rootY)));
    const drop = Math.min(0, offsets[0], offsets[1]) - Math.max(-0.03, Math.min(0.16, o.crouch));
    this.idleDrop += (drop - this.idleDrop) * (1 - Math.exp(-dt * 12));
    const idleAnkles = clipAnkles.map((p, i) => p.add(new Vector3(0, offsets[i], 0)));
    const W = this.active ? this.w : 0;

    const lift = this.footwork(dt, !!o.lock && W <= 0.002, clipAnkles, ls);
    if (W <= 0.002) {
      this.moveHips(Hc, new Vector3(Hc.x, Hc.y + this.idleDrop, Hc.z));
      for (let i = 0; i < 2; i++) {
        const l = this.legs[i];
        const po = this.plantO[i];
        const moved = po.lengthSquared() > 1e-6 || lift[i] > 1e-4;
        if (!moved && Math.abs(offsets[i] - this.idleDrop) < 0.01) continue;
        const t = idleAnkles[i];
        if (moved) {
          const c = clipAnkles[i];
          t.set(c.x + po.x, 0, c.z + po.z);
          t.y = c.y + Math.max(-0.45, Math.min(0.45, o.ground(t.x, t.z) - rootY)) + lift[i];
        }
        this.solveLeg(l, t, null, 0);
      }
      this.armW = 0;
      this.hipY = Hc.y + this.idleDrop;
      return;
    }

    // diagonal and sideways travel: the hips (and feet) turn toward it, the chest keeps facing ahead
    let travel = 0;
    let lateral = 0;
    if (moving) {
      const lx = Vector3.Dot(this.vs, R);
      const lz = Vector3.Dot(this.vs, F);
      lateral = Math.abs(lx) / Math.max(1e-3, speed);
      travel = Math.max(-1.25, Math.min(1.25, Math.atan2(lx, Math.abs(lz) + 0.15))) * 0.8 * (lz < 0 ? -1 : 1);
    }

    // the legs' own frame, turned with the hips
    const Rl = new Vector3(Math.cos(yaw + travel), 0, -Math.sin(yaw + travel));

    // ---- the cycle (side-steps are quicker and shorter)
    let cps = (stepRate(vn) / 2 / Math.sqrt(ls)) * (1 + 0.4 * lateral);
    if (!moving) cps = need || anySwing ? 1.15 : 0;
    this.phase = (this.phase + cps * dt) % 1;
    const toeUp = backward ? 0.05 : lerp(0.32, 0.12, run);
    const heelRise = backward ? 0.2 : lerp(0.55, 0.75, run);
    const roll0 = lerp(0.55, 0.35, run);
    const strikeEnd = lerp(0.14, 0.06, run);
    const liftH = lerp(0.075, 0.26, run) * ls * Math.min(1, 0.45 + vn / 2) + 0.06 * sprint * ls;
    const stanceDur = duty / Math.max(cps, 0.6);
    for (let i = 0; i < 2; i++) {
      const l = this.legs[i];
      const p = (this.phase + i * 0.5) % 1;
      const pp = l.prevP;
      l.prevP = p;
      const pWrapped = p < pp;
      const willLift = moving || far(l);
      // window edges: lift at `duty`, land when the foot's phase wraps
      if (!l.swing && cps > 0 && crossed(pp, p, duty) && willLift) {
        l.swing = true;
        l.lift.copyFrom(l.ankle);
        l.liftYaw = l.heading;
        l.liftPitch = l.pitch;
      } else if (l.swing && pWrapped) {
        l.swing = false;
        l.g.copyFrom(l.target);
        l.yaw = l.targetYaw;
      }
      if (l.swing) {
        const s = clamp01((p - duty) / (1 - duty));
        const tLeft = Math.max(0, (1 - p) / Math.max(cps, 0.3));
        let T: Vector3;
        if (moving) {
          T = root.position.add(this.vs.scale(tLeft + stanceDur * lerp(0.5, 0.42, run)));
          // narrower track at speed (runners place their feet nearly in line)
          T.addInPlace(Rl.scale(this.track(l) * lerp(1, 0.5, run)));
        } else T = restOf(l);
        // keep the feet from crossing on side-steps
        const other = this.legs[1 - i];
        const lat = Vector3.Dot(T.subtract(other.swing ? other.target : other.g), Rl) * l.sign;
        if (lat < 0.07 * ls) T.addInPlace(Rl.scale(l.sign * (0.07 * ls - lat)));
        T.y = gnd(T.x, T.z);
        l.target.copyFrom(T);
        // walking feet point ahead (a touch out-toed); a settling step goes back to the idle stance
        l.targetYaw = yaw + (moving ? l.sign * 0.09 * (1 - run) + travel * 0.9 : clampAbs(l.restYaw, 0.45));
        const land = ankleAt(T, l.targetYaw, toeUp, this.ankleH, this.ballFwd * 0.55, this.ballFwd);
        const e = s - Math.sin(TAU * s) / TAU;
        const pos = Vector3.Lerp(l.lift, land, e);
        const arc = run > 0.5 ? Math.sin(Math.PI * Math.pow(s, 0.72)) : Math.sin(Math.PI * s);
        const clearance = gnd(pos.x, pos.z) + this.ankleH;
        pos.y = Math.max(pos.y, clearance) + liftH * arc;
        l.ankle.copyFrom(pos);
        l.pitch = lerp(l.liftPitch, toeUp, smooth(0.25, 1, s)) - 0.35 * run * Math.sin(Math.PI * Math.min(1, s * 1.6));
        l.heading = l.liftYaw + angleDiff(l.targetYaw, l.liftYaw) * smooth(0, 0.8, s);
      } else {
        const u = willLift ? p / duty : 0.35;
        let th = 0;
        if (u < strikeEnd) th = toeUp * (1 - smooth(0, strikeEnd, u));
        else if (u > roll0) th = -heelRise * smooth(roll0, 1, u);
        // follow the slope under the foot
        const f = new Vector3(Math.sin(l.yaw), 0, Math.cos(l.yaw));
        const hb = gnd(l.g.x - f.x * 0.06, l.g.z - f.z * 0.06);
        const hf = gnd(l.g.x + f.x * 0.1, l.g.z + f.z * 0.1);
        const slope = Math.atan2(hf - hb, 0.16);
        // a held foot settles flat (no snap)
        l.pitch += (th - l.pitch) * (willLift ? 1 : 1 - Math.exp(-dt * 14));
        const g = l.g.clone();
        l.ankle.copyFrom(ankleAt(g, l.yaw, l.pitch, this.ankleH, this.ballFwd * 0.55, this.ballFwd));
        l.heading = l.yaw;
        l.slope = slope;
      }
    }

    // ---- hips: height (bob, reach), sway, rotation
    const gaitOn = Math.min(1, vn / 1.2);
    const bobA = lerp(0.016, 0.03, run) * ls * gaitOn;
    const bob = lerp(1, -1, run) * bobA * Math.cos(2 * TAU * (this.phase - duty / 2));
    const lower = (lerp(0.015, 0.07, run) + 0.03 * sprint) * ls * gaitOn;
    const crouch = Math.max(-0.03, Math.min(0.16, o.crouch));
    let H = rootY + this.hipH - lower + bob - crouch;
    const swayA = lerp(0.024, 0.008, run) * ls * gaitOn;
    const left = this.legs[0];
    const sway = R.scale(swayA * Math.cos(TAU * (this.phase - duty / 2)) * left.sign);
    const hipsXZ = root.position.add(R.scale(this.hipX)).add(F.scale(this.hipZ)).add(sway);
    // the legs must reach: hips no higher than the standing feet allow
    const Lmax = (this.thigh + this.shin) * 0.995;
    for (let i = 0; i < 2; i++) {
      const l = this.legs[i];
      const s = l.swing ? clamp01(((this.phase + i * 0.5) % 1 - duty) / (1 - duty)) : 0;
      if (l.swing && s > 0.12 && s < 0.88) continue;
      const off = clipHipJoints[i].subtract(Hc);
      const jx = hipsXZ.x + off.x - l.ankle.x;
      const jz = hipsXZ.z + off.z - l.ankle.z;
      const reach = l.ankle.y + Math.sqrt(Math.max(0, Lmax * Lmax - jx * jx - jz * jz)) - off.y;
      H = smin(H, reach, 0.03);
    }
    H = Math.max(H, rootY + this.hipH - 0.16 * ls);
    if (this.w < 0.05) this.hipY = Hc.y + this.idleDrop;
    this.hipY += (H - this.hipY) * (1 - Math.exp(-dt * 28));
    const idleHips = new Vector3(Hc.x, Hc.y + this.idleDrop, Hc.z);
    const gaitHips = new Vector3(hipsXZ.x, this.hipY, hipsXZ.z);
    // lean into acceleration, back when braking
    const leanT = Math.max(-0.2, Math.min(0.14, accel * 0.012)) * Math.min(1, speed / 1.5 + 0.4);
    stepSpring(this.lean, leanT * W, dt, 2.2, 0.55);
    const lean = this.lean.x;
    // rotation
    const swingYaw = -lerp(0.08, 0.13, run) * gaitOn * Math.cos(TAU * this.phase) * left.sign;
    const roll = lerp(0.05, 0.025, run) * gaitOn * Math.cos(TAU * (this.phase - duty / 2)) * left.sign;
    const tilt = (lerp(0.03, 0.15, run) + 0.07 * sprint) * gaitOn * (backward ? -0.3 : 1);
    const qClip = this.hips.rotationQuaternion!.clone();
    this.moveHips(Hc, Vector3.Lerp(idleHips, gaitHips, W));
    this.hips.rotationQuaternion!.copyFrom(this.hipsRest);
    refreshChain(this.hips);
    rotateWorld(this.hips, UP, swingYaw + travel);
    rotateWorld(this.hips, R, tilt + lean * 0.6);
    rotateWorld(this.hips, F, roll);
    const qProc = this.hips.rotationQuaternion!.clone();
    Quaternion.SlerpToRef(qClip, qProc, W, this.hips.rotationQuaternion!);
    refreshChain(this.hips);
    // the chest counters the hips, leans a little into the move and the turn
    if (this.spine) {
      rotateWorld(this.spine, UP, (-swingYaw * 0.45 - travel * 0.5) * W);
      rotateWorld(this.spine, R, lean * 0.25 * W);
    }
    if (this.chest) {
      refreshChain(this.chest);
      const turnLead = Math.max(-0.2, Math.min(0.2, o.turnRate * 0.05));
      rotateWorld(this.chest, UP, (-swingYaw * 0.85 - travel * 0.45 + turnLead) * W);
      rotateWorld(this.chest, R, (lean * 0.2 - tilt * 0.35) * W);
    }

    // ---- legs
    for (let i = 0; i < 2; i++) {
      const l = this.legs[i];
      const target = Vector3.Lerp(idleAnkles[i], l.ankle, W);
      const kneeFwd = new Vector3(Math.sin(l.heading), 0, Math.cos(l.heading)).add(R.scale(l.sign * 0.12));
      const clipPole = clipKnees[i].subtract(Vector3.Lerp(clipHipJoints[i], clipAnkles[i], 0.5));
      const pole = clipPole.lengthSquared() > 1e-8 ? Vector3.Lerp(clipPole.normalize(), kneeFwd.normalize(), W) : kneeFwd;
      this.solveLeg(l, target, pole, W);
    }

    if (this.debug) {
      this.debug.push({
        ph: +this.phase.toFixed(3), W: +W.toFixed(2), cps: +cps.toFixed(2), root: fmt(root.position),
        hipY: +(this.hipY - rootY).toFixed(3),
        legs: this.legs.map((l) => ({ sw: l.swing, g: fmt(l.g), want: fmt(l.ankle), got: (refreshChain(l.foot), fmt(l.foot.absolutePosition)) })),
      });
      if (this.debug.length > 400) this.debug.shift();
    }

    // ---- arms
    const armT = o.detail ? o.arms : 0;
    this.armW += (armT - this.armW) * (1 - Math.exp(-dt * 10));
    const aw = this.armW * W * smooth(0.05, 0.7, vn + (moving ? 0.3 : 0));
    if (aw > 0.01) this.swingArms(aw, F, R, run, sprint, gaitOn, o.armScale, o.grip ?? null);
  }

  /**
   * Square up the idle clip (weight `k`): turn the hips to face ahead and the
   * shoulders over them, centre the hips over feet set side by side (toes a
   * little out, one a touch ahead), and stand a little taller than the
   * clip's crouch. Done on the clip's pose before anything reads it, so the
   * rest of the gait (and its learned idle stance) sees the squared stance.
   */
  private squareUp(k: number, yaw: number, F: Vector3, R: Vector3, rootY: number) {
    if (k < 0.01) return;
    const left = this.legs[0].sign < 0 ? this.legs[0] : this.legs[1];
    const right = left === this.legs[0] ? this.legs[1] : this.legs[0];
    const side = yaw + Math.PI / 2;
    const heading = (a: Vector3, b: Vector3) => Math.atan2(b.x - a.x, b.z - a.z);
    // hips face ahead
    refreshChain(right.upper);
    refreshChain(left.upper);
    rotateWorld(this.hips, UP, -angleDiff(heading(left.upper.absolutePosition, right.upper.absolutePosition), side) * k);
    refreshChain(left.upper);
    refreshChain(right.upper);
    // the feet: side by side under the hip joints, toes a little out
    const jl = left.upper.absolutePosition.clone();
    const jr = right.upper.absolutePosition.clone();
    const ls = this.ls;
    const half = Math.max(0.085 * ls, Math.min(0.12 * ls, Vector3.Distance(jl, jr) / 2 + 0.02 * ls));
    const root = this.root.position;
    const stance = (l: Leg, z: number) => root.add(R.scale(l.sign * half)).add(F.scale(z * ls));
    const tgt = [stance(left, 0.035), stance(right, -0.025)];
    // the hips over them, high enough that the knees are only softly bent
    const mid = jl.add(jr).scale(0.5);
    const centre = tgt[0].add(tgt[1]).scale(0.5);
    const L = (this.thigh + this.shin) * 0.97;
    let top = Infinity;
    for (const [i, j] of [jl, jr].entries()) {
      const h = Math.hypot(j.x - mid.x + centre.x - tgt[i].x, j.z - mid.z + centre.z - tgt[i].z);
      top = Math.min(top, Math.sqrt(Math.max(0, L * L - h * h)));
    }
    const wantY = rootY + this.ankleH + top;
    const d = new Vector3(centre.x - mid.x, Math.max(-0.04, Math.min(0.1 * ls, wantY - mid.y)), centre.z - mid.z).scale(k);
    const hp = this.hips.absolutePosition.clone();
    this.moveHips(hp, hp.add(d));
    // the shoulders over the hips (spine and chest share the turn)
    const shoulders = () => {
      const a = this.arms.map((x) => (refreshChain(x.upper), x.upper.absolutePosition.clone()));
      if (a.length < 2) return 0;
      const [p, q] = Vector3.Dot(a[1].subtract(a[0]), R) >= 0 ? [a[0], a[1]] : [a[1], a[0]];
      return angleDiff(heading(p, q), side);
    };
    if (this.spine) rotateWorld(this.spine, UP, -shoulders() * 0.4 * k);
    if (this.chest) {
      refreshChain(this.chest);
      rotateWorld(this.chest, UP, -shoulders() * k);
    }
    // the legs down to the feet, knees ahead
    for (const [i, l] of [left, right].entries()) {
      refreshChain(l.foot);
      const t = tgt[i];
      t.y = rootY + this.ankleH;
      const target = Vector3.Lerp(l.foot.absolutePosition, t, k);
      const fy = yaw + l.sign * 0.16;
      const pole = new Vector3(Math.sin(fy), 0, Math.cos(fy)).add(R.scale(l.sign * 0.1));
      this.solveLeg(l, target, pole, k, { heading: fy, pitch: 0 });
    }
  }

  /** Lateral offset of a walking foot from the body's line: the idle stance width, within reason. */
  private track(l: Leg) {
    const half = Math.max(0.06 * this.ls, Math.min(0.13 * this.ls, Math.abs(this.legs[0].restX - this.legs[1].restX) / 2));
    return half * l.sign;
  }

  private start(yaw: number, gnd: Ground, F: Vector3, duty: number) {
    this.active = true;
    // the trailing foot (along the way we're heading) steps first
    let lead = 0;
    let best = Infinity;
    const dir = this.vs.lengthSquared() > 1e-4 ? this.vs.clone().normalize() : F;
    for (let i = 0; i < 2; i++) {
      const l = this.legs[i];
      const p = l.foot.absolutePosition;
      l.g.set(p.x, gnd(p.x, p.z), p.z);
      l.yaw = footYaw(l, yaw);
      l.heading = l.yaw;
      l.pitch = 0;
      l.swing = false;
      l.ankle.copyFrom(p);
      const d = Vector3.Dot(p.subtract(this.root.position), dir);
      if (d < best) {
        best = d;
        lead = i;
      }
    }
    // the lead foot's window opens on the next frame
    this.phase = (duty - 0.002 - lead * 0.5 + 1) % 1;
    for (let i = 0; i < 2; i++) this.legs[i].prevP = (this.phase + i * 0.5) % 1;
    this.hipY = this.hips.absolutePosition.y;
  }

  /**
   * Attack footwork. While `on`, each foot keeps its place in the world as
   * the body lunges under it (its offset from the clip's foot grows); once a
   * foot is pulled too far it steps to catch up, the leading one first, so a
   * lunge reads as a step into the blow. Turns (an attack snaps the body to
   * its aim) pivot the feet with the body: planted against a big snap they
   * wrung the legs round each other. Off, any offset left steps home.
   * Returns each foot's lift.
   */
  private footwork(dt: number, on: boolean, clip: Vector3[], ls: number) {
    const r = this.root.position;
    const prev = this.prevRoot;
    const lifts = [0, 0];
    for (let i = 0; i < 2; i++) this.sinceStep[i] += dt;
    if (on && prev) {
      for (let i = 0; i < 2; i++) {
        if (this.stepT[i] >= 0) continue;
        const o = this.plantO[i];
        o.x -= r.x - prev.x;
        o.z -= r.z - prev.z;
        // a foot that has just stepped drags rather than pattering again,
        // and no foot is left far behind (no splits)
        const d = o.length();
        if (d > 0.12 * ls && this.sinceStep[i] < 0.32) o.scaleInPlace(Math.exp(-dt * 7));
        if (d > 0.32 * ls) o.scaleInPlace((0.32 * ls) / d);
      }
    }
    const step = (i: number) => {
      this.stepT[i] = 0;
      this.sinceStep[i] = 0;
      this.stepFrom[i].copyFrom(this.plantO[i]);
      this.stepLift[i] = Math.min(0.07, 0.025 + this.plantO[i].length() * 0.2) * ls;
    };
    if (this.stepT[0] < 0 && this.stepT[1] < 0) {
      // the foot pulled furthest steps, favouring the one leading the way the body went
      let pick = -1;
      let best = 0;
      for (let i = 0; i < 2; i++) {
        const d = this.plantO[i].length();
        if (d < (on ? 0.14 * ls : 0.02) || (on && this.sinceStep[i] < 0.32)) continue;
        const lead = d > 1e-6 ? -((clip[i].x - r.x) * this.plantO[i].x + (clip[i].z - r.z) * this.plantO[i].z) / d : 0;
        const score = d + 0.6 * lead;
        if (pick < 0 || score > best) {
          pick = i;
          best = score;
        }
      }
      if (pick >= 0) step(pick);
    }
    for (let i = 0; i < 2; i++) {
      if (this.stepT[i] < 0) {
        // nothing to step off: let small offsets go
        if (!on) this.plantO[i].scaleInPlace(Math.exp(-dt * 20));
        continue;
      }
      this.stepT[i] = Math.min(1, this.stepT[i] + dt / 0.17);
      const u = this.stepT[i];
      const e = u * u * (3 - 2 * u);
      this.plantO[i].copyFrom(this.stepFrom[i]).scaleInPlace(1 - e);
      lifts[i] = Math.sin(Math.PI * u) * this.stepLift[i];
      if (u >= 1) {
        this.stepT[i] = -1;
        this.plantO[i].setAll(0);
      }
    }
    this.prevRoot = r.clone();
    return lifts;
  }

  /** Move the hips bone so its world position becomes `to` (from `from`). */
  private moveHips(from: Vector3, to: Vector3) {
    const d = to.subtract(from);
    if (d.lengthSquared() < 1e-10) return;
    const parent = this.hips.parent as TransformNode | null;
    if (parent) {
      const inv = parent.getWorldMatrix().clone().invert();
      Vector3.TransformNormalToRef(d, inv, d);
    }
    this.hips.position.addInPlace(d);
    refreshChain(this.hips);
  }

  /** Two-bone IK to an ankle target, the knee toward `pole`; then the foot's pitch. */
  private solveLeg(l: Leg, target: Vector3, pole: Vector3 | null, w: number, pose?: { heading: number; pitch: number }) {
    refreshChain(l.foot);
    const A = l.upper.absolutePosition.clone();
    const B = l.lower.absolutePosition.clone();
    const C = l.foot.absolutePosition.clone();
    const lab = Vector3.Distance(A, B);
    const lbc = Vector3.Distance(B, C);
    const toT = target.subtract(A);
    const lat = Math.max(0.05, Math.min(lab + lbc - 0.002, toT.length()));
    const d = toT.normalize();
    let pl: Vector3;
    if (pole) pl = pole.clone();
    else {
      const ac = C.subtract(A).normalize();
      const ab = B.subtract(A);
      pl = ab.subtract(ac.scale(Vector3.Dot(ab, ac)));
      if (pl.lengthSquared() < 1e-8) pl = new Vector3(Math.sin(this.root.rotation.y), 0, Math.cos(this.root.rotation.y));
    }
    pl = pl.subtract(d.scale(Vector3.Dot(pl, d)));
    if (pl.lengthSquared() < 1e-8) pl = new Vector3(Math.sin(this.root.rotation.y), 0, Math.cos(this.root.rotation.y));
    pl.normalize();
    const cosA = Math.max(-1, Math.min(1, (lab * lab + lat * lat - lbc * lbc) / (2 * lab * lat)));
    const sinA = Math.sqrt(1 - cosA * cosA);
    const knee = A.add(d.scale(lab * cosA)).add(pl.scale(lab * sinA));
    aimBone(l.upper, l.lower, knee);
    aimBone(l.lower, l.foot, A.add(d.scale(lat)));
    if (w < 0.01 || !l.toes) return;
    // foot pitch: aim the ball of the foot, then keep the toes on the ground
    refreshChain(l.toes);
    const th = pose ? pose.pitch : l.pitch + (l.swing ? 0 : l.slope);
    const hd = pose ? pose.heading : l.heading;
    const f = new Vector3(Math.sin(hd), 0, Math.cos(hd));
    const fwd = this.ballFwd;
    const down = this.ballDown;
    const ball = l.foot.absolutePosition.add(f.scale(fwd * Math.cos(th) + down * Math.sin(th))).add(UP.scale(fwd * Math.sin(th) - down * Math.cos(th)));
    const now = l.toes.absolutePosition;
    aimBone(l.foot, l.toes, Vector3.Lerp(now, ball, w));
    if (!pose && l.pitch < -0.02 && !l.swing) {
      refreshChain(l.toes);
      const side = Vector3.Cross(UP, f).normalize();
      rotateWorld(l.toes, side, -l.pitch * 0.85 * w);
    }
  }

  /** Arms swing against the legs: relaxed walking, pumped with bent elbows running. */
  private swingArms(w: number, F: Vector3, R: Vector3, run: number, sprint: number, on: number, scale: { l: number; r: number }, grip: 'blade' | 'staff' | null) {
    const lag = 0.04;
    for (const a of this.arms) {
      refreshChain(a.wrist);
      const S = a.upper.absolutePosition.clone();
      const out = R.scale(Vector3.Dot(S.subtract(this.root.position), R) >= 0 ? 1 : -1);
      // this arm swings forward as the opposite leg does (left leg forward at phase 0)
      const legL = this.legs.find((l) => l.side === 'l')!;
      const sameSide = Vector3.Dot(out, R) * legL.sign > 0;
      const ph = this.phase - lag - (sameSide ? 0.5 : 0);
      const sw = Math.cos(TAU * ph) * (scale[a.side] ?? 1);
      const amp = (lerp(0.32, 0.7, run) + 0.2 * sprint) * on;
      const alpha = lerp(0.04, 0.12, run) + amp * sw;
      const beta = lerp(0.1, 0.24, run);
      const bend = lerp(0.22 + 0.3 * Math.max(0, sw) * on, 1.45 + 0.25 * sw, run);
      // torso frame: tip forward with the hips
      const du = UP.scale(-Math.cos(alpha)).add(F.scale(Math.sin(alpha))).add(out.scale(Math.sin(beta))).normalize();
      const E = S.add(du.scale(this.upperArm));
      // forearm: bend forward and up, crossing in a little when running
      let side = F.subtract(du.scale(Vector3.Dot(F, du)));
      if (side.lengthSquared() < 1e-6) side = F.clone();
      side.normalize();
      const df = du.scale(Math.cos(bend)).add(side.scale(Math.sin(bend))).add(out.scale(-0.28 * run)).normalize();
      const E0 = a.lower.absolutePosition.clone();
      const W0 = a.wrist.absolutePosition.clone();
      aimBone(a.upper, a.lower, Vector3.Lerp(E0, E, w));
      refreshChain(a.wrist);
      const Ew = a.lower.absolutePosition.clone();
      const dir = Vector3.Lerp(W0.subtract(E0).normalize(), df, w).normalize();
      aimBone(a.lower, a.wrist, Ew.add(dir.scale(this.foreArm)));
      if (grip && a.side === 'r') this.holdWeapon(a, grip, w, F, out, run);
    }
  }

  /**
   * Turn the weapon hand so what it holds is carried, not waved: a blade
   * points ahead and down from the fist walking and trails low behind
   * running; a staff stands upright. (The clips hold weapons up for a fight,
   * which on the swinging arm stuck the sword out behind like a tail.)
   */
  private holdWeapon(a: Arm, grip: 'blade' | 'staff', w: number, F: Vector3, out: Vector3, run: number) {
    const slot = this.slot;
    if (!slot) return;
    refreshChain(slot);
    const fa = a.wrist.absolutePosition.subtract(a.lower.absolutePosition).normalize();
    let D: Vector3;
    if (grip === 'staff') D = UP.scale(0.93).add(F.scale(0.3)).add(out.scale(0.06)).normalize();
    else {
      const f = F.subtract(fa.scale(Vector3.Dot(F, fa)));
      if (f.lengthSquared() < 1e-4) f.copyFrom(F);
      f.normalize();
      const carry = f.scale(0.65).add(fa.scale(0.75)).add(out.scale(0.15)).normalize();
      const trail = F.scale(-0.75).add(UP.scale(-0.4)).add(out.scale(0.55)).normalize();
      D = Vector3.Lerp(carry, trail, smooth(0.2, 0.8, run)).normalize();
    }
    // point the tip (the slot's +Y)
    const m = slot.getWorldMatrix();
    const Y = Vector3.TransformNormal(Vector3.Up(), m).normalize();
    const axis = Vector3.Cross(Y, D);
    const s = axis.length();
    if (s > 1e-5) rotateWorld(a.wrist, axis.scaleInPlace(1 / s), Math.atan2(s, Vector3.Dot(Y, D)) * w * AIM_SIGN);
    refreshChain(slot);
    // edge down, flat to the side: the guard (the slot's X) upright, whichever way is nearer
    const X = Vector3.TransformNormal(Vector3.Right(), slot.getWorldMatrix());
    const Xp = X.subtract(D.scale(Vector3.Dot(X, D)));
    const Xd = UP.subtract(D.scale(Vector3.Dot(UP, D)));
    if (Xp.lengthSquared() < 1e-6 || Xd.lengthSquared() < 1e-6) return;
    Xp.normalize();
    Xd.normalize();
    if (Vector3.Dot(Xp, Xd) < 0) Xd.scaleInPlace(-1);
    const roll = Math.atan2(Vector3.Dot(Vector3.Cross(Xp, Xd), D), Vector3.Dot(Xp, Xd));
    rotateWorld(a.wrist, D, roll * w * AIM_SIGN);
  }
}

// ---------------------------------------------------------------- helpers

function fmt(v: Vector3) {
  return [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function clampAbs(x: number, m: number) {
  return Math.max(-m, Math.min(m, x));
}

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function smooth(e0: number, e1: number, x: number) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Smooth minimum (k = blend width). */
function smin(a: number, b: number, k: number) {
  const h = clamp01(0.5 + (0.5 * (b - a)) / k);
  return b + (a - b) * h - k * h * (1 - h);
}

function angleDiff(a: number, b: number) {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Did a phase go from `a` to `b` (forwards, maybe wrapping) past `edge`? */
function crossed(a: number, b: number, edge: number) {
  if (b >= a) return a < edge && b >= edge;
  return a < edge || b >= edge;
}

/** Steps per second at a (leg-normalised) speed: brisk walking to sprinting. */
function stepRate(v: number) {
  const keys: [number, number][] = [[0.2, 1.6], [1.2, 2.0], [2.1, 2.5], [3.2, 2.7], [5.4, 3.0], [8, 3.6], [11, 4.0]];
  if (v <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (v <= keys[i][0]) {
      const [v0, s0] = keys[i - 1];
      const [v1, s1] = keys[i];
      return s0 + ((s1 - s0) * (v - v0)) / (v1 - v0);
    }
  }
  return keys[keys.length - 1][1];
}

/**
 * Ankle position for a foot on ground point `g` heading `yaw`, pitched `th`
 * (toes up positive: rocking on the heel; negative: heel raised, on the ball).
 */
function ankleAt(g: Vector3, yaw: number, th: number, ankleH: number, heelBack: number, ballFwd: number) {
  const f = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const c = Math.cos(th);
  const s = Math.sin(th);
  if (th >= 0) {
    const heel = g.subtract(f.scale(heelBack));
    return heel.add(f.scale(heelBack * c - ankleH * s)).add(UP.scale(heelBack * s + ankleH * c));
  }
  const ball = g.add(f.scale(ballFwd));
  return ball.add(f.scale(-ballFwd * c - ankleH * s)).add(UP.scale(-ballFwd * s + ankleH * c));
}

/** Heading of a foot (ankle → ball), or the body's when it can't tell. */
function footYaw(l: Leg, yaw: number) {
  if (!l.toes) return yaw;
  const d = l.toes.absolutePosition.subtract(l.foot.absolutePosition);
  if (d.x * d.x + d.z * d.z < 1e-6) return yaw;
  return Math.atan2(d.x, d.z);
}

/** Recompute a node's world matrix and its ancestors', top down. */
export function refreshChain(n: Node) {
  const chain: TransformNode[] = [];
  for (let p: Node | null = n; p; p = p.parent) if (p instanceof TransformNode) chain.push(p);
  for (let i = chain.length - 1; i >= 0; i--) chain[i].computeWorldMatrix(true);
}

const tmpM = new Matrix();
const tmpQ = new Quaternion();

/**
 * Rotate a node about a world axis through its own origin. Done with
 * matrices so it stays right under the mirrored glTF root (a world rotation
 * seen through a reflection is a rotation about the reflected axis the other way).
 */
export function rotateWorld(n: TransformNode, axis: Vector3, angle: number) {
  if (Math.abs(angle) < 1e-6) return;
  const q = n.rotationQuaternion ?? (n.rotationQuaternion = Quaternion.FromEulerVector(n.rotation));
  const parent = n.parent as TransformNode | null;
  const rot = Matrix.RotationAxis(axis, angle);
  let C = rot;
  if (parent) {
    const P = parent.getWorldMatrix();
    const Pi = P.clone().invert();
    C = P.multiply(rot).multiply(Pi);
  }
  q.toRotationMatrix(tmpM);
  const L = tmpM.multiply(C);
  Quaternion.FromRotationMatrixToRef(L, tmpQ);
  tmpQ.normalize();
  q.copyFrom(tmpQ);
  n.computeWorldMatrix(true);
}

/** Rotate `bone` (about its origin, in world space) so bone→child points at `target`. */
export function aimBone(bone: TransformNode, child: TransformNode, target: Vector3) {
  bone.computeWorldMatrix(true);
  child.computeWorldMatrix(true);
  const pivot = bone.absolutePosition.clone();
  const from = child.absolutePosition.subtract(pivot);
  const to = target.subtract(pivot);
  if (from.lengthSquared() < 1e-12 || to.lengthSquared() < 1e-12) return;
  from.normalize();
  to.normalize();
  const dot = Vector3.Dot(from, to);
  if (dot > 0.999999) return;
  let axis = Vector3.Cross(from, to);
  if (axis.lengthSquared() < 1e-12) {
    axis = Vector3.Cross(from, Math.abs(from.y) < 0.9 ? UP : Vector3.Right());
  }
  axis.normalize();
  const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
  rotateWorld(bone, axis, angle * AIM_SIGN);
  child.computeWorldMatrix(true);
}

/** Which way Matrix.RotationAxis turns about a cross product (handedness), found once. */
export const AIM_SIGN = (() => {
  const from = new Vector3(1, 0, 0);
  const to = new Vector3(0, 1, 0);
  const r = Vector3.TransformNormal(from, Matrix.RotationAxis(Vector3.Cross(from, to).normalize(), Math.PI / 2));
  return Vector3.Dot(r, to) > 0 ? 1 : -1;
})();
