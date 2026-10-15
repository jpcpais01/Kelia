// Main-pass draw order. Babylon draws opaque and alpha-tested surfaces grouped
// by material in creation order, which put the sky (all clouds and noise) under
// the whole landscape and the terrain under the grass. Grass goes first (it
// covers the ground right in front of the camera), the rest goes near to far
// in coarse bands (batched by material inside each), and the sky goes after
// the alpha-tested trees: it sits on the far plane, so early depth testing
// skips every pixel something already covers.
import { RenderingGroup, type AbstractMesh, type Scene, type SubMesh } from '@babylonjs/core';

const first = new WeakSet<AbstractMesh>();
const last = new WeakSet<AbstractMesh>();
const hints = new WeakMap<AbstractMesh, number>();

export function drawFirst(m: AbstractMesh) {
  first.add(m);
}

/** Draw after every opaque and alpha-tested surface (the mesh's material must sit in the alpha-test queue). */
export function drawLast(m: AbstractMesh) {
  last.add(m);
}

/**
 * Distance (m) to sort an instanced set by, for meshes whose bounding box says
 * nothing about where their instances are (thin-instanced trees by LOD ring).
 */
export function drawDistance(m: AbstractMesh, metres: number) {
  hints.set(m, metres);
}

const rank = (m: AbstractMesh) => (first.has(m) ? 0 : last.has(m) ? 2 : 1);

// Near to far in coarse distance bands, batched by material inside a band:
// what is drawn first fills the depth buffer, so the GPU skips shading most
// of what lies behind it (terrain behind houses and trees, far hills behind
// near ones) without breaking up material batches much.
let camX = 0;
let camY = 0;
let camZ = 0;
let frame = -1;
const bands = new WeakMap<SubMesh, [number, number]>();

function band(s: SubMesh) {
  const cached = bands.get(s);
  if (cached && cached[0] === frame) return cached[1];
  const m = s.getMesh();
  let d = hints.get(m);
  if (d === undefined) {
    // nearest point of the world bounding box
    const b = s.getBoundingInfo().boundingBox;
    const lo = b.minimumWorld;
    const hi = b.maximumWorld;
    const dx = Math.max(0, lo.x - camX, camX - hi.x);
    const dy = Math.max(0, lo.y - camY, camY - hi.y);
    const dz = Math.max(0, lo.z - camZ, camZ - hi.z);
    d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  // 0: <6 m, 1: <18 m, 2: <42 m, 3: <90 m, 4: <186 m ...
  const v = Math.floor(Math.log2(1 + d / 6));
  if (cached) {
    cached[0] = frame;
    cached[1] = v;
  } else bands.set(s, [frame, v]);
  return v;
}

function compare(a: SubMesh, b: SubMesh) {
  const ma = a.getMesh();
  const mb = b.getMesh();
  return rank(ma) - rank(mb) || band(a) - band(b) || RenderingGroup.PainterSortCompare(a, b);
}

export function applyDrawOrder(scene: Scene) {
  scene.onBeforeRenderingGroupObservable.add(() => {
    const cam = scene.activeCamera;
    if (!cam) return;
    const p = cam.globalPosition;
    camX = p.x;
    camY = p.y;
    camZ = p.z;
    frame = scene.getRenderId();
  });
  scene.setRenderingOrder(0, compare, compare);
}