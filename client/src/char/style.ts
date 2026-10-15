// The anime finish on characters and monsters: a thin ink outline (inverted
// hull, drawn by Babylon's outline renderer) and a stronger rim light so
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

/** Give a character's meshes their outline and rim (call after the model is scaled). */
export function inkCharacter(meshes: AbstractMesh[], style: InkStyle = {}) {
  const color = style.color ?? new Color3(0.07, 0.05, 0.09);
  const width = style.width ?? 0.018;
  for (const m of meshes) {
    m.computeWorldMatrix(true);
    m.getWorldMatrix().decompose(tmpS);
    const scale = Math.max(1e-4, (Math.abs(tmpS.x) + Math.abs(tmpS.y) + Math.abs(tmpS.z)) / 3);
    m.outlineColor = color;
    m.outlineWidth = width / scale;
    m.renderOutline = outlines;
    setToon(m.material, { rim: style.rim ?? 1.3 });
    if (!tracked.has(m)) {
      tracked.add(m);
      m.onDisposeObservable.addOnce(() => tracked.delete(m));
    }
  }
}

/** Quality setting: turn every outline on or off. */
export function setOutlines(on: boolean) {
  outlines = on;
  for (const m of tracked) m.renderOutline = on;
}
