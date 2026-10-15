// Keyboard and mouse. Click the world to capture the mouse (action camera);
// Esc or Alt frees it for the UI. While free, dragging still turns the camera
// and the character aims at the cursor.

export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  locked = false;
  private dragging = false;
  /** Cursor position over the canvas in CSS pixels, and whether it is over it. */
  cursorX = 0;
  cursorY = 0;
  cursorIn = false;
  /** Set while a text field has focus so typing doesn't move the character. */
  typing = false;
  enabled = true;
  mouseButtons = new Set<number>();
  private clicked = new Set<number>();
  onLockChange: ((locked: boolean) => void) | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (this.isTextTarget(e.target)) return;
      if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.down.delete(e.code);
    });
    window.addEventListener('blur', () => {
      this.down.clear();
      this.mouseButtons.clear();
    });
    // Pointer events, not mouse events: Babylon's scene input calls
    // preventDefault() on pointerdown, which suppresses mousedown entirely.
    // `buttons` is a bitmask (1 left, 2 right, 4 middle) and is synced on every
    // event, since a second button pressed while one is held only fires pointermove.
    const sync = (e: PointerEvent, onCanvas: boolean) => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      const now = new Set<number>();
      if (e.buttons & 1) now.add(0);
      if (e.buttons & 2) now.add(2);
      if (e.buttons & 4) now.add(1);
      for (const b of now) {
        if (this.mouseButtons.has(b)) continue;
        if (!onCanvas || !this.enabled) continue;
        this.mouseButtons.add(b);
        this.clicked.add(b);
        if (!this.locked) {
          this.dragging = true;
          if (b === 0) this.requestLock();
        }
      }
      for (const b of [...this.mouseButtons]) if (!now.has(b)) this.mouseButtons.delete(b);
      if (!this.mouseButtons.size) this.dragging = false;
    };
    canvas.addEventListener('pointerdown', (e) => sync(e, true));
    window.addEventListener('pointerup', (e) => sync(e, false));
    canvas.addEventListener('pointermove', (e) => {
      this.cursorX = e.offsetX;
      this.cursorY = e.offsetY;
      this.cursorIn = true;
    });
    canvas.addEventListener('pointerleave', () => (this.cursorIn = false));
    window.addEventListener('pointermove', (e) => {
      sync(e, e.target === canvas || this.locked);
      if (!this.enabled) return;
      if (this.locked || this.dragging) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.wheel += Math.sign(e.deltaY) * Math.min(3, Math.abs(e.deltaY) / 60 || 1);
      },
      { passive: false },
    );
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      this.onLockChange?.(this.locked);
    });
  }

  /** Free cursor resting over the world (not captured, not dragging the camera). */
  get cursorAiming() {
    return this.enabled && !this.locked && !this.dragging && this.cursorIn;
  }

  requestLock() {
    if (!this.enabled || this.locked) return;
    try {
      const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {});
    } catch {
      /* not allowed right now */
    }
  }

  releaseLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private isTextTarget(t: EventTarget | null) {
    const el = t as HTMLElement | null;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  key(code: string) {
    return this.enabled && !this.typing && this.down.has(code);
  }

  /** True once per key press. */
  pressedKey(code: string) {
    return this.enabled && !this.typing && this.pressed.has(code);
  }

  clickedButton(b: number) {
    return this.enabled && this.clicked.has(b);
  }

  /** Call at the end of each frame. */
  endFrame() {
    this.pressed.clear();
    this.clicked.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }
}
