// Assembles a hero for an appearance: body (with the outfit's close layers
// and garments), head and face, hair (minus what headgear covers), headgear
// and cape, as skinned geometry in the rig's rest pose, plus the colours for
// the character's texture.
import { HAIR_COLORS, OUTFITS, SKIN_TONES, type Appearance } from '@kelia/shared';
import { BUILDS, buildArm, buildHand, buildLeg, buildTorso, type Dress } from './body';
import { Geo } from './geo';
import { buildHair } from './hair';
import { buildHead, buildNeck } from './head';
import type { ChainJoints } from './chains';
import { OUTFIT_DEFS } from './outfits';
import type { HeroRest } from './rig';
import { heroSkin, type PaletteColors } from './palette';

export interface HeroGeometry {
  /** Body and outfit (outlined in ink). */
  body: Geo;
  /** Head skin, ears and neck (outlined in a deep skin tone). */
  head: Geo;
  /** Hair (outlined in a deep hair tone). */
  hair: Geo;
  /** Headgear (part of the body's look; outlined in ink). */
  hat: Geo;
  /** The cape (empty when the outfit has none). */
  cape: Geo;
  /** Where the look's swinging chains (hair, cape) hang, in rig space. */
  chains: ChainJoints;
  colors: PaletteColors;
  /** Build index (selects the feminine face and the like). */
  soft: boolean;
}

const cache = new Map<string, HeroGeometry>();

export function heroKey(a: Appearance, outfit: number) {
  return [a.body, a.hair, outfit, a.headgear ? 1 : 0].join('|');
}

/** Geometry for an appearance (shared between characters that look alike). */
export function buildHero(rest: HeroRest, a: Appearance): HeroGeometry {
  const outfit = Math.min(OUTFIT_DEFS.length - 1, Math.max(0, a.outfit));
  const key = heroKey(a, outfit);
  const hit = cache.get(key);
  const colors: PaletteColors = {
    skin: heroSkin(SKIN_TONES[a.skin]?.color ?? SKIN_TONES[1].color),
    hair: HAIR_COLORS[a.hairColor]?.color ?? HAIR_COLORS[0].color,
    outfit: OUTFIT_DEFS[outfit].colors,
  };
  if (hit) return { ...hit, colors };
  const def = OUTFIT_DEFS[outfit];
  const build = BUILDS[a.body] ?? BUILDS[1];
  const soft = build.bust > 0;
  const dress: Dress = { neck: 1.48, ...def.dress };
  const body = new Geo();
  const head = new Geo();
  const hair = new Geo();
  const hat = new Geo();
  const cape = new Geo();
  const parts = { rest, build, dress };
  buildTorso(body, parts);
  for (const side of [1, -1] as const) {
    buildArm(body, side, parts);
    buildHand(body, side, parts);
    buildLeg(body, side, parts);
  }
  const showHat = !!(a.headgear && def.headgear && OUTFITS[outfit]?.headgear !== 'none');
  const chains: ChainJoints = {};
  def.garments({ g: body, cape, chains, rest, build, dress, hat: showHat });
  buildHead(head);
  buildNeck(head, soft ? 0.9 : build.limb > 1.05 ? 1.1 : 1);
  if (showHat && def.headgear) def.headgear.build({ g: body, cape, chains, rest, build, dress, hat: true }, hat);
  Object.assign(chains, buildHair(hair, a.hair, showHat && def.headgear ? def.headgear.covers : [], soft));
  const geo: HeroGeometry = { body, head, hair, hat, cape, chains, colors, soft };
  cache.set(key, geo);
  return geo;
}
