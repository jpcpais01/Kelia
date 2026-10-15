// Fold a character's skinned body parts into one mesh per material. Parts that
// share a skeleton, a material, a parent and a placement draw identically as
// one mesh, so a hero costs one draw (and one outline) for body, arms and legs
// instead of five of each.
import { BoundingInfo, Mesh, VertexData, type AbstractMesh } from '@babylonjs/core';

function samePlacement(x: AbstractMesh, y: AbstractMesh) {
  const a = x.computeWorldMatrix(true).m;
  const b = y.computeWorldMatrix(true).m;
  for (let k = 0; k < 16; k++) if (Math.abs(a[k] - b[k]) > 1e-5) return false;
  return true;
}

/**
 * Merge the `candidates` into as few meshes as possible and return the new
 * list of meshes (merged ones plus everything left as it was). Merged sources
 * are disposed. Outline settings are copied from the first part of a group.
 */
export function mergeSkinnedParts(meshes: AbstractMesh[], candidate: (m: AbstractMesh) => boolean): AbstractMesh[] {
  const groups: Mesh[][] = [];
  const rest: AbstractMesh[] = [];
  for (const m of meshes) {
    if (!(m instanceof Mesh) || !m.skeleton || !m.material || !candidate(m) || m.subMeshes?.length !== 1) {
      rest.push(m);
      continue;
    }
    const g = groups.find((g) => g[0].skeleton === m.skeleton && g[0].material === m.material && g[0].parent === m.parent && samePlacement(g[0], m));
    if (g) g.push(m);
    else groups.push([m]);
  }
  const out = rest;
  for (const g of groups) {
    if (g.length < 2) {
      out.push(g[0]);
      continue;
    }
    const first = g[0];
    const datas = g.map((m) => VertexData.ExtractFromMesh(m, true, true));
    const verts = g.reduce((s, m) => s + m.getTotalVertices(), 0);
    const vd = datas[0];
    vd.merge(datas.slice(1), verts > 65535, false, false, true);
    const merged = new Mesh(first.name + '_skin', first.getScene());
    vd.applyToMesh(merged, false);
    // glTF parts carry their own winding (the rig is mirrored): keep it
    merged.sideOrientation = first.sideOrientation;
    merged.overrideMaterialSideOrientation = first.overrideMaterialSideOrientation;
    merged.parent = first.parent;
    merged.position.copyFrom(first.position);
    if (first.rotationQuaternion) merged.rotationQuaternion = first.rotationQuaternion.clone();
    else merged.rotation.copyFrom(first.rotation);
    merged.scaling.copyFrom(first.scaling);
    merged.skeleton = first.skeleton;
    merged.numBoneInfluencers = Math.max(...g.map((m) => m.numBoneInfluencers));
    merged.material = first.material;
    merged.isPickable = first.isPickable;
    merged.receiveShadows = first.receiveShadows;
    merged.alwaysSelectAsActiveMesh = first.alwaysSelectAsActiveMesh;
    merged.layerMask = first.layerMask;
    merged.setEnabled(first.isEnabled(false));
    // the parts' own bounds (their bind-pose vertices may sit elsewhere, see RigLibrary.unifySkins)
    const lo = first.getBoundingInfo().minimum.clone();
    const hi = first.getBoundingInfo().maximum.clone();
    for (const m of g) {
      lo.minimizeInPlace(m.getBoundingInfo().minimum);
      hi.maximizeInPlace(m.getBoundingInfo().maximum);
    }
    merged.setBoundingInfo(new BoundingInfo(lo, hi));
    for (const m of g) m.dispose(false, false);
    out.push(merged);
  }
  return out;
}
