// Modal windows: settings, patch notes and controls.
import type { QualityLevel, UserSettings } from '../core/quality';
import { groupedNotes } from '../data/patchnotes';
import { h, icon, mount, unmount } from './dom';

let open: HTMLElement | null = null;

export function closeWindow() {
  if (open) unmount(open, 200);
  open = null;
}

export function isWindowOpen() {
  return !!open;
}

function windowFrame(title: string, ...body: HTMLElement[]) {
  closeWindow();
  const wrap = h(
    'div',
    { class: 'modal-wrap interactive', onmousedown: (e: Event) => { if (e.target === wrap) closeWindow(); } },
    h('div', { class: 'window panel' }, h('div', { class: 'window-head' }, h('h2', null, title), h('button', { class: 'icon-btn', onclick: closeWindow, title: 'Close' }, icon('close', 16))), h('div', { class: 'window-body' }, ...body)),
  );
  open = mount(wrap);
  return wrap;
}

export function openPatchNotes() {
  const groups = groupedNotes();
  windowFrame('PATCH NOTES', ...groups.map((g) => h('div', { class: 'patch-group' }, h('h3', null, g.label), h('ul', null, ...g.lines.map((l) => h('li', null, l))))));
}

export function openHelp() {
  const row = (keys: string[], what: string) => [h('div', null, ...keys.map((k) => h('span', { class: 'kbd', style: 'margin-right:4px' }, k))), h('div', null, what)];
  windowFrame(
    'CONTROLS',
    h(
      'div',
      { class: 'help-grid' },
      ...row(['W', 'A', 'S', 'D'], 'Move (relative to the camera)'),
      ...row(['Shift'], 'Sprint'),
      ...row(['Z'], 'Toggle walk'),
      ...row(['Space'], 'Jump'),
      ...row(['Click'], 'Capture the mouse to look around'),
      ...row(['Esc'], 'Free the mouse / close windows'),
      ...row(['Drag'], 'Turn the camera while the mouse is free'),
      ...row(['Wheel'], 'Zoom'),
      ...row(['Enter'], 'Chat'),
      ...row(['/wave', '/cheer', '/dance', '/sit'], 'Emotes'),
      ...row(['/who', '/roll', '/stuck'], 'Who is online, roll dice, get unstuck'),
      ...row(['N'], 'Toggle name plates'),
    ),
  );
}

export interface SettingsCallbacks {
  settings: UserSettings;
  onChange(s: UserSettings, needsReload: boolean): void;
  onLogout(): void;
}

export function openSettings(cb: SettingsCallbacks) {
  const s = { ...cb.settings };
  const seg = <T extends string>(values: [T, string][], current: T, pick: (v: T) => void) => {
    const el = h('div', { class: 'seg' });
    const render = (cur: T) =>
      el.replaceChildren(...values.map(([v, label]) => h('button', { class: v === cur ? 'on' : '', onclick: () => { pick(v); render(v); } }, label)));
    render(current);
    return el;
  };
  const toggle = (label: string, value: boolean, set: (v: boolean) => void) =>
    h('label', { class: 'toggle setting' }, label, h('input', { type: 'checkbox', checked: value, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) }), h('i'));
  const range = (label: string, min: number, max: number, step: number, value: number, set: (v: number) => void) =>
    h('div', { class: 'setting' }, label, h('input', { type: 'range', min, max, step, value, oninput: (e: Event) => set(Number((e.target as HTMLInputElement).value)) }));
  const apply = (reload = false) => cb.onChange({ ...s }, reload);
  windowFrame(
    'SETTINGS',
    h('div', { class: 'setting' }, 'Graphics', seg<QualityLevel | 'auto'>([['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']], s.quality, (v) => { s.quality = v; apply(); })),
    h('div', { class: 'setting' }, 'Renderer', seg<UserSettings['renderer']>([['auto', 'Auto'], ['webgpu', 'WebGPU'], ['webgl2', 'WebGL2']], s.renderer, (v) => { s.renderer = v; apply(true); })),
    range('Field of view', 50, 80, 1, s.fov, (v) => { s.fov = v; apply(); }),
    range('Mouse sensitivity', 0.3, 2.5, 0.05, s.mouseSensitivity, (v) => { s.mouseSensitivity = v; apply(); }),
    toggle('Invert vertical look', s.invertY, (v) => { s.invertY = v; apply(); }),
    toggle('Camera shake', s.cameraShake, (v) => { s.cameraShake = v; apply(); }),
    toggle('Name plates', s.showNames, (v) => { s.showNames = v; apply(); }),
    h('div', { class: 'muted', style: 'font-size:12px' }, 'Renderer changes apply after a reload.'),
    h('button', { class: 'btn', onclick: () => { closeWindow(); cb.onLogout(); } }, icon('door', 16), 'Log out'),
  );
}
