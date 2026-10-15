// Enemies of the valley: risen skeletons in four kinds and the Bonelord who
// rules the ruins. Shared by the server (AI, damage, rewards) and the client
// (models, animation, telegraphs).
import type { Rarity } from './items';

export type MonsterId = 'minion' | 'rogue' | 'mage' | 'warrior' | 'king';

export interface MonsterAttack {
  name: string;
  anim: string;
  speed?: number;
  /** Seconds from the start of the swing to the moment it lands. */
  impactAt: number;
  /** Seconds the monster is committed to the attack. */
  lockout: number;
  cooldown: number;
  /** The monster starts this attack when its target is this close. */
  range: number;
  power: number;
  /**
   * melee: cone in front (arc radians); spin: circle around itself;
   * slam: circle at the target's position (telegraphed);
   * projectile: a missile flying at the target.
   */
  kind: 'melee' | 'spin' | 'slam' | 'projectile';
  arc?: number;
  radius?: number;
  projSpeed?: number;
  /** Leap towards the target during the wind-up (metres). */
  lunge?: number;
  /** Show a warning circle on the ground for this attack. */
  telegraph?: boolean;
}

export interface LootEntry {
  id: string;
  chance: number;
  qty?: [number, number];
}

/** Chance to drop a piece of gear for the killer's class, and of which rarity. */
export interface GearDrop {
  chance: number;
  rarity: Rarity[];
  /** Chance to drop an outfit as well. */
  outfit: number;
}

export interface MonsterDef {
  id: MonsterId;
  name: string;
  level: number;
  hp: number;
  power: number;
  walkSpeed: number;
  runSpeed: number;
  /** Notices players within this distance. */
  aggro: number;
  /** Gives up the chase this far from home. */
  leash: number;
  /** Size relative to a player character. */
  scale: number;
  /** Collision / hit radius in metres. */
  radius: number;
  parts: string[];
  weapon?: string;
  offhand?: string;
  eyeColor: string;
  attacks: MonsterAttack[];
  /** Keeps at least this distance from its target (casters). */
  keepAway?: number;
  xp: number;
  /** Seconds before it rises again. */
  respawn: number;
  loot: LootEntry[];
  gear: GearDrop;
  boss?: boolean;
}

const parts = (kind: string, extra: string[] = []) =>
  ['armleft', 'armright', 'body', 'legleft', 'legright', 'jaw'].map((p) => `${p}_${kind}`).concat(extra);

export const MONSTERS: Record<MonsterId, MonsterDef> = {
  minion: {
    id: 'minion',
    name: 'Restless Bones',
    level: 1,
    hp: 60,
    power: 6,
    walkSpeed: 1.4,
    runSpeed: 3.9,
    aggro: 13,
    leash: 38,
    scale: 0.92,
    radius: 0.5,
    parts: parts('minion', ['head_minion', 'eyes_minion', 'cloak_minion']),
    weapon: 'sw_blade',
    eyeColor: '#ffd23a',
    attacks: [{ name: 'Chop', anim: '1H_Melee_Attack_Chop', speed: 1.1, impactAt: 0.5, lockout: 1.05, cooldown: 1.7, range: 2.1, power: 1, kind: 'melee', arc: 1.8 }],
    xp: 24,
    respawn: 25,
    loot: [{ id: 'potion_small', chance: 0.22 }],
    gear: { chance: 0.07, rarity: ['uncommon'], outfit: 0.03 },
  },
  rogue: {
    id: 'rogue',
    name: 'Hollow Stalker',
    level: 3,
    hp: 95,
    power: 9,
    walkSpeed: 1.6,
    runSpeed: 5.2,
    aggro: 16,
    leash: 45,
    scale: 0.95,
    radius: 0.5,
    parts: parts('rogue', ['head_rogue', 'eyes_rogue', 'hood_rogue', 'cape_rogue']),
    weapon: 'sw_blade',
    eyeColor: '#7dff8a',
    attacks: [
      { name: 'Pounce', anim: '1H_Melee_Attack_Jump_Chop', speed: 1.15, impactAt: 0.62, lockout: 1.2, cooldown: 7, range: 7, power: 1.7, kind: 'melee', arc: 1.6, lunge: 5.5, telegraph: true },
      { name: 'Stab', anim: '1H_Melee_Attack_Stab', speed: 1.3, impactAt: 0.32, lockout: 0.75, cooldown: 1.15, range: 2.1, power: 0.8, kind: 'melee', arc: 1.2 },
    ],
    xp: 40,
    respawn: 30,
    loot: [{ id: 'potion_small', chance: 0.3 }],
    gear: { chance: 0.11, rarity: ['uncommon', 'uncommon', 'rare'], outfit: 0.05 },
  },
  mage: {
    id: 'mage',
    name: 'Bone Hexer',
    level: 4,
    hp: 80,
    power: 11,
    walkSpeed: 1.3,
    runSpeed: 3.6,
    aggro: 20,
    leash: 40,
    scale: 0.95,
    radius: 0.5,
    parts: parts('mage', ['skull_mage', 'eyes_mage', 'hat_mage']),
    weapon: 'sw_staff',
    eyeColor: '#c47bff',
    keepAway: 9,
    attacks: [
      { name: 'Grave Burst', anim: 'Spellcast_Long', speed: 1.2, impactAt: 1.25, lockout: 1.5, cooldown: 8, range: 18, power: 1.7, kind: 'slam', radius: 3, telegraph: true },
      { name: 'Hex Bolt', anim: 'Spellcast_Shoot', speed: 1.1, impactAt: 0.45, lockout: 1.0, cooldown: 2.4, range: 19, power: 1, kind: 'projectile', radius: 0.7, projSpeed: 17 },
    ],
    xp: 48,
    respawn: 30,
    loot: [{ id: 'potion_small', chance: 0.35 }],
    gear: { chance: 0.13, rarity: ['uncommon', 'rare'], outfit: 0.06 },
  },
  warrior: {
    id: 'warrior',
    name: 'Grave Knight',
    level: 5,
    hp: 230,
    power: 14,
    walkSpeed: 1.3,
    runSpeed: 3.7,
    aggro: 14,
    leash: 36,
    scale: 1.08,
    radius: 0.6,
    parts: parts('warrior', ['head_warrior', 'eyes_warrior', 'helmet_warrior', 'cloak_warrior']),
    weapon: 'sw_axe',
    offhand: 'ssh_small',
    eyeColor: '#ff8a3a',
    attacks: [
      { name: 'Overhead', anim: '2H_Melee_Attack_Chop', speed: 1.0, impactAt: 0.72, lockout: 1.35, cooldown: 2.1, range: 2.6, power: 1.25, kind: 'melee', arc: 1.6 },
      { name: 'Sweep', anim: '2H_Melee_Attack_Slice', speed: 1.0, impactAt: 0.5, lockout: 1.1, cooldown: 4.5, range: 2.8, power: 1, kind: 'melee', arc: 2.6 },
    ],
    xp: 85,
    respawn: 45,
    loot: [{ id: 'potion_small', chance: 0.5 }, { id: 'potion_large', chance: 0.15 }],
    gear: { chance: 0.2, rarity: ['rare'], outfit: 0.08 },
  },
  king: {
    id: 'king',
    name: 'Bonelord Varrok',
    level: 7,
    hp: 1500,
    power: 17,
    walkSpeed: 1.5,
    runSpeed: 3.9,
    aggro: 17,
    leash: 32,
    scale: 1.85,
    radius: 1.1,
    parts: parts('warrior', ['head_warrior', 'eyes_warrior', 'helmet_warrior', 'cloak_warrior']),
    weapon: 'sw_axe',
    offhand: 'ssh_large',
    eyeColor: '#ff3b2f',
    attacks: [
      { name: 'Earthbreaker', anim: '1H_Melee_Attack_Jump_Chop', speed: 0.85, impactAt: 1.05, lockout: 1.9, cooldown: 11, range: 13, power: 2.2, kind: 'slam', radius: 4.2, lunge: 8, telegraph: true },
      { name: 'Bone Storm', anim: '2H_Melee_Attack_Spin', speed: 0.8, impactAt: 0.95, lockout: 1.7, cooldown: 8, range: 4.5, power: 1.7, kind: 'spin', radius: 5.2, telegraph: true },
      { name: 'Cleave', anim: '2H_Melee_Attack_Chop', speed: 0.95, impactAt: 0.78, lockout: 1.45, cooldown: 2.0, range: 3.6, power: 1.3, kind: 'melee', arc: 2.0 },
    ],
    xp: 600,
    respawn: 180,
    loot: [{ id: 'potion_large', chance: 1, qty: [2, 3] }],
    gear: { chance: 1, rarity: ['epic'], outfit: 0.5 },
    boss: true,
  },
};

export const MONSTER_IDS = Object.keys(MONSTERS) as MonsterId[];
/** Monster entity ids live above this so they never clash with players. */
export const MONSTER_ID_BASE = 1_000_000;
