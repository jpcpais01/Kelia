// Weight-blended animation for KayKit rigs.
//
// Locomotion clips (idle / walk / run / sprint / back / strafe) all play at
// once with weights from the current velocity, started together and advanced
// at one shared cycle rate so they stay phase-locked. That rate follows the
// distance travelled (cycles per second = speed / stride) until it reaches a
// natural cadence for the gait; past that the legs keep a human rhythm and
// the stride lengthens instead (`strideGain`, applied by the model), because
// the stylised clips take much shorter steps than the speeds we move at.
// One-shot actions (attacks, casts, dodges, hits) fade in on top: full-body
// when standing still, upper-body only while moving (weighted over the legs' clips).
// An action can follow a timeline of beats instead of playing at one speed:
// each frame the clip's playback rate is steered so its pose lands on the
// beat curve, which is how attacks get their anticipation, snap and
// follow-through (see attacks.ts), and how hit-stop freezes them on contact.
// A clip can be asked for again while its last play is still fading out (the
// staff's bolt combo casts the same clip three times in a row): that play
// keeps its group, and the new one runs on a twin of the clip, so the two
// cross-fade instead of fighting over one group's weight and clock.
import { AnimationGroupMask, AnimationGroupMaskMode, type AnimationGroup, type TransformNode } from '@babylonjs/core';

const MIN_W = 1e-4;
/** Below this a fading locomotion loop no longer shows and is paused. */
const LIVE_W = 0.004;

export const UPPER_BODY = [
  'spine', 'chest', 'head',
  'upperarm.l', 'lowerarm.l', 'wrist.l', 'hand.l', 'handslot.l',
  'upperarm.r', 'lowerarm.r', 'wrist.r', 'hand.r', 'handslot.r',
];

type LocoKey = 'idle' | 'walk' | 'run' | 'sprint' | 'back' | 'left' | 'right' | 'air';

export interface LocoClips {
  idle: string;
  walk: string;
  run: string;
  sprint?: string;
  back?: string;
  left?: string;
  right?: string;
  air?: string;
}

export type Ease = 'linear' | 'in' | 'out' | 'inout';
/** [game seconds since the action started, clip seconds, easing of the segment that ends here] */
export type Beat = [number, number, Ease];

/** Where a timed action is, for procedural layers that follow it. */
export interface ActionPhase {
  /** Seconds into the timeline (hit-stop doesn't advance it). */
  t: number;
  strikeAt: number;
  contactAt: number;
  settleAt: number;
  duration: number;
  /** Blend weight of the action (fades in and out). */
  weight: number;
  /** 0..1 how hard it hits (set by the caller). */
  power: number;
  /** strike (melee), release (bow), cast (spells): how the body sells it. */
  style: 'strike' | 'release' | 'cast';
  /** Frozen on contact. */
  stopped: boolean;
}

interface Action {
  group: AnimationGroup;
  t: number;
  duration: number;
  fadeIn: number;
  fadeOut: number;
  upper: boolean;
  loop: boolean;
  hold: boolean;
  weight: number;
  onEnd?: () => void;
  beats?: Beat[];
  fps: number;
  /** Hit-stop seconds left. */
  stop: number;
  /** First frame of a timed action, until the clip has been sampled once. */
  startFrame: number | null;
  cancelAfter?: number;
  phase?: Omit<ActionPhase, 't' | 'weight' | 'stopped' | 'duration'>;
}

export interface PlayOptions {
  speed?: number;
  fadeIn?: number;
  fadeOut?: number;
  /** Only animate the upper body (spine up). Default: auto (when moving). */
  upper?: boolean;
  loop?: boolean;
  /** Freeze on the last frame instead of fading out (deaths, sitting). */
  hold?: boolean;
  onEnd?: () => void;
  /** Follow this timeline instead of a fixed speed (ignores `speed`). */
  beats?: Beat[];
  /** Key moments of the timeline, exposed through `phase()`. */
  phase?: Omit<ActionPhase, 't' | 'weight' | 'stopped' | 'duration'>;
  /** After this many seconds, moving cuts the action short (its recovery). */
  cancelAfter?: number;
}

export class Animator {
  private groups = new Map<string, AnimationGroup>();
  /** Second copies of action clips, made the first time a clip is replayed mid-fade. */
  private twins = new Map<string, AnimationGroup>();
  private loco = new Map<LocoKey, AnimationGroup>();
  private locoW = new Map<LocoKey, number>();
  private strides = new Map<LocoKey, number>();
  private action: Action | null = null;
  private fading: Action[] = [];
  /** Smoothed planar speed (m/s) and local direction (x right, z forward). */
  private speed = 0;
  private dirX = 0;
  private dirZ = 1;
  airborne = false;
  /** Model units → metres (character scale). */
  scale = 1;
  /**
   * Natural cadence per gait: [loops per second, at this speed in m/s]. The
   * cadence scales with the square root of speed around that point. Null keeps
   * the playback strictly foot-locked (monsters).
   */
  cadence: Partial<Record<LocoKey, [number, number]>> | null = null;
  /** How much longer than the clip's own stride the legs should swing (1 = as authored). */
  strideGain = 1;

  constructor(groups: AnimationGroup[], clips: LocoClips, strideOverrides: Partial<Record<LocoKey, number>> = {}) {
    for (const g of groups) {
      g.stop();
      g.weight = 0;
      g.enableBlending = false;
      this.groups.set(stripName(g.name), g);
    }
    const defaults: Record<LocoKey, number> = { idle: 1, walk: 1.75, run: 3.1, sprint: 3.6, back: 1.4, left: 2.6, right: 2.6, air: 1 };
    for (const [k, name] of Object.entries(clips) as [LocoKey, string | undefined][]) {
      if (!name) continue;
      const g = this.groups.get(name);
      if (!g) continue;
      this.loco.set(k, g);
      this.locoW.set(k, k === 'idle' ? 1 : 0);
      this.strides.set(k, strideOverrides[k] ?? defaults[k]);
    }
    // Start every locomotion loop on the same frame so phases stay locked.
    for (const g of this.loco.values()) {
      g.start(true, 1, g.from, g.to, false);
      g.weight = MIN_W;
    }
    this.loco.get('idle')!.weight = 1;
  }

  has(name: string) {
    return this.groups.has(name);
  }

  duration(name: string) {
    const g = this.groups.get(name);
    if (!g) return 0;
    return (g.to - g.from) / (g.targetedAnimations[0]?.animation.framePerSecond || 30);
  }

  /** Measured stride (metres per loop at scale 1) for a locomotion key. */
  setStride(key: LocoKey, units: number) {
    if (units > 0.2) this.strides.set(key, units);
  }

  locoGroup(key: LocoKey) {
    return this.loco.get(key);
  }

  /**
   * Feed the current planar velocity in the character's local frame
   * (x = right, z = forward), in metres per second.
   */
  setMotion(localX: number, localZ: number, dt: number) {
    const sp = Math.hypot(localX, localZ);
    const k = 1 - Math.exp(-dt * 7);
    this.speed += (sp - this.speed) * k;
    if (sp > 0.05) {
      const kd = 1 - Math.exp(-dt * 8);
      this.dirX += (localX / sp - this.dirX) * kd;
      this.dirZ += (localZ / sp - this.dirZ) * kd;
    }
  }

  play(name: string, o: PlayOptions = {}): number {
    if (!this.groups.has(name)) return 0;
    if (this.action) this.retire(this.action);
    const g = this.freeGroup(name);
    const beats = o.beats && o.beats.length > 1 ? o.beats : undefined;
    const speed = beats ? 1 : o.speed ?? 1;
    const fps = g.targetedAnimations[0]?.animation.framePerSecond || 30;
    const duration = beats ? beats[beats.length - 1][0] : (g.to - g.from) / fps / speed;
    const upper = o.upper ?? this.speed > 0.6;
    g.stop();
    g.mask = upper ? new AnimationGroupMask(UPPER_BODY, AnimationGroupMaskMode.Include) : null;
    g.weight = MIN_W;
    // Holds loop internally so the group can't end (and drop its pose) before
    // we freeze it; timed actions too, since they steer their own clock and
    // must stay on their last pose while they fade out.
    const from = beats ? Math.min(g.to - 1, g.from + beats[0][1] * fps) : g.from;
    g.start(!!o.loop || !!o.hold || !!beats, speed, from, g.to, false);
    this.action = {
      group: g,
      t: 0,
      duration,
      fadeIn: o.fadeIn ?? 0.08,
      fadeOut: o.fadeOut ?? 0.18,
      upper,
      loop: !!o.loop,
      hold: !!o.hold,
      weight: 0,
      onEnd: o.onEnd,
      beats,
      fps,
      stop: 0,
      startFrame: from,
      cancelAfter: o.cancelAfter,
      phase: beats && o.phase ? { ...o.phase } : undefined,
    };
    return duration;
  }

  /** Freeze the current timed action for `seconds` (hit-stop on contact). */
  hitstop(seconds: number) {
    const a = this.action;
    if (a?.beats) a.stop = Math.max(a.stop, seconds);
  }

  /** The current timed action's progress, for procedural layers. */
  phase(): ActionPhase | null {
    const a = this.action ?? null;
    if (a?.phase) return { ...a.phase, t: a.t, duration: a.duration, weight: a.weight, stopped: a.stop > 0 };
    // keep reporting a fading action so its overlay eases out with it
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const f = this.fading[i];
      if (f.phase) return { ...f.phase, t: f.t, duration: f.duration, weight: Math.max(0, f.weight), stopped: false };
    }
    return null;
  }

  /** Stop the current action (e.g. interrupted by a dodge). */
  stopAction() {
    if (this.action) this.retire(this.action);
    this.action = null;
  }

  get busy() {
    return !!this.action && !this.action.loop && !this.action.hold;
  }

  get currentAction() {
    return this.action ? stripName(this.action.group.name) : null;
  }

  /**
   * A group for a new play of `name` that no other play is using. A replay
   * while the previous one still fades out goes to the clip's twin; if both
   * are busy, the fainter fading play gives its group up.
   */
  private freeGroup(name: string): AnimationGroup {
    const g = this.groups.get(name)!;
    const user = (grp: AnimationGroup) => this.fading.findIndex((f) => f.group === grp);
    if (user(g) < 0) return g;
    let twin = this.twins.get(name);
    if (!twin) {
      twin = g.clone(g.name);
      twin.stop();
      twin.weight = 0;
      twin.enableBlending = false;
      this.twins.set(name, twin);
    }
    if (user(twin) < 0) return twin;
    const a = user(g);
    const b = user(twin);
    const drop = this.fading[a].weight <= this.fading[b].weight ? a : b;
    const grp = this.fading[drop].group;
    this.fading.splice(drop, 1);
    return grp;
  }

  /**
   * True while some clip is writing the skeleton this frame. When nothing
   * plays, the bones keep last frame's values, so procedural layers that
   * build on the animated pose must not be applied again.
   */
  get posing() {
    if (this.action?.group.isPlaying) return true;
    for (const f of this.fading) if (f.group.isPlaying) return true;
    for (const g of this.loco.values()) if (g.isPlaying) return true;
    return false;
  }

  private retire(a: Action) {
    a.hold = false;
    a.loop = false;
    a.stop = 0;
    // timed actions hold their pose while they fade
    if (a.beats) a.group.speedRatio = 0;
    a.t = Math.max(a.t, a.duration); // fade from now
    a.duration = a.t;
    this.fading.push(a);
  }

  update(dt: number) {
    // --- action weights ---
    let actionFull = 0; // how much a full-body action overrides locomotion
    // moving cancels looping emotes (sitting, dancing)
    if (this.action && (this.action.loop || this.action.hold) && this.speed > 1.2) this.stopAction();
    // a recovery can be cut short by moving away
    if (this.action?.cancelAfter !== undefined && this.action.t > this.action.cancelAfter && this.speed > 0.9 && !this.action.upper) {
      this.action.fadeOut = Math.min(this.action.fadeOut, 0.16);
      this.stopAction();
    }
    const a = this.action;
    if (a) {
      // hit-stop: the timeline barely creeps
      const adv = a.stop > 0 ? dt * 0.03 : dt;
      a.stop = Math.max(0, a.stop - dt);
      a.t += adv;
      if (a.beats) this.steer(a, dt);
      if (!a.loop && !a.hold && a.t >= a.duration) {
        this.action = null;
        if (a.beats) a.group.speedRatio = 0;
        this.fading.push(a);
        a.onEnd?.();
      } else {
        a.weight = Math.max(MIN_W, Math.min(1, a.t / a.fadeIn));
        if (a.hold && a.t >= a.duration && a.group.isPlaying) {
          a.group.goToFrame(a.group.to - 0.01);
          a.group.pause();
        }
        // Upper-body actions out-weigh locomotion on the masked bones (Babylon normalises weights > 1).
        a.group.weight = a.upper ? a.weight * 6 : a.weight;
        // a clip that stopped writing bones must not hold locomotion off
        if (!a.upper && (a.group.isPlaying || a.hold)) actionFull = a.weight;
      }
    }
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const f = this.fading[i];
      f.weight -= dt / f.fadeOut;
      if (f.weight <= 0) {
        f.group.weight = 0;
        f.group.stop();
        this.fading.splice(i, 1);
      } else {
        f.group.weight = f.upper ? f.weight * 6 : f.weight;
        if (!f.upper && f.group.isPlaying) actionFull = Math.max(actionFull, f.weight);
      }
    }

    // --- locomotion blend ---
    const s = this.speed;
    const w: Record<LocoKey, number> = { idle: 0, walk: 0, run: 0, sprint: 0, back: 0, left: 0, right: 0, air: 0 };
    if (this.airborne && this.loco.has('air')) {
      w.air = 1;
    } else {
      const moving = smooth(0.05, 0.5, s);
      w.idle = 1 - moving;
      // gait along forward axis
      const walkRun = smooth(2.3, 4.6, s);
      const runSprint = this.loco.has('sprint') ? smooth(5.8, 7.6, s) : 0;
      const fwd = Math.max(0, this.dirZ);
      const back = Math.max(0, -this.dirZ);
      const side = Math.abs(this.dirX);
      const total = fwd + back + side || 1;
      const mf = (moving * fwd) / total;
      w.walk = mf * (1 - walkRun);
      w.run = mf * walkRun * (1 - runSprint);
      w.sprint = mf * walkRun * runSprint;
      if (this.loco.has('back')) w.back = (moving * back) / total;
      else w.walk += (moving * back) / total;
      const ms = (moving * side) / total;
      if (this.loco.has('left') && this.loco.has('right')) {
        if (this.dirX < 0) w.left = ms;
        else w.right = ms;
      } else w.run += ms;
    }
    // shared cycle rate (loops per second) from the weighted stride
    let strideSum = 0;
    let naturalSum = 0;
    let wSum = 0;
    for (const k of ['walk', 'run', 'sprint', 'back', 'left', 'right'] as LocoKey[]) {
      if (w[k] > 0) {
        strideSum += (this.strides.get(k) ?? 2) * this.scale * w[k];
        const c = this.cadence?.[k];
        naturalSum += (c ? c[0] * Math.sqrt(Math.max(s, 0) / c[1]) : Infinity) * w[k];
        wSum += w[k];
      }
    }
    const stride = wSum > 0 ? strideSum / wSum : 2;
    const locked = s / stride;
    const natural = wSum > 0 ? naturalSum / wSum : Infinity;
    const cyclesPerSec = Math.max(0.35, Math.min(locked, natural));
    const gain = this.airborne ? 1 : Math.max(1, Math.min(1.3, locked / cyclesPerSec));
    this.strideGain += (gain - this.strideGain) * (1 - Math.exp(-dt * 6));
    // The gait mix is smoothed on its own; an action then takes its exact
    // share off the top, so action + locomotion always add up to a full pose
    // (below 1 in total, Babylon blends toward the rig's T-pose).
    const rest = 1 - actionFull;
    for (const [k, g] of this.loco) {
      const cur = this.locoW.get(k) ?? 0;
      const nw = cur + ((w[k] ?? 0) - cur) * (1 - Math.exp(-dt * 9));
      this.locoW.set(k, nw);
      const eff = nw * rest;
      // Never exactly 0: Babylon's multi-clip quaternion blend divides by the
      // sum of the first two weights, which turns 0/0 into NaN bones.
      g.weight = Math.max(MIN_W, eff);
      const gait = k !== 'idle' && k !== 'air';
      if (!gait) g.speedRatio = 1;
      else {
        const fps = g.targetedAnimations[0]?.animation.framePerSecond || 30;
        const dur = (g.to - g.from) / fps;
        g.speedRatio = cyclesPerSec * dur;
      }
      // A clip with no weight left is paused instead of being sampled and
      // blended at 0.0001 every frame (most of a character's animation cost).
      const live = eff > LIVE_W || (w[k] > 0 && rest > 0);
      if (!live && g.isPlaying) g.pause();
      else if (live && !g.isPlaying) this.resume(k, g, gait);
    }
  }

  /** Unpause a locomotion loop, back in step with the gaits still playing. */
  private resume(key: LocoKey, g: AnimationGroup, gait: boolean) {
    g.play(true);
    if (!gait) return;
    for (const [k, other] of this.loco) {
      if (k === key || k === 'idle' || k === 'air' || !other.isPlaying) continue;
      const f = other.animatables[0]?.masterFrame;
      if (f === undefined) break;
      const phase = (f - other.from) / Math.max(1e-3, other.to - other.from);
      g.goToFrame(g.from + (phase - Math.floor(phase)) * (g.to - g.from));
      break;
    }
  }

  dispose() {
    for (const g of this.groups.values()) g.dispose();
    for (const g of this.twins.values()) g.dispose();
  }

  /**
   * Steer a timed action's playback rate so the frame shown at the next
   * render is where the beat curve says it should be by then.
   */
  private steer(a: Action, dt: number) {
    const g = a.group;
    const want = g.from + evalBeats(a.beats!, a.t) * a.fps;
    const target = Math.min(g.to - 0.5, want);
    // until its first render the clip sits on its start frame
    const shown = a.startFrame ?? g.animatables[0]?.masterFrame ?? target;
    a.startFrame = null;
    if (dt <= 0) return;
    const rate = (target - shown) / a.fps / dt;
    g.speedRatio = Math.max(0, Math.min(12, rate));
  }
}

function applyEase(e: Ease, x: number) {
  switch (e) {
    case 'in':
      return x * x * x;
    case 'out': {
      const y = 1 - x;
      return 1 - y * y * y;
    }
    case 'inout':
      return x * x * (3 - 2 * x);
    default:
      return x;
  }
}

/** Clip seconds at game time `t` along a beat curve. */
export function evalBeats(beats: Beat[], t: number) {
  if (t <= beats[0][0]) return beats[0][1];
  for (let i = 1; i < beats.length; i++) {
    const [t1, c1, e] = beats[i];
    if (t <= t1) {
      const [t0, c0] = beats[i - 1];
      const x = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
      return c0 + (c1 - c0) * applyEase(e, x);
    }
  }
  return beats[beats.length - 1][1];
}

export function stripName(n: string) {
  // instantiateModelsToScene names clones "Clone of X" or "<prefix>X"
  return n.replace(/^Clone of /, '').replace(/^[a-z0-9]+\|/i, '');
}

function smooth(e0: number, e1: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Measure stride (model units per loop) of an in-place locomotion clip by sampling foot motion. */
export function measureStride(group: AnimationGroup, footL: TransformNode, footR: TransformNode, root: TransformNode): number {
  const n = 24;
  let minL = Infinity, maxL = -Infinity, minR = Infinity, maxR = -Infinity;
  const wasWeight = group.weight;
  group.start(true, 1, group.from, group.to, false);
  group.weight = 1;
  const inv = root.getWorldMatrix().clone().invert();
  for (let i = 0; i < n; i++) {
    group.goToFrame(group.from + ((group.to - group.from) * i) / n);
    footL.computeWorldMatrix(true);
    footR.computeWorldMatrix(true);
    const l = footL.getAbsolutePosition().clone();
    const r = footR.getAbsolutePosition().clone();
    const lz = l.x * inv.m[2] + l.y * inv.m[6] + l.z * inv.m[10] + inv.m[14];
    const rz = r.x * inv.m[2] + r.y * inv.m[6] + r.z * inv.m[10] + inv.m[14];
    minL = Math.min(minL, lz);
    maxL = Math.max(maxL, lz);
    minR = Math.min(minR, rz);
    maxR = Math.max(maxR, rz);
  }
  group.weight = Math.max(MIN_W, wasWeight);
  // Each foot sweeps (max-min) backwards while planted, once per loop, for each of two steps.
  return ((maxL - minL) + (maxR - minR));
}
