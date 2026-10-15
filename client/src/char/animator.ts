// Weight-blended animation for KayKit rigs.
//
// Locomotion clips (idle / walk / run / sprint / back / strafe) all play at
// once with weights from the current velocity. Their playback rates are tied
// to the distance actually travelled (cycles per second = speed / stride), and
// they are started together, so the feet stay phase-locked and never slide.
// One-shot actions (attacks, casts, dodges, hits) fade in on top: full-body
// when standing still, upper-body only while moving (weighted over the legs' clips).
import { AnimationGroupMask, AnimationGroupMaskMode, type AnimationGroup, type TransformNode } from '@babylonjs/core';

const MIN_W = 1e-4;

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
}

export class Animator {
  private groups = new Map<string, AnimationGroup>();
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
    const k = 1 - Math.exp(-dt * 10);
    this.speed += (sp - this.speed) * k;
    if (sp > 0.05) {
      this.dirX += (localX / sp - this.dirX) * k;
      this.dirZ += (localZ / sp - this.dirZ) * k;
    }
  }

  play(name: string, o: PlayOptions = {}): number {
    const g = this.groups.get(name);
    if (!g) return 0;
    if (this.action) this.retire(this.action);
    const speed = o.speed ?? 1;
    const fps = g.targetedAnimations[0]?.animation.framePerSecond || 30;
    const duration = (g.to - g.from) / fps / speed;
    const upper = o.upper ?? this.speed > 0.6;
    g.stop();
    g.mask = upper ? new AnimationGroupMask(UPPER_BODY, AnimationGroupMaskMode.Include) : null;
    g.weight = MIN_W;
    // holds loop internally so the group can't end (and drop its pose) before we freeze it
    g.start(!!o.loop || !!o.hold, speed, g.from, g.to, false);
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
    };
    return duration;
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

  private retire(a: Action) {
    a.hold = false;
    a.loop = false;
    a.t = Math.max(a.t, a.duration); // fade from now
    a.duration = a.t;
    this.fading.push(a);
  }

  update(dt: number) {
    // --- action weights ---
    let actionFull = 0; // how much a full-body action overrides locomotion
    // moving cancels looping emotes (sitting, dancing)
    if (this.action && (this.action.loop || this.action.hold) && this.speed > 1.2) this.stopAction();
    const a = this.action;
    if (a) {
      a.t += dt;
      if (!a.loop && !a.hold && a.t >= a.duration) {
        this.action = null;
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
        if (!a.upper) actionFull = a.weight;
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
        if (!f.upper) actionFull = Math.max(actionFull, f.weight);
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
    let wSum = 0;
    for (const k of ['walk', 'run', 'sprint', 'back', 'left', 'right'] as LocoKey[]) {
      if (w[k] > 0) {
        strideSum += (this.strides.get(k) ?? 2) * this.scale * w[k];
        wSum += w[k];
      }
    }
    const stride = wSum > 0 ? strideSum / wSum : 2;
    const cyclesPerSec = Math.max(0.35, s / stride);
    for (const [k, g] of this.loco) {
      const target = (w[k] ?? 0) * (1 - actionFull);
      const cur = this.locoW.get(k) ?? 0;
      const nw = cur + (target - cur) * (1 - Math.exp(-dt * 14));
      this.locoW.set(k, nw);
      // Never exactly 0: Babylon's multi-clip quaternion blend divides by the
      // sum of the first two weights, which turns 0/0 into NaN bones.
      g.weight = Math.max(MIN_W, nw);
      if (k === 'idle' || k === 'air') g.speedRatio = 1;
      else {
        const fps = g.targetedAnimations[0]?.animation.framePerSecond || 30;
        const dur = (g.to - g.from) / fps;
        g.speedRatio = cyclesPerSec * dur;
      }
    }
  }

  dispose() {
    for (const g of this.groups.values()) g.dispose();
  }
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
