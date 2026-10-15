// Weapon styles (classes), their skills and passives. Numbers here are the
// single source of truth for both the server (damage, cooldowns) and the
// client (tooltips, animation timing, effects).

export type ClassId = 'vanguard' | 'ranger' | 'arcanist';

export type SkillShape =
  | { kind: 'melee'; range: number; arc: number } // cone in front of the caster (arc in radians)
  | { kind: 'projectile'; range: number; speed: number; radius: number; pierce?: boolean }
  | { kind: 'aoe-self'; radius: number }
  | { kind: 'aoe-target'; range: number; radius: number }
  | { kind: 'self' }
  | { kind: 'dash'; distance: number };

export interface SkillDef {
  id: string;
  name: string;
  key: string; // default key binding label
  description: string;
  icon: string; // icon id drawn by the UI
  cooldown: number; // seconds
  /** Damage as a multiple of weapon power. 0 for utility skills. */
  power: number;
  shape: SkillShape;
  anim: string; // animation clip on the caster
  animSpeed?: number;
  /** Seconds from cast start to the moment of impact (hit frame). */
  impactAt: number;
  /** Seconds the caster is committed (can't start another action). */
  lockout: number;
  effect?: 'stun' | 'slow' | 'heal' | 'guard' | 'burn' | 'root' | 'blink';
  effectValue?: number;
  effectDuration?: number;
  vfx: string;
}

export interface PassiveDef {
  id: string;
  name: string;
  level: number;
  description: string;
  stat: 'regen' | 'crit' | 'speed' | 'maxHp' | 'power' | 'cooldown';
  value: number;
}

export interface ClassDef {
  id: ClassId;
  name: string;
  weaponStyle: string;
  tagline: string;
  description: string;
  color: string;
  baseHp: number;
  hpPerLevel: number;
  basePower: number;
  powerPerLevel: number;
  idleAnim: string;
  combo: SkillDef[]; // basic attack chain (left mouse)
  skills: SkillDef[]; // 3 active skills (1, 2, 3)
  dodge: SkillDef; // space? no: dodge is on Q / double-tap — see controls
  passives: PassiveDef[];
  startingWeapon: string; // item id
  startingOffhand?: string;
}

const meleeCombo = (names: [string, string, string]): SkillDef[] => [
  { id: 'combo1', name: 'Slash', key: 'LMB', description: '', icon: 'slash', cooldown: 0, power: 1.0, shape: { kind: 'melee', range: 2.6, arc: 2.0 }, anim: names[0], animSpeed: 1.25, impactAt: 0.32, lockout: 0.55, vfx: 'slash' },
  { id: 'combo2', name: 'Cross Cut', key: 'LMB', description: '', icon: 'slash', cooldown: 0, power: 1.15, shape: { kind: 'melee', range: 2.6, arc: 2.2 }, anim: names[1], animSpeed: 1.25, impactAt: 0.3, lockout: 0.55, vfx: 'slash' },
  { id: 'combo3', name: 'Cleave', key: 'LMB', description: '', icon: 'slash', cooldown: 0, power: 1.6, shape: { kind: 'melee', range: 2.9, arc: 2.4 }, anim: names[2], animSpeed: 1.1, impactAt: 0.42, lockout: 0.85, vfx: 'heavy', effect: 'stun', effectDuration: 0.4 },
];

export const CLASSES: Record<ClassId, ClassDef> = {
  vanguard: {
    id: 'vanguard',
    name: 'Vanguard',
    weaponStyle: 'Sword & Shield',
    tagline: 'Stand in front. Hold the line.',
    description: 'A steel-clad defender who trades blows up close, shrugs off hits behind a shield and keeps allies standing.',
    color: '#e0a64a',
    baseHp: 140,
    hpPerLevel: 22,
    basePower: 12,
    powerPerLevel: 2.4,
    idleAnim: 'Idle',
    combo: meleeCombo(['1H_Melee_Attack_Slice_Diagonal', '1H_Melee_Attack_Slice_Horizontal', '1H_Melee_Attack_Chop']),
    skills: [
      { id: 'shield_bash', name: 'Shield Bash', key: '1', description: 'Slam your shield forward, stunning enemies in front of you.', icon: 'shield', cooldown: 6, power: 1.4, shape: { kind: 'melee', range: 2.8, arc: 1.6 }, anim: 'Block_Attack', animSpeed: 1.2, impactAt: 0.28, lockout: 0.6, effect: 'stun', effectDuration: 1.6, vfx: 'bash' },
      { id: 'whirlwind', name: 'Whirlwind', key: '2', description: 'Spin with your blade, striking every enemy around you.', icon: 'spin', cooldown: 9, power: 2.2, shape: { kind: 'aoe-self', radius: 3.6 }, anim: '2H_Melee_Attack_Spin', animSpeed: 1.15, impactAt: 0.45, lockout: 0.95, vfx: 'whirl' },
      { id: 'rally', name: 'Rallying Cry', key: '3', description: 'A war cry that heals you and nearby allies and hardens your guard.', icon: 'rally', cooldown: 20, power: 0, shape: { kind: 'aoe-self', radius: 10 }, anim: 'Cheer', animSpeed: 1.3, impactAt: 0.5, lockout: 0.9, effect: 'heal', effectValue: 0.25, effectDuration: 6, vfx: 'rally' },
    ],
    dodge: { id: 'roll', name: 'Combat Roll', key: 'Q', description: 'Roll out of harm’s way.', icon: 'dodge', cooldown: 3, power: 0, shape: { kind: 'dash', distance: 5 }, anim: 'Dodge_Forward', animSpeed: 1.25, impactAt: 0, lockout: 0.5, vfx: 'dust' },
    passives: [
      { id: 'iron_skin', name: 'Iron Skin', level: 2, description: '+15% maximum health.', stat: 'maxHp', value: 0.15 },
      { id: 'second_wind', name: 'Second Wind', level: 4, description: 'Regenerate 1.5% health per second.', stat: 'regen', value: 0.015 },
      { id: 'veteran', name: 'Veteran', level: 6, description: '+12% weapon power.', stat: 'power', value: 0.12 },
      { id: 'battle_trance', name: 'Battle Trance', level: 8, description: 'Skills recharge 15% faster.', stat: 'cooldown', value: 0.15 },
    ],
    startingWeapon: 'sword_iron',
    startingOffhand: 'shield_round',
  },
  ranger: {
    id: 'ranger',
    name: 'Ranger',
    weaponStyle: 'Bow',
    tagline: 'Strike first. Never get caught.',
    description: 'A swift hunter who kites enemies from afar, pins them down and rains arrows from above.',
    color: '#6fbf73',
    baseHp: 105,
    hpPerLevel: 16,
    basePower: 13,
    powerPerLevel: 2.7,
    idleAnim: 'Idle',
    combo: [
      { id: 'combo1', name: 'Quick Shot', key: 'LMB', description: '', icon: 'arrow', cooldown: 0, power: 0.9, shape: { kind: 'projectile', range: 34, speed: 55, radius: 0.5 }, anim: '2H_Ranged_Shoot', animSpeed: 1.6, impactAt: 0.22, lockout: 0.5, vfx: 'arrow' },
      { id: 'combo2', name: 'Quick Shot', key: 'LMB', description: '', icon: 'arrow', cooldown: 0, power: 0.9, shape: { kind: 'projectile', range: 34, speed: 55, radius: 0.5 }, anim: '2H_Ranged_Shoot', animSpeed: 1.6, impactAt: 0.22, lockout: 0.5, vfx: 'arrow' },
      { id: 'combo3', name: 'Power Shot', key: 'LMB', description: '', icon: 'arrow', cooldown: 0, power: 1.7, shape: { kind: 'projectile', range: 38, speed: 70, radius: 0.6 }, anim: '2H_Ranged_Shoot', animSpeed: 1.1, impactAt: 0.34, lockout: 0.75, vfx: 'arrow_heavy' },
    ],
    skills: [
      { id: 'piercing', name: 'Piercing Arrow', key: '1', description: 'A charged arrow that passes through every enemy in a line.', icon: 'pierce', cooldown: 7, power: 2.4, shape: { kind: 'projectile', range: 40, speed: 80, radius: 0.8, pierce: true }, anim: '2H_Ranged_Shoot', animSpeed: 0.85, impactAt: 0.45, lockout: 0.8, vfx: 'arrow_pierce' },
      { id: 'volley', name: 'Arrow Volley', key: '2', description: 'Loose a volley that crashes down on the target area.', icon: 'volley', cooldown: 11, power: 2.0, shape: { kind: 'aoe-target', range: 26, radius: 4.5 }, anim: '2H_Ranged_Shoot', animSpeed: 1.0, impactAt: 0.75, lockout: 0.8, effect: 'slow', effectValue: 0.4, effectDuration: 3, vfx: 'volley' },
      { id: 'snare', name: 'Snare Shot', key: '3', description: 'Pin an enemy to the ground, rooting it in place.', icon: 'snare', cooldown: 14, power: 0.8, shape: { kind: 'projectile', range: 30, speed: 60, radius: 0.7 }, anim: '2H_Ranged_Shoot', animSpeed: 1.3, impactAt: 0.3, lockout: 0.55, effect: 'root', effectDuration: 3, vfx: 'snare' },
    ],
    dodge: { id: 'vault', name: 'Vault', key: 'Q', description: 'Leap backwards out of reach.', icon: 'dodge', cooldown: 3, power: 0, shape: { kind: 'dash', distance: 6 }, anim: 'Dodge_Backward', animSpeed: 1.3, impactAt: 0, lockout: 0.45, vfx: 'dust' },
    passives: [
      { id: 'fleet', name: 'Fleet Foot', level: 2, description: '+8% movement speed.', stat: 'speed', value: 0.08 },
      { id: 'eagle_eye', name: 'Eagle Eye', level: 4, description: '+10% critical strike chance.', stat: 'crit', value: 0.1 },
      { id: 'forager', name: 'Forager', level: 6, description: 'Regenerate 1% health per second.', stat: 'regen', value: 0.01 },
      { id: 'deadeye', name: 'Deadeye', level: 8, description: '+15% weapon power.', stat: 'power', value: 0.15 },
    ],
    startingWeapon: 'bow_hunter',
  },
  arcanist: {
    id: 'arcanist',
    name: 'Arcanist',
    weaponStyle: 'Staff',
    tagline: 'Bend the elements to your will.',
    description: 'A scholar of old magic who hurls fire, freezes the ground and mends wounds with light.',
    color: '#8f7cf0',
    baseHp: 95,
    hpPerLevel: 15,
    basePower: 15,
    powerPerLevel: 3.0,
    idleAnim: 'Idle',
    combo: [
      { id: 'combo1', name: 'Arcane Bolt', key: 'LMB', description: '', icon: 'bolt', cooldown: 0, power: 0.95, shape: { kind: 'projectile', range: 30, speed: 32, radius: 0.7 }, anim: 'Spellcast_Shoot', animSpeed: 1.5, impactAt: 0.25, lockout: 0.55, vfx: 'bolt' },
      { id: 'combo2', name: 'Arcane Bolt', key: 'LMB', description: '', icon: 'bolt', cooldown: 0, power: 0.95, shape: { kind: 'projectile', range: 30, speed: 32, radius: 0.7 }, anim: 'Spellcast_Shoot', animSpeed: 1.5, impactAt: 0.25, lockout: 0.55, vfx: 'bolt' },
      { id: 'combo3', name: 'Arcane Burst', key: 'LMB', description: '', icon: 'bolt', cooldown: 0, power: 1.8, shape: { kind: 'projectile', range: 30, speed: 26, radius: 1.1 }, anim: 'Spellcast_Shoot', animSpeed: 1.05, impactAt: 0.36, lockout: 0.8, vfx: 'bolt_big' },
    ],
    skills: [
      { id: 'fireball', name: 'Fireball', key: '1', description: 'A roaring fireball that explodes on impact and sets foes ablaze.', icon: 'fire', cooldown: 6, power: 2.3, shape: { kind: 'aoe-target', range: 28, radius: 3.5 }, anim: 'Spellcast_Long', animSpeed: 1.6, impactAt: 0.7, lockout: 0.85, effect: 'burn', effectValue: 0.15, effectDuration: 4, vfx: 'fireball' },
      { id: 'frost_nova', name: 'Frost Nova', key: '2', description: 'Erupt in a ring of ice that damages and slows everything nearby.', icon: 'frost', cooldown: 10, power: 1.6, shape: { kind: 'aoe-self', radius: 6 }, anim: '2H_Melee_Attack_Chop', animSpeed: 1.3, impactAt: 0.4, lockout: 0.7, effect: 'slow', effectValue: 0.5, effectDuration: 4, vfx: 'frost' },
      { id: 'mend', name: 'Mending Light', key: '3', description: 'Golden light that restores health to you and nearby allies.', icon: 'heal', cooldown: 16, power: 0, shape: { kind: 'aoe-self', radius: 10 }, anim: 'Spellcast_Raise', animSpeed: 1.4, impactAt: 0.55, lockout: 0.85, effect: 'heal', effectValue: 0.35, vfx: 'heal' },
    ],
    dodge: { id: 'blink', name: 'Blink', key: 'Q', description: 'Teleport a short distance forward.', icon: 'dodge', cooldown: 4, power: 0, shape: { kind: 'dash', distance: 7 }, anim: 'Dodge_Forward', animSpeed: 1.6, impactAt: 0, lockout: 0.3, effect: 'blink', vfx: 'blink' },
    passives: [
      { id: 'focus', name: 'Focus', level: 2, description: 'Skills recharge 10% faster.', stat: 'cooldown', value: 0.1 },
      { id: 'arcane_flow', name: 'Arcane Flow', level: 4, description: 'Regenerate 1.2% health per second.', stat: 'regen', value: 0.012 },
      { id: 'spellblade', name: 'Overcharge', level: 6, description: '+8% critical strike chance.', stat: 'crit', value: 0.08 },
      { id: 'archmage', name: 'Archmage', level: 8, description: '+15% weapon power.', stat: 'power', value: 0.15 },
    ],
    startingWeapon: 'staff_apprentice',
  },
};

export const CLASS_LIST: ClassDef[] = [CLASSES.vanguard, CLASSES.ranger, CLASSES.arcanist];
export const isClassId = (v: unknown): v is ClassId => v === 'vanguard' || v === 'ranger' || v === 'arcanist';
