// Fullscreen toggle: the HUD button and F11 both go through here so the page
// itself goes fullscreen (not browser chrome fullscreen, which the page can't
// leave on its own). A captured mouse is re-captured after the switch, since
// some browsers drop pointer lock when the fullscreen element changes.

type Listener = (on: boolean) => void;
const listeners = new Set<Listener>();

export const isFullscreen = () => !!document.fullscreenElement;
export const fullscreenSupported = () => !!document.fullscreenEnabled;

export async function toggleFullscreen() {
  const locked = document.pointerLockElement as HTMLElement | null;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    return; // refused (no user gesture, iframe without permission, …)
  }
  if (locked && document.pointerLockElement !== locked) {
    try {
      const p = locked.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {});
    } catch {
      /* the next click captures it again */
    }
  }
}

/** Calls `fn` now and on every fullscreen change; returns an unsubscribe. */
export function onFullscreenChange(fn: Listener) {
  listeners.add(fn);
  fn(isFullscreen());
  return () => listeners.delete(fn);
}

document.addEventListener('fullscreenchange', () => {
  for (const fn of listeners) fn(isFullscreen());
});

window.addEventListener(
  'keydown',
  (e) => {
    if (e.code !== 'F11' || e.repeat || !fullscreenSupported()) return;
    e.preventDefault();
    void toggleFullscreen();
  },
  true,
);
