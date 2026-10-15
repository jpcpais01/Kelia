// Attack timing: turns a stock attack clip into a strike with weight.
//
// The KayKit clips play every attack at one even pace, and their contact
// frames rarely line up with the moment the server resolves the hit. Here each
// clip's key poses were measured from the hand's speed (tools: sample the
// handslot bones over the clip): when the wind-up is coiled, when the weapon
// connects, and when the follow-through settles. A timeline then re-times the
// clip so that:
//   - the wind-up moves quickly into the coil and then hangs there (anticipation),
//   - the strike snaps from coil to contact in a few frames (the smear),
//   - contact lands exactly on the gameplay impact time,
//   - the follow-through decelerates past contact, then eases home (recovery).
// The same timeline drives the body overlay in CharacterModel (coil, lunge,
// plant) and the weapon trails in fx/skills.ts, so all three stay in sync.
import type { SkillDef } from '@kelia/shared';
import type { Animator, Beat } from './animator';

/** Key poses of a clip, in clip seconds. */
export interface ClipKeys {
  /** Wind-up is fully coiled. */
  cock: number;
  /** The weapon (or spell) connects / releases. */
  contact: number;
  /** Follow-through has spent its momentum. */
  settle: number;
  /** Last frame of the clip. */
  end: number;
}

export const CLIP_KEYS: Record<string, ClipKeys> = {
  // Sword & shield (and skeleton warriors: same rig, same clips)
  '1H_Melee_Attack_Slice_Diagonal': { cock: 0.3, contact: 0.44, settle: 0.54, end: 1.0 },
  '1H_Melee_Attack_Slice_Horizontal': { cock: 0.2, contact: 0.29, settle: 0.42, end: 1.067 },
  '1H_Melee_Attack_Chop': { cock: 0.5, contact: 0.62, settle: 0.72, end: 1.067 },
  '1H_Melee_Attack_Stab': { cock: 0.31, contact: 0.42, settle: 0.5, end: 1.6 },
  '1H_Melee_Attack_Jump_Chop': { cock: 0.47, contact: 0.77, settle: 0.84, end: 1.333 },
  Block_Attack: { cock: 0.27, contact: 0.42, settle: 0.5, end: 1.067 },
  '2H_Melee_Attack_Spin': { cock: 0.57, contact: 0.72, settle: 0.84, end: 2.4 },
  '2H_Melee_Attack_Chop': { cock: 0.6, contact: 0.86, settle: 0.93, end: 1.633 },
  '2H_Melee_Attack_Slice': { cock: 0.31, contact: 0.43, settle: 0.5, end: 1.1 },
  // Bow: full draw, release, recoil
  '2H_Ranged_Shoot': { cock: 0.25, contact: 0.31, settle: 0.42, end: 1.067 },
  // Staff and spells
  Spellcast_Shoot: { cock: 0.1, contact: 0.24, settle: 0.33, end: 0.933 },
  Spellcast_Long: { cock: 1.4, contact: 1.52, settle: 1.63, end: 2.533 },
  Spellcast_Raise: { cock: 0.45, contact: 0.64, settle: 0.76, end: 2.1 },
  Cheer: { cock: 0.04, contact: 0.13, settle: 0.26, end: 1.667 },
};

export interface TimelineOptions {
  /** Clip second to start from (skip a slow lead-in). */
  start?: number;
  /** Strike duration (coil → contact), game seconds. */
  snap?: number;
  /** Follow-through duration (contact → settle), game seconds. */
  follow?: number;
  /** Recovery duration (settle → end of clip), game seconds. */
  recover?: number;
}

export interface Timeline {
  beats: Beat[];
  /** Game seconds from the start: coil reached / strike starts. */
  strikeAt: number;
  contactAt: number;
  settleAt: number;
  duration: number;
}

/**
 * Re-time `clip` so its contact lands at `contactAt` (game seconds after the
 * start). Returns null for clips without measured keys (they play as before).
 */
export function attackTimeline(clip: string, contactAt: number, o: TimelineOptions = {}): Timeline | null {
  const k = CLIP_KEYS[clip];
  if (!k) return null;
  const start = Math.min(o.start ?? 0, k.cock - 0.05);
  const authoredStrike = k.contact - k.cock;
  // strike faster than authored, but never so fast it reads as a pop
  const snap = Math.min(contactAt * 0.5, o.snap ?? Math.max(0.06, Math.min(0.11, authoredStrike * 0.6)));
  const windEnd = Math.max(0.02, contactAt - snap);
  const follow = o.follow ?? Math.max(0.1, Math.min(0.2, (k.settle - k.contact) * 1.3));
  const recover = o.recover ?? Math.max(0.3, Math.min(0.85, (k.end - k.settle) / 1.5));
  const coil = start + (k.cock - start) * 0.88;
  const last = k.end - 0.06;
  const beats: Beat[] = [
    [0, start, 'linear'],
    // quickly into the coil...
    [windEnd * 0.6, coil, 'out'],
    // ...then hang there, still tightening
    [windEnd, k.cock, 'inout'],
    // snap through: accelerating into contact
    [contactAt, k.contact, 'in'],
    // momentum carries past contact and dies off
    [contactAt + follow, k.settle, 'out'],
    // and home
    [contactAt + follow + recover, last, 'inout'],
  ];
  return { beats, strikeAt: windEnd, contactAt, settleAt: contactAt + follow, duration: contactAt + follow + recover };
}

/** When a player skill's motion connects (the release for spells and arrows). */
export function releaseAt(skill: SkillDef) {
  if (skill.vfx === 'fireball') return skill.impactAt * 0.55;
  if (skill.vfx === 'volley') return skill.impactAt * 0.4;
  return skill.impactAt;
}

/** Timing tweaks per skill: lead-ins to skip, heavier strikes. */
export function skillTimeline(skill: SkillDef): Timeline | null {
  const at = releaseAt(skill);
  switch (skill.vfx) {
    case 'fireball':
      // from mid-channel: the gather is the fade-in
      return attackTimeline(skill.anim, at, { start: 0.95, snap: 0.08 });
    case 'heavy':
      return attackTimeline(skill.anim, at, { snap: 0.1, follow: 0.18 });
    case 'arrow':
      return attackTimeline(skill.anim, at, { snap: 0.045, follow: 0.12, recover: 0.3 });
    case 'arrow_heavy':
    case 'arrow_pierce':
      return attackTimeline(skill.anim, at, { snap: 0.05, follow: 0.16 });
    case 'whirl':
      return attackTimeline(skill.anim, at, { snap: 0.1, follow: 0.24, recover: 0.6 });
    default:
      return attackTimeline(skill.anim, at);
  }
}

/**
 * How the body sells a skill: `strike` coils and lunges into a melee blow,
 * `release` leans into the aim and kicks back on the shot, `cast` gathers and
 * pushes a spell out.
 */
export type AttackStyle = 'strike' | 'release' | 'cast';

export function skillStyle(skill: SkillDef): AttackStyle {
  const k = skill.shape.kind;
  if (k === 'melee' || (k === 'aoe-self' && skill.power > 0)) return 'strike';
  if (skill.vfx.startsWith('arrow') || skill.vfx === 'snare' || skill.vfx === 'volley') return 'release';
  return skill.vfx === 'rally' ? 'strike' : 'cast';
}

/** How hard a skill hits, 0..1 (drives lunge, plant, hit-stop and shake). */
export function skillWeight(skill: SkillDef): number {
  switch (skill.vfx) {
    case 'heavy':
    case 'whirl':
      return 1;
    case 'bash':
      return 0.85;
    case 'slash':
      return skill.id === 'combo2' ? 0.6 : 0.55;
    case 'frost':
      return 0.8;
    case 'rally':
      return 0.6;
    case 'fireball':
    case 'bolt_big':
      return 0.5;
    case 'arrow_heavy':
    case 'arrow_pierce':
      return 0.45;
    default:
      return 0.3;
  }
}

/** Play a skill's clip on its timeline; returns the timeline (null: plain playback). */
export function playSkillAnim(an: Animator, skill: SkillDef, upper?: boolean): Timeline | null {
  const tl = skillTimeline(skill);
  an.play(skill.anim, {
    speed: skill.animSpeed ?? 1,
    upper,
    // a spell from mid-channel blends in as the gather
    fadeIn: skill.vfx === 'fireball' ? 0.14 : 0.06,
    fadeOut: 0.22,
    beats: tl?.beats,
    phase: tl ? { strikeAt: tl.strikeAt, contactAt: tl.contactAt, settleAt: tl.settleAt, power: skillWeight(skill), style: skillStyle(skill) } : undefined,
    cancelAfter: tl ? Math.max(skill.lockout, tl.settleAt) : undefined,
  });
  return tl;
}

/**
 * Dodge rolls: an explosive push-off, the roll carried across the whole dash,
 * and a soft landing as it ends (the stock clip is over before the dash is).
 */
export function dodgeBeats(lockout: number): Beat[] {
  return [
    [0, 0, 'linear'],
    [0.07, 0.1, 'out'],
    [lockout * 0.8, 0.3, 'inout'],
    [lockout + 0.12, 0.37, 'out'],
  ];
}
