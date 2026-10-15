// The hand-authored layout of the starting area: where the village, river,
// lake, forest, hills and points of interest sit. Terrain generation and
// gameplay (spawns, monsters, minimap) all read from here.

export type Vec2 = readonly [number, number];

export const WORLD_SEED = 1337;
export const WORLD_HALF = 512; // world spans [-512, 512] on x and z (1.024 km)
export const WORLD_SIZE = WORLD_HALF * 2;
export const PLAYABLE_HALF = 470; // beyond this the mountain wall rises
export const WATER_LEVEL = 2.5; // lake surface height

export const VILLAGE = { name: 'Hearthmere', center: [0, -40] as Vec2, radius: 46, height: 7.2 };
export const SHRINE = { name: 'Shrine of Arrival', center: [-62, -16] as Vec2, radius: 9 };
export const LAKE = { name: 'Mirror Lake', center: [170, -255] as Vec2, radius: 88 };
export const RUINS = { name: 'Ruins of Old Kelia', center: [255, 25] as Vec2, radius: 42 };
export const HILLS = { name: 'Greyspine Hills', center: [255, 255] as Vec2, radius: 230 };
export const VIEWPOINT = { name: "Eagle's Perch", center: [300, 335] as Vec2 };
export const FOREST = { name: 'Whisperwood', center: [-280, 0] as Vec2 };
export const WATERFALL = { name: 'Silverfall', center: [-28, 226] as Vec2 };

/** Silverrun river: from the northern plateau, over Silverfall, into Mirror Lake. */
export const RIVER_POINTS: Vec2[] = [
  [-95, 420],
  [-70, 350],
  [-48, 290],
  [-30, 240],
  [-26, 214], // foot of the falls
  [-8, 165],
  [30, 110],
  [62, 55],
  [80, 0],
  [86, -55],
  [108, -120],
  [140, -185],
  [160, -215],
];

export interface PointOfInterest {
  id: string;
  name: string;
  pos: Vec2;
  kind: 'village' | 'ruins' | 'waterfall' | 'viewpoint' | 'lake' | 'forest' | 'secret' | 'shrine' | 'hills';
  hidden?: boolean;
  description: string;
}

export const POINTS_OF_INTEREST: PointOfInterest[] = [
  { id: 'village', name: VILLAGE.name, pos: VILLAGE.center, kind: 'village', description: 'A lantern-lit camp village where every adventure begins.' },
  { id: 'shrine', name: SHRINE.name, pos: SHRINE.center, kind: 'shrine', description: 'Standing stones that hum when new souls arrive.' },
  { id: 'ruins', name: RUINS.name, pos: RUINS.center, kind: 'ruins', description: 'Broken halls of the old kingdom. Something still walks there.' },
  { id: 'falls', name: WATERFALL.name, pos: WATERFALL.center, kind: 'waterfall', description: 'The Silverrun tumbles off the northern plateau.' },
  { id: 'perch', name: VIEWPOINT.name, pos: VIEWPOINT.center, kind: 'viewpoint', description: 'The highest crag of the Greyspine. All of Kelia below you.' },
  { id: 'lake', name: LAKE.name, pos: LAKE.center, kind: 'lake', description: 'Still water that holds the whole sky.' },
  { id: 'forest', name: FOREST.name, pos: FOREST.center, kind: 'forest', description: 'Old trees that whisper when the wind turns.' },
  { id: 'grotto', name: 'Hidden Grotto', pos: [-36, 232], kind: 'secret', hidden: true, description: 'A dry ledge tucked behind the falling water.' },
  { id: 'fairy', name: 'Fairy Ring', pos: [-318, 140], kind: 'secret', hidden: true, description: 'A perfect circle of glowing mushrooms deep in the wood.' },
  { id: 'isle', name: 'Lantern Isle', pos: [196, -276], kind: 'secret', hidden: true, description: 'A tiny island with a lantern that never goes out.' },
  { id: 'tower', name: 'Old Watchtower', pos: [-210, -300], kind: 'secret', hidden: true, description: 'A lonely tower watching the southern pass.' },
];

/** Dirt trails, drawn into the ground colour and kept clear of grass. */
export const PATHS: Vec2[][] = [
  // village -> shrine
  [[0, -40], [-30, -30], [-62, -16]],
  // village -> north, along the river to the falls
  [[0, -40], [20, -5], [30, 50], [12, 120], [-8, 175], [-22, 208]],
  // village -> east bridge -> ruins
  [[0, -40], [40, -38], [84, -30], [130, -10], [190, 10], [232, 22]],
  // village -> south-east to the lake shore
  [[0, -40], [30, -90], [70, -150], [105, -195]],
  // village -> west into Whisperwood
  [[0, -40], [-50, -60], [-120, -55], [-180, -30], [-240, 20], [-300, 110]],
  // ruins -> hills trail up to Eagle's Perch
  [[232, 22], [250, 90], [262, 170], [282, 250], [298, 320]],
  // village -> south-west to the watchtower
  [[0, -40], [-40, -120], [-110, -210], [-190, -285]],
];

export const SPAWN_POINT: Vec2 = [6, -32];

/** Village buildings (prop name, x, z, rotationY radians, scale). */
export interface Placement {
  prop: string;
  x: number;
  z: number;
  rot: number;
  scale: number;
  collide?: number; // collision radius (m), 0/undefined = none
}

export const VILLAGE_PROPS: Placement[] = [
  // buildings (KayKit hex kit: ~1 unit per building, scaled to real size)
  { prop: 'building_tavern', x: -18, z: -14, rot: Math.PI * 0.95, scale: 8.5, collide: 5.2 },
  { prop: 'building_home_A', x: 22, z: -16, rot: Math.PI * 1.15, scale: 8, collide: 3.6 },
  { prop: 'building_home_B', x: 28, z: -60, rot: Math.PI * 1.6, scale: 8, collide: 4 },
  { prop: 'building_market', x: -24, z: -62, rot: Math.PI * 0.35, scale: 7.5, collide: 5.5 },
  { prop: 'building_blacksmith', x: -36, z: -36, rot: Math.PI * 0.55, scale: 7.5, collide: 4.8 },
  { prop: 'building_well', x: 2, z: -42, rot: 0, scale: 4, collide: 1.5 },
  { prop: 'building_windmill', x: 4, z: -82, rot: Math.PI * 0.1, scale: 9, collide: 4.5 },
  { prop: 'building_home_A', x: 41, z: -38, rot: Math.PI * 1.45, scale: 7.5, collide: 3.4 },
  { prop: 'building_church', x: -6, z: 6, rot: Math.PI, scale: 8.5, collide: 4.6 },
  { prop: 'building_tower_A', x: -44, z: -2, rot: Math.PI * 0.2, scale: 7, collide: 3.6 },
  { prop: 'building_stage_A', x: 14, z: -46, rot: Math.PI * 1.5, scale: 7, collide: 0 },
  { prop: 'tent', x: 16, z: -4, rot: Math.PI * 0.9, scale: 5.5, collide: 1.6 },
  { prop: 'tent', x: -10, z: -74, rot: Math.PI * 0.1, scale: 5.5, collide: 1.6 },
  // clutter
  { prop: 'weaponrack', x: -27, z: -42, rot: Math.PI * 0.5, scale: 6 },
  { prop: 'target', x: -30, z: -50, rot: Math.PI * 0.5, scale: 6, collide: 0.5 },
  { prop: 'crate_A_big', x: -15, z: -53, rot: 0.3, scale: 5.5, collide: 0.7 },
  { prop: 'crate_A_small', x: -13.4, z: -52, rot: 0.9, scale: 5.5 },
  { prop: 'crate_open', x: -16, z: -50.5, rot: 2.4, scale: 5.5 },
  { prop: 'barrel', x: 15, z: -25, rot: 0, scale: 5.5, collide: 0.6 },
  { prop: 'barrel', x: 16.4, z: -26.2, rot: 1, scale: 5.5, collide: 0.6 },
  { prop: 'barrel', x: -11, z: -20, rot: 2, scale: 5.5, collide: 0.6 },
  { prop: 'sack', x: -21, z: -54, rot: 0.4, scale: 6 },
  { prop: 'sack', x: -20, z: -55.2, rot: 1.4, scale: 6 },
  { prop: 'wheelbarrow', x: 31, z: -47, rot: 2.2, scale: 5.5, collide: 0.8 },
  { prop: 'resource_lumber', x: -47, z: -26, rot: 0.2, scale: 5, collide: 1.6 },
  { prop: 'resource_stone', x: -40, z: -48, rot: 1.1, scale: 5, collide: 1.2 },
  { prop: 'flag', x: 9, z: -46, rot: 0, scale: 9 },
  { prop: 'flag_blue', x: -5, z: -46, rot: 0, scale: 9 },
  { prop: 'bucket_water', x: 4.4, z: -40, rot: 0, scale: 5 },
  { prop: 'bucket_arrows', x: -25.5, z: -44.5, rot: 0, scale: 5 },
  { prop: 'crate_long_A', x: 25, z: -31, rot: 0.6, scale: 5.5 },
  { prop: 'pallet', x: 24, z: -28, rot: 0.2, scale: 5.5 },
  { prop: 'ladder', x: -12.5, z: -17, rot: 0.8, scale: 4 },
  { prop: 'fence_wood_straight', x: 34, z: -70, rot: 0.3, scale: 3.2 },
  { prop: 'fence_wood_straight_gate', x: 37.4, z: -68.9, rot: 0.3, scale: 3.2 },
  { prop: 'fence_wood_straight', x: 40.8, z: -67.8, rot: 0.3, scale: 3.2 },
  { prop: 'd_torch_lit', x: 4, z: -30, rot: 0, scale: 1.7 },
  { prop: 'd_torch_lit', x: -4, z: -54, rot: 0, scale: 1.7 },
  { prop: 'd_torch_lit', x: 18, z: -38, rot: 0, scale: 1.7 },
  { prop: 'd_torch_lit', x: -14, z: -30, rot: 0, scale: 1.7 },
  { prop: 'd_stool', x: -10.5, z: -24, rot: 0.3, scale: 1 },
  { prop: 'd_table_long_decorated_A', x: -8, z: -26, rot: Math.PI / 2, scale: 0.9, collide: 1.2 },
];

/** Ruins layout around RUINS.center (positions are offsets). Dungeon kit walls are 4 m. */
const W = 4.4; // wall step at scale 1.1
export const RUINS_PROPS: Placement[] = [
  // north hall wall
  { prop: 'd_wall_broken', x: -2 * W, z: 12, rot: 0, scale: 1.1, collide: 2 },
  { prop: 'd_wall_arched', x: -W, z: 12, rot: 0, scale: 1.1, collide: 2 },
  { prop: 'd_wall', x: 0, z: 12, rot: 0, scale: 1.1, collide: 2 },
  { prop: 'd_wall_cracked', x: W, z: 12, rot: 0, scale: 1.1, collide: 2 },
  { prop: 'd_wall_half', x: 2 * W - 1.1, z: 12, rot: 0, scale: 1.1, collide: 1.2 },
  { prop: 'd_wall_corner', x: -2.5 * W - 0.4, z: 12, rot: 0, scale: 1.1, collide: 1.5 },
  // east side
  { prop: 'd_wall_cracked', x: 2.5 * W, z: 6, rot: Math.PI / 2, scale: 1.1, collide: 2 },
  { prop: 'd_wall_broken', x: 2.5 * W, z: 6 - W, rot: Math.PI / 2, scale: 1.1, collide: 2 },
  // west side
  { prop: 'd_wall', x: -2.5 * W - 0.4, z: 12 - W * 0.75, rot: Math.PI / 2, scale: 1.1, collide: 2 },
  { prop: 'd_wall_arched', x: -2.5 * W - 0.4, z: 12 - W * 1.75, rot: Math.PI / 2, scale: 1.1, collide: 2 },
  { prop: 'd_wall_half', x: -2.5 * W - 0.4, z: 12 - W * 2.75 + 1.1, rot: Math.PI / 2, scale: 1.1, collide: 1.2 },
  // pillars of the open nave
  { prop: 'd_pillar_decorated', x: -6, z: -2, rot: 0, scale: 1.1, collide: 1.1 },
  { prop: 'd_pillar_decorated', x: 6, z: -2, rot: 0, scale: 1.1, collide: 1.1 },
  { prop: 'd_pillar', x: -6, z: -12, rot: 0.4, scale: 1.1, collide: 0.9 },
  { prop: 'd_column', x: 6, z: -12, rot: 0, scale: 1.6, collide: 0.6 },
  { prop: 'd_column', x: 6, z: -18, rot: 1, scale: 1.4, collide: 0.6 },
  { prop: 'd_rubble_large', x: 4, z: -22, rot: 1.2, scale: 0.9 },
  { prop: 'd_rubble_half', x: -12, z: 4, rot: 0.3, scale: 0.9 },
  { prop: 'd_rubble_large', x: 16, z: 16, rot: 2.1, scale: 0.8 },
  { prop: 'd_rubble_half', x: 14, z: -10, rot: 4.1, scale: 0.8 },
  // altar area
  { prop: 'd_stairs', x: 0, z: 7.5, rot: Math.PI, scale: 0.55 },
  { prop: 'd_chest_gold', x: 0, z: 9.5, rot: Math.PI, scale: 0.75, collide: 0.8 },
  { prop: 'd_coin_stack_large', x: 1.6, z: 9.8, rot: 0.4, scale: 0.6 },
  { prop: 'd_candle_triple', x: -1.6, z: 9.8, rot: 0, scale: 0.9 },
  { prop: 'd_banner_patternA_red', x: -W, z: 11.4, rot: Math.PI, scale: 1.1 },
  { prop: 'd_banner_thin_red', x: W, z: 11.4, rot: Math.PI, scale: 1.1 },
  { prop: 'd_torch_lit', x: -3.5, z: 4, rot: 0, scale: 1.7 },
  { prop: 'd_torch_lit', x: 3.5, z: 4, rot: 0, scale: 1.7 },
  { prop: 'd_sword_shield_broken', x: -3, z: -8, rot: 0.6, scale: 0.9 },
  { prop: 'd_barrel_large', x: 9, z: 9, rot: 0.2, scale: 0.6, collide: 0.6 },
  { prop: 'd_keg', x: 10.4, z: 7.8, rot: 1.2, scale: 0.55 },
  { prop: 'd_trunk_large_A', x: -8, z: 9, rot: 0.3, scale: 0.75, collide: 0.6 },
  { prop: 'building_destroyed', x: -30, z: -24, rot: 0.8, scale: 9, collide: 5.5 },
  // floor
  { prop: 'd_floor_tile_large', x: 0, z: 4, rot: 0, scale: 1.1 },
  { prop: 'd_floor_tile_large', x: -W, z: 4, rot: 0, scale: 1.1 },
  { prop: 'd_floor_tile_large', x: W, z: 4, rot: 0, scale: 1.1 },
  { prop: 'd_floor_tile_small_broken_A', x: -2, z: -3, rot: 0, scale: 1.1 },
  { prop: 'd_floor_tile_small_weeds_A', x: 3, z: -6, rot: 0, scale: 1.1 },
  { prop: 'd_floor_dirt_large_rocky', x: 0, z: -14, rot: 0.5, scale: 1.1 },
];

/** Monster spawn zones (used from the combat update onwards). */
export interface SpawnZone {
  id: string;
  monster: 'minion' | 'rogue' | 'mage' | 'warrior';
  center: Vec2;
  radius: number;
  count: number;
}

export const SPAWN_ZONES: SpawnZone[] = [
  { id: 'east-meadow', monster: 'minion', center: [150, -40], radius: 50, count: 6 },
  { id: 'south-meadow', monster: 'minion', center: [40, -170], radius: 45, count: 5 },
  { id: 'forest-edge', monster: 'rogue', center: [-200, -20], radius: 55, count: 5 },
  { id: 'ruins-yard', monster: 'mage', center: [255, -10], radius: 30, count: 4 },
  { id: 'ruins-hall', monster: 'warrior', center: [255, 30], radius: 4, count: 1 },
];
