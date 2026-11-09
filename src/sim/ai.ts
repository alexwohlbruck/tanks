// Enemy AI: RPTnkAiProbe (RPTnkAi_3.cpp), RPTnkAiMove (RPTnkAi_2.cpp), RPTnkAiAttack
// (RPTnkAi_4.cpp) and RPTnkAiController (RPTnkAi.cpp). Randomness goes through the shared
// RPRandom exactly where the original advances RP_randSeedX/Y.

import { Actor } from './actor'
import { MINE, SHELL, ENEMY_SLOT0 } from './consts'
import { collideActor } from './field'
import { FIRST_ADDED_TYPE, paramsFor } from './stats'
import type { Tank } from './tank'
import {
  type Axes,
  type V3,
  EY,
  EZ,
  ZERO,
  accumulate,
  axesFromForward,
  cosDeg,
  cross,
  dot,
  mag,
  normalize,
  perpendicularDistance,
  selectMoreAligned,
  tanDeg,
  v3,
  vcopy,
  vset,
} from './vec'
import type { World } from './world'

export type ProbeResult = {
  /** the decomp's "mHitPos": actually the sweep direction */
  dir: V3
  /** sum of the hit wall normals, normalised */
  hitNormal: V3
  endPos: V3
  endVel: V3
  steps: number
  /** speed * steps (distance) */
  time: number
  /** 1 wall hit, 8 passed near a mine */
  flags: number
}

/** RPTnkAiProbe: an invisible actor swept along a line through the field collision. */
export class Probe extends Actor {
  startPos = v3()
  dir = vcopy(EZ)
  speed = 0
  radius = 1
  stepSize = 1
  maxSteps = 1
  /** 0 move test, 1 shot (reflect on the first wall, record the end position) */
  mode = 0
  stopFlags = 0
  step = 0
  hit = false
  hitPos = v3()
  hitOther = false

  constructor(private w: World) {
    super()
  }

  /** RPTnkAiProbe::Reset */
  override reset() {
    super.reset()
    vset(this.hitOffset, ZERO)
    vset(this.startPos, this.pos)
    vset(this.dir, EZ)
    this.speed = 0
    this.radius = 1
    this.stepSize = 1
    this.maxSteps = 1
  }

  setup(pos: V3, dir: V3, speed: number, radius: number, stepSize: number, maxSteps: number, mode: number, stopFlags: number) {
    vset(this.startPos, pos)
    vset(this.dir, dir)
    this.speed = speed
    this.radius = radius
    this.stepSize = stepSize
    this.maxSteps = maxSteps
    this.mode = mode
    this.stopFlags = stopFlags
  }

  /** RPTnkAiProbe::Step */
  private stepOnce(): boolean {
    let hit = false
    const d = this.speed * this.step
    this.pos.x = this.dir.x * d + this.startPos.x
    this.pos.y = this.dir.y * d + this.startPos.y
    this.pos.z = this.dir.z * d + this.startPos.z
    this.vel.x = this.dir.x * this.speed
    this.vel.y = this.dir.y * this.speed
    this.vel.z = this.dir.z * this.speed
    this.hitRadius = this.radius
    const mode = this.mode === 1 ? 1 : 0
    if (this.stopFlags & 1) hit = collideActor(this.w, this, mode) || hit
    if (this.stopFlags & 8) {
      if (this.w.minePool.isNearAnyMine(this)) this.hitOther = true
    }
    return hit
  }

  /** RPTnkAiProbe::Sweep */
  sweep(): ProbeResult {
    this.step = 0
    this.hit = false
    vset(this.hitPos, ZERO)
    this.hitOther = false
    if (this.mode === 0) {
      this.step = 1
      do {
        if (this.stepOnce()) break
        this.step += this.stepSize
      } while (this.step < this.maxSteps)
    } else if (this.mode === 1) {
      this.step = 1
      do {
        this.clearForces()
        if (this.stepOnce()) {
          this.integrate()
          break
        }
        this.step += this.stepSize
      } while (this.step < this.maxSteps)
    }
    const r: ProbeResult = {
      dir: vcopy(this.dir),
      hitNormal: vcopy(EZ),
      endPos: v3(),
      endVel: v3(),
      steps: this.step,
      time: this.speed * this.step,
      flags: 0,
    }
    if (this.hit) {
      vset(r.hitNormal, this.hitPos)
      r.flags |= 1
    }
    if (this.hitOther) r.flags |= 8
    if (this.mode === 1) {
      vset(r.endPos, this.pos)
      vset(r.endVel, this.vel)
    }
    return r
  }

  /** RPTnkAiProbe::OnHitWall: mode 1 reflects like a shell (RPTnkShell::OnHitWall) */
  override onHitWall(depth: number, n: V3) {
    this.hit = true
    if (this.mode === 1) {
      const d = dot(this.vel, n)
      const speed = mag(this.vel)
      if (d < 0) {
        const back = normalize(v3(-this.vel.x, 0, -this.vel.z))
        let dist = dot(back, n)
        if (dist !== 0) dist = depth / dist
        if (dist > speed) accumulate(this.posAccum[0], this.posAccum[1], depth, n)
        else accumulate(this.posAccum[0], this.posAccum[1], dist, back)
      } else accumulate(this.posAccum[0], this.posAccum[1], depth, n)
      const refl = -2 * dot(this.vel, n)
      if (refl > 0) accumulate(this.velAccum[0], this.velAccum[1], refl, n)
    }
    this.hitPos.x += n.x
    this.hitPos.y += n.y
    this.hitPos.z += n.z
    if (mag(this.hitPos) !== 0) normalize(this.hitPos)
  }
}

export type ShellThreat = { pos: V3; dir: V3; dist: number; perpDist: number; perpDir: V3 }
export type MineThreat = { pos: V3; dist: number; dir: V3 }

/** Nearest living player (RPTnkAi_2.cpp AiMoveGetTargetDir / RPTnkAi_4.cpp PickAimTarget).
 * 1P: always P1. 2P (original): P1 if P2 is dead, P2 if only P2 lives, else the nearer
 * (ties go to P1). Generalised to 4 players: the nearest living one, ties to the lower index,
 * P1 when nobody is alive. */
function targetPlayer(w: World, from: V3, alt: boolean): Tank {
  const p0 = w.playerTanks[0]
  if (w.players === 1) return p0
  let best: Tank | null = null
  let bestD = Infinity
  for (let i = 0; i < w.players; i++) {
    const p = w.playerTanks[i]
    if (p.lives === 0) continue
    // the move AI compares plain positions, the attack AI the shell hit centres (pos + (0,0,9))
    const c = alt ? p.hitCenterAlt() : p.pos
    const d = Math.hypot(from.x - c.x, from.z - c.z)
    if (d < bestD) {
      best = p
      bestD = d
    }
  }
  return best ?? p0
}

/** RPTnkAiMove: states 0 approach, 1 evade, 2 keep direction (after laying a mine). */
export class AiMove {
  // Params (LoadParams)
  accel = 0
  decel = 0
  speed = 0
  turnAngle = 0
  turnStep = 0
  maxAngle = 0
  targetWeight = 0
  timerMin = 0
  timerMax = 0
  probeSteps = 0
  shellRangeEnemy = 0
  shellRangePlayer = 0
  mineRadiusEnemy = 0
  mineRadiusPlayer = 0
  setFlag2 = 0
  historyNum = 0

  shellThreats: ShellThreat[] = []
  mineThreats: MineThreat[] = []
  /** unk16C: current speed */
  curSpeed = 0
  pos = v3()
  dirHistory: V3[] = Array.from({ length: 8 }, () => v3())
  dir = v3()
  side = v3()
  /** unk1F4: +1 forward, -1 reversing */
  sign = 1
  /** unk1F8: a state has run at least once */
  hasDir = false
  /** unk1F9: keep driving away from a freshly laid mine */
  keepDir = false
  timer = 0
  state = 0
  probe: Probe

  constructor(private tank: Tank, private w: World) {
    this.probe = new Probe(w)
  }

  get tankRef() {
    return this.tank
  }

  /** RPTnkAiMove::LoadParams */
  loadParams(type: number) {
    const p = paramsFor(type)
    this.accel = p.accel
    this.decel = p.decel
    this.speed = p.speed
    this.turnAngle = p.moveAngle
    this.turnStep = p.turnStep
    this.maxAngle = p.wanderAngle
    this.targetWeight = p.aggression
    this.timerMin = p.moveTimerMin
    this.timerMax = p.moveTimerMax
    this.probeSteps = p.probeSteps
    this.shellRangeEnemy = p.shellRangeEnemy
    this.shellRangePlayer = p.shellRangePlayer
    this.mineRadiusEnemy = p.mineAvoidEnemy
    this.mineRadiusPlayer = p.mineAvoidPlayer
    this.setFlag2 = p.noFireWhileEvading ? 1 : 0
    this.historyNum = p.historyNum
  }

  /** RPTnkAiMove::ResetMovement */
  resetMovement() {
    this.curSpeed = 0
    this.setDirection(EZ)
    this.sign = 1
    this.hasDir = false
    this.keepDir = false
    this.timer = 0
    this.state = 0
    this.probe.reset()
  }

  /** RPTnkAiMove::SetDirection */
  setDirection(d: V3) {
    this.fillHistory(d)
    vset(this.dir, d)
    normalize(this.dir)
    cross(EY, this.dir, this.side)
  }

  private fillHistory(d: V3) {
    const n = normalize(vcopy(d))
    for (const h of this.dirHistory) vset(h, n)
  }
  private pushHistory(d: V3) {
    const n = normalize(vcopy(d))
    for (let i = 7; i >= 1; i--) vset(this.dirHistory[i], this.dirHistory[i - 1])
    vset(this.dirHistory[0], n)
  }
  private averageHistory() {
    const sum = v3()
    let i = 0
    do {
      sum.x += this.dirHistory[i].x
      sum.y += this.dirHistory[i].y
      sum.z += this.dirHistory[i].z
      i++
    } while (i < this.historyNum)
    if (mag(sum) !== 0) vset(this.dir, normalize(sum))
    else vset(this.dir, this.dirHistory[0])
  }

  /** SetupProbe: radius 16, every second step, stop flags 9 (walls + mines) */
  private setupProbe(pos: V3, dir: V3, steps: number) {
    this.probe.setup(pos, dir, this.speed, 16, 2, steps, 0, 9)
  }

  /** RPTnkAiMove::RotateBodyStep */
  private rotateBodyStep(rot: Axes, d: V3) {
    const f = vcopy(rot.z)
    const k = this.turnStep
    const pos = normalize(v3(rot.x.x * k + f.x, rot.x.y * k + f.y, rot.x.z * k + f.z))
    const neg = normalize(v3(-(rot.x.x * k - f.x), -(rot.x.y * k - f.y), -(rot.x.z * k - f.z)))
    const sel = v3()
    selectMoreAligned(sel, d, neg, pos)
    selectMoreAligned(f, f, sel, d)
    normalize(f)
    axesFromForward(rot, f)
  }

  /** RPTnkAiMove::TurnTowardDirection */
  private turnTowardDirection(rot: Axes, d: V3) {
    const f = vcopy(rot.z)
    const back = v3(-f.x, -f.y, -f.z)
    if (!selectMoreAligned(v3(), d, f, back)) {
      this.rotateBodyStep(rot, d)
      this.sign = 1
    } else {
      const k = this.turnStep
      const pos = normalize(v3(rot.x.x * k + back.x, rot.x.y * k + back.y, rot.x.z * k + back.z))
      const neg = normalize(v3(-(rot.x.x * k - back.x), -(rot.x.y * k - back.y), -(rot.x.z * k - back.z)))
      const turn = v3()
      selectMoreAligned(turn, d, neg, pos)
      selectMoreAligned(back, back, turn, d)
      axesFromForward(rot, normalize(v3(-back.x, -back.y, -back.z)))
      this.sign = -1
    }
  }

  /** RPTnkAiMove::StateApproach */
  private stateApproach() {
    const maxA = this.maxAngle
    const minA = -maxA
    const d = vcopy(this.dirHistory[0])
    const t = targetPlayer(this.w, this.pos, false)
    const to = normalize(v3(t.pos.x - this.pos.x, 0, t.pos.z - this.pos.z))
    d.x += to.x * this.targetWeight
    d.z += to.z * this.targetWeight
    if (mag(d) !== 0) normalize(d)
    else vset(d, this.dirHistory[0])
    this.setupProbe(this.pos, d, this.probeSteps)
    const r = this.probe.sweep()
    if (r.flags & 1) {
      d.x += r.hitNormal.x
      d.y = 0
      d.z += r.hitNormal.z
      if (mag(d) === 0) vset(d, r.hitNormal)
      else normalize(d)
    }
    const tan = tanDeg(this.w.rng.range(minA, maxA))
    const p = normalize(v3(this.side.x * tan + d.x, this.side.y * tan + d.y, this.side.z * tan + d.z))
    this.pushHistory(p)
    this.averageHistory()
    this.hasDir = true
  }

  /** RPTnkAiMove::StateEvade */
  private stateEvade() {
    const wts = [1, 0.8, 0.6, 0.4]
    const d = v3()
    const n = this.shellThreats.length
    if (n > 0) {
      for (let i = 0; i < n; i++) {
        d.x += wts[i] * this.shellThreats[i].perpDir.x
        d.z += wts[i] * this.shellThreats[i].perpDir.z
      }
      for (let i = 0; i < n; i++) {
        const away = normalize(v3(this.pos.x - this.shellThreats[i].pos.x, 0, this.pos.z - this.shellThreats[i].pos.z))
        d.x += away.x * wts[i]
        d.z += away.z * wts[i]
      }
    }
    if (mag(d) !== 0) {
      normalize(d)
      this.pushHistory(d)
      this.pushHistory(d)
    }
    const m = this.mineThreats.length
    if (m > 0) {
      for (let i = 0; i < m; i++) {
        d.x += wts[i] * this.mineThreats[i].dir.x
        d.z += wts[i] * this.mineThreats[i].dir.z
      }
      if (mag(d) !== 0) {
        normalize(d)
        this.pushHistory(d)
        this.pushHistory(d)
      }
    }
    this.averageHistory()
    this.hasDir = true
  }

  /** RPTnkAiMove::StateKeepDirection */
  private stateKeepDirection() {
    this.averageHistory()
    this.hasDir = true
    if (this.mineThreats.length === 0) this.keepDir = false
    else if (!this.mineThreats.some((t) => t.dist < 16)) this.keepDir = false
  }

  /** RPTnkAiMove::CalcVelocity */
  private calcVelocity(rot: Axes, vel: V3) {
    if (this.tank.aiCtrl.flags & 1) {
      this.curSpeed = 0
    } else if (this.hasDir) {
      this.turnTowardDirection(rot, this.dir)
      const f = v3(rot.z.x * this.sign, rot.z.y * this.sign, rot.z.z * this.sign)
      if (dot(f, this.dir) < cosDeg(this.turnAngle)) this.curSpeed *= this.decel
      else this.curSpeed += this.accel
    } else {
      this.curSpeed *= this.decel
    }
    if (this.speed <= this.curSpeed) this.curSpeed = this.speed
    const s = this.curSpeed * this.sign
    vel.x = rot.z.x * s
    vel.y = rot.z.y * s
    vel.z = rot.z.z * s
  }

  /** RPTnkAiMove::Update */
  update(rot: Axes, vel: V3, pos: V3) {
    vset(this.pos, pos)
    this.timer--
    if (this.timer <= 0) {
      this.shellThreats = []
      this.w.shellPool.detectIncomingShells(this)
      this.mineThreats = []
      this.w.minePool.addTankAvoidance(this)
      const ctrl = this.tank.aiCtrl
      if (this.keepDir) {
        this.state = 2
        if (this.setFlag2 !== 0) ctrl.setFlags(2, true)
      } else if (this.shellThreats.length > 0 || this.mineThreats.length > 0) {
        this.state = 1
        if (this.setFlag2 !== 0) ctrl.setFlags(2, true)
      } else {
        this.state = 0
        ctrl.setFlags(2, false)
      }
      if (this.state === 0) this.stateApproach()
      else if (this.state === 1) this.stateEvade()
      else this.stateKeepDirection()
      normalize(this.dir)
      cross(EY, this.dir, this.side)
      this.timer = this.w.rng.timer(this.timerMin, this.timerMax)
    }
    this.calcVelocity(rot, vel)
  }

  /** RPTnkAiMove::FindClearDirection: forward, back, side, -side; the first fully clear wins */
  findClearDirection(dist: number, pos: V3): boolean {
    let cand = vcopy(this.dir)
    const probed = vcopy(this.dir)
    let best = 0
    const raw = (dist * 3) / this.speed
    const steps = Number.isFinite(raw) ? Math.trunc(raw) : 0
    const tryDir = (d: V3): 'clear' | 'blocked' => {
      this.setupProbe(pos, d, steps)
      const r = this.probe.sweep()
      if (r.flags === 0) {
        cand = vcopy(d)
        return 'clear'
      }
      if (r.flags === 1 && r.time > dist && r.time > best) {
        cand = vcopy(d)
        best = r.time
      }
      return 'blocked'
    }
    let found = tryDir(probed) === 'clear'
    if (!found) {
      probed.x = -this.dir.x
      probed.z = -this.dir.z
      found = tryDir(probed) === 'clear'
    }
    if (!found) {
      vset(probed, this.side)
      found = tryDir(probed) === 'clear'
    }
    if (!found) {
      probed.x = -this.side.x
      probed.z = -this.side.z
      found = tryDir(probed) === 'clear'
      if (!found && best < dist) return false
    }
    // ResetDirectionHistory
    this.fillHistory(cand)
    this.averageHistory()
    return true
  }

  /** RPTnkAiMove::AddShellThreat: insertion into a 4-entry list sorted by distance */
  addShellThreat(t: ShellThreat) {
    insertSorted(this.shellThreats, t)
  }
  addMineThreat(t: MineThreat) {
    insertSorted(this.mineThreats, t)
  }
}

function insertSorted<T extends { dist: number }>(list: T[], t: T) {
  for (let i = 0; i < list.length; i++) {
    if (list[i].dist > t.dist) {
      list.splice(i, 0, t)
      if (list.length > 4) list.length = 4
      return
    }
  }
  if (list.length < 4) list.push(t)
}

type Segment = { pos: V3; dir: V3; startStep: number; endStep: number }

/** RPTnkAiAttack: aiming, firing and mine laying. */
export class AiAttack {
  probe: Probe
  /** unk8: k36 fire cooldown */
  fireCooldown = 0
  maxShells = 0
  shellBounces = 0
  shellSpeed = 0
  // Params
  fireFreeze = 0
  aimAngle = 0
  aimStep = 0
  aimTime = 0
  fireIntervalMin = 0
  fireIntervalMax = 0
  selfAngle = 0
  playerAngle = 0
  allyAngle = 0
  allyDist = 0
  mineCooldown = 0
  mineMax = 0
  mineFreeze = 0
  mineClearDist = 0
  mineEnemyDist = 0
  mineIntervalMin = 0
  mineIntervalMax = 0
  mineChance = 0
  mineChanceNearBlock = 0

  pos = v3()
  /** unk70: frames until the next shot is allowed */
  fireTimer = 0
  /** unk74: frames until the next mine is allowed */
  mineTimer = 0
  /** unk78: movement freeze (controller flag 1 while > 0) */
  freeze = 0
  type = 0
  aimTarget = vcopy(EZ)
  aimDir = vcopy(EZ)
  aimSide = v3()
  segments: Segment[] = [0, 1, 2].map(() => ({ pos: v3(), dir: v3(), startStep: 0, endStep: 0 }))
  segmentNum = 0
  fire = false
  aimTimer = 0
  fireInterval = 0
  layMine = false
  mineInterval = 0

  constructor(private tank: Tank, private w: World) {
    this.probe = new Probe(w)
  }

  /** RPTnkAiAttack::LoadParams */
  loadParams(type: number) {
    this.type = type
    const p = paramsFor(type)
    this.fireCooldown = p.fireCooldown
    this.maxShells = p.maxShells
    this.shellBounces = p.ricochets
    this.shellSpeed = p.shellSpeed
    this.fireFreeze = p.fireFreeze
    this.aimAngle = p.aimAngle
    this.aimStep = p.aimStep
    this.aimTime = p.aimTime
    this.fireIntervalMin = p.fireIntervalMin
    this.fireIntervalMax = p.fireIntervalMax
    this.selfAngle = p.selfAngle
    this.playerAngle = p.playerAngle
    this.allyAngle = p.allyAngle
    this.allyDist = p.allyDist
    this.mineCooldown = p.mineCooldown
    this.mineMax = p.maxMines
    this.mineFreeze = p.mineFreeze
    this.mineClearDist = p.mineClearDist
    this.mineEnemyDist = p.mineEnemyDist
    this.mineIntervalMin = p.mineIntervalMin
    this.mineIntervalMax = p.mineIntervalMax
    this.mineChance = p.mineChance
    this.mineChanceNearBlock = p.mineChanceNearBlock
  }

  /** RPTnkAiAttack::ResetAttack (two RNG draws) */
  resetAttack() {
    vset(this.aimTarget, EZ)
    vset(this.aimDir, EZ)
    cross(EY, this.aimDir, this.aimSide)
    this.fire = false
    this.layMine = false
    this.fireTimer = 0
    this.mineTimer = 0
    this.freeze = 0
    this.aimTimer = 0
    this.fireInterval = this.w.rng.timer(this.fireIntervalMin, this.fireIntervalMax)
    this.mineInterval = this.w.rng.timer(this.mineIntervalMin, this.mineIntervalMax)
    this.probe.reset()
  }

  /** RPTnkAiAttack::SetAimDirection */
  setAimDirection(d: V3) {
    vset(this.aimTarget, d)
    vset(this.aimDir, d)
    normalize(this.aimDir)
    cross(EY, this.aimDir, this.aimSide)
  }

  /** Shot probe: radius 6, 1 unit steps, 250 steps, reflect mode, walls only */
  private setupShotProbe(pos: V3, dir: V3) {
    this.probe.setup(pos, dir, this.shellSpeed, SHELL.radius, 1, 250, 1, 1)
  }

  /** RPTnkAiAttack::PredictShotPath: up to bounces + 1 straight segments */
  private predictShotPath(muzzleDist: number) {
    const start = v3(muzzleDist * this.aimDir.x + this.pos.x, this.pos.y, muzzleDist * this.aimDir.z + this.pos.z)
    this.segmentNum = this.shellBounces + 1
    const [s0, s1, s2] = this.segments
    setSeg(s0, start, this.aimDir, 0)
    if (this.w.blocks.isPointInsideBlock(start)) return
    this.setupShotProbe(start, this.aimDir)
    const first = this.probe.sweep()
    if (first.flags & 1 && first.steps > 6) {
      const steps = first.steps
      s0.endStep = steps
      setSeg(s1, first.endPos, first.endVel, steps)
      normalize(s1.dir)
      if (this.segmentNum >= 2) {
        this.setupShotProbe(s1.pos, s1.dir)
        const second = this.probe.sweep()
        if (second.flags & 1) {
          s1.endStep = second.steps + s1.startStep
          setSeg(s2, second.endPos, second.endVel, s1.endStep)
          normalize(s2.dir)
          if (this.segmentNum === 3) {
            this.setupShotProbe(s2.pos, s2.dir)
            const third = this.probe.sweep()
            if (third.flags & 1) s2.endStep = third.steps + s2.startStep
          }
        } else {
          this.segmentNum = 2
        }
      }
    } else {
      this.segmentNum = 1
    }
  }

  private segLength(s: Segment) {
    return (s.endStep - s.startStep) * this.shellSpeed
  }

  /** RPTnkAiAttack::PathHitsSelf: the bounced segments only */
  private pathHitsSelf(): boolean {
    if (this.segmentNum <= 1) return false
    const cosine = cosDeg(this.selfAngle)
    const c = this.tank.hitCenterAlt()
    for (let i = 1; i < this.segmentNum; i++) {
      const s = this.segments[i]
      const origin = v3(s.pos.x, 0, s.pos.z)
      const len = this.segLength(s)
      const delta = v3(c.x - origin.x, c.y - origin.y, c.z - origin.z)
      if (!(mag(delta) > len)) {
        if (perpendicularDistance(c, origin, s.dir) < 22) {
          const along = dot(delta, s.dir)
          if (0 <= along && len >= along) return true
        }
        normalize(delta)
        if (dot(delta, s.dir) > cosine) return true
      }
    }
    return false
  }

  /** RPTnkAiAttack::PathHitsPlayer: some segment points at a living player within its length */
  private pathHitsPlayer(): boolean {
    const cosine = cosDeg(this.playerAngle)
    const test = (p: Tank) => {
      const c = p.hitCenterAlt()
      for (let i = 0; i < this.segmentNum; i++) {
        const s = this.segments[i]
        const len = this.segLength(s)
        const delta = v3(c.x - s.pos.x, 0, c.z - s.pos.z)
        if (!(mag(delta) > len)) {
          normalize(delta)
          if (dot(delta, s.dir) > cosine) return true
        }
      }
      return false
    }
    for (let i = 0; i < this.w.players; i++) {
      const p = this.w.playerTanks[i]
      if (p.lives && test(p)) return true
    }
    return false
  }

  /** RPTnkAiAttack::PathHitsAlly: every other active enemy tank */
  private pathHitsAlly(): boolean {
    const cosine = cosDeg(this.allyAngle)
    for (const t of this.w.enemyTanks) {
      if (t === this.tank || t.age < 0) continue
      const c = t.hitCenterAlt()
      if (Math.hypot(c.x - this.pos.x, c.z - this.pos.z) < this.allyDist) return true
      for (let i = 0; i < this.segmentNum; i++) {
        const s = this.segments[i]
        const origin = v3(s.pos.x, 0, s.pos.z)
        const len = this.segLength(s)
        const delta = v3(c.x - origin.x, 0, c.z - origin.z)
        if (!(mag(delta) > len)) {
          if (perpendicularDistance(c, origin, s.dir) < 22) {
            const along = dot(delta, s.dir)
            if (0 <= along && len >= along) return true
          }
          normalize(delta)
          if (dot(delta, s.dir) > cosine) return true
        }
      }
    }
    return false
  }

  /** RPTnkAiAttack::PickAimTarget: nearest player rotated by a random +-aimAngle about Y */
  private pickAimTarget() {
    const p = targetPlayer(this.w, this.pos, true)
    const target = p.hitCenterAlt()
    const d = normalize(v3(target.x - this.pos.x, 0, target.z - this.pos.z))
    const angle = this.w.rng.range(-this.aimAngle, this.aimAngle)
    // MTX34RotXYZFIdx(0, angle, 0) * d
    const a = (angle * Math.PI) / 180
    const c = Math.cos(a)
    const s = Math.sin(a)
    this.aimTarget = normalize(v3(c * d.x + s * d.z, d.y, -s * d.x + c * d.z))
  }

  /** RPTnkAiAttack::DecideFire */
  private decideFire(muzzleDist: number) {
    this.fire = false
    const slot = this.tank.index + ENEMY_SLOT0
    if (this.w.shellPool.shellNum[slot] < this.maxShells) {
      this.predictShotPath(muzzleDist)
      if (this.segments[0].endStep > 6 && !this.pathHitsSelf() && !this.pathHitsAlly() && this.pathHitsPlayer()) this.fire = true
    }
  }

  /** RPTnkAiAttack::DecideLayMine */
  private decideLayMine() {
    this.layMine = false
    const slot = this.tank.index + ENEMY_SLOT0
    if (this.w.minePool.mineNum[slot] < this.mineMax) {
      const distance = this.w.nearestEnemyDistance(this.tank)
      if (distance <= this.mineEnemyDist) return
      const nearby = this.w.blocks.isKind0BlockNear(MINE.proximity, this.pos)
      let lay = false
      const chance = this.w.rng.range(0, 100)
      if (nearby && chance < this.mineChanceNearBlock) lay = true
      else if (!nearby && chance < this.mineChance) lay = true
      if (lay) {
        if (this.tank.aiCtrl.move.findClearDirection(this.mineClearDist, vcopy(this.pos))) this.layMine = true
      }
    }
  }

  /** RPTnkAiAttack::ExecuteActions: turret follows aimDir; a mine wins over a shot */
  private executeActions(muzzleDist: number, turret: Axes) {
    const d = v3(this.aimDir.x, 0, this.aimDir.z)
    const m = mag(d)
    if (m !== 0) axesFromForward(turret, v3(d.x / m, d.y / m, d.z / m))
    const t = this.tank
    if (this.layMine) {
      const at = v3(this.pos.x, 0, this.pos.z)
      const slot = t.index + ENEMY_SLOT0
      this.w.layMine(0, t, at, at, slot)
      t.playLayMineSe()
      this.mineTimer = this.mineCooldown
      this.freeze = this.mineFreeze
      this.fire = false
      this.fireInterval = this.w.rng.timer(this.fireIntervalMin, this.fireIntervalMax)
      t.aiCtrl.move.keepDir = true
    }
    // [tanks+] an added type's behaviour may take the shot over (sniper charge-up); never 1-9
    if (this.fire && this.type >= FIRST_ADDED_TYPE && this.w.plus && this.w.plus.interceptFire(t)) this.fire = false
    if (this.fire) {
      const muzzle = v3(muzzleDist * turret.z.x + this.pos.x, muzzleDist * turret.z.y + this.pos.y, muzzleDist * turret.z.z + this.pos.z)
      const slot = t.index + ENEMY_SLOT0
      // [tanks+] added types borrow an original type's shell look (smoke trail, sounds)
      const look = this.type < FIRST_ADDED_TYPE ? this.type : this.w.plus ? this.w.plus.shellLook(this.type) : 2
      let smoke = 0
      if (look === 3) smoke = 1
      else if (look === 7) smoke = 2
      else if (look === 9) smoke = 1
      const shell = this.w.fireShell(this.shellSpeed, t, muzzle, vcopy(turret.z), slot, this.shellBounces, smoke, look)
      t.playFireSe(shell)
      this.fireTimer = this.fireCooldown
      this.freeze = this.fireFreeze
    }
    if (--this.fireTimer < 0) this.fireTimer = 0
    if (--this.mineTimer < 0) this.mineTimer = 0
    if (this.freeze > 0) {
      t.aiCtrl.setFlags(1, true)
      this.freeze--
    } else t.aiCtrl.setFlags(1, false)
  }

  /** RPTnkAiAttack::Update */
  update(muzzleDist: number, turret: Axes, pos: V3) {
    vset(this.pos, pos)
    this.fire = false
    this.layMine = false
    if (--this.aimTimer <= 0) {
      this.pickAimTarget()
      this.aimTimer = this.aimTime
    }
    // turn the aim one step toward the target
    const k = this.aimStep
    const plus = normalize(v3(this.aimSide.x * k + this.aimDir.x, this.aimSide.y * k + this.aimDir.y, this.aimSide.z * k + this.aimDir.z))
    const minus = normalize(v3(this.aimDir.x - this.aimSide.x * k, this.aimDir.y - this.aimSide.y * k, this.aimDir.z - this.aimSide.z * k))
    const sel = v3()
    selectMoreAligned(sel, this.aimTarget, minus, plus)
    selectMoreAligned(this.aimDir, this.aimDir, sel, this.aimTarget)
    normalize(this.aimDir)
    cross(EY, this.aimDir, this.aimSide)
    if (!(this.tank.aiCtrl.flags & 2)) {
      if (--this.fireInterval <= 0) {
        if (this.fireTimer === 0) this.decideFire(muzzleDist)
        this.fireInterval = this.w.rng.timer(this.fireIntervalMin, this.fireIntervalMax)
      }
      if (--this.mineInterval <= 0) {
        if (this.mineTimer === 0) this.decideLayMine()
        this.mineInterval = this.w.rng.timer(this.mineIntervalMin, this.mineIntervalMax)
      }
    }
    this.executeActions(muzzleDist, turret)
  }
}

function setSeg(s: Segment, pos: V3, dir: V3, step: number) {
  vset(s.pos, pos)
  vset(s.dir, dir)
  s.startStep = step
  s.endStep = step
}

/** RPTnkAiController: flags bit 0 = movement frozen (after a shot/mine), bit 1 = evading */
export class AiController {
  attack: AiAttack
  move: AiMove
  mode = 0
  flags = 0

  constructor(tank: Tank, w: World) {
    this.attack = new AiAttack(tank, w)
    this.move = new AiMove(tank, w)
  }

  /** RPTnkAiController::Reset (type 0 parameters) */
  reset() {
    this.mode = 0
    this.attack.loadParams(0)
    this.attack.resetAttack()
    this.move.loadParams(0)
    this.move.resetMovement()
    this.flags = 0
  }

  /** RPTnkAiController::SetMode (note: flags are not cleared) */
  setMode(mode: number) {
    this.mode = mode
    this.attack.loadParams(mode)
    this.attack.resetAttack()
    this.move.loadParams(mode)
    this.move.resetMovement()
  }

  setFlags(f: number, set: boolean) {
    if (set) this.flags |= f
    else this.flags &= ~f
  }
}
