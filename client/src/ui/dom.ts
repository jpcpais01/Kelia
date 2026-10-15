// Tiny DOM helpers (no framework needed for Kelia's UI).

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown> & { class?: string; style?: string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (k === 'style') el.setAttribute('style', String(v));
      else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: HTMLElement, children: (Child | Child[])[]) {
  for (const c of children) {
    if (Array.isArray(c)) append(el, c);
    else if (c === null || c === undefined || c === false) continue;
    else el.append(c instanceof Node ? c : String(c));
  }
}

export const uiRoot = () => document.getElementById('ui')!;

/** Mount a screen element, fading it in. */
export function mount(el: HTMLElement) {
  el.classList.add('fade-in');
  uiRoot().append(el);
  return el;
}

/** Fade out and remove. */
export function unmount(el: HTMLElement, ms = 350) {
  el.classList.add('fade-out');
  setTimeout(() => el.remove(), ms);
}

export function icon(name: string, size = 20) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = ICONS[name] ?? ICONS.dot;
  span.style.width = span.style.height = size + 'px';
  return span;
}

/** Minimal line icons (24×24, stroke = currentColor). */
const p = (d: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
export const ICONS: Record<string, string> = {
  dot: p('<circle cx="12" cy="12" r="3"/>'),
  sword: p('<path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6M16 16l4 4M19 21l2-2"/>'),
  slash: p('<path d="M4 20 20 4"/><path d="M8 20 20 8" opacity=".5"/>'),
  shield: p('<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>'),
  spin: p('<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>'),
  rally: p('<path d="M3 11v2a1 1 0 0 0 1 1h3l5 4V6L7 10H4a1 1 0 0 0-1 1z"/><path d="M16 9a3 3 0 0 1 0 6M19 6a7 7 0 0 1 0 12"/>'),
  dodge: p('<path d="M4 18c4 0 6-3 7-6s3-6 7-6"/><path d="m15 3 3 3-3 3"/>'),
  bow: p('<path d="M5 3c8 3 13 8 16 16"/><path d="M5 3 21 19"/><path d="m3 7 2-4 4-2"/>'),
  arrow: p('<path d="M4 20 20 4M14 4h6v6"/>'),
  pierce: p('<path d="M3 12h16M15 8l4 4-4 4"/><circle cx="8" cy="12" r="2"/>'),
  volley: p('<path d="M6 3v10M12 3v12M18 3v10M4 11l2 2 2-2M10 13l2 2 2-2M16 11l2 2 2-2"/><path d="M3 21h18"/>'),
  snare: p('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>'),
  staff: p('<path d="M6 21 17 7"/><circle cx="18.5" cy="5.5" r="2.5"/>'),
  wand: p('<path d="M4 20 15 9"/><path d="M17 3v4M15 5h4M20 9v2M19 10h2"/>'),
  bolt: p('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  fire: p('<path d="M12 22c4 0 7-3 7-7 0-4-3-6-4-9-1 2-2 3-3 3 0-2-1-4-3-6 0 4-4 6-4 12 0 4 3 7 7 7z"/>'),
  frost: p('<path d="M12 2v20M4 6l16 12M20 6 4 18"/><path d="m9 3 3 3 3-3M9 21l3-3 3 3"/>'),
  heal: p('<path d="M12 21s-7-4.5-9-9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 4.5-9 9-9 9z"/><path d="M12 9v6M9 12h6"/>'),
  blink: p('<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>'),
  potion: p('<path d="M9 3h6M10 3v5L5 17a3 3 0 0 0 3 4h8a3 3 0 0 0 3-4l-5-9V3"/><path d="M7 14h10"/>'),
  potion_big: p('<path d="M9 2h6M10 2v5L4 17a3.5 3.5 0 0 0 3 5h10a3.5 3.5 0 0 0 3-5l-6-10V2"/><path d="M6 13h12"/>'),
  axe: p('<path d="M14 10 4 20"/><path d="M14 3a6 6 0 0 0 7 7l-4 1-4-4z"/>'),
  dagger: p('<path d="M15 9 21 3M15 9l-8 8-3 1 1-3 8-8M12 6l6 6"/>'),
  outfit: p('<path d="M8 3 4 6l2 4 2-1v12h8V9l2 1 2-4-4-3c0 2-2 3-4 3s-4-1-4-3z"/>'),
  bag: p('<path d="M5 8h14l-1 13H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>'),
  gear: p('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  scroll: p('<path d="M8 21h11a2 2 0 0 0 2-2v-1H10v1a2 2 0 0 1-4 0V5a2 2 0 0 0-2-2h11a2 2 0 0 1 2 2v13"/><path d="M10 8h5M10 12h5"/>'),
  chat: p('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.5A8 8 0 1 1 21 12z"/>'),
  close: p('<path d="M6 6l12 12M18 6 6 18"/>'),
  user: p('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  google: '<svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.5 12.3c0-.8-.1-1.5-.2-2.3H12v4.3h5.9a5 5 0 0 1-2.2 3.3v2.8h3.6c2-1.9 3.2-4.7 3.2-8.1z"/><path fill="#34A853" d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.8c-1 .7-2.2 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.5H2.1v2.9A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.8 14.1a6.6 6.6 0 0 1 0-4.2V7H2.1a11 11 0 0 0 0 10z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3 .6 4.2 1.6l3.1-3.1A11 11 0 0 0 2.1 7l3.7 2.9C6.7 7.3 9.1 5.4 12 5.4z"/></svg>',
  map: p('<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>'),
  star: p('<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>'),
  door: p('<path d="M4 21h16M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17"/><circle cx="14.5" cy="12" r="1"/>'),
};
