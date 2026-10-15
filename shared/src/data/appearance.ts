// Character appearance options. Values are stored as small indices so they
// are cheap to send over the network and safe to validate on the server.

export interface Option {
  id: string;
  name: string;
}

export interface ColorOption extends Option {
  color: string; // hex
}

export const BODY_TYPES: (Option & { width: number; height: number; head: number })[] = [
  { id: 'lean', name: 'Lean', width: 0.9, height: 1.03, head: 0.86 },
  { id: 'average', name: 'Average', width: 1.0, height: 1.0, head: 0.88 },
  { id: 'broad', name: 'Broad', width: 1.14, height: 0.98, head: 0.9 },
];

export const SKIN_TONES: ColorOption[] = [
  { id: 'porcelain', name: 'Porcelain', color: '#f9d9c6' },
  { id: 'fair', name: 'Fair', color: '#f6c09c' },
  { id: 'honey', name: 'Honey', color: '#e3a77f' },
  { id: 'golden', name: 'Golden', color: '#cf8d5d' },
  { id: 'tan', name: 'Tan', color: '#b4744a' },
  { id: 'bronze', name: 'Bronze', color: '#925a38' },
  { id: 'umber', name: 'Umber', color: '#6c4128' },
  { id: 'ebony', name: 'Ebony', color: '#48291b' },
  { id: 'moonblood', name: 'Moonblood', color: '#b7c4d8' },
  { id: 'sylvan', name: 'Sylvan', color: '#a3c99a' },
];

export const FACES: Option[] = [
  { id: 'knight', name: 'Valiant' },
  { id: 'rogue', name: 'Keen' },
  { id: 'mage', name: 'Stern' },
  { id: 'barbarian', name: 'Rugged' },
];

export const HAIR_STYLES: Option[] = [
  { id: 'knight', name: 'Short Crop' },
  { id: 'rogue', name: 'Long Braid' },
  { id: 'mage', name: 'Neat Part' },
  { id: 'barbarian', name: 'Bearded' },
  { id: 'none', name: 'Shaved' },
];

export const HAIR_COLORS: ColorOption[] = [
  { id: 'raven', name: 'Raven', color: '#1d1a1d' },
  { id: 'chestnut', name: 'Chestnut', color: '#4b2e21' },
  { id: 'umber', name: 'Umber', color: '#7a4a2e' },
  { id: 'auburn', name: 'Auburn', color: '#9b452a' },
  { id: 'copper', name: 'Copper', color: '#cf6a2c' },
  { id: 'honey', name: 'Honey', color: '#daae7d' },
  { id: 'platinum', name: 'Platinum', color: '#ece3cf' },
  { id: 'silver', name: 'Silver', color: '#b5bac2' },
  { id: 'crimson', name: 'Crimson', color: '#a52237' },
  { id: 'midnight', name: 'Midnight', color: '#2c3d75' },
];

export const EYE_COLORS: ColorOption[] = [
  { id: 'obsidian', name: 'Obsidian', color: '#15191c' },
  { id: 'amber', name: 'Amber', color: '#b8741c' },
  { id: 'emerald', name: 'Emerald', color: '#2f8a4e' },
  { id: 'sapphire', name: 'Sapphire', color: '#2b5fae' },
  { id: 'violet', name: 'Violet', color: '#7d3fae' },
  { id: 'frost', name: 'Frost', color: '#7fd0e6' },
];

export type Headgear = 'none' | 'helmet' | 'bearhat' | 'wizard' | 'hood';

export interface Outfit extends Option {
  description: string;
  body: string; // part sets by character id: knight | barbarian | mage | rogue
  arms: string;
  legs: string;
  cape: string | null;
  headgear: Headgear;
}

/** Outfits. The first six can be picked at creation; more drop as loot. */
export const OUTFITS: Outfit[] = [
  { id: 'squire', name: "Squire's Plate", description: 'Polished steel and a crimson cape.', body: 'knight', arms: 'knight', legs: 'knight', cape: 'knight', headgear: 'helmet' },
  { id: 'ranger', name: 'Ranger Leathers', description: 'Green wool, soft boots, a forest cloak.', body: 'rogue', arms: 'rogue', legs: 'rogue', cape: 'rogue', headgear: 'hood' },
  { id: 'arcanist', name: 'Arcanist Robes', description: 'Twilight silk embroidered with brass.', body: 'mage', arms: 'mage', legs: 'mage', cape: 'mage', headgear: 'wizard' },
  { id: 'northman', name: 'Northman Furs', description: 'Bearskin and leather for cold passes.', body: 'barbarian', arms: 'barbarian', legs: 'barbarian', cape: 'barbarian', headgear: 'bearhat' },
  { id: 'wanderer', name: 'Wanderer', description: 'Road-worn tunic and sturdy fur boots.', body: 'rogue', arms: 'barbarian', legs: 'barbarian', cape: null, headgear: 'none' },
  { id: 'battlemage', name: 'Battlemage', description: 'Robes reinforced with knightly steel.', body: 'mage', arms: 'knight', legs: 'knight', cape: 'knight', headgear: 'none' },
];

export interface Appearance {
  body: number;
  skin: number;
  face: number;
  hair: number;
  hairColor: number;
  eyes: number;
  outfit: number;
  /** Show the outfit's headgear (helmet, hood, hat). */
  headgear: boolean;
}

export const DEFAULT_APPEARANCE: Appearance = {
  body: 1,
  skin: 1,
  face: 1,
  hair: 1,
  hairColor: 3,
  eyes: 2,
  outfit: 1,
  headgear: false,
};

export const STARTER_OUTFIT_COUNT = 6;

export function isValidAppearance(a: unknown): a is Appearance {
  if (!a || typeof a !== 'object') return false;
  const o = a as Record<string, unknown>;
  const idx = (v: unknown, n: number) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < n;
  return (
    idx(o.body, BODY_TYPES.length) &&
    idx(o.skin, SKIN_TONES.length) &&
    idx(o.face, FACES.length) &&
    idx(o.hair, HAIR_STYLES.length) &&
    idx(o.hairColor, HAIR_COLORS.length) &&
    idx(o.eyes, EYE_COLORS.length) &&
    idx(o.outfit, OUTFITS.length) &&
    typeof o.headgear === 'boolean'
  );
}

export function sanitizeAppearance(a: Appearance): Appearance {
  return {
    body: a.body,
    skin: a.skin,
    face: a.face,
    hair: a.hair,
    hairColor: a.hairColor,
    eyes: a.eyes,
    outfit: a.outfit,
    headgear: a.headgear,
  };
}
