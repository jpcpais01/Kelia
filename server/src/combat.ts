// Authoritative combat: player skills and dodges, monster AI, projectiles,
// damage, status effects, death, XP, levels and loot. Runs inside the world's
// 20 Hz tick.
import {
  CLASSES,
  CRIT_MULTIPLIER,
  HIT_CRIT,
  HIT_DODGED,
  HIT_DOT,
  HIT_HEAL,
  HIT_PLAYER,
  ITEMS,
  MAX_LEVEL,
  MONSTERS,
  MONSTER_IDS,
  MONSTER_ID_BASE,
  MonsterState,
  POTION_COOLDOWN,
  SPAWN_POINT,
  SPAWN_ZONES,
  VILLAGE,
  clampAim,
  inCone,
  q,
  segmentDistance,
  skillFor,
  skillUnlocked,
  statsFor,
  xpToNext,
  type ActKind,
  type Hit,
  type MonsterAttack,
  type MonsterDef,
  type SkillDef,
  type SnapMonster,
  type SpawnZone,
  type Stats,
} from '@kelia/shared';

/** What combat needs from a player (implemented by world.Player). */
export interface Fighter {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  stats: Stats;
  character: { name: string; cls: keyof typeof CLASSES; level: number; xp: number; hp: number; inventory: { id: string; qty: number }[]; equipment: { weapon: string | null; offhand: string | null; outfit: string | null } };
  combat: PlayerCombat;
  send(msg: object): void;
}

export class PlayerCombat {
  busyUntil = 0;
  cooldowns = new Map<string, number>();
  invulnUntil = 0;
  dashUntil = 0;
  dashDistance = 0;
  guardUntil = 0;
  dead = false;
  deadAt = 0;
  lastHurtAt = 0;
  potionAt = 0;
  dirty = false;
  gain = 0;
  invDirty = false;
  regenAcc = 0;
}

interface Pending {
  at: number;
  run: () => void;
}

interface Projectile {
  x: number;
  z: number;
  y: number;
  dx: number;
  dz: number;
  speed: number;
  left: number;
  radius: number;
  pierce: boolean;
  hitIds: Set<number>;
  onHit: (targetId: number) => boolean; // return true to stop
  targets: 'monsters' | 'players';
}

export class Monster {
  readonly def: MonsterDef;
  readonly kind: number;
  x: number;
  y = 0;
  z: number;
  yaw = Math.random() * Math.PI * 2;
  hp: number;
  state = MonsterState.Rising;
  stateUntil = 0;
  target: number | null = null;
  homeX: number;
  homeZ: number;
  wanderX: number;
  wanderZ: number;
  wanderAt = 0;
  returning = false;
  attack: { a: MonsterAttack; idx: number; until: number; lungeV: [number, number] | null; lungeUntil: number } | null = null;
  cooldowns: number[];
  stunUntil = 0;
  rootUntil = 0;
  slowUntil = 0;
  slowValue = 0;
  burnUntil = 0;
  burnDps = 0;
  burnSource = 0;
  burnAcc = 0;
  respawnAt = 0;
  damageBy = new Map<number, number>();
  aggroCheckAt = 0;
  lastHurtAt = 0;

  constructor(readonly id: number, readonly zone: SpawnZone, x: number, z: number) {
    this.def = MONSTERS[zone.monster];
    this.kind = MONSTER_IDS.indexOf(zone.monster);
    this.x = this.homeX = this.wanderX = x;
    this.z = this.homeZ = this.wanderZ = z;
    this.hp = this.def.hp;
    this.cooldowns = this.def.attacks.map(() => 0);
  }

  get alive() {
    return this.state !== MonsterState.Dead;
  }
}

export interface CombatHost {
  players: Map<number, Fighter>;
  groundAt(x: number, z: number): number;
  walkable(x: number, z: number): boolean;
  broadcast(msg: object): void;
  /** Players near a point (for interest-limited messages). */
  now(): number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class Combat {
  readonly monsters: Monster[] = [];
  private pending: Pending[] = [];
  private projectiles: Projectile[] = [];
  private hits: Hit[] = [];

  constructor(private host: CombatHost) {
    let n = 0;
    for (const zone of SPAWN_ZONES) {
      for (let i = 0; i < zone.count; i++) {
        const [x, z] = this.spawnPoint(zone);
        const m = new Monster(MONSTER_ID_BASE + ++n, zone, x, z);
        m.y = host.groundAt(x, z);
        m.state = MonsterState.Idle;
        this.monsters.push(m);
      }
    }
  }

  private spawnPoint(zone: SpawnZone): [number, number] {
    for (let tries = 0; tries < 30; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * zone.radius;
      const x = zone.center[0] + Math.cos(a) * r;
      const z = zone.center[1] + Math.sin(a) * r;
      if (this.host.walkable(x, z) && Math.hypot(x - VILLAGE.center[0], z - VILLAGE.center[1]) > VILLAGE.radius + 10) return [x, z];
    }
    return [zone.center[0], zone.center[1]];
  }

  monster(id: number) {
    return this.monsters[id - MONSTER_ID_BASE - 1];
  }

  // ------------------------------------------------------------------ player actions
  /** Returns false when the action was rejected. */
  act(p: Fighter, k: ActKind, i: number, yaw: number, tx: number, tz: number): boolean {
    const now = this.host.now();
    const pc = p.combat;
    if (pc.dead) return false;
    const skill = skillFor(p.character.cls, k, i | 0);
    if (!skill || !skillUnlocked(k, i, p.character.level)) return false;
    if (![yaw, tx, tz].every(Number.isFinite)) return false;
    // allow a little network jitter on lockouts and cooldowns
    if (now < pc.busyUntil - 150) return false;
    if ((pc.cooldowns.get(skill.id) ?? 0) > now + 150) return false;
    pc.busyUntil = now + skill.lockout * 1000;
    if (skill.cooldown > 0) pc.cooldowns.set(skill.id, now + skill.cooldown * (1 - p.stats.cdr) * 1000);
    p.yaw = yaw;
    this.host.broadcast({ t: 'act', id: p.id, k, i, yaw: Math.round(yaw * 1000) / 1000, tx: q(tx), tz: q(tz) });
    if (k === 'd') {
      const d = skill.shape.kind === 'dash' ? skill.shape.distance : 5;
      pc.invulnUntil = now + (skill.lockout + 0.15) * 1000;
      pc.dashUntil = now + 1200;
      pc.dashDistance = d + 1;
      return true;
    }
    this.later(skill.impactAt, () => this.resolveSkill(p, skill, yaw, tx, tz));
    return true;
  }

  private resolveSkill(p: Fighter, skill: SkillDef, yaw: number, tx: number, tz: number) {
    if (p.combat.dead || !this.host.players.has(p.id)) return;
    const sh = skill.shape;
    const hitMonster = (m: Monster) => this.damageMonster(m, p, skill);
    switch (sh.kind) {
      case 'melee':
        for (const m of this.monsters) if (m.alive && m.state !== MonsterState.Rising && inCone(p.x, p.z, yaw, m.x, m.z, sh.range, sh.arc, m.def.radius)) hitMonster(m);
        break;
      case 'aoe-self':
        if (skill.effect === 'heal') {
          for (const o of this.host.players.values()) {
            if (o.combat.dead || Math.hypot(o.x - p.x, o.z - p.z) > sh.radius) continue;
            this.heal(o, o.stats.maxHp * (skill.effectValue ?? 0.25), p.id);
            if (skill.id === 'rally') o.combat.guardUntil = this.host.now() + (skill.effectDuration ?? 6) * 1000;
          }
        } else {
          for (const m of this.monsters) if (m.alive && m.state !== MonsterState.Rising && Math.hypot(m.x - p.x, m.z - p.z) <= sh.radius + m.def.radius) hitMonster(m);
        }
        break;
      case 'aoe-target': {
        const [ax, az] = clampAim(p.x, p.z, tx, tz, sh.range);
        for (const m of this.monsters) if (m.alive && m.state !== MonsterState.Rising && Math.hypot(m.x - ax, m.z - az) <= sh.radius + m.def.radius) hitMonster(m);
        break;
      }
      case 'projectile': {
        const dx = Math.sin(yaw);
        const dz = Math.cos(yaw);
        this.projectiles.push({
          x: p.x + dx * 0.5,
          z: p.z + dz * 0.5,
          y: p.y + 1.3,
          dx,
          dz,
          speed: sh.speed,
          left: sh.range,
          radius: sh.radius,
          pierce: !!sh.pierce,
          hitIds: new Set(),
          targets: 'monsters',
          onHit: (id) => {
            const m = this.monster(id);
            if (m) hitMonster(m);
            return !sh.pierce;
          },
        });
        break;
      }
      default:
        break;
    }
  }

  private damageMonster(m: Monster, p: Fighter, skill: SkillDef) {
    const crit = Math.random() < p.stats.crit;
    let dmg = p.stats.power * skill.power * rand(0.9, 1.1);
    if (crit) dmg *= CRIT_MULTIPLIER;
    dmg = Math.max(1, Math.round(dmg));
    const now = this.host.now();
    switch (skill.effect) {
      case 'stun':
        m.stunUntil = Math.max(m.stunUntil, now + (skill.effectDuration ?? 1) * (m.def.boss ? 0.35 : 1) * 1000);
        break;
      case 'root':
        m.rootUntil = now + (skill.effectDuration ?? 2) * (m.def.boss ? 0.4 : 1) * 1000;
        break;
      case 'slow':
        m.slowUntil = now + (skill.effectDuration ?? 3) * 1000;
        m.slowValue = skill.effectValue ?? 0.4;
        break;
      case 'burn':
        m.burnUntil = now + (skill.effectDuration ?? 4) * 1000;
        m.burnDps = dmg * (skill.effectValue ?? 0.15);
        m.burnSource = p.id;
        break;
    }
    this.applyMonsterDamage(m, dmg, p, crit ? HIT_CRIT : 0);
  }

  private applyMonsterDamage(m: Monster, dmg: number, p: Fighter | undefined, flags: number) {
    if (!m.alive) return;
    m.hp = Math.max(0, m.hp - dmg);
    m.lastHurtAt = this.host.now();
    this.hits.push([m.id, dmg, flags, p?.id ?? 0]);
    if (p) {
      m.damageBy.set(p.id, (m.damageBy.get(p.id) ?? 0) + dmg);
      if (m.target === null && !m.returning) m.target = p.id;
    }
    if (m.hp <= 0) this.killMonster(m);
  }

  private killMonster(m: Monster) {
    const now = this.host.now();
    m.state = MonsterState.Dead;
    m.attack = null;
    m.target = null;
    m.respawnAt = now + m.def.respawn * 1000;
    m.burnUntil = 0;
    // Everyone who helped (and is still nearby) gets the full reward.
    let top: Fighter | null = null;
    let topDmg = 0;
    for (const [pid, dmg] of m.damageBy) {
      const p = this.host.players.get(pid);
      if (!p) continue;
      if (dmg > topDmg) {
        topDmg = dmg;
        top = p;
      }
      if (Math.hypot(p.x - m.x, p.z - m.z) < 80) this.giveXp(p, m.def.xp);
    }
    m.damageBy.clear();
    this.host.broadcast({ t: 'kill', id: m.id, xp: m.def.xp });
    if (top) {
      for (const l of m.def.loot) {
        if (Math.random() > l.chance) continue;
        const qty = l.qty ? Math.round(rand(l.qty[0], l.qty[1])) : 1;
        this.addItem(top, l.id, qty);
        top.send({ t: 'loot', id: l.id, qty });
      }
      if (m.def.boss) this.host.broadcast({ t: 'chat', id: 0, name: '', text: `${top.character.name} has defeated ${m.def.name}!`, sys: true });
    }
  }

  giveXp(p: Fighter, amount: number) {
    const c = p.character;
    if (c.level >= MAX_LEVEL) return;
    c.xp += amount;
    p.combat.gain += amount;
    p.combat.dirty = true;
    let leveled = false;
    while (c.level < MAX_LEVEL && c.xp >= xpToNext(c.level)) {
      c.xp -= xpToNext(c.level);
      c.level++;
      leveled = true;
    }
    if (c.level >= MAX_LEVEL) c.xp = 0;
    if (leveled) {
      p.stats = statsFor(c.cls, c.level, c.equipment);
      c.hp = p.stats.maxHp;
      this.host.broadcast({ t: 'lvl', id: p.id, level: c.level, maxHp: p.stats.maxHp });
      this.host.broadcast({ t: 'chat', id: 0, name: '', text: `${c.name} reached level ${c.level}!`, sys: true });
    }
  }

  addItem(p: Fighter, id: string, qty: number) {
    const def = ITEMS[id];
    if (!def) return;
    const inv = p.character.inventory;
    const stack = def.stack ?? 1;
    let left = qty;
    for (const s of inv) {
      if (left <= 0) break;
      if (s.id !== id || s.qty >= stack) continue;
      const add = Math.min(left, stack - s.qty);
      s.qty += add;
      left -= add;
    }
    while (left > 0 && inv.length < 24) {
      const add = Math.min(left, stack);
      inv.push({ id, qty: add });
      left -= add;
    }
    p.combat.invDirty = true;
    p.combat.dirty = true;
  }

  usePotion(p: Fighter, id: string) {
    const now = this.host.now();
    const def = ITEMS[id];
    if (!def?.heal || p.combat.dead || now < p.combat.potionAt) return;
    const inv = p.character.inventory;
    const slot = inv.find((s) => s.id === id && s.qty > 0);
    if (!slot) return;
    slot.qty--;
    if (slot.qty <= 0) inv.splice(inv.indexOf(slot), 1);
    p.combat.potionAt = now + POTION_COOLDOWN * 1000;
    p.combat.invDirty = true;
    this.heal(p, p.stats.maxHp * def.heal, p.id);
  }

  private heal(p: Fighter, amount: number, src: number) {
    const before = p.character.hp;
    p.character.hp = Math.min(p.stats.maxHp, p.character.hp + amount);
    const done = Math.round(p.character.hp - before);
    if (done > 0) this.hits.push([p.id, done, HIT_HEAL | HIT_PLAYER, src]);
    p.combat.dirty = true;
  }

  private damagePlayer(p: Fighter, raw: number, m: Monster) {
    const now = this.host.now();
    const pc = p.combat;
    if (pc.dead) return;
    if (now < pc.invulnUntil) {
      this.hits.push([p.id, 0, HIT_PLAYER | HIT_DODGED, m.id]);
      return;
    }
    let dmg = raw * rand(0.9, 1.1);
    if (now < pc.guardUntil) dmg *= 0.7;
    dmg = Math.max(1, Math.round(dmg));
    p.character.hp = Math.max(0, p.character.hp - dmg);
    pc.lastHurtAt = now;
    pc.dirty = true;
    this.hits.push([p.id, dmg, HIT_PLAYER, m.id]);
    if (p.character.hp <= 0) {
      pc.dead = true;
      pc.deadAt = now;
      p.send({ t: 'died', by: m.def.name });
      for (const o of this.monsters) if (o.target === p.id) o.target = null;
    }
  }

  respawn(p: Fighter) {
    const pc = p.combat;
    if (!pc.dead || this.host.now() - pc.deadAt < 2500) return false;
    pc.dead = false;
    pc.busyUntil = 0;
    pc.invulnUntil = this.host.now() + 3000;
    p.character.hp = p.stats.maxHp;
    p.x = SPAWN_POINT[0];
    p.z = SPAWN_POINT[1];
    p.y = this.host.groundAt(p.x, p.z);
    pc.dirty = true;
    p.send({ t: 'respawned', x: q(p.x), y: q(p.y), z: q(p.z), yaw: Math.PI });
    return true;
  }

  playerLeft(id: number) {
    for (const m of this.monsters) {
      if (m.target === id) m.target = null;
      m.damageBy.delete(id);
    }
  }

  // ------------------------------------------------------------------ simulation
  private later(seconds: number, run: () => void) {
    this.pending.push({ at: this.host.now() + seconds * 1000, run });
  }

  tick(dt: number) {
    const now = this.host.now();
    // scheduled impacts
    if (this.pending.length) {
      const due = this.pending.filter((e) => e.at <= now);
      this.pending = this.pending.filter((e) => e.at > now);
      for (const e of due) e.run();
    }
    this.stepProjectiles(dt);
    const active = this.host.players.size > 0;
    for (const m of this.monsters) this.stepMonster(m, dt, now, active);
    this.stepPlayers(dt, now);
    if (this.hits.length) {
      this.host.broadcast({ t: 'hit', h: this.hits });
      this.hits = [];
    }
  }

  private stepPlayers(dt: number, now: number) {
    for (const p of this.host.players.values()) {
      const pc = p.combat;
      const c = p.character;
      if (!pc.dead && c.hp < p.stats.maxHp) {
        const outOfCombat = now - pc.lastHurtAt > 6000;
        const rate = p.stats.regen + (outOfCombat ? 0.03 : 0);
        if (rate > 0) {
          pc.regenAcc += p.stats.maxHp * rate * dt;
          if (pc.regenAcc >= 1) {
            const n = Math.floor(pc.regenAcc);
            pc.regenAcc -= n;
            c.hp = Math.min(p.stats.maxHp, c.hp + n);
            pc.dirty = true;
          }
        }
      }
      if (pc.dirty) {
        pc.dirty = false;
        p.send({
          t: 'me',
          s: {
            hp: Math.ceil(c.hp),
            maxHp: p.stats.maxHp,
            level: c.level,
            xp: c.xp,
            ...(pc.invDirty ? { inventory: c.inventory } : {}),
            ...(pc.gain ? { gain: pc.gain } : {}),
          },
        });
        pc.invDirty = false;
        pc.gain = 0;
      }
    }
  }

  private stepProjectiles(dt: number) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      const step = Math.min(pr.left, pr.speed * dt);
      const nx = pr.x + pr.dx * step;
      const nz = pr.z + pr.dz * step;
      let done = false;
      if (pr.targets === 'monsters') {
        for (const m of this.monsters) {
          if (!m.alive || m.state === MonsterState.Rising || pr.hitIds.has(m.id)) continue;
          if (segmentDistance(pr.x, pr.z, nx, nz, m.x, m.z) <= pr.radius + m.def.radius) {
            pr.hitIds.add(m.id);
            if (pr.onHit(m.id)) {
              done = true;
              break;
            }
          }
        }
      } else {
        for (const p of this.host.players.values()) {
          if (p.combat.dead || pr.hitIds.has(p.id)) continue;
          if (segmentDistance(pr.x, pr.z, nx, nz, p.x, p.z) <= pr.radius + 0.4 && Math.abs(p.y + 1 - pr.y) < 2.5) {
            pr.hitIds.add(p.id);
            if (pr.onHit(p.id)) {
              done = true;
              break;
            }
          }
        }
      }
      pr.x = nx;
      pr.z = nz;
      pr.left -= step;
      if (done || pr.left <= 0.01) this.projectiles.splice(i, 1);
    }
  }

  private stepMonster(m: Monster, dt: number, now: number, active: boolean) {
    const def = m.def;
    if (m.state === MonsterState.Dead) {
      if (now >= m.respawnAt) {
        const [x, z] = this.spawnPoint(m.zone);
        m.x = m.homeX = m.wanderX = x;
        m.z = m.homeZ = m.wanderZ = z;
        m.y = this.host.groundAt(x, z);
        m.hp = def.hp;
        m.state = MonsterState.Rising;
        m.stateUntil = now + 1800;
        m.cooldowns = def.attacks.map(() => 0);
        m.stunUntil = m.rootUntil = m.slowUntil = m.burnUntil = 0;
      }
      return;
    }
    if (m.state === MonsterState.Rising) {
      if (now >= m.stateUntil) m.state = MonsterState.Idle;
      return;
    }
    // burning
    if (now < m.burnUntil) {
      m.burnAcc += m.burnDps * dt;
      if (m.burnAcc >= 1) {
        const n = Math.floor(m.burnAcc);
        m.burnAcc -= n;
        this.applyMonsterDamage(m, n, this.host.players.get(m.burnSource), HIT_DOT);
        if (!m.alive) return;
      }
    }
    if (!active && m.target === null && !m.returning) return; // nobody online: sleep
    if (now < m.stunUntil) {
      m.state = MonsterState.Stunned;
      m.attack = null;
      return;
    }

    // ongoing attack
    if (m.attack) {
      if (m.attack.lungeV && now < m.attack.lungeUntil && now >= m.rootUntil) this.moveMonster(m, m.attack.lungeV[0] * dt, m.attack.lungeV[1] * dt);
      if (now >= m.attack.until) m.attack = null;
      else {
        m.state = MonsterState.Attack;
        return;
      }
    }

    // targeting
    let target = m.target !== null ? this.host.players.get(m.target) : undefined;
    if (target && target.combat.dead) target = undefined;
    const fromHome = Math.hypot(m.x - m.homeX, m.z - m.homeZ);
    if (target && (fromHome > def.leash || Math.hypot(target.x - m.x, target.z - m.z) > def.leash + 10)) {
      target = undefined;
      m.returning = true;
    }
    if (!target && !m.returning && now >= m.aggroCheckAt) {
      m.aggroCheckAt = now + 250;
      let best = def.aggro;
      for (const p of this.host.players.values()) {
        if (p.combat.dead || now < p.combat.invulnUntil - 2000) continue;
        const d = Math.hypot(p.x - m.x, p.z - m.z);
        if (d < best && Math.abs(p.y - m.y) < 8) {
          best = d;
          target = p;
        }
      }
    }
    m.target = target ? target.id : null;

    const slow = now < m.slowUntil ? 1 - m.slowValue : 1;
    const rooted = now < m.rootUntil;

    if (m.returning) {
      const d = this.walkTowards(m, m.homeX, m.homeZ, def.runSpeed * 1.2 * slow, dt, rooted);
      m.state = MonsterState.Run;
      if (d < 1.5) {
        m.returning = false;
        m.hp = def.hp;
        m.damageBy.clear();
        m.state = MonsterState.Idle;
      }
      return;
    }

    if (target) {
      const dx = target.x - m.x;
      const dz = target.z - m.z;
      const dist = Math.hypot(dx, dz);
      const enraged = def.boss && m.hp < def.hp * 0.4;
      // pick the first ready attack in range (special attacks are listed first)
      for (let i = 0; i < def.attacks.length; i++) {
        const a = def.attacks[i];
        if (now < m.cooldowns[i] || dist > a.range) continue;
        this.startAttack(m, i, target, now, enraged ? 0.7 : 1);
        return;
      }
      // approach (casters keep their distance)
      const want = def.keepAway ?? Math.max(1.4, Math.min(...def.attacks.map((a) => a.range)) * 0.8);
      m.yaw = turnTowards(m.yaw, Math.atan2(dx, dz), dt * 8);
      if (dist > want) {
        this.walkTowards(m, target.x, target.z, def.runSpeed * slow * (enraged ? 1.15 : 1), dt, rooted);
        m.state = rooted ? MonsterState.Idle : MonsterState.Run;
      } else if (def.keepAway && dist < def.keepAway * 0.6) {
        this.walkTowards(m, m.x - dx, m.z - dz, def.walkSpeed * 1.5 * slow, dt, rooted, false);
        m.state = MonsterState.Walk;
      } else m.state = MonsterState.Idle;
      return;
    }

    // out of the fight for a while: knit back together
    if (m.hp < def.hp && now - m.lastHurtAt > 6000) {
      m.hp = Math.min(def.hp, m.hp + def.hp * 0.08 * dt);
      if (m.hp >= def.hp) m.damageBy.clear();
    }
    // wander
    if (now >= m.wanderAt) {
      m.wanderAt = now + rand(4000, 9000);
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * Math.min(m.zone.radius, 10);
      m.wanderX = m.homeX + Math.cos(a) * r;
      m.wanderZ = m.homeZ + Math.sin(a) * r;
    }
    const d = Math.hypot(m.wanderX - m.x, m.wanderZ - m.z);
    if (d > 0.6) {
      this.walkTowards(m, m.wanderX, m.wanderZ, def.walkSpeed * slow, dt, rooted);
      m.state = MonsterState.Walk;
    } else m.state = MonsterState.Idle;
  }

  private startAttack(m: Monster, idx: number, target: Fighter, now: number, cdScale: number) {
    const a = m.def.attacks[idx];
    m.cooldowns[idx] = now + a.cooldown * cdScale * 1000;
    const dx = target.x - m.x;
    const dz = target.z - m.z;
    const dist = Math.hypot(dx, dz);
    m.yaw = Math.atan2(dx, dz);
    let tx = target.x;
    let tz = target.z;
    let lungeV: [number, number] | null = null;
    if (a.lunge && dist > 1.5) {
      const travel = Math.min(a.lunge, Math.max(0, dist - (a.kind === 'slam' ? 0.5 : 1.4)));
      const t = a.impactAt * 0.85;
      lungeV = [(dx / dist) * (travel / t), (dz / dist) * (travel / t)];
      if (a.kind !== 'slam') {
        tx = m.x + (dx / dist) * travel;
        tz = m.z + (dz / dist) * travel;
      }
    }
    if (a.kind === 'spin') {
      tx = m.x;
      tz = m.z;
    }
    m.attack = { a, idx, until: now + a.lockout * 1000, lungeV, lungeUntil: now + a.impactAt * 850 };
    m.state = MonsterState.Attack;
    this.host.broadcast({ t: 'mact', id: m.id, a: idx, tx: q(tx), tz: q(tz), yaw: Math.round(m.yaw * 1000) / 1000 });
    this.later(a.impactAt, () => this.resolveMonsterAttack(m, a, tx, tz));
  }

  private resolveMonsterAttack(m: Monster, a: MonsterAttack, tx: number, tz: number) {
    if (!m.alive || this.host.now() < m.stunUntil) return;
    const dmg = m.def.power * a.power;
    switch (a.kind) {
      case 'melee':
        for (const p of this.host.players.values()) if (inCone(m.x, m.z, m.yaw, p.x, p.z, a.range * m.def.scale ** 0.3 + 0.2, a.arc ?? 1.6, 0.4)) this.damagePlayer(p, dmg, m);
        break;
      case 'spin':
        for (const p of this.host.players.values()) if (Math.hypot(p.x - m.x, p.z - m.z) <= (a.radius ?? 4) + 0.4) this.damagePlayer(p, dmg, m);
        break;
      case 'slam':
        for (const p of this.host.players.values()) if (Math.hypot(p.x - tx, p.z - tz) <= (a.radius ?? 3) + 0.4) this.damagePlayer(p, dmg, m);
        break;
      case 'projectile': {
        const dx = tx - m.x;
        const dz = tz - m.z;
        const d = Math.hypot(dx, dz) || 1;
        this.projectiles.push({
          x: m.x,
          z: m.z,
          y: m.y + 1.4,
          dx: dx / d,
          dz: dz / d,
          speed: a.projSpeed ?? 15,
          left: a.range + 4,
          radius: a.radius ?? 0.6,
          pierce: false,
          hitIds: new Set(),
          targets: 'players',
          onHit: (id) => {
            const p = this.host.players.get(id);
            if (p) this.damagePlayer(p, dmg, m);
            return true;
          },
        });
        break;
      }
    }
  }

  /** Move towards a point; returns the remaining distance. */
  private walkTowards(m: Monster, x: number, z: number, speed: number, dt: number, rooted: boolean, face = true) {
    const dx = x - m.x;
    const dz = z - m.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) return d;
    if (face) m.yaw = turnTowards(m.yaw, Math.atan2(dx, dz), dt * 8);
    if (rooted) return d;
    const step = Math.min(d, speed * dt);
    this.moveMonster(m, (dx / d) * step, (dz / d) * step);
    return d - step;
  }

  private moveMonster(m: Monster, mx: number, mz: number) {
    let nx = m.x + mx;
    let nz = m.z + mz;
    // keep a little space between monsters
    for (const o of this.monsters) {
      if (o === m || !o.alive) continue;
      const ox = nx - o.x;
      const oz = nz - o.z;
      const r = m.def.radius + o.def.radius;
      const d2 = ox * ox + oz * oz;
      if (d2 < r * r && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        nx = o.x + (ox / d) * r;
        nz = o.z + (oz / d) * r;
      }
    }
    if (!this.host.walkable(nx, nz)) return;
    m.x = nx;
    m.z = nz;
    m.y = this.host.groundAt(nx, nz);
  }

  /** Monsters within `range` of a point, as snapshot rows. */
  snapshot(x: number, z: number, range: number): SnapMonster[] {
    const out: SnapMonster[] = [];
    for (const m of this.monsters) {
      if (Math.abs(m.x - x) > range || Math.abs(m.z - z) > range) continue;
      out.push([m.id, m.kind, q(m.x), q(m.y), q(m.z), Math.round(m.yaw * 1000) / 1000, m.state, Math.round((m.hp / m.def.hp) * 255)]);
    }
    return out;
  }
}

function turnTowards(cur: number, want: number, maxStep: number) {
  let d = want - cur;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return cur + Math.max(-maxStep, Math.min(maxStep, d));
}
