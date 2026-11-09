// The layout side of the game flow. RPTnkGameManager drives the 2D layouts (RPTnkFade, the
// start / clear / failed / complete messages, HUD, result list, medal and result menu) and
// waits on them; Game calls these methods exactly where the original calls the layout objects
// (RPTnkGameManager.cpp, RPTnkStageMap.cpp, RPTnkTank.cpp). The real implementation draws the
// BRLYTs; HeadlessPresenter reproduces only their timings (RPTnkLyt_2/7/8/9.cpp + the BRLAN
// frame counts) so the simulation runs without UI.
//
// Per frame Game runs: physics, the game-manager state, then presenter.tick(game) (the
// original's RPTnkLayoutManager::Calculate), then polls the fade* signals.

import type { Game } from '../game'

export interface Presenter {
  /** RPTnkFade::Start: with `bonus` the +1 life card plays first; `fast` = first mission (rate 15 curtain) */
  fadeStart(bonus: boolean, fast: boolean): void
  /** true once when the curtain is closed and the next stage may be loaded behind it (SetStageReady) */
  fadeStageReady(): boolean
  /** true once at the bonus card's +1 life (fade timer 120): Game adds a life to every player */
  fadeBonusLife(): boolean
  /** true once when the mission banner appears (RPTnkGameManager::StartBgm: PANPAKAPAN) */
  fadeJingle(): boolean
  /** true once when the curtain starts opening (RPTnkGameManager::StartStageBgm) */
  fadeStageBgm(): boolean
  /** RPTnkFade::IsDone */
  fadeDone(): boolean

  hudIn(): void
  hudOut(): void
  /** RPTnkHud::PlayScoreAnim */
  hudScore(player: 0 | 1): void
  /** RPTnkHud::SetShowBalloons (P1/P2 start balloons) */
  setBalloons(on: boolean): void
  /** "Start!" (RPTnkStartMsg::Play) */
  startMsgPlay(): void

  clearMsgShow(): void
  clearMsgActive(): boolean
  clearMsgHide(): void
  failedMsgShow(): void
  failedMsgActive(): boolean
  completeMsgShow(): void
  completeMsgActive(): boolean

  /** RPTnkExGuide::Start (mission 1 control hints) */
  exGuideStart(): void
  /** RPTnkHideExMsg */
  exGuideStop(): void
  /** RPTnkExMsg::Show(msg, -0.45): 0 move, 1 aim, 2 fire (called every frame while shown) */
  exMsgShow(msg: number): void
  /** RPTnkExMsg::PlayOutAll */
  exMsgOutAll(): void

  /** RPTnkResultLyt::Start / IsFinished / ShowTotals */
  resultStart(): void
  resultDone(): boolean
  resultShowTotals(): void
  /** RPTnkLayoutManager::SpawnHitPopup at a destroyed enemy, credited to `player` */
  hitPopup(worldPos: { x: number; z: number }, player: 0 | 1): void
  /** 1P: RPMedalResult::Start(kills) / state 4 */
  medalStart(kills: number): void
  medalDone(): boolean
  /** 2P: RPVsWinner::Start(winner) / state 5; winnerTotals() = IsStateEntered(3) */
  winnerStart(winner: -1 | 0 | 1): void
  winnerDone(): boolean
  winnerTotals(): boolean
  /** RPResultMenu::Start(players, winner) / GetChoice when state 4: 0 retry, 1 quit, -1 waiting */
  menuStart(players: 1 | 2): void
  menuChoice(): -1 | 0 | 1

  /** RPTnkLayoutManager::Calculate */
  tick(game: Game): void
}

/** RPSysFrameCtrl in one-time mode: finished once frame >= end (end = BRLAN frame size) */
class Anim {
  frame = 0
  playing = false
  rate = 1
  constructor(public end: number) {}
  restart() {
    this.frame = 0
    this.playing = true
  }
  stop() {
    this.playing = false
  }
  get finished() {
    return this.frame >= this.end
  }
  update() {
    if (this.playing) this.frame += this.rate
    if (this.frame >= this.end) {
      this.frame = this.end
      this.playing = false
    }
  }
}

/** BRLAN frame sizes from tank.arc (US/RPTnkScene/local/tank/anim) */
export const LAYOUT_FRAMES = {
  fadeIn: 16,
  fadeOut: 16,
  fadeInLife: 16,
  fadeOutLife: 16,
  fadeInBonus: 26,
  fadeOutBonus: 11,
  fadeAddLife: 36,
  fadeInMission: 16,
  fadeInEnemy: 16,
  fadeLoop: 140,
  start: 61,
  clearIn: 16,
  clearTotal: 16,
  failedIn: 36,
  failedOut: 21,
  completeIn: 81,
  completeOut: 21,
  hudIn: 21,
  hudOut: 21,
  hit: 49,
} as const

/**
 * Timing-only presenter. Fade: port of RPTnkFade::Start / Calculate / UpdateStates; messages:
 * RPTnkClearMsg (show -> 16 + 16 frames of animation -> 120 frames -> active), RPTnkFailedMsg
 * (120 frames -> 21-frame out -> active), RPTnkCompleteMsg (180 + 21). Result, medal and menu
 * finish after `resultFrames` / at once; the menu answers `menuAnswer` (-1 waits forever).
 */
export class HeadlessPresenter implements Presenter {
  menuAnswer: -1 | 0 | 1 = -1
  resultFrames = 1
  /** sound hook for the layout SEs (MISSION_BONUS, TNK1UP, GET_TNKNUM, GAMESTART) */
  private game: Game | null = null

  // fade (RPTnkFade)
  private fState = 0
  private fTimer = 0
  private fFast = false
  private fBonus = false
  private fDone = false
  private fSig = { ready: false, life: false, jingle: false, bgm: false }
  private aIn = new Anim(LAYOUT_FRAMES.fadeIn)
  private aOut = new Anim(LAYOUT_FRAMES.fadeOut)
  private aInLife = new Anim(LAYOUT_FRAMES.fadeInLife)
  private aOutLife = new Anim(LAYOUT_FRAMES.fadeOutLife)
  private aInBonus = new Anim(LAYOUT_FRAMES.fadeInBonus)
  private aOutBonus = new Anim(LAYOUT_FRAMES.fadeOutBonus)
  private aInMission = new Anim(LAYOUT_FRAMES.fadeInMission)
  private aInEnemy = new Anim(LAYOUT_FRAMES.fadeInEnemy)

  // RPTnkClearMsg
  private cState = 0
  private cTimer = 0
  private cActive = false
  private cIn = new Anim(LAYOUT_FRAMES.clearIn)
  private cTotal = new Anim(LAYOUT_FRAMES.clearTotal)
  // RPTnkFailedMsg / RPTnkCompleteMsg share the same machine
  private failed = new TimedMsg(120, LAYOUT_FRAMES.failedIn, LAYOUT_FRAMES.failedOut)
  private complete = new TimedMsg(180, LAYOUT_FRAMES.completeIn, LAYOUT_FRAMES.completeOut)

  private resultT = -1
  private medal = false
  private winner = false
  private menu = false

  private anims() {
    return [this.aIn, this.aOut, this.aInLife, this.aOutLife, this.aInBonus, this.aOutBonus, this.aInMission, this.aInEnemy, this.cIn, this.cTotal]
  }

  // ---- fade ----
  fadeStart(bonus: boolean, fast: boolean) {
    if (this.fState !== 0) return
    this.fFast = fast
    this.fBonus = bonus
    this.fTimer = bonus ? 150 : 4
    this.aIn.restart()
    this.aIn.rate = fast ? 15 : 1
    this.fDone = false
    this.fState = 1
  }
  fadeStageReady() {
    return this.take('ready')
  }
  fadeBonusLife() {
    return this.take('life')
  }
  fadeJingle() {
    return this.take('jingle')
  }
  fadeStageBgm() {
    return this.take('bgm')
  }
  fadeDone() {
    return this.fDone
  }
  private take(k: keyof HeadlessPresenter['fSig']) {
    const v = this.fSig[k]
    this.fSig[k] = false
    return v
  }

  /** RPTnkFade::Calculate (state 3 / 6 timers) then UpdateStates */
  private fadeCalc() {
    if (this.fState === 3) {
      if (--this.fTimer === 0) {
        if (this.fBonus) {
          this.aOutBonus.restart()
          this.fState = 4
        } else this.showMission()
      } else if (this.fBonus && this.fTimer === 120) {
        this.fSig.life = true
        this.game?.se('RP_TNK_SE_TNK1UP')
      }
    } else if (this.fState === 6) {
      if (--this.fTimer === 0) {
        this.aOutLife.restart() // (the real fade also calls RPTnkHud::SetShowBalloons(true))
        this.fState = 7
      }
    }
    // UpdateStates
    switch (this.fState) {
      case 1:
        if (this.aIn.finished) {
          this.aIn.rate = 1
          if (!this.fFast) this.fSig.ready = true
          this.aInLife.restart()
          if (this.fBonus) {
            this.aInBonus.restart()
            this.game?.se('RP_TNK_SE_MISSION_BONUS')
          }
          this.fState = 2
        }
        break
      case 2:
        if (this.fBonus ? this.aInLife.finished && this.aInBonus.finished : this.aInLife.finished) this.fState = 3
        break
      case 4:
        if (this.aOutBonus.finished) this.showMission()
        break
      case 5:
        if (this.aInMission.finished && this.aInEnemy.finished) this.fState = 6
        break
      case 7:
        if (this.aOutLife.finished) {
          this.aOut.restart()
          this.fSig.bgm = true
          this.fState = 8
        }
        break
      case 8:
        if (this.aOut.finished) {
          this.fState = 0
          this.fDone = true
        }
        break
    }
  }

  private showMission() {
    this.fTimer = 140
    this.aInMission.restart()
    this.aInEnemy.restart()
    this.fSig.jingle = true
    this.fState = 5
  }

  /** the fade's state for a HUD (0 idle .. 8 opening) */
  get fadeState() {
    return this.fState
  }

  // ---- HUD / messages ----
  hudIn() {}
  hudOut() {}
  hudScore() {}
  setBalloons() {}
  startMsgPlay() {
    this.game?.se('RP_TNK_SE_GAMESTART')
  }
  clearMsgShow() {
    if (this.cState !== 0) return
    this.cTimer = 120
    this.cActive = false
    this.cIn.restart()
    this.cState = 1
  }
  clearMsgActive() {
    return this.cActive
  }
  clearMsgHide() {
    if (this.cState === 3) this.cState = 0
  }
  private clearCalc() {
    if (this.cState === 1) {
      if (this.cIn.finished) {
        this.cTotal.restart()
        this.game?.se('RP_TNK_SE_GET_TNKNUM')
        this.cState = 2
      }
    } else if (this.cState === 2) {
      if (this.cTotal.finished) this.cState = 3
    }
    if (this.cState === 3) {
      if (--this.cTimer <= 0) this.cActive = true
    }
  }
  failedMsgShow() {
    this.failed.show()
  }
  failedMsgActive() {
    return this.failed.active
  }
  completeMsgShow() {
    this.complete.show()
  }
  completeMsgActive() {
    return this.complete.active
  }
  exGuideStart() {}
  exGuideStop() {}
  exMsgShow() {}
  exMsgOutAll() {}
  resultStart() {
    this.resultT = this.resultFrames
  }
  resultDone() {
    return this.resultT === 0
  }
  resultShowTotals() {}
  hitPopup() {}
  medalStart() {
    this.medal = true
  }
  medalDone() {
    return this.medal
  }
  winnerStart() {
    this.winner = true
  }
  winnerDone() {
    return this.winner
  }
  winnerTotals() {
    return this.winner
  }
  menuStart() {
    this.menu = true
  }
  menuChoice() {
    return this.menu ? this.menuAnswer : -1
  }

  tick(game: Game) {
    this.game = game
    this.fadeCalc()
    this.clearCalc()
    this.failed.calc()
    this.complete.calc()
    if (this.resultT > 0) this.resultT--
    // RPSysLayout::calc advances the animations after the state checks
    for (const a of this.anims()) a.update()
    this.failed.update()
    this.complete.update()
  }

  /** RPTnkLayoutManager::Reset */
  reset() {
    this.fState = 0
    this.fDone = false
    this.fSig = { ready: false, life: false, jingle: false, bgm: false }
    for (const a of this.anims()) {
      a.frame = 0
      a.playing = false
      a.rate = 1
    }
    this.cState = 0
    this.cActive = false
    this.failed = new TimedMsg(120, LAYOUT_FRAMES.failedIn, LAYOUT_FRAMES.failedOut)
    this.complete = new TimedMsg(180, LAYOUT_FRAMES.completeIn, LAYOUT_FRAMES.completeOut)
    this.resultT = -1
    this.medal = this.winner = this.menu = false
  }
}

/** RPTnkFailedMsg / RPTnkCompleteMsg: Reset leaves state 1; Show (state != 0) -> 2 */
class TimedMsg {
  state = 1
  timer: number
  active = false
  private aIn: Anim
  private aOut: Anim
  constructor(private hold: number, inFrames: number, outFrames: number) {
    this.timer = hold
    this.aIn = new Anim(inFrames)
    this.aOut = new Anim(outFrames)
  }
  show() {
    if (this.state === 0) return
    this.timer = this.hold
    this.active = false
    this.aIn.restart()
    this.state = 2
  }
  calc() {
    if (this.state === 2) {
      if (this.aIn.finished) this.state = 0
    } else if (this.state === 3) {
      if (this.aOut.finished) {
        this.state = 1
        this.active = true
      }
    }
    if (this.state === 2 || this.state === 0) {
      if (--this.timer <= 0) {
        this.aOut.restart()
        this.state = 3
      }
    }
  }
  update() {
    this.aIn.update()
    this.aOut.update()
  }
}
