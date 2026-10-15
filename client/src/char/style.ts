// The anime finish on characters and monsters: a crisp ink outline (inverted
// hull, drawn by Babylon's outline renderer) tinted per part to the dark tone
// of its surface, kept readable at distance, and a stronger rim light so
// figures pop out of the scenery.
import { Color3, Vector3, type AbstractMesh } from '@babylonjs/core';
import { setToon } from '../world/toon';

const tracked = new Set<AbstractMesh>();
let outlines = true;
const tmpS = new Vector3();

export interface InkStyle {
  /** Outline colour. */
  color?: Color3;
  /** Outline thickness in metres. */
  width?: number;
  rim?: number;
}

/** Default ink: a deep plum, softer than black against bright scenery. */
export const INK = new Color3(0.075, 0.045, 0.09);

/** Give a character's meshes their outline and rim (call after the model is scaled). */
export function inkCharacter(meshes: AbstractMesh[], style: InkStyle = {}) {
  const color = style.color ?? INK;
  const width = style.width ?? 0.019;
  for (const m of meshes) {
    m.computeWorldMatrix(true);
    m.getWorldMatrix().decompose(tmpS);
    const scale = Math.max(1e-4, (Math.abs(tmpS.x) + Math.abs(tmpS.y) + Math.abs(tmpS.z)) / 3);
    m.outlineColor = color.clone();
    m.outlineWidth = width / scale;
    m.renderOutline = outlines;
    setToon(m.material, { rim: style.rim ?? 1.3 });
    if (!tracked.has(m)) {
      tracked.add(m);
      m.onDisposeObservable.addOnce(() => tracked.delete(m));
    }
  }
}

/**
 * An outline colour for a surface: its own hue, very dark and a little more
 * saturated (the way anime line art is coloured per material).
 */
export function inkFor(hex: string, out = new Color3()): Color3 {
  const c = Color3.FromHexString(hex);
  const hsv = c.toHSV();
  Color3.HSVtoRGBToRef(hsv.r, Math.min(1, hsv.g * 1.1 + 0.15), Math.min(0.3, 0.1 + hsv.b * 0.16), out);
  return out.toLinearSpaceToRef(out);
}

/**
 * Keeps outlines a steady weight on screen: thin up close (no fat cartoon
 * lines on faces) and thicker with distance, so a figure across the meadow
 * still reads as a drawn character.
 */
export class InkScaler {
  private base: number[] = [];
  private last = -1;

  constructor(private meshes: AbstractMesh[]) {
    for (const m of meshes) this.base.push(m.outlineWidth);
  }

  update(subject: Vector3, eye: Vector3) {
    const d = Vector3.Distance(subject, eye);
    // ×0.8 at portrait distance, ×1 at 5 m, growing to ×2.4 at 20 m
    const k = Math.round(Math.min(2.4, Math.max(0.8, 0.55 + d * 0.093)) * 20) / 20;
    if (k === this.last) return;
    this.last = k;
    for (let i = 0; i < this.meshes.length; i++) this.meshes[i].outlineWidth = this.base[i] * k;
  }
}

/** Quality setting: turn every outline on or off. */
export function setOutlines(on: boolean) {
  outlines = on;
  for (const m of tracked) m.renderOutline = on;
}
