// RPTnkTank (RPTnkTank.cpp) and its tread-sound helper RPTnkTankSound (RPTnkSound_2.cpp).
//
// States: 0 idle (spawned, waiting for StateStageStart; players still aim), 1 player control,
// 2 enemy control, 3 player stop, 4 enemy stop (3/4 are never entered by the game manager).
// Body orientation is the basis `rot` (z = forward); the turret has its own basis.

import { Actor } from './actor'
import { AiController } from './ai'
import { TANK, TEAM_ENEMY } from './consts'
import { collideActor } from './field'
import { PlayerController } from './player'
import type { TankExt } from './plus'
import type { Shell } from './shell'
import { FIRST_ADDED_TYPE, paramsFor } from './stats'
import { type Axes, type V3, EY, accumulate, copyAxes, cross, dot, heading, identityAxes, mag, normalize, setAxes, v3, vcopy, vset } from './vec'
import type { World } from './world'

/** player index 0-3, or TEAM_ENEMY (9) */
export type Team = number

/**
 * Per-frame player input (filled by padToIntent). Enemy tanks ignore it.
 * moveX/moveZ: world-space drive direction, |v| = stick deflection 0..1 (z = down the screen).
 * analog: Nunchuk stick (10 degree drive cone) vs D-pad (46 degrees).
 * aimX/aimZ: cursor position on the field (world units).
 * fire / mine: B / A pressed this frame (edge triggered, like getTrigger()).
 */
export type Intent = {
  moveX: number
  moveZ: number
  analog: boolean
  aimX: number
  aimZ: number
  /** turret angle toward the aim point (informational) */
  aim: number
  /** legacy, unused */
  aimSnap: boolean
  fire: boolean
  mine: boolean
}

export type HitInfo = { id: number; dist: number }
const NO_HIT = (): HitInfo => ({ id: 0, dist: 1000 })

/** Tnk_treadSoundIds indexed by SetSeVariant's tread index */
const TREAD_SOUNDS = [
  'RP_TNK_SE_CATERPILLAR_1P',
  'RP_TNK_SE_CATERPILLAR_2P',
  'RP_TNK_SE_CATERPILLAR_SLOW',
  'RP_TNK_SE_CATERPILLAR_SLOW',
  'RP_TNK_SE_CATERPILLAR_SLOW',
  'RP_TNK_SE_CATERPILLAR_MID',
  'RP_TNK_SE_CATERPILLAR_MID',
  'RP_TNK_SE_CATERPILLAR_SAME',
  'RP_TNK_SE_CATERPILLAR_SAME',
  'RP_TNK_SE_CATERPILLAR_FAST',
  'RP_TNK_SE_CATERPILLAR_FAST',
  'RP_TNK_SE_CATERPILLAR_SLOW',
]

/** RPTnkTankSound: smoothed speed driving the tread-sound interval */
export class TankSound {
  maxSpeed = 1
  accelRate = 1 / 14
  decelRate = 1 / 45
  topStep = (1 * 0.3) / 200
  speed = 0
  target = 0
  step = 0
  treadTimer = 0
  treadIndex = 0

  clear() {
    this.speed = 0
    this.target = 0
    this.step = 0
    this.treadTimer = 0
  }

  /** RPTnkTankSound::ApproachSpeed */
  private approach(target: number) {
    if (this.speed > 0.7 * this.maxSpeed && this.speed < target) this.step = this.topStep
    else if (target !== this.target) {
      this.step = target > this.speed ? this.accelRate * (target - this.speed) : this.decelRate * (target - this.speed)
      this.target = target
    }
    const diff = target - this.speed
    if (Math.abs(diff) <= Math.abs(this.step)) {
      this.speed = target
      this.step = 0
    } else this.speed += this.step
    if (this.speed > this.maxSpeed) this.speed = this.maxSpeed
    else if (this.speed < 0) this.speed = 0
    return this.speed
  }

  /** RPTnkTankSound::UpdateTread: returns the sound to start this frame, if any */
  update(speed: number): string | null {
    const s = this.approach(speed)
    let out: string | null = null
    if (s > 0.01) {
      let interval = -30 * s + 25
      if (interval > 25) interval = 25
      else if (interval < 4) interval = 4
      if (this.treadTimer === 1) out = TREAD_SOUNDS[this.treadIndex]
      else if (this.treadTimer > Math.trunc(interval)) this.treadTimer = 0
      this.treadTimer = (this.treadTimer + 1) & 0xffff
    }
    return out
  }
}

export class Tank extends Actor {
  bodyHeight = 1
  turretRot: Axes = identityAxes()
  /** |velocity| */
  speed = 0
  maxSpeed = 1
  /** mAlive: 1 after spawn, 0 once hit (the decomp's 1-hit "hit points") */
  lives = 0
  modelIdx = 0
  state = 0
  shellHit: HitInfo = NO_HIT()
  mineHit: HitInfo = NO_HIT()
  isEnemy: boolean
  stealth = false
  enemyType = 0
  /** spawn parameter: enemy spawn slot 0-7 */
  spawnParam = 0
  treadPos: [V3, V3] = [v3(), v3()]
  prevPos = v3()
  /** mTreadDistance: drives the tread marks (consumed 10 units at a time) */
  treadDistance = 0
  player: PlayerController
  aiCtrl: AiController
  tankSound = new TankSound()

  // ---- public view / contract ----
  intent: Intent = { moveX: 0, moveZ: 0, analog: false, aimX: 0, aimZ: 0, aim: 0, aimSnap: false, fire: false, mine: false }
  /** total tread distance since spawn (monotonic) */
  odometer = 0
  /** scratch space for renderers (not part of the simulation) */
  ai: any = {}
  /** [tanks+] per-tank state of the extension (src/sim/plus.ts); null for the original missions */
  ext: TankExt | null = null

  constructor(private w: World, enemy: boolean, index: number) {
    super()
    this.isEnemy = enemy
    this.index = index
    this.player = new PlayerController(this, w)
    this.aiCtrl = new AiController(this, w)
  }

  /** 0 = player, 1-9 = enemy type */
  get type() {
    return this.isEnemy ? this.enemyType : 0
  }
  get team(): Team {
    return this.isEnemy ? TEAM_ENEMY : this.index
  }
  /** enemy spawn slot 0-7 (-1 for players) */
  get slot() {
    return this.isEnemy ? this.spawnParam : -1
  }
  /** body heading in radians, 0 = +x, toward +z positive (renderer: rotation.y = -body) */
  get body() {
    return heading(this.rot.z)
  }
  get turret() {
    return heading(this.turretRot.z)
  }
  get alive() {
    return this.active && this.lives > 0
  }
  /** RPTnkTank::CalcModelMtx hides the model in state 2 when stealthed */
  get invisible() {
    // [tanks+] Ghost / fog of war (ext is null for the original missions)
    return (this.state === 2 && this.stealth) || (this.ext !== null && this.ext.hidden)
  }
  get moving() {
    return this.speed > 0.01
  }
  /** legacy stats view */
  get stats() {
    return paramsFor(this.type)
  }
  get forward(): V3 {
    return this.rot.z
  }

  /** RPTnkTank::OnSpawn */
  override onSpawn() {
    this.hitRadius = TANK.fieldRadius
    vset(this.hitOffsetAlt, { x: 0, y: 0, z: TANK.shellOffsetZ })
    this.scale.x = this.scale.y = this.scale.z = TANK.scale
    this.bodyHeight = 11 * this.scale.y
    setAxes(this.rot, identityAxes())
    this.turretRot = copyAxes(this.rot)
    this.speed = 0
    this.maxSpeed = 1
    this.lives = 1
    this.shellHit = NO_HIT()
    this.mineHit = NO_HIT()
    const tx = 10 * this.rot.x.x + this.pos.x
    const tz = 10 * this.rot.x.z + this.pos.z
    this.treadPos = [v3(tx, 0, tz), v3(tx, 0, tz)]
    vset(this.prevPos, this.pos)
    this.treadDistance = 0
    this.odometer = 0
    this.tankSound.clear()
    this.player.reset()
    this.state = 0
  }

  override applySpawnParam(param: number) {
    this.spawnParam = param & 0xff
  }

  /** RPTnkTank::Reset */
  override reset() {
    super.reset()
    this.bodyHeight = 1
    this.turretRot = identityAxes()
    this.speed = 0
    this.maxSpeed = 1
    this.lives = 0
    this.shellHit = NO_HIT()
    this.mineHit = NO_HIT()
    this.modelIdx = 0
    this.state = 0
    this.stealth = false
    this.enemyType = 0
    this.spawnParam = 0
    this.tankSound.clear()
    this.player.reset()
    this.aiCtrl.reset()
    this.ext = null
  }

  /** RPTnkTank::InitOrientation: face the field centre along the nearest axis */
  initOrientation() {
    const slope = this.w.field.depth / this.w.field.width
    const a = this.pos.z > slope * this.pos.x
    const b = this.pos.z > -slope * this.pos.x
    if (a && b) this.rot.z = v3(0, 0, -1)
    else if (!a && !b) this.rot.z = v3(0, 0, 1)
    else if (!a && b) this.rot.z = v3(-1, 0, 0)
    else if (a && !b) this.rot.z = v3(1, 0, 0)
    this.rot.y = vcopy(EY)
    cross(this.rot.y, this.rot.z, this.rot.x)
    this.turretRot = copyAxes(this.rot)
  }

  /** RPTnkTank::SpawnPlayer */
  spawnPlayer(pos: V3, param: number, show: boolean) {
    this.spawn(pos, param)
    this.isEnemy = false
    this.initOrientation()
    this.modelIdx = this.index
    this.state = show ? 0 : 1
    this.tankSound.treadIndex = this.index
    // [tanks+]
    this.ext = this.w.plus ? this.w.plus.attach(this) : null
  }

  /** RPTnkTank::SpawnEnemy */
  spawnEnemy(pos: V3, type: number, idx: number, show: boolean) {
    this.spawn(pos, idx)
    this.isEnemy = true
    this.initOrientation()
    this.aiCtrl.setMode(type)
    this.enemyType = type
    this.modelIdx = type + 1
    this.stealth = paramsFor(type).stealth
    if (this.enemyType > 0) this.w.onEnemySpawned(this.enemyType, this)
    this.aiCtrl.move.setDirection(vcopy(this.rot.z))
    this.aiCtrl.attack.setAimDirection(vcopy(this.rot.z))
    this.state = show ? 0 : 2
    this.tankSound.treadIndex = type + 1
    // [tanks+] (added types get the tread sound of their speed class)
    this.ext = this.w.plus ? this.w.plus.attach(this) : null
    if (type >= FIRST_ADDED_TYPE) {
      const s = paramsFor(type).speed
      this.tankSound.treadIndex = s <= 1.2 ? 2 : s <= 1.6 ? 5 : s <= 1.9 ? 7 : 9
    }
  }

  /** RPTnkTank::Activate (StateStageStart): White plays Tnk_stealth_change and vanishes */
  activate() {
    if (this.state !== 0) return
    if (!this.isEnemy) this.state = 1
    else {
      this.state = 2
      if (this.stealth) {
        this.w.sound('RP_TNK_SE_TNK_DISAPPEAR', this.pos)
        this.w.emit({ t: 'stealth', tank: this })
      }
    }
  }

  /** RPTnkTank::ApplyVelocity */
  override applyVelocity() {
    vset(this.prevPos, this.pos)
    super.applyVelocity()
  }

  override clearForcesStep() {
    this.clearForces()
    this.shellHit = NO_HIT()
    this.mineHit = NO_HIT()
  }

  /** RPTnkTank::CollideWithField: separation from the other tanks, then the field */
  override collideWithField() {
    this.hitRadius = TANK.fieldRadius
    this.w.separateTank(this)
    this.hitRadius = TANK.fieldRadius
    collideActor(this.w, this, 0)
  }

  /** RPTnkTank::IntegrateStep: both tread samples sit at +10 along the body x axis (sic) */
  override integrateStep() {
    this.integrate()
    const l = v3(10 * this.rot.x.x + this.pos.x, 0, 10 * this.rot.x.z + this.pos.z)
    const r = v3(10 * this.rot.x.x + this.pos.x, 0, 10 * this.rot.x.z + this.pos.z)
    const a = Math.hypot(l.x - this.treadPos[0].x, l.z - this.treadPos[0].z)
    const b = Math.hypot(r.x - this.treadPos[1].x, r.z - this.treadPos[1].z)
    const d = b <= a ? a : b
    this.treadDistance += d
    this.odometer += d
    this.treadPos = [l, r]
  }

  /** RPTnkTank::Calculate */
  override calculate() {
    switch (this.state) {
      case 0:
        this.stateIdle()
        break
      case 1:
        this.statePlayerControl()
        break
      case 2:
        this.stateEnemyControl()
        break
      case 3:
        this.statePlayerStop()
        break
      case 4:
        this.stateEnemyStop()
        break
    }
  }

  private stateIdle() {
    if (!this.isEnemy) this.player.aimAtCursor(this.turretRot, this.pos)
  }

  /** consumes a recorded hit; true when the tank exploded */
  private resolveHits(): boolean {
    // [tanks+] shields, hit points, invulnerability frames (ext is null for the original missions)
    if (this.ext && this.w.plus!.absorbHit(this)) return false
    if (this.mineHit.id !== 0) {
      if (--this.lives === 0) this.explode(this.mineHit.id, 'mine')
      return true
    }
    if (this.shellHit.id !== 0) {
      if (--this.lives === 0) this.explode(this.shellHit.id, 'shell')
      return true
    }
    return false
  }

  private updateTreadSound() {
    const ratio = this.maxSpeed !== 0 ? this.speed / this.maxSpeed : 0
    const s = this.tankSound.update(Math.min(1, Math.max(0, ratio)))
    if (s) this.w.sound(s, this.pos, this)
  }

  /** RPTnkTank::StatePlayerControl */
  private statePlayerControl() {
    if (this.resolveHits()) return
    this.player.aimAtCursor(this.turretRot, this.pos)
    const p = v3(this.pos.x, this.pos.y + 11 * this.scale.y, this.pos.z)
    this.player.handleFireInput(TANK.muzzle, this.turretRot, p, this.index)
    this.player.calcMoveVelocity(this.rot, this.vel)
    this.speed = mag(this.vel)
    this.maxSpeed = this.player.getMaxSpeed()
    this.updateTreadSound()
  }

  /** RPTnkTank::StateEnemyControl (speed is sampled before the move AI runs) */
  private stateEnemyControl() {
    if (!this.resolveHits()) {
      const p = v3(this.pos.x, this.pos.y + 11 * this.scale.y, this.pos.z)
      this.aiCtrl.attack.update(TANK.muzzle, this.turretRot, p)
      this.speed = mag(this.vel)
      this.maxSpeed = this.aiCtrl.move.speed
      this.aiCtrl.move.update(this.rot, this.vel, this.pos)
      this.updateTreadSound()
    }
  }

  private statePlayerStop() {
    this.player.aimAtCursor(this.turretRot, this.pos)
    vset(this.vel, { x: 0, y: 0, z: 0 })
    this.speed = 0
    this.maxSpeed = this.player.getMaxSpeed()
  }

  private stateEnemyStop() {
    vset(this.vel, { x: 0, y: 0, z: 0 })
    this.speed = 0
    this.maxSpeed = this.aiCtrl.move.speed
  }

  /** RPTnkTank::Explode: tallies, check mark, effects, HIT sound, Kill */
  explode(hitId: number, cause: 'shell' | 'mine') {
    this.w.onTankExplode(this, hitId, cause)
    this.speed = 0
    this.w.sound('RP_TNK_SE_HIT', this.pos)
    if (!this.isEnemy) this.w.sound('RP_TNK_SE_HIT_CSPK', this.pos)
    this.kill()
  }

  /** RPTnkTank::Kill */
  override kill() {
    super.kill()
    if (this.isEnemy) this.w.enemyAliveNum--
    this.tankSound.clear()
  }

  /** RPTnkTank::TestHit (mines / blasts): radius 14 + other's */
  override testHit(other: Actor) {
    const o = other.hitCenter()
    const r = TANK.mineRadius + other.hitRadius
    return circle(o, this.pos.x + this.hitOffset.x, this.pos.z + this.hitOffset.z, r)
  }

  /** RPTnkTank::TestHitAlt (shells): radius 15 + other's around pos + (0, 0, 9) */
  override testHitAlt(other: Actor) {
    const o = other.hitCenter()
    // [tanks+] big boss hulls
    const r = this.ext ? TANK.shellRadius + other.hitRadius + this.ext.hitBonus : TANK.shellRadius + other.hitRadius
    return circle(o, this.pos.x + this.hitOffsetAlt.x, this.pos.z + this.hitOffsetAlt.z, r)
  }

  /** RPTnkTank::PushApartFrom: pushes `other` out of this tank by the full overlap */
  pushApartFrom(other: Tank) {
    const o = other.hitCenter()
    const radius = TANK.separation
    const r2 = radius * radius
    const x = o.x - (this.pos.x + this.hitOffset.x)
    const xx = x * x
    if (xx > r2) return
    const z = o.z - (this.pos.z + this.hitOffset.z)
    const zz = z * z
    if (zz > r2) return
    if (xx + zz > r2) return
    const dist = Math.sqrt(xx + zz)
    if (dist !== 0) {
      const n = normalize(v3(x, 0, z))
      other.accumulatePushOut(radius - dist, n, this.vel)
    }
  }

  /** RPTnkTank::OnHitWall / AccumulatePushOut */
  override onHitWall(depth: number, n: V3, _wall: number, vel: V3) {
    this.accumulatePushOut(depth, n, vel)
  }
  accumulatePushOut(depth: number, n: V3, vel: V3) {
    accumulate(this.posAccum[0], this.posAccum[1], depth, n)
    const rel = v3(this.vel.x - vel.x, this.vel.y - vel.y, this.vel.z - vel.z)
    const along = -dot(rel, n)
    if (along > 0) accumulate(this.velAccum[0], this.velAccum[1], along, n)
  }

  keepNearestShellHit(id: number, dist: number) {
    if (dist < this.shellHit.dist) this.shellHit = { id, dist }
  }
  keepNearestMineHit(id: number, dist: number) {
    if (dist < this.mineHit.dist) this.mineHit = { id, dist }
  }

  /**
   * RPTnkTank::DrawTreadMark (run from the scene's draw, once per frame): when 10 units of
   * tread travel have built up, stamps one 30x30 mark, placed back along the last move.
   */
  treadMark(): { pos: V3; dir: V3 } | null {
    if (this.treadDistance < TANK.treadMarkSpacing) return null
    this.treadDistance -= TANK.treadMarkSpacing
    const d = v3(this.prevPos.x - this.pos.x, this.prevPos.y - this.pos.y, this.prevPos.z - this.pos.z)
    if (mag(d) !== 0) normalize(d)
    const pos = v3(this.treadDistance * d.x + this.pos.x, this.treadDistance * d.y + this.pos.y, this.treadDistance * d.z + this.pos.z)
    return { pos, dir: vcopy(this.rot.z) }
  }

  /** RPTnkTank::PlayFireSeByType + PlayShotEffect */
  playFireSe(shell: Shell | null) {
    if (!this.isEnemy) this.w.sound(this.index === 0 ? 'RP_TNK_SE_SHOOT_1P' : 'RP_TNK_SE_SHOOT_2P', this.pos, this)
    else {
      // [tanks+] added types sound like the original type whose shells they borrow
      const type = this.enemyType < FIRST_ADDED_TYPE ? this.enemyType : this.w.plus ? this.w.plus.shellLook(this.enemyType) : 2
      const id = { 1: 'RP_TNK_SE_SHOOT_ENEMY1', 2: 'RP_TNK_SE_SHOOT_ENEMY2', 4: 'RP_TNK_SE_SHOOT_ENEMY4', 5: 'RP_TNK_SE_SHOOT_ENEMY5', 6: 'RP_TNK_SE_SHOOT_ENEMY6', 8: 'RP_TNK_SE_SHOOT_ENEMY8' }[type]
      if (id) this.w.sound(id, this.pos, this)
    }
    this.w.emit({ t: 'shoot', tank: this, bullet: shell })
    // [tanks+] fans, rocket power-up
    if (this.w.plus) this.w.plus.onFire(this, shell)
  }

  /** RPTnkTank::PlayLayMineSe */
  playLayMineSe() {
    this.w.sound('RP_TNK_SE_JIRAI_SET', this.pos, this)
    if (!this.isEnemy) this.w.sound('RP_TNK_SE_JIRAI_SET_CSPK', this.pos, this)
  }
}

function circle(o: V3, cx: number, cz: number, radius: number): number | null {
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
