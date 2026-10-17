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
    at: '2026-10-17T20:30:00Z',
    title: 'Staff casting that reads',
    lines: ["Fixed the Arcanist's attacks with a staff or wand. Bolts and Fireball no longer cast from the empty hand with the staff pointing backward: you raise the staff before you, then thrust its head at your target, and the spell flies from the staff's head. Frost Nova no longer swings the staff flat at your waist: you lift it overhead and slam its head into the ground, then bring it back upright. Standing still, the staff now rests upright at your side instead of jutting forward like a spear."],
  },
  {
    at: '2026-10-16T08:40:00Z',
    title: 'Smoother walking and swings',
    lines: ["Fixed heroes looking glitchy when walking and fighting. Standing still, your hero no longer stands twisted to one side: they face forward, upright, with both feet planted side by side. Walking, the sword is carried pointing ahead and down instead of sticking out behind you, and a staff is held upright. Swings no longer fold the body in half or flip it sideways at the end of a slash. When an attack turns you to face your aim, your feet turn with you instead of twisting your legs round each other. A lunge now takes a step or two instead of a flurry of tiny ones."],
  },
  {
    at: '2026-10-16T08:20:00Z',
    title: 'Outfits with real detail',
    lines: ["Outfits get a detail pass. The Northman's mantle is now layered fur, with dark under-fur, shaggy tufts over the shoulders and a fur collar, and fur boots get shaggy cuffs. Skirts, robes and capes have deeper folds that catch the light, with shadow in the hollows. Metal plates and pauldrons shine toward the top. Belts have proper buckles and leather pouches with flaps. The Wanderer's scarf is wrapped twice and knotted, with its ends hanging over the chest, and their tunic has a buttoned placket."],
  },
  {
    at: '2026-10-16T07:55:00Z',
    title: 'Faces that react',
    lines: ["Heroes' faces now come alive. They blink every few seconds (sometimes twice), narrow their eyes, knit their brows and shout as they swing, and squeeze their eyes shut and grit their teeth when they take a hit. Jaws and cheeks are softer and rounder, so faces read less pointy. Other players' faces react the same way when you're close enough to see them."],
  },
  {
    at: '2026-10-16T07:40:00Z',
    title: 'Fuller hair, swinging skirts',
    lines: ["Hair is fuller and layered: locks stand out from the head toward their tips, darker locks tucked between them give the hair depth, and every lock shades from deep roots to sunlit tips. Tousled hair has more spikes. Skirts, tunics and robes now hang from the hips and swing with your walk, sway as your hips turn, flare when you stop, and get pushed aside by your legs instead of moving stiffly with them."],
  },
  {
    at: '2026-10-16T06:55:00Z',
    title: 'Skeletons walk the walk',
    lines: ["The risen skeletons now use the heroes' new walking system: their feet plant on the ground and keep pace with how fast they move instead of sliding, they step up and down slopes, they shuffle round when they turn, and their feet stay put as they lunge into a swing. Their arms keep their own menacing pose."],
  },
  {
    at: '2026-10-16T06:25:00Z',
    title: 'Footwork in a fight',
    lines: ["Your feet now stay planted when you swing, cast or shoot, instead of sliding across the ground. Lunging into a blow steps your lead foot forward and pulls the back foot after it, and turning to aim pivots on your feet with little steps. Your cape and hair whip round with the swing."],
  },
  {
    at: '2026-10-16T05:50:00Z',
    title: 'Capes and hair that move',
    lines: ["Capes and long hair now move with real physics instead of hanging stiff. A cape streams out behind you when you run, billows round when you turn, ripples in the wind and settles back when you stop, and it hangs down when you bend forward. Braids, long hair and ponytails swing and bounce with every step, and the locks framing the face sway when you turn your head. Both keep clear of your body: a cape rides over your legs and arms instead of passing through them, and long hair stays outside your shoulders. Other players' heroes move the same way."],
  },
  {
    at: '2026-10-16T04:45:00Z',
    title: 'Heroes walk like people',
    lines: ["Heroes' legs are now driven by a real walking system instead of tiny looped steps, so feet no longer skate. Each foot plants on the ground and stays put while it carries your weight. It rolls from heel to toe and swings through in an arc to the next footfall, on slopes too. Hips dip and sway over the standing leg, the chest twists against the hips and the arms swing against the legs: loose when you walk, pumping with bent elbows when you run. You lean into a sprint and rock back when you stop, the first step comes at once, stopping brings your feet together, and turning on the spot shuffles your feet round. Side-steps turn the hips into the run while you keep facing ahead. Also fixed: some animations pushed the heroes' hips and shoulders out of place."],
  },
  {
    at: '2026-10-16T02:50:00Z',
    title: 'Anime heroes',
    lines: ["Heroes are no longer chunky little figures. Every adventurer is rebuilt with anime proportions: a slim, tall body, a smaller head with a painted face (big shining eyes, lashes, brows and a blush), hair made of real locks that fall around the face, and outfits remade to fit, from the Squire's tabard to the Arcanist's robe and hat. Every creator option carries over, there's a new Graceful build, the hair styles are now Tousled, Long Braid, Side Part, High Tail and Buzz Cut, weapons are sized for the new heroes, and the creator's face view now frames the face. All the animations, gliding and combat work as before."],
  },
  {
    at: '2026-10-16T02:25:00Z',
    title: 'Deeper light and shade',
    lines: ["Shade now looks like shade: the side turned away from the sun sits a clear, cool step darker, lit only by the blue sky, and faces that barely catch the sun fall off gently instead of all glowing the same. Heroes and monsters finally stand on the ground: a soft contact shadow pools under their feet, darkens the grass around them and falls on anyone standing close. Walls, fences, crates, rocks and tree trunks get a fine dark crease where they meet the earth. The distant haze is thinner and bluer, so far mountains turn blue with distance instead of washing out to grey, and keep their sunlit and shaded sides; sunsets keep their warm glow."],
  },
  {
    at: '2026-10-16T02:20:00Z',
    title: 'Finer grass and real wildflowers',
    lines: ['Meadows are woven from far finer grass: close to you every patch is a thick carpet of slim blades, five or so to a clump, that grow out of the colour of the soil, thin out and shorten softly where the meadow meets sand or a path, and stay delicate all the way to the horizon. The wildflowers are rebuilt too: smaller, rounder daisies with a raised heart, buttercups and poppies that open as real cups, bellflowers that hang in little clusters with a shadowed inside, and lupins packed with folded florets. Petals now catch the sun and glow when it shines through them, and flowers grow in drifts that are densest at their hearts and fade out at the edges, with their colours carrying on through the grass into the distance.'],
  },
  {
    at: '2026-10-16T02:15:00Z',
    title: 'Beaches, trails and mountains with real detail',
    lines: ["The ground is no longer a flat colour. Sand along Mirror Lake and the Silverrun turns dark and wet at the water's edge, with a pale dried line and a broken line of washed-up weed above it, and the dry beach carries wind ripples, grains and the odd pebble. Trails are trodden pale down the middle with two worn ruts, gravel and stones kicked to the sides, scree gathers below the cliffs and fallen leaves litter the forest floor. The mountains now split into clear sunlit and shaded masses, with ridges catching the light and gullies falling into shade, so the peaks keep their shape through the haze even at noon."],
  },
  {
    at: '2026-10-16T02:06:00Z',
    title: 'Softer, fuller tree crowns',
    lines: ["Tree crowns no longer break up into a jagged speckle against the sky. On High and Ultra their edges are now smoothed by the graphics card itself, so they stay clean and still as you move, and trees farther than a stone's throw away swap their tiny painted leaves for bolder, fuller clumps with leafy edges, the way a painter simplifies a far-off wood. Oaks, birches, blossoms, pines and bushes all keep their own shapes. Also fixed: on Low and Medium the world could turn black in some browsers."],
  },
  {
    at: '2026-10-15T22:40:00Z',
    title: 'Bounced light is back',
    lines: ['The light that fills the world returns, now tested on every kind of graphics card: soft shade under tree crowns and at the foot of cliffs and walls, ground-tinted bounce light, and eyes that adjust as you walk from a dark wood into a sunny meadow.'],
  },
  {
    at: '2026-10-15T22:15:00Z',
    title: 'Black screen fixed for real',
    lines: ['The real cause of the black world is found and fixed: the swirling streaks of the new updrafts used a drawing trick that most modern browsers refuse, and that refusal blanked the whole picture every frame. The updrafts are rewritten so every graphics card accepts them, and the world shows again.'],
  },
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
