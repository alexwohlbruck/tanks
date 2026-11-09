// RPTnkShell (RPTnkShell_2.cpp) and RPTnkShellPool (RPTnkShell.cpp).

import { Actor, ActorPool } from './actor'
import type { AiMove } from './ai'
import { SHELL } from './consts'
import { collideActor } from './field'
import type { Tank } from './tank'
import { type V3, EY, accumulate, cross, dot, mag, normalize, perpendicularDir, perpendicularDistance, v3, vcopy } from './vec'
import type { World } from './world'

export type ShellDeath = 'wall' | 'early' | 'tank' | 'mine' | 'bullet' | 'clear'

export class Shell extends Actor {
  /** walls the shell may still bounce off; it dies when this drops below 0 */
  bouncesLeft = 1
  /** owner slot: 0/1 players, 2 + enemy index */
  slot = 0
  /** 0 Tnk_shellsmoke01 (normal), 1 _02 (Marine, Black), 2 _03 (Green) */
  smokeType = 0
  /** spawn bits 12-15: the shooter's enemy type (0 for players); 7 = "super" ricochet sound */
  shooterType = 0
  isEnemy = false
  hitTank = false
  /** [0] other shell, [1] mine, [2] wall, [3] wall while age <= 6 */
  hitFlags = [false, false, false, false]
  state = 0
  owner: Tank | null = null

  constructor(private w: World) {
    super()
  }

  // ---- public view ----
  /** rocket (fast smoke-trail shell) */
  get fast() {
    return this.smokeType !== 0
  }
  get alive() {
    return this.active
  }
  get type() {
    return this.shooterType
  }
  get team() {
    return this.slot >= 2 ? 2 : this.slot
  }

  override ownerSlot() {
    return this.slot
  }
  override ownerTank() {
    return this.owner
  }

  /** RPTnkShell::OnSpawn */
  override onSpawn() {
    this.scale.x = this.scale.y = this.scale.z = SHELL.scale
    this.hitRadius = 1
    this.hitTank = false
    this.hitFlags.fill(false)
    this.bouncesLeft = 1
    this.owner = null
    this.state = 0
  }

  /** RPTnkShell::ApplySpawnParam */
  override applySpawnParam(param: number) {
    this.slot = param & 0xf
    this.isEnemy = this.slot >= 2
    this.bouncesLeft = (param >> 4) & 0xf
    this.smokeType = (param >> 8) & 7
    this.shooterType = (param >> 12) & 0xf
  }

  override clearForcesStep() {
    this.clearForces()
    this.hitTank = false
    this.hitFlags.fill(false)
  }

  /** RPTnkShell::CollideWithField */
  override collideWithField() {
    this.hitRadius = SHELL.radius
    collideActor(this.w, this, 3)
    this.hitRadius = SHELL.radius
    const r = this.w.findShellHit(this)
    if (r && (this.age >= SHELL.selfHitAge || this.owner !== r.tank)) {
      this.hitTank = true
      const kind = this.slot === 0 ? 1 : this.slot === 1 ? 2 : 3
      r.tank.keepNearestShellHit(kind, r.dist)
    }
    this.hitRadius = SHELL.radius
    if (this.w.minePool.checkShellHit(this)) this.hitFlags[1] = true
    if (this.w.shellPool.collideShellWithShells(this)) this.hitFlags[0] = true
  }

  /** RPTnkShell::OnHitWall: mirror reflection via the push accumulators */
  override onHitWall(depth: number, n: V3) {
    const d = dot(this.vel, n)
    const speed = mag(this.vel)
    if (d < 0) {
      const back = normalize(v3(-this.vel.x, 0, -this.vel.z))
      let dist = dot(back, n)
      if (dist !== 0) dist = depth / dist
      if (dist > speed) accumulate(this.posAccum[0], this.posAccum[1], depth, n)
      else accumulate(this.posAccum[0], this.posAccum[1], dist, back)
    } else accumulate(this.posAccum[0], this.posAccum[1], depth, n)
    const refl = -2 * d
    if (refl > 0) accumulate(this.velAccum[0], this.velAccum[1], refl, n)
    this.hitFlags[2] = true
    if (this.age <= SHELL.earlyWallAge) this.hitFlags[3] = true
  }

  /** RPTnkShell::TestHit: shell radius 6 against other's pos + hitOffsetAlt */
  override testHit(other: Actor): number | null {
    const cx = other.pos.x + other.hitOffsetAlt.x
    const cz = other.pos.z + other.hitOffsetAlt.z
    const r = SHELL.radius + other.hitRadius
    const r2 = r * r
    let dx = cx - (this.pos.x + this.hitOffset.x)
    dx *= dx
    if (dx > r2) return null
    let dz = cz - (this.pos.z + this.hitOffset.z)
    dz *= dz
    if (dz > r2) return null
    if (dx + dz > r2) return null
    return Math.sqrt(dx + dz)
  }

  /** RPTnkShell::Calculate -> StateResolveHits */
  override calculate() {
    this.vel.y = 0
    const sp = mag(this.vel)
    if (sp !== 0) {
      this.rot.z = v3(this.vel.x / sp, this.vel.y / sp, this.vel.z / sp)
      this.rot.y = vcopy(EY)
      cross(this.rot.y, this.rot.z, this.rot.x)
    }
    if (this.hitFlags[2]) {
      if (--this.bouncesLeft <= -1) return this.die('wall')
      if (this.hitFlags[3]) {
        this.bouncesLeft = -1
        return this.die('early')
      }
      const sup = this.shooterType === 7
      this.w.sound(sup ? 'RP_TNK_SE_REFLECT_SUPER' : 'RP_TNK_SE_REFLECT', this.pos)
      this.w.emit({ t: 'ricochet', bullet: this, pos: vcopy(this.pos), super: sup })
    }
    if (this.hitTank || this.hitFlags[1]) {
      this.bouncesLeft = -1
      return this.die(this.hitTank ? 'tank' : 'mine')
    }
    if (this.hitFlags[0]) {
      this.bouncesLeft = -1
      return this.die('bullet')
    }
    // the rockets' flight loop (holdSound while alive)
    if (this.shooterType === 3) this.w.soundHold('RP_TNK_SE_SHOOT_ENEMY3_LV', this.id, this.pos)
    else if (this.shooterType === 7) this.w.soundHold('RP_TNK_SE_SHOOT_ENEMY7_LV', this.id, this.pos)
    else if (this.shooterType === 9) this.w.soundHold('RP_TNK_SE_SHOOT_ENEMY9_LV', this.id, this.pos)
  }

  /** shell_bomb effect + BROKEN for wall deaths; tank / mine / shell hits just Kill */
  private die(reason: ShellDeath) {
    if (reason === 'wall' || reason === 'early') this.w.sound('RP_TNK_SE_BROKEN', this.pos)
    this.w.emit({ t: 'bulletDie', bullet: this, pos: vcopy(this.pos), reason })
    this.kill()
  }
}

export class ShellPool extends ActorPool<Shell> {
  /** active shells per owner slot, recounted at the start of every frame */
  shellNum = new Array(10).fill(0)

  constructor(private w: World, n: number) {
    super(n, () => new Shell(w))
  }

  /** RPTnkShellPool::CountShellsPerOwner */
  countShellsPerOwner() {
    this.shellNum.fill(0)
    this.forActive((s) => this.shellNum[s.slot]++)
  }

  /** RPTnkShellPool::StopAllEffects (smoke fades; also our "frozen" marker) */
  stopAllEffects() {
    this.w.emit({ t: 'shellsFrozen' })
  }

  /** RPTnkShellPool::IsObjectHit: optionally ignores the target owner's young shells */
  isObjectHit(actor: Actor, ignoreOwnShells: boolean): boolean {
    if (this.activeNum === 0) return false
    let hit = false
    for (const s of this.items) {
      if (!s.active || s.testHit(actor) === null) continue
      if (ignoreOwnShells && s.age < SHELL.ownMineAge && actor.ownerTank() === s.owner) continue
      hit = true
    }
    return hit
  }

  /** RPTnkShellPool::CollideShellWithShells: both shells die; the lower index plays BROKEN */
  collideShellWithShells(shell: Shell): boolean {
    if (this.activeNum === 0) return false
    let hit = false
    for (const s of this.items) {
      if (!s.active || s === shell || s.testHit(shell) === null) continue
      const mid = v3(0.5 * (s.pos.x + shell.pos.x), 0.5 * (s.pos.y + shell.pos.y), 0.5 * (s.pos.z + shell.pos.z))
      this.w.emit({ t: 'shellClash', pos: mid })
      if (shell.index < s.index) this.w.sound('RP_TNK_SE_BROKEN', mid)
      hit = true
    }
    return hit
  }

  /** RPTnkShellPool::DetectIncomingShells: shells within range and heading toward the tank.
   * Only slot 0 (P1) counts as "player"; P2's shells use the enemy range. */
  detectIncomingShells(m: AiMove) {
    if (this.activeNum === 0) return
    const tank = m.tankRef
    const tp = tank.hitCenterAlt()
    const er = m.shellRangeEnemy
    const pr = m.shellRangePlayer
    if (er === 0 && pr === 0) return
    for (const s of this.items) {
      if (!s.active) continue
      const range = s.slot === 0 ? pr : er
      if (range === 0) continue
      const sp = vcopy(s.pos)
      const dir = vcopy(s.rot.z)
      const delta = v3(tp.x - sp.x, 0, tp.z - sp.z)
      const dist = mag(delta)
      if (dist < range && dot(delta, dir) > 0) {
        const perpDir = perpendicularDir(v3(), tp, sp, dir)
        perpDir.x = -perpDir.x
        perpDir.z = -perpDir.z
        m.addShellThreat({ pos: sp, dir, dist, perpDist: perpendicularDistance(tp, sp, dir), perpDir })
      }
    }
  }
}
