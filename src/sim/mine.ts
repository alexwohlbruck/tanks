// RPTnkMine (RPTnkMine_2.cpp) and RPTnkMinePool (RPTnkMine.cpp).
//
// States: 0 move to target (speed is always 0 in the game, so it arms at once), 1 armed,
// 2 exploding. Arming: the mine ignores tanks until its owner has left 90 (+14) units; then any
// tank within 70 (+14) lights a 20-frame fuse. Untouched it lights a 120-frame fuse at age 480.
// A shell hit or another blast detonates it at once.

import { Actor, ActorPool } from './actor'
import type { AiMove } from './ai'
import { MINE, MAX_ENEMIES, ENEMY_SLOT0, TEAM_ENEMY, HIT_ENEMY } from './consts'
import { collideActor } from './field'
import type { Tank } from './tank'
import { type V3, accumulate, dot, normalize, v3, vcopy, vset, ZERO } from './vec'
import type { World } from './world'

export class Mine extends Actor {
  targetPos = v3()
  /** owner slot: 0/1 players, 2 + enemy index */
  slot = 0
  /** fuse countdown while lit (state 1), frames since the blast (state 2) */
  timer = 0
  blastRadius: number = MINE.blastIdle
  isEnemy = false
  /** [0] tank near, [1] shell hit, [2] other explosion, [3] wall, [4] kill, [5] armed */
  hitFlags = [false, false, false, false, false, false]
  fuseLit = false
  state = 0
  owner: Tank | null = null
  /** [versus] owner slot credited with the blast (World.mineCreditTrigger), -1 = the owner */
  creditSlot = -1
  /** [versus] this frame's trigger: the slot whose shell / blast hit the mine, -1 none */
  private triggerSlot = -1

  constructor(private w: World) {
    super()
  }

  get alive() {
    return this.active && this.state !== 2
  }
  get exploding() {
    return this.active && this.state === 2
  }
  get armed() {
    return this.hitFlags[5]
  }
  get team() {
    return this.slot >= ENEMY_SLOT0 ? TEAM_ENEMY : this.slot
  }

  override ownerSlot() {
    return this.slot
  }
  override ownerTank() {
    return this.owner
  }
  override isExploding() {
    return this.state === 2
  }

  /** RPTnkMine::OnSpawn */
  override onSpawn() {
    this.hitRadius = 1
    vset(this.hitOffsetAlt, { x: 0, y: 0, z: MINE.shellOffsetZ })
    this.pos.y = 0
    this.timer = 0
    this.blastRadius = MINE.blastIdle
    this.hitFlags.fill(false)
    this.fuseLit = false
    this.owner = null
    this.state = 0
    this.creditSlot = -1
    this.triggerSlot = -1
  }

  /** the slot a blast of this mine is credited to */
  get blastSlot() {
    return this.creditSlot >= 0 ? this.creditSlot : this.slot
  }

  override applySpawnParam(param: number) {
    this.slot = param & 0xff
    this.isEnemy = this.slot >= ENEMY_SLOT0
  }

  override clearForcesStep() {
    this.clearForces()
    for (let i = 0; i < 5; i++) this.hitFlags[i] = false
    this.triggerSlot = -1
  }

  /** RPTnkMine::CollideWithField */
  override collideWithField() {
    this.hitRadius = MINE.fieldRadius
    collideActor(this.w, this, 0)
    if (this.state === 0 || this.state === 1) {
      if (!this.hitFlags[5]) {
        this.hitRadius = MINE.armRadius
        const owner = this.isEnemy ? this.slot - ENEMY_SLOT0 : this.slot
        if (!this.w.testMineHitTank(this, owner, this.isEnemy)) this.hitFlags[5] = true
      } else {
        this.hitRadius = MINE.triggerRadius
        if (this.w.findMineHit(this)) this.hitFlags[0] = true
      }
      this.hitRadius = MINE.bodyRadius
      if (this.w.shellPool.isObjectHit(this, true)) this.hitFlags[1] = true
      // [versus] who set it off: the first shell over it, else the first blast it is in
      if (this.w.mineCreditTrigger && this.hitFlags[1]) this.triggerSlot = this.w.shellPool.objectHitSlot(this, true)
      this.hitRadius = MINE.bodyRadius
      if (this.w.minePool.isInOtherExplosion(this)) {
        this.hitFlags[2] = true
        if (this.w.mineCreditTrigger && !this.hitFlags[1]) this.triggerSlot = this.w.minePool.otherExplosionSlot(this)
      }
    } else if (this.state === 2) {
      if (this.timer < MINE.blastKillFrames) {
        this.hitRadius = this.blastRadius
        const r = this.w.findMineHit(this)
        if (r) {
          const slot = this.w.mineCreditTrigger ? this.blastSlot : this.slot
          const kind = slot < ENEMY_SLOT0 ? slot + 1 : HIT_ENEMY
          r.tank.keepNearestMineHit(kind, r.dist)
        }
      }
    }
  }

  /** RPTnkMine::Calculate */
  override calculate() {
    if (this.state === 0) this.stateMoveToTarget()
    else if (this.state === 1) this.stateArmed()
    else this.stateExplode()
  }

  private stateMoveToTarget() {
    const speed = Math.hypot(this.vel.x, this.vel.y, this.vel.z)
    if (speed === 0) this.state = 1
    else {
      const d = v3(this.targetPos.x - this.pos.x, this.targetPos.y - this.pos.y, this.targetPos.z - this.pos.z)
      const dist = Math.hypot(d.x, d.y, d.z)
      if (dist === 0) this.state = 1
      else {
        normalize(d)
        const s = dist <= speed ? dist : speed
        this.vel.x = s * d.x
        this.vel.y = s * d.y
        this.vel.z = s * d.z
        if (dist <= speed) this.state = 1
      }
    }
    if (this.hitFlags[3]) {
      vset(this.vel, ZERO)
      this.state = 1
    }
    if (this.hitFlags[0] || this.hitFlags[4]) this.kill()
  }

  private stateArmed() {
    vset(this.vel, ZERO)
    if (this.hitFlags[4]) this.kill()
    else if (this.hitFlags[1] || this.hitFlags[2]) {
      if (this.w.mineCreditTrigger) this.creditSlot = this.triggerSlot
      this.explode()
    }
    else if (!this.fuseLit) {
      if (this.age >= MINE.fuse) {
        this.timer = MINE.fuseLit
        this.fuseLit = true
        this.w.emit({ t: 'mineFuse', mine: this, near: false })
      } else if (this.hitFlags[0]) {
        this.timer = MINE.fuseNear
        this.fuseLit = true
        this.w.emit({ t: 'mineFuse', mine: this, near: true })
      }
    } else {
      if (--this.timer <= 0) this.explode()
      // RPTnkTank::HoldMineFuseSe: only player-owned mines beep
      if (this.slot < ENEMY_SLOT0) this.w.soundHold('RP_TNK_SE_JIRAI_EXP_MAE', -1 - this.slot, this.pos)
    }
  }

  private stateExplode() {
    vset(this.vel, ZERO)
    if (this.timer >= MINE.blastGrowFrames) this.blastRadius = MINE.blastMax
    else this.blastRadius = (this.timer / MINE.blastGrowFrames) * (MINE.blastMax - MINE.blastStart) + MINE.blastStart
    if (++this.timer >= MINE.blastFrames) {
      this.kill()
      this.w.emit({ t: 'mineGone', mine: this })
    }
  }

  /** RPTnkMine::Explode: effect Tnk_mine_bomb (scale 1.6), JIRAI_EXP, state 2 */
  explode() {
    this.fuseLit = true
    this.timer = 0
    this.w.sound('RP_TNK_SE_JIRAI_EXP', this.pos)
    this.w.emit({ t: 'mineExplode', mine: this })
    this.state = 2
  }

  /** RPTnkMine::OnHitWall */
  override onHitWall(depth: number, n: V3) {
    accumulate(this.posAccum[0], this.posAccum[1], depth, n)
    const push = -dot(this.vel, n)
    if (push > 0) accumulate(this.velAccum[0], this.velAccum[1], push, n)
    this.hitFlags[3] = true
  }

  /** RPTnkMine::TestHit: mine body 12 + other's radius around pos */
  override testHit(other: Actor) {
    return circleAround(other.hitCenter(), this.pos.x + this.hitOffset.x, this.pos.z + this.hitOffset.z, MINE.bodyRadius + other.hitRadius)
  }
  /** RPTnkMine::TestHitAlt: same around pos + (0, 0, 16) */
  override testHitAlt(other: Actor) {
    return circleAround(other.hitCenter(), this.pos.x + this.hitOffsetAlt.x, this.pos.z + this.hitOffsetAlt.z, MINE.bodyRadius + other.hitRadius)
  }

  /** RPTnkMine::IsInBlastRadius (inclusive) */
  override isInBlastRadius(other: Actor) {
    if (this.state !== 2) return false
    return circleAround(other.hitCenter(), this.pos.x + this.hitOffset.x, this.pos.z + this.hitOffset.z, this.blastRadius + other.hitRadius) !== null
  }
  /** RPTnkMine::IsInTriggerRange: 80 + other's radius (used by the AI probes) */
  override isInTriggerRange(other: Actor) {
    return circleAround(other.hitCenter(), this.pos.x + this.hitOffset.x, this.pos.z + this.hitOffset.z, MINE.proximity + other.hitRadius) !== null
  }
}

function circleAround(o: V3, cx: number, cz: number, radius: number): number | null {
  const r2 = radius * radius
  let dx = o.x - cx
  dx *= dx
  if (dx > r2) return null
  let dz = o.z - cz
  dz *= dz
  if (dz > r2) return null
  if (dx + dz > r2) return null
  return Math.sqrt(dx + dz)
}

export class MinePool extends ActorPool<Mine> {
  /** non-exploding mines per owner slot, recounted every frame */
  mineNum = new Array(ENEMY_SLOT0 + MAX_ENEMIES).fill(0)

  constructor(w: World, n: number) {
    super(n, () => new Mine(w))
  }

  /** RPTnkMinePool::CountByOwner */
  countByOwner() {
    this.mineNum.fill(0)
    this.forActive((m) => {
      if (!m.isExploding()) this.mineNum[m.slot]++
    })
  }

  /** RPTnkMinePool::CheckShellHit: young shells pass their own tank's mines */
  checkShellHit(shell: Actor): boolean {
    if (this.activeNum === 0) return false
    let hit = false
    for (const m of this.items) {
      if (!m.active || m.testHitAlt(shell) === null) continue
      if (shell.age >= 16 || m.owner !== shell.ownerTank()) hit = true
    }
    return hit
  }

  isInExplosion(a: Actor): boolean {
    if (this.activeNum === 0) return false
    for (const m of this.items) if (m.active && m.isInBlastRadius(a)) return true
    return false
  }

  isInOtherExplosion(a: Actor): boolean {
    if (this.activeNum === 0) return false
    for (const m of this.items) if (m.active && m !== a && m.isInBlastRadius(a)) return true
    return false
  }

  /** [versus] the slot credited with the first other blast `a` is in (-1 none) */
  otherExplosionSlot(a: Actor): number {
    for (const m of this.items) if (m.active && m !== a && m.isInBlastRadius(a)) return m.blastSlot
    return -1
  }

  isNearAnyMine(a: Actor): boolean {
    if (this.activeNum === 0) return false
    for (const m of this.items) if (m.active && m.isInTriggerRange(a)) return true
    return false
  }

  /** RPTnkMinePool::AddTankAvoidance: P1's mines use the "player" radius, all others the enemy one */
  addTankAvoidance(ai: AiMove) {
    if (this.activeNum === 0) return
    const pos = ai.pos
    const er = ai.mineRadiusEnemy
    const pr = ai.mineRadiusPlayer
    if (er === 0 && pr === 0) return
    for (const m of this.items) {
      if (!m.active) continue
      const radius = m.slot === 0 ? pr : er
      if (radius === 0) continue
      const c = vcopy(m.pos)
      const dir = v3(pos.x - c.x, 0, pos.z - c.z)
      const dist = Math.hypot(dir.x, dir.z)
      if (dist < radius) {
        if (dist !== 0) normalize(dir)
        ai.addMineThreat({ pos: c, dist, dir })
      }
    }
  }
}
