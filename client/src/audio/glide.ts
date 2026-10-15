// Glider sounds, all synthesized from one loop of noise: the rush of air
// (louder and brighter with speed, a roar in a dive), the deep buffeting of
// the wind on the body, the canvas fluttering, the rising whoosh of an
// updraft, a soft "fwump" as the canopy fills and a swish as it folds.
import { mixer } from './mixer';

export interface GlideSoundState {
  gliding: boolean;
  /** Airspeed, m/s. */
  speed: number;
  diving: boolean;
  /** 0..1 updraft lift. */
  lift: number;
}

export class GlideAudio {
  private ctx: AudioContext | null = null;
  private noise!: AudioBuffer;
  private out!: GainNode;
  private rushF!: BiquadFilterNode;
  private rushG!: GainNode;
  private lowG!: GainNode;
  private lowAm!: GainNode;
  private flutG!: GainNode;
  private flutLfo!: OscillatorNode;
  private liftF!: BiquadFilterNode;
  private liftG!: GainNode;
  private t = 0;
  private active = false;

  constructor() {
    mixer.onReady((ctx) => this.init(ctx));
  }

  private init(ctx: AudioContext) {
    this.ctx = ctx;
    const n = ctx.sampleRate * 3;
    this.noise = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = this.noise.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    this.out = ctx.createGain();
    this.out.connect(mixer.bus.sfx);
    const src = (offset: number) => {
      const s = ctx.createBufferSource();
      s.buffer = this.noise;
      s.loop = true;
      s.start(0, offset);
      return s;
    };
    const filter = (type: BiquadFilterType, f: number, q = 0.707) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    const gain = (v = 0) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };
    // rushing air
    this.rushF = filter('bandpass', 600, 0.6);
    this.rushG = gain();
    src(0).connect(this.rushF).connect(this.rushG).connect(this.out);
    // the low buffet, swelling and easing like gusts
    this.lowAm = gain(1);
    this.lowG = gain();
    src(1.1).connect(filter('lowpass', 200)).connect(this.lowAm).connect(this.lowG).connect(this.out);
    // canvas flutter: a narrow band chopped by a fast wobble
    const flutAm = gain(0.5);
    this.flutLfo = ctx.createOscillator();
    this.flutLfo.frequency.value = 11;
    const depth = gain(0.5);
    this.flutLfo.connect(depth).connect(flutAm.gain);
    this.flutLfo.start();
    this.flutG = gain();
    src(2.2).connect(filter('highpass', 1200)).connect(filter('lowpass', 3200)).connect(flutAm).connect(this.flutG).connect(this.out);
    // updraft whoosh
    this.liftF = filter('bandpass', 350, 1.4);
    this.liftG = gain();
    src(0.6).connect(this.liftF).connect(this.liftG).connect(this.out);
  }

  update(dt: number, s: GlideSoundState) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    this.t += dt;
    const on = s.gliding ? 1 : 0;
    if (!on && !this.active) return;
    this.active = on > 0;
    const t = ctx.currentTime;
    const sp = Math.max(0, Math.min(1, s.speed / 10));
    const dive = s.diving ? 1 : 0;
    const gust = 0.75 + 0.25 * Math.sin(this.t * 0.9) * Math.sin(this.t * 0.37 + 1);
    const tc = on ? 0.18 : 0.12;
    this.rushG.gain.setTargetAtTime(on * (0.05 + 0.12 * sp + 0.16 * dive) * gust, t, tc);
    this.rushF.frequency.setTargetAtTime(450 + 800 * sp + 1100 * dive, t, 0.25);
    this.lowG.gain.setTargetAtTime(on * (0.22 + 0.25 * dive), t, tc);
    this.lowAm.gain.setTargetAtTime(gust, t, 0.3);
    this.flutG.gain.setTargetAtTime(on * (0.012 + 0.03 * sp + 0.02 * dive), t, tc);
    this.flutLfo.frequency.setTargetAtTime(8 + 9 * sp + 6 * dive, t, 0.3);
    this.liftG.gain.setTargetAtTime(on * s.lift * 0.14, t, 0.3);
    this.liftF.frequency.setTargetAtTime(280 + 520 * s.lift + 60 * Math.sin(this.t * 1.7), t, 0.3);
  }

  /** The canopy filling: a deep cloth "fwump" and the snap of the frame. */
  open() {
    this.burst('lowpass', 1400, 160, 0.4, 0.012, 0.42, 0.9);
    this.burst('highpass', 2600, 2600, 0.12, 0.004, 0.06, 0.7);
  }

  /** Folding away: a quick swish. */
  fold() {
    this.burst('bandpass', 2200, 600, 0.16, 0.02, 0.24, 1.2);
  }

  /** A filtered noise burst whose cutoff sweeps from f0 to f1. */
  private burst(type: BiquadFilterType, f0: number, f1: number, peak: number, attack: number, decay: number, q: number) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + attack + decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.001, t + attack + decay);
    s.connect(f).connect(g).connect(this.out);
    s.start(t, Math.random() * 2);
    s.stop(t + attack + decay + 0.05);
  }
}
