// Procedural sound synthesis for Kelia's ambience. Every sound in the valley
// (birdsong, crickets, owls, frogs, rustling leaves, babbling water, the
// smithy's anvil, the chapel bell) is rendered here into plain sample arrays
// from a seed: no recordings, no downloads. Pure maths with no DOM access, so
// it runs anywhere and the same seed always gives the same sound.

export type Rng = () => number;

const TAU = Math.PI * 2;

/** Seeded PRNG (mulberry32). */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = (r: Rng, a: number, b: number) => a + (b - a) * r();
const randInt = (r: Rng, a: number, b: number) => Math.floor(rand(r, a, b + 1));
const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Mono or multichannel sample data at a sample rate. */
export interface Sound {
  sr: number;
  channels: Float32Array[];
}

const mono = (data: Float32Array, sr: number): Sound => ({ sr, channels: [data] });

// ------------------------------------------------------------------ filters

/** RBJ biquad, for offline rendering. */
class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(type: 'lowpass' | 'highpass' | 'bandpass', sr: number, f: number, q = 0.707) {
    const w = (TAU * Math.min(f, sr * 0.45)) / sr;
    const cs = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    let b0: number, b1: number, b2: number;
    if (type === 'lowpass') {
      b0 = (1 - cs) / 2;
      b1 = 1 - cs;
      b2 = b0;
    } else if (type === 'highpass') {
      b0 = (1 + cs) / 2;
      b1 = -(1 + cs);
      b2 = b0;
    } else {
      b0 = al;
      b1 = 0;
      b2 = -al;
    }
    const a0 = 1 + al;
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = (-2 * cs) / a0;
    this.a2 = (1 - al) / a0;
  }

  run(x: number) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

// ------------------------------------------------------------------ helpers

function normalize(a: Float32Array, peak = 0.9) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]));
  if (m > 0) {
    const k = peak / m;
    for (let i = 0; i < a.length; i++) a[i] *= k;
  }
  return a;
}

function normalizeAll(chs: Float32Array[], peak = 0.9) {
  let m = 0;
  for (const a of chs) for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]));
  if (m > 0) for (const a of chs) for (let i = 0; i < a.length; i++) a[i] *= peak / m;
}

/** Turn a buffer rendered `xf` samples too long into a seamless loop by crossfading its tail into its head. */
function seamless(a: Float32Array, xf: number): Float32Array {
  const n = a.length - xf;
  const out = a.slice(0, n);
  for (let i = 0; i < xf; i++) {
    const t = i / xf;
    out[i] = a[i] * Math.sin((t * Math.PI) / 2) + a[n + i] * Math.cos((t * Math.PI) / 2);
  }
  return out;
}

/** Filter a loop seamlessly: run it once to settle the filter state, then again for real. */
function filterLoop(a: Float32Array, ...fs: Biquad[]) {
  for (let pass = 0; pass < 2; pass++)
    for (let i = 0; i < a.length; i++) {
      let x = a[i];
      for (const f of fs) x = f.run(x);
      if (pass) a[i] = x;
    }
  return a;
}

/** Fade out the last `sec` seconds of a one-shot so it never ends on a click. */
function tailFade(a: Float32Array, sr: number, sec = 0.05) {
  const n = Math.min(a.length, Math.floor(sec * sr));
  for (let i = 0; i < n; i++) a[a.length - 1 - i] *= i / n;
  return a;
}

/** Pink noise (Paul Kellet's refined filter). */
function pink(r: Rng, n: number): Float32Array {
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return out;
}

/** Brown (red) noise: leaky integrated white noise, deep and rumbling. */
function brown(r: Rng, n: number): Float32Array {
  const out = new Float32Array(n);
  let v = 0;
  for (let i = 0; i < n; i++) {
    v = (v + (r() * 2 - 1) * 0.02) * 0.998;
    out[i] = v * 3.5;
  }
  return out;
}

// ------------------------------------------------------------------ tonal notes

/** One tonal note: a pitch path through key frequencies, harmonics, vibrato and an envelope. */
export interface Note {
  t: number;
  d: number;
  /** Frequencies (Hz) the pitch glides through over the note, interpolated in log space. */
  fp: number[];
  a?: number;
  h2?: number;
  h3?: number;
  /** Vibrato depth (fraction of pitch) and rate (Hz). */
  vib?: number;
  vibHz?: number;
  /** Tremolo / rasp depth (0..1) and rate (Hz). */
  trem?: number;
  tremHz?: number;
  /** Attack and release as fractions of the note. */
  atk?: number;
  rel?: number;
}

function renderNotes(notes: Note[], sr: number, pad = 0.08): Float32Array {
  let end = 0;
  for (const n of notes) end = Math.max(end, n.t + n.d);
  const out = new Float32Array(Math.ceil((end + pad) * sr));
  for (const n of notes) addNote(out, sr, n);
  return out;
}

function addNote(out: Float32Array, sr: number, n: Note) {
  const N = Math.floor(n.d * sr);
  const s0 = Math.floor(n.t * sr);
  const lf = n.fp.map(Math.log);
  const segs = lf.length - 1;
  const atk = n.atk ?? 0.12;
  const rel = n.rel ?? 0.3;
  const a = n.a ?? 1;
  const h2 = n.h2 ?? 0;
  const h3 = n.h3 ?? 0;
  const vib = n.vib ?? 0;
  const vibW = (TAU * (n.vibHz ?? 0)) / sr;
  const trem = n.trem ?? 0;
  const tremW = (TAU * (n.tremHz ?? 0)) / sr;
  let ph = 0;
  for (let i = 0; i < N && s0 + i < out.length; i++) {
    const u = i / N;
    let f: number;
    if (segs <= 0) f = n.fp[0];
    else {
      const x = u * segs;
      const k = Math.min(segs - 1, Math.floor(x));
      const t = x - k;
      // smooth glide between key frequencies
      const e = t * t * (3 - 2 * t);
      f = Math.exp(lf[k] + (lf[k + 1] - lf[k]) * e);
    }
    if (vib) f *= 1 + vib * Math.sin(vibW * i);
    ph += (TAU * f) / sr;
    const env = smooth(0, atk, u) * smooth(1, 1 - rel, u);
    let s = Math.sin(ph);
    if (h2) s += h2 * Math.sin(2 * ph);
    if (h3) s += h3 * Math.sin(3 * ph);
    if (trem) s *= 1 - trem * (0.5 + 0.5 * Math.sin(tremW * i));
    out[s0 + i] += a * env * s;
  }
}

/** Damped sinusoid (a struck or knocked resonance), added in place; wraps around if `wrap`. */
function addRing(out: Float32Array, sr: number, t: number, f: number, amp: number, decay: number, wrap = false, beat = 0) {
  const s0 = Math.floor(t * sr);
  const N = Math.min(Math.floor(decay * 7 * sr), wrap ? out.length : out.length - s0);
  const w = (TAU * f) / sr;
  const wb = (TAU * beat) / sr;
  const k = Math.exp(-1 / (decay * sr));
  let e = amp;
  const atk = Math.max(1, Math.floor(sr * 0.0015));
  for (let i = 0; i < N; i++) {
    let j = s0 + i;
    if (j >= out.length) {
      if (!wrap) break;
      j %= out.length;
    }
    const a = i < atk ? i / atk : 1;
    out[j] += e * a * Math.sin(w * i) * (beat ? 0.75 + 0.25 * Math.cos(wb * i) : 1);
    e *= k;
  }
}

/** A short burst of filtered noise (a click, a knock's transient, a grain). */
function addNoiseBurst(out: Float32Array, sr: number, r: Rng, t: number, dur: number, amp: number, filter: Biquad | null, shape: 'hann' | 'decay' = 'hann', wrap = false) {
  const s0 = Math.floor(t * sr);
  const N = Math.max(2, Math.floor(dur * sr));
  for (let i = 0; i < N; i++) {
    let j = s0 + i;
    if (j >= out.length) {
      if (!wrap) break;
      j %= out.length;
    }
    const u = i / N;
    const env = shape === 'hann' ? 0.5 - 0.5 * Math.cos(TAU * u) : Math.exp(-u * 6) * Math.min(1, i / 8);
    let x = r() * 2 - 1;
    if (filter) x = filter.run(x);
    out[j] += x * env * amp;
  }
}

// ------------------------------------------------------------------ birds by day

/** A warbler's tumbling song: quick sweeping notes, a repeated motif and a closing trill. */
export function warbler(r: Rng, sr: number): Sound {
  const notes: Note[] = [];
  const base = rand(r, 3300, 4700);
  let t = 0.02;
  for (let i = randInt(r, 1, 3); i > 0; i--) {
    const d = rand(r, 0.05, 0.08);
    notes.push({ t, d, fp: [base * rand(r, 1.1, 1.35), base * rand(r, 0.75, 0.9)], a: 0.55, h2: 0.05 });
    t += d + rand(r, 0.06, 0.11);
  }
  const motif = Array.from({ length: randInt(r, 2, 3) }, () => [base * rand(r, 0.7, 1.45), base * rand(r, 0.7, 1.45), base * rand(r, 0.8, 1.3)].slice(0, randInt(r, 2, 3)));
  const reps = randInt(r, 3, 5);
  for (let k = 0; k < reps; k++) {
    for (const fp of motif) {
      const d = rand(r, 0.028, 0.05);
      notes.push({ t, d, fp, a: 0.7 + 0.3 * (k / reps), h2: 0.06, atk: 0.1, rel: 0.25 });
      t += d + rand(r, 0.01, 0.022);
    }
    t += rand(r, 0.01, 0.04);
  }
  const tf = base * rand(r, 1.05, 1.5);
  const n = randInt(r, 6, 12);
  for (let k = 0; k < n; k++) {
    notes.push({ t, d: 0.022, fp: [tf * 1.1, tf * 0.8], a: 0.9 - (0.4 * k) / n, h2: 0.04, atk: 0.15, rel: 0.4 });
    t += 0.031 + rand(r, -0.003, 0.003);
  }
  return mono(normalize(renderNotes(notes, sr)), sr);
}

/** A song thrush: clear whistled phrases, each repeated two or three times. */
export function thrush(r: Rng, sr: number): Sound {
  const notes: Note[] = [];
  let t = 0.02;
  const phrase = () => {
    const out: Omit<Note, 't'>[] = [];
    for (let i = randInt(r, 2, 4); i > 0; i--) {
      const f = rand(r, 1900, 4200);
      const kind = r();
      if (kind < 0.5) out.push({ d: rand(r, 0.1, 0.22), fp: [f, f * rand(r, 0.88, 1.18)], vib: 0.012, vibHz: 28, h2: 0.08, atk: 0.15, rel: 0.35 });
      else if (kind < 0.8) out.push({ d: rand(r, 0.03, 0.05), fp: [f * 1.35, f * 0.75], h2: 0.05, atk: 0.1, rel: 0.3 });
      else out.push({ d: rand(r, 0.09, 0.14), fp: [f * 0.9, f], trem: 0.7, tremHz: rand(r, 70, 110), h2: 0.15 });
    }
    return out;
  };
  for (let p = randInt(r, 2, 3); p > 0; p--) {
    const ph = phrase();
    for (let rep = randInt(r, 2, 3); rep > 0; rep--) {
      for (const n of ph) {
        notes.push({ ...n, t, a: rand(r, 0.75, 1) });
        t += n.d + rand(r, 0.05, 0.09);
      }
      t += rand(r, 0.18, 0.3);
    }
    t += rand(r, 0.2, 0.4);
  }
  return mono(normalize(renderNotes(notes, sr)), sr);
}

/** A great tit's "tea-cher, tea-cher, tea-cher". */
export function tit(r: Rng, sr: number): Sound {
  const notes: Note[] = [];
  const hi = rand(r, 4700, 5600);
  const lo = hi * rand(r, 0.66, 0.78);
  const period = rand(r, 0.28, 0.36);
  const reps = randInt(r, 3, 6);
  for (let k = 0; k < reps; k++) {
    const t = 0.02 + k * period;
    const a = k === 0 ? 0.8 : 1;
    notes.push({ t, d: 0.075, fp: [hi * 1.04, hi * 0.96], a, h2: 0.05, atk: 0.15, rel: 0.3 });
    notes.push({ t: t + 0.11, d: 0.1, fp: [lo * 1.02, lo * 0.95], a: a * 0.9, h2: 0.06, atk: 0.12, rel: 0.4 });
  }
  return mono(normalize(renderNotes(notes, sr)), sr);
}

/** A wood pigeon's soft five-note coo. */
export function dove(r: Rng, sr: number): Sound {
  const base = rand(r, 440, 520);
  const pattern: [number, number, number][] = [
    [0.32, 0.6, 0.0],
    [0.55, 1.0, 0.12],
    [0.28, 0.75, 0.12],
    [0.4, 0.7, 0.32],
    [0.26, 0.55, 0.1],
  ];
  const notes: Note[] = [];
  let t = 0.03;
  for (const [d, a, gap] of pattern) {
    t += gap;
    notes.push({ t, d, fp: [base * 0.9, base * 1.07, base * 0.96], a, h2: 0.32, h3: 0.08, atk: 0.35, rel: 0.45 });
    t += d;
  }
  return mono(normalize(renderNotes(notes, sr, 0.2)), sr);
}

/** The cuckoo's falling third, called across the wood. */
export function cuckoo(r: Rng, sr: number): Sound {
  const hi = rand(r, 640, 720);
  const lo = hi * 0.8;
  const notes: Note[] = [];
  for (let k = randInt(r, 2, 4) - 1; k >= 0; k--) {
    const t = 0.02 + notes.length * 0.38;
    notes.push({ t, d: 0.17, fp: [hi * 1.02, hi * 0.98], h2: 0.12, atk: 0.2, rel: 0.5 });
    notes.push({ t: t + 0.25, d: 0.3, fp: [lo, lo * 0.97], h2: 0.12, atk: 0.15, rel: 0.6 });
  }
  return mono(normalize(renderNotes(notes, sr, 0.25)), sr);
}

/** A skylark pouring out its endless warble from high above the meadow. */
export function skylark(r: Rng, sr: number): Sound {
  const notes: Note[] = [];
  const len = rand(r, 5, 8);
  let t = 0.05;
  while (t < len) {
    const kind = r();
    if (kind < 0.55) {
      const d = rand(r, 0.025, 0.07);
      notes.push({ t, d, fp: [rand(r, 2400, 6500), rand(r, 2400, 6500), rand(r, 2800, 6000)].slice(0, randInt(r, 2, 3)), a: rand(r, 0.5, 1), h2: 0.05, atk: 0.1, rel: 0.25 });
      t += d + rand(r, 0.006, 0.03);
    } else if (kind < 0.8) {
      const fp = [rand(r, 3500, 6000), rand(r, 2500, 4500)];
      const n = randInt(r, 4, 9);
      for (let k = 0; k < n; k++) {
        notes.push({ t, d: 0.018, fp, a: rand(r, 0.6, 0.9), atk: 0.2, rel: 0.4 });
        t += 0.026;
      }
      t += rand(r, 0.01, 0.04);
    } else {
      const f = rand(r, 3000, 5200);
      const d = rand(r, 0.09, 0.18);
      notes.push({ t, d, fp: [f, f * rand(r, 0.95, 1.08)], vib: 0.025, vibHz: rand(r, 20, 34), a: rand(r, 0.6, 0.9), h2: 0.05 });
      t += d + rand(r, 0.01, 0.03);
    }
  }
  const out = renderNotes(notes, sr);
  // swell in and out like a bird rising and drifting
  for (let i = 0; i < out.length; i++) {
    const u = i / out.length;
    out[i] *= smooth(0, 0.08, u) * smooth(1, 0.85, u) * (0.75 + 0.25 * Math.sin(u * 9 + 1));
  }
  return mono(normalize(out), sr);
}

/** A woodpecker drumming a dead branch: a fast roll of woody knocks. */
export function woodpecker(r: Rng, sr: number): Sound {
  const count = randInt(r, 14, 24);
  let rate = rand(r, 14, 18);
  const f = rand(r, 850, 1150);
  const out = new Float32Array(Math.ceil((count / rate + 0.3) * sr));
  let t = 0.02;
  for (let k = 0; k < count; k++) {
    const a = (1 - 0.55 * (k / count)) * rand(r, 0.85, 1);
    addRing(out, sr, t, f * rand(r, 0.98, 1.02), a, 0.016);
    addRing(out, sr, t, f * 1.93, a * 0.5, 0.01);
    addRing(out, sr, t, f * 3.1, a * 0.3, 0.006);
    addNoiseBurst(out, sr, r, t, 0.0025, a * 0.8, new Biquad('highpass', sr, 1500), 'decay');
    t += 1 / rate;
    rate *= 1.008;
  }
  return mono(normalize(out), sr);
}

/** A hawk's piercing "kee-eeer" over the crags. */
export function hawk(r: Rng, sr: number): Sound {
  const notes: Note[] = [];
  let t = 0.02;
  for (let k = randInt(r, 1, 3); k > 0; k--) {
    const d = rand(r, 0.7, 1.1);
    const f = rand(r, 2500, 3000);
    notes.push({ t, d, fp: [f * 0.92, f * 1.22, f * 1.12, f * 0.8], h2: 0.45, h3: 0.22, trem: 0.4, tremHz: rand(r, 48, 62), atk: 0.06, rel: 0.5 });
    t += d + rand(r, 0.25, 0.5);
  }
  return mono(normalize(renderNotes(notes, sr, 0.15)), sr);
}

// ------------------------------------------------------------------ night

/** A tawny owl: a long hoot, a pause, then the quavering "hu-hoooo". */
export function owl(r: Rng, sr: number): Sound {
  const notes: Note[] = [];
  const f = rand(r, 360, 440);
  const style = r();
  let t = 0.03;
  if (style < 0.75) {
    notes.push({ t, d: 0.45, fp: [f, f * 1.05, f * 0.97], h2: 0.12, atk: 0.2, rel: 0.5 });
    t += 0.45 + rand(r, 1.6, 2.6);
  }
  notes.push({ t, d: 0.14, fp: [f * 0.92, f * 0.98], h2: 0.1, a: 0.7, atk: 0.2, rel: 0.4 });
  t += 0.42;
  notes.push({ t, d: rand(r, 1.1, 1.5), fp: [f, f * 1.04, f, f * 0.93], h2: 0.12, trem: 0.55, tremHz: rand(r, 13, 19), atk: 0.08, rel: 0.35 });
  return mono(normalize(renderNotes(notes, sr, 0.2)), sr);
}

/** One field cricket chirping steadily for a few seconds. */
export function cricket(r: Rng, sr: number): Sound {
  const f = rand(r, 4300, 5000);
  const period = rand(r, 0.36, 0.55);
  const pulses = randInt(r, 3, 4);
  const notes: Note[] = [];
  for (let t = 0.02; t < 3; t += period * rand(r, 0.97, 1.03)) {
    for (let p = 0; p < pulses; p++) notes.push({ t: t + p * 0.021, d: 0.014, fp: [f, f * 0.985], h2: 0.08, a: p === 0 ? 0.75 : 1, atk: 0.2, rel: 0.4 });
  }
  return mono(normalize(renderNotes(notes, sr)), sr);
}

/** A frog's double "rib-bit" croaks at the water's edge. */
export function frog(r: Rng, sr: number): Sound {
  const f1 = rand(r, 480, 700);
  const rate = rand(r, 45, 70);
  const croaks = randInt(r, 2, 4);
  const out = new Float32Array(Math.ceil((croaks * 0.7 + 0.4) * sr));
  let t = 0.02;
  for (let c = 0; c < croaks; c++) {
    for (let part = 0; part < 2; part++) {
      const n = randInt(r, 4, 8);
      const pitch = part ? 1.12 : 1;
      for (let k = 0; k < n; k++) {
        const a = Math.sin(Math.PI * ((k + 0.5) / n)) * (part ? 0.85 : 1);
        addRing(out, sr, t + k / rate, f1 * pitch, a, 0.006);
        addRing(out, sr, t + k / rate, f1 * pitch * 2.3, a * 0.45, 0.004);
        addRing(out, sr, t + k / rate, f1 * pitch * 0.5, a * 0.35, 0.008);
      }
      t += n / rate + rand(r, 0.08, 0.14);
    }
    t += rand(r, 0.2, 0.45);
  }
  return mono(normalize(out), sr);
}

// ------------------------------------------------------------------ village

/** A smith's hammer ringing on the anvil: a short rhythmic bout. */
export function anvil(r: Rng, sr: number): Sound {
  const f0 = rand(r, 950, 1150);
  const strikes = randInt(r, 3, 6);
  const gap = rand(r, 0.42, 0.6);
  const out = new Float32Array(Math.ceil((strikes * gap + 1.6) * sr));
  const ratios = [1, 2.76, 5.4, 8.93, 13.34];
  const amps = [1, 0.55, 0.35, 0.18, 0.1];
  const decays = [0.9, 0.6, 0.35, 0.2, 0.12];
  let t = 0.02;
  for (let k = 0; k < strikes; k++) {
    // a light tap on the anvil between some blows
    const light = k > 0 && r() < 0.25;
    const a = light ? 0.35 : rand(r, 0.8, 1);
    const ff = f0 * rand(r, 0.992, 1.008);
    for (let p = 0; p < ratios.length; p++) addRing(out, sr, t, ff * ratios[p], a * amps[p], decays[p] * (light ? 0.5 : 1));
    addNoiseBurst(out, sr, r, t, 0.004, a * 1.2, new Biquad('highpass', sr, 2500), 'decay');
    t += light ? gap * 0.5 : gap * rand(r, 0.95, 1.05);
  }
  return mono(tailFade(normalize(out), sr, 0.3), sr);
}

/** One toll of the chapel bell: a hum note under bright beating partials. */
export function bell(r: Rng, sr: number, f = 262): Sound {
  const out = new Float32Array(Math.ceil(10 * sr));
  const parts: [number, number, number][] = [
    [0.5, 0.5, 4.5],
    [1, 0.6, 3.2],
    [1.2, 0.42, 2.6],
    [1.5, 0.28, 2.0],
    [2, 0.6, 2.2],
    [2.5, 0.22, 1.2],
    [3, 0.2, 1.0],
    [4.2, 0.12, 0.6],
    [5.4, 0.07, 0.35],
  ];
  for (const [ratio, a, decay] of parts) addRing(out, sr, 0.01, f * ratio * rand(r, 0.999, 1.001), a, decay, false, rand(r, 0.6, 2.2));
  addNoiseBurst(out, sr, r, 0.01, 0.01, 0.35, new Biquad('bandpass', sr, 3000, 0.8), 'decay');
  return mono(tailFade(normalize(out, 0.85), sr, 2), sr);
}

/** Wind chimes stirred by a gust: a few pentatonic tinkles. */
export function chimes(r: Rng, sr: number): Sound {
  const scale = [1046.5, 1174.7, 1318.5, 1568, 1760, 2093, 2349.3];
  const n = randInt(r, 3, 7);
  const out = new Float32Array(Math.ceil((n * 0.45 + 2.5) * sr));
  let t = 0.02;
  for (let k = 0; k < n; k++) {
    const f = scale[Math.floor(r() * scale.length)];
    const a = rand(r, 0.4, 1);
    addRing(out, sr, t, f, a, rand(r, 0.5, 0.8));
    addRing(out, sr, t, f * 2.76, a * 0.25, 0.25);
    addRing(out, sr, t, f * 5.4, a * 0.08, 0.12);
    t += rand(r, 0.07, 0.45);
  }
  return mono(tailFade(normalize(out, 0.8), sr, 0.3), sr);
}

/** The windmill's wooden groan: stick-slip pulses exciting the timber. */
export function creak(r: Rng, sr: number): Sound {
  const dur = rand(r, 0.6, 1.2);
  const out = new Float32Array(Math.ceil((dur + 0.15) * sr));
  const fp = [rand(r, 50, 80), rand(r, 110, 160), rand(r, 70, 100)];
  const res = [rand(r, 280, 360), rand(r, 700, 850), rand(r, 1400, 1700)];
  let t = 0.02;
  while (t < dur) {
    const u = t / dur;
    const x = u * 2;
    const k = Math.min(1, Math.floor(x));
    const rate = fp[k] + (fp[k + 1] - fp[k]) * (x - k);
    const a = Math.pow(Math.sin(Math.PI * u), 0.7) * rand(r, 0.6, 1);
    addRing(out, sr, t, res[0], a, 0.012);
    addRing(out, sr, t, res[1], a * 0.5, 0.008);
    addRing(out, sr, t, res[2], a * 0.2, 0.004);
    t += (1 / rate) * rand(r, 0.9, 1.1);
  }
  return mono(normalize(out, 0.8), sr);
}

// ------------------------------------------------------------------ loops & beds

/** Rustling leaves: thousands of tiny filtered noise grains, written around a loop so it repeats seamlessly. */
function rustleInto(out: Float32Array, sr: number, r: Rng, density: number, bright: number, from = 0, to = out.length / sr, wrap = true) {
  let t = from;
  const swellPh = r() * TAU;
  while (t < to) {
    const u = (t - from) / Math.max(0.001, to - from);
    // gusts thicken and thin the grains
    const swell = 0.55 + 0.45 * Math.sin(u * TAU * 2 + swellPh) * Math.sin(u * TAU * 3.3);
    const d = rand(r, 0.006, 0.05);
    const f = rand(r, 1400, 6500) * bright;
    const a = Math.pow(r(), 2) * (0.4 + 0.6 * swell);
    addNoiseBurst(out, sr, r, t, d, a, new Biquad('bandpass', sr, f, rand(r, 0.8, 2.5)), 'hann', wrap);
    t += -Math.log(1 - r() * 0.999) / (density * (0.5 + swell));
  }
}

export function rustleLoop(r: Rng, sr: number, seconds = 10): Sound {
  const chs = [0, 1].map(() => {
    const a = new Float32Array(Math.floor(seconds * sr));
    rustleInto(a, sr, r, 170, 1);
    return a;
  });
  normalizeAll(chs, 0.8);
  return { sr, channels: chs };
}

/** A short, spatial rustle: a gust passing through one tree. */
export function leafGust(r: Rng, sr: number): Sound {
  const dur = rand(r, 1.6, 3.2);
  const out = new Float32Array(Math.ceil(dur * sr));
  rustleInto(out, sr, r, 260, rand(r, 0.8, 1.1), 0, dur, false);
  for (let i = 0; i < out.length; i++) {
    const u = i / out.length;
    out[i] *= Math.pow(Math.sin(Math.PI * Math.pow(u, 0.7)), 1.5);
  }
  return mono(normalize(out), sr);
}

/** A babbling brook: low rushing water under hundreds of bubbles popping into song. */
export function babbleLoop(r: Rng, sr: number, seconds = 8): Sound {
  const n = Math.floor(seconds * sr);
  const out = new Float32Array(n);
  // the rush underneath
  const xf = Math.floor(sr * 0.25);
  const rush = filterLoop(seamless(pink(r, n + xf), xf), new Biquad('lowpass', sr, 1100, 0.6), new Biquad('highpass', sr, 120));
  for (let i = 0; i < n; i++) out[i] = rush[i] * 1.4;
  // bubbles: little sines whose pitch rises as they surface
  let t = 0;
  while (t < seconds) {
    const f0 = Math.exp(rand(r, Math.log(320), Math.log(1500)));
    const d = (rand(r, 0.5, 1.6) * 0.35) / Math.sqrt(f0);
    const rise = rand(r, 0.4, 1.8);
    const a = Math.pow(r(), 2.2) * 0.5;
    const s0 = Math.floor(t * sr);
    const N = Math.floor(d * sr);
    let ph = 0;
    for (let i = 0; i < N; i++) {
      const u = i / N;
      ph += (TAU * f0 * (1 + rise * u)) / sr;
      out[(s0 + i) % n] += a * Math.sin(ph) * Math.exp(-u * 4) * Math.min(1, i / 30);
    }
    t += -Math.log(1 - r() * 0.999) / 75;
  }
  // a little sparkle of spray
  t = 0;
  while (t < seconds) {
    addNoiseBurst(out, sr, r, t, rand(r, 0.002, 0.008), rand(r, 0.05, 0.2), new Biquad('bandpass', sr, rand(r, 3500, 8000), 1.5), 'hann', true);
    t += -Math.log(1 - r() * 0.999) / 25;
  }
  return mono(normalize(out, 0.8), sr);
}

/** Waves lapping on Mirror Lake's shore: slow washes, a fizz of foam, the odd bubble. */
export function lapLoop(r: Rng, sr: number, seconds = 12): Sound {
  const n = Math.floor(seconds * sr);
  const out = new Float32Array(n);
  let t = rand(r, 0, 1);
  while (t < seconds) {
    const a = rand(r, 0.5, 1);
    const lp = new Biquad('lowpass', sr, rand(r, 600, 1100), 0.7);
    const hp = new Biquad('highpass', sr, 2600);
    const N = Math.floor(2.4 * sr);
    const s0 = Math.floor(t * sr);
    for (let i = 0; i < N; i++) {
      const u = i / sr;
      const wash = smooth(0, 0.35, u) * Math.exp(-Math.max(0, u - 0.35) / 0.45);
      const fizz = u > 0.3 ? Math.exp(-(u - 0.3) / 0.5) * smooth(0.3, 0.45, u) : 0;
      const w = r() * 2 - 1;
      out[(s0 + i) % n] += a * (lp.run(w) * wash * 1.6 + hp.run(w) * fizz * 0.22);
    }
    for (let b = randInt(r, 0, 3); b > 0; b--) addRing(out, sr, t + rand(r, 0.3, 1.2), rand(r, 500, 1200), 0.06 * a, 0.012, true);
    t += rand(r, 2.2, 4.2);
  }
  return mono(normalize(out, 0.8), sr);
}

/** A field full of crickets at night, spread across the stereo image. */
export function cricketBed(r: Rng, sr: number, seconds = 10): Sound {
  const n = Math.floor(seconds * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let c = 0; c < 14; c++) {
    const f = rand(r, 4100, 5300);
    // a whole number of chirps per loop so it repeats seamlessly
    const period = seconds / Math.round(seconds / rand(r, 0.3, 0.62));
    const pulses = randInt(r, 2, 4);
    const amp = Math.pow(rand(r, 0.15, 1), 2);
    const pan = r();
    const offset = r() * period;
    const notes: Note[] = [];
    for (let t = offset; t < seconds; t += period) for (let p = 0; p < pulses; p++) notes.push({ t: t + p * 0.022, d: 0.014, fp: [f, f * 0.985], h2: 0.05, atk: 0.2, rel: 0.4, a: amp });
    const one = new Float32Array(n + Math.floor(sr * 0.2));
    for (const no of notes) addNote(one, sr, no);
    const gl = Math.cos((pan * Math.PI) / 2);
    const gr = Math.sin((pan * Math.PI) / 2);
    for (let i = 0; i < one.length; i++) {
      L[i % n] += one[i] * gl;
      R[i % n] += one[i] * gr;
    }
  }
  normalizeAll([L, R], 0.8);
  return { sr, channels: [L, R] };
}

/** A crackling flame: snapping embers over a soft, low roar. */
export function crackleLoop(r: Rng, sr: number, seconds = 6): Sound {
  const n = Math.floor(seconds * sr);
  const xf = Math.floor(sr * 0.2);
  const out = filterLoop(seamless(brown(r, n + xf), xf), new Biquad('lowpass', sr, 260));
  for (let i = 0; i < n; i++) out[i] *= 0.5;
  let t = 0;
  while (t < seconds) {
    const big = r() < 0.06;
    const a = big ? rand(r, 0.6, 1) : Math.pow(r(), 3) * 0.5;
    addNoiseBurst(out, sr, r, t, big ? rand(r, 0.004, 0.012) : rand(r, 0.0008, 0.004), a, new Biquad('bandpass', sr, rand(r, 1200, 5000), 0.9), 'decay', true);
    t += -Math.log(1 - r() * 0.999) / (big ? 40 : 34);
  }
  return mono(normalize(out, 0.8), sr);
}

/** Stereo pink noise loop (wind, the waterfall's hiss). */
export function pinkLoop(r: Rng, sr: number, seconds = 8): Sound {
  const n = Math.floor(seconds * sr);
  const xf = Math.floor(sr * 0.3);
  const chs = [0, 1].map(() => seamless(pink(r, n + xf), xf));
  normalizeAll(chs, 0.8);
  return { sr, channels: chs };
}

/** Stereo brown noise loop (the low body of wind and falling water). */
export function brownLoop(r: Rng, sr: number, seconds = 8): Sound {
  const n = Math.floor(seconds * sr);
  const xf = Math.floor(sr * 0.5);
  const chs = [0, 1].map(() => {
    const a = seamless(brown(r, n + xf), xf);
    // remove DC drift so the loop sits centred
    let m = 0;
    for (let i = 0; i < a.length; i++) m += a[i];
    m /= a.length;
    for (let i = 0; i < a.length; i++) a[i] -= m;
    return filterLoop(a, new Biquad('highpass', sr, 25));
  });
  normalizeAll(chs, 0.8);
  return { sr, channels: chs };
}

/** Impulse response for the outdoor reverb: scattered early reflections and a darkening tail. */
export function reverbIR(r: Rng, sr: number, seconds = 2.4): Sound {
  const n = Math.floor(seconds * sr);
  const tau = seconds / 6.9;
  const chs = [0, 1].map(() => {
    const a = new Float32Array(n);
    const pre = Math.floor(sr * 0.012);
    let lpState = 0;
    for (let i = pre; i < n; i++) {
      const u = (i - pre) / sr;
      // the tail loses its highs as it dies away
      const k = Math.min(0.95, 0.15 + (u / seconds) * 1.3);
      lpState = lpState * k + (r() * 2 - 1) * (1 - k);
      a[i] = (lpState * (1 + u * 2)) * Math.exp(-u / tau);
    }
    for (let e = 0; e < 14; e++) {
      const j = pre + Math.floor(rand(r, 0.004, 0.09) * sr);
      a[j] += rand(r, -0.6, 0.6);
    }
    return a;
  });
  normalizeAll(chs, 0.5);
  return { sr, channels: chs };
}

// ------------------------------------------------------------------ registry

/** Every sound the ambience can ask for, by name. Variants differ by seed. */
export const SOUNDS = {
  warbler,
  thrush,
  tit,
  dove,
  cuckoo,
  skylark,
  woodpecker,
  hawk,
  owl,
  cricket,
  frog,
  anvil,
  bell: (r: Rng, sr: number) => bell(r, sr),
  chimes,
  creak,
  leafGust,
  rustleLoop: (r: Rng, sr: number) => rustleLoop(r, sr),
  babbleLoop: (r: Rng, sr: number) => babbleLoop(r, sr),
  lapLoop: (r: Rng, sr: number) => lapLoop(r, sr),
  cricketBed: (r: Rng, sr: number) => cricketBed(r, sr),
  crackleLoop: (r: Rng, sr: number) => crackleLoop(r, sr),
  pinkLoop: (r: Rng, sr: number) => pinkLoop(r, sr),
  brownLoop: (r: Rng, sr: number) => brownLoop(r, sr),
  reverbIR: (r: Rng, sr: number) => reverbIR(r, sr),
} satisfies Record<string, (r: Rng, sr: number) => Sound>;

export type SoundName = keyof typeof SOUNDS;
