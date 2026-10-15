// Main-pass draw order. Babylon draws opaque and alpha-tested surfaces grouped
// by material in creation order, which put the sky (all clouds and noise) under
// the whole landscape and the terrain under the grass. Grass goes first (it
// covers the ground right in front of the camera), the rest stays batched by
// material, and the sky goes after the alpha-tested trees: it sits on the far
// plane, so early depth testing skips every pixel something already covers.
import { RenderingGroup, type AbstractMesh, type Scene, type SubMesh } from '@babylonjs/core';

const first = new WeakSet<AbstractMesh>();
const last = new WeakSet<AbstractMesh>();

export function drawFirst(m: AbstractMesh) {
  first.add(m);
}

/** Draw after every opaque and alpha-tested surface (the mesh's material must sit in the alpha-test queue). */
export function drawLast(m: AbstractMesh) {
  last.add(m);
}

const rank = (m: AbstractMesh) => (first.has(m) ? 0 : last.has(m) ? 2 : 1);

function compare(a: SubMesh, b: SubMesh) {
  return rank(a.getMesh()) - rank(b.getMesh()) || RenderingGroup.PainterSortCompare(a, b);
}

export function applyDrawOrder(scene: Scene) {
  scene.setRenderingOrder(0, compare, compare);
}
