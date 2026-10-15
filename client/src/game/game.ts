// Ties everything together: title flyover and login, character creation on
// the shrine stage, then the live world with other players.
import { Vector3 } from '@babylonjs/core';
import {
  ARRIVAL_POINT,
  ARRIVAL_YAW,
  CLASSES,
  ITEMS,
  POINTS_OF_INTEREST,
  MONSTER_ID_BASE,
  dayTimeAt,
  statsFor,
  xpToNext,
  type Appearance,
  type CharacterData,
  type ClassId,
  type PointOfInterest,
  type PublicCharacter,
  type ServerMessage,
} from '@kelia/shared';
import { CharacterModel, type Look } from '../char/model';
import { MonsterModel } from '../char/monsterModel';
import { Effects } from '../fx/fx';
import type { RigLibrary } from '../char/library';
import { perf } from '../core/perf';
import { PRESETS, autoQuality, saveSettings, type UserSettings } from '../core/quality';
import { Net } from '../net/net';
import { signOut } from '../net/auth';
import { CreatorScreen, type CreatorTab } from '../ui/creator';
import type { RosterEntry } from '../ui/roster';
import { h, mount } from '../ui/dom';
import { Hud } from '../ui/hud';
import { LoginScreen } from '../ui/login';
import type { WorldMapState } from '../ui/worldMap';
import { mixer } from '../audio/mixer';
import { closeWindow, isWindowOpen, openHelp, openPatchNotes, openSettings } from '../ui/windows';
import { isInventoryOpen, openInventory, renderInventory, type InventoryActions } from '../ui/inventory';
import { LATEST_NOTE } from '../data/patchnotes';
import type { World } from '../world/world';
import { FollowCamera } from './camera';
import { CombatController } from './combat';
import { Input } from './input';
import { MonsterEntity } from './monsters';
import { LocalPlayer } from './player';
import { RemotePlayer } from './remote';

type Mode = 'title' | 'creator' | 'entering' | 'playing';

const NOTES_SEEN_KEY = 'kelia.notesSeen';

export class Game {
  private mode: Mode = 'title';
  private net = new Net();
  readonly input: Input;
  private follow: FollowCamera;
  private t = 0;
  private login: LoginScreen | null = null;
  private serverReady: Promise<{ online: number; max: number } | null>;
  private creator: CreatorScreen | null = null;
  private stageModel: CharacterModel | null = null;
  private stageYaw = ARRIVAL_YAW + 0.25;
  private stageTab: CreatorTab = 'hero';
  private stageZoom = 1;
  private player: LocalPlayer | null = null;
  private character: CharacterData | null = null;
  private myId = -1;
  /** Latest round trip per player, from the server (Tab roster). */
  private pings = new Map<number, number>();
  private rosterTimer = 0;
  private remotes = new Map<number, RemotePlayer>();
  private monsters = new Map<number, MonsterEntity>();
  private combat: CombatController | null = null;
  readonly fx: Effects;
  private hud: Hud | null = null;
  private camBlend = 1;
  private camFrom = { pos: new Vector3(), target: new Vector3() };
  private currentZone: PointOfInterest | null = null;
  private mapTimer = 0;
  private dayOverride: number | null = 0.72;

  constructor(private world: World, private lib: RigLibrary, private settings: UserSettings, private gpu: string, private monsterLib: RigLibrary) {
    this.input = new Input(world.engine.getRenderingCanvas()!);
    this.fx = new Effects(world.scene, world.terrain.heightTexture);
    this.fx.groundAt = (x, z) => world.groundAt(x, z);
    this.follow = new FollowCamera(world.camera);
    this.follow.groundAt = (x, z) => world.groundAt(x, z);
    this.follow.blocked = (x, y, z) => {
      const cr = world.props.shrineCrystal;
      if (cr && Vector3.DistanceSquared(cr.position, new Vector3(x, y, z)) < 2.6) return true;
      for (const c of world.foliage.nearby(x, z)) {
        const dx = x - c.x;
        const dz = z - c.z;
        if (dx * dx + dz * dz < c.r * c.r && y < world.groundAt(c.x, c.z) + (c.r > 2.5 ? 9 : 4)) return true;
      }
      return false;
    };
    this.applyCameraSettings();
    this.input.onLockChange = (locked) => this.hud?.setPointerLocked(locked);
    world.onUpdate((dt) => this.update(dt));
    this.serverReady = Net.wake((msg) => this.login?.setServer('waking', msg));
  }

  /** Smoothed round-trip time to the server, or null when offline. */
  get ping() {
    return this.net.connected ? this.net.rtt : null;
  }

  // ------------------------------------------------------------------ title & login
  async start() {
    this.mode = 'title';
    this.world.postfx.setDepthOfField(false, this.world.quality);
    this.login = new LoginScreen();
    this.serverReady.then((r) => {
      if (r) this.login?.setServer('on', `Realm online · ${r.online}/${r.max} adventurers`);
      else this.login?.setServer('off', 'The realm is not answering. Try again in a minute.');
    });
    let res = await this.login.result;
    for (;;) {
      try {
        this.login.setServer('waking', 'Connecting…');
        const awake = await this.serverReady;
        if (!awake) {
          this.serverReady = Net.wake((msg) => this.login?.setServer('waking', msg));
          if (!(await this.serverReady)) throw new Error('The realm is asleep and did not wake up. Please try again shortly.');
        }
        const welcome = await this.net.connect(res.token);
        this.onWelcome(welcome);
        return;
      } catch (err) {
        this.net.close();
        this.login.showError((err as Error).message);
        this.login.setServer('off', 'Not connected');
        res = await this.login.reset();
      }
    }
  }

  private onWelcome(w: Extract<ServerMessage, { t: 'welcome' }>) {
    this.login?.close();
    this.login = null;
    this.net.onClose = (reason) => this.connectionLost(reason);
    this.net.on('error', (m) => {
      if (m.code === 'replaced' || m.code === 'version') this.connectionLost(m.message);
      else this.hud?.toast(m.message);
    });
    if (w.character) this.enterWorld();
    else this.openCreator();
  }

  private connectionLost(reason: string) {
    this.input.releaseLock();
    this.input.enabled = false;
    mount(
      h(
        'div',
        { class: 'overlay-msg interactive' },
        h('div', { class: 'panel' }, h('div', { class: 'title', style: 'font-size:20px' }, 'DISCONNECTED'), h('div', { class: 'muted' }, reason), h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Reconnect')),
      ),
    );
  }

  // ------------------------------------------------------------------ creator
  private creatorSnap = true;

  private openCreator() {
    this.mode = 'creator';
    this.creatorSnap = true;
    this.dayOverride = 0.34;
    this.world.postfx.setDepthOfField(true, this.world.quality);
    this.creator = new CreatorScreen({
      onChange: (a, cls, rebuild) => this.updateStage(a, cls, rebuild),
      onTab: (tab) => (this.stageTab = tab),
      onSubmit: (name, a, cls) => this.createCharacter(name, a, cls),
    });
  }

  private lookFor(a: Appearance, cls: ClassId): Look {
    const c = CLASSES[cls];
    return { appearance: a, cls, weapon: c.startingWeapon, offhand: c.startingOffhand ?? null };
  }

  private updateStage(a: Appearance, cls: ClassId, rebuild: boolean) {
    const look = this.lookFor(a, cls);
    if (!this.stageModel) {
      this.stageModel = new CharacterModel(this.world.scene, this.lib, look, 'stage');
      this.stageModel.setShowcase(true);
      this.stageModel.setShadowCaster((m) => this.world.atmosphere.addShadowCaster(m, false));
      this.stageModel.groundAt = (x, z) => this.world.groundAt(x, z);
      const [x, z] = ARRIVAL_POINT;
      this.stageModel.root.position.set(x, this.world.groundAt(x, z), z);
      this.stageModel.animator.play('Cheer', { upper: false });
    } else if (rebuild) {
      const prevCls = this.stageModel.look.cls;
      this.stageModel.setLook(look);
      this.stageModel.setShadowCaster((m) => this.world.atmosphere.addShadowCaster(m, false));
      if (prevCls !== cls) this.stageModel.animator.play(cls === 'arcanist' ? 'Spellcast_Raise' : cls === 'ranger' ? '2H_Ranged_Aiming' : 'Block_Attack', { upper: false });
      else this.stageModel.animator.play('Interact', { upper: true, speed: 1.4 });
    } else this.stageModel.setColors(a);
  }

  private createCharacter(name: string, a: Appearance, cls: ClassId): Promise<string | null> {
    return new Promise((resolve) => {
      const offs: (() => void)[] = [];
      const done = (err: string | null) => {
        offs.forEach((f) => f());
        resolve(err);
      };
      offs.push(this.net.on('created', (m) => {
        this.character = m.character;
        done(null);
        this.creator?.close();
        this.creator = null;
        this.stageModel?.animator.play('Cheer', { upper: false });
        setTimeout(() => this.enterWorld(), 900);
      }));
      offs.push(this.net.on('nameTaken', (m) => done(`“${m.name}” is already taken. Try another name.`)));
      offs.push(this.net.on('error', (m) => done(m.message)));
      this.net.send({ t: 'create', name, cls, appearance: a });
      setTimeout(() => done('The realm did not answer. Try again.'), 12000);
    });
  }

  private updateCreatorCamera(dt: number) {
    const m = this.stageModel;
    if (!m) return;
    if (this.input.mouseButtons.size && !this.input.locked) this.stageYaw -= this.input.mouseDX * 0.008;
    this.stageZoom = Math.max(0.6, Math.min(1.6, this.stageZoom * Math.pow(1.1, this.input.wheel)));
    m.root.rotation.y += (this.stageYaw - m.root.rotation.y) * (1 - Math.exp(-dt * 8));
    m.lookTarget = this.world.camera.position;
    m.update(dt, Vector3.Zero(), 0, false);
    const close = this.stageTab === 'face' || this.stageTab === 'hair';
    const base = m.root.position;
    const focusY = close ? 1.3 : 0.95;
    const dist = (close ? 2.0 : 4.4) * this.stageZoom;
    // camera sits facing the village side of the dais, slightly off-axis
    const ang = ARRIVAL_YAW + 0.35;
    const want = new Vector3(base.x + Math.sin(ang) * dist, base.y + focusY + (close ? 0.12 : 0.55), base.z + Math.cos(ang) * dist);
    const target = new Vector3(base.x, base.y + focusY, base.z);
    // shift the subject right of centre (the panel is on the left); `right` here points to screen-left
    const right = new Vector3(Math.cos(ang), 0, -Math.sin(ang));
    target.addInPlace(right.scale(close ? 0.35 : 0.8));
    want.addInPlace(right.scale(close ? 0.35 : 0.8));
    const cam = this.world.camera;
    const k = this.creatorSnap ? 1 : 1 - Math.exp(-dt * 3.2);
    this.creatorSnap = false;
    cam.position = Vector3.Lerp(cam.position, want, k);
    const curT = cam.getTarget();
    cam.setTarget(Vector3.Lerp(curT, target, k));
    cam.fov = (40 * Math.PI) / 180;
    this.world.postfx.setFocus(base.add(new Vector3(0, focusY, 0)), close ? 0.16 : 0.24);
  }

  // ------------------------------------------------------------------ entering the world
  private enterWorld() {
    this.mode = 'entering';
    const off = this.net.on('world', (m) => {
      off();
      this.onWorld(m);
    });
    this.net.send({ t: 'enter' });
  }

  private onWorld(m: Extract<ServerMessage, { t: 'world' }>) {
    const c = m.character;
    this.character = c;
    this.myId = m.you;
    const look: Look = { appearance: c.appearance, cls: c.cls, weapon: c.equipment.weapon, offhand: c.equipment.offhand };
    const outfitIdx = (c.equipment.outfit ? ITEMS[c.equipment.outfit]?.outfit : undefined) ?? c.appearance.outfit;
    look.appearance = { ...look.appearance, outfit: outfitIdx };
    let model = this.stageModel;
    if (model) {
      model.setShowcase(false);
      model.setLook(look);
      model.lookTarget = null;
      this.stageModel = null;
    } else {
      model = new CharacterModel(this.world.scene, this.lib, look, 'me');
      model.groundAt = (x, z) => this.world.groundAt(x, z);
    }
    model.setShadowCaster((mm) => this.world.atmosphere.addShadowCaster(mm, false));
    const player = new LocalPlayer(model, {
      groundAt: (x, z) => this.world.groundAt(x, z),
      colliders: (x, z, out) => this.world.foliage.nearby(x, z, out),
      send: (msg) => this.net.send(msg),
    });
    player.spawn(c.pos[0], c.pos[1], c.pos[2], c.yaw);
    player.onJump = () => model!.animator.play('Jump_Start', { upper: false, speed: 1.6, fadeIn: 0.04, fadeOut: 0.12 });
    player.onLand = (v) => {
      if (v > 9) this.follow.shake(Math.min(0.5, (v - 9) * 0.06));
      model!.animator.play('Jump_Land', { upper: false, speed: 1.5, fadeIn: 0.04, fadeOut: 0.15 });
    };
    this.player = player;
    this.follow.yaw = c.yaw;
    this.follow.pitch = 0.28;
    this.follow.snap(this.focusPoint());
    this.camFrom.pos.copyFrom(this.world.camera.position);
    this.camFrom.target.copyFrom(this.world.camera.getTarget());
    this.camBlend = 0;
    this.world.postfx.setDepthOfField(false, this.world.quality);

    const maxHp = statsFor(c.cls, c.level, c.equipment).maxHp;
    this.hud = new Hud(
      {
        onChat: (text) => this.net.send({ t: 'chat', text }),
        openSettings: () => this.openSettings(),
        openPatchNotes: () => this.openNotes(),
        openHelp: () => openHelp(),
        openInventory: () => this.toggleInventory(),
        openMap: () => this.toggleMap(),
      },
      this.world.data.heightmap,
      this.world.data.splat,
    );
    this.hud.setCharacter(c, maxHp);
    this.hud.setXp(c.xp / xpToNext(c.level), c.level);
    this.hud.plate(this.myId, c.name, c.level);
    try {
      if (localStorage.getItem(NOTES_SEEN_KEY) === LATEST_NOTE) this.hud.notesDot.remove();
    } catch {
      /* ignore */
    }
    for (const p of m.players) this.addRemote(p);
    const hud = this.hud;
    this.combat = new CombatController({
      world: this.world,
      fx: this.fx,
      hud,
      net: this.net,
      input: this.input,
      follow: this.follow,
      player,
      character: c,
      myId: this.myId,
      remotes: this.remotes,
      monsters: this.monsters,
      canAct: () => !hud.chatOpen && !isWindowOpen(),
    });
    this.combat.onInventory = () => {
      if (this.character && isInventoryOpen()) renderInventory(this.character, this.invActions);
    };
    this.bindNet();
    this.hud.addChat('', `Welcome to Kelia, ${c.name}. Press Enter to chat.`, true);
    this.mode = 'playing';
    const startPoi = this.zoneAt(player.pos.x, player.pos.z);
    if (startPoi) setTimeout(() => this.hud?.zoneToast(startPoi, false), 1200);
    this.currentZone = startPoi;
  }

  private bindNet() {
    const net = this.net;
    net.on('s', (m) => {
      for (const e of m.e) {
        if (e[0] === this.myId) continue;
        this.remotes.get(e[0])?.push(m.ts, e);
      }
      for (const row of m.m ?? []) {
        let me = this.monsters.get(row[0]);
        if (!me) {
          me = new MonsterEntity(row[0], row[1]);
          const model = new MonsterModel(this.world.scene, this.monsterLib, me.def, 'm' + (row[0] - MONSTER_ID_BASE));
          model.setShadowCaster((mm) => this.world.atmosphere.addShadowCaster(mm, false));
          me.model = model;
          this.monsters.set(row[0], me);
          if (!me.def.boss) this.hud?.plate(row[0], me.def.name, me.def.level, 'enemy');
        }
        me.lastSeen = performance.now();
        me.push(m.ts, row);
      }
    });
    net.on('act', (m) => this.combat?.onRemoteAct(m));
    net.on('mact', (m) => this.combat?.onMonsterAct(m));
    net.on('hit', (m) => this.combat?.onHits(m.h));
    net.on('kill', (m) => this.combat?.onKill(m.id));
    net.on('me', (m) => this.combat?.onSelf(m.s));
    net.on('lvl', (m) => this.combat?.onLevel(m));
    net.on('died', (m) => this.combat?.onDied(m.by));
    net.on('respawned', (m) => this.combat?.onRespawned(m));
    net.on('loot', (m) => this.combat?.onLoot(m.id, m.qty));
    net.on('look', (m) => this.combat?.onLook(m));
    net.on('join', (m) => this.addRemote(m.p));
    net.on('leave', (m) => {
      const r = this.remotes.get(m.id);
      if (r) {
        r.dispose();
        this.remotes.delete(m.id);
        this.hud?.removePlate(m.id);
      }
    });
    net.on('chat', (m) => {
      this.hud?.addChat(m.name, m.text, m.sys);
      if (!m.sys && m.id) this.hud?.say(m.id, m.text);
      if (m.sys && m.text.startsWith('Discovered: ')) {
        const name = m.text.slice(12);
        const poi = POINTS_OF_INTEREST.find((p) => p.name === name);
        if (poi) {
          this.character?.discovered.push(poi.id);
          this.hud?.zoneToast(poi, true);
        }
      }
    });
    net.on('emote', (m) => {
      if (m.id === this.myId && this.player) this.emoteLocal(m.e);
      else this.remotes.get(m.id)?.emote(m.e);
    });
    net.on('correct', (m) => this.player?.correct(m.x, m.y, m.z));
    net.on('pings', (m) => {
      this.pings.clear();
      for (const [id, ms] of m.p) this.pings.set(id, ms);
    });
  }

  private emoteLocal(e: string) {
    const an = this.player!.model.animator;
    if (e === 'wave') an.play('Interact', { upper: true });
    else if (e === 'cheer') an.play('Cheer', { upper: false });
    else if (e === 'dance') an.play('Cheer', { upper: false, speed: 1.6, loop: true });
    else if (e === 'sit') an.play('Sit_Floor_Down', { upper: false, onEnd: () => an.play('Sit_Floor_Idle', { loop: true, upper: false }) });
  }

  private addRemote(p: PublicCharacter) {
    if (this.remotes.has(p.id) || p.id === this.myId) return;
    const model = new CharacterModel(this.world.scene, this.lib, { appearance: p.appearance, cls: p.cls, weapon: p.weapon, offhand: p.offhand }, 'p' + p.id);
    model.groundAt = (x, z) => this.world.groundAt(x, z);
    model.setShadowCaster((m) => this.world.atmosphere.addShadowCaster(m, false));
    const r = new RemotePlayer(p, model);
    this.remotes.set(p.id, r);
    this.hud?.plate(p.id, p.name, p.level);
  }

  private invActions: InventoryActions = {
    equip: (i) => this.net.send({ t: 'equip', i }),
    unequip: (slot) => this.net.send({ t: 'unequip', slot }),
    discard: (i) => this.net.send({ t: 'discard', i }),
  };

  private toggleInventory() {
    if (!this.character) return;
    if (isInventoryOpen()) {
      closeWindow();
      return;
    }
    this.input.releaseLock();
    openInventory(this.character, this.invActions);
  }

  private toggleMap() {
    const s = this.mapState();
    if (!s || !this.hud) return;
    this.input.releaseLock();
    this.hud.toggleWorldMap(s);
  }

  /** What the big map shows: you, the heroes around you and the monsters you can sense. */
  private mapState(): WorldMapState | null {
    const player = this.player;
    if (!player) return null;
    const enemies: { x: number; z: number; boss: boolean }[] = [];
    for (const mo of this.monsters.values()) if (mo.alive) enemies.push({ x: mo.pos.x, z: mo.pos.z, boss: !!mo.def.boss });
    const zone = this.zoneAt(player.pos.x, player.pos.z);
    const discovered = this.character?.discovered ?? [];
    return {
      px: player.pos.x,
      pz: player.pos.z,
      yaw: player.yaw,
      camYaw: this.follow.yaw,
      others: [...this.remotes.values()].map((r) => ({ x: r.pos.x, z: r.pos.z, yaw: r.yaw, name: r.info.name })),
      enemies,
      discovered,
      zone: zone && (!zone.hidden || discovered.includes(zone.id)) ? zone.name : 'Kelia',
    };
  }

  private focusPoint() {
    const p = this.player!.pos;
    return new Vector3(p.x, p.y + 1.55, p.z);
  }

  private zoneAt(x: number, z: number): PointOfInterest | null {
    let best: PointOfInterest | null = null;
    let bd = Infinity;
    for (const poi of POINTS_OF_INTEREST) {
      const r = poi.kind === 'forest' ? 130 : poi.kind === 'lake' ? 100 : poi.kind === 'hills' ? 200 : poi.kind === 'village' ? 60 : poi.hidden ? 14 : 34;
      const d = Math.hypot(x - poi.pos[0], z - poi.pos[1]);
      if (d < r && d / r < bd) {
        bd = d / r;
        best = poi;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ settings
  private openSettings() {
    this.input.releaseLock();
    openSettings({
      settings: this.settings,
      renderSize: () => this.world.renderSize(),
      onChange: (s, reload) => {
        const qualityChanged = s.quality !== this.settings.quality;
        const scaleChanged = s.renderScale !== this.settings.renderScale;
        this.settings = s;
        saveSettings(s);
        this.applyCameraSettings();
        if (qualityChanged) {
          const level = s.quality === 'auto' ? autoQuality(this.gpu) : s.quality;
          this.world.applyQuality(PRESETS[level]);
        }
        if (scaleChanged) this.world.setRenderScale(s.renderScale);
        mixer.setVolumes(s);
        if (reload) setTimeout(() => location.reload(), 300);
      },
      onLogout: async () => {
        await signOut().catch(() => {});
        location.reload();
      },
    });
  }

  private openNotes() {
    this.input.releaseLock();
    openPatchNotes();
    this.hud?.notesDot.remove();
    try {
      localStorage.setItem(NOTES_SEEN_KEY, LATEST_NOTE);
    } catch {
      /* ignore */
    }
  }

  private applyCameraSettings() {
    this.follow.settings = { sensitivity: this.settings.mouseSensitivity, invertY: this.settings.invertY, fov: this.settings.fov, shake: this.settings.cameraShake };
  }

  // ------------------------------------------------------------------ frame
  private update(dt: number) {
    this.t += dt;
    const atm = this.world.atmosphere;
    const serverDay = dayTimeAt(this.net.connected ? this.net.serverNow() : Date.now());
    if (this.mode === 'playing' || this.mode === 'entering') {
      // ease from the staged time of day to the real one
      if (this.dayOverride !== null) {
        let d = serverDay - this.dayOverride;
        if (d > 0.5) d -= 1;
        if (d < -0.5) d += 1;
        this.dayOverride = (this.dayOverride + d * Math.min(1, dt * 0.8) + 1) % 1;
        if (Math.abs(d) < 0.002) this.dayOverride = null;
      }
      atm.dayTime = this.dayOverride ?? serverDay;
    } else atm.dayTime = this.dayOverride ?? serverDay;

    const input = this.input;
    if (this.mode === 'title') this.updateTitleCamera();
    else if (this.mode === 'creator') this.updateCreatorCamera(dt);
    else if (this.mode === 'entering') this.stageModel?.update(dt, Vector3.Zero(), 0, false);
    else if (this.mode === 'playing') this.updatePlaying(dt);
    input.endFrame();
  }

  private updateTitleCamera() {
    const t = this.t * 0.018;
    const cx = 10;
    const cz = -70;
    const r = 150;
    const pos = new Vector3(cx + Math.sin(t) * r, 0, cz + Math.cos(t) * r);
    pos.y = Math.max(this.world.groundAt(pos.x, pos.z) + 16, 34);
    const look = new Vector3(cx + Math.sin(t + 0.9) * 40, 10, cz + Math.cos(t + 0.9) * 40);
    const cam = this.world.camera;
    cam.position.copyFrom(pos);
    cam.setTarget(look);
    cam.fov = (55 * Math.PI) / 180;
  }

  private updatePlaying(dt: number) {
    const input = this.input;
    const hud = this.hud!;
    const player = this.player!;
    // UI keys
    if (input.pressedKey('Enter') && !hud.chatOpen) {
      input.releaseLock();
      hud.openChat();
    }
    if (input.pressedKey('Escape') && isWindowOpen()) closeWindow();
    if (input.pressedKey('KeyI') || input.pressedKey('KeyB')) this.toggleInventory();
    if (input.pressedKey('KeyM')) this.toggleMap();
    if (input.pressedKey('KeyV')) this.follow.toggleFrontView();
    if (input.pressedKey('KeyN')) {
      this.settings = { ...this.settings, showNames: !this.settings.showNames };
      saveSettings(this.settings);
    }
    input.typing = hud.chatOpen;
    this.updateRoster(dt, input.key('Tab') && !isWindowOpen());
    if (input.mouseDX || input.mouseDY) this.follow.look(input.mouseDX, input.mouseDY);
    if (input.wheel) this.follow.zoom(input.wheel);

    this.follow.aimYaw = input.cursorAiming ? this.cursorYaw(player.pos, this.follow.aimYaw) : null;

    perf.begin('combat');
    this.combat?.update(dt);
    perf.end('combat');
    perf.begin('player');
    player.update(dt, input, this.follow);
    // In front view the hero looks into the lens instead of where the camera points.
    player.model.lookTarget = this.combat?.dead ? null : this.follow.frontAmount > 0.5 ? this.world.camera.position : this.camLookPoint();
    perf.end('player');

    const now = this.net.serverNow();
    perf.begin('remotes');
    for (const r of this.remotes.values()) r.update(dt, now);
    perf.end('remotes');
    perf.begin('monsters');
    const pnow = performance.now();
    let boss: MonsterEntity | null = null;
    for (const [id, mo] of this.monsters) {
      if (pnow - mo.lastSeen > 2500) {
        mo.dispose();
        this.monsters.delete(id);
        this.hud?.removePlate(id);
        continue;
      }
      mo.update(dt, now);
      if (mo.def.boss && mo.alive && Vector3.Distance(mo.pos, player.pos) < 38) boss = mo;
    }
    perf.end('monsters');
    hud.setBoss(boss ? boss.def.name : null, boss?.hpFrac ?? 1);
    perf.begin('fx');
    this.fx.update(dt);
    perf.end('fx');

    // camera (blend in from the previous shot when entering)
    perf.begin('camera');
    this.follow.update(dt, this.focusPoint(), player.vel, player.sprinting);
    if (this.camBlend < 1) {
      this.camBlend = Math.min(1, this.camBlend + dt / 2.2);
      const e = this.camBlend * this.camBlend * (3 - 2 * this.camBlend);
      const cam = this.world.camera;
      const toPos = cam.position.clone();
      const toT = cam.getTarget();
      cam.position = Vector3.Lerp(this.camFrom.pos, toPos, e);
      cam.setTarget(Vector3.Lerp(this.camFrom.target, toT, e));
    }
    perf.end('camera');

    // HUD
    perf.begin('ui');
    const plates = [{ id: this.myId, pos: player.pos.add(new Vector3(0, 2.25, 0)), hp: 1, visible: true }];
    for (const [id, r] of this.remotes) plates.push({ id, pos: r.pos.add(new Vector3(0, 2.25, 0)), hp: r.hpFrac, visible: true });
    for (const [id, mo] of this.monsters) {
      if (mo.def.boss) continue;
      const show = mo.alive && mo.state !== 6 && (mo.hpFrac < 0.999 || pnow - mo.lastHurt < 5000);
      plates.push({ id, pos: mo.pos.add(new Vector3(0, 2.1 * mo.def.scale + 0.15, 0)), hp: mo.hpFrac, visible: show });
    }
    hud.updatePlates(this.world.engine, this.world.camera, plates, this.settings.showNames);
    if (hud.worldMap.isOpen) {
      const ms = this.mapState();
      if (ms) hud.worldMap.update(ms);
    }
    this.mapTimer -= dt;
    if (this.mapTimer <= 0) {
      this.mapTimer = 0.08;
      const enemies: { x: number; z: number; boss: boolean }[] = [];
      for (const mo of this.monsters.values()) if (mo.alive) enemies.push({ x: mo.pos.x, z: mo.pos.z, boss: !!mo.def.boss });
      hud.updateMinimap(player.pos.x, player.pos.z, player.yaw, this.follow.yaw, [...this.remotes.values()].map((r) => ({ x: r.pos.x, z: r.pos.z })), this.character?.discovered ?? [], enemies);
      const zone = this.zoneAt(player.pos.x, player.pos.z);
      hud.setZone(zone && (!zone.hidden || this.character?.discovered.includes(zone.id)) ? zone.name : 'Kelia');
      hud.setClock(this.world.atmosphere.dayTime);
      if (zone && zone !== this.currentZone && !zone.hidden && this.character?.discovered.includes(zone.id)) hud.zoneToast(zone, false);
      this.currentZone = zone;
    }
    perf.end('ui');
  }

  /** Hold Tab: who is online, where they are and their ping. */
  private updateRoster(dt: number, held: boolean) {
    const roster = this.hud!.roster;
    roster.show(held);
    if (!held) {
      this.rosterTimer = 0;
      return;
    }
    this.rosterTimer -= dt;
    if (this.rosterTimer > 0) return;
    this.rosterTimer = 0.25;
    const c = this.character!;
    const me = this.player!.pos;
    const entries: RosterEntry[] = [
      { id: this.myId, name: c.name, cls: c.cls, level: c.level, hp: this.combat ? c.hp / this.combat.maxHp : 1, dead: !!this.combat?.dead, x: me.x, z: me.z, ping: Math.round(this.net.rtt) || null, you: true },
    ];
    for (const [id, r] of this.remotes) {
      entries.push({ id, name: r.info.name, cls: r.info.cls, level: r.info.level, hp: r.hpFrac, dead: r.dead, x: r.pos.x, z: r.pos.z, ping: this.pings.get(id) ?? null, you: false });
    }
    roster.update(entries, { x: me.x, z: me.z }, this.follow.yaw, this.hud!.clockText);
  }

  /** Where the character's head should look: ahead along the camera ray. */
  /** Yaw from the player to where the free cursor points on the ground. */
  private cursorYaw(from: Vector3, prev: number | null): number | null {
    const cam = this.world.camera;
    const canvas = this.input.canvas;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return prev;
    const inv = cam.getViewMatrix().multiply(cam.getProjectionMatrix()).invert();
    const nx = (this.input.cursorX / w) * 2 - 1;
    const ny = 1 - (this.input.cursorY / h) * 2;
    const origin = cam.globalPosition;
    const dir = Vector3.TransformCoordinates(new Vector3(nx, ny, 0.5), inv).subtractInPlace(origin);
    // depth conventions differ between WebGL and WebGPU: make sure it points away from the eye
    if (Vector3.Dot(dir, cam.getDirection(Vector3.Forward())) < 0) dir.scaleInPlace(-1);
    let dx: number;
    let dz: number;
    if (dir.y < -1e-3) {
      const t = (from.y - origin.y) / dir.y;
      dx = origin.x + dir.x * t - from.x;
      dz = origin.z + dir.z * t - from.z;
    } else {
      // above the horizon: aim along the ray
      dx = dir.x;
      dz = dir.z;
      if (Math.hypot(dx, dz) < 1e-4) return prev;
      return Math.atan2(dx, dz);
    }
    if (Math.hypot(dx, dz) < 0.6) return prev;
    return Math.atan2(dx, dz);
  }

  private camLookPoint() {
    const cam = this.world.camera;
    const dir = cam.getTarget().subtract(cam.position).normalize();
    return cam.position.add(dir.scale(30));
  }
}
