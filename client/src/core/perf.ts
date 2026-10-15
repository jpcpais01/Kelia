// Kelia's built-in profiler. Measures, per frame:
//  - CPU time of every game and world system (self time, nested scopes),
//  - CPU time of each rendering stage (culling, animations, every render
//    target such as the shadow cascades, the main scene draw and each
//    post-process),
//  - GPU time of each render pass (WebGPU timestamp queries, or WebGL2
//    EXT_disjoint_timer_query segments),
//  - and, on request, the GPU cost of each world system by briefly hiding its
//    meshes and measuring how much faster the frame gets ("probe").
// Everything is free while the overlay is off: scopes cost one array push.
import { RenderTargetTexture, type AbstractEngine, type AbstractMesh, type Node, type PostProcess, type RenderTargetWrapper, type Scene } from '@babylonjs/core';

// ------------------------------------------------------------------ systems

/** Systems that own meshes (the probe can hide them to measure GPU cost). */
export const MESH_SYSTEMS = ['terrain', 'grass', 'foliage', 'water', 'props', 'sky', 'ambient', 'secrets', 'characters', 'fx'] as const;
export type MeshSystem = (typeof MESH_SYSTEMS)[number];
const MESH_SYSTEM_SET = new Set<string>(MESH_SYSTEMS);

export const SYSTEM_LABELS: Record<string, string> = {
  sky: 'Sky, sun & fog',
  terrain: 'Terrain',
  water: 'Water',
  grass: 'Grass',
  foliage: 'Trees & foliage',
  props: 'Village & props',
  ambient: 'Ambient life',
  secrets: 'Secret spots',
  postfx: 'Post-FX update',
  game: 'Game logic',
  player: 'Player & animation',
  combat: 'Combat',
  remotes: 'Other players',
  monsters: 'Monsters',
  characters: 'Characters & monsters',
  fx: 'Combat effects',
  particles: 'Particles',
  camera: 'Camera',
  ui: 'HUD & UI',
  network: 'Network',
  render: 'Scene setup & other',
  'r:anim': 'Animations',
  'r:cull': 'Culling & mesh selection',
  draw: 'Scene draw (main pass)',
};

export function systemLabel(key: string) {
  if (SYSTEM_LABELS[key]) return SYSTEM_LABELS[key];
  if (key.startsWith('rtt:') || key.startsWith('pp:')) return prettyPass(key.slice(key.indexOf(':') + 1)).label;
  return key;
}

// ------------------------------------------------------------------ pass naming

export type PassGroup = 'Shadows' | 'Scene draw' | 'Ambient occlusion' | 'Depth of field' | 'Light shafts' | 'Bloom' | 'Depth' | 'Grading & AA' | 'Other';
export const PASS_GROUP_COLORS: Record<PassGroup, string> = {
  Shadows: '#8f7cf0',
  'Scene draw': '#e8c27a',
  'Ambient occlusion': '#6cc3d5',
  'Depth of field': '#d57bb6',
  'Light shafts': '#ffb35c',
  Bloom: '#ff8a6b',
  Depth: '#7fa8d1',
  'Grading & AA': '#7fd18b',
  Other: '#9aa0aa',
};

const passCache = new Map<string, { label: string; group: PassGroup }>();
export function prettyPass(name: string): { label: string; group: PassGroup } {
  let r = passCache.get(name);
  if (r) return r;
  const n = name.toLowerCase().replace(/^postprocessrtt-/, '');
  const words = name
    .replace(/^PostProcessRTT-/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  const nice = words.charAt(0).toUpperCase() + words.slice(1);
  if (n === 'scene draw') r = { label: 'Scene draw (main pass)', group: 'Scene draw' };
  else if (n === 'frame other') r = { label: 'Clears, copies & other', group: 'Other' };
  else if (/shadow|csm|cascade/.test(n)) r = { label: `Shadow maps (${words})`, group: 'Shadows' };
  else if (/gbuffer|geometrybuffer|geometry|prepass/.test(n)) r = { label: 'G-buffer re-render (for SSAO)', group: 'Ambient occlusion' };
  else if (/ssao/.test(n)) r = { label: n.includes('combine') ? 'SSAO combine' : n.includes('blur') ? `SSAO blur (${words})` : n.includes('original') ? 'SSAO scene copy' : 'SSAO', group: 'Ambient occlusion' };
  else if (/dof|depthoffield|circleofconfusion|coc/.test(n)) r = { label: `Depth of field · ${nice}`, group: 'Depth of field' };
  else if (/volumetric|shafts|vls|lightscattering/.test(n)) r = { label: n.includes('map') || n.includes('pass') ? 'Light shafts occluder pass' : 'Light shafts', group: 'Light shafts' };
  else if (/prefilter/.test(n)) r = { label: 'Bloom & sky mask prefilter', group: 'Bloom' };
  else if (/bloom|highlight|kernel|blur/.test(n)) r = { label: `Bloom · ${nice}`, group: 'Bloom' };
  else if (/depth/.test(n)) r = { label: 'Depth pre-pass', group: 'Depth' };
  else if (/imageprocessing|composite/.test(n)) r = { label: 'Composite, tone mapping & grading', group: 'Grading & AA' };
  else if (/fxaa|sharpen|grain|chromatic|pass$/.test(n)) r = { label: nice.replace(/^Fxaa$/, 'FXAA'), group: 'Grading & AA' };
  else r = { label: nice, group: 'Other' };
  passCache.set(name, r);
  return r;
}

// ------------------------------------------------------------------ GPU timers

type GpuSink = (label: string, frameId: number, ns: number) => void;

interface GpuTimer {
  readonly name: string;
  setEnabled(on: boolean): void;
  /**
   * A new render pass (or segment) starts with this label. `resume` marks a
   * return to the enclosing pass after a nested one ended.
   */
  switchTo(label: string, wrapper?: RenderTargetWrapper | null, resume?: boolean): void;
  frameBegin(frameId: number): void;
  frameEnd(): void;
  poll(sink: GpuSink): void;
  resetLabels?(): void;
}

/** WebGL2: back-to-back TIME_ELAPSED queries, one per pass segment. */
class WebGLTimer implements GpuTimer {
  readonly name = 'WebGL2 timer queries';
  private pool: WebGLQuery[] = [];
  private pending: { q: WebGLQuery; label: string; frame: number }[] = [];
  private active: { q: WebGLQuery; label: string; frame: number } | null = null;
  private frame = 0;
  private on = false;

  constructor(private gl: WebGL2RenderingContext, private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }) {}

  setEnabled(on: boolean) {
    if (!on) this.close();
    this.on = on;
  }

  frameBegin(frameId: number) {
    this.frame = frameId;
    this.switchTo('frame other');
  }

  frameEnd() {
    this.close();
  }

  switchTo(label: string) {
    if (!this.on) return;
    if (this.active?.label === label) return;
    this.close();
    const gl = this.gl;
    const q = this.pool.pop() ?? gl.createQuery();
    if (!q) return;
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = { q, label, frame: this.frame };
  }

  private close() {
    if (!this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  poll(sink: GpuSink) {
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this.pending.length) {
      const p = this.pending[0];
      if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!disjoint) sink(p.label, p.frame, gl.getQueryParameter(p.q, gl.QUERY_RESULT) as number);
      this.pool.push(p.q);
      this.pending.shift();
    }
    // never let a stuck driver grow the queue forever
    while (this.pending.length > 600) gl.deleteQuery(this.pending.shift()!.q);
  }
}

/** Counter object the WebGPU engine fills in per render pass. */
class PassCounter {
  constructor(private owner: WebGPUTimer, readonly key: RenderTargetWrapper | 'main') {}
  // signature expected by Babylon's WebGPU timestamp query
  _addDuration(frameId: number, ns: number) {
    this.owner.record(this.key, frameId, ns);
  }
}

type WebGPUEngineLike = AbstractEngine & {
  enableGPUTimingMeasurements: boolean;
  gpuTimeInFrameForMainPass?: unknown;
  enabledExtensions?: readonly string[];
  _renderTargetWrapperCache?: RenderTargetWrapper[];
  _currentRenderTarget: RenderTargetWrapper | null;
};

/** WebGPU: timestamp queries around every render pass, attributed by target. */
class WebGPUTimer implements GpuTimer {
  readonly name = 'WebGPU timestamp queries';
  private labels = new Map<RenderTargetWrapper | 'main', string>();
  private prevLabels = new Map<RenderTargetWrapper | 'main', string>();
  private counters = new WeakMap<RenderTargetWrapper, PassCounter>();
  private main = new PassCounter(this, 'main');
  private buffered: [RenderTargetWrapper | 'main', number, number][] = [];

  constructor(private engine: WebGPUEngineLike) {}

  setEnabled(on: boolean) {
    this.engine.enableGPUTimingMeasurements = on;
    if (on) {
      this.engine.gpuTimeInFrameForMainPass = this.main;
      this.attach();
    }
  }

  /** Give every render target our counter (targets made later get theirs on the next poll). */
  private attach() {
    for (const w of this.engine._renderTargetWrapperCache ?? []) {
      const rec = w as unknown as { gpuTimeInFrame?: unknown };
      if (rec.gpuTimeInFrame instanceof PassCounter) continue;
      let c = this.counters.get(w);
      if (!c) this.counters.set(w, (c = new PassCounter(this, w)));
      rec.gpuTimeInFrame = c;
    }
  }

  frameBegin() {}
  frameEnd() {}

  switchTo(label: string, wrapper?: RenderTargetWrapper | null, resume = false) {
    // passes are timed by their render target, so only the start of a pass names it
    if (resume || label === 'frame other') return;
    const w = wrapper === undefined ? this.engine._currentRenderTarget : wrapper;
    const key = w ?? 'main';
    const prev = this.labels.get(key);
    if (prev === undefined) this.labels.set(key, label);
    else if (prev !== label && !prev.split(' + ').includes(label)) this.labels.set(key, prev.split(' + ').length < 3 ? `${prev} + ${label}` : prev);
  }

  record(key: RenderTargetWrapper | 'main', frameId: number, ns: number) {
    this.buffered.push([key, frameId, ns]);
  }

  poll(sink: GpuSink) {
    this.attach();
    for (const [key, frame, ns] of this.buffered) {
      const label = this.labels.get(key) ?? this.prevLabels.get(key) ?? (key === 'main' ? 'frame other' : key.label || 'frame other');
      sink(label, frame, ns);
    }
    this.buffered.length = 0;
  }

  /** Relearn pass labels each window (render targets get recycled when settings change). */
  resetLabels() {
    this.prevLabels = this.labels;
    this.labels = new Map();
  }
}

// ------------------------------------------------------------------ snapshot

export interface PerfRow {
  key: string;
  label: string;
  ms: number;
  peak: number;
}

export interface GpuRow {
  label: string;
  group: PassGroup;
  ms: number;
}

export interface SystemRow {
  key: string;
  label: string;
  cpu: number | null;
  gpu: number | null;
  gpuLive: boolean;
  meshes: number;
  tris: number;
  draws: number;
}

export interface ProbeResult {
  at: number;
  baselineGpu: number | null;
  baselineCpu: number;
  costs: Record<string, { gpu: number | null; cpu: number }>;
}

export interface PerfSnapshot {
  fps: number;
  frameMs: number;
  low1: number;
  worst: number;
  cpuMs: number;
  updateMs: number;
  renderMs: number;
  gpuMs: number | null;
  update: PerfRow[];
  render: PerfRow[];
  gpu: GpuRow[];
  systems: SystemRow[];
  drawCalls: number;
  activeMeshes: number;
  tris: number;
  meshes: number;
  materials: number;
  textures: number;
  particles: number;
  netMsgs: number;
  netKB: number;
}

const RING = 300;

// ------------------------------------------------------------------ profiler

interface ScopeEntry {
  key: string;
  t0: number;
  child: number;
  pass: string | null;
}

class Profiler {
  enabled = false;
  gpuName = 'not available';
  /** Rolling per-frame history for the graph. */
  readonly hist = {
    frame: new Float32Array(RING),
    update: new Float32Array(RING),
    render: new Float32Array(RING),
    gpu: new Float32Array(RING).fill(NaN),
    head: 0,
  };
  snapshot: PerfSnapshot | null = null;
  probe: { progress: number; label: string } | null = null;
  probeResult: ProbeResult | null = null;
  onProbeDone: (() => void) | null = null;

  private scene: Scene | null = null;
  private engine: AbstractEngine | null = null;
  private gpu: GpuTimer | null = null;
  private stack: ScopeEntry[] = [];
  /** Category stack for tagging newly created meshes (always on, cheap). */
  private cat: string[] = [];
  private tags = new WeakMap<Node, string>();
  private resolved = new WeakMap<AbstractMesh, string>();
  private hooked = new WeakSet<PostProcess>();
  private sceneHooked = false;

  // per frame
  private lastFrameStart = 0;
  private frameId = 0;
  private cur = new Map<string, number>();
  private gpuFrames = new Map<number, number>();
  // per window
  private win = { t0: 0, frames: 0, intervals: 0, frameMs: 0, drawCalls: 0, sum: new Map<string, number>(), peak: new Map<string, number>(), gpu: new Map<string, number>(), gpuFrames: new Set<number>(), netMsgs: 0, netBytes: 0 };
  private intervals: number[] = [];

  // ---------------------------------------------------------------- setup

  /** Call right after the scene is created, before any system builds meshes. */
  watch(scene: Scene) {
    this.scene = scene;
    this.engine = scene.getEngine();
    const tag = (n: Node) => {
      const c = this.cat[this.cat.length - 1];
      if (c && MESH_SYSTEM_SET.has(c) && !this.tags.has(n)) this.tags.set(n, c);
    };
    // (wrap addMesh: Babylon announces new meshes asynchronously, after the scope ended)
    const addMesh = scene.addMesh.bind(scene);
    scene.addMesh = (mesh, recursive) => {
      tag(mesh);
      addMesh(mesh, recursive);
    };
    scene.onNewTransformNodeAddedObservable.add(tag);
  }

  /** Tag a node (and, through parenting, its children) as part of a system. */
  tag(node: Node, system: MeshSystem) {
    this.tags.set(node, system);
  }

  /** Tag every mesh no system has claimed yet (used after async loads). */
  claimUntagged(system: MeshSystem) {
    for (const m of this.scene?.meshes ?? []) if (!this.systemOf(m, false)) this.tags.set(m, system);
  }

  scope<T>(key: string, fn: () => T): T {
    this.begin(key);
    try {
      return fn();
    } finally {
      this.end(key);
    }
  }

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
      this.hookScene();
      this.resetWindow();
      this.intervals.length = 0;
      this.lastFrameStart = 0;
    }
    try {
      this.gpu?.setEnabled(on);
    } catch (err) {
      console.warn('[perf] GPU timing unavailable', err);
      this.gpu = null;
      this.gpuName = 'not available';
    }
    if (!on) this.stack.length = 0;
  }

  private hookScene() {
    const scene = this.scene;
    const engine = this.engine;
    if (!scene || !engine || this.sceneHooked) return;
    this.sceneHooked = true;
    this.gpu = this.createGpuTimer(engine);

    // every render target (shadow cascades, G-buffer, depth, light-shaft occluders…)
    const proto = RenderTargetTexture.prototype as unknown as { _render: (...a: unknown[]) => void; __keliaPerf?: boolean };
    if (!proto.__keliaPerf) {
      proto.__keliaPerf = true;
      const orig = proto._render;
      const self = this;
      proto._render = function (this: RenderTargetTexture, ...args: unknown[]) {
        if (!self.enabled) return orig.apply(this, args);
        const key = 'rtt:' + this.name;
        self.begin(key, this.name, this.renderTarget);
        try {
          return orig.apply(this, args);
        } finally {
          self.end(key);
        }
      };
    }
    const on = <T>(obs: { add(fn: (v: T) => void): unknown }, fn: () => void) => obs.add(() => this.enabled && fn());
    on(scene.onBeforeAnimationsObservable, () => this.begin('r:anim'));
    on(scene.onAfterAnimationsObservable, () => this.end('r:anim'));
    on(scene.onBeforeActiveMeshesEvaluationObservable, () => this.begin('r:cull'));
    on(scene.onAfterActiveMeshesEvaluationObservable, () => this.end('r:cull'));
    on(scene.onBeforeDrawPhaseObservable, () => this.begin('draw', 'scene draw'));
    on(scene.onAfterDrawPhaseObservable, () => this.end('draw'));
    // probe: hide one system for the length of the render
    let hidden: AbstractMesh[] = [];
    let particlesWere = true;
    scene.onBeforeRenderObservable.add(() => {
      const sys = this.probeSystem;
      if (!sys) return;
      if (sys === 'particles') {
        particlesWere = scene.particlesEnabled;
        scene.particlesEnabled = false;
        return;
      }
      for (const m of scene.meshes) {
        if (m.isVisible && this.systemOf(m) === sys) {
          m.isVisible = false;
          hidden.push(m);
        }
      }
    });
    scene.onAfterRenderObservable.add(() => {
      if (this.probeSystem === 'particles') scene.particlesEnabled = particlesWere;
      for (const m of hidden) m.isVisible = true;
      hidden = [];
    });
  }

  private createGpuTimer(engine: AbstractEngine): GpuTimer | null {
    try {
      const e = engine as WebGPUEngineLike;
      if (engine.isWebGPU) {
        if (!e.enabledExtensions?.includes('timestamp-query')) return null;
        this.gpuName = 'WebGPU timestamp queries';
        return new WebGPUTimer(e);
      }
      const gl = (engine as unknown as { _gl?: WebGL2RenderingContext })._gl;
      const ext = gl?.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
      if (!gl || !ext) return null;
      this.gpuName = 'WebGL2 timer queries';
      return new WebGLTimer(gl, ext);
    } catch {
      return null;
    }
  }

  /** Attach timing to post-processes we have not seen yet. */
  private hookPostProcesses() {
    const scene = this.scene!;
    const all = new Set<PostProcess>([...scene.postProcesses, ...(this.engine?.postProcesses ?? []), ...((scene.activeCamera as unknown as { _postProcesses?: (PostProcess | null)[] })?._postProcesses ?? []).filter((p): p is PostProcess => !!p)]);
    for (const pp of all) {
      if (this.hooked.has(pp)) continue;
      this.hooked.add(pp);
      const key = 'pp:' + pp.name;
      pp.onApplyObservable.add(() => this.enabled && this.begin(key, pp.name));
      pp.onAfterRenderObservable.add(() => this.enabled && this.end(key));
    }
  }

  // ---------------------------------------------------------------- scopes

  begin(key: string, pass: string | null = null, wrapper?: RenderTargetWrapper | null) {
    this.cat.push(key);
    if (!this.enabled) return;
    this.stack.push({ key, t0: performance.now(), child: 0, pass });
    if (pass !== null) this.gpu?.switchTo(pass, wrapper);
  }

  end(key: string) {
    // pop the category stack up to the matching key (robust to throws)
    const ci = this.cat.lastIndexOf(key);
    if (ci >= 0) this.cat.length = ci;
    if (!this.enabled) return;
    let i = this.stack.length - 1;
    while (i >= 0 && this.stack[i].key !== key) i--;
    if (i < 0) return;
    const now = performance.now();
    const e = this.stack[i];
    this.stack.length = i;
    const dur = now - e.t0;
    this.cur.set(key, (this.cur.get(key) ?? 0) + dur - e.child);
    const parent = this.stack[i - 1];
    if (parent) parent.child += dur;
    if (e.pass !== null) {
      // back to the enclosing pass, or the in-between work
      let p = i - 1;
      while (p >= 0 && this.stack[p].pass === null) p--;
      this.gpu?.switchTo(p >= 0 ? this.stack[p].pass! : 'frame other', undefined, true);
    }
  }

  /** Network traffic and the time spent handling it (outside the frame). */
  netMessage(bytes: number) {
    if (!this.enabled) return;
    this.win.netMsgs++;
    this.win.netBytes += bytes;
  }

  // ---------------------------------------------------------------- frames

  frameBegin() {
    this.cat.length = 0;
    if (!this.enabled) return;
    const now = performance.now();
    if (this.lastFrameStart) {
      const dt = now - this.lastFrameStart;
      this.win.frameMs += dt;
      this.win.intervals++;
      this.intervals.push(dt);
      if (this.intervals.length > 600) this.intervals.splice(0, this.intervals.length - 600);
      this.hist.frame[this.hist.head] = dt;
    }
    this.lastFrameStart = now;
    this.stack.length = 0;
    this.frameId = this.engine?.frameId ?? this.frameId + 1;
    this.gpu?.frameBegin(this.frameId);
    // Babylon only resets its draw-call counter when instrumentation asks it to
    this.drawCounter()?.fetchNewFrame();
    this.probeFrame();
  }

  frameEnd() {
    if (!this.enabled) return;
    this.gpu?.frameEnd();
    const w = this.win;
    w.frames++;
    w.drawCalls += this.drawCounter()?.current ?? 0;
    let update = 0;
    let render = 0;
    for (const [k, v] of this.cur) {
      w.sum.set(k, (w.sum.get(k) ?? 0) + v);
      if (v > (w.peak.get(k) ?? 0)) w.peak.set(k, v);
      if (k === 'render' || k === 'draw' || k.startsWith('r:') || k.startsWith('rtt:') || k.startsWith('pp:')) render += v;
      else if (k !== 'network') update += v;
    }
    const h = this.hist;
    h.update[h.head] = update;
    h.render[h.head] = render;
    h.gpu[h.head] = NaN;
    this.frameHead.set(this.frameId, h.head);
    if (this.probing) this.probeCpu(render);
    h.head = (h.head + 1) % RING;
    this.cur.clear();
    this.gpu?.poll((label, frame, ns) => this.gpuSample(label, frame, ns));
    if (performance.now() - w.t0 > 500) this.publish();
  }

  /** Ring index of each recent frame, so late GPU results land on the graph. */
  private frameHead = new Map<number, number>();

  private gpuSample(label: string, frame: number, ns: number) {
    const ms = ns / 1e6;
    if (!(ms >= 0 && ms < 1000)) return;
    const w = this.win;
    w.gpu.set(label, (w.gpu.get(label) ?? 0) + ms);
    w.gpuFrames.add(frame);
    const total = (this.gpuFrames.get(frame) ?? 0) + ms;
    this.gpuFrames.set(frame, total);
    const head = this.frameHead.get(frame);
    if (head !== undefined) this.hist.gpu[head] = total;
  }

  private resetWindow() {
    const w = this.win;
    w.t0 = performance.now();
    w.frames = 0;
    w.frameMs = 0;
    w.intervals = 0;
    w.sum.clear();
    w.peak.clear();
    w.gpu.clear();
    w.gpuFrames.clear();
    w.netMsgs = 0;
    w.netBytes = 0;
    w.drawCalls = 0;
  }

  private drawCounter() {
    return (this.engine as unknown as { _drawCalls?: { current: number; fetchNewFrame(): void } } | null)?._drawCalls;
  }

  private publish() {
    const w = this.win;
    const scene = this.scene!;
    const n = Math.max(1, w.frames);
    const secs = (performance.now() - w.t0) / 1000;
    this.hookPostProcesses();
    this.gpu?.resetLabels?.();
    // drop old per-frame bookkeeping
    for (const k of this.gpuFrames.keys()) if (k < this.frameId - 240) this.gpuFrames.delete(k);
    for (const k of this.frameHead.keys()) if (k < this.frameId - RING) this.frameHead.delete(k);

    const rows = (filter: (k: string) => boolean): PerfRow[] =>
      [...w.sum].filter(([k]) => filter(k)).map(([key, s]) => ({ key, label: systemLabel(key), ms: s / n, peak: w.peak.get(key) ?? 0 })).sort((a, b) => b.ms - a.ms);
    const isRender = (k: string) => k === 'render' || k === 'draw' || k.startsWith('r:') || k.startsWith('rtt:') || k.startsWith('pp:');
    const update = rows((k) => !isRender(k));
    const render = rows(isRender);
    const updateMs = update.filter((r) => r.key !== 'network').reduce((a, r) => a + r.ms, 0);
    const renderMs = render.reduce((a, r) => a + r.ms, 0);

    let gpu: GpuRow[] = [];
    let gpuMs: number | null = null;
    if (this.gpu && w.gpuFrames.size) {
      const gn = w.gpuFrames.size;
      const merged = new Map<string, GpuRow>();
      for (const [label, ms] of w.gpu) {
        const parts = label.split(' + ');
        const p = prettyPass(parts[0]);
        const nice = parts.length > 1 ? parts.map((x) => prettyPass(x).label).join(' + ') : p.label;
        const row = merged.get(nice) ?? { label: nice, group: p.group, ms: 0 };
        row.ms += ms / gn;
        merged.set(nice, row);
      }
      gpu = [...merged.values()].sort((a, b) => b.ms - a.ms);
      gpuMs = gpu.reduce((a, r) => a + r.ms, 0);
    }

    const sorted = [...this.intervals].sort((a, b) => a - b);
    const low1 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] : 0;
    const frameMs = w.frameMs / Math.max(1, w.intervals);

    // what is on screen, per system
    const content = new Map<string, { meshes: number; tris: number; draws: number }>();
    let tris = 0;
    const active = scene.getActiveMeshes();
    for (let i = 0; i < active.length; i++) {
      const m = active.data[i];
      const sys = this.systemOf(m) ?? 'other';
      const c = content.get(sys) ?? { meshes: 0, tris: 0, draws: 0 };
      const thin = (m as unknown as { thinInstanceCount?: number }).thinInstanceCount ?? 0;
      const isInstance = (m as unknown as { sourceMesh?: unknown }).sourceMesh !== undefined;
      const t = (m.getTotalIndices() / 3) * (thin > 0 ? thin : 1);
      c.meshes++;
      c.tris += t;
      if (!isInstance) c.draws += m.subMeshes?.length ?? 1;
      tris += t;
      content.set(sys, c);
    }
    let particles = 0;
    for (const ps of scene.particleSystems) particles += ps.getActiveCount();

    // the per-system table: CPU from scopes, GPU from the probe or from passes
    const cpuOf = (...keys: string[]) => keys.reduce((a, k) => a + (w.sum.get(k) ?? 0) / n, 0);
    const passGroup = (g: PassGroup) => (gpuMs === null ? null : gpu.filter((r) => r.group === g).reduce((a, r) => a + r.ms, 0));
    const probe = this.probeResult;
    const sysRow = (key: string, cpuKeys: string[], label = systemLabel(key)): SystemRow => {
      const c = content.get(key) ?? { meshes: 0, tris: 0, draws: 0 };
      const pr = probe?.costs[key];
      return { key, label, cpu: cpuOf(...cpuKeys), gpu: pr ? pr.gpu : null, gpuLive: false, ...c };
    };
    const rttCpu = (re: RegExp) => [...w.sum.keys()].filter((k) => (k.startsWith('rtt:') || k.startsWith('pp:')) && re.test(prettyPass(k.slice(k.indexOf(':') + 1)).group));
    const systems: SystemRow[] = [
      sysRow('terrain', ['terrain']),
      sysRow('grass', ['grass']),
      sysRow('foliage', ['foliage']),
      sysRow('water', ['water']),
      sysRow('props', ['props']),
      sysRow('sky', ['sky']),
      sysRow('ambient', ['ambient']),
      sysRow('secrets', ['secrets']),
      sysRow('characters', ['player', 'remotes', 'monsters', 'r:anim']),
      sysRow('fx', ['fx', 'combat']),
      { ...sysRow('particles', []), meshes: 0, tris: 0, draws: 0, label: `Particles (${particles} live)` },
      { key: 'shadows', label: 'Shadows', cpu: cpuOf(...rttCpu(/Shadows/)), gpu: passGroup('Shadows'), gpuLive: true, meshes: 0, tris: 0, draws: 0 },
      { key: 'post', label: 'Post-processing', cpu: cpuOf('postfx', ...rttCpu(/Ambient|Depth|Light|Bloom|Grading/)), gpu: gpuMs === null ? null : gpu.filter((r) => r.group !== 'Shadows' && r.group !== 'Scene draw' && r.group !== 'Other').reduce((a, r) => a + r.ms, 0), gpuLive: true, meshes: 0, tris: 0, draws: 0 },
      { key: 'ui', label: 'HUD & UI', cpu: cpuOf('ui'), gpu: null, gpuLive: false, meshes: 0, tris: 0, draws: 0 },
      { key: 'network', label: 'Network', cpu: cpuOf('network'), gpu: null, gpuLive: false, meshes: 0, tris: 0, draws: 0 },
    ];
    const other = content.get('other');
    if (other) systems.push({ key: 'other', label: 'Untagged meshes', cpu: null, gpu: probe?.costs.other?.gpu ?? null, gpuLive: false, ...other });

    const drawCalls = Math.round(w.drawCalls / n);
    this.snapshot = {
      fps: frameMs > 0 ? 1000 / frameMs : 0,
      frameMs,
      low1,
      worst: sorted[sorted.length - 1] ?? 0,
      cpuMs: updateMs + renderMs,
      updateMs,
      renderMs,
      gpuMs,
      update,
      render,
      gpu,
      systems,
      drawCalls,
      activeMeshes: active.length,
      tris,
      meshes: scene.meshes.length,
      materials: scene.materials.length,
      textures: scene.textures.length,
      particles,
      netMsgs: w.netMsgs / secs,
      netKB: w.netBytes / 1024 / secs,
    };
    this.resetWindow();
  }

  // ---------------------------------------------------------------- systems

  /** Which system a mesh belongs to: its own tag, a parent's, or a guess. */
  systemOf(m: AbstractMesh, guess = true): string | null {
    const cached = this.resolved.get(m);
    if (cached) return cached;
    let n: Node | null = m;
    let sys: string | null = null;
    while (n && !sys) {
      sys = this.tags.get(n) ?? null;
      n = n.parent;
    }
    if (!sys && !guess) return null;
    if (!sys) {
      const name = m.name.toLowerCase();
      if (m.skeleton) sys = 'characters';
      else if (/^(ring|tele|telein|slash|missile|arrow|orb|flash|fx)\b/.test(name)) sys = 'fx';
      else sys = 'other';
    }
    if (sys !== 'other') this.resolved.set(m, sys);
    return sys;
  }

  // ---------------------------------------------------------------- probe

  private probing = false;
  private probeSystem: string | null = null;
  private probePlan: { sys: string | null; frames: number }[] = [];
  private probeIndex = 0;
  private probeFrameInPhase = 0;
  private probeFrames = new Map<number, number>(); // frameId -> phase index
  private probeCpuSamples: number[][] = [];
  private probeTail = 0;
  private static readonly PHASE = 24;
  private static readonly SETTLE = 6;

  /** Hide each system in turn and measure how much cheaper the frame gets. */
  startProbe() {
    if (!this.enabled || this.probing || !this.scene) return;
    const systems: string[] = [...MESH_SYSTEMS, 'particles'];
    if (this.scene.meshes.some((m) => this.systemOf(m) === 'other')) systems.push('other');
    const plan: { sys: string | null; frames: number }[] = [{ sys: null, frames: Profiler.PHASE }];
    systems.forEach((s, i) => {
      plan.push({ sys: s, frames: Profiler.PHASE });
      if (i % 3 === 2) plan.push({ sys: null, frames: Profiler.PHASE });
    });
    plan.push({ sys: null, frames: Profiler.PHASE });
    this.probePlan = plan;
    this.probeIndex = 0;
    this.probeFrameInPhase = 0;
    this.probeFrames.clear();
    this.probeCpuSamples = plan.map(() => []);
    this.probeTail = 0;
    this.probing = true;
    this.probe = { progress: 0, label: 'Baseline' };
  }

  private probeFrame() {
    if (!this.probing) return;
    if (this.probeIndex >= this.probePlan.length) {
      // let the last GPU results arrive, then score
      this.probeSystem = null;
      if (++this.probeTail > 12) this.finishProbe();
      return;
    }
    const phase = this.probePlan[this.probeIndex];
    this.probeSystem = phase.sys;
    if (this.probeFrameInPhase >= Profiler.SETTLE) this.probeFrames.set(this.frameId, this.probeIndex);
    const total = this.probePlan.reduce((a, p) => a + p.frames, 0);
    const done = this.probePlan.slice(0, this.probeIndex).reduce((a, p) => a + p.frames, 0) + this.probeFrameInPhase;
    this.probe = { progress: done / total, label: phase.sys ? systemLabel(phase.sys) : 'Baseline' };
    if (++this.probeFrameInPhase >= phase.frames) {
      this.probeIndex++;
      this.probeFrameInPhase = 0;
    }
  }

  private probeCpu(renderMs: number) {
    const phase = this.probeFrames.get(this.frameId);
    if (phase !== undefined) this.probeCpuSamples[phase].push(renderMs);
  }

  private finishProbe() {
    this.probing = false;
    this.probeSystem = null;
    this.probe = null;
    const median = (a: number[]) => {
      if (!a.length) return NaN;
      const s = [...a].sort((x, y) => x - y);
      return s[Math.floor(s.length / 2)];
    };
    const gpuByPhase: number[][] = this.probePlan.map(() => []);
    for (const [frame, phase] of this.probeFrames) {
      const g = this.gpuFrames.get(frame);
      if (g !== undefined) gpuByPhase[phase].push(g);
    }
    const base = this.probePlan.map((p, i) => (p.sys === null ? i : -1)).filter((i) => i >= 0);
    const baseGpu = median(base.flatMap((i) => gpuByPhase[i]));
    const baseCpu = median(base.flatMap((i) => this.probeCpuSamples[i]));
    const costs: ProbeResult['costs'] = {};
    this.probePlan.forEach((p, i) => {
      if (!p.sys) return;
      // compare against the nearest baselines on both sides, which cancels slow drift (camera moving, sun setting)
      const before = Math.max(...base.filter((b) => b < i));
      const after = Math.min(...base.filter((b) => b > i));
      const localGpu = median([...gpuByPhase[before], ...gpuByPhase[after]]);
      const localCpu = median([...this.probeCpuSamples[before], ...this.probeCpuSamples[after]]);
      const g = median(gpuByPhase[i]);
      const c = median(this.probeCpuSamples[i]);
      costs[p.sys] = {
        gpu: Number.isFinite(g) && Number.isFinite(localGpu) ? Math.max(0, localGpu - g) : null,
        cpu: Number.isFinite(c) && Number.isFinite(localCpu) ? Math.max(0, localCpu - c) : 0,
      };
    });
    this.probeResult = { at: Date.now(), baselineGpu: Number.isFinite(baseGpu) ? baseGpu : null, baselineCpu: baseCpu, costs };
    this.onProbeDone?.();
  }

  get probeRunning() {
    return this.probing;
  }
}

export const perf = new Profiler();
