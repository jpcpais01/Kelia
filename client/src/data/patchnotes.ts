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
    // the 21:00 hour already has its five lines, so this opens the next group
    at: '2026-10-15T22:00:00Z',
    title: 'Black screen fixed',
    lines: ['On some computers the whole world turned black after the last lighting update, leaving only the menus and map. That update is rolled back for now, so the valley shows again; the bounced light and eye adjustment will return once they work everywhere.'],
  },
  {
    at: '2026-10-15T22:00:00Z',
    title: 'Gliding',
    lines: [
      "You can fly! Fall more than 5 metres (step off a cliff, leap from a ledge) and your glider snaps open above you; Space in the air opens or folds it too. Steer with the mouse, slip sideways with A and D, W to speed up, S to brake and Shift to dive. Each class flies its own colours, the canvas ripples in the wind, wingtips stream contrails and the air roars past as you dive. Three updrafts lift you high: the Hearthmere Windwell behind the market, one at the foot of the Silverfall cliffs, and the Greyspine Thermal below Eagle's Perch, high enough to glide all the way down to the Ruins (they're on the world map). Over deep water the glider skims the surface, and everyone sees you fly.",
    ],
  },
  {
    at: '2026-10-15T21:05:00Z',
    title: 'Light that fills the world',
    lines: ['Light now behaves like it really bounces around the valley: tree crowns shade the forest floor and turn the light under them a soft green, even far beyond the real-time shadows, valleys, cliff bases and the foot of every wall gather gentle shade, and the ground tints the light it reflects. Your eyes adjust too, opening up as you walk into a dark wood and settling back down in the bright meadow, and hidden surfaces are now skipped before they are painted, which saves graphics work.'],
  },
  {
    at: '2026-10-15T21:02:00Z',
    title: 'A living view of the valley while you load',
    lines: ['The loading screen now opens on a living view of Kelia: Mirror Lake at sunset and at dawn, Hearthmere in the evening light, the wildflower meadows, the Shrine of Arrival, Silverfall, the Greyspine peaks and the vista from the heights. Clouds drift across the sky, the lakes ripple and glint, Silverfall pours down its cliff, gusts of wind roll through the grass and trees and motes of light float up through the air, gently dimmed so the title stays clear, while the camera slowly glides from one scene to the next.'],
  },
  {
    at: '2026-10-15T21:00:00Z',
    title: 'Smooth spellcasting and nature magic',
    lines: [
      'Arcanists no longer twist out of shape when chaining Arcane Bolts or casting Mending Light right after a Blink: back-to-back casts now flow into each other, and the end of every attack blends cleanly back into your stance. Spell circles are now drawn from nature instead of a hexagram: a breeze of wind swirls and leaves around an opening flower, with petals lifting off as you cast. Level ups and respawns bloom in a crown of leaves and petals, Arcane Bolts carry a spinning blossom, and enemy mages and the Bonelord call up rings of thorned briars.',
    ],
  },
  {
    at: '2026-10-15T21:00:00Z',
    title: 'Install Kelia as an app',
    lines: [
      'Kelia can now be installed like a real game: look for Install Kelia on the title screen (or the download button in the top-right menu) and it gets its own window, its own desktop and taskbar icon (a golden compass star over a twilight valley) and opens straight into fullscreen. It also starts faster on return visits, since models and game files are kept on your computer and only re-downloaded when an update changes them. You always get the newest version when you open it.',
    ],
  },
  {
    // the 20:00 hour already has its five lines, so this opens the next group
    at: '2026-10-15T21:00:00Z',
    title: 'Painted cliffs',
    lines: [
      'The mountains have a whole new look: instead of stacked grey bands, cliffs break into big bold planes of warm and cool stone, with dark cracks between them, rain-streaked gullies running down the faces, ochre patches, grassy ledges with shadow under their lips, and snow that settles on the tops and trickles down the gullies. The far ranges share the same style on a grander scale.',
    ],
  },
  {
    at: '2026-10-15T20:30:00Z',
    title: 'No more flickering specks',
    lines: ['The white specks that flickered in the meadows and around the sun are gone: flowers too small to draw cleanly melt into soft dabs of colour, glints and glowing blade tips fade before they shrink to a single pixel, nothing in the grass outshines the sky, and sparkles on the water spread into a steady shimmer instead of blinking.'],
  },
  {
    at: '2026-10-15T20:25:00Z',
    title: 'Silky-smooth minimap',
    lines: [
      'The minimap now glides and turns with you at your full frame rate instead of stepping along, and it is sharper too, with the same height lines as the world map.',
    ],
  },
  {
    at: '2026-10-15T20:12:00Z',
    title: 'Sign in with a username',
    lines: ['Accounts now use a username and password instead of an email: pick any name of 3 to 16 letters, numbers or underscores and you are in. Google sign-in is still there too.'],
  },
  {
    at: '2026-10-15T20:10:00Z',
    title: 'Wildflower meadows and shaggier trees',
    lines: [
      'The meadows bloom with five kinds of wildflower, each with its own shape: daisies in white, pink and lilac, buttercups and red or orange poppies, nodding bellflowers, tall lupin spikes and little clover pompoms. Every plant is different, with its own height, flower size and tilt, and many carry two or three blooms. Each kind grows in its own drifts, with the odd stray flower in between. Tree crowns lose their round, ball-like look too: every leaf mass now has its own shape, lumpy or tufted, squashed or drooping at the edges, some with a gap where the light shines through, from up close all the way across the valley.',
    ],
  },
  {
    at: '2026-10-15T20:05:00Z',
    title: 'Choose your time of day',
    lines: [
      'A new button next to Settings sets the sky for your own view: Automatic follows the world clock as before, or hold it at Sunrise, Day, Sunset or Night. Each click sweeps the sun smoothly to the new time, and everything follows: the light and shadows, the sky and stars, village windows and lanterns, fireflies and butterflies, and the birdsong, crickets and owls. Other players keep their own sky, and your choice is remembered.',
    ],
  },
  {
    at: '2026-10-15T19:57:00Z',
    title: 'Front view and clearer sign-in',
    lines: [
      'Press V to swing the camera smoothly round to the front and see your hero face on, framed a little closer, with their eyes turned to meet yours. You keep walking and fighting as normal, and V again glides back behind you. Account sign-in also reads its settings more forgivingly and, when something is still wrong, the title screen says exactly what (a mistyped or rejected key, a missing project) instead of a raw Firebase error; guest play always keeps working.',
    ],
  },
  {
    at: '2026-10-15T19:53:00Z',
    title: 'Trees with character',
    lines: [
      'Every tree in Kelia is now its own: bark is hand-painted per species, with ridged, mossy oak trunks, flaky red pine plates, white birch with dark scars and glossy banded cherry, and no two neighbours share quite the same shape, height, lean or shade of bark and leaves. Oaks grow as broad giants, upright crowns or gnarled leaners with low side limbs, cherries come in classic pink or pale white blossom, pines grow crooked trunks and uneven tiers, and birches by the water often grow as clusters of two or three stems.',
    ],
  },
  {
    at: '2026-10-15T19:45:00Z',
    title: 'Smoother frames',
    lines: [
      'A big performance boost with nothing lost on screen: heroes and monsters draw their whole body in one go and only animate the moves they are actually blending, the grass no longer spends any work on blades behind you or out of view, forests across the valley use lighter trees, and the sky only paints the parts you can actually see.',
    ],
  },
  {
    at: '2026-10-15T19:35:00Z',
    title: 'Teleport from the map',
    lines: [
      'Hover a place on the world map and click it to teleport there: a violet circle gathers at your feet for three seconds, then a column of light sets you down nearby, on dry ground and clear of any monster camp. Moving, attacking or taking a hit breaks the spell, you cannot teleport while monsters are hunting you, and it recharges for 20 seconds after each jump. Secret places become destinations once you have found them.',
    ],
  },
  {
    at: '2026-10-15T19:25:00Z',
    title: 'The valley comes alive with sound',
    lines: [
      'Kelia now has a soundscape, all of it created by the game itself: thrushes, warblers and tits sing from the trees, skylarks pour out their song high over the meadows, woodpeckers drum and cuckoos call in the Whisperwood, and a hawk cries over the Greyspine crags. Each bird sings from a real spot around you, so you can walk towards it, and a dawn chorus greets the sunrise. At night the crickets take over the fields, owls hoot in the wood and frogs croak along the river and Mirror Lake. Leaves rustle and swell with every gust, the wind whistles around the peaks with an echo off the rock, the river babbles beside you, Silverfall roars long before you see it and waves lap at the lake shore. Hearthmere has its own life: the smith\'s hammer rings on the anvil by day, the windmill creaks, chimes stir, torches crackle and the chapel bell rings at dawn, noon and dusk. New music, "Dawn in the Highlands", fades gently in and out between quiet pauses. Sound starts after your first click, goes quiet when you switch tabs, and Settings has a new Sound section with Master, Music and Ambience sliders.',
    ],
  },
  {
    at: '2026-10-15T18:25:00Z',
    title: 'The world map',
    lines: [
      'Press M or click the minimap to unfold a full map of Kelia: hill-shaded terrain with height lines, rivers, trails and every place you know, with your position and the way you face, other heroes by name and monsters nearby. Scroll to zoom, drag to pan and hover a place to read about it and see how far it is.',
      'Click anywhere on the map to drop a marker: a dotted line and the distance lead you there, and the minimap keeps pointing to it until you arrive. Right-click to clear it.',
    ],
  },
  {
    at: '2026-10-15T17:57:00Z',
    title: 'Lush meadows and real branches',
    lines: [
      'The grass is back in full: close to you, meadows were showing only scattered patches, and now every field is a thick carpet of arching blades in little tufts that rise into taller clumps and dip into short patches. Each blade fades from deep shade at the root to a warm sunny tip, shows a lit and a shaded half, catches glossy streaks of sun and glows when the light is behind it.',
      'Trees grow real branches: oaks fork into spreading limbs that split into branches and twigs, cherry blossoms throw long, low, twisting limbs under their pink clouds, birches climb in slender white branches, and pines show limbs under their skirts. Leaves gather in separate masses at the branch tips, so you see the wood between and beneath them, with roots spreading into the ground.',
    ],
  },
  {
    at: '2026-10-15T17:40:00Z',
    title: 'Crystal water and towering peaks',
    lines: [
      'Water has real depth now: the shallows are glass-clear over sand and pebbles with sunlight caustics dancing on the bed, fading through turquoise into deep blue. Mirror Lake reflects the clouds, the shore and the mountains, sunlight glows through the wave crests, foam washes up the beaches and Silverfall pours down in streaming white ribbons.',
      'The mountains rise far higher, with sharp snow-capped summits, chiselled rock that breaks into crisp sunlit and shaded faces, ledges, cracks and moss, and a ring of distant ranges fading blue into the haze behind the valley. The trail up to Eagle\'s Perch is a gentler climb.',
    ],
  },
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
