// The hero's face comes alive: it blinks now and then, scowls and shouts
// through an attack and squeezes its eyes shut when hit. Each expression is
// the painted face (hero/face.ts) redrawn with lids, brows and mouth moved;
// a character caches the faces it has shown and swaps them into its atlas,
// only while it is close enough to the camera for anyone to see.
import { EXPRESSIONS, paintFace, type ExpressionName, type FacePaint } from './hero/face';
import type { HeroAtlas } from './hero/palette';

/** Face swaps (texture uploads) allowed per frame across all characters. */
const BUDGET = 3;
let frame = -1;
let spent = 0;

export class FaceAnimator {
  private cache = new Map<ExpressionName, ImageData>();
  private shown: ExpressionName = 'rest';
  private paint: FacePaint | null = null;
  private nextBlink = 1 + Math.random() * 3;
  private blinkT = -1;
  private doubleBlink = false;
  private hurtT = 0;
  /** Hold one expression (dev views). */
  hold: ExpressionName | null = null;

  constructor(private atlas: HeroAtlas) {}

  /** The face was (re)painted at rest: forget the old expressions. */
  painted(f: FacePaint) {
    this.paint = f;
    this.cache.clear();
    this.cache.set('rest', this.atlas.ctx.getImageData(512, 0, 512, 512));
    this.shown = 'rest';
  }

  /** A blow landed: wince for a moment. */
  hurt(amount: number) {
    this.hurtT = 0.32 + 0.25 * Math.min(1, amount);
  }

  /**
   * Advance the clock and show the right face. `fierce` is true through the
   * wind-up and strike of an attack; `near` says the face can be seen.
   */
  update(dt: number, frameId: number, near: boolean, fierce: boolean) {
    if (frameId !== frame) {
      frame = frameId;
      spent = 0;
    }
    this.hurtT = Math.max(0, this.hurtT - dt);
    this.nextBlink -= dt;
    if (this.blinkT >= 0) this.blinkT += dt;
    if (this.nextBlink <= 0 && this.blinkT < 0) {
      this.blinkT = 0;
      this.doubleBlink = Math.random() < 0.15;
      this.nextBlink = 2.2 + Math.random() * 3.6;
    }
    let want: ExpressionName = 'rest';
    if (!near) {
      // out of sight: drop the extra faces (the rest face is kept to restore)
      if (this.shown === 'rest' && this.cache.size > 1) for (const k of [...this.cache.keys()]) if (k !== 'rest') this.cache.delete(k);
    } else if (this.hurtT > 0) want = 'hurt';
    else if (fierce) want = this.blink() === 'blink' ? 'blink' : 'fierce';
    else want = this.blink();
    this.show(this.hold ?? want);
  }

  /** Where the blink is: lids half down, shut, half up, open (sometimes twice). */
  private blink(): ExpressionName {
    const t = this.blinkT;
    if (t < 0) return 'rest';
    if (t > (this.doubleBlink ? 0.42 : 0.17)) {
      this.blinkT = -1;
      return 'rest';
    }
    const k = t > 0.25 ? t - 0.25 : t;
    if (k > 0.17) return 'rest';
    return k < 0.04 || k > 0.13 ? 'half' : 'blink';
  }

  private show(name: ExpressionName) {
    if (name === this.shown || !this.paint) return;
    if (spent >= BUDGET && name !== 'rest') return;
    spent++;
    const ctx = this.atlas.ctx;
    const hit = this.cache.get(name);
    if (hit) ctx.putImageData(hit, 512, 0);
    else {
      paintFace(this.atlas, this.paint, EXPRESSIONS[name]);
      this.cache.set(name, ctx.getImageData(512, 0, 512, 512));
    }
    this.atlas.update();
    this.shown = name;
  }
}
