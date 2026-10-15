// Player-facing patch notes. One entry per update that reaches the live game.
// The in-game panel groups them by hour (at most 5 lines per group).

export interface PatchNote {
  /** ISO time the update went live (UTC). */
  at: string;
  title: string;
  lines: string[];
}

export const PATCH_NOTES: PatchNote[] = [
  {
    at: '2026-10-15T04:40:00Z',
    title: 'A valley that breathes',
    lines: [
      'Torches flicker, chimneys smoke, mist rises from Silverfall, birds and butterflies fill the day and fireflies the night, and leaves drift through the Whisperwood. Seek out the Fairy Ring, Lantern Isle, the Old Watchtower and the Hidden Grotto.',
    ],
  },
  {
    at: '2026-10-15T04:30:00Z',
    title: 'Spoils of war',
    lines: [
      'Enemies now drop weapons, shields and outfits for your class, from uncommon to epic. The Bonelord always drops an epic weapon.',
      'Press I to open your inventory: equip gear, compare stats, drink potions and check your character’s stats.',
    ],
  },
  {
    at: '2026-10-15T04:00:00Z',
    title: 'The dead walk',
    lines: [
      'Combat is here: every fighting style has a three-hit combo, three skills (unlocking at levels 1, 3 and 5), a dodge and passives.',
      'Risen skeletons roam the meadows, forest edge and ruins, and Bonelord Varrok waits in the ruined hall. Every kill gives XP to all who helped, up to level 10.',
    ],
  },
  {
    at: '2026-10-15T03:00:00Z',
    title: 'Kelia opens its gates',
    lines: [
      'A whole valley to explore: Hearthmere village, the Whisperwood, Silverfall, Mirror Lake, the Greyspine Hills and the Ruins of Old Kelia, with a few secrets tucked away.',
      'Create your hero at the Shrine of Arrival: body, skin, face, hair, eyes, outfit and one of three fighting styles, with a name that is yours alone.',
      'Explore with friends: up to 10 players share the world, with chat, emotes (/wave, /cheer, /dance, /sit) and name plates.',
      'A living sky: a 40-minute day and night cycle with sunrises, starry nights, drifting clouds and swaying grass and trees.',
      'Sign in with Google or email to keep your hero, or jump straight in as a guest.',
    ],
  },
];

/** Groups notes by hour, newest first, capped at 5 lines per group. */
export function groupedNotes() {
  const groups = new Map<string, { label: string; lines: string[] }>();
  const sorted = [...PATCH_NOTES].sort((a, b) => b.at.localeCompare(a.at));
  for (const n of sorted) {
    const d = new Date(n.at);
    const key = n.at.slice(0, 13);
    const label = d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { label, lines: [] }));
    for (const l of n.lines) if (g.lines.length < 5) g.lines.push(l);
  }
  return [...groups.values()];
}

export const LATEST_NOTE = PATCH_NOTES.reduce((a, b) => (a.at > b.at ? a : b)).at;
