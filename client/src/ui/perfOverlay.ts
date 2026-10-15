// The F3 performance overlay: FPS and frame-time graph, CPU time per game
// system, GPU time per render pass, and a per-part table that answers "what
// costs the most?". F4 measures the GPU cost of each world system by hiding
// it for a moment (the screen flickers while it runs).
import type { AbstractEngine } from '@babylonjs/core';
import { PASS_GROUP_COLORS, perf, type PerfRow, type PerfSnapshot, type SystemRow } from '../core/perf';

type Mode = 'off' | 'full' | 'compact';
const MODE_KEY = 'kelia.perfOverlay';
const MODES: Mode[] = ['off', 'full', 'compact'];

export interface PerfInfo {
  api: string;
  gpu: string;
  quality: () => string;
  ping: () => number | null;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const ms = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v < 0.005 ? '0' : v.toFixed(v >= 10 ? 1 : d));
const big = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)));
const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
};

class PerfOverlay {
  private mode: Mode = 'off';
  private root: HTMLElement | null = null;
  private canvas!: HTMLCanvasElement;
  private els: Record<string, HTMLElement> = {};
  private lastSnap: PerfSnapshot | null = null;
  private frame = 0;
  private engine: AbstractEngine | null = null;
  private info: PerfInfo | null = null;
  onModeChange: ((on: boolean) => void) | null = null;

  init(engine: AbstractEngine, info: PerfInfo) {
    this.engine = engine;
    this.info = info;
    let saved: Mode = 'off';
    try {
      saved = (localStorage.getItem(MODE_KEY) as Mode) || 'off';
    } catch {
      /* ignore */
    }
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.code === 'F3') {
          e.preventDefault();
          this.setMode(MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]);
        } else if (e.code === 'F4' && this.mode !== 'off') {
          e.preventDefault();
          perf.startProbe();
        }
      },
      true,
    );
    perf.onProbeDone = () => this.renderText(true);
    if (MODES.includes(saved)) this.setMode(saved);
  }

  get visible() {
    return this.mode !== 'off';
  }

  setMode(mode: Mode) {
    this.mode = mode;
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* ignore */
    }
    perf.setEnabled(mode !== 'off');
    if (mode === 'off') {
      this.root?.remove();
      this.root = null;
    } else {
      if (!this.root) this.build();
      this.root!.classList.toggle('compact', mode === 'compact');
    }
    this.onModeChange?.(mode !== 'off');
  }

  toggle(on: boolean) {
    this.setMode(on ? 'full' : 'off');
  }

  private build() {
    const root = document.createElement('div');
    root.className = 'perf';
    root.innerHTML = `
      <div class="perf-head">
        <div class="perf-fps"><b data-el="fps">—</b><span>FPS</span></div>
        <div class="perf-frame" data-el="frame"></div>
        <div class="perf-bound" data-el="bound"></div>
      </div>
      <canvas class="perf-graph" width="356" height="84"></canvas>
      <div class="perf-legend"><i style="--c:#5fc9b5"></i>CPU update<i style="--c:#6f8ff0"></i>CPU render<i style="--c:#ffb35c"></i>GPU<i style="--c:rgba(255,255,255,.75)"></i>Frame</div>
      <div class="perf-totals" data-el="totals"></div>
      <div class="perf-more">
        <section>
          <h4>Where the time goes <span class="perf-probe" data-el="probe"></span></h4>
          <div data-el="systems"></div>
        </section>
        <section><h4>GPU · render passes <span data-el="gpuNote"></span></h4><div data-el="gpuBar" class="perf-stack"></div><div data-el="gpu"></div></section>
        <section><h4>CPU · game &amp; world update <span>avg · peak</span></h4><div data-el="update"></div></section>
        <section><h4>CPU · rendering <span>avg · peak</span></h4><div data-el="render"></div></section>
        <section><h4>Scene</h4><div data-el="scene" class="perf-grid"></div></section>
        <div class="perf-foot">
          <button data-act="probe">Measure GPU per part <span class="kbd">F4</span></button>
          <button data-act="copy">Copy report</button>
          <span class="perf-keys"><span class="kbd">F3</span> compact / hide</span>
        </div>
      </div>`;
    root.querySelectorAll<HTMLElement>('[data-el]').forEach((el) => (this.els[el.dataset.el!] = el));
    this.canvas = root.querySelector('canvas')!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = 356 * dpr;
    this.canvas.height = 84 * dpr;
    root.querySelector('[data-act="probe"]')!.addEventListener('click', () => perf.startProbe());
    root.querySelector('[data-act="copy"]')!.addEventListener('click', (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      void navigator.clipboard?.writeText(this.report()).then(() => {
        btn.textContent = 'Copied ✓';
        setTimeout(() => (btn.textContent = 'Copy report'), 1500);
      });
    });
    document.body.append(root);
    this.root = root;
  }

  /** Called once per frame from the render loop. */
  update() {
    if (!this.root) return;
    this.frame++;
    if (this.frame % 2 === 0) this.drawGraph();
    if (perf.snapshot !== this.lastSnap || perf.probeRunning) this.renderText(perf.snapshot !== this.lastSnap);
  }

  // ---------------------------------------------------------------- graph

  private drawGraph() {
    const c = this.canvas;
    const g = c.getContext('2d')!;
    const W = c.width;
    const H = c.height;
    const dpr = W / 356;
    const h = perf.hist;
    const n = h.frame.length;
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, h.frame[i], h.update[i] + h.render[i], Number.isFinite(h.gpu[i]) ? h.gpu[i] : 0);
    const top = peak > 40 ? Math.min(100, Math.ceil(peak / 10) * 10) : peak > 20 ? 40 : 20;
    const y = (v: number) => H - (Math.min(v, top) / top) * (H - 2 * dpr);
    g.clearRect(0, 0, W, H);
    const bw = W / n;
    for (let k = 0; k < n; k++) {
      const i = (h.head + k) % n;
      const x = k * bw;
      const u = h.update[i];
      const r = h.render[i];
      g.fillStyle = 'rgba(95,201,181,0.85)';
      g.fillRect(x, y(u), Math.max(1, bw - 0.2), H - y(u));
      g.fillStyle = 'rgba(111,143,240,0.85)';
      g.fillRect(x, y(u + r), Math.max(1, bw - 0.2), y(u) - y(u + r));
    }
    const line = (arr: Float32Array, color: string, width: number) => {
      g.strokeStyle = color;
      g.lineWidth = width * dpr;
      g.beginPath();
      let pen = false;
      for (let k = 0; k < n; k++) {
        const v = arr[(h.head + k) % n];
        if (!Number.isFinite(v) || v <= 0) {
          pen = false;
          continue;
        }
        const px = k * bw + bw / 2;
        if (pen) g.lineTo(px, y(v));
        else g.moveTo(px, y(v));
        pen = true;
      }
      g.stroke();
    };
    line(h.gpu, '#ffb35c', 1.6);
    line(h.frame, 'rgba(255,255,255,0.75)', 1);
    g.font = `${9 * dpr}px Inter Variable, system-ui, sans-serif`;
    for (const [v, label] of [[1000 / 60, '60 fps'], [1000 / 30, '30 fps']] as const) {
      if (v > top) continue;
      g.strokeStyle = 'rgba(255,255,255,0.18)';
      g.lineWidth = dpr;
      g.setLineDash([3 * dpr, 3 * dpr]);
      g.beginPath();
      g.moveTo(0, y(v));
      g.lineTo(W, y(v));
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = 'rgba(255,255,255,0.45)';
      g.fillText(label, 3 * dpr, y(v) - 3 * dpr);
    }
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.fillText(`${top} ms`, W - 34 * dpr, 10 * dpr);
  }

  // ---------------------------------------------------------------- text

  private verdict(s: PerfSnapshot): [string, string] {
    const frame = s.frameMs;
    if (s.gpuMs !== null && s.gpuMs > s.cpuMs * 1.15 && s.gpuMs > frame * 0.7) return ['GPU-bound', 'bad'];
    if (s.cpuMs > frame * 0.7 && (s.gpuMs === null || s.cpuMs >= s.gpuMs)) return ['CPU-bound', 'bad'];
    if (frame < 1000 / 55 && Math.abs(frame - 1000 / 60) < 1.2) return ['Capped at 60 Hz', 'good'];
    if (frame < 18) return ['Smooth', 'good'];
    return ['Waiting on browser / vsync', 'warn'];
  }

  private renderText(newSnap: boolean) {
    const s = perf.snapshot;
    const els = this.els;
    this.lastSnap = s;
    this.renderProbe();
    if (!s || !newSnap) return;
    els.fps.textContent = String(Math.round(s.fps));
    els.fps.className = s.fps >= 55 ? 'good' : s.fps >= 30 ? 'warn' : 'bad';
    els.frame.innerHTML = `${ms(s.frameMs, 1)} ms<span>1% low ${ms(s.low1, 1)} · worst ${ms(s.worst, 1)}</span>`;
    const [v, cls] = this.verdict(s);
    els.bound.textContent = v;
    els.bound.className = 'perf-bound ' + cls;
    els.totals.innerHTML =
      `<div><span>CPU</span><b>${ms(s.cpuMs)}</b> ms<em>update ${ms(s.updateMs)} · render ${ms(s.renderMs)}</em></div>` +
      `<div><span>GPU</span><b>${s.gpuMs === null ? 'n/a' : ms(s.gpuMs)}</b>${s.gpuMs === null ? '' : ' ms'}<em>${esc(perf.gpuName)}</em></div>`;
    if (this.mode === 'compact') return;

    els.systems.innerHTML = this.systemsTable(s.systems);
    // GPU passes
    if (s.gpuMs === null) {
      els.gpuNote.textContent = '';
      els.gpuBar.innerHTML = '';
      els.gpu.innerHTML = `<p class="perf-note">This browser does not expose GPU timers${this.info?.api === 'webgpu' ? ' (WebGPU “timestamp-query”)' : ' (WebGL2 “EXT_disjoint_timer_query”)'}. CPU numbers below are still exact.</p>`;
    } else {
      els.gpuNote.textContent = `${ms(s.gpuMs)} ms`;
      const groups = new Map<string, number>();
      for (const r of s.gpu) groups.set(r.group, (groups.get(r.group) ?? 0) + r.ms);
      els.gpuBar.innerHTML = [...groups]
        .sort((a, b) => b[1] - a[1])
        .map(([gname, v]) => `<i style="flex:${v};--c:${PASS_GROUP_COLORS[gname as keyof typeof PASS_GROUP_COLORS]}" title="${esc(gname)} ${ms(v)} ms"></i>`)
        .join('');
      const max = Math.max(0.001, ...s.gpu.map((r) => r.ms));
      els.gpu.innerHTML = s.gpu
        .slice(0, 16)
        .map((r) => `<div class="perf-row"><i class="dot" style="--c:${PASS_GROUP_COLORS[r.group]}"></i><span class="l" title="${esc(r.group)}">${esc(r.label)}</span><span class="bar"><i style="width:${(r.ms / max) * 100}%;--c:${PASS_GROUP_COLORS[r.group]}"></i></span><b>${ms(r.ms)}</b></div>`)
        .join('');
    }
    els.update.innerHTML = this.cpuRows(s.update);
    els.render.innerHTML = this.cpuRows(s.render);
    const eng = this.engine!;
    const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
    const ping = this.info?.ping();
    const cells: [string, string][] = [
      ['Renderer', `${this.info?.api === 'webgpu' ? 'WebGPU' : 'WebGL2'} · ${esc(this.info?.quality() ?? '')}`],
      ['Resolution', `${eng.getRenderWidth()}×${eng.getRenderHeight()}`],
      ['Draw calls', big(s.drawCalls)],
      ['Triangles (main)', big(s.tris)],
      ['Meshes', `${s.activeMeshes} / ${s.meshes}`],
      ['Materials · textures', `${s.materials} · ${s.textures}`],
      ['Particles', big(s.particles)],
      ['Network', ping ? `${Math.round(ping)} ms · ${s.netMsgs.toFixed(0)} msg/s · ${s.netKB.toFixed(1)} KB/s` : 'offline'],
      ['JS heap', heap ? `${(heap / 1048576).toFixed(0)} MB` : '—'],
      ['GPU', esc(this.info?.gpu ?? '')],
    ];
    els.scene.innerHTML = cells.map(([k, val]) => `<span>${k}</span><b title="${val}">${val}</b>`).join('');
  }

  private cpuRows(rows: PerfRow[]) {
    const max = Math.max(0.001, ...rows.map((r) => r.ms));
    return rows
      .filter((r) => r.ms >= 0.005 || r.peak >= 0.05)
      .slice(0, 18)
      .map((r) => `<div class="perf-row"><span class="l">${esc(r.label)}</span><span class="bar"><i style="width:${(r.ms / max) * 100}%"></i></span><b>${ms(r.ms)}</b><em class="${r.peak > 4 ? 'warn' : ''}">${ms(r.peak, 1)}</em></div>`)
      .join('');
  }

  private systemsTable(rows: SystemRow[]) {
    const cost = (r: SystemRow) => Math.max(r.cpu ?? 0, r.gpu ?? 0);
    const sorted = [...rows].sort((a, b) => cost(b) - cost(a) || b.tris - a.tris);
    const max = Math.max(0.001, ...sorted.map(cost));
    const head = `<div class="perf-sys perf-sys-h"><span class="l">Part</span><span>CPU</span><span>GPU</span><span>Tris</span></div>`;
    return (
      head +
      sorted
        .filter((r) => cost(r) >= 0.01 || r.tris > 0 || r.gpuLive)
        .map((r) => {
          const gpu = r.gpu === null ? `<span class="na" title="${r.gpuLive ? 'No GPU timers' : 'Press F4 to measure'}">${r.gpuLive ? 'n/a' : 'F4'}</span>` : `<span>${ms(r.gpu)}</span>`;
          return `<div class="perf-sys"><span class="l">${esc(r.label)}</span><span>${r.cpu === null ? '—' : ms(r.cpu)}</span>${gpu}<span class="t">${r.tris ? big(r.tris) : ''}</span><i style="width:${(cost(r) / max) * 100}%"></i></div>`;
        })
        .join('')
    );
  }

  private renderProbe() {
    const el = this.els.probe;
    if (!el) return;
    if (perf.probe) {
      el.innerHTML = `measuring ${esc(perf.probe.label)}… <i><b style="width:${Math.round(perf.probe.progress * 100)}%"></b></i>`;
      el.className = 'perf-probe running';
    } else if (perf.probeResult) {
      el.textContent = `GPU measured ${ago(perf.probeResult.at)}`;
      el.className = 'perf-probe';
    } else {
      el.textContent = 'GPU per part: press F4';
      el.className = 'perf-probe';
    }
  }

  // ---------------------------------------------------------------- report

  private report() {
    const s = perf.snapshot;
    if (!s) return 'No data yet.';
    const e = this.engine!;
    const L: string[] = [];
    L.push(`Kelia performance report · ${new Date().toISOString()}`);
    L.push(`${this.info?.api} · ${this.info?.gpu} · ${this.info?.quality()} · ${e.getRenderWidth()}x${e.getRenderHeight()}`);
    L.push(`FPS ${s.fps.toFixed(1)} · frame ${ms(s.frameMs)} ms · 1% low ${ms(s.low1)} ms · worst ${ms(s.worst)} ms · ${this.verdict(s)[0]}`);
    L.push(`CPU ${ms(s.cpuMs)} ms (update ${ms(s.updateMs)}, render ${ms(s.renderMs)}) · GPU ${s.gpuMs === null ? 'n/a' : ms(s.gpuMs) + ' ms'} (${perf.gpuName})`);
    L.push(`Draw calls ${s.drawCalls} · tris ${big(s.tris)} · meshes ${s.activeMeshes}/${s.meshes} · particles ${s.particles}`);
    L.push('', 'Part                         CPU ms   GPU ms   tris');
    for (const r of s.systems) L.push(`${r.label.padEnd(28)} ${ms(r.cpu).padStart(6)}   ${(r.gpu === null ? '—' : ms(r.gpu)).padStart(6)}   ${r.tris ? big(r.tris) : ''}`);
    if (perf.probeResult) L.push(`(GPU per part measured ${ago(perf.probeResult.at)}, baseline GPU ${ms(perf.probeResult.baselineGpu)} ms)`);
    if (s.gpu.length) {
      L.push('', 'GPU passes                                   ms');
      for (const r of s.gpu) L.push(`${r.label.slice(0, 44).padEnd(44)} ${ms(r.ms).padStart(6)}`);
    }
    L.push('', 'CPU update                       avg    peak');
    for (const r of s.update) L.push(`${r.label.padEnd(30)} ${ms(r.ms).padStart(6)}  ${ms(r.peak, 1).padStart(6)}`);
    L.push('', 'CPU render                       avg    peak');
    for (const r of s.render) L.push(`${r.label.slice(0, 30).padEnd(30)} ${ms(r.ms).padStart(6)}  ${ms(r.peak, 1).padStart(6)}`);
    return L.join('\n');
  }
}

export const perfOverlay = new PerfOverlay();
