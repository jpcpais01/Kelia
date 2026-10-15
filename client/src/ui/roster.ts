// Hold-Tab roster: everyone in the realm with level, class, whereabouts and
// ping. Shown while Tab is held, refreshed a few times a second.
import { CLASSES, MAX_PLAYERS, POINTS_OF_INTEREST, type ClassId } from '@kelia/shared';
import { h, icon } from './dom';

export interface RosterEntry {
  id: number;
  name: string;
  cls: ClassId;
  level: number;
  hp: number; // 0..1
  dead: boolean;
  x: number;
  z: number;
  ping: number | null;
  you: boolean;
}

const CLASS_ICON: Record<ClassId, string> = { vanguard: 'sword', ranger: 'bow', arcanist: 'staff' };
const PLACES = POINTS_OF_INTEREST.filter((p) => !p.hidden);

/** The nearest named place (secret spots stay secret). */
function whereabouts(x: number, z: number) {
  let best = PLACES[0];
  let bestD = Infinity;
  for (const p of PLACES) {
    const d = Math.hypot(p.pos[0] - x, p.pos[1] - z);
    if (d < bestD) (bestD = d), (best = p);
  }
  return bestD < 70 ? best.name : `near ${best.name}`;
}

function pingTier(ms: number) {
  return ms < 80 ? 'good' : ms < 160 ? 'ok' : 'bad';
}

export class Roster {
  private el: HTMLElement;
  private body: HTMLElement;
  private count: HTMLElement;
  private sub: HTMLElement;
  private shown = false;

  constructor(parent: HTMLElement) {
    this.count = h('span', { class: 'roster-count' });
    this.sub = h('div', { class: 'roster-sub' });
    this.body = h('div', { class: 'roster-rows' });
    this.el = h(
      'div',
      { class: 'roster panel', role: 'dialog', 'aria-label': 'Players online' },
      h('div', { class: 'roster-head' }, h('h2', null, 'ADVENTURERS'), this.count),
      this.sub,
      h('div', { class: 'roster-row roster-cols' }, h('span'), h('span', null, 'Name'), h('span', null, 'Lv'), h('span', null, 'Class'), h('span', null, 'Whereabouts'), h('span', { class: 'r' }, 'Ping')),
      this.body,
      h('div', { class: 'roster-foot' }, 'Hold ', h('span', { class: 'kbd' }, 'Tab'), ' to see who is in Kelia'),
    );
    parent.append(this.el);
  }

  get visible() {
    return this.shown;
  }

  show(on: boolean) {
    if (on === this.shown) return;
    this.shown = on;
    this.el.classList.toggle('on', on);
  }

  /** camYaw matches the minimap so the arrows point the way you'd walk. */
  update(entries: RosterEntry[], me: { x: number; z: number }, camYaw: number, dayLabel: string) {
    const sorted = [...entries].sort((a, b) => Number(b.you) - Number(a.you) || b.level - a.level || a.name.localeCompare(b.name));
    this.count.textContent = `${entries.length} / ${MAX_PLAYERS}`;
    this.sub.textContent = entries.length === 1 ? `Just you so far · ${dayLabel}` : `${entries.length} heroes in the valley · ${dayLabel}`;
    const a = -camYaw;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    this.body.replaceChildren(
      ...sorted.map((e) => {
        const cls = CLASSES[e.cls];
        const dx = e.x - me.x;
        const dz = e.z - me.z;
        const dist = Math.hypot(dx, dz);
        // same screen transform as the minimap: rotate (dx, -dz) by -camYaw
        const sx = dx * ca + dz * sa;
        const sy = dx * sa - dz * ca;
        const deg = (Math.atan2(sx, -sy) * 180) / Math.PI;
        const where = h(
          'span',
          { class: 'roster-where' },
          e.you || dist < 4
            ? null
            : h('i', { class: 'roster-arrow', style: `transform: rotate(${deg.toFixed(0)}deg)` }),
          whereabouts(e.x, e.z),
          e.you ? null : h('em', null, dist < 1000 ? `${Math.round(dist)} m` : `${(dist / 1000).toFixed(1)} km`),
        );
        const ping = e.ping == null || e.ping <= 0 ? h('span', { class: 'roster-ping r' }, '–') : h('span', { class: `roster-ping r ${pingTier(e.ping)}` }, h('b', null, h('i'), h('i'), h('i')), `${e.ping}`);
        return h(
          'div',
          { class: `roster-row${e.you ? ' you' : ''}${e.dead ? ' dead' : ''}`, style: `--cls:${cls.color}` },
          h('span', { class: 'roster-crest' }, icon(CLASS_ICON[e.cls], 14)),
          h('span', { class: 'roster-name' }, h('span', null, e.name), e.you ? h('small', null, 'you') : null, h('i', { class: 'roster-hp' }, h('i', { style: `transform: scaleX(${Math.max(0, Math.min(1, e.hp)).toFixed(3)})` }))),
          h('span', { class: 'roster-lv' }, String(e.level)),
          h('span', { class: 'roster-cls' }, cls.name),
          where,
          ping,
        );
      }),
    );
  }
}
