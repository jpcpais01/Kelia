// The big world map (M, or click the minimap): a full-screen, north-up chart of
// Kelia painted from the live terrain, with every named place, the heroes
// around you, nearby monsters and a marker you can drop to plan a route.
import { FOREST, HILLS, LAKE, PLAYABLE_HALF, POINTS_OF_INTEREST, RIVER_POINTS, UPDRAFTS, WORLD_HALF, type PointOfInterest } from '@kelia/shared';
import { h, icon } from './dom';
import { closeWindow, openOverlay } from './windows';

export interface MapMarker {
  x: number;
  z: number;
}

export interface WorldMapState {
  px: number;
  pz: number;
  yaw: number;
  camYaw: number;
  others: { x: number; z: number; yaw: number; name: string }[];
  enemies: { x: number; z: number; boss: boolean }[];
  discovered: string[];
  zone: string;
}

/** Badge glyphs per kind of place (24×24 line paths, like the UI icons). */
const GLYPH: Record<PointOfInterest['kind'], string> = {
  village: 'M4 20V11l8-6 8 6v9M9 20v-6h6v6',
  shrine: 'M6 20V8M12 20V5M18 20V8M4 20h16',
  ruins: 'M4 20h16M6 20V9h3v11M15 20v-8h3v8M10 9h4M6 9l1-3M18 12l-1-2',
  waterfall: 'M4 5h16M8 5v10M12 5v14M16 5v9M6 19c2 1 4 1 6 0s4-1 6 0',
  viewpoint: 'M3 20 10 8l4 6 2-3 5 9zM10 8l1.5 2.5',
  lake: 'M3 10c3-2 6 2 9 0s6-2 9 0M3 15c3-2 6 2 9 0s6-2 9 0',
  forest: 'M12 3 6 12h3l-4 6h14l-4-6h3zM12 18v3',
  hills: 'M2 19 9 9l4 5 3-4 6 9z',
  secret: 'm12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
};
const glyphs = new Map<string, Path2D>();
const glyph = (k: PointOfInterest['kind']) => {
  let p = glyphs.get(k);
  if (!p) glyphs.set(k, (p = new Path2D(GLYPH[k])));
  return p;
};

/** Big labels for whole regions, drawn under the markers when zoomed out. */
const REGIONS: { name: string; x: number; z: number; size: number }[] = [
  { name: HILLS.name, x: HILLS.center[0] + 30, z: HILLS.center[1] - 80, size: 1 },
  { name: FOREST.name, x: FOREST.center[0] + 10, z: FOREST.center[1] - 70, size: 1 },
  { name: LAKE.name, x: LAKE.center[0] - 10, z: LAKE.center[1] + 18, size: 0.8 },
];

const MIN_ZOOM_FACTOR = 0.9; // of "whole world fits"
const MAX_ZOOM = 7; // css px per metre

export class WorldMap {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tip: HTMLElement;
  private zoneEl: HTMLElement;
  private scaleEl: HTMLElement;
  private image: HTMLCanvasElement | null = null;
  private state: WorldMapState | null = null;
  private raf = 0;
  private w = 0;
  private hgt = 0;
  private dpr = 1;
  /** View centre (world metres) and zoom (css px per metre), eased towards the targets. */
  private cx = 0;
  private cz = 0;
  private zoom = 1;
  private tcx = 0;
  private tcz = 0;
  private tzoom = 1;
  private follow = true;
  private drag: { x: number; y: number; cx: number; cz: number; moved: boolean } | null = null;
  private hover: { x: number; y: number } | null = null;
  private hoverPoi: PointOfInterest | null = null;
  private t0 = performance.now();
  private last = 0;
  /** A pin the player dropped on the map; the minimap points to it too. */
  marker: MapMarker | null = null;

  constructor(
    private paint: () => HTMLCanvasElement,
    /** Teleport to a place (clicking its badge), and what the tooltip says about that. */
    private travel: { go(poi: PointOfInterest): void; note(poi: PointOfInterest): string },
  ) {
    this.canvas = h('canvas', { class: 'wm-canvas' });
    this.ctx = this.canvas.getContext('2d')!;
    this.tip = h('div', { class: 'wm-tip' });
    this.zoneEl = h('div', { class: 'wm-zone' });
    this.scaleEl = h('div', { class: 'wm-scale' }, h('i'), h('span'));
    const btn = (title: string, ic: string, fn: () => void) => h('button', { class: 'icon-btn', title, onclick: fn }, icon(ic, 18));
    const legendRow = (cls: string, label: string) => h('div', null, h('i', { class: cls }), label);
    this.el = h(
      'div',
      { class: 'world-map interactive' },
      h(
        'div',
        { class: 'wm-frame panel' },
        this.canvas,
        h('div', { class: 'wm-head' }, h('div', { class: 'wm-title' }, 'KELIA'), this.zoneEl),
        h(
          'div',
          { class: 'wm-tools' },
          btn('Zoom in', 'plus', () => this.zoomBy(1.6)),
          btn('Zoom out', 'minus', () => this.zoomBy(1 / 1.6)),
          btn('Centre on me', 'locate', () => this.recenter()),
          btn('Close (M)', 'close', () => closeWindow()),
        ),
        h(
          'div',
          { class: 'wm-legend' },
          legendRow('lg-you', 'You'),
          legendRow('lg-ally', 'Heroes'),
          legendRow('lg-foe', 'Monsters'),
          legendRow('lg-place', 'Places'),
          legendRow('lg-wind', 'Updrafts'),
          legendRow('lg-pin', 'Your marker'),
        ),
        this.scaleEl,
        h('div', { class: 'wm-hint' }, h('span', { class: 'kbd' }, 'Wheel'), 'zoom', h('span', { class: 'kbd' }, 'Drag'), 'pan', h('span', { class: 'kbd' }, 'Click'), 'a place to teleport, anywhere else for a marker', h('span', { class: 'kbd' }, 'M'), 'close'),
        this.tip,
      ),
    );
    this.bindPointer();
  }

  isOpen = false;

  open(s: WorldMapState) {
    if (!this.image) this.image = this.paint();
    this.state = s;
    openOverlay(this.el, () => this.onClosed());
    this.isOpen = true;
    requestAnimationFrame(() => {
      this.measure();
      const fit = this.fitZoom();
      this.follow = true;
      this.tzoom = Math.min(MAX_ZOOM, fit * 1.9);
      this.zoom = this.tzoom * 0.82; // a gentle push-in as it opens
      this.cx = this.tcx = s.px;
      this.cz = this.tcz = s.pz;
      this.clampTarget();
      this.cx = this.tcx;
      this.cz = this.tcz;
      this.last = performance.now();
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(this.frame);
    });
  }

  update(s: WorldMapState) {
    this.state = s;
    if (this.marker && Math.hypot(this.marker.x - s.px, this.marker.z - s.pz) < 6) this.marker = null;
  }

  private onClosed() {
    this.isOpen = false;
    cancelAnimationFrame(this.raf);
    this.drag = null;
    this.tip.classList.remove('on');
  }

  // ------------------------------------------------------------ view maths
  private measure() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (r.width !== this.w || r.height !== this.hgt || dpr !== this.dpr) {
      this.w = r.width;
      this.hgt = r.height;
      this.dpr = dpr;
      this.canvas.width = Math.max(1, Math.round(r.width * dpr));
      this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    }
  }

  private fitZoom() {
    return Math.min(this.w, this.hgt) / (PLAYABLE_HALF * 2 + 40);
  }

  /** World → css pixels on the canvas (north up, east right). */
  private toScreen(x: number, z: number): [number, number] {
    return [this.w / 2 + (x - this.cx) * this.zoom, this.hgt / 2 - (z - this.cz) * this.zoom];
  }

  private toWorld(sx: number, sy: number, zoom = this.zoom, cx = this.cx, cz = this.cz): [number, number] {
    return [cx + (sx - this.w / 2) / zoom, cz - (sy - this.hgt / 2) / zoom];
  }

  private clampTarget() {
    this.tzoom = Math.max(this.fitZoom() * MIN_ZOOM_FACTOR, Math.min(MAX_ZOOM, this.tzoom));
    // keep the world under the frame: no scrolling off into the void
    const lim = (half: number) => Math.max(0, WORLD_HALF - half / this.tzoom);
    const lx = lim(this.w / 2);
    const lz = lim(this.hgt / 2);
    this.tcx = Math.max(-lx, Math.min(lx, this.tcx));
    this.tcz = Math.max(-lz, Math.min(lz, this.tcz));
  }

  private zoomBy(f: number, sx = this.w / 2, sy = this.hgt / 2) {
    // keep the world point under the cursor fixed while zooming
    const [wx, wz] = this.toWorld(sx, sy, this.tzoom, this.tcx, this.tcz);
    this.tzoom *= f;
    this.clampTarget();
    if (!this.follow || sx !== this.w / 2 || sy !== this.hgt / 2) {
      this.follow = false;
      this.tcx = wx - (sx - this.w / 2) / this.tzoom;
      this.tcz = wz + (sy - this.hgt / 2) / this.tzoom;
      this.clampTarget();
    }
  }

  private recenter() {
    this.follow = true;
    if (this.state) {
      this.tcx = this.state.px;
      this.tcz = this.state.pz;
      this.clampTarget();
    }
  }

  // ------------------------------------------------------------ input
  private bindPointer() {
    const c = this.canvas;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      this.zoomBy(Math.pow(1.0018, -e.deltaY * (e.deltaMode === 1 ? 30 : 1)), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 2) return;
      c.setPointerCapture(e.pointerId);
      this.drag = { x: e.clientX, y: e.clientY, cx: this.tcx, cz: this.tcz, moved: false };
    });
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      this.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
      const d = this.drag;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 5) return;
      d.moved = true;
      this.follow = false;
      this.tcx = d.cx - dx / this.tzoom;
      this.tcz = d.cz + dy / this.tzoom;
      this.clampTarget();
      // panning follows the hand exactly, no easing lag
      this.cx = this.tcx;
      this.cz = this.tcz;
    });
    c.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      if (!d || d.moved) return;
      const r = c.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      if (e.button === 2) {
        this.marker = null;
        return;
      }
      // click a place to teleport there
      const s = this.state;
      if (s) {
        for (const poi of POINTS_OF_INTEREST) {
          if (poi.hidden && !s.discovered.includes(poi.id)) continue;
          const [x, y] = this.toScreen(poi.pos[0], poi.pos[1]);
          if (Math.hypot(sx - x, sy - y) < 16) {
            this.travel.go(poi);
            return;
          }
        }
      }
      // click a pin to lift it, anywhere else to drop it
      if (this.marker) {
        const [mx, my] = this.toScreen(this.marker.x, this.marker.z);
        if (Math.hypot(sx - mx, sy - my - 12) < 16) {
          this.marker = null;
          return;
        }
      }
      const [wx, wz] = this.toWorld(sx, sy);
      if (Math.abs(wx) < PLAYABLE_HALF && Math.abs(wz) < PLAYABLE_HALF) this.marker = { x: wx, z: wz };
    });
    c.addEventListener('pointerleave', () => (this.hover = null));
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('dblclick', (e) => {
      const r = c.getBoundingClientRect();
      this.zoomBy(2, e.clientX - r.left, e.clientY - r.top);
    });
  }

  // ------------------------------------------------------------ drawing
  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.measure();
    const s = this.state;
    if (!s || !this.w) return;
    if (this.follow) {
      this.tcx = s.px;
      this.tcz = s.pz;
      this.clampTarget();
    }
    const k = 1 - Math.exp(-dt * 12);
    this.zoom += (this.tzoom - this.zoom) * k;
    if (!this.drag?.moved) {
      this.cx += (this.tcx - this.cx) * k;
      this.cz += (this.tcz - this.cz) * k;
    }
    this.draw(s, (now - this.t0) / 1000);
  };

  private draw(s: WorldMapState, t: number) {
    const { ctx, zoom } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#0d1016';
    ctx.fillRect(0, 0, this.w, this.hgt);

    // terrain
    if (this.image) {
      const [x0, y0] = this.toScreen(-WORLD_HALF, WORLD_HALF);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      // the image's row 0 is the south edge (z = -half), so flip it north-up
      ctx.save();
      ctx.translate(x0, y0 + WORLD_HALF * 2 * zoom);
      ctx.scale(1, -1);
      ctx.drawImage(this.image, 0, 0, WORLD_HALF * 2 * zoom, WORLD_HALF * 2 * zoom);
      ctx.restore();
    }
    // the mountain wall beyond the valley: shade it into the frame
    {
      const [ax, ay] = this.toScreen(-PLAYABLE_HALF, PLAYABLE_HALF);
      const span = PLAYABLE_HALF * 2 * zoom;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, this.w, this.hgt);
      ctx.roundRect(ax, ay, span, span, 60 * zoom);
      ctx.fillStyle = 'rgba(8, 10, 14, 0.38)';
      ctx.fill('evenodd');
      ctx.restore();
    }
    this.drawGrid();

    // the Silverrun's name along its course
    if (zoom > 0.75) {
      const a = RIVER_POINTS[6];
      const b = RIVER_POINTS[7];
      const [sx, sy] = this.toScreen((a[0] + b[0]) / 2 + 14, (a[1] + b[1]) / 2);
      const [bx, by] = this.toScreen(b[0], b[1]);
      const [ax2, ay2] = this.toScreen(a[0], a[1]);
      let ang = Math.atan2(by - ay2, bx - ax2);
      if (Math.abs(ang) > Math.PI / 2) ang += Math.PI;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(ang);
      this.label('S I L V E R R U N', 0, 0, `italic 500 ${Math.round(10 + zoom * 2)}px ${SERIF}`, 'rgba(200, 228, 245, 0.75)');
      ctx.restore();
    }
    // regions
    const regionAlpha = Math.max(0, Math.min(1, (3.2 - zoom) / 1.6));
    if (regionAlpha > 0.02) {
      for (const r of REGIONS) {
        const [x, y] = this.toScreen(r.x, r.z);
        const size = Math.round(Math.min(30, 13 + zoom * 9) * r.size);
        this.label(spaced(r.name.toUpperCase()), x, y, `600 ${size}px ${SERIF}`, `rgba(246, 223, 170, ${0.55 * regionAlpha})`);
      }
    }

    // your marker
    if (this.marker) {
      const [mx, my] = this.toScreen(this.marker.x, this.marker.z);
      const bob = Math.sin(t * 3) * 2;
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 210, 120, 0.7)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 6]);
      const [px, py] = this.toScreen(s.px, s.pz);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(mx, my);
      ctx.stroke();
      ctx.setLineDash([]);
      const ring = (t * 0.8) % 1;
      ctx.strokeStyle = `rgba(255, 210, 120, ${1 - ring})`;
      ctx.beginPath();
      ctx.ellipse(mx, my, 6 + ring * 16, (6 + ring * 16) * 0.5, 0, 0, Math.PI * 2);
      ctx.stroke();
      drawPin(ctx, mx, my - bob);
      const dist = Math.hypot(this.marker.x - s.px, this.marker.z - s.pz);
      this.label(`${Math.round(dist)} m`, mx, my + 16, `600 11px ${SANS}`, '#ffe3a6');
      ctx.restore();
    }

    // updrafts: a little turning swirl, named when you hover it
    for (const u of UPDRAFTS) {
      const [x, y] = this.toScreen(u.pos[0], u.pos[1]);
      if (x < -40 || y < -40 || x > this.w + 40 || y > this.hgt + 40) continue;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-t * 1.5);
      ctx.strokeStyle = 'rgba(214, 240, 255, 0.95)';
      ctx.lineWidth = 1.8;
      ctx.lineCap = 'round';
      for (let arm = 0; arm < 3; arm++) {
        ctx.beginPath();
        for (let i = 0; i <= 12; i++) {
          const a = (arm / 3) * Math.PI * 2 + i * 0.32;
          const r = 1.5 + i * 0.6;
          if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
          else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        ctx.stroke();
      }
      ctx.restore();
      if (this.hover && Math.hypot(this.hover.x - x, this.hover.y - y) < 14) this.label(u.name, x, y - 16, `600 11px ${SANS}`, '#d6f0ff');
    }

    // places
    this.hoverPoi = null;
    for (const poi of POINTS_OF_INTEREST) {
      const known = s.discovered.includes(poi.id);
      if (poi.hidden && !known) continue;
      const [x, y] = this.toScreen(poi.pos[0], poi.pos[1]);
      if (x < -60 || y < -60 || x > this.w + 60 || y > this.hgt + 60) continue;
      const hot = !!this.hover && !this.drag?.moved && Math.hypot(this.hover.x - x, this.hover.y - y) < 16;
      if (hot) this.hoverPoi = poi;
      this.drawPlace(poi, x, y, known, hot);
    }

    // monsters you can sense nearby
    for (const e of s.enemies) {
      const [x, y] = this.toScreen(e.x, e.z);
      ctx.fillStyle = e.boss ? '#ff3b2f' : 'rgba(255, 107, 94, 0.9)';
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, e.boss ? 6.5 : 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (e.boss) {
        ctx.strokeStyle = `rgba(255, 59, 47, ${0.5 + 0.4 * Math.sin(t * 5)})`;
        ctx.beginPath();
        ctx.arc(x, y, 11, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // other heroes
    for (const o of s.others) {
      const [x, y] = this.toScreen(o.x, o.z);
      drawArrow(ctx, x, y, o.yaw, 0.75, '#7fd7ff');
      this.label(o.name, x, y - 15, `600 12px ${SANS}`, '#bfeaff');
    }

    // you: view cone, pulse, arrow
    {
      const [x, y] = this.toScreen(s.px, s.pz);
      const cone = ctx.createRadialGradient(x, y, 0, x, y, 70);
      cone.addColorStop(0, 'rgba(255, 244, 214, 0.38)');
      cone.addColorStop(1, 'rgba(255, 244, 214, 0)');
      ctx.fillStyle = cone;
      ctx.beginPath();
      ctx.moveTo(x, y);
      // camYaw 0 looks north (screen up); canvas angles start at east
      const a = s.camYaw - Math.PI / 2;
      ctx.arc(x, y, 70, a - 0.55, a + 0.55);
      ctx.closePath();
      ctx.fill();
      const p = (t * 0.7) % 1;
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.55 * (1 - p)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 9 + p * 22, 0, Math.PI * 2);
      ctx.stroke();
      drawArrow(ctx, x, y, s.yaw, 1, '#ffffff');
    }

    // compass rose
    this.drawCompass(this.w - 64, this.hgt - 120);
    this.updateScale();
    this.updateTip(s);
    if (this.zoneEl.textContent !== s.zone) this.zoneEl.textContent = s.zone;
  }

  private drawPlace(poi: PointOfInterest, x: number, y: number, known: boolean, hot: boolean) {
    const ctx = this.ctx;
    const secret = poi.kind === 'secret';
    const r = hot ? 15 : 12.5;
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = 8;
    ctx.fillStyle = known ? 'rgba(22, 20, 16, 0.88)' : 'rgba(18, 20, 26, 0.7)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = secret ? '#c9a6ff' : known ? '#e8c27a' : 'rgba(232, 194, 122, 0.45)';
    ctx.stroke();
    ctx.translate(x - r * 0.62, y - r * 0.62);
    ctx.scale((r * 1.24) / 24, (r * 1.24) / 24);
    ctx.lineWidth = 1.9;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = secret ? '#e2d0ff' : known ? '#f6dfaa' : 'rgba(246, 223, 170, 0.6)';
    ctx.stroke(glyph(poi.kind));
    ctx.restore();
    if (this.zoom > 0.6 || hot) {
      const size = poi.kind === 'village' ? 15 : 13;
      this.label(poi.name, x, y + r + 12, `600 ${size}px ${SERIF}`, known ? (secret ? '#e2d0ff' : '#f6dfaa') : 'rgba(243, 239, 230, 0.62)');
    }
  }

  private drawGrid() {
    const ctx = this.ctx;
    const step = this.zoom > 2.4 ? 50 : 100;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let v = -WORLD_HALF + (WORLD_HALF % step); v <= WORLD_HALF; v += step) {
      const [x] = this.toScreen(v, 0);
      const [, y] = this.toScreen(0, v);
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, this.hgt);
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(this.w, Math.round(y) + 0.5);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawCompass(x: number, y: number) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = 'rgba(232, 194, 122, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, 26, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 4; i++) {
      ctx.rotate(Math.PI / 2);
      ctx.fillStyle = i === 3 ? '#f6dfaa' : 'rgba(246, 223, 170, 0.45)';
      ctx.beginPath();
      ctx.moveTo(0, -30);
      ctx.lineTo(5, -4);
      ctx.lineTo(-5, -4);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    this.label('N', x, y - 42, `700 13px ${SERIF}`, '#f6dfaa');
  }

  private updateScale() {
    // a round distance that is 60–150 px long
    const opts = [10, 20, 25, 50, 100, 200, 250, 500];
    const m = opts.find((v) => v * this.zoom >= 60) ?? 500;
    const bar = this.scaleEl.firstChild as HTMLElement;
    const w = `${Math.round(m * this.zoom)}px`;
    if (bar.style.width !== w) bar.style.width = w;
    const txt = `${m} m`;
    const span = this.scaleEl.lastChild as HTMLElement;
    if (span.textContent !== txt) span.textContent = txt;
  }

  private updateTip(s: WorldMapState) {
    const poi = this.hoverPoi;
    const tip = this.tip;
    if (!poi || !this.hover) {
      tip.classList.remove('on');
      this.canvas.style.cursor = this.drag?.moved ? 'grabbing' : 'crosshair';
      return;
    }
    this.canvas.style.cursor = 'pointer';
    const known = s.discovered.includes(poi.id);
    const dist = Math.round(Math.hypot(poi.pos[0] - s.px, poi.pos[1] - s.pz));
    const note = this.travel.note(poi);
    const key = `${poi.id}|${known}|${dist}|${note}`;
    if (tip.dataset.key !== key) {
      tip.dataset.key = key;
      tip.replaceChildren(
        h('b', null, poi.name),
        h('p', null, poi.description),
        h('small', null, `${known ? 'Discovered' : 'Not yet visited'} · ${dist} m away`),
        ...(note ? [h('div', { class: 'wm-travel' }, icon('blink', 14), note)] : []),
      );
    }
    const left = Math.min(this.hover.x + 18, this.w - 260);
    tip.style.transform = `translate(${left}px, ${Math.max(8, this.hover.y - 20)}px)`;
    tip.classList.add('on');
  }

  private label(text: string, x: number, y: number, font: string, color: string) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(8, 10, 14, 0.75)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.restore();
  }
}

const SERIF = "Cinzel, 'Trajan Pro', Georgia, serif";
const SANS = "'Inter Variable', Inter, system-ui, sans-serif";
const spaced = (s: string) => s.split('').join(' ');

/** A facing arrow: yaw 0 points north (screen up), turning clockwise. */
function drawArrow(ctx: CanvasRenderingContext2D, x: number, y: number, yaw: number, scale: number, fill: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(yaw);
  ctx.scale(scale, scale);
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = 6;
  ctx.fillStyle = fill;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(0, -12);
  ctx.lineTo(8.5, 9);
  ctx.lineTo(0, 4.5);
  ctx.lineTo(-8.5, 9);
  ctx.closePath();
  ctx.stroke();
  ctx.fill();
  ctx.restore();
}

/** A map pin whose tip sits on (x, y). */
export function drawPin(ctx: CanvasRenderingContext2D, x: number, y: number, scale = 1) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = 6;
  ctx.fillStyle = '#ffcf6e';
  ctx.strokeStyle = 'rgba(40, 26, 6, 0.85)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-3, -7, -9, -11, -9, -17);
  ctx.arc(0, -17, 9, Math.PI, 0);
  ctx.bezierCurveTo(9, -11, 3, -7, 0, 0);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.stroke();
  ctx.fillStyle = 'rgba(40, 26, 6, 0.85)';
  ctx.beginPath();
  ctx.arc(0, -17, 3.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
