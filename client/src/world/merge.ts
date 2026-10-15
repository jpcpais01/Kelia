// Static-geometry batching: many small meshes that never move become one mesh
// per material, so the village is a handful of draw calls instead of hundreds
// (in the main pass and again in the shadow map).
import { Mesh, type AbstractMesh } from '@babylonjs/core';

/** Merge static meshes, grouped by material and vertex layout. Returns the merged meshes. */
export function mergeStatic(meshes: AbstractMesh[], name: string): Mesh[] {
  const groups = new Map<string, Mesh[]>();
  for (const m of meshes) {
    if (!(m instanceof Mesh) || !m.geometry || m.skeleton || m.hasThinInstances || m.visibility < 1 || !m.material) continue;
    if (m.getTotalVertices() === 0 || !m.isEnabled()) continue;
    const kinds = m.getVerticesDataKinds().slice().sort().join(',');
    const key = `${m.material.uniqueId}|${kinds}|${m.material.backFaceCulling}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(m);
  }
  const out: Mesh[] = [];
  let i = 0;
  for (const g of groups.values()) {
    if (g.length < 2) {
      out.push(...g);
      continue;
    }
    for (const m of g) m.computeWorldMatrix(true);
    try {
      const merged = Mesh.MergeMeshes(g, true, true, undefined, false, false);
      if (merged) {
        merged.name = `${name}_${i++}`;
        out.push(merged);
      }
    } catch (err) {
      console.warn('[merge] could not merge', name, err);
      out.push(...g);
    }
  }
  for (const m of out) {
    m.isPickable = false;
    m.receiveShadows = true;
    m.computeWorldMatrix(true);
    m.freezeWorldMatrix();
  }
  return out;
}
