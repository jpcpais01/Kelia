// Kelia offline asset pipeline.
//
// Fetches CC0 asset packs from GitHub (KayKit by Kay Lousberg, CC0 1.0) and
// HDRIs from @pmndrs/assets (Poly Haven, CC0), then builds optimized,
// game-ready files into client/public/assets.
//
//   cd tools && npm i && node build-assets.mjs
//
// Output files are committed, so neither Vercel nor Render ever runs this.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { mergeDocuments, prune, dedup, weld, meshopt, textureCompress, unpartition, resample } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SRC = path.join(root, '.assets-src');
const OUT = path.join(root, 'client/public/assets');

const REPOS = {
  adventurers: 'KayKit-Character-Pack-Adventures-1.0',
  skeletons: 'KayKit-Character-Pack-Skeletons-1.0',
  dungeon: 'KayKit-Dungeon-Remastered-1.0',
  hexagon: 'KayKit-Medieval-Hexagon-Pack-1.0',
};

function fetchRepos() {
  fs.mkdirSync(SRC, { recursive: true });
  for (const repo of Object.values(REPOS)) {
    const dir = path.join(SRC, repo);
    if (fs.existsSync(dir)) continue;
    console.log('cloning', repo);
    execSync(`git clone --depth 1 https://github.com/KayKit-Game-Assets/${repo} "${dir}"`, { stdio: 'inherit' });
  }
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git') continue;
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (entry.name === name) return p;
  }
  return null;
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.encoder': MeshoptEncoder,
  'meshopt.decoder': MeshoptDecoder,
});

function disposeAnimation(anim) {
  for (const ch of anim.listChannels()) ch.dispose();
  for (const sm of anim.listSamplers()) sm.dispose();
  anim.dispose();
}

async function finalize(doc, outFile, { textureSize = 512 } = {}) {
  for (const anim of doc.getRoot().listAnimations()) {
    for (const sm of anim.listSamplers()) if (!anim.listChannels().some((c) => c.getSampler() === sm)) sm.dispose();
  }
  // Drop animation channels that drive Blender IK helpers (they skin nothing)
  // and channels that just hold a bone at its rest pose. This shrinks the
  // file ~5x; JSON overhead per channel is the dominant cost.
  const IK_HELPER = /IK|control-/;
  const restOf = (node, path) =>
    path === 'rotation' ? node.getRotation() : path === 'translation' ? node.getTranslation() : node.getScale();
  let dropped = 0;
  for (const anim of doc.getRoot().listAnimations()) {
    for (const ch of anim.listChannels()) {
      const node = ch.getTargetNode();
      const sampler = ch.getSampler();
      let drop = !node || IK_HELPER.test(node.getName());
      if (!drop && ch.getTargetPath() !== 'weights') {
        const out = sampler.getOutput();
        const rest = restOf(node, ch.getTargetPath());
        const n = out.getElementSize();
        const v = [];
        let constant = true;
        for (let i = 0; i < out.getCount() && constant; i++) {
          out.getElement(i, v);
          for (let k = 0; k < n; k++) if (Math.abs(v[k] - rest[k]) > 2e-4) { constant = false; break; }
        }
        drop = constant;
      }
      if (drop) { sampler.dispose(); ch.dispose(); dropped++; }
    }
  }
  if (dropped) console.log('  dropped', dropped, 'redundant animation channels');
  await doc.transform(
    resample({ tolerance: 1e-4 }),
    dedup(),
    prune({ keepLeaves: false }),
    weld(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [textureSize, textureSize], quality: 92 }),
    unpartition(),
    meshopt({ encoder: MeshoptEncoder, level: 'high' }),
    prune({ keepLeaves: false }),
  );
  // Belt and braces: drop anything no longer referenced from the scene graph.
  const r = doc.getRoot();
  const inScene = new Set();
  for (const sc of r.listScenes()) sc.traverse((n) => inScene.add(n));
  for (const n of r.listNodes()) if (!inScene.has(n)) n.dispose();
  for (const sk of r.listSkins()) if (!sk.listParents().some((p) => p.propertyType === 'Node')) sk.dispose();
  for (const a of r.listAccessors()) if (a.listParents().every((p) => p.propertyType === 'Root')) a.dispose();
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await io.write(outFile, doc);
  console.log('wrote', path.relative(root, outFile), (fs.statSync(outFile).size / 1024).toFixed(0) + ' KB');
}

// ---------------------------------------------------------------------------
// Characters: merge several KayKit characters (same 41-joint rig) into one GLB
// with a single skeleton, every body part as a separately toggleable mesh,
// and one shared, trimmed animation set.
// ---------------------------------------------------------------------------
function renameAndCollect(doc, rename) {
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const newName = rename(node.getName());
    if (newName === null) {
      node.dispose();
      continue;
    }
    if (newName) {
      node.setName(newName);
      mesh.setName(newName);
    }
  }
}

async function mergeRig({ baseFile, extraFiles, rename, keepAnims, outFile, looseProps = [] }) {
  const base = await io.read(baseFile);
  const baseRoot = base.getRoot();
  const baseSkin = baseRoot.listSkins()[0];
  const joints = baseSkin.listJoints();
  const jointByName = new Map(joints.map((j) => [j.getName(), j]));
  const baseIBM = baseSkin.getInverseBindMatrices().getArray();
  const rigNode = baseRoot.listNodes().find((n) => n.getName() === 'Rig');

  renameAndCollect(base, (n) => rename(n, path.basename(baseFile)));
  for (const anim of baseRoot.listAnimations()) {
    if (!keepAnims.includes(anim.getName())) disposeAnimation(anim);
  }

  for (const file of extraFiles) {
    const src = await io.read(file);
    const srcRoot = src.getRoot();
    for (const anim of srcRoot.listAnimations()) disposeAnimation(anim);
    const srcSkin = srcRoot.listSkins()[0];
    const srcJointNames = srcSkin.listJoints().map((j) => j.getName());
    if (srcJointNames.join() !== joints.map((j) => j.getName()).join()) {
      throw new Error('joint order mismatch in ' + file);
    }
    const ibm = srcSkin.getInverseBindMatrices().getArray();
    let maxDiff = 0;
    for (let i = 0; i < ibm.length; i++) maxDiff = Math.max(maxDiff, Math.abs(ibm[i] - baseIBM[i]));
    if (maxDiff > 1e-3) console.warn('  inverse bind matrices differ in', path.basename(file), maxDiff);
    renameAndCollect(src, (n) => rename(n, path.basename(file)));

    const map = mergeDocuments(base, src);
    const srcScene = srcRoot.listScenes()[0];
    const merged = map.get(srcScene);
    // Walk merged scene: re-home meshes onto the base skeleton.
    const moves = [];
    merged.traverse((node) => {
      if (!node.getMesh()) return;
      const parent = node.getParentNode();
      if (node.getSkin()) moves.push({ node, skinned: true });
      else if (parent && jointByName.has(parent.getName())) moves.push({ node, parentName: parent.getName() });
    });
    for (const m of moves) {
      if (m.skinned) {
        m.node.setSkin(baseSkin);
        rigNode.addChild(m.node);
      } else {
        jointByName.get(m.parentName).addChild(m.node);
      }
    }
    // Everything left in the merged scene (duplicate rig) goes away.
    const leftovers = [];
    for (const child of merged.listChildren()) child.traverse((n) => leftovers.push(n));
    for (const n of leftovers) if (!moves.some((m) => m.node === n)) n.dispose();
    merged.dispose();
    for (const skin of baseRoot.listSkins()) if (skin !== baseSkin) skin.dispose();
  }

  // Loose props (weapons from separate files), as hidden top-level nodes.
  const scene = baseRoot.listScenes()[0];
  for (const { file, name } of looseProps) {
    const src = await io.read(file);
    const srcRoot = src.getRoot();
    const map = mergeDocuments(base, src);
    const merged = map.get(srcRoot.listScenes()[0]);
    const holder = base.createNode(name);
    for (const child of merged.listChildren()) holder.addChild(child);
    holder.traverse((n) => { if (n.getMesh()) n.getMesh().setName(name); });
    scene.addChild(holder);
    merged.dispose();
  }
  for (const s of baseRoot.listScenes()) if (s !== scene) s.dispose();

  const animNames = baseRoot.listAnimations().map((a) => a.getName());
  const missing = keepAnims.filter((a) => !animNames.includes(a));
  if (missing.length) console.warn('  missing animations:', missing.join(', '));
  await finalize(base, outFile);
  return base;
}

const PLAYER_ANIMS = [
  'Idle', 'Unarmed_Idle', '2H_Melee_Idle', 'Walking_A', 'Walking_B', 'Walking_C', 'Walking_Backwards',
  'Running_A', 'Running_B', 'Running_Strafe_Left', 'Running_Strafe_Right',
  'Jump_Start', 'Jump_Idle', 'Jump_Land', 'Jump_Full_Short', 'Jump_Full_Long',
  'Dodge_Forward', 'Dodge_Backward', 'Dodge_Left', 'Dodge_Right',
  'Hit_A', 'Hit_B', 'Death_A', 'Death_A_Pose', 'Death_B',
  '1H_Melee_Attack_Chop', '1H_Melee_Attack_Slice_Diagonal', '1H_Melee_Attack_Slice_Horizontal', '1H_Melee_Attack_Stab',
  '2H_Melee_Attack_Spin', '2H_Melee_Attack_Spinning', '2H_Melee_Attack_Chop', '2H_Melee_Attack_Slice', '2H_Melee_Attack_Stab',
  'Block', 'Blocking', 'Block_Attack', 'Block_Hit',
  '2H_Ranged_Aiming', '2H_Ranged_Shoot', '2H_Ranged_Reload', '2H_Ranged_Shooting', '1H_Ranged_Shoot',
  'Spellcast_Shoot', 'Spellcast_Raise', 'Spellcast_Long', 'Spellcasting',
  'Cheer', 'Interact', 'PickUp', 'Use_Item', 'Throw', 'Unarmed_Melee_Attack_Kick',
  'Sit_Floor_Down', 'Sit_Floor_Idle', 'Sit_Floor_StandUp',
];

const SKELETON_ANIMS = [
  'Idle', 'Idle_B', 'Idle_Combat', 'Walking_A', 'Walking_D_Skeletons', 'Running_A', 'Running_C',
  'Hit_A', 'Hit_B', 'Death_A', 'Death_A_Pose', 'Death_C_Skeletons', 'Death_C_Pose',
  '1H_Melee_Attack_Chop', '1H_Melee_Attack_Jump_Chop', '1H_Melee_Attack_Slice_Diagonal', '1H_Melee_Attack_Stab',
  '2H_Melee_Attack_Chop', '2H_Melee_Attack_Spin', '2H_Melee_Attack_Slice',
  'Spellcast_Shoot', 'Spellcast_Summon', 'Spellcast_Long', 'Spellcast_Raise',
  'Spawn_Ground_Skeletons', 'Skeletons_Awaken_Standing', 'Taunt', 'Block', 'Block_Hit', 'Dodge_Backward', 'Cheer',
  '1H_Ranged_Shoot', '1H_Ranged_Aiming',
];

const ADVENTURER_PARTS = {
  Body: 'body', ArmLeft: 'armL', ArmRight: 'armR', LegLeft: 'legL', LegRight: 'legR', Head: 'head', Cape: 'cape',
  Helmet: 'hat', Hat: 'hat',
};
const ADVENTURER_PROPS = {
  '1H_Sword': 'w_sword', '2H_Sword': 'w_greatsword', '1H_Axe': 'w_axe', '2H_Axe': 'w_greataxe',
  Badge_Shield: 'sh_badge', Rectangle_Shield: 'sh_rect', Round_Shield: 'sh_round', Spike_Shield: 'sh_spike',
  Barbarian_Round_Shield: 'sh_barbarian', '2H_Staff': 'w_staff', '1H_Wand': 'w_wand', Spellbook: 'oh_spellbook',
  Knife: 'w_dagger', Knife_Offhand: 'oh_dagger', '1H_Crossbow': 'w_crossbow', Mug: 'p_mug', Throwable: 'p_bomb',
};

function adventurerRename(nodeName, file) {
  const who = file.replace('.glb', '').toLowerCase(); // knight, barbarian, mage, rogue, rogue_hooded
  if (nodeName === 'Rogue_Head_Hooded') return 'head_hooded';
  const m = nodeName.match(/^(Knight|Barbarian|Mage|Rogue)_(\w+)$/);
  if (m && ADVENTURER_PARTS[m[2]]) {
    if (who === 'rogue_hooded') return null; // only the hooded head differs
    return `${ADVENTURER_PARTS[m[2]]}_${m[1].toLowerCase()}`;
  }
  if (ADVENTURER_PROPS[nodeName]) {
    if (who === 'rogue_hooded') return null;
    return ADVENTURER_PROPS[nodeName];
  }
  return null; // drop duplicates we don't use (offhand sword copies, open spellbook...)
}

function skeletonRename(nodeName) {
  const m = nodeName.match(/^Skeleton_(Minion|Mage|Rogue|Warrior)_(\w+)$/);
  if (!m) return null;
  return `${m[2].toLowerCase()}_${m[1].toLowerCase()}`;
}

async function buildCharacters() {
  const dir = path.join(SRC, REPOS.adventurers);
  const f = (n) => findFile(dir, n);
  await mergeRig({
    baseFile: f('Knight.glb'),
    extraFiles: ['Barbarian.glb', 'Mage.glb', 'Rogue.glb', 'Rogue_Hooded.glb'].map(f),
    rename: adventurerRename,
    keepAnims: PLAYER_ANIMS,
    outFile: path.join(OUT, 'characters/adventurers.glb'),
  });
  // Export the colour atlases so the client can recolour skin and hair.
  for (const name of ['knight', 'barbarian', 'mage', 'rogue']) {
    const png = findFile(path.join(dir, 'addons'), `${name}_texture.png`);
    await sharp(png).resize(512, 512).png({ compressionLevel: 9 }).toFile(path.join(OUT, `characters/atlas_${name}.png`));
  }

  const sdir = path.join(SRC, REPOS.skeletons);
  const sf = (n) => findFile(sdir, n);
  const weapons = {
    Skeleton_Blade: 'sw_blade', Skeleton_Axe: 'sw_axe', Skeleton_Staff: 'sw_staff', Skeleton_Crossbow: 'sw_crossbow',
    Skeleton_Shield_Small_A: 'ssh_small', Skeleton_Shield_Large_A: 'ssh_large',
  };
  await mergeRig({
    baseFile: sf('Skeleton_Minion.glb'),
    extraFiles: ['Skeleton_Warrior.glb', 'Skeleton_Mage.glb', 'Skeleton_Rogue.glb'].map(sf),
    rename: skeletonRename,
    keepAnims: SKELETON_ANIMS,
    outFile: path.join(OUT, 'characters/skeletons.glb'),
    looseProps: Object.entries(weapons).map(([file, name]) => ({ file: sf(file + '.gltf'), name })),
  });
}

// ---------------------------------------------------------------------------
// Props: village buildings, ruins and clutter, merged into one GLB where each
// prop is a top-level node named "prop_<name>".
// ---------------------------------------------------------------------------
const HEX_PROPS = [
  'building_tavern_red', 'building_home_A_red', 'building_home_B_red', 'building_market_red', 'building_well_red',
  'building_windmill_red', 'building_blacksmith_red', 'building_watermill_red', 'building_tower_A_red',
  'building_church_red', 'building_destroyed', 'building_bridge_A', 'building_stage_A', 'building_scaffolding',
  'tent', 'crate_A_big', 'crate_A_small', 'crate_B_big', 'crate_long_A', 'crate_open', 'barrel', 'sack', 'weaponrack',
  'wheelbarrow', 'fence_wood_straight', 'fence_wood_straight_gate', 'fence_stone_straight', 'flag_red', 'flag_blue',
  'resource_lumber', 'resource_stone', 'bucket_water', 'bucket_arrows', 'target', 'pallet', 'ladder',
  'rock_single_A', 'rock_single_B', 'rock_single_C', 'rock_single_D', 'rock_single_E',
  'wall_straight', 'wall_corner_A_outside', 'wall_straight_gate', 'waterlily_A', 'waterlily_B', 'waterplant_A', 'waterplant_B',
];
const DUNGEON_PROPS = [
  'column', 'pillar', 'pillar_decorated', 'rubble_large', 'rubble_half', 'wall', 'wall_broken', 'wall_cracked',
  'wall_arched', 'wall_half', 'wall_corner', 'wall_pillar', 'stairs', 'chest', 'chest_gold', 'torch_lit', 'torch_mounted',
  'banner_patternA_red', 'banner_thin_red', 'banner_shield_blue', 'barrel_large', 'box_stacked', 'keg', 'table_long_decorated_A',
  'stool', 'sword_shield_broken', 'candle_triple', 'coin_stack_large', 'floor_tile_large', 'floor_tile_small_broken_A',
  'floor_tile_small_weeds_A', 'floor_dirt_large_rocky', 'bed_floor', 'trunk_large_A',
];

async function buildProps() {
  const doc = await io.read(findFile(path.join(SRC, REPOS.hexagon), 'tent.gltf'));
  // Start from an empty document that shares the IO setup.
  const rootP = doc.getRoot();
  const scene = rootP.listScenes()[0];
  for (const child of scene.listChildren()) child.traverse((n) => n.dispose());
  const add = async (file, name) => {
    if (!file) { console.warn('  missing prop', name); return; }
    const src = await io.read(file);
    const map = mergeDocuments(doc, src);
    const merged = map.get(src.getRoot().listScenes()[0]);
    const holder = doc.createNode('prop_' + name);
    for (const child of merged.listChildren()) holder.addChild(child);
    scene.addChild(holder);
    merged.dispose();
  };
  for (const p of HEX_PROPS) await add(findFile(path.join(SRC, REPOS.hexagon), p + '.gltf'), p.replace(/_red$/, ''));
  for (const p of DUNGEON_PROPS) {
    const dir = path.join(SRC, REPOS.dungeon);
    await add(findFile(dir, p + '.gltf.glb') || findFile(dir, p + '.glb'), 'd_' + p);
  }
  for (const s of rootP.listScenes()) if (s !== scene) s.dispose();
  for (const a of rootP.listAnimations()) disposeAnimation(a);
  await finalize(doc, path.join(OUT, 'props/props.glb'), { textureSize: 1024 });
}

// ---------------------------------------------------------------------------
// HDRIs: Poly Haven skies (via @pmndrs/assets, CC0) -> Radiance .hdr files.
// ---------------------------------------------------------------------------
async function buildHdris() {
  const { EXRLoader } = await import('three/examples/jsm/loaders/EXRLoader.js');
  const THREE = await import('three');
  const pm = path.join(SRC, 'pmndrs');
  if (!fs.existsSync(path.join(pm, 'package'))) {
    fs.mkdirSync(pm, { recursive: true });
    execSync('npm pack @pmndrs/assets', { cwd: pm, stdio: 'inherit' });
    execSync('tar xzf pmndrs-assets-*.tgz', { cwd: pm, shell: '/bin/bash' });
  }
  for (const name of ['sky', 'sunset', 'night', 'dawn']) {
    const js = fs.readFileSync(path.join(pm, `package/hdri/${name}.exr.js`), 'utf8');
    const b64 = js.slice(js.indexOf('base64,') + 7, js.lastIndexOf("'"));
    const buf = Buffer.from(b64, 'base64');
    const loader = new EXRLoader();
    loader.setDataType(THREE.FloatType);
    const tex = loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const { width, height, data } = tex;
    const channels = data.length / (width * height);
    const out = [Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`, 'ascii')];
    const row = Buffer.alloc(width * 4);
    // EXRLoader returns rows bottom-up; Radiance wants top-down.
    for (let y = height - 1; y >= 0; y--) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * channels;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const v = Math.max(r, g, b);
        if (v < 1e-32) { row.writeUInt32BE(0, x * 4); continue; }
        const e = Math.ceil(Math.log2(v) + 1e-9);
        const scale = 256 / Math.pow(2, e);
        row[x * 4] = Math.min(255, Math.floor(r * scale));
        row[x * 4 + 1] = Math.min(255, Math.floor(g * scale));
        row[x * 4 + 2] = Math.min(255, Math.floor(b * scale));
        row[x * 4 + 3] = e + 128;
      }
      out.push(Buffer.from(row));
    }
    const file = path.join(OUT, `env/${name}.hdr`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.concat(out));
    console.log('wrote', path.relative(root, file), width + 'x' + height);
  }
}

async function writeLicenses() {
  const text = `Third-party assets used by Kelia (all CC0 1.0 Universal / public domain)

- KayKit Character Pack: Adventurers 1.0, by Kay Lousberg (kaylousberg.com) — CC0
- KayKit Character Pack: Skeletons 1.0, by Kay Lousberg — CC0
- KayKit Dungeon Remastered 1.0, by Kay Lousberg — CC0
- KayKit Medieval Hexagon Pack 1.0, by Kay Lousberg — CC0
  Source: https://github.com/KayKit-Game-Assets
- HDRI skies from Poly Haven (polyhaven.com) via @pmndrs/assets — CC0

Everything else (terrain, water, sky, grass, trees, flowers, effects, UI) is generated in code.
`;
  fs.writeFileSync(path.join(OUT, 'LICENSES.txt'), text);
  // Self-hosted meshopt decoder for Babylon's EXT_meshopt_compression support (MIT).
  const vendor = path.join(OUT, '..', 'vendor');
  fs.mkdirSync(vendor, { recursive: true });
  fs.copyFileSync(path.join(root, 'tools/node_modules/meshoptimizer/meshopt_decoder.cjs'), path.join(vendor, 'meshopt_decoder.js'));
}

const only = process.argv[2];
fetchRepos();
if (!only || only === 'characters') await buildCharacters();
if (!only || only === 'props') await buildProps();
if (!only || only === 'hdri') await buildHdris();
await writeLicenses();
