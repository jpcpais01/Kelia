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
    at: '2026-10-15T15:55:00Z',
    title: 'Attacks with weight',
    lines: [
      'Every attack now has a real swing: you coil into the wind-up, the blade snaps through, the hit freezes for a heartbeat on impact with a punch of the camera, and the follow-through carries your whole body. Monsters reel and stagger away from your blows, heroes flinch when struck, dodges push off hard, skeletons rear back before they swing, Frost Nova is now a staff slam and Mending Light raises the staff to the sky.',
    ],
  },
  {
    at: '2026-10-15T15:45:00Z',
    title: 'Who is online',
    lines: [
      'Hold Tab to see everyone in Kelia: name, level, class, health, where they are (with an arrow and distance pointing the way) and each player\'s ping.',
    ],
  },
  {
    at: '2026-10-15T15:10:00Z',
    title: 'Spectacular combat',
    lines: [
      'Every attack and skill has new effects: glowing ribbon trails and crescent arcs on swords, ground-cracking finishers, bursts of sparks on hit, and runic magic circles, cel-shaded fire, ice crystals and vortexes for every skill.',
      'Monster attacks warn you with red or purple circles, the Bonelord\'s slam cracks the earth, defeated foes dissolve and release their soul, and level-ups raise a pillar of light.',
    ],
  },
  {
    at: '2026-10-15T15:01:00Z',
    title: 'Heroes with anime flair',
    lines: [
      'Heroes look like they stepped out of an anime: bigger sparkling eyes with catch-lights, soft rosy skin with a light blush, glossy hair with a shining highlight band, polished metal that gleams, crisp sunlit rims and cleaner outlines. Capes swing as you run, glowing weapons pulse with energy along the blade, and bows are freshly carved with gilded tips. Skeletons have ivory bone, glowing eyes and a faint soul light in their ribs, and flash white when struck. Bonelord Varrok now wears blackened armour with burning red seams, with a turning blood sigil, embers and dark wisps around him.',
    ],
  },
  {
    at: '2026-10-15T14:45:00Z',
    title: 'A server closer to home',
    lines: [
      'The game server is moving from the US to Frankfurt, so players in Europe get much lower ping: movement, hits and skills land noticeably faster.',
    ],
  },
  {
    at: '2026-10-15T14:05:00Z',
    title: 'Hearthmere rebuilt',
    lines: [
      'Hearthmere has been rebuilt from the ground up: half-timbered houses with jettied upper floors, tiled roofs, dormers, shuttered windows and flower boxes, a three-storey tavern with a hanging sign and benches out front, an open smithy with a glowing forge, a stone chapel with a rose window and spire, a round watchtower and a windmill whose sails really turn.',
      'The well now stands in a cobbled square with benches, flower tubs and lantern posts strung with colourful bunting, and every building faces the square.',
      'At dusk the village comes alive: windows light up one by one, lanterns glow warm in the dark, and smoke curls from the chimneys. The standing stones at the Shrine of Arrival are now weathered, mossy monoliths.',
    ],
  },
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
