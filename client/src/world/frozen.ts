// Static materials: the world's terrain, trees, rocks, buildings and props
// never change their look at runtime, so they are frozen. A frozen material
// skips Babylon's per-draw readiness check (re-deriving every shader define
// for every mesh, every frame) and its texture/colour uniform re-uploads,
// which is most of the CPU cost of a draw call.
import type { Material, Scene } from '@babylonjs/core';

const statics = new Set<Material>();
let thawed = 0;

/** Mark a material whose properties never change after creation. */
export function freezeStatic(m: Material | null | undefined) {
  if (!m || statics.has(m)) return;
  statics.add(m);
  m.onDisposeObservable.addOnce(() => statics.delete(m));
  // A frozen material still compiles normally on first use; it only stops re-checking once ready.
  if (!thawed) m.freeze();
}

/**
 * After something that changes shader variants for everyone (quality preset,
 * shadows on or off), let each static material re-derive its shaders, then
 * lock them again a few frames later.
 */
export function refreshStatics(scene: Scene) {
  for (const m of statics) m.unfreeze();
  thawed++;
  let frames = 0;
  const o = scene.onAfterRenderObservable.add(() => {
    if (++frames < 4) return;
    scene.onAfterRenderObservable.remove(o);
    if (--thawed === 0) for (const m of statics) m.freeze();
  });
}
