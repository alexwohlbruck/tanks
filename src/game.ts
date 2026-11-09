// Game flow: port of RPTnkGameManager (RPTnkGameManager.cpp), RPTnkGameStats
// (RPTnkGameManager_2.cpp), RPTnkExGuide (RPTnkExGuide.cpp), the stage selection of
// RPTnkGameManager::PickStageVariant + RPTnkStageMap::LoadStage/ReloadStage, and the per-frame
// order of RPTnkScene::Calculate / UpdateGameplay.
//
// Phases are the original manager states (mState):
//   0 'title'     StateIdle            (before newGame / after quitting)
//   1 'intro'     StateWaitLifeNo      first mission: the fade card ("Mission N", lives)
//   2 'start'     StateStageStart      165 frames with the tanks shown but idle, then "Start!"
//   3 'countdown' StateCountdown       (never entered)
//   4 'play'      StatePlay
//   5 'dead'      StateMissWait        a life was lost; 120 frames, then the fade
//   6 'cleared'   StateStageClearWait  "Mission cleared!" until the clear message is done
//   7 'next'      StateNextStage       the fade card between missions (stage (re)loaded behind it)
//   8 'complete'  StateCompleteWait    last mission cleared ("Mission complete!")
//   9 'gameover'  StateFailedWait      no lives left ("Mission failed!")
//  10 'results'   StateResultWait      result list
//  11 'medal'     StateResultMenu      1P medal / 2P winner screen
//  12 'menu'      StateEndMenu         Try again / Quit
//
// HUD data: lives / livesOf(p), missionIndex (stage, 0-based), lastStage, enemiesLeft(),
// stats.kills[p], killsByPlayer[p][type], kills[type], typeOrder (types in first-seen
// order), winner(), freeze, state, cursorMode(p, farOrClamped).

import { loadGameData, mapKey, normalizeData, type Aspect, type GameData, type MissionSetup } from './data'
import type { PadState } from './input'
import { type AudioSink, BgmMix } from './sim/bgm'
import { CAMERA, C, TANK as TANKC } from './sim/consts'

/** stats arrays are indexed by enemy type (1-9 original, 10+ added types) */
const TYPE_SLOTS = 32
import { HeadlessPresenter, type Presenter } from './sim/presenter'
import { RPRandom } from './sim/rng'
import { setTankRecords } from './sim/stats'
import type { Tank } from './sim/tank'
import type { V3 } from './sim/vec'
import { World, type SimEvent } from './sim/world'

export type Phase = 'title' | 'intro' | 'start' | 'countdown' | 'play' | 'dead' | 'cleared' | 'next' | 'complete' | 'gameover' | 'results' | 'medal' | 'menu'

export const PHASES: Phase[] = ['title', 'intro', 'start', 'countdown', 'play', 'dead', 'cleared', 'next', 'complete', 'gameover', 'results', 'medal', 'menu']

/** RPTnkGameManager::STAGE_NUM */
export const STAGE_NUM = 100

/** RPTnkGameManager frame timers */
export const FLOW = {
  /** StateWaitLifeNo / StateNextStage -> StateStageStart */
  stageStart: 165,
  /** StatePlay -> StateMissWait */
  missWait: 120,
  /** mission 20 is the last one unless the gold medal has been won (RPCommon saved medal >= 3) */
  lastStageNoGold: 19,
}

/** kept for older callers */
export function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type Listener = {
  onWorld(w: World): void
  onEvents(ev: SimEvent[], w: World): void
  onPhase(p: Phase, g: Game): void
}

/** RPTnkGameStats */
export class GameStats {
  players = 2
  kills = [0, 0, 0, 0]
  /** [player][enemy type] */
  killsByType = [0, 1, 2, 3].map(() => new Array(TYPE_SLOTS).fill(0))
  typeSeen = new Array(TYPE_SLOTS).fill(false)
  /** enemy types in order of first appearance (AddKilledType at spawn) */
  typeOrder: number[] = []
  lives = [1, 1, 1, 1]

  /** RPTnkGameStats::Setup */
  setup(players: number) {
    this.players = players
    this.clearCounts()
    this.lives = [1, 1, 1, 1]
  }
  /** RPTnkGameStats::ClearCounts */
  clearCounts() {
    this.kills = [0, 0, 0, 0]
    this.killsByType = [0, 1, 2, 3].map(() => new Array(TYPE_SLOTS).fill(0))
    this.typeSeen = new Array(TYPE_SLOTS).fill(false)
    this.typeOrder = []
  }
  setAllLives(n: number) {
    for (let i = 0; i < this.players; i++) this.lives[i] = n
  }
  addKill(player: number, type: number, n = 1) {
    this.kills[player] += n
    this.killsByType[player][type] += n
  }
  /** RPTnkGameStats::AddLives: clamped to 0..99; true when none are left */
  addLives(player: number, n: number) {
    this.lives[player] = Math.min(99, Math.max(0, this.lives[player] + n))
    return this.lives[player] <= 0
  }
  addKilledType(type: number) {
    if (this.typeSeen[type]) return
    this.typeSeen[type] = true
    this.typeOrder.push(type)
  }
  /** RPTnkGameStats::GetWinner: the player with the most kills, -1 on a draw */
  winner(): number {
    let best = -1
    let bestK = -1
    let tie = false
    for (let i = 0; i < this.players; i++) {
      if (this.kills[i] > bestK) {
        best = i
        bestK = this.kills[i]
        tie = false
      } else if (this.kills[i] === bestK) tie = true
    }
    return tie ? -1 : best
  }
}

/** RPTnkCamera::ProjectToScreen for the fixed camera: layout units (x right, y up, origin centre) */
export function projectToScreen(p: { x: number; y: number; z: number }) {
  const e = CAMERA.eye
  const u = CAMERA.up
  const x = p.x - e.x
  const y = p.y - e.y
  const z = p.z - e.z
  return { x: x / CAMERA.screenScale, y: (y * u.y + z * u.z) / CAMERA.screenScale }
}

/**
 * RPTnkCursor::CalcWorldPos: a screen point (layout units, x right / y up, origin at the
 * centre; RPTnkCursor::mScreenPos) cast along the camera direction onto the plane y = 17.6
 * (the turret height). Returns the cursor's world position.
 */
export function screenToField(sx: number, sy: number): { x: number; y: number; z: number } {
  const s = CAMERA.screenScale
  const e = CAMERA.eye
  const t = CAMERA.target
  // dir = normalize(target - eye); side (negated) = +x; up = side x dir
  const dl = Math.hypot(t.x - e.x, t.y - e.y, t.z - e.z)
  const dir = { x: (t.x - e.x) / dl, y: (t.y - e.y) / dl, z: (t.z - e.z) / dl }
  const up = { x: 0, y: -dir.z, z: dir.y } // (1,0,0) x dir
  const o = { x: sx * s + e.x, y: sy * s * up.y + e.y, z: sy * s * up.z + e.z }
  const h = TANKC.bodyHeight
  const k = (h - o.y) / dir.y
  return { x: o.x + dir.x * k, y: h, z: o.z + dir.z * k }
}

/**
 * RPTnkCursor::UpdatePointerPos + UpdateScreenPosAndMode: Wii pointer (x right, y down, both
 * in units of the half screen width, clamped to the TV-safe box) -> layout screen position,
 * limited to 480 units from the tank while it lives.
 */
export function pointerToScreen(px: number, py: number, aspect: Aspect, tank: Tank | null) {
  const half = CAMERA.screen[aspect].w * 0.5
  const box = aspect === '16_9' ? { x: 0.82, y0: -0.44, y1: 0.41 } : { x: 0.82, y0: -0.61, y1: 0.56 }
  const x = Math.min(box.x, Math.max(-box.x, px))
  const y = Math.min(box.y1, Math.max(box.y0, py))
  const clamped = Math.abs(x) === box.x || y === box.y0 || y === box.y1
  let sx = x * half
  let sy = -y * half
  let far = false
  if (tank && tank.lives) {
    const tp = projectToScreen({ x: tank.pos.x, y: tank.pos.y + TANKC.bodyHeight, z: tank.pos.z })
    const dx = sx - tp.x
    const dy = sy - tp.y
    const d = Math.hypot(dx, dy)
    if (d > 480) {
      sx = (dx / d) * 480 + tp.x
      sy = (dy / d) * 480 + tp.y
    }
    far = d >= 480
  }
  return { x: sx, y: sy, clamped, far }
}

/** RPTnkExGuide: mission 1 control hints */
class ExGuide {
  startPos = [{ x: 0, z: 0 }, { x: 0, z: 0 }]
  screenPos = { x: 0, y: 0 }
  done = false
  state = 0
  moved = [0, 0]
  idle = 0
  target: Tank | null = null

  reset() {
    this.startPos = [{ x: 0, z: 0 }, { x: 0, z: 0 }]
    this.screenPos = { x: 0, y: 0 }
    this.done = false
    this.state = 0
    this.moved = [0, 0]
    this.idle = 0
  }

  start(w: World) {
    const p = w.playerTanks
    this.startPos[0] = { x: p[0].pos.x, z: p[0].pos.z }
    if (w.players >= 2) this.startPos[1] = { x: p[1].pos.x, z: p[1].pos.z }
    this.done = false
    this.state = 0
    this.moved = [0, 0]
    this.idle = 0
  }

  private show(pr: Presenter) {
    pr.exMsgShow([0, 0, 1, 2][this.state])
  }

  calculate(w: World, pr: Presenter) {
    const p = w.playerTanks
    if (!this.done) {
      const xs = [-1000, -1000]
      for (let i = 0; i < 2; i++) if (p[i].lives) xs[i] = p[i].pos.x
      const near = () => {
        let n = false
        for (let i = 0; i < 2; i++) {
          if (!p[i].lives || xs[i] < 10) continue
          const c = projectToScreen({ x: p[i].intent.aimX, y: TANKC.bodyHeight, z: p[i].intent.aimZ })
          if (30 > Math.hypot(c.x - this.screenPos.x, c.y - this.screenPos.y)) n = true
        }
        return n
      }
      switch (this.state) {
        case 0: {
          const moving = [false, false]
          for (let i = 0; i < 2; i++) {
            if (!p[i].lives) continue
            if (p[i].speed > 0.1) {
              moving[i] = true
              this.moved[i] = Math.hypot(p[i].pos.x - this.startPos[i].x, p[i].pos.z - this.startPos[i].z)
            }
          }
          if (this.moved[0] > 40 || this.moved[1] > 40) this.state = 1
          else if (moving[0] || moving[1]) this.idle = 0
          else if (++this.idle > 0) this.show(pr)
          break
        }
        case 1:
          if (xs[0] >= 10 || xs[1] >= 10) this.state = 2
          this.show(pr)
          break
        case 2:
          if (xs[0] < 10 && xs[1] < 10) {
            this.state = 1
            break
          }
          this.show(pr)
          if (near()) this.state = 3
          break
        case 3:
          if (xs[0] < 10 && xs[1] < 10) {
            this.state = 1
            break
          }
          if (!near()) this.state = 2
          else this.show(pr)
          break
      }
    }
    if (this.target) {
      const t = this.target
      this.screenPos = projectToScreen({ x: t.pos.x, y: t.pos.y + 11 * t.scale.y, z: t.pos.z })
    }
  }
}

export type GameOptions = {
  /** RPCommon saved medal >= 3 (gold): play all 100 missions instead of stopping after 20 */
  goldMedal: boolean
  /** fixed RNG seed (default: random, like OSGetTick) */
  seed?: number
  /** debug: losing a life never happens (the mission still restarts after a death) */
  infiniteLives?: boolean
  /** debug: all 100 missions are playable in 1P and 2P (no mission-20 stop) */
  unlockAll?: boolean
}

export class Game {
  data!: GameData
  world: World | null = null
  mission: MissionSetup | null = null
  /** RPTnkGameManager::mState */
  state = 0
  phaseTime = 0
  paused = false
  /** 1-4 (the original: 1 or 2; 3-4 follow the 2P rules) */
  players = 1
  aspect: Aspect = '16_9'
  options: GameOptions = { goldMedal: false }
  rng = new RPRandom((Math.random() * 2 ** 32) >>> 0)
  stats = new GameStats()
  presenter: Presenter = new HeadlessPresenter()
  audio: AudioSink | null = null
  listener: Listener | null = null

  // RPTnkGameManager members
  /** mStage (0-based mission) */
  stage = 0
  lastStage = 0
  /** unk10 / unk14: current and previous map stage file */
  variant = 0
  prevVariant = -1
  timer = 0
  retryCount = 0
  freeze = false
  stageReady = false
  retry = false
  quit = false
  /** unk30: 1 = next mission, 3 = retry after a miss, 4 = failed */
  nextAction = 0
  /** RPTnkStageMap::mSwapPlayers */
  swapPlayers = false
  /** RPTnkScene::mStepCount */
  stepCount = 0

  private bgm = new BgmMix({
    bgm: (name) => this.emitAudio({ t: 'bgm', name }),
    bgmStop: (fade) => this.emitAudio({ t: 'bgmStop', fade }),
    mask: (mask) => this.emitAudio({ t: 'bgmMask', mask }),
  })
  private exGuide = new ExGuide()
  private pending: SimEvent[] = []

  async load() {
    this.setData(await loadGameData())
  }

  /** for headless use: data already parsed from params.json / maps.json */
  setData(d: GameData | { params: any; maps: any }) {
    this.data = normalizeData(d as any)
    setTankRecords(this.data.params.tanks)
  }

  get phase(): Phase {
    return PHASES[this.state]
  }

  /** 0-based mission index (mStage) */
  get missionIndex() {
    return this.stage
  }

  /** P1 lives (the fade card's "x N") */
  get lives() {
    return this.stats.lives[0]
  }
  livesOf(p: number) {
    return this.stats.lives[p]
  }

  /** destroyed tanks by type, both players */
  get kills(): number[] {
    return this.stats.killsByType[0].map((n, i) => n + this.stats.killsByType[1][i])
  }
  get killsByPlayer(): number[][] {
    return this.stats.killsByType
  }
  get typeOrder() {
    return this.stats.typeOrder
  }
  totalKills() {
    return this.stats.kills[0] + this.stats.kills[1]
  }
  winner() {
    return this.stats.winner()
  }
  enemiesLeft() {
    return this.world?.enemyAliveNum ?? 0
  }

  setPhase(p: Phase) {
    const s = PHASES.indexOf(p)
    this.setState(s < 0 ? 0 : s)
  }

  private setState(s: number) {
    if (s === this.state) return
    this.state = s
    this.phaseTime = 0
    this.listener?.onPhase(this.phase, this)
  }

  /** layout SEs (presenter) and system SEs */
  se(name: string) {
    this.emitAudio({ t: 'se', name })
  }

  private emitAudio(e: SimEvent) {
    if (this.world) this.world.events.push(e)
    else this.pending.push(e)
  }

  // ---- RPTnkScene::Reset + RPTnkGameManager::ResetForMode / Start --------------------------

  newGame(players: number, startMission = 0, seed = this.options.seed) {
    this.players = players
    // RP_seedRandomTicks
    this.rng.seed(seed ?? (Math.random() * 2 ** 32) >>> 0)
    // RPTnkGameManager::ResetForMode
    this.stage = 0
    this.lastStage = 0
    this.prevVariant = -1
    this.variant = 0
    this.timer = 0
    this.freeze = false
    this.stageReady = false
    this.retry = false
    this.quit = false
    this.nextAction = 0
    this.stats.setup(2)
    this.exGuide.reset()
    this.bgm.stop()
    this.state = 0
    // RPTnkField / TankManager / WeaponManager / LayoutManager Reset
    this.world = new World(players, { aspect: this.aspect, rng: this.rng })
    for (const e of this.pending) this.world.events.push(e)
    this.pending = []
    this.world.hooks = {
      addKill: (p, type, pos) => {
        this.stats.addKill(p, type, 1)
        this.presenter.hudScore(p)
        this.presenter.hitPopup(pos, p)
      },
      enemySpawned: (type, tank) => {
        if (this.stage === 0) this.exGuide.target = tank
        this.stats.addKilledType(type)
      },
      enemyDestroyed: (slot) => {
        if (this.mission) this.mission.active[slot] = false
      },
    }
    // RPTnkCursorManager::Reset: P1's cursor starts at pointer (-0.4, 0.15), P2's at (0.4, 0.15)
    for (const t of this.world.playerTanks) {
      const sp = pointerToScreen(t.index === 0 ? -0.4 : 0.4, 0.15, this.aspect, null)
      const at = screenToField(sp.x, sp.y)
      t.intent.aimX = at.x
      t.intent.aimZ = at.z
    }
    ;(this.presenter as { reset?: () => void }).reset?.()
    this.stepCount = 0
    // RPTnkGameManager::Start -> SetupFirstStage
    this.setupFirstStage(startMission)
  }

  /** RPTnkGameManager::SetupFirstStage (startMission is a debug addition) */
  private setupFirstStage(startMission: number) {
    this.stats.clearCounts()
    this.stats.setAllLives(this.data.params.header || C.startLives)
    this.nextAction = 0
    this.freeze = false
    this.stageReady = false
    this.stage = Math.max(0, Math.min(STAGE_NUM - 1, startMission))
    if (this.players === 1) {
      this.lastStage = this.options.goldMedal || this.options.unlockAll ? STAGE_NUM - 1 : FLOW.lastStageNoGold
      this.pickStageVariant(this.stage)
      this.loadStage(this.stage, this.variant, false)
    } else {
      this.lastStage = this.options.unlockAll ? STAGE_NUM - 1 : FLOW.lastStageNoGold
      this.pickStageVariant(this.stage)
      this.loadStage(this.stage, this.variant, true)
      this.stats.setAllLives(1)
    }
    this.presenter.fadeStart(false, true)
    this.timer = 0
    this.setState(1)
  }

  /** RPTnkGameManager::PickStageVariant: random map in [first, last], never the previous one */
  private pickStageVariant(stage: number) {
    const m = this.data.params.missions[stage]
    const [first, last] = this.players === 1 ? m.map1P : m.map2P
    if (first === last) this.variant = first
    else {
      const n = last - first + 1
      do this.variant = (this.rng.next() % n) + first
      while (this.prevVariant === this.variant)
    }
    this.prevVariant = this.variant
  }

  /** RPTnkStageMap::ChooseEnemyType: `ab` = random type in a..b (u32 modulo) */
  private chooseEnemyType(v: number) {
    if (v < 10) return v
    const lo = Math.trunc(v / 10)
    const hi = v % 10
    return lo + (this.rng.next() % (hi - (lo - 1)))
  }

  /** RPTnkStageMap::LoadStage(stage, mapStage, TRUE, twoPlayers) */
  private loadStage(stage: number, variant: number, two: boolean) {
    const w = this.world!
    const m = this.data.params.missions[stage]
    const key = mapKey(this.players === 1 ? 1 : 2, variant, this.aspect)
    const map = this.data.maps[key]
    if (!map) throw new Error(`missing map ${key}`)
    // the original swaps P1/P2 at random in 2P (the draw is kept for 3-4 players, the swap is not)
    this.swapPlayers = two ? ((this.rng.next() >>> 4) & 1) === 1 && this.players === 2 : false
    const raw = two ? m.slots2P : m.slots1P
    const types = w.loadStage(map, raw, { swap: this.swapPlayers, chooseType: (v) => this.chooseEnemyType(v) })
    this.mission = {
      index: stage,
      bonus: (this.players === 1 ? m.bonus : m.bonus2P) > 0,
      variant,
      mapKey: key,
      map,
      slots: types,
      active: types.map((t) => t > 0),
    }
    this.listener?.onWorld(w)
  }

  /** RPTnkStageMap::ReloadStage: same map and types, only the surviving enemies */
  private reloadStage() {
    const w = this.world!
    const ms = this.mission!
    w.loadStage(ms.map, ms.slots, { swap: this.swapPlayers, active: ms.active })
    this.listener?.onWorld(w)
  }

  // ---- per frame ---------------------------------------------------------------------------

  /** One 60 Hz frame (RPTnkScene::Calculate). `applyPads` fills the player tanks' intents. */
  tick(applyPads: (w: World) => void) {
    if (this.paused) return
    const w = this.world
    if (!w) {
      this.phaseTime++
      return
    }
    applyPads(w)
    // RPTnkScene::UpdateGameplay
    w.countPools()
    if (!this.freeze) {
      w.physics()
      this.stepCount++
    }
    this.calculate()
    // RPTnkLayoutManager::Calculate
    this.presenter.tick(this)
    if (this.presenter.fadeStageReady()) this.stageReady = true
    if (this.presenter.fadeBonusLife()) {
      // RPTnkFade::Calculate at timer 120 of the bonus card
      this.stats.addLives(0, 1)
      for (let i = 1; i < this.players; i++) this.stats.addLives(i, 1)
    }
    if (this.presenter.fadeJingle()) this.startBgm()
    if (this.presenter.fadeStageBgm()) this.startStageBgm()
    // RPTnkScene::UserDraw: tread marks once 10 steps have run
    if (this.stepCount >= 10) w.drawTreadMarks()
    const ev = w.events
    w.events = []
    if (this.audio) this.forwardAudio(ev)
    this.listener?.onEvents(ev, w)
    this.phaseTime++
  }

  private forwardAudio(ev: SimEvent[]) {
    const a = this.audio!
    for (const e of ev) {
      if (e.t === 'se') a.se(e.name, e.pos)
      else if (e.t === 'seHold') a.seHold?.(e.name, e.key, e.pos)
      else if (e.t === 'bgm') a.bgm(e.name)
      else if (e.t === 'bgmStop') a.bgmStop(e.fade)
      else if (e.t === 'bgmMask') a.bgmTrackMask(e.mask)
    }
  }

  /** RPTnkGameManager::Calculate */
  private calculate() {
    switch (this.state) {
      case 1:
        this.stateWaitLifeNo()
        break
      case 2:
        this.stateStageStart()
        break
      case 3:
        this.stateCountdown()
        break
      case 4:
        this.statePlay()
        break
      case 5:
        this.stateMissWait()
        break
      case 6:
        this.stateStageClearWait()
        break
      case 7:
        this.stateNextStage()
        break
      case 8:
        this.stateCompleteWait()
        break
      case 9:
        this.stateFailedWait()
        break
      case 10:
        this.stateResultWait()
        break
      case 11:
        this.stateResultMenu()
        break
      case 12:
        this.stateEndMenu()
        break
    }
    const w = this.world
    if (w) this.bgm.setParams(w.enemyAliveNum, w.maxActiveEnemyType())
  }

  private stateWaitLifeNo() {
    if (!this.presenter.fadeDone()) return
    this.timer = FLOW.stageStart
    this.setState(2)
  }

  private stateStageStart() {
    if (--this.timer <= 0) {
      const w = this.world!
      w.activatePlayers()
      w.activateEnemies()
      this.presenter.setBalloons(false)
      this.presenter.startMsgPlay()
      this.presenter.hudIn()
      if (this.stage === 0) {
        this.exGuide.start(w)
        this.presenter.exGuideStart()
      }
      this.timer = 0
      this.setState(4)
    }
  }

  private stateCountdown() {
    if (--this.timer === 0) {
      this.world!.activatePlayers()
      this.world!.activateEnemies()
      this.timer = 0
      this.setState(4)
    }
  }

  /** RPTnkGameManager::CheckStageClear */
  private checkStageClear(): boolean {
    const w = this.world!
    if (w.enemyAliveNum !== 0) return false
    w.shellPool.stopAllEffects()
    this.freeze = true
    if (this.stage === this.lastStage || this.stage === STAGE_NUM - 1) {
      this.presenter.completeMsgShow()
      this.presenter.hudOut()
      this.bgm.stop()
      this.emitAudio({ t: 'bgm', name: this.stage === 19 ? 'RP_TNK_BGM_COMP20' : 'RP_TNK_BGM_COMP100' })
      this.timer = 0
      this.setState(8)
    } else {
      if (this.stage === 0) this.presenter.exGuideStop()
      this.presenter.clearMsgShow()
      this.presenter.hudOut()
      this.bgm.stop()
      this.bgm.playStageClearBgm()
      this.nextAction = 1
      this.timer = 0
      this.setState(6)
    }
    return true
  }

  private statePlay() {
    const w = this.world!
    if (this.stage === 0) this.exGuide.calculate(w, this.presenter)
    const dead = w.playersDeadState()
    if (dead !== 3) {
      ++this.timer
      this.checkStageClear()
      return
    }
    w.shellPool.stopAllEffects()
    this.freeze = true
    const lose = this.options.infiniteLives ? 0 : -1
    const failed = this.stats.addLives(0, lose)
    for (let i = 1; i < this.players; i++) this.stats.addLives(i, lose)
    if (failed) {
      this.presenter.failedMsgShow()
      this.presenter.hudOut()
      this.bgm.stop()
      this.emitAudio({ t: 'bgm', name: 'RP_TNK_BGM_RESULT2' })
      this.nextAction = 4
      this.timer = 0
      this.setState(9)
    } else if (!this.checkStageClear()) {
      this.bgm.stop()
      this.emitAudio({ t: 'bgm', name: 'RP_TNK_BGM_MISS' })
      this.nextAction = 3
      this.timer = FLOW.missWait
      this.setState(5)
    }
    if (this.stage === 0) this.presenter.exGuideStop()
  }

  private stateMissWait() {
    if (--this.timer === 0) {
      this.presenter.fadeStart(false, false)
      this.setState(7)
    }
  }

  private stateStageClearWait() {
    if (this.presenter.clearMsgActive()) {
      const m = this.data.params.missions[this.stage]
      const bonus = this.players === 1 ? m.bonus : m.bonus2P
      this.presenter.fadeStart(bonus > 0, false)
      this.setState(7)
    }
  }

  private stateNextStage() {
    const w = this.world!
    if (this.presenter.fadeDone()) {
      this.timer = FLOW.stageStart
      this.setState(2)
    } else if (this.stageReady) {
      w.deactivateAll()
      this.presenter.hudOut()
      this.presenter.clearMsgHide()
      this.presenter.setBalloons(true)
      this.freeze = false
      if (this.nextAction === 1) {
        ++this.stage
        this.pickStageVariant(this.stage)
        this.loadStage(this.stage, this.variant, this.players >= 2)
      } else this.reloadStage()
      this.nextAction = 0
      this.stageReady = false
    }
  }

  private stateCompleteWait() {
    if (this.presenter.completeMsgActive()) {
      this.presenter.resultStart()
      this.setState(10)
    }
  }

  private stateFailedWait() {
    if (this.presenter.failedMsgActive()) {
      this.presenter.exMsgOutAll()
      this.presenter.resultStart()
      this.setState(10)
    }
  }

  private stateResultWait() {
    if (!this.presenter.resultDone()) return
    if (this.players === 1) this.presenter.medalStart(this.stats.kills[0])
    else this.presenter.winnerStart(this.stats.winner())
    this.setState(11)
  }

  private stateResultMenu() {
    if (this.players === 1) {
      if (this.presenter.medalDone()) {
        this.presenter.menuStart(1)
        this.setState(12)
      }
    } else if (this.presenter.winnerDone()) {
      this.presenter.menuStart(2)
      this.setState(12)
    } else if (this.presenter.winnerTotals()) this.presenter.resultShowTotals()
  }

  private stateEndMenu() {
    const c = this.presenter.menuChoice()
    if (c === 0) {
      this.retry = true
      this.retryCount++
      this.newGame(this.players)
    } else if (c === 1) {
      this.quit = true
      this.setState(0)
    }
  }

  /** pause menu "Quit": back to the title (the scene change in the original) */
  quitToTitle() {
    this.paused = false
    this.quit = true
    this.audio?.bgmStop(0)
    this.setState(0)
  }

  /** RPTnkGameManager::StartBgm (the mission banner jingle) */
  private startBgm() {
    this.se('RP_TNK_BGM_PANPAKAPAN')
  }

  /** RPTnkGameManager::StartStageBgm */
  private startStageBgm() {
    const w = this.world!
    this.bgm.startStageBgm(this.stage + 1, w.enemyAliveNum, w.maxActiveEnemyType())
  }

  /**
   * Cursor display mode (RPTnkCursor::UpdateScreenPosAndMode): 0 hidden, 1 reticle + tail,
   * 2 reticle + tail + line to the tank, 3 dimmed reticle (dead player in 2P).
   * `farOrClamped`: the pointer is >= 480 units from the tank or pinned to the screen edge.
   */
  cursorMode(player: number, farOrClamped: boolean): 0 | 1 | 2 | 3 {
    switch (this.state) {
      case 2:
      case 3:
        return 2
      case 1:
      case 7:
      case 10:
        return 1
      case 11:
      case 12:
        return 0
    }
    const t = this.world?.playerTanks[player]
    if (t && t.lives) return farOrClamped ? 2 : 1
    return this.players >= 2 ? 3 : 1
  }

  // ---- debug -----------------------------------------------------------------------------

  /** destroys every enemy (credited to P1) */
  debugKillAll() {
    const w = this.world
    if (!w) return
    for (const t of w.enemyTanks) if (t.active && t.lives > 0) {
      t.lives = 0
      t.explode(1, 'shell')
    }
    w.syncView()
  }

  /** destroys the player tanks */
  debugKillPlayers() {
    const w = this.world
    if (!w) return
    for (let i = 0; i < w.players; i++) {
      const t = w.playerTanks[i]
      if (t.active && t.lives > 0) {
        t.lives = 0
        t.explode(3, 'shell')
      }
    }
  }
}

/**
 * Port of RPTnkPlayerController's inputs: the pad is mapped onto the Nunchuk stick / D-pad
 * (moveX/moveY, y down the screen), B (fire) and A (mine) triggers, and the pointer, given as
 * its world point on the turret plane (`aimWorld`, e.g. from screenToField or a ray cast to
 * y = 17.6). Keyboard-style digital input uses the D-pad's 46 degree drive cone; analog sticks
 * the Nunchuk's 10 degrees.
 */
export function padToIntent(t: Tank, pad: PadState, aimWorld: { x: number; z: number } | null) {
  const it = t.intent
  it.moveX = pad.moveX
  it.moveZ = pad.moveY
  const analogFlag = (pad as { analog?: boolean }).analog
  it.analog = analogFlag ?? !isDigital(pad.moveX, pad.moveY)
  if (aimWorld) {
    it.aimX = aimWorld.x
    it.aimZ = aimWorld.z
  } else if (pad.aimStick) {
    // right stick: a cursor 200 units out in the stick direction
    it.aimX = t.pos.x + pad.aimStick.x * 200
    it.aimZ = t.pos.z + pad.aimStick.y * 200
  }
  it.aim = Math.atan2(it.aimZ - t.pos.z, it.aimX - t.pos.x)
  it.fire = pad.fire
  it.mine = pad.mine
}

function isDigital(x: number, y: number) {
  const ok = (v: number) => v === 0 || Math.abs(Math.abs(v) - 1) < 1e-6 || Math.abs(Math.abs(v) - Math.SQRT1_2) < 1e-6
  return ok(x) && ok(y)
}

export type { V3 }
