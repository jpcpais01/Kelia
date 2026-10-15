import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heightAt, waterAt, riverWaterY, FALL_S0, FALL_S1 } from '../src/world/terrain';
import { Heightmap } from '../src/world/heightmap';
import { VILLAGE, SPAWN_POINT, LAKE, WATER_LEVEL, VILLAGE_PROPS } from '../src/world/layout';
import { validateName } from '../src/character';
import { dayTimeAt, sunDirection } from '../src/daynight';
import { isValidAppearance, DEFAULT_APPEARANCE } from '../src/data/appearance';

test('terrain is deterministic', () => {
  assert.equal(heightAt(12.5, -40.25), heightAt(12.5, -40.25));
});

test('village is flat and dry', () => {
  const [vx, vz] = VILLAGE.center;
  for (const [dx, dz] of [[0, 0], [20, 10], [-25, -15], [10, -30]]) {
    const h = heightAt(vx + dx, vz + dz);
    assert.ok(Math.abs(h - VILLAGE.height) < 0.8, `village height ${h}`);
  }
  assert.equal(waterAt(SPAWN_POINT[0], SPAWN_POINT[1]), -Infinity);
  for (const p of VILLAGE_PROPS) assert.equal(waterAt(p.x, p.z), -Infinity, `prop ${p.prop} in water`);
});

test('lake holds water and river flows downhill', () => {
  assert.ok(heightAt(LAKE.center[0], LAKE.center[1]) < WATER_LEVEL - 2);
  let prev = Infinity;
  for (let s = 0; s < 700; s += 10) {
    const y = riverWaterY(s);
    assert.ok(y <= prev + 1e-6, 'river must flow downhill');
    prev = y;
  }
  assert.ok(riverWaterY(FALL_S0) - riverWaterY(FALL_S1) > 15, 'waterfall drop');
});

test('heightmap sample matches analytic height at grid points', () => {
  const hm = new Heightmap(4);
  hm.fillRows(0, hm.size);
  const x = -512 + 4 * 100, z = -512 + 4 * 130;
  assert.ok(Math.abs(hm.sample(x, z) - heightAt(x, z)) < 1e-4);
});

test('names', () => {
  assert.equal(validateName('Aria'), null);
  assert.equal(validateName("D'arc"), null);
  assert.notEqual(validateName('ab'), null);
  assert.notEqual(validateName('Bad Name'), null);
  assert.notEqual(validateName('xXx--'), null);
});

test('day/night and appearance', () => {
  for (let t = 0; t < 1e7; t += 123457) {
    const d = dayTimeAt(t);
    assert.ok(d >= 0 && d < 1);
  }
  const noon = sunDirection(0.5);
  assert.ok(noon[1] > 0.8);
  const midnight = sunDirection(0);
  assert.ok(midnight[1] < 0);
  assert.ok(isValidAppearance(DEFAULT_APPEARANCE));
  assert.ok(!isValidAppearance({ ...DEFAULT_APPEARANCE, skin: 99 }));
});
