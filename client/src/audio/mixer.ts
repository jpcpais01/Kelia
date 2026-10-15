// The audio graph's trunk: one AudioContext, a master volume, and separate
// buses for ambience, music and (later) sound effects, each with its own
// player-facing volume. Browsers forbid sound before the player interacts, so
// the context is created on the first click or key press, and everything
// fades out and sleeps while the tab is hidden.

export type BusName = 'ambience' | 'music' | 'sfx';

export interface Volumes {
  masterVolume: number;
  musicVolume: number;
  ambienceVolume: number;
}

/** Sliders are linear; ears are not. */
const perceptual = (v: number) => Math.max(0, Math.min(1, v)) ** 2;

class Mixer {
  ctx: AudioContext | null = null;
  readonly bus = {} as Record<BusName, GainNode>;
  volumes: Volumes = { masterVolume: 0.8, musicVolume: 0.5, ambienceVolume: 0.8 };
  private master!: GainNode;
  private sleep!: GainNode;
  private armed = false;
  private readyCbs: ((ctx: AudioContext) => void)[] = [];
  private visCbs: ((hidden: boolean) => void)[] = [];
  private sleepTimer = 0;

  /** Start listening for the first gesture; audio begins on it. */
  arm(v: Volumes) {
    this.volumes = { masterVolume: v.masterVolume, musicVolume: v.musicVolume, ambienceVolume: v.ambienceVolume };
    if (this.armed) return;
    this.armed = true;
    const events = ['pointerdown', 'keydown', 'click', 'touchend'];
    const unlock = () => {
      this.start();
      if (this.ctx?.state === 'running') for (const ev of events) window.removeEventListener(ev, unlock, true);
    };
    for (const ev of events) window.addEventListener(ev, unlock, true);
  }

  /** Run once audio exists (right away if it already does). */
  onReady(cb: (ctx: AudioContext) => void) {
    if (this.ctx) cb(this.ctx);
    else this.readyCbs.push(cb);
  }

  /** Told when the tab hides or shows, after audio has started. */
  onVisibility(cb: (hidden: boolean) => void) {
    this.visCbs.push(cb);
  }

  get running() {
    return this.ctx?.state === 'running';
  }

  setVolumes(v: Volumes) {
    this.volumes = { masterVolume: v.masterVolume, musicVolume: v.musicVolume, ambienceVolume: v.ambienceVolume };
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(perceptual(v.masterVolume), t, 0.05);
    this.bus.music.gain.setTargetAtTime(perceptual(v.musicVolume), t, 0.05);
    this.bus.ambience.gain.setTargetAtTime(perceptual(v.ambienceVolume), t, 0.05);
  }

  private start() {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      let ctx: AudioContext;
      try {
        ctx = new AC();
      } catch {
        return;
      }
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.sleep = ctx.createGain();
      // a gentle safety limiter so many voices at once never clip
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 6;
      limiter.ratio.value = 8;
      limiter.attack.value = 0.005;
      limiter.release.value = 0.25;
      this.master.connect(this.sleep).connect(limiter).connect(ctx.destination);
      for (const b of ['ambience', 'music', 'sfx'] as BusName[]) {
        this.bus[b] = ctx.createGain();
        this.bus[b].connect(this.master);
      }
      this.master.gain.value = perceptual(this.volumes.masterVolume);
      this.bus.music.gain.value = perceptual(this.volumes.musicVolume);
      this.bus.ambience.gain.value = perceptual(this.volumes.ambienceVolume);
      document.addEventListener('visibilitychange', () => this.onVisibilityChange());
      const cbs = this.readyCbs;
      this.readyCbs = [];
      for (const cb of cbs) cb(ctx);
    }
    if (this.ctx.state === 'suspended' && !document.hidden) void this.ctx.resume();
  }

  private onVisibilityChange() {
    const ctx = this.ctx!;
    const hidden = document.hidden;
    const t = ctx.currentTime;
    clearTimeout(this.sleepTimer);
    this.sleep.gain.cancelScheduledValues(t);
    this.sleep.gain.setValueAtTime(this.sleep.gain.value, t);
    if (hidden) {
      this.sleep.gain.linearRampToValueAtTime(0, t + 0.4);
      this.sleepTimer = window.setTimeout(() => {
        if (document.hidden) void ctx.suspend();
      }, 500);
    } else {
      void ctx.resume();
      this.sleep.gain.linearRampToValueAtTime(1, t + 1.2);
    }
    for (const cb of this.visCbs) cb(hidden);
  }

  /**
   * Place the listener. Babylon is left-handed (+z forward) while Web Audio is
   * right-handed (-z forward), so z flips on the way in.
   */
  setListener(px: number, py: number, pz: number, fx: number, fy: number, fz: number, ux: number, uy: number, uz: number) {
    const l = this.ctx?.listener;
    if (!l) return;
    if (l.positionX) {
      l.positionX.value = px;
      l.positionY.value = py;
      l.positionZ.value = -pz;
      l.forwardX.value = fx;
      l.forwardY.value = fy;
      l.forwardZ.value = -fz;
      l.upX.value = ux;
      l.upY.value = uy;
      l.upZ.value = -uz;
    } else {
      l.setPosition(px, py, -pz);
      l.setOrientation(fx, fy, -fz, ux, uy, -uz);
    }
  }

  /** A positional source in world (Babylon) coordinates. */
  panner(ref: number, rolloff: number, hrtf: boolean): PannerNode {
    const p = this.ctx!.createPanner();
    p.panningModel = hrtf ? 'HRTF' : 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = rolloff;
    p.maxDistance = 10000;
    return p;
  }

  place(p: PannerNode, x: number, y: number, z: number) {
    if (p.positionX) {
      p.positionX.value = x;
      p.positionY.value = y;
      p.positionZ.value = -z;
    } else p.setPosition(x, y, -z);
  }
}

export const mixer = new Mixer();
