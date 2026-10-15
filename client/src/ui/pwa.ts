// Installable app: registers the service worker (production builds only) and
// keeps the browser's install prompt so the login screen and HUD can offer an
// "Install Kelia" button whenever the browser allows it.

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type Listener = (canInstall: boolean) => void;
const listeners = new Set<Listener>();
let deferred: InstallPromptEvent | null = null;

const emit = () => listeners.forEach((fn) => fn(!!deferred));

/** True when Kelia is running as an installed app window. */
export const isInstalled = () =>
  matchMedia('(display-mode: standalone), (display-mode: fullscreen), (display-mode: window-controls-overlay)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** Calls `fn` now and whenever installing becomes possible or not; returns an unsubscribe. */
export function onInstallChange(fn: Listener) {
  listeners.add(fn);
  fn(!!deferred);
  return () => listeners.delete(fn);
}

export async function promptInstall() {
  const ev = deferred;
  if (!ev) return false;
  deferred = null;
  emit();
  await ev.prompt();
  const { outcome } = await ev.userChoice;
  return outcome === 'accepted';
}

addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // we show our own button instead of the browser's mini bar
  deferred = e as InstallPromptEvent;
  emit();
});
addEventListener('appinstalled', () => {
  deferred = null;
  emit();
});

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch((err) => console.warn('[kelia] service worker', err));
  });
}
