// Presenter backed by the real Tanks layouts (src/ui/tnk.ts): the game manager
// calls these exactly where RPTnkGameManager calls RPTnkLayoutManager.

import type { Game } from '../game'
import type { Presenter } from '../sim/presenter'
import { NO_INPUT, SceneFader, type MenuInput } from './shared/common'
import { loadTrophyTextures } from './shared/medal'
import { MedalResult } from './shared/medalResult'
import { drawMiiHead } from './shared/mii'
import { PauseText } from './shared/pause'
import { ResultMenu, VsWinner } from './shared/vsResult'
import type { Lyt } from './lyt'
import { TnkLayouts, type TnkInfo } from './tnk'

export type PresenterHost = {
  /** world point -> layout units (832 x 456, centred, y up) */
  project(x: number, y: number, z: number): { x: number; y: number }
  /** system SE by brsar index */
  se(id: number): void
  /** SE / jingle by brsar label (Tanks or party-common archive) */
  seName(name: string): void
  /** RPSndAudioMgr::startFanfare: a jingle that replaces the BGM */
  fanfare(name: string): void
  /** A/B pressed this frame (result list skip) */
  confirm(): boolean
  /** menu input this frame (result menu, medal / winner skips) */
  menu?(): MenuInput
  /** RPScreenFade: 0..1, the game view dims and blurs behind the result screens */
  screenFade?(t: number): void
  /** the best medal was saved (gold lifts the 20-mission cap) */
  medalSaved?(medal: number): void
}

/** RPScreenFade: sFadeFrames, sTargetColor (200, 200, 200, blur 200) */
const SCREEN_FADE_FRAMES = 20
const SCREEN_FADE_COLOR = 200

/** RPTnkFade / RPTnkHud Mii head mounts -> player */
const FADE_HEADS: Record<string, number> = { N_player00_00: 0, N_player00_01: 0, N_player01_01: 1 }
const HUD_HEADS: Record<string, number> = {
  N_player_00: 0,
  N_player_01: 0,
  N_player_02: 0,
  N_player_03: 0,
  N_player_04: 1,
  N_player_05: 1,
  N_player_06: 1,
  N_player_07: 1,
}

export class UiPresenter implements Presenter {
  ui: TnkLayouts
  private game: Game | null = null
  private sig = { ready: false, life: false, jingle: false, bgm: false }
  // RPCommon: the party-common screens of the Tanks scene
  medal: MedalResult
  winner: VsWinner
  menu: ResultMenu
  pauseText = new PauseText()
  /** scene changes (retry / quit) go through black */
  fader = new SceneFader()
  private screenFade = 0
  private screenFadeIn = false
  private menuChoiceReady: -1 | 0 | 1 = -1
  private offscreen: HTMLCanvasElement | null = null

  constructor(private host: PresenterHost) {
    const g = (): Game => this.game!
    const info: TnkInfo = {
      state: () => g()?.state ?? 0,
      stage: () => g()?.stage ?? 0,
      lastStage: () => g()?.lastStage ?? 19,
      modeIdx: () => (g()?.players === 2 ? 1 : 0),
      lives: (p) => g()?.livesOf(p as 0 | 1) ?? 0,
      addLives: () => (this.sig.life = true),
      kills: (p) => g()?.stats.kills[p] ?? 0,
      killsByType: (p, i) => g()?.stats.killsByType[p][i + 1] ?? 0,
      typeOrder: (i) => (g()?.stats.typeOrder[i] ?? 1) - 1,
      typeNum: () => g()?.stats.typeOrder.length ?? 0,
      winner: () => g()?.winner() ?? -1,
      enemyAlive: () => g()?.world?.enemyAliveNum ?? 0,
      setStageReady: () => (this.sig.ready = true),
      startBgm: () => (this.sig.jingle = true),
      startStageBgm: () => (this.sig.bgm = true),
      se: (id) => this.host.se(id),
      playerScreen: (p) => {
        const t = g()?.world?.playerTanks[p]
        if (!t) return null
        return this.host.project(t.pos.x, t.pos.y + 17.6, t.pos.z)
      },
      playerAngle: (p) => g()?.world?.playerFacing[p] ?? 0,
    }
    this.ui = new TnkLayouts(info)
    const snd = { se: (n: string) => host.seName(n), fanfare: (n: string) => host.fanfare(n) }
    this.medal = new MedalResult(snd, (m) => host.medalSaved?.(m))
    this.winner = new VsWinner(snd)
    this.menu = new ResultMenu(snd)
  }

  async load() {
    await Promise.all([this.ui.load(), this.medal.load(), this.winner.load(), this.menu.load(), this.pauseText.load(), loadTrophyTextures()])
    // RPDrawKokeshiIcon at the Mii head mounts (P2's only in 2P)
    const heads = (l: Lyt, map: Record<string, number>) => (name: string, ctx: CanvasRenderingContext2D, alpha: number) => {
      const p = map[name]
      if (p === undefined || (p === 1 && this.game?.players !== 2)) return
      drawMiiHead(ctx, l.pane(name).size[0], p, alpha)
    }
    this.ui.fade.l.hook = heads(this.ui.fade.l, FADE_HEADS)
    this.ui.hud.l.hook = heads(this.ui.hud.l, HUD_HEADS)
  }

  /** RPTnkScene::Reset: the layout manager and RPCommon start over with the scene */
  reset() {
    this.ui.reset()
    this.medal.reset()
    this.winner.reset()
    this.menu.reset()
    this.pauseText.reset()
    this.screenFade = 0
    this.screenFadeIn = false
    this.menuChoiceReady = -1
    this.host.screenFade?.(0)
  }

  bind(game: Game) {
    this.game = game
  }

  private take(k: keyof UiPresenter['sig']) {
    const v = this.sig[k]
    this.sig[k] = false
    return v
  }

  fadeStart(bonus: boolean, fast: boolean) {
    this.ui.fade.start(bonus, fast)
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
    return this.ui.fade.doneFlag
  }
  hudIn() {
    this.ui.hud.playIn()
  }
  hudOut() {
    this.ui.hud.playOut()
  }
  hudScore(p: 0 | 1) {
    this.ui.hud.playScore(p)
  }
  setBalloons(on: boolean) {
    this.ui.hud.showBalloons = on
  }
  startMsgPlay() {
    this.ui.start.play()
  }
  clearMsgShow() {
    this.ui.clear.show()
  }
  clearMsgActive() {
    return this.ui.clear.active
  }
  clearMsgHide() {
    this.ui.clear.hide()
  }
  failedMsgShow() {
    this.ui.failed.show()
  }
  failedMsgActive() {
    return this.ui.failed.active
  }
  completeMsgShow() {
    this.ui.complete.show()
  }
  completeMsgActive() {
    return this.ui.complete.active
  }
  exGuideStart() {}
  exGuideStop() {
    this.ui.ex.playOut()
  }
  exMsgShow(m: number) {
    this.ui.ex.show(m)
  }
  exMsgOutAll() {
    this.ui.ex.playOutAll()
  }
  resultStart() {
    this.ui.result.start()
  }
  resultDone() {
    return this.ui.result.finished
  }
  hitPopup(p: { x: number; z: number }, player: 0 | 1) {
    const s = this.host.project(p.x, 17.6, p.z)
    this.ui.spawnHit({ x: s.x / 304, y: s.y / 228 }, player)
  }
  resultShowTotals() {
    // RPTnkResultLyt::ShowTotals: the 2P total leaves and the winner's total keeps pulsing
    const r = this.ui.result
    const l = r.l
    const g = this.game
    l.unbind('outTotal')
    l.play('tnkResult_00_outTotal_00', { key: 'outTotal', bind: g?.players === 2 ? 'N_totalAll_01' : 'N_totalAll_00' })
    const w = g?.winner() ?? -1
    if (w === 0) l.play('tnkResult_00_win1P_00', { key: 'win', bind: 'N_total_01', loop: true })
    else if (w === 1) l.play('tnkResult_00_win2P_00', { key: 'win', bind: 'N_total_02', loop: true })
    r.state = 6
  }
  // Medal / VS winner / result menu: Wii Play's shared screens (RPCommon)
  medalStart(kills: number) {
    this.medal.start(kills)
    this.startScreenFade()
  }
  medalDone() {
    return this.medal.state === 4
  }
  winnerStart(winner: -1 | 0 | 1) {
    this.winner.start(winner)
    this.startScreenFade()
  }
  winnerDone() {
    return this.winner.state === 5
  }
  winnerTotals() {
    return this.winner.closing
  }
  menuStart(players: 1 | 2) {
    this.menu.start(players === 1 ? 1 : 2, players === 2 ? ((this.game?.winner() ?? -1) as -1 | 0 | 1) : -1)
  }
  /** RPResultMenu::GetChoice, held back until the scene change has faded to black */
  menuChoice() {
    const c = this.menu.getChoice() as -1 | 0 | 1
    if (c === -1) return -1
    if (this.menuChoiceReady !== -1) {
      const r = this.menuChoiceReady
      this.menuChoiceReady = -1
      return r
    }
    this.fader.out(() => (this.menuChoiceReady = c))
    return -1
  }
  /** RPMedalResult / RPVsWinner Start: RPCommon::GetPauseText()->SetEnabled(false), ScreenFade in */
  private startScreenFade() {
    this.screenFadeIn = true
    this.pauseText.enabled = false
  }
  /** RPCommon::IsPauseEnable */
  get pauseEnabled() {
    return !this.screenFadeIn
  }

  tick(game: Game) {
    this.game = game
    this.ui.calc(this.host.confirm())
    // RPCommon::Calculate
    const input = this.host.menu?.() ?? NO_INPUT
    const ab = this.host.confirm()
    const mi = { ...input, ab: input.ab || ab }
    this.medal.calc(mi)
    this.menu.calc(mi)
    this.winner.calc(mi)
    // RPTnkGameManager: P1's "+ Pause" hint on mission 1 in 1P, from the end of the first fade
    // until the mission ends (StateMissWait / StateStageClearWait turn it off)
    const s = game.state
    if (!this.screenFadeIn) this.pauseText.enabled = game.players === 1 && game.stage === 0 && (s === 2 || s === 4 || s === 5 || s === 6)
    this.pauseText.calc()
    // RPScreenFade
    const before = this.screenFade
    this.screenFade = Math.max(0, Math.min(SCREEN_FADE_FRAMES, this.screenFade + (this.screenFadeIn ? 1 : -1)))
    if (this.screenFade !== before) this.host.screenFade?.(this.screenFade / SCREEN_FADE_FRAMES)
  }

  /** The Tanks layouts (view 2), dimmed and blurred by RPScreenFade, then RPCommon's layers. */
  draw(ctx: CanvasRenderingContext2D, wideX: number) {
    if (!this.game) return
    const k = this.screenFade / SCREEN_FADE_FRAMES
    if (k > 0) {
      const c = ctx.canvas
      const off = (this.offscreen ??= document.createElement('canvas'))
      if (off.width !== c.width || off.height !== c.height) {
        off.width = c.width
        off.height = c.height
      }
      const o = off.getContext('2d')!
      o.setTransform(1, 0, 0, 1, 0, 0)
      o.clearRect(0, 0, off.width, off.height)
      o.setTransform(ctx.getTransform())
      this.ui.draw(o, wideX)
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.filter = screenFilter(k, c.height)
      ctx.drawImage(off, 0, 0)
      ctx.restore()
    } else this.ui.draw(ctx, wideX)
    // RPCommon::UserDraw (layers 1A / 1C) and the pause hint
    this.medal.draw(ctx, wideX)
    this.menu.draw(ctx, wideX)
    this.winner.draw(ctx)
    this.pauseText.draw(ctx, wideX)
  }
}

/**
 * CSS filter for RPScreenFade at strength k: colour multiply 200/255 and a blur of about one
 * Wii pixel (SetBlurOffset(1)), scaled to a canvas `height` pixels tall.
 */
export function screenFilter(k: number, height: number) {
  if (k <= 0) return 'none'
  const mul = 1 - (1 - SCREEN_FADE_COLOR / 255) * k
  return `brightness(${mul.toFixed(3)}) blur(${((k * height) / 480).toFixed(2)}px)`
}
