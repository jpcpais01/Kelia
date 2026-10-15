import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HIT_DODGED, HIT_PLAYER, MonsterState, newCharacter, statsFor, DEFAULT_APPEARANCE, type ClassId, type Hit } from '@kelia/shared';
import { Combat, PlayerCombat, type Fighter } from '../src/combat';

function setup(cls: ClassId = 'vanguard') {
  let now = 1_000_000;
  const sent: { t: string }[] = [];
  const broadcasts: { t: string; h?: Hit[] }[] = [];
  const players = new Map<number, Fighter>();
  const combat = new Combat({
    players,
    groundAt: () => 0,
    walkable: () => true,
    broadcast: (m) => broadcasts.push(m as never),
    now: () => now,
  });
  const character = newCharacter('u1', 'Tester', cls, DEFAULT_APPEARANCE);
  const p: Fighter = {
    id: 1,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    stats: statsFor(cls, 1, character.equipment),
    character,
    combat: new PlayerCombat(),
    send: (m) => sent.push(m as never),
  };
  players.set(1, p);
  const run = (seconds: number) => {
    for (let t = 0; t < seconds; t += 0.05) {
      now += 50;
      combat.tick(0.05);
    }
  };
  const minion = combat.monsters.find((m) => m.def.id === 'minion')!;
  // park every other monster far away
  for (const m of combat.monsters) if (m !== minion) { m.x = m.homeX = 5000; m.z = m.homeZ = 5000; }
  return { combat, p, sent, broadcasts, run, minion, advance: (ms: number) => (now += ms), get now() { return now; } };
}

test('a combo swing damages a monster in front, not one behind', () => {
  const { combat, p, run, minion } = setup();
  minion.x = minion.homeX = 0;
  minion.z = minion.homeZ = 1.8;
  minion.state = MonsterState.Idle;
  assert.equal(combat.act(p, 'c', 0, 0, 0, 0), true);
  run(0.5);
  assert.ok(minion.hp < minion.def.hp, 'minion took damage');
  const hp = minion.hp;
  minion.z = -1.8; // now behind the player
  minion.attack = null;
  run(1);
  assert.equal(combat.act(p, 'c', 1, 0, 0, 0), true);
  run(0.5);
  assert.equal(minion.hp, hp);
});

test('actions respect lockouts, cooldowns and skill unlocks', () => {
  const { combat, p, run } = setup();
  assert.equal(combat.act(p, 's', 0, 0, 0, 0), true); // shield bash
  assert.equal(combat.act(p, 'c', 0, 0, 0, 0), false); // still committed
  run(1);
  assert.equal(combat.act(p, 's', 0, 0, 0, 0), false); // on cooldown
  assert.equal(combat.act(p, 's', 1, 0, 0, 0), false); // whirlwind unlocks at level 3
  p.character.level = 3;
  assert.equal(combat.act(p, 's', 1, 0, 0, 0), true);
});

test('killing a monster grants XP and levels up', () => {
  const { combat, p, run, minion, sent } = setup();
  minion.x = minion.homeX = 0;
  minion.z = minion.homeZ = 1.5;
  minion.hp = 1;
  combat.act(p, 'c', 0, 0, 0, 0);
  run(0.6);
  assert.equal(minion.state, MonsterState.Dead);
  assert.equal(p.character.xp, minion.def.xp);
  combat.giveXp(p, 1000);
  assert.ok(p.character.level >= 3);
  assert.equal(p.character.hp, p.stats.maxHp);
  assert.ok(sent.some((m) => m.t === 'me'));
});

test('monsters chase, hit, and can be dodged', () => {
  const { combat, p, run, minion, broadcasts } = setup();
  minion.x = minion.homeX = 0;
  minion.z = minion.homeZ = 6;
  minion.state = MonsterState.Idle;
  run(3);
  const hpAfter = p.character.hp;
  assert.ok(hpAfter < p.stats.maxHp, 'player was hit');
  assert.ok(broadcasts.some((b) => b.t === 'mact'));
  // dodge right before the next swing lands
  p.combat.busyUntil = 0;
  p.combat.cooldowns.clear();
  let dodged = false;
  for (let i = 0; i < 80 && !dodged; i++) {
    if (minion.attack && combat.act(p, 'd', 0, 0, 0, 0)) {
      run(1.2);
      dodged = broadcasts.some((b) => b.t === 'hit' && b.h!.some((h) => h[0] === 1 && (h[2] & (HIT_PLAYER | HIT_DODGED)) === (HIT_PLAYER | HIT_DODGED)));
    } else run(0.05);
  }
  assert.ok(dodged, 'a dodge avoided a hit');
});

test('dying stops attacks; respawn restores health in the village', () => {
  const { combat, p, run, minion, sent, advance } = setup();
  minion.x = minion.homeX = 0;
  minion.z = minion.homeZ = 1.6;
  minion.state = MonsterState.Idle;
  p.character.hp = 1;
  for (let i = 0; i < 80 && !p.combat.dead; i++) run(0.05);
  assert.equal(p.combat.dead, true);
  assert.ok(sent.some((m) => m.t === 'died'));
  assert.equal(combat.act(p, 'c', 0, 0, 0, 0), false);
  assert.equal(combat.respawn(p), false); // too soon
  advance(3000);
  assert.equal(combat.respawn(p), true);
  assert.equal(p.character.hp, p.stats.maxHp);
});

test('potions heal and use up the stack', () => {
  const { combat, p, run } = setup();
  p.character.hp = 10;
  const before = p.character.inventory.find((s) => s.id === 'potion_small')!.qty;
  combat.usePotion(p, 'potion_small');
  run(0.1);
  assert.ok(p.character.hp > 10);
  assert.equal(p.character.inventory.find((s) => s.id === 'potion_small')!.qty, before - 1);
  combat.usePotion(p, 'potion_small'); // on cooldown
  assert.equal(p.character.inventory.find((s) => s.id === 'potion_small')!.qty, before - 1);
});

test('ranger arrows travel and hit at range', () => {
  const { combat, p, run, minion } = setup('ranger');
  minion.x = minion.homeX = 0;
  minion.z = minion.homeZ = 20;
  minion.state = MonsterState.Idle;
  combat.act(p, 'c', 0, 0, 0, 20);
  run(1);
  assert.ok(minion.hp < minion.def.hp);
});
