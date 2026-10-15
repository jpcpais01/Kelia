// In-game HUD: health and XP, skill bar, minimap, chat, name plates, toasts
// and the small menu (settings, patch notes, controls).
import { Vector3, type Camera, type Engine, type AbstractEngine, Matrix } from '@babylonjs/core';
import { CHAT_MAX_LENGTH, CLASSES, ITEMS, POINTS_OF_INTEREST, SKILL_UNLOCK, WORLD_HALF, type CharacterData, type PointOfInterest } from '@kelia/shared';
import { h, icon, mount } from './dom';
import type { Heightmap } from '@kelia/shared';
import { renderMapImage } from './mapImage';
import { drawPin, WorldMap, type WorldMapState } from './worldMap';
import { Roster } from './roster';
import { closeWindow } from './windows';
import { fullscreenSupported, onFullscreenChange, toggleFullscreen } from './fullscreen';

export interface Plate {
  el: HTMLElement;
  hp: HTMLElement;
  bubble: HTMLElement | null;
  bubbleUntil: number;
}

export interface HudCallbacks {
  onChat(text: string): void;
  openSettings(): void;
  openPatchNotes(): void;
  openHelp(): void;
  openInventory(): void;
  openMap(): void;
  travel(poi: PointOfInterest): void;
  travelNote(poi: PointOfInterest): string;
}

export class Hud {
  readonly el: HTMLElement;
  private hpFill: HTMLElement;
  private hpTrail: HTMLElement;
  private hpLabel: HTMLElement;
  private xpFill: HTMLElement;
  private level: HTMLElement;
  private nameEl: HTMLElement;
  private subEl: HTMLElement;
  private chatLog: HTMLElement;
  private chatInput: HTMLInputElement;
  private chatWrap: HTMLElement;
  private toastArea: HTMLElement;
  private plates: HTMLElement;
  private mapCanvas: HTMLCanvasElement;
  private mapCtx: CanvasRenderingContext2D;
  private mapImage: HTMLCanvasElement | null = null;
  readonly worldMap: WorldMap;
  private zoneEl: HTMLElement;
  private clockEl: HTMLElement;
  private hint: HTMLElement;
  private crosshair: HTMLElement;
  private floats: HTMLElement;
  private bossEl: HTMLElement;
  private bossFill: HTMLElement;
  private bossName: HTMLElement;
  private hurtEl: HTMLElement;
  private castEl: HTMLElement;
  private castFill: HTMLElement;
  private castLabel: HTMLElement;
  private deathEl: HTMLElement | null = null;
  notesDot: HTMLElement;
  slots: HTMLElement[] = [];
  chatOpen = false;
  readonly roster: Roster;
  private plateMap = new Map<number, Plate>();

  constructor(cb: HudCallbacks, hm: Heightmap, splat?: Uint8Array) {
    this.hpFill = h('i', { class: 'fill' });
    this.hpTrail = h('i', { class: 'trail' });
    this.hpLabel = h('span', { class: 'label' });
    this.xpFill = h('i');
    this.level = h('div', { class: 'level-badge' }, '1');
    this.nameEl = h('div', { class: 'portrait-name' });
    this.subEl = h('div', { class: 'portrait-sub' });
    this.chatLog = h('div', { class: 'chat-log' });
    this.chatInput = h('input', { class: 'input chat-input', maxlength: CHAT_MAX_LENGTH, placeholder: 'Say something…  (/wave /cheer /dance /sit /who /roll)', spellcheck: false });
    this.chatWrap = h('div', { class: 'chat interactive' }, this.chatLog, this.chatInput, h('div', { class: 'chat-hint' }, h('span', { class: 'kbd' }, 'Enter'), 'to chat'));
    this.toastArea = h('div', { class: 'toast-area' });
    this.plates = h('div', { class: 'nameplates' });
    this.mapCanvas = h('canvas', { width: 376, height: 376 });
    this.mapCtx = this.mapCanvas.getContext('2d')!;
    this.zoneEl = h('div', { class: 'zone-label' });
    this.clockEl = h('div', { class: 'clock' });
    this.hint = h('div', { class: 'center-hint' }, h('span', { class: 'kbd' }, 'W A S D'), 'move', h('span', { class: 'kbd' }, 'Shift'), 'sprint', h('span', { class: 'kbd' }, 'Space'), 'jump', h('span', { class: 'kbd' }, 'Click'), 'look & attack', h('span', { class: 'kbd' }, '1 2 3'), 'skills', h('span', { class: 'kbd' }, 'Q'), 'dodge', h('span', { class: 'kbd' }, 'Esc'), 'free mouse');
    this.crosshair = h('div', { class: 'crosshair' });
    this.notesDot = h('span', { class: 'dot' });
    this.floats = h('div', { class: 'floats' });
    this.bossFill = h('i');
    this.bossName = h('div', { class: 'boss-name' });
    this.bossEl = h('div', { class: 'boss-bar' }, this.bossName, h('div', { class: 'boss-track' }, this.bossFill));
    this.hurtEl = h('div', { class: 'hurt' });
    this.castFill = h('i');
    this.castLabel = h('div', { class: 'cast-label' });
    this.castEl = h('div', { class: 'cast-bar' }, this.castLabel, h('div', { class: 'cast-track' }, this.castFill));

    const bottom = h(
      'div',
      { class: 'hud-bottom' },
      h('div', { class: 'skillbar' }),
      h('div', { class: 'vitals' }, this.level, h('div', { class: 'bar hp' }, this.hpTrail, this.hpFill, this.hpLabel)),
      h('div', { class: 'xpbar' }, this.xpFill),
    );
    this.el = h(
      'div',
      { class: 'hud' },
      this.hurtEl,
      this.plates,
      this.floats,
      this.bossEl,
      this.crosshair,
      h('div', { class: 'top-left' }, h('div', null, this.nameEl, this.subEl)),
      h('div', { class: 'minimap interactive', title: 'World map (M)', onclick: () => cb.openMap() }, this.mapCanvas, h('div', { class: 'minimap-n' }, 'N'), h('span', { class: 'kbd minimap-m' }, 'M')),
      this.zoneEl,
      this.clockEl,
      h(
        'div',
        { class: 'menu-buttons interactive' },
        h('button', { class: 'icon-btn', title: 'Inventory (I)', onclick: () => cb.openInventory() }, icon('bag', 18)),
        h('button', { class: 'icon-btn', title: 'Controls', onclick: () => cb.openHelp() }, icon('keys', 18)),
        h('button', { class: 'icon-btn', title: 'Patch notes', onclick: () => cb.openPatchNotes() }, icon('scroll', 18), this.notesDot),
        h('button', { class: 'icon-btn', title: 'Settings', onclick: () => cb.openSettings() }, icon('gear', 18)),
        fullscreenButton(),
      ),
      this.toastArea,
      this.hint,
      this.castEl,
      this.chatWrap,
      bottom,
    );
    this.roster = new Roster(this.el);
    mount(this.el);
    setTimeout(() => (this.hint.style.opacity = '0'), 14000);

    this.chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const t = this.chatInput.value.trim();
        if (t) cb.onChat(t);
        this.closeChat();
      } else if (e.key === 'Escape') this.closeChat();
    });
    this.chatInput.addEventListener('blur', () => this.closeChat());
    setTimeout(() => (this.mapImage = renderMapImage(hm, 512, splat)), 50);
    // the big map gets a sharper chart with height lines; paint it once things have settled
    let chart: HTMLCanvasElement | null = null;
    const paintChart = () => (chart ??= renderMapImage(hm, 1024, splat, 6));
    this.worldMap = new WorldMap(paintChart, { go: (poi) => cb.travel(poi), note: (poi) => cb.travelNote(poi) });
    setTimeout(paintChart, 6000);
  }

  setCharacter(c: CharacterData, maxHp: number) {
    const cls = CLASSES[c.cls];
    this.nameEl.textContent = c.name;
    this.subEl.textContent = `${cls.name} · ${cls.weaponStyle}`;
    this.level.textContent = String(c.level);
    this.setHp(c.hp, maxHp);
    this.renderSkillbar(c);
  }

  private renderSkillbar(c: CharacterData) {
    const cls = CLASSES[c.cls];
    const bar = this.el.querySelector('.skillbar')!;
    const slot = (key: string, ic: string, title: string, extra = '') => h('div', { class: 'slot' + extra, title }, icon(ic, 24), h('span', { class: 'key' }, key), h('i', { class: 'cd' }), h('span', { class: 'cdt' }));
    const potions = c.inventory.find((s) => s.id === 'potion_small');
    const potion = slot('R', 'potion', ITEMS.potion_small.name, ' sep');
    potion.append(h('span', { class: 'qty' }, String(potions?.qty ?? 0)));
    this.slots = [
      slot('LMB', cls.combo[0].icon, `${cls.combo.map((c) => c.name).filter((n, i, a) => a.indexOf(n) === i).join(' → ')}: hold or click to attack`),
      ...cls.skills.map((s, i) => slot(s.key, s.icon, `${s.name} (unlocks at level ${SKILL_UNLOCK[i]}): ${s.description}`)),
      slot('Q', 'dodge', `${cls.dodge.name}: ${cls.dodge.description}`),
      potion,
    ];
    bar.replaceChildren(...this.slots);
    this.setUnlocks(c.level);
  }

  /** Grey out skills the character hasn't learned yet. */
  setUnlocks(level: number) {
    SKILL_UNLOCK.forEach((lv, i) => this.slots[1 + i]?.classList.toggle('locked', level < lv));
  }

  /** frac = remaining fraction of the cooldown (0 = ready). */
  setCooldown(slot: number, frac: number, secondsLeft: number) {
    const el = this.slots[slot];
    if (!el) return;
    const cd = el.querySelector('.cd') as HTMLElement;
    const t = el.querySelector('.cdt') as HTMLElement;
    const p = `${Math.round(Math.max(0, frac) * 100)}%`;
    if (cd.style.getPropertyValue('--p') !== p) cd.style.setProperty('--p', p);
    const txt = secondsLeft > 0.05 ? (secondsLeft < 1 ? secondsLeft.toFixed(1) : String(Math.ceil(secondsLeft))) : '';
    if (t.textContent !== txt) t.textContent = txt;
    if (frac <= 0 && el.dataset.cd === '1') {
      el.dataset.cd = '0';
      this.pulse(slot);
    } else if (frac > 0) el.dataset.cd = '1';
  }

  pulse(slot: number) {
    const el = this.slots[slot];
    if (!el) return;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  setPotions(n: number) {
    const q = this.slots[5]?.querySelector('.qty');
    if (q) q.textContent = String(n);
    this.slots[5]?.classList.toggle('empty', n <= 0);
  }

  // ---------------------------------------------------------------- combat feedback
  /** Floating text at a world position (damage numbers, XP). */
  floatText(engine: AbstractEngine | Engine, camera: Camera, pos: Vector3, text: string, kind: string) {
    void engine;
    const v = Vector3.TransformCoordinates(pos, camera.getTransformationMatrix());
    if (v.z <= 0 || v.z >= 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) return;
    const x = ((v.x + 1) / 2) * window.innerWidth + (Math.random() - 0.5) * 30;
    const y = ((1 - v.y) / 2) * window.innerHeight;
    const el = h('div', { class: 'float ' + kind, style: `left:${x}px;top:${y}px` }, text);
    this.floats.append(el);
    while (this.floats.children.length > 40) this.floats.firstChild?.remove();
    setTimeout(() => el.remove(), 1200);
  }

  /** Red edge flash when you get hurt (strength 0..1). */
  hurt(strength: number) {
    this.hurtEl.style.transition = 'none';
    this.hurtEl.style.opacity = String(Math.min(1, 0.35 + strength * 2));
    void this.hurtEl.offsetWidth;
    this.hurtEl.style.transition = 'opacity 0.7s ease';
    this.hurtEl.style.opacity = '0';
  }

  /** Low health keeps a faint pulse on screen. */
  setLowHealth(on: boolean) {
    this.el.classList.toggle('low-hp', on);
  }

  setBoss(name: string | null, frac = 1) {
    this.bossEl.classList.toggle('on', !!name);
    if (name && this.bossName.textContent !== name) this.bossName.textContent = name;
    this.bossFill.style.transform = `scaleX(${Math.max(0, Math.min(1, frac))})`;
  }

  levelUp(level: number) {
    const el = h('div', { class: 'levelup' }, h('div', { class: 't1' }, 'Level up'), h('div', { class: 't2' }, String(level)));
    this.toastArea.prepend(el);
    setTimeout(() => el.remove(), 3600);
  }

  showDeath(by: string, onRespawn: () => void) {
    this.hideDeath();
    const btn = h('button', { class: 'btn primary', disabled: true, onclick: () => onRespawn() }, 'Return to Hearthmere');
    this.deathEl = h('div', { class: 'death interactive' }, h('div', { class: 't1' }, 'You have fallen'), h('div', { class: 't2' }, `Struck down by ${by}.`), btn);
    this.el.append(this.deathEl);
    setTimeout(() => (btn.disabled = false), 2800);
  }

  hideDeath() {
    this.deathEl?.remove();
    this.deathEl = null;
  }

  setHp(hp: number, max: number) {
    const f = Math.max(0, Math.min(1, hp / max));
    this.hpFill.style.transform = `scaleX(${f})`;
    this.hpTrail.style.transform = `scaleX(${f})`;
    this.hpLabel.textContent = `${Math.ceil(hp)} / ${max}`;
  }

  setXp(frac: number, level: number) {
    this.xpFill.style.transform = `scaleX(${Math.max(0, Math.min(1, frac))})`;
    this.level.textContent = String(level);
  }

  setPointerLocked(on: boolean) {
    this.crosshair.classList.toggle('on', on);
  }

  // ---------------------------------------------------------------- chat
  openChat() {
    this.chatOpen = true;
    this.chatWrap.classList.add('open');
    this.chatInput.value = '';
    this.chatInput.focus();
  }

  closeChat() {
    this.chatOpen = false;
    this.chatWrap.classList.remove('open');
    this.chatInput.blur();
  }

  addChat(name: string, text: string, sys = false) {
    const line = h('div', { class: 'chat-line' + (sys ? ' sys' : '') }, sys ? null : h('b', null, name + ': '), text);
    this.chatLog.append(line);
    while (this.chatLog.children.length > 80) this.chatLog.firstChild?.remove();
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
    setTimeout(() => line.classList.add('old'), 12000);
  }

  // ---------------------------------------------------------------- toasts
  zoneToast(poi: PointOfInterest, discovered: boolean) {
    const el = h('div', { class: 'zone-toast' }, h('div', { class: 't1' }, discovered ? 'Discovered' : 'Entering'), h('div', { class: 't2' }, poi.name), h('div', { class: 't3' }, poi.description));
    this.toastArea.replaceChildren(el);
    setTimeout(() => el.remove(), 4300);
  }

  lootToast(name: string, color: string, qty: number) {
    const el = h('div', { class: 'panel small-toast loot', style: `--rc:${color}` }, 'Looted ', h('b', null, name), qty > 1 ? ` × ${qty}` : '');
    this.toastArea.append(el);
    setTimeout(() => el.remove(), 3100);
  }

  toast(text: string) {
    const el = h('div', { class: 'panel small-toast' }, text);
    this.toastArea.append(el);
    setTimeout(() => el.remove(), 3100);
  }

  // ---------------------------------------------------------------- name plates
  plate(id: number, name: string, level: number, kind = ''): Plate {
    let p = this.plateMap.get(id);
    if (!p) {
      const hp = h('i');
      const el = h('div', { class: 'nameplate ' + kind }, h('div', { class: 'n' }, h('small', null, String(level)), name), h('div', { class: 'hpb' }, hp));
      this.plates.append(el);
      p = { el, hp, bubble: null, bubbleUntil: 0 };
      this.plateMap.set(id, p);
    }
    return p;
  }

  setPlateLevel(id: number, level: number) {
    const s = this.plateMap.get(id)?.el.querySelector('small');
    if (s) s.textContent = String(level);
  }

  removePlate(id: number) {
    this.plateMap.get(id)?.el.remove();
    this.plateMap.delete(id);
  }

  say(id: number, text: string) {
    const p = this.plateMap.get(id);
    if (!p) return;
    p.bubble?.remove();
    p.bubble = h('div', { class: 'bubble' }, text);
    p.el.prepend(p.bubble);
    p.bubbleUntil = performance.now() + 6000;
  }

  private tmpM = new Matrix();

  /** Position name plates over heads. */
  updatePlates(engine: AbstractEngine | Engine, camera: Camera, items: { id: number; pos: Vector3; hp: number; visible: boolean }[], show: boolean) {
    const w = engine.getRenderWidth();
    const hgt = engine.getRenderHeight();
    const cw = window.innerWidth;
    const ch = window.innerHeight;
    const vp = camera.getTransformationMatrix(); // view * projection
    void this.tmpM;
    const now = performance.now();
    for (const it of items) {
      const p = this.plateMap.get(it.id);
      if (!p) continue;
      const v = Vector3.TransformCoordinates(it.pos, vp);
      const dist = Vector3.Distance(camera.globalPosition, it.pos);
      const onScreen = v.z > 0 && v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2;
      if (!it.visible || !onScreen || dist > 60 || (!show && !p.bubble)) {
        p.el.style.display = 'none';
        continue;
      }
      p.el.style.display = '';
      const x = ((v.x + 1) / 2) * cw;
      const y = ((1 - v.y) / 2) * ch;
      const s = Math.max(0.65, Math.min(1, 14 / dist));
      p.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%) scale(${s})`;
      p.el.style.opacity = String(Math.max(0, Math.min(1, (60 - dist) / 15)));
      p.hp.style.transform = `scaleX(${it.hp})`;
      if (p.bubble && now > p.bubbleUntil) {
        p.bubble.remove();
        p.bubble = null;
      }
    }
    void w;
    void hgt;
  }

  // ---------------------------------------------------------------- cast bar
  /** Show a channel ("Teleporting to …") filling over `ms`, or hide it with null. */
  setChannel(label: string | null, ms = 0) {
    const el = this.castEl;
    if (!label) {
      el.classList.remove('on');
      return;
    }
    this.castLabel.textContent = label;
    const f = this.castFill;
    f.style.transition = 'none';
    f.style.width = '0%';
    void f.offsetWidth;
    f.style.transition = `width ${ms}ms linear`;
    f.style.width = '100%';
    el.classList.add('on');
  }

  // ---------------------------------------------------------------- world map
  toggleWorldMap(s: WorldMapState) {
    if (this.worldMap.isOpen) closeWindow();
    else this.worldMap.open(s);
  }

  // ---------------------------------------------------------------- minimap
  updateMinimap(px: number, pz: number, yaw: number, camYaw: number, others: { x: number; z: number }[], discovered: string[], enemies: { x: number; z: number; boss: boolean }[] = []) {
    const ctx = this.mapCtx;
    const S = this.mapCanvas.width;
    const scale = 1.6; // canvas px per metre
    ctx.save();
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = '#10141b';
    ctx.fillRect(0, 0, S, S);
    // rotate the map so the camera's forward is up (world +z is north, flip to screen space)
    ctx.translate(S / 2, S / 2);
    ctx.rotate(-camYaw);
    ctx.scale(1, -1);
    if (this.mapImage) {
      const k = this.mapImage.width / (WORLD_HALF * 2);
      const half = (S / scale) * 0.75;
      ctx.drawImage(this.mapImage, (px - half + WORLD_HALF) * k, (pz - half + WORLD_HALF) * k, half * 2 * k, half * 2 * k, -half * scale, -half * scale, half * 2 * scale, half * 2 * scale);
    }
    // points of interest
    for (const poi of POINTS_OF_INTEREST) {
      const known = discovered.includes(poi.id);
      if (poi.hidden && !known) continue;
      const x = (poi.pos[0] - px) * scale;
      const y = (poi.pos[1] - pz) * scale;
      if (Math.hypot(x, y) > S * 0.62) continue;
      ctx.fillStyle = known ? '#f6dfaa' : 'rgba(246,223,170,0.45)';
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const e of enemies) {
      const x = (e.x - px) * scale;
      const y = (e.z - pz) * scale;
      ctx.fillStyle = e.boss ? '#ff3b2f' : 'rgba(255,107,94,0.85)';
      ctx.beginPath();
      ctx.arc(x, y, e.boss ? 7 : 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const o of others) {
      const x = (o.x - px) * scale;
      const y = (o.z - pz) * scale;
      ctx.fillStyle = '#7fd7ff';
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    // the marker dropped on the world map; pinned to the rim when it is out of range
    const mk = this.worldMap.marker;
    if (mk) {
      let x = (mk.x - px) * scale;
      let y = (mk.z - pz) * scale;
      const d = Math.hypot(x, y);
      const rim = S * 0.42;
      if (d > rim) {
        x *= rim / d;
        y *= rim / d;
      }
      // undo the flip and rotation so the pin stands upright
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, -1);
      ctx.rotate(camYaw);
      drawPin(ctx, 0, 0, 1.5);
      ctx.restore();
    }
    ctx.restore();
    // player arrow (always centre, pointing along facing relative to camera)
    ctx.save();
    ctx.translate(S / 2, S / 2);
    ctx.rotate(yaw - camYaw);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, -13);
    ctx.lineTo(9, 10);
    ctx.lineTo(0, 5);
    ctx.lineTo(-9, 10);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  }

  setZone(name: string) {
    if (this.zoneEl.textContent !== name) this.zoneEl.textContent = name;
  }

  setClock(dayTime: number) {
    const mins = Math.floor(dayTime * 24 * 60);
    const hh = Math.floor(mins / 60);
    const mm = mins % 60;
    const txt = `${String(hh).padStart(2, '0')}:${String(mm - (mm % 5)).padStart(2, '0')}`;
    if (this.clockEl.textContent !== txt) this.clockEl.textContent = txt;
  }

  get clockText() {
    return this.clockEl.textContent ?? '';
  }

  dispose() {
    this.el.remove();
  }
}

function fullscreenButton() {
  const btn = h('button', { class: 'icon-btn', onclick: () => void toggleFullscreen() }) as HTMLButtonElement;
  if (!fullscreenSupported()) btn.style.display = 'none';
  onFullscreenChange((on) => {
    btn.replaceChildren(icon(on ? 'shrink' : 'expand', 18));
    btn.title = on ? 'Exit fullscreen (F11)' : 'Fullscreen (F11)';
    btn.classList.toggle('active', on);
  });
  return btn;
}
