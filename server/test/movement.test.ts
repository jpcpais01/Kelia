import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GLIDE_DIVE_SINK, GLIDE_DIVE_SPEED, GLIDE_FAST_SPEED, GLIDE_SLOW_SINK, GLIDE_SLOW_SPEED, GLIDE_SPEED, GLIDE_STRAFE_SPEED, Heightmap, TICK_MS, UPDRAFTS, waterAt, LAKE } from '@kelia/shared';
import { judgeMove, newAirState, type Pos } from '../src/movement';

const hm = new Heightmap(1).fill();

/** Fly a path of positions at 20 Hz, starting `t0` ms; returns the verdicts. */
function fly(path: Pos[]) {
  const air = newAirState();
  let from = path[0];
  let now = 1_000_000;
  const out = [];
  for (const to of path.slice(1)) {
    now += TICK_MS;
    const v = judgeMove(hm, from, to, TICK_MS / 1000, 0, now, air);
    out.push(v);
    if (v.ok) from = to;
    else if (v.why === 'hover') from = { ...to, y: v.y };
  }
  return Object.assign(out, { end: from });
}

/** A glide from (x, z, y) heading along +x at `speed`, sinking at `sink`, until it nears the ground. */
function glide(x: number, z: number, y: number, speed: number, sink: number, maxT = 60, dir: [number, number] = [1, 0]) {
  const path: Pos[] = [{ x, y, z }];
  const dt = TICK_MS / 1000;
  for (let t = 0; t < maxT; t += dt) {
    x += dir[0] * speed * dt;
    z += dir[1] * speed * dt;
    y -= sink * dt;
    if (y < hm.sample(x, z) + 0.5) break;
    path.push({ x, y, z });
  }
  return path;
}

// from the top of the Greyspine Thermal, south towards the Ruins
const [GX, GZ] = [250, 262];
const GY = 96;

test('a slow glide from the Greyspine Thermal is never rejected', () => {
  const path = glide(GX, GZ, GY, GLIDE_SLOW_SPEED, GLIDE_SLOW_SINK, 60, [0, -1]);
  assert.ok(path.length > 100);
  assert.ok(fly(path).every((v) => v.ok));
});

test('fast glides, dives and strafing glides pass', () => {
  const fast = Math.hypot(GLIDE_FAST_SPEED, GLIDE_STRAFE_SPEED);
  for (const [speed, sink] of [[fast, 2.4], [GLIDE_DIVE_SPEED, GLIDE_DIVE_SINK], [GLIDE_SPEED, 2.0]]) {
    const path = glide(GX, GZ, GY, speed, sink, 60, [0, -1]);
    assert.ok(path.length > 40);
    assert.ok(fly(path).every((v) => v.ok));
  }
});

test('hovering in mid-air is pulled down', () => {
  const [x, z, y] = [GX, GZ, 60];
  const path: Pos[] = [];
  // hang there, drifting slowly south
  for (let i = 0; i < 300; i++) path.push({ x, y, z: z - i * 0.3 });
  const verdicts = fly(path);
  const firstBad = verdicts.findIndex((v) => !v.ok);
  assert.ok(firstBad > 0, 'allowed a moment of hang time');
  assert.ok(verdicts.some((v) => !v.ok && v.why === 'hover'));
  // where the server has them by the end: well below where they claim to hang
  assert.ok(verdicts.end.y < y - 3, `ended at ${verdicts.end.y}`);
});

test('updrafts carry gliders up to their top, and no higher', () => {
  const u = UPDRAFTS[0];
  const [x, z] = u.pos;
  const path: Pos[] = [];
  let y = hm.sample(x, z);
  for (let i = 0; i < 160 && y < u.top; i++) path.push({ x, y: (y += 0.35), z });
  assert.ok(fly(path).every((v) => v.ok));
  // and then a long glide away from the top
  const away = glide(x, z, u.top, GLIDE_SPEED, 2.0, 40);
  assert.ok(fly(away).every((v) => v.ok));
  // trying to keep rising above the column is clamped
  const over: Pos[] = [];
  for (let i = 0; i < 80; i++) over.push({ x, y: u.top + i * 0.3, z });
  assert.ok(fly(over).some((v) => !v.ok && v.why === 'hover'));
});

test('skimming over deep water is fine, standing in it is not', () => {
  const [x, z] = LAKE.center;
  const w = waterAt(x, z);
  assert.ok(w > hm.sample(x, z) + 2, 'lake centre is deep');
  const skim: Pos[] = [];
  for (let i = 0; i < 100; i++) skim.push({ x: x + i * 0.3, y: w + 0.9, z });
  assert.ok(fly(skim).every((v) => v.ok));
  const v = judgeMove(hm, { x, y: hm.sample(x, z), z }, { x: x + 0.2, y: hm.sample(x + 0.2, z), z }, 0.05, 0, 1, newAirState());
  assert.deepEqual(v, { ok: false, why: 'water' });
});

test('walking, jumping and speed hacks', () => {
  const [x, z] = [6, -32];
  const g = hm.sample(x, z);
  assert.ok(judgeMove(hm, { x, y: g, z }, { x: x + 0.3, y: hm.sample(x + 0.3, z), z }, 0.05, 0, 1, newAirState()).ok);
  assert.ok(judgeMove(hm, { x, y: g, z }, { x, y: g + 1.1, z }, 0.05, 0, 1, newAirState()).ok);
  assert.deepEqual(judgeMove(hm, { x, y: g, z }, { x: x + 5, y: g, z }, 0.05, 0, 1, newAirState()), { ok: false, why: 'speed' });
  assert.deepEqual(judgeMove(hm, { x, y: g, z }, { x, y: g + 8, z }, 0.05, 0, 1, newAirState()), { ok: false, why: 'flying' });
});
