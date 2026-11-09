// RPTnkPlayerController (RPTnkPlayerController.cpp): stick/D-pad driving, pointer aiming,
// B fires, A lays a mine (A wins when both arrive in the same frame).

import { TANK } from './consts'
import { paramsFor } from './stats'
import type { Tank } from './tank'
import { type Axes, type V3, axesFromForward, cosDeg, dot, normalize, selectMoreAligned, v3, vset } from './vec'
import type { World } from './world'

export class PlayerController {
  // RPTnkPlayerController::Reset copies these from the player record (TnkGameParam record 0)
  stickMin = 0
  stickMax = 0
  accel = 0
  friction = 0
  maxSpeed = 0
  moveAngle = 0
  turnSpeed = 0
  fireCooldown = 0
  maxShells = 0
  shellBounces = 0
  shellSpeed = 0
  /** k41: movement freeze after a shot (decomp: mMineCooldownInit) */
  fireFreeze = 0
  /** k8: frames between mines (decomp: unk34) */
  mineCooldown = 0
  maxMines = 0
  /** k9: movement freeze after a mine (decomp: unk3C) */
  mineFreeze = 0
  /** unk40: current speed */
  speed = 0
  /** unk44: +1 driving forward, -1 reversing */
  sign = 1
  shellTimer = 0
  mineTimer = 0
  /** unk50: frames the tank may not drive */
  freeze = 0
  mineHeld = false
  fired = false
  laidMine = false

  constructor(private tank: Tank, private w: World) {}

  /** RPTnkPlayerController::Reset (always the player record, also for player 2) */
  reset() {
    const p = paramsFor(0)
    this.stickMin = p.stickMin
    this.stickMax = p.stickMax
    this.accel = p.accel
    this.friction = p.decel
    this.maxSpeed = p.speed
    this.moveAngle = p.moveAngle
    this.turnSpeed = p.turnStep
    this.fireCooldown = p.fireCooldown
    this.maxShells = p.maxShells
    this.shellBounces = p.ricochets
    this.shellSpeed = p.shellSpeed
    this.fireFreeze = p.fireFreeze
    this.mineCooldown = p.mineCooldown
    this.maxMines = p.maxMines
    this.mineFreeze = p.mineFreeze
    this.speed = 0
    this.sign = 1
    this.shellTimer = 0
    this.mineTimer = 0
    this.freeze = 0
    this.mineHeld = false
    this.fired = false
    this.laidMine = false
  }

  /** RPTnkPlayerController::AimAtCursor: turret z points at the cursor on the XZ plane */
  aimAtCursor(turret: Axes, pos: V3) {
    const it = this.tank.intent
    const dx = it.aimX - pos.x
    const dz = it.aimZ - pos.z
    const len = Math.hypot(dx, dz)
    if (len !== 0) axesFromForward(turret, v3(dx / len, 0, dz / len))
  }

  /** RPTnkPlayerController::TurnBodyStep */
  private turnBodyStep(rot: Axes, dir: V3) {
    const f = rot.z
    const k = this.turnSpeed
    const plus = normalize(v3(rot.x.x * k + f.x, rot.x.y * k + f.y, rot.x.z * k + f.z))
    const minus = normalize(v3(f.x - rot.x.x * k, f.y - rot.x.y * k, f.z - rot.x.z * k))
    const sel = v3()
    selectMoreAligned(sel, dir, minus, plus)
    const forward = v3()
    selectMoreAligned(forward, f, sel, dir)
    normalize(forward)
    axesFromForward(rot, forward)
  }

  /** RPTnkPlayerController::TurnBodyTowards: reverses instead of turning more than 90 degrees */
  private turnBodyTowards(rot: Axes, dir: V3) {
    const forward = v3(rot.z.x, rot.z.y, rot.z.z)
    const backward = v3(-forward.x, -forward.y, -forward.z)
    if (!selectMoreAligned(v3(), dir, forward, backward)) {
      this.turnBodyStep(rot, dir)
      this.sign = 1
    } else {
      const k = this.turnSpeed
      const plus = normalize(v3(rot.x.x * k + backward.x, rot.x.y * k + backward.y, rot.x.z * k + backward.z))
      const minus = normalize(v3(backward.x - rot.x.x * k, backward.y - rot.x.y * k, backward.z - rot.x.z * k))
      const cand = v3()
      selectMoreAligned(cand, dir, minus, plus)
      selectMoreAligned(backward, backward, cand, dir)
      const f = normalize(v3(-backward.x, -backward.y, -backward.z))
      axesFromForward(rot, f)
      this.sign = -1
    }
  }

  /** RPTnkPlayerController::CalcMoveVelocity */
  calcMoveVelocity(rot: Axes, vel: V3) {
    const it = this.tank.intent
    // GetMoveInput: (stickX, stickY) with +y = up the screen; the world direction is (x, 0, -y)
    const freestyle = it.analog
    const dir = v3(it.moveX, 0, it.moveZ)
    let magnitude = Math.hypot(dir.x, dir.z)
    magnitude = Math.min(1, Math.max(0, magnitude))
    if (this.freeze > 0) {
      this.speed = 0
    } else if (magnitude >= this.stickMin) {
      const inv = 1 / magnitude
      dir.x *= inv
      dir.z *= inv
      this.turnBodyTowards(rot, dir)
      const angle = freestyle ? this.moveAngle : 46
      const forward = v3(rot.z.x * this.sign, rot.z.y * this.sign, rot.z.z * this.sign)
      if (dot(forward, dir) < cosDeg(angle)) {
        this.speed *= this.friction
      } else {
        let maxSpeed: number
        const range = this.stickMax - this.stickMin
        if (range !== 0) {
          const f = Math.min(1, Math.max(0, (magnitude - this.stickMin) / range))
          maxSpeed = f * this.maxSpeed
        } else maxSpeed = this.maxSpeed
        this.speed += this.accel
        if (maxSpeed <= this.speed) this.speed = maxSpeed
      }
    } else {
      this.speed *= this.friction
    }
    const s = this.speed * this.sign
    vel.x = rot.z.x * s
    vel.y = rot.z.y * s
    vel.z = rot.z.z * s
    if (--this.freeze < 0) this.freeze = 0
  }

  /** RPTnkPlayerController::HandleFireInput */
  handleFireInput(muzzleDist: number, turret: Axes, pos: V3, player: number) {
    const it = this.tank.intent
    const t = this.tank
    this.fired = false
    this.laidMine = false
    if (it.mine) {
      if (!this.mineHeld && this.mineTimer === 0 && this.maxMines > this.w.minePool.mineNum[player]) {
        const at = v3(pos.x, 0, pos.z)
        this.w.layMine(0, t, at, at, player)
        this.w.emit({ t: 'rumble', player, frames: 16 })
        t.playLayMineSe()
        this.laidMine = true
        this.mineTimer = this.mineCooldown
        this.freeze = this.mineFreeze
      }
      this.mineHeld = true
    } else {
      if (it.fire) {
        const at = v3(muzzleDist * turret.z.x + pos.x, muzzleDist * turret.z.y + pos.y, muzzleDist * turret.z.z + pos.z)
        if (this.shellTimer === 0 && this.maxShells > this.w.shellPool.shellNum[player]) {
          const shell = this.w.fireShell(this.shellSpeed, t, at, vset(v3(), turret.z), player, this.shellBounces, 0, 0)
          this.w.emit({ t: 'rumble', player, frames: 6 })
          t.playFireSe(shell)
          this.fired = true
          this.shellTimer = this.fireCooldown
          this.freeze = this.fireFreeze
        } else {
          // not in the original (it plays nothing); kept for the existing audio/HUD code
          this.w.emit({ t: 'cantFire', tank: t })
        }
      }
      this.mineHeld = false
    }
    if (--this.shellTimer < 0) this.shellTimer = 0
    if (--this.mineTimer < 0) this.mineTimer = 0
  }

  getMaxSpeed() {
    return this.maxSpeed
  }
}

/** muzzle offset (re-export for callers that only need the number) */
export const MUZZLE = TANK.muzzle
