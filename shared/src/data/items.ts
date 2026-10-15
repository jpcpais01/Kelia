import type { ClassId } from './classes';

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic';
export type ItemKind = 'weapon' | 'offhand' | 'outfit' | 'consumable';

export interface ItemDef {
  id: string;
  name: string;
  kind: ItemKind;
  rarity: Rarity;
  description: string;
  icon: string;
  /** Which class can equip it (weapons/offhands). */
  cls?: ClassId;
  /** Mesh node in the character GLB, or 'bow:<variant>' for procedural bows. */
  mesh?: string;
  /** Optional emissive tint for magical variants. */
  glow?: string;
  tint?: string;
  stats?: { power?: number; crit?: number; hp?: number; speed?: number };
  /** For outfits: index into OUTFITS. */
  outfit?: number;
  /** For consumables. */
  heal?: number;
  stack?: number;
  value: number; // flavour gold value
}

export const RARITY_COLORS: Record<Rarity, string> = {
  common: '#c9c4b8',
  uncommon: '#6fd27a',
  rare: '#59a6ff',
  epic: '#c27bff',
};

export const ITEMS: Record<string, ItemDef> = {
  // Sword & shield
  sword_iron: { id: 'sword_iron', name: 'Iron Sword', kind: 'weapon', rarity: 'common', cls: 'vanguard', mesh: 'w_sword', description: 'Dependable steel from the Hearthmere forge.', icon: 'sword', stats: { power: 10 }, value: 10 },
  axe_woodsman: { id: 'axe_woodsman', name: "Woodsman's Axe", kind: 'weapon', rarity: 'uncommon', cls: 'vanguard', mesh: 'w_axe', description: 'Heavier than it looks. Bites deep.', icon: 'axe', stats: { power: 14, crit: 0.02 }, value: 30 },
  dagger_bone: { id: 'dagger_bone', name: 'Bonecarver', kind: 'weapon', rarity: 'rare', cls: 'vanguard', mesh: 'w_dagger', tint: '#e8e0c8', description: 'Taken from the ruins. Quick and wicked.', icon: 'dagger', stats: { power: 15, crit: 0.08 }, value: 80 },
  sword_ember: { id: 'sword_ember', name: 'Emberbrand', kind: 'weapon', rarity: 'epic', cls: 'vanguard', mesh: 'w_sword', glow: '#ff6a1a', description: 'The blade still remembers the forge.', icon: 'sword', stats: { power: 22, crit: 0.05, hp: 20 }, value: 250 },
  shield_round: { id: 'shield_round', name: 'Round Shield', kind: 'offhand', rarity: 'common', cls: 'vanguard', mesh: 'sh_round', description: 'Oak and iron.', icon: 'shield', stats: { hp: 10 }, value: 8 },
  shield_badge: { id: 'shield_badge', name: 'Hearthguard Shield', kind: 'offhand', rarity: 'uncommon', cls: 'vanguard', mesh: 'sh_badge', description: 'Bears the village crest.', icon: 'shield', stats: { hp: 25 }, value: 35 },
  shield_spike: { id: 'shield_spike', name: 'Spiked Bulwark', kind: 'offhand', rarity: 'rare', cls: 'vanguard', mesh: 'sh_spike', description: 'Defence is the best offence.', icon: 'shield', stats: { hp: 35, power: 3 }, value: 90 },
  // Bows (procedural meshes)
  bow_hunter: { id: 'bow_hunter', name: "Hunter's Bow", kind: 'weapon', rarity: 'common', cls: 'ranger', mesh: 'bow:hunter', description: 'Yew limbs, waxed string.', icon: 'bow', stats: { power: 10 }, value: 10 },
  bow_recurve: { id: 'bow_recurve', name: 'Recurve of the Plains', kind: 'weapon', rarity: 'uncommon', cls: 'ranger', mesh: 'bow:recurve', description: 'Snappy draw, long reach.', icon: 'bow', stats: { power: 14, crit: 0.03 }, value: 30 },
  bow_elven: { id: 'bow_elven', name: 'Whisperwood Longbow', kind: 'weapon', rarity: 'rare', cls: 'ranger', mesh: 'bow:elven', description: 'Grown, not carved.', icon: 'bow', stats: { power: 17, crit: 0.06 }, value: 85 },
  bow_starfall: { id: 'bow_starfall', name: 'Starfall', kind: 'weapon', rarity: 'epic', cls: 'ranger', mesh: 'bow:starfall', glow: '#7fd7ff', description: 'Its arrows leave light behind them.', icon: 'bow', stats: { power: 23, crit: 0.08 }, value: 260 },
  // Staves
  staff_apprentice: { id: 'staff_apprentice', name: "Apprentice's Staff", kind: 'weapon', rarity: 'common', cls: 'arcanist', mesh: 'w_staff', description: 'A green crystal, slightly chipped.', icon: 'staff', stats: { power: 10 }, value: 10 },
  wand_willow: { id: 'wand_willow', name: 'Willow Wand', kind: 'weapon', rarity: 'uncommon', cls: 'arcanist', mesh: 'w_wand', description: 'Light, quick, eager.', icon: 'wand', stats: { power: 13, crit: 0.04 }, value: 30 },
  staff_frost: { id: 'staff_frost', name: 'Rimecaller', kind: 'weapon', rarity: 'rare', cls: 'arcanist', mesh: 'w_staff', glow: '#6fd8ff', description: 'Frost creeps along the shaft.', icon: 'staff', stats: { power: 17, hp: 15 }, value: 90 },
  staff_sun: { id: 'staff_sun', name: 'Sunspire', kind: 'weapon', rarity: 'epic', cls: 'arcanist', mesh: 'w_staff', glow: '#ffc94a', description: 'Warm to the touch, even at night.', icon: 'staff', stats: { power: 24, crit: 0.05 }, value: 270 },
  // Consumables
  potion_small: { id: 'potion_small', name: 'Healing Draught', kind: 'consumable', rarity: 'common', description: 'Restores 35% of your health.', icon: 'potion', heal: 0.35, stack: 20, value: 5 },
  potion_large: { id: 'potion_large', name: 'Greater Healing Draught', kind: 'consumable', rarity: 'uncommon', description: 'Restores 70% of your health.', icon: 'potion_big', heal: 0.7, stack: 20, value: 15 },
  // Outfits (loot / starter)
  outfit_squire: { id: 'outfit_squire', name: "Squire's Plate", kind: 'outfit', rarity: 'common', outfit: 0, description: 'Polished steel and a crimson cape.', icon: 'outfit', stats: { hp: 10 }, value: 20 },
  outfit_ranger: { id: 'outfit_ranger', name: 'Ranger Leathers', kind: 'outfit', rarity: 'common', outfit: 1, description: 'Green wool, soft boots, a forest cloak.', icon: 'outfit', stats: { speed: 0.02 }, value: 20 },
  outfit_arcanist: { id: 'outfit_arcanist', name: 'Arcanist Robes', kind: 'outfit', rarity: 'common', outfit: 2, description: 'Twilight silk embroidered with brass.', icon: 'outfit', stats: { power: 1 }, value: 20 },
  outfit_northman: { id: 'outfit_northman', name: 'Northman Furs', kind: 'outfit', rarity: 'common', outfit: 3, description: 'Bearskin and leather for cold passes.', icon: 'outfit', stats: { hp: 15 }, value: 20 },
  outfit_wanderer: { id: 'outfit_wanderer', name: 'Wanderer', kind: 'outfit', rarity: 'common', outfit: 4, description: 'Road-worn tunic and sturdy fur boots.', icon: 'outfit', stats: { speed: 0.03 }, value: 20 },
  outfit_battlemage: { id: 'outfit_battlemage', name: 'Battlemage', kind: 'outfit', rarity: 'common', outfit: 5, description: 'Robes reinforced with knightly steel.', icon: 'outfit', stats: { hp: 8, power: 1 }, value: 20 },
};

export const OUTFIT_ITEM_IDS = [
  'outfit_squire',
  'outfit_ranger',
  'outfit_arcanist',
  'outfit_northman',
  'outfit_wanderer',
  'outfit_battlemage',
];

export interface InventorySlot {
  id: string;
  qty: number;
}

export interface Equipment {
  weapon: string | null;
  offhand: string | null;
  outfit: string | null;
}
