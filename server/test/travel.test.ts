import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Heightmap, POINTS_OF_INTEREST, waterAt } from '@kelia/shared';
import { landable, travelSpot } from '../src/travel';

const hm = new Heightmap(1).fill();

test('every place on the map has a dry, level landing spot nearby', () => {
  for (const poi of POINTS_OF_INTEREST) {
    const [x, z] = travelSpot(hm, poi);
    assert.ok(waterAt(x, z) < hm.sample(x, z), `${poi.id} lands in water`);
    const d = Math.hypot(x - poi.pos[0], z - poi.pos[1]);
    if (poi.id === 'lake') assert.ok(Math.hypot(x - 196, z + 276) > 20, 'lake lands on Lantern Isle');
    assert.ok(d < 130, `${poi.id} lands ${d.toFixed(0)} m away`);
    if (poi.id !== 'village' && poi.id !== 'shrine') assert.ok(landable(hm, x, z), `${poi.id} landing is not landable`);
    console.log(`${poi.id.padEnd(8)} -> (${x}, ${z}) ${d.toFixed(1)} m from its marker`);
  }
});
