// Character creation UI. The 3D stage (camera, model) lives in game/creator.ts;
// this file is the panels: options, class choice and the name.
import {
  BODY_TYPES,
  CLASSES,
  DEFAULT_APPEARANCE,
  EYE_COLORS,
  FACES,
  HAIR_COLORS,
  HAIR_STYLES,
  OUTFITS,
  SKIN_TONES,
  STARTER_OUTFIT_COUNT,
  validateName,
  type Appearance,
  type ClassId,
} from '@kelia/shared';
import { h, icon, mount, unmount } from './dom';

export type CreatorTab = 'hero' | 'body' | 'face' | 'hair' | 'outfit';

export interface CreatorCallbacks {
  onChange(a: Appearance, cls: ClassId, rebuild: boolean): void;
  onTab(tab: CreatorTab): void;
  onSubmit(name: string, a: Appearance, cls: ClassId): Promise<string | null>; // returns an error or null
}

const CLASS_ICON: Record<ClassId, string> = { vanguard: 'shield', ranger: 'bow', arcanist: 'staff' };

export class CreatorScreen {
  readonly el: HTMLElement;
  appearance: Appearance = { ...DEFAULT_APPEARANCE };
  cls: ClassId = 'vanguard';
  private tab: CreatorTab = 'hero';
  private body: HTMLElement;
  private tabsEl: HTMLElement;
  private summary: HTMLElement;
  private nameInput: HTMLInputElement;
  private err: HTMLElement;
  private submitBtn: HTMLButtonElement;

  constructor(private cb: CreatorCallbacks) {
    // A random but pleasant starting look.
    const r = (n: number) => Math.floor(Math.random() * n);
    this.appearance = {
      body: r(BODY_TYPES.length),
      skin: r(8),
      face: r(FACES.length),
      hair: r(HAIR_STYLES.length - 1),
      hairColor: r(HAIR_COLORS.length - 2),
      eyes: r(EYE_COLORS.length),
      outfit: r(STARTER_OUTFIT_COUNT),
      headgear: false,
    };
    this.cls = (['vanguard', 'ranger', 'arcanist'] as ClassId[])[r(3)];

    this.body = h('div', { class: 'creator-body' });
    this.tabsEl = h('div', { class: 'tabs' });
    this.summary = h('div', { class: 'class-summary' });
    this.nameInput = h('input', { class: 'input', placeholder: 'Your name', maxlength: 16, spellcheck: false, autocomplete: 'off' });
    this.err = h('div', { class: 'err' });
    this.submitBtn = h('button', { class: 'btn primary wide', onclick: () => this.submit() }, 'Begin your journey');
    this.nameInput.addEventListener('input', () => {
      this.err.textContent = '';
    });
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.submit();
    });

    this.el = h(
      'div',
      { class: 'creator' },
      h(
        'div',
        { class: 'creator-left panel interactive' },
        h('div', { class: 'creator-head' }, h('h1', null, 'NEW HERO'), h('p', null, 'Shape who you will be in Kelia.')),
        this.tabsEl,
        this.body,
      ),
      h(
        'div',
        { class: 'creator-right panel interactive' },
        this.summary,
        h('div', { class: 'field name-row' }, h('label', null, 'Name'), this.nameInput),
        this.err,
        this.submitBtn,
      ),
      h('div', { class: 'rotate-hint' }, 'Drag to turn', h('span', { class: 'muted' }, '·'), 'Scroll to zoom'),
    );
    mount(this.el);
    this.renderTabs();
    this.renderBody();
    this.renderSummary();
    setTimeout(() => this.cb.onChange(this.appearance, this.cls, true), 0);
  }

  private renderTabs() {
    const tabs: [CreatorTab, string][] = [['hero', 'Class'], ['body', 'Body'], ['face', 'Face'], ['hair', 'Hair'], ['outfit', 'Outfit']];
    this.tabsEl.replaceChildren(
      ...tabs.map(([id, label]) =>
        h('button', { class: 'tab' + (this.tab === id ? ' on' : ''), onclick: () => { this.tab = id; this.renderTabs(); this.renderBody(); this.cb.onTab(id); } }, label),
      ),
    );
  }

  private set(patch: Partial<Appearance>, rebuild = true) {
    this.appearance = { ...this.appearance, ...patch };
    this.renderBody();
    this.cb.onChange(this.appearance, this.cls, rebuild);
  }

  private chips<T>(title: string, items: { name: string }[], current: number, pick: (i: number) => void, extra?: T) {
    void extra;
    return h(
      'div',
      { class: 'opt-group' },
      h('h3', null, title, h('span', null, items[current]?.name ?? '')),
      h('div', { class: 'chips' }, ...items.map((it, i) => h('button', { class: 'chip' + (i === current ? ' on' : ''), onclick: () => pick(i) }, it.name))),
    );
  }

  private swatches(title: string, items: { name: string; color: string }[], current: number, pick: (i: number) => void) {
    return h(
      'div',
      { class: 'opt-group' },
      h('h3', null, title, h('span', null, items[current]?.name ?? '')),
      h('div', { class: 'swatches' }, ...items.map((it, i) => h('button', { class: 'swatch' + (i === current ? ' on' : ''), title: it.name, style: `background:${it.color}`, onclick: () => pick(i) }))),
    );
  }

  private renderBody() {
    const a = this.appearance;
    let content: HTMLElement[] = [];
    switch (this.tab) {
      case 'hero':
        content = [
          h(
            'div',
            { class: 'cards' },
            ...(Object.values(CLASSES)).map((c) =>
              h(
                'button',
                { class: 'card' + (this.cls === c.id ? ' on' : ''), onclick: () => { this.cls = c.id; this.renderBody(); this.renderSummary(); this.cb.onChange(this.appearance, this.cls, true); } },
                h('div', { class: 'card-icon', style: `color:${c.color}` }, icon(CLASS_ICON[c.id], 22)),
                h('div', null, h('span', { class: 'card-tag' }, c.weaponStyle), h('b', null, c.name), h('small', null, c.description)),
              ),
            ),
          ),
        ];
        break;
      case 'body':
        content = [
          this.chips('Build', BODY_TYPES, a.body, (i) => this.set({ body: i })),
          this.swatches('Skin', SKIN_TONES, a.skin, (i) => this.set({ skin: i }, false)),
        ];
        break;
      case 'face':
        content = [
          this.chips('Face', FACES, a.face, (i) => this.set({ face: i })),
          this.swatches('Eyes', EYE_COLORS, a.eyes, (i) => this.set({ eyes: i }, false)),
        ];
        break;
      case 'hair':
        content = [
          this.chips('Style', HAIR_STYLES, a.hair, (i) => this.set({ hair: i })),
          this.swatches('Colour', HAIR_COLORS, a.hairColor, (i) => this.set({ hairColor: i }, false)),
        ];
        break;
      case 'outfit': {
        const hg = h('input', { type: 'checkbox', checked: a.headgear, onchange: (e: Event) => this.set({ headgear: (e.target as HTMLInputElement).checked }) });
        content = [
          h(
            'div',
            { class: 'cards' },
            ...OUTFITS.slice(0, STARTER_OUTFIT_COUNT).map((o, i) =>
              h('button', { class: 'card' + (a.outfit === i ? ' on' : ''), onclick: () => this.set({ outfit: i }) }, h('div', { class: 'card-icon' }, icon('outfit', 20)), h('div', null, h('b', null, o.name), h('small', null, o.description))),
            ),
          ),
          OUTFITS[a.outfit].headgear !== 'none'
            ? h('label', { class: 'toggle' }, `Wear ${({ helmet: 'helmet', hood: 'hood', wizard: 'hat', bearhat: 'bear hat', none: '' } as const)[OUTFITS[a.outfit].headgear]}`, hg, h('i'))
            : h('div', { class: 'muted', style: 'font-size:12px' }, 'This outfit has no headgear.'),
        ];
        break;
      }
    }
    this.body.replaceChildren(...content);
  }

  private renderSummary() {
    const c = CLASSES[this.cls];
    const all = [...c.skills];
    this.summary.replaceChildren(
      h('div', null, h('b', null, c.name.toUpperCase()), ' ', h('span', { class: 'muted' }, '· ', c.weaponStyle)),
      h('div', { style: 'margin:6px 0 10px' }, c.tagline),
      h('div', { class: 'skill-mini' }, ...all.map((s) => h('div', { class: 's', title: `${s.name}: ${s.description}` }, icon(s.icon, 18))), h('div', { class: 's', title: `${c.dodge.name}: ${c.dodge.description}` }, icon('dodge', 18))),
    );
  }

  private async submit() {
    const name = this.nameInput.value.trim();
    const problem = validateName(name);
    if (problem) {
      this.err.textContent = problem;
      this.nameInput.focus();
      return;
    }
    this.submitBtn.disabled = true;
    this.submitBtn.replaceChildren(h('span', { class: 'spinner' }), 'Creating…');
    const err = await this.cb.onSubmit(name, this.appearance, this.cls);
    if (err) {
      this.err.textContent = err;
      this.submitBtn.disabled = false;
      this.submitBtn.replaceChildren('Begin your journey');
    }
  }

  close() {
    unmount(this.el);
  }
}
