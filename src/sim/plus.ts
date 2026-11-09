// Tanks+ extension of a World: added tank behaviours, special tiles, power-ups and level rules.
//
// A World only gets one (World.plus) when the loaded level needs it: a cell code 500-599, an
// enemy type 10+ or a non-empty `rules` object. The original missions never do, so every hook
// below is unreachable in classic mode (tools/levels/classic-trace.ts checks that the
// original campaign stays bit-for-bit identical). Hooks, in step order:
//
//   World.loadStage        new Plus(...) + spawnTiles()        after the original blocks
//   Tank.spawn*            attach()                            per-tank state (Tank.ext)
//   World.physics          collide()                           after all CollideWithField
//   Shell.collideWithField deflectShell()                      front shields
//   Shell.onHitWall        shellHitTile()                      tagged tile edges
//   Tank.resolveHits       absorbHit()                         shields, hit points, i-frames
//   AiAttack.executeActions interceptFire()                    sniper charge-up
//   Tank.playFireSe        onFire()                            fans, rockets
//   World.physics          afterCalc()                         after every Calculate
//   World.onBlockBreak     onBlockBreak()                      glass / crates
//
// All randomness comes from the extension's own RPRandom (seeded from the level), never from
// the shared game RNG directly.

import { ENEMY_SLOT0, MINE, TANK } from './consts'
import type { Block } from './field'
import type { Mine } from './mine'
import { PowerUps, applyBuffs } from './powerups'
import { RPRandom } from './rng'
import type { Shell } from './shell'
import { FIRST_ADDED_TYPE, type TankBehaviours, tankMeta } from './stats'
import type { Tank } from './tank'
import { Tiles, isSpecialCode } from './tiles'
import { enemyBehaviours, sniperIntercept, spreadShot, steerShell } from './types/behaviours'
import './types/index'
import { type V3, dot, mag, normalize, v3, vcopy } from './vec'
import type { World } from './world'

export type TankExt = {
  beh: TankBehaviours
  /** hit points at spawn (Tank.lives counts them down) */
  maxHp: number
  hitBonus: number
  /** frames during which hits are ignored (after losing a hit point or a shield) */
  iframes: number
  /** one-hit shield bubble (Medic, power-up) */
  shield: number
  /** hidden from view (Ghost standing still, fog of war) */
  hidden: boolean
  /** ice: the velocity actually driven */
  slide: V3 | null
  /** standing on a teleporter it arrived through */
  tpLock: boolean
  onSwitch: boolean
  /** power-up frames left, by power-up index */
  buffs: number[]
  /** behaviour timers: [teleport, mines, medic, spawner] */
  timer: number[]
  /** teleport warning frames left (0 = none) */
  warn: number
  /** kamikaze fuse frames left (0 = not lit) */
  fuse: number
  /** sniper: locked shot direction and frames until it fires */
  charge: { dir: V3; frames: number } | null
  /** sniper laser sight, field coordinates */
  laser: { x0: number; z0: number; x1: number; z1: number } | null
  /** the Hive that released this tank */
  parent: Tank | null
}

export type PlusEventKind =
  | 'teleport'
  | 'teleportIn'
  | 'tpWarn'
  | 'bumper'
  | 'glass'
  | 'crate'
  | 'switch'
  | 'drop'
  | 'pickup'
  | 'shieldUp'
  | 'shieldPop'
  | 'heal'
  | 'hit'
  | 'deflect'
  | 'fuse'
  | 'charge'
  | 'spawn'

/** does a level need the extension? (classic maps: never) */
export function needsPlus(cells: number[][], slots: number[], rules: Record<string, unknown> | undefined) {
  if (rules && Object.keys(rules).length) return true
  if (slots.some((s) => s >= FIRST_ADDED_TYPE)) return true
  return cells.some((row) => row.some(isSpecialCode))
}

export class Plus {
  rng: RPRandom
  /** frames since the stage was loaded */
  frame = 0
  tiles: Tiles
  powerups: PowerUps
  /** fog of war: enemies farther than this from every player are hidden (0 = off) */
  fog = 0
  /** wind: added to every shell's velocity each frame (keeps its speed) */
  wind: V3 | null = null
  private minesChecked = new WeakSet<Mine>()

  constructor(
    public w: World,
    cells: number[][],
  ) {
    let h = 0x2545f491 ^ w.frame
    for (const row of cells) for (const c of row) h = Math.imul(h ^ c, 0x9e3779b1) >>> 0
    this.rng = new RPRandom(h || 1)
    const r = w.rules
    if (typeof r.fog === 'number') this.fog = r.fog
    else if (r.fog === true) this.fog = 140
    if (Array.isArray(r.wind) && r.wind.length === 2) this.wind = v3(+r.wind[0] || 0, 0, +r.wind[1] || 0)
    this.tiles = new Tiles(w, this)
    this.powerups = new PowerUps(w, this)
  }

  /** World.loadStage, after the original blocks: tile blocks, pads */
  spawnTiles() {
    this.tiles.spawnBlocks()
    this.powerups.init()
  }

  event(kind: PlusEventKind, pos?: V3, tank?: Tank, n?: number) {
    this.w.emit({ t: 'plus', kind, pos: pos ? vcopy(pos) : undefined, tank, n })
  }

  /** original type 1-9 whose shell look / sounds an enemy type uses */
  shellLook(type: number) {
    return type < FIRST_ADDED_TYPE ? type : (tankMeta(type)?.shellLook ?? 2)
  }

  /** Tank.spawnPlayer / spawnEnemy */
  attach(t: Tank): TankExt {
    const meta = t.isEnemy ? tankMeta(t.enemyType) : undefined
    const beh = meta?.behaviours ?? {}
    const hp = Math.max(1, (beh.hp ?? 1) + (beh.hpPerPlayer ?? 0) * (this.w.players - 1))
    t.lives = hp
    const x: TankExt = {
      beh,
      maxHp: hp,
      hitBonus: beh.hitBonus ?? 0,
      iframes: 0,
      shield: 0,
      hidden: false,
      slide: null,
      tpLock: false,
      onSwitch: false,
      buffs: [0, 0, 0, 0, 0, 0],
      // first teleport / medic pulse / release come sooner than the interval
      timer: [Math.round((beh.teleport?.interval ?? 0) * 0.6), 60, Math.round((beh.medic?.interval ?? 0) * 0.4), Math.round((beh.spawner?.interval ?? 0) * 0.5)],
      warn: 0,
      fuse: 0,
      charge: null,
      laser: null,
      parent: null,
    }
    return x
  }

  /** Tank.resolveHits: true when the recorded hit was absorbed (the tank keeps going) */
  absorbHit(t: Tank): boolean {
    const x = t.ext!
    if (t.mineHit.id === 0 && t.shellHit.id === 0) return false
    let absorbed = false
    if (x.iframes > 0) absorbed = true
    else if (x.shield > 0) {
      x.shield = 0
      x.iframes = 40
      this.event('shieldPop', t.pos, t)
      this.w.sound('RP_TNK_SE_BROKEN', t.pos)
      absorbed = true
    } else if (t.lives > 1) {
      t.lives--
      x.iframes = 30
      this.event('hit', t.pos, t, t.lives)
      this.w.sound('RP_TNK_SE_HIT', t.pos)
      absorbed = true
    }
    if (absorbed) {
      t.shellHit = { id: 0, dist: 1000 }
      t.mineHit = { id: 0, dist: 1000 }
    }
    return absorbed
  }

  /** Shell.collideWithField: a front shield turns the hit into a ricochet */
  deflectShell(s: Shell, t: Tank): boolean {
    const fs = t.ext!.beh.frontShield
    if (!fs || t.lives <= 0) return false
    const sp = mag(s.vel)
    if (sp === 0) return false
    const f = t.rot.z
    const toShell = normalize(v3(s.pos.x - t.pos.x, 0, s.pos.z - t.pos.z))
    // the shell is in front of the hull and flying into it
    if (dot(toShell, f) < Math.cos((fs.angle * Math.PI) / 180)) return false
    const d = dot(s.vel, toShell)
    if (d >= 0) return false
    s.vel.x -= 2 * d * toShell.x
    s.vel.z -= 2 * d * toShell.z
    const r = TANK.shellRadius + 6 + 2 + t.ext!.hitBonus
    s.pos.x = t.pos.x + toShell.x * r
    s.pos.z = t.pos.z + toShell.z * r
    this.event('deflect', s.pos, t)
    this.w.sound('RP_TNK_SE_REFLECT', s.pos)
    this.w.emit({ t: 'ricochet', bullet: s, pos: vcopy(s.pos), super: false })
    return true
  }

  /** Shell.onHitWall with a non-zero edge id */
  shellHitTile(s: Shell, id: number) {
    this.tiles.shellHitTile(s, id)
  }

  /** AiAttack.executeActions decided to fire an added type: true = the shot was taken over */
  interceptFire(t: Tank): boolean {
    if (!t.ext) return false
    return sniperIntercept(this, t)
  }

  /** Tank.playFireSe: every shot (players and enemies) */
  onFire(t: Tank, shell: Shell | null) {
    if (!shell || !t.ext) return
    if (t.isEnemy) {
      if (t.ext.beh.spread) spreadShot(this, t, shell)
    } else if (t.ext.buffs[5] > 0) shell.smokeType = 1
  }

  /** World.onBlockBreak */
  onBlockBreak(b: Block) {
    this.tiles.onBlockBreak(b)
  }

  /** World.physics after every CollideWithField (hit flags are read by Calculate next) */
  collide() {
    this.tiles.collide()
    // RPTnkMine arming: wait for the mine's own tank (the pool index of enemy / 3rd-4th
    // player mines is offset in MinePool.collideWithField; corrected here for Tanks+ levels)
    for (const m of this.w.minePool.items) {
      if (!m.active || m.state === 2 || this.minesChecked.has(m) || !m.owner) continue
      const o = m.owner
      const near = o.active && Math.hypot(o.pos.x - m.pos.x, o.pos.z - m.pos.z) <= MINE.armRadius + TANK.mineRadius
      m.hitFlags[5] = !near
      if (!near) this.minesChecked.add(m)
    }
  }

  /** World.physics after every Calculate */
  afterCalc() {
    this.frame++
    const w = this.w
    this.tiles.afterCalc()
    for (const t of w.enemyTanks) if (t.active && t.lives > 0 && t.state === 2 && t.ext) enemyBehaviours(this, t)
    for (const s of w.shellPool.items) {
      if (!s.active || !s.owner?.ext?.beh.homing || s.slot < ENEMY_SLOT0) continue
      steerShell(this, s, s.owner)
    }
    this.powerups.afterCalc()
    for (const t of w.tanks) {
      const x = t.ext
      if (!x || !t.active) continue
      if (x.iframes > 0) x.iframes--
      if (!t.isEnemy) continue
      let hidden = x.beh.ghost ? t.state === 2 && Math.hypot(t.vel.x, t.vel.z) < 0.35 : false
      if (!hidden && this.fog > 0 && t.state === 2) {
        hidden = true
        for (let i = 0; i < w.players && hidden; i++) {
          const p = w.playerTanks[i]
          if (p.active && p.lives > 0 && Math.hypot(p.pos.x - t.pos.x, p.pos.z - t.pos.z) < this.fog) hidden = false
        }
      }
      x.hidden = hidden
    }
  }

  /** moves a tank to (x, z) without leaving a tread streak between the two places */
  moveTank(t: Tank, x: number, z: number) {
    const dx = x - t.pos.x
    const dz = z - t.pos.z
    t.pos.x = x
    t.pos.z = z
    t.prevPos.x += dx
    t.prevPos.z += dz
    for (const p of t.treadPos) {
      p.x += dx
      p.z += dz
    }
    if (t.ext) t.ext.slide = null
  }

  /** players' controller parameters (power-ups) */
  refreshPlayer(t: Tank) {
    if (t.ext) applyBuffs(t)
  }
}
