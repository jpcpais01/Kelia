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
    at: '2026-10-15T13:25:00Z',
    title: 'A painted wilderness',
    lines: [
      'Every tree has been regrown: big, soft crowns of hand-painted leaves that light up like balls of sunlit foliage, tiered pines with drooping boughs, white birches, and pink blossom trees ringing Hearthmere and dotting the meadows.',
      'The meadows are lush and soft now: every blade of grass grows out of the colour of the ground beneath it, silvery wind gusts roll across the fields, and wildflowers bloom in drifts of daisies, buttercups, violets, pinks and cornflowers.',
      'Cliffs show layered rock strata with mossy ledges, boulders are chunky and faceted with moss on top, and bushes are fuller, some flowering.',
    ],
  },
  {
    at: '2026-10-15T12:45:00Z',
    title: 'A calmer stride',
    lines: [
      'Walking and running look natural now: legs move at a relaxed, human rhythm with longer strides instead of a frantic shuffle, the body settles into each step, and starting, stopping and turning blend more smoothly.',
    ],
  },
  {
    at: '2026-10-15T12:15:00Z',
    title: 'Click, aim, strike, go fullscreen',
    lines: [
      'Clicking the world works again: it captures the mouse for the action camera and attacks. With the mouse free, your character turns to face your cursor, W runs toward it, A and D strafe around it, and skills fire where you point. A new button next to Settings (or F11) takes Kelia fullscreen and back, and Settings can now set the render resolution (50–200% of your screen, or automatic).',
    ],
  },
  {
    at: '2026-10-15T12:10:00Z',
    title: 'A brand new look',
    lines: [
      'Kelia now has a hand-painted anime style: soft cel shading with cool tinted shadows, glowing rim light, inked outlines on heroes and monsters, a painted sky with fluffy clouds, and a warm haze that glows toward the sun.',
      'Shadows are crisp and stable (no more flicker as you move), trees, rocks, heroes and buildings now cast them onto the grass, and distant flowers, grass tips and water glints no longer glitter.',
      'Much faster graphics: shadows and post-processing cost a fraction of what they did, trees draw far less, and WebGPU is now quicker than WebGL2 instead of slower. The world now needs far less CPU to draw (fewer, cheaper draw calls for terrain, props and wildlife), turning near forests no longer hitches, and the F3 overlay widens to show every name and number in full.',
    ],
  },
  {
    at: '2026-10-15T11:45:00Z',
    title: 'Steer with your mouse',
    lines: [
      'Your character now faces wherever you aim: W runs toward your mouse, A and D strafe sideways while you keep your eyes forward, S backs up. Standing still, look far enough around and you turn to follow.',
    ],
  },
  {
    at: '2026-10-15T11:15:00Z',
    title: 'Under the hood',
    lines: [
      'Press F3 for a performance overlay: FPS with a live frame graph, CPU time for every part of the game (terrain, grass, water, trees, characters, combat, HUD, network…) and GPU time for every render pass (shadows, the scene, bloom, light shafts, grading).',
      'Press F4 with it open to measure what each part of the world costs the GPU, and use “Copy report” to share the numbers. F3 again switches to a compact view, then hides it.',
    ],
  },
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
