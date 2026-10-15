// Background music: one track that fades in, plays through, fades out before
// its end and comes back after a quiet pause, so it never starts or stops
// abruptly. It streams from a plain <audio> element (no 30 MB decode) routed
// into the music bus, and holds (fading out, then pausing) while the tab is
// hidden or the music volume is at zero.
import { mixer } from './mixer';

const TRACK = `${import.meta.env.BASE_URL}assets/audio/dawn-in-the-highlands.mp3`;
/** Seconds to fade in at the start of each play-through. */
const FADE_IN = 6;
/** Seconds before the track's end to begin fading out. */
const FADE_OUT = 8;
/** Seconds of silence (just the world) between play-throughs. */
const GAP = 25;
/** Fades when pausing for a hidden tab or a muted slider, and when coming back. */
const HOLD_FADE = 0.5;
const RESUME_FADE = 2.5;

export class Music {
  private el: HTMLAudioElement | null = null;
  private fade: GainNode | null = null;
  private state: 'idle' | 'playing' | 'gap' = 'idle';
  private fadingOut = false;
  private gapUntil = 0;
  private held = false;
  private pauseTimer = 0;

  constructor() {
    mixer.onReady((ctx) => this.attach(ctx));
    mixer.onVisibility(() => this.sync());
  }

  private attach(ctx: AudioContext) {
    const el = new Audio();
    el.src = TRACK;
    el.preload = 'auto';
    el.loop = false;
    this.el = el;
    this.fade = ctx.createGain();
    this.fade.gain.value = 0;
    ctx.createMediaElementSource(el).connect(this.fade).connect(mixer.bus.music);
    el.addEventListener('ended', () => {
      this.state = 'gap';
      this.gapUntil = performance.now() + GAP * 1000;
    });
    // the media clock drives the fade-out, so it lands on time whatever the frame rate
    el.addEventListener('timeupdate', () => this.checkEnd());
    // first play-through starts inside the unlocking gesture (Safari insists)
    if (this.wanted()) this.begin();
    else this.held = true;
  }

  private wanted() {
    return mixer.volumes.musicVolume > 0.001 && !document.hidden;
  }

  private ramp(to: number, seconds: number) {
    const ctx = mixer.ctx;
    if (!ctx || !this.fade) return;
    const g = this.fade.gain;
    const t = ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(to, t + seconds);
  }

  private begin() {
    const el = this.el!;
    el.currentTime = 0;
    this.state = 'playing';
    this.fadingOut = false;
    this.ramp(0, 0.01);
    void el.play().catch(() => {});
    this.ramp(1, FADE_IN);
  }

  /** Hold or release for tab visibility and the music volume. */
  private sync() {
    const el = this.el;
    if (!el) return;
    const want = this.wanted();
    if (!want && !this.held) {
      this.held = true;
      this.ramp(0, HOLD_FADE);
      clearTimeout(this.pauseTimer);
      this.pauseTimer = window.setTimeout(() => {
        if (this.held) el.pause();
      }, HOLD_FADE * 1000 + 50);
    } else if (want && this.held) {
      this.held = false;
      clearTimeout(this.pauseTimer);
      if (this.state === 'idle') this.begin();
      else if (this.state === 'playing' && !this.fadingOut) {
        void el.play().catch(() => {});
        this.ramp(1, RESUME_FADE);
      } else if (this.state === 'playing') void el.play().catch(() => {});
    }
  }

  private checkEnd() {
    const el = this.el!;
    if (this.held || this.state !== 'playing' || this.fadingOut || !Number.isFinite(el.duration) || el.duration < FADE_OUT * 2) return;
    const left = el.duration - el.currentTime;
    if (left < FADE_OUT) {
      this.fadingOut = true;
      this.ramp(0, Math.max(0.5, left - 0.3));
    }
  }

  update() {
    if (!this.el) return;
    this.sync();
    if (this.held) {
      // coming back from a hold leaves at least a second of quiet before the track restarts
      if (this.state === 'gap') this.gapUntil = Math.max(this.gapUntil, performance.now() + 1000);
      return;
    }
    if (this.state === 'gap' && performance.now() >= this.gapUntil) this.begin();
  }
}
