// The living soundscape of the valley. It listens from the camera and reads
// the world around the player: where the forest thickens, where the river
// runs, how high the ground climbs, what time of day it is and how hard the
// wind is gusting, and from that it mixes two kinds of sound:
//
//  - Beds: continuous layers (wind, rustling leaves and grass, crickets, the
//    river, Silverfall's roar, waves on Mirror Lake, crackling torches) whose
//    levels follow the surroundings. Water and fire are positioned in 3D.
//  - Singers: individual animals placed at real spots around the player
//    (a thrush in a tree, a skylark high over the meadow, an owl in the wood,
//    a frog on the shore) that sing their own song a few times from that spot
//    and then fall silent, so the chorus moves around you as you walk.
//
// Everything is synthesized in a worker at startup (see synth.ts), runs on
// its own ambience bus, and reaches the ears through an outdoor reverb that
// deepens in the forest and an echo off the crags up high.
import { Vector3 } from '@babylonjs/core';
import {
  LAKE,
  Simplex2,
  VILLAGE,
  VILLAGE_PROPS,
  WATERFALL,
  WATER_LEVEL,
  forestMask,
  hillsMask,
  riverQuery,
  riverWaterY,
  waterAt,
} from '@kelia/shared';
import type { World } from '../world/world';
import { riverPointAt } from '../world/water';
import { mixer } from './mixer';
import type { SoundName } from './synth';
import type { SynthJob } from './synth.worker';

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const rand = (a: number, b: number) => a + (b - a) * Math.random();
const bump = (x: number, c: number, w: number) => Math.exp(-(((x - c) / w) ** 2));

/** Ambient conditions at the listener, eased over time. */
interface Env {
  day: number;
  night: number;
  /** Dawn and dusk choruses (0..1 bumps). */
  dawn: number;
  dusk: number;
  gust: number;
  forest: number;
  meadow: number;
  village: number;
  hills: number;
  /** How high up the player is (0 valley floor .. 1 the crags). */
  alt: number;
}

/** What a spot in the world offers a creature. */
interface Spot {
  forest: number;
  hills: number;
  village: number;
  alt: number;
  /** 1 over open water. */
  wet: number;
  /** 1 right at the water's edge. */
  shore: number;
  ground: number;
  water: number;
}

interface Species {
  name: SoundName;
  variants: number;
  activity(e: Env): number;
  habitat(s: Spot): number;
  dist: [number, number];
  height: [number, number];
  /** Pause between songs (s). */
  interval: [number, number];
  /** Songs an individual sings before falling silent. */
  bout: [number, number];
  gain: number;
  /** Distance (m) at which it is heard at full level. */
  ref: number;
  max: number;
  weight: number;
  /** Spread of individual voices (playback rate). */
  pitch?: number;
  /** Sits on the water surface rather than the ground. */
  onWater?: boolean;
}

const SPECIES: Species[] = [
  {
    name: 'warbler', variants: 6, weight: 1.2, max: 3,
    activity: (e) => e.day * (1 + e.dawn * 1.2),
    habitat: (s) => (1 - s.hills * 0.6) * (0.4 + 1.6 * s.forest * (1 - s.forest)) * (1 - s.wet) * (1 - s.village * 0.5),
    dist: [12, 70], height: [2, 8], interval: [4, 10], bout: [3, 7], gain: 0.5, ref: 5,
  },
  {
    name: 'thrush', variants: 5, weight: 1, max: 2,
    activity: (e) => e.day * (0.6 + e.dawn * 1.8 + e.dusk * 1.8),
    habitat: (s) => (0.15 + s.forest * 0.85 + s.village * 0.4) * (1 - s.wet),
    dist: [20, 80], height: [5, 12], interval: [3, 8], bout: [3, 6], gain: 0.6, ref: 7,
  },
  {
    name: 'tit', variants: 5, weight: 0.9, max: 2,
    activity: (e) => e.day * (1 + e.dawn * 0.6),
    habitat: (s) => (0.1 + s.forest * 0.8 + s.village * 0.6) * (1 - s.wet),
    dist: [10, 50], height: [3, 9], interval: [5, 12], bout: [2, 5], gain: 0.42, ref: 4,
  },
  {
    name: 'dove', variants: 4, weight: 0.6, max: 1,
    activity: (e) => e.day,
    habitat: (s) => (0.05 + s.forest * 0.6 + s.village * 0.8) * (1 - s.wet),
    dist: [15, 60], height: [6, 12], interval: [8, 16], bout: [2, 4], gain: 0.5, ref: 6, pitch: 0.04,
  },
  {
    name: 'cuckoo', variants: 3, weight: 0.25, max: 1,
    activity: (e) => e.day * (1 + e.dawn),
    habitat: (s) => 0.05 + s.forest * 0.6,
    dist: [60, 140], height: [8, 14], interval: [6, 14], bout: [2, 5], gain: 0.6, ref: 15, pitch: 0.03,
  },
  {
    name: 'skylark', variants: 5, weight: 0.9, max: 2,
    activity: (e) => e.day * (1 + e.dawn * 0.5),
    habitat: (s) => (1 - s.forest) * (1 - s.village) * (1 - s.hills * 0.5) * (1 - s.wet),
    dist: [20, 70], height: [25, 45], interval: [3, 9], bout: [2, 5], gain: 0.42, ref: 8,
  },
  {
    name: 'woodpecker', variants: 3, weight: 0.35, max: 1,
    activity: (e) => e.day,
    habitat: (s) => s.forest * s.forest,
    dist: [25, 90], height: [4, 10], interval: [6, 15], bout: [2, 5], gain: 0.55, ref: 6, pitch: 0.05,
  },
  {
    name: 'hawk', variants: 3, weight: 0.35, max: 1,
    activity: (e) => e.day,
    habitat: (s) => 0.04 + Math.max(s.hills, s.alt) * 0.9,
    dist: [40, 130], height: [35, 70], interval: [10, 25], bout: [1, 3], gain: 0.55, ref: 25,
  },
  {
    name: 'owl', variants: 4, weight: 0.7, max: 2,
    activity: (e) => e.night,
    habitat: (s) => 0.05 + s.forest * 0.9 + s.village * 0.15,
    dist: [30, 100], height: [6, 12], interval: [12, 28], bout: [2, 5], gain: 0.6, ref: 12, pitch: 0.04,
  },
  {
    name: 'cricket', variants: 5, weight: 1.4, max: 4,
    activity: (e) => e.night + e.dusk * 0.5,
    habitat: (s) => (1 - s.forest * 0.7) * (1 - s.hills * 0.6) * (1 - s.wet) * (1 - s.alt * 0.7),
    dist: [5, 25], height: [0.1, 0.3], interval: [0.2, 1.5], bout: [5, 14], gain: 0.28, ref: 2, pitch: 0.04,
  },
  {
    name: 'frog', variants: 4, weight: 1.5, max: 3,
    activity: (e) => e.night + e.day * 0.12,
    habitat: (s) => s.shore,
    dist: [8, 60], height: [0, 0.2], interval: [3, 9], bout: [3, 7], gain: 0.45, ref: 4, onWater: true, pitch: 0.08,
  },
  {
    name: 'leafGust', variants: 6, weight: 1, max: 2,
    activity: (e) => e.gust * e.gust,
    habitat: (s) => s.forest * s.forest,
    dist: [8, 35], height: [5, 12], interval: [3, 8], bout: [1, 3], gain: 0.35, ref: 6, pitch: 0.1,
  },
];

interface Singer {
  sp: Species;
  pos: Vector3;
  voices: number[];
  rate: number;
  next: number;
  left: number;
  until: number;
}

const MAX_VOICES = 14;

/** Village landmarks that make their own sounds. */
const at = (prop: string) => VILLAGE_PROPS.find((p) => p.prop === prop)!;
const SMITHY = at('building_blacksmith');
const CHAPEL = at('building_church');
const TAVERN = at('building_tavern');
const WINDMILL = at('building_windmill');

/** Times of day the chapel bell rings, and how many tolls. */
const BELLS: [number, number][] = [
  [0.265, 3],
  [0.5, 5],
  [0.745, 3],
];

export class Soundscape {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private time = 0;
  private envT = 0;
  private spawnT = 0;
  private noise = new Simplex2(9137);
  private singers: Singer[] = [];
  private voices = 0;
  private lastDay = -1;
  private env: Env = { day: 1, night: 0, dawn: 0, dusk: 0, gust: 0.5, forest: 0, meadow: 1, village: 0, hills: 0, alt: 0 };
  private listener = new Vector3();
  private focus = new Vector3();
  private torches: Vector3[];
  private next = { anvil: 3, creak: 0, chimes: 2 };

  // graph
  private out!: GainNode;
  private spatial!: GainNode;
  private reverbSend!: GainNode;
  private echoSend!: GainNode;
  private beds: Record<string, { gain: GainNode; input: AudioNode; started: boolean }> = {};
  private windLP!: BiquadFilterNode;
  private whistleBP!: BiquadFilterNode;
  private whistlePan!: StereoPannerNode;
  private riverP!: PannerNode;
  private lakeP!: PannerNode;
  private fireP!: PannerNode;
  private convolver!: ConvolverNode;

  constructor(private world: World) {
    this.torches = world.props.lights.filter((l) => l.kind === 'torch').map((l) => l.pos);
    mixer.onReady((ctx) => this.start(ctx));
  }

  private start(ctx: AudioContext) {
    this.ctx = ctx;
    // the whole ambience swells in once its first sounds are ready
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(mixer.bus.ambience);

    // positioned sounds share an outdoor reverb and a mountain echo
    this.spatial = ctx.createGain();
    this.spatial.connect(this.out);
    this.convolver = ctx.createConvolver();
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.15;
    this.spatial.connect(this.reverbSend).connect(this.convolver).connect(this.out);
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.42;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const echoLP = ctx.createBiquadFilter();
    echoLP.type = 'lowpass';
    echoLP.frequency.value = 2200;
    this.echoSend = ctx.createGain();
    this.echoSend.gain.value = 0;
    this.spatial.connect(this.echoSend).connect(delay).connect(echoLP).connect(fb).connect(delay);
    echoLP.connect(this.out);

    // beds
    this.windLP = this.filter('lowpass', 400, 0.5);
    this.bed('wind', this.windLP, this.out);
    this.whistleBP = this.filter('bandpass', 900, 4);
    this.whistlePan = ctx.createStereoPanner();
    this.whistlePan.connect(this.out);
    this.bed('whistle', this.whistleBP, this.whistlePan);
    this.bed('leaves', this.filter('highpass', 700), this.out);
    this.bed('grass', this.filter('lowpass', 2600), this.out);
    this.bed('crickets', null, this.out);
    this.riverP = mixer.panner(6, 1.3, false);
    this.riverP.connect(this.spatial);
    this.bed('river', null, this.riverP);
    this.bed('riverRush', this.filter('lowpass', 700), this.riverP);
    const fallsP = mixer.panner(20, 1, false);
    fallsP.connect(this.spatial);
    mixer.place(fallsP, WATERFALL.center[0], 18, WATERFALL.center[1] - 4);
    this.bed('falls', this.filter('lowpass', 3500), fallsP);
    this.bed('fallsBody', null, fallsP);
    this.bed('fallsBabble', null, fallsP);
    this.lakeP = mixer.panner(8, 1.2, false);
    this.lakeP.connect(this.spatial);
    this.bed('lake', null, this.lakeP);
    this.fireP = mixer.panner(2, 1.5, false);
    this.fireP.connect(this.spatial);
    this.bed('fire', null, this.fireP);

    this.synthesize(ctx.sampleRate);
  }

  private filter(type: BiquadFilterType, f: number, q = 0.707) {
    const n = this.ctx!.createBiquadFilter();
    n.type = type;
    n.frequency.value = f;
    n.Q.value = q;
    return n;
  }

  private bed(name: string, filter: AudioNode | null, dest: AudioNode) {
    const gain = this.ctx!.createGain();
    gain.gain.value = 0;
    if (filter) filter.connect(gain);
    gain.connect(dest);
    this.beds[name] = { gain, input: filter ?? gain, started: false };
  }

  /** Loop a bed's buffer once it exists, from a random point so layers never line up. */
  private startBed(name: string, key: string, rate = 1) {
    const b = this.beds[name];
    const buf = this.buffers.get(key);
    if (!b || b.started || !buf) return;
    b.started = true;
    const src = this.ctx!.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = rate;
    src.connect(b.input);
    src.start(0, Math.random() * buf.duration);
  }

  /** Render every sound in a worker, beds first, then a few voices per species. */
  private synthesize(sr: number) {
    const jobs: SynthJob[] = [];
    const add = (name: SoundName, i = 0) => jobs.push({ key: `${name}:${i}`, name, seed: (hashName(name) + i * 7919) >>> 0 });
    for (const n of ['brownLoop', 'pinkLoop', 'rustleLoop', 'babbleLoop', 'lapLoop', 'cricketBed', 'crackleLoop', 'reverbIR'] as SoundName[]) add(n);
    add('pinkLoop', 1);
    add('rustleLoop', 1);
    // one voice of every species first, then the rest
    const maxV = Math.max(...SPECIES.map((s) => s.variants));
    for (let i = 0; i < maxV; i++) for (const s of SPECIES) if (i < s.variants) add(s.name, i);
    for (let i = 0; i < 3; i++) add('anvil', i);
    add('bell');
    for (let i = 0; i < 4; i++) add('chimes', i);
    for (let i = 0; i < 4; i++) add('creak', i);

    const worker = new Worker(new URL('./synth.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ key: string; sr: number; channels: Float32Array[] } | { done: true }>) => {
      const m = e.data;
      if ('done' in m) {
        worker.terminate();
        return;
      }
      const ctx = this.ctx!;
      const buf = ctx.createBuffer(m.channels.length, m.channels[0].length, m.sr);
      m.channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
      this.buffers.set(m.key, buf);
      this.onBuffer(m.key);
    };
    worker.postMessage({ sr, jobs });
  }

  private onBuffer(key: string) {
    switch (key) {
      case 'brownLoop:0':
        this.startBed('wind', key);
        this.startBed('fallsBody', key, 0.8);
        // the first layer is in: let the world fade up
        {
          const t = this.ctx!.currentTime;
          this.out.gain.cancelScheduledValues(t);
          this.out.gain.setValueAtTime(this.out.gain.value, t);
          this.out.gain.linearRampToValueAtTime(1, t + 4);
        }
        break;
      case 'pinkLoop:0':
        this.startBed('whistle', key);
        this.startBed('falls', key);
        break;
      case 'pinkLoop:1':
        this.startBed('riverRush', key);
        break;
      case 'rustleLoop:0':
        this.startBed('leaves', key);
        break;
      case 'rustleLoop:1':
        this.startBed('grass', key, 0.75);
        break;
      case 'babbleLoop:0':
        this.startBed('river', key);
        this.startBed('fallsBabble', key, 1.5);
        break;
      case 'lapLoop:0':
        this.startBed('lake', key);
        break;
      case 'cricketBed:0':
        this.startBed('crickets', key);
        break;
      case 'crackleLoop:0':
        this.startBed('fire', key);
        break;
      case 'reverbIR:0':
        this.convolver.buffer = this.buffers.get(key)!;
        break;
    }
  }

  // ------------------------------------------------------------------ per frame

  update(dt: number) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    this.time += dt;
    const cam = this.world.camera;
    const p = cam.globalPosition;
    const fwd = cam.getDirection(Vector3.Forward());
    const up = cam.getDirection(Vector3.Up());
    mixer.setListener(p.x, p.y, p.z, fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    this.listener.copyFrom(p);
    // the world is "where the player is": the camera's target when close, else the camera
    const target = cam.getTarget();
    this.focus.copyFrom(Vector3.Distance(target, p) < 25 ? target : p);

    this.envT -= dt;
    if (this.envT <= 0) {
      const step = 0.2 - this.envT;
      this.envT = 0.2;
      this.updateEnv(step);
      this.updateBeds();
      this.updateVillage();
    }
    this.spawnT -= dt;
    if (this.spawnT <= 0) {
      this.spawnT = 0.4;
      this.trySpawn();
    }
    this.updateSingers();
  }

  private spot(x: number, z: number): Spot {
    const ground = this.world.groundAt(x, z);
    const water = waterAt(x, z);
    const hasWater = water > -Infinity;
    const dv = Math.hypot(x - VILLAGE.center[0], z - VILLAGE.center[1]);
    return {
      forest: forestMask(x, z),
      hills: hillsMask(x, z),
      village: smooth(VILLAGE.radius + 30, VILLAGE.radius - 5, dv),
      alt: smooth(18, 55, ground),
      wet: hasWater && ground < water - 0.3 ? 1 : 0,
      shore: hasWater && Math.abs(ground - water) < 1.2 ? 1 : 0,
      ground,
      water,
    };
  }

  private updateEnv(dt: number) {
    const a = this.world.atmosphere;
    const e = this.env;
    const k = Math.min(1, dt * 0.8);
    const ease = (key: keyof Env, v: number) => (e[key] += (v - e[key]) * k);
    const fx = this.focus.x;
    const fz = this.focus.z;
    // average the forest over a few nearby points so stepping out of the trees fades smoothly
    let forest = forestMask(fx, fz);
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2;
      forest += forestMask(fx + Math.cos(ang) * 18, fz + Math.sin(ang) * 18);
    }
    forest /= 5;
    const s = this.spot(fx, fz);
    const day = smooth(-0.04, 0.1, a.sunDir.y);
    ease('day', day);
    ease('night', 1 - day);
    ease('dawn', bump(a.dayTime, 0.265, 0.04));
    ease('dusk', bump(a.dayTime, 0.75, 0.035));
    ease('forest', forest);
    ease('hills', s.hills);
    ease('village', s.village);
    // altitude counts the camera's own height a little, for flying views
    ease('alt', clamp01(Math.max(s.alt, smooth(30, 90, this.listener.y) * 0.6)));
    ease('meadow', clamp01(1 - e.forest - e.hills * 0.7 - e.village * 0.8 - e.alt * 0.5));
    // rolling gusts: slow swells with quicker flurries on top
    const t = this.time;
    e.gust = clamp01(0.45 + 0.45 * this.noise.noise(t * 0.06, 1.7) + 0.22 * this.noise.noise(t * 0.23, 8.3));
  }

  private level(name: string, v: number, tc = 0.35) {
    const b = this.beds[name];
    if (b) b.gain.gain.setTargetAtTime(v, this.ctx!.currentTime, tc);
  }

  private updateBeds() {
    const e = this.env;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const g = e.gust;
    // low wind everywhere, stronger and brighter up high, sheltered in the trees
    this.level('wind', (0.16 + 0.45 * e.alt + 0.12 * e.hills) * (0.35 + 0.65 * g) * (1 - e.forest * 0.45), 0.6);
    this.windLP.frequency.setTargetAtTime(170 + 420 * g + 520 * e.alt, t, 0.6);
    // the whistle of wind over the crags
    const w = 0.5 + 0.5 * this.noise.noise(this.time * 0.05, 3.1);
    this.level('whistle', Math.pow(e.alt, 1.5) * (0.12 + 0.88 * g * g) * 0.32, 0.8);
    this.whistleBP.frequency.setTargetAtTime(480 + 900 * w + 300 * g, t, 0.8);
    this.whistlePan.pan.setTargetAtTime(this.noise.noise(this.time * 0.03, 5.5) * 0.7, t, 1);
    // leaves hiss and swell with each gust; meadow grass whispers more softly
    this.level('leaves', e.forest * (0.12 + 0.88 * Math.pow(g, 1.5)) * 0.5, 0.5);
    this.level('grass', e.meadow * (0.06 + 0.5 * g * g) * 0.3, 0.5);
    // a field of crickets at night
    this.level('crickets', e.night * (e.meadow * 0.8 + e.village * 0.45 + e.forest * 0.25) * (1 - e.alt * 0.8) * 0.3, 1.5);

    // the river from its nearest point, at its own height
    const f = this.focus;
    const rq = riverQuery(f.x, f.z);
    const rp = riverPointAt(rq.s);
    mixer.place(this.riverP, rp.x, riverWaterY(rq.s) + 0.4, rp.z);
    this.level('river', 0.9);
    this.level('riverRush', 0.35);
    // Silverfall: a roar you hear long before you see it
    this.level('falls', 0.55);
    this.level('fallsBody', 0.7);
    this.level('fallsBabble', 0.4);
    // waves lapping at the nearest stretch of Mirror Lake's shore
    let dx = f.x - LAKE.center[0];
    let dz = f.z - LAKE.center[1];
    const d = Math.hypot(dx, dz) || 1;
    dx /= d;
    dz /= d;
    const shoreR = Math.min(d, LAKE.radius + 6);
    mixer.place(this.lakeP, LAKE.center[0] + dx * shoreR, WATER_LEVEL + 0.3, LAKE.center[1] + dz * shoreR);
    this.level('lake', 0.7);
    // the nearest burning torch crackles
    let best: Vector3 | null = null;
    let bd = 40 * 40;
    for (const tp of this.torches) {
      const dd = Vector3.DistanceSquared(tp, this.listener);
      if (dd < bd) {
        bd = dd;
        best = tp;
      }
    }
    if (best) mixer.place(this.fireP, best.x, best.y, best.z);
    this.level('fire', best ? 0.55 : 0, 0.8);

    // reverb deepens among the trees; the crags throw back an echo
    this.reverbSend.gain.setTargetAtTime(0.1 + 0.4 * e.forest + 0.12 * e.alt, t, 1);
    this.echoSend.gain.setTargetAtTime(0.32 * Math.max(e.alt, e.hills * 0.5), t, 1);
  }

  /** The smithy's anvil by day, the windmill's creak, chimes in the gusts and the chapel bell at dawn, noon and dusk. */
  private updateVillage() {
    const e = this.env;
    const tm = this.time;
    const L = this.listener;
    const near = (x: number, z: number, r: number) => (L.x - x) ** 2 + (L.z - z) ** 2 < r * r;
    const ground = (x: number, z: number) => this.world.groundAt(x, z);
    if (tm > this.next.anvil) {
      this.next.anvil = tm + rand(5, 13);
      if (e.day > 0.6 && near(SMITHY.x, SMITHY.z, 180)) this.oneShot(`anvil:${(Math.random() * 3) | 0}`, SMITHY.x + 2, ground(SMITHY.x, SMITHY.z) + 1.2, SMITHY.z + 2, 0.5, 4, 1, true);
    }
    if (tm > this.next.creak) {
      this.next.creak = tm + rand(2.4, 3.6);
      if (near(WINDMILL.x, WINDMILL.z, 100)) this.oneShot(`creak:${(Math.random() * 4) | 0}`, WINDMILL.x, ground(WINDMILL.x, WINDMILL.z) + 9, WINDMILL.z, 0.35, 4, rand(0.9, 1.1), true);
    }
    if (tm > this.next.chimes && e.gust > 0.62) {
      this.next.chimes = tm + rand(5, 14);
      if (near(TAVERN.x, TAVERN.z, 90)) this.oneShot(`chimes:${(Math.random() * 4) | 0}`, TAVERN.x + 4, ground(TAVERN.x, TAVERN.z) + 3.5, TAVERN.z - 3, 0.3, 3, 1, true);
    }
    // the bell, only when the day moves naturally (not while the sky eases after login)
    const day = this.world.atmosphere.dayTime;
    if (this.lastDay >= 0 && day > this.lastDay && day - this.lastDay < 0.01) {
      for (const [when, tolls] of BELLS) if (this.lastDay < when && day >= when) this.ringBell(tolls);
    }
    this.lastDay = day;
  }

  /** Ring the chapel bell: it carries across the whole valley. */
  ringBell(tolls: number) {
    const buf = this.buffers.get('bell:0');
    if (!buf) return;
    const y = this.world.groundAt(CHAPEL.x, CHAPEL.z) + 11;
    for (let i = 0; i < tolls; i++) this.oneShot('bell:0', CHAPEL.x, y, CHAPEL.z, 0.75, 40, 1, false, i * 2.6, 0.7);
  }

  // ------------------------------------------------------------------ singers

  private trySpawn() {
    const e = this.env;
    const cap = Math.round(7 + 6 * e.dawn * e.day);
    if (this.singers.length >= cap) return;
    let total = 0;
    const weights = SPECIES.map((sp) => {
      const n = this.singers.filter((s) => s.sp === sp).length;
      const w = n >= sp.max ? 0 : sp.weight * sp.activity(e);
      total += w;
      return w;
    });
    if (total < 0.02) return;
    let pick = Math.random() * total;
    const sp = SPECIES[Math.max(0, weights.findIndex((w) => (pick -= w) < 0))];
    // a few tries to find a spot this creature likes
    for (let tries = 0; tries < 3; tries++) {
      const ang = Math.random() * Math.PI * 2;
      const r = rand(sp.dist[0], sp.dist[1]);
      const x = this.focus.x + Math.cos(ang) * r;
      const z = this.focus.z + Math.sin(ang) * r;
      const s = this.spot(x, z);
      if (Math.random() > clamp01(sp.habitat(s))) continue;
      const base = sp.onWater && s.water > -Infinity ? Math.max(s.water, s.ground) : s.ground;
      const voices = [(Math.random() * sp.variants) | 0, (Math.random() * sp.variants) | 0];
      const spread = sp.pitch ?? 0.06;
      this.singers.push({
        sp,
        pos: new Vector3(x, base + rand(sp.height[0], sp.height[1]), z),
        voices,
        rate: 1 + rand(-spread, spread),
        next: this.time + rand(0.3, sp.interval[1] * 0.6),
        left: Math.round(rand(sp.bout[0], sp.bout[1])),
        until: 0,
      });
      return;
    }
  }

  private updateSingers() {
    const e = this.env;
    for (let i = this.singers.length - 1; i >= 0; i--) {
      const s = this.singers[i];
      const far = Vector3.DistanceSquared(s.pos, this.listener) > 170 * 170;
      const asleep = s.sp.activity(e) < 0.05;
      if (far || ((s.left <= 0 || asleep) && this.time > s.until)) {
        this.singers.splice(i, 1);
        continue;
      }
      if (s.left > 0 && !asleep && this.time >= s.next) {
        const key = `${s.sp.name}:${s.voices[Math.random() < 0.7 ? 0 : 1]}`;
        const dur = this.oneShot(key, s.pos.x, s.pos.y, s.pos.z, s.sp.gain * rand(0.75, 1), s.sp.ref, s.rate, true);
        if (dur > 0) {
          s.left--;
          s.until = this.time + dur;
          s.next = this.time + dur + rand(s.sp.interval[0], s.sp.interval[1]);
        } else s.next = this.time + 1;
      }
    }
  }

  /**
   * Play a buffer from a point in the world. Distant sounds lose their highs
   * the way they do through real air. Returns its duration (0 if not played).
   */
  private oneShot(key: string, x: number, y: number, z: number, gain: number, ref: number, rate = 1, hrtf = true, delay = 0, rolloff = 1): number {
    const ctx = this.ctx!;
    const buf = this.buffers.get(key);
    if (!buf || this.voices >= MAX_VOICES) return 0;
    const dist = Math.hypot(x - this.listener.x, y - this.listener.y, z - this.listener.z);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.max(1800, Math.min(20000, 22000 * Math.exp(-dist / 120)));
    const g = ctx.createGain();
    g.gain.value = gain;
    const p = mixer.panner(ref, rolloff, hrtf);
    mixer.place(p, x, y, z);
    src.connect(lp).connect(g).connect(p).connect(this.spatial);
    this.voices++;
    src.onended = () => {
      this.voices--;
      src.disconnect();
      lp.disconnect();
      g.disconnect();
      p.disconnect();
    };
    src.start(ctx.currentTime + delay);
    return buf.duration / rate;
  }

  /** For the developer console: what is singing right now. */
  debug() {
    return {
      env: { ...this.env },
      voices: this.voices,
      singers: this.singers.map((s) => `${s.sp.name} @${Vector3.Distance(s.pos, this.listener).toFixed(0)}m ×${s.left}`),
      buffers: this.buffers.size,
    };
  }
}

function hashName(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
