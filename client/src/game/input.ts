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
    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      this.mouseButtons.add(e.button);
      this.clicked.add(e.button);
      if (!this.locked) {
        this.dragging = true;
        if (e.button === 0) this.requestLock();
      }
    });
    window.addEventListener('mouseup', (e) => {
      this.mouseButtons.delete(e.button);
      this.dragging = false;
    });
    canvas.addEventListener('mousemove', (e) => {
      this.cursorX = e.offsetX;
      this.cursorY = e.offsetY;
      this.cursorIn = true;
    });
    canvas.addEventListener('mouseleave', () => (this.cursorIn = false));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      if (this.locked || this.dragging) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
    });
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
