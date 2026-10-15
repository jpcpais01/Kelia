// Inventory and equipment: your three gear slots with your stats on the left,
// the 24 bag slots on the right. Click to equip or drink; hover to compare.
import { CLASSES, INVENTORY_SIZE, ITEMS, RARITY_COLORS, canEquip, statsFor, type CharacterData, type ItemDef } from '@kelia/shared';
import { h, icon } from './dom';
import { onWindowClose, windowFrame } from './windows';

export interface InventoryActions {
  equip(i: number): void;
  unequip(slot: 'offhand' | 'outfit'): void;
  discard(i: number): void;
}

let root: HTMLElement | null = null;
let tip: HTMLElement | null = null;

export function isInventoryOpen() {
  return !!root;
}

export function openInventory(c: CharacterData, actions: InventoryActions) {
  const wrap = windowFrame('INVENTORY', h('div', { class: 'inv' }));
  wrap.querySelector('.window')?.classList.add('wide');
  root = wrap.querySelector('.inv') as HTMLElement;
  onWindowClose(() => {
    hideTip();
    root = null;
  });
  renderInventory(c, actions);
}

/** Redraw with fresh data (no-op when closed). */
export function renderInventory(c: CharacterData, actions: InventoryActions) {
  if (!root?.isConnected) return;
  hideTip();
  const st = statsFor(c.cls, c.level, c.equipment);
  const base = statsFor(c.cls, c.level, null);
  const eq = (key: 'weapon' | 'offhand' | 'outfit', label: string) => {
    const id = c.equipment[key];
    const it = id ? ITEMS[id] : undefined;
    const el = tile(it, 1, label);
    if (it) {
      el.addEventListener('mouseenter', () => showTip(el, it, null, key === 'weapon' ? 'Equipped' : 'Equipped · click to take off'));
      el.addEventListener('mouseleave', hideTip);
      if (key !== 'weapon') el.addEventListener('click', () => actions.unequip(key));
    }
    return h('div', { class: 'eq-row' }, el, h('div', { class: 'eq-label' }, h('small', null, label), h('b', { style: it ? `color:${RARITY_COLORS[it.rarity]}` : '' }, it?.name ?? 'Empty')));
  };
  const statRow = (label: string, v: string, bonus: boolean) => h('div', { class: 'stat' }, h('span', null, label), h('b', { class: bonus ? 'up' : '' }, v));
  const left = h(
    'div',
    { class: 'inv-left' },
    h('div', { class: 'inv-title' }, `${c.name}`, h('small', null, `Level ${c.level} ${CLASSES[c.cls].name}`)),
    eq('weapon', 'Weapon'),
    eq('offhand', 'Off-hand'),
    eq('outfit', 'Outfit'),
    h(
      'div',
      { class: 'stats' },
      statRow('Health', String(st.maxHp), st.maxHp > base.maxHp),
      statRow('Power', st.power.toFixed(0), st.power > base.power),
      statRow('Critical', `${Math.round(st.crit * 100)}%`, st.crit > base.crit),
      statRow('Speed', `${Math.round(st.speed * 100)}%`, st.speed > base.speed),
    ),
  );
  const cells: HTMLElement[] = [];
  for (let i = 0; i < INVENTORY_SIZE; i++) {
    const slot = c.inventory[i];
    const it = slot ? ITEMS[slot.id] : undefined;
    const el = tile(it, slot?.qty ?? 0);
    if (it) {
      const usable = it.kind === 'consumable' || canEquip(c.cls, it);
      if (!usable) el.classList.add('unusable');
      const cur = it.kind === 'weapon' ? c.equipment.weapon : it.kind === 'offhand' ? c.equipment.offhand : it.kind === 'outfit' ? c.equipment.outfit : null;
      const hint = it.kind === 'consumable' ? 'Click to drink' : usable ? 'Click to equip · Shift+click to discard' : `Only a ${CLASSES[it.cls!]?.name ?? 'other class'} can use this · Shift+click to discard`;
      el.addEventListener('mouseenter', () => showTip(el, it, cur ? ITEMS[cur] : null, hint));
      el.addEventListener('mouseleave', hideTip);
      el.addEventListener('click', (e) => {
        if ((e as MouseEvent).shiftKey) {
          if (confirm(`Discard ${it.name}?`)) actions.discard(i);
        } else if (usable) actions.equip(i);
      });
    }
    cells.push(el);
  }
  root.replaceChildren(left, h('div', { class: 'inv-right' }, h('div', { class: 'bag' }, ...cells), h('div', { class: 'muted inv-foot' }, `${c.inventory.length} / ${INVENTORY_SIZE}`)));
}

function tile(it: ItemDef | undefined, qty: number, empty?: string) {
  const el = h('div', { class: 'tile' + (it ? ' ' + it.rarity : ' empty') });
  if (it) {
    el.style.setProperty('--rc', RARITY_COLORS[it.rarity]);
    el.append(icon(it.icon, 26));
    if (it.glow) el.style.setProperty('--glow', it.glow);
    if (qty > 1) el.append(h('span', { class: 'q' }, String(qty)));
  } else if (empty) el.title = empty;
  return el;
}

function statLines(it: ItemDef): string[] {
  const s = it.stats ?? {};
  const out: string[] = [];
  if (s.power) out.push(`+${s.power} Power`);
  if (s.hp) out.push(`+${s.hp} Health`);
  if (s.crit) out.push(`+${Math.round(s.crit * 100)}% Critical`);
  if (s.speed) out.push(`+${Math.round(s.speed * 100)}% Speed`);
  if (it.heal) out.push(`Restores ${Math.round(it.heal * 100)}% health`);
  return out;
}

function showTip(anchor: HTMLElement, it: ItemDef, current: ItemDef | null, hint: string) {
  hideTip();
  const kind = it.kind === 'weapon' ? 'Weapon' : it.kind === 'offhand' ? 'Off-hand' : it.kind === 'outfit' ? 'Outfit' : 'Consumable';
  const cmp: HTMLElement[] = [];
  if (current && current.id !== it.id) {
    const a = current.stats ?? {};
    const b = it.stats ?? {};
    const d = (k: 'power' | 'hp' | 'crit' | 'speed', label: string, pct = false) => {
      const v = (b[k] ?? 0) - (a[k] ?? 0);
      if (Math.abs(v) < 1e-6) return;
      const txt = pct ? `${v > 0 ? '+' : ''}${Math.round(v * 100)}% ${label}` : `${v > 0 ? '+' : ''}${v} ${label}`;
      cmp.push(h('div', { class: v > 0 ? 'up' : 'down' }, txt));
    };
    d('power', 'Power');
    d('hp', 'Health');
    d('crit', 'Critical', true);
    d('speed', 'Speed', true);
  }
  tip = h(
    'div',
    { class: 'item-tip panel' },
    h('b', { style: `color:${RARITY_COLORS[it.rarity]}` }, it.name),
    h('small', null, `${it.rarity[0].toUpperCase()}${it.rarity.slice(1)} ${kind}`),
    ...statLines(it).map((l) => h('div', { class: 'tl' }, l)),
    cmp.length ? h('div', { class: 'cmp' }, h('small', null, `Compared to ${current!.name}`), ...cmp) : null,
    h('p', null, it.description),
    h('div', { class: 'hint' }, hint),
  );
  document.body.append(tip);
  const r = anchor.getBoundingClientRect();
  const tr = tip.getBoundingClientRect();
  const x = Math.min(window.innerWidth - tr.width - 10, r.right + 10);
  const y = Math.min(window.innerHeight - tr.height - 10, r.top);
  tip.style.left = `${Math.max(10, x)}px`;
  tip.style.top = `${Math.max(10, y)}px`;
}

function hideTip() {
  tip?.remove();
  tip = null;
}
