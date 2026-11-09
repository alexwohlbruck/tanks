// App bootstrap: loads the game, renderer, audio and UI, owns the 60 Hz loop and routes
// between DOM screens (menus, editor, lobby) and the game.

import { Audio } from '../audio/audio'
import { Game } from '../game'
import { Input, type PadState } from '../input'
import type { LevelPack } from '../levels/format'
import { Models } from '../render/models'
import { SceneView } from '../render/scene'
import { FPS } from '../sim/consts'
import { DebugPanel } from '../ui/debug'
import { Hud } from '../ui/hud'
import { screenFilter, UiPresenter } from '../ui/presenter'
import { loadPlayerData } from '../ui/shared/save'
import { Router } from './router'
import { LocalSession, type Cursor } from './session'
import type { AppContext, Pads, Session } from './types'
// [net] online play: registers the 'lobby' and 'net-hud' screens (src/net/index.ts)
import { handleJoinParam } from '../net'

/** layout space: 832 x 456 in 16:9, panes with locationAdjust spread by 832/608 */
const LAYOUT_W = 832
const LAYOUT_H = 456

export class App implements AppContext {
  game = new Game()
  models = new Models()
  audio = new Audio()
  input: Input
  view: SceneView
  presenter: UiPresenter
  hud: Hud
  router: Router
  debug!: DebugPanel
  session: Session
  params = new URLSearchParams(location.search)
  private pad: PadState
  private frame = 0
  /** held loops (rocket shells, mine fuse) by key, refreshed by the simulation every frame */
  private held = new Map<number, { name: string; seen: number }>()

  constructor(
    private stage: HTMLElement,
    private gl: HTMLCanvasElement,
    private uiCanvas: HTMLCanvasElement,
    screens: HTMLElement,
  ) {
    this.input = new Input(stage)
    this.pad = Input.merge(this.input.pollAll().kbm)
    this.view = new SceneView(gl, this.models)
    this.router = new Router(screens, () => this)
    const game = this.game
    const audio = this.audio
    this.presenter = new UiPresenter({
      project: (x, y, z) => this.view.projectToLayout(x, y, z),
      se: (id) => {
        const n = audio.nameOf(id)
        if (n) audio.play(n)
      },
      seName: (name) => audio.play(name),
      fanfare: (name) => audio.playMusic(name),
      confirm: () => this.pad.fire || this.pad.mine || this.pad.confirm || this.pad.back,
      menu: () => this.hud.mi,
      screenFade: (t) => (gl.style.filter = t > 0 ? screenFilter(t, gl.clientHeight) : ''),
      // RPPartyPlayerData medal >= 3 (gold) lifts the 20-mission cap of later runs
      medalSaved: (medal) => (game.options.goldMedal = medal >= 3 || this.params.has('gold')),
    })
    this.hud = new Hud(uiCanvas, game, this.presenter, {
      se: (name) => audio.play(name),
      fanfare: (name) => audio.playMusic(name),
      music: (name, frames = 0) => {
        if (!name) audio.stopMusic(frames / FPS)
        else if (audio.musicName !== name) audio.playMusic(name)
      },
      pauseAudio: (paused) => {
        audio.musicBus.gain.setTargetAtTime(paused ? 0 : 1, audio.ctx.currentTime, 0.02)
        if (paused) this.stopHeld()
      },
      stopSounds: () => {
        audio.stopMusic()
        this.stopHeld()
      },
    })
    this.session = new LocalSession(game)
  }

  async start() {
    const { game, audio } = this
    await Promise.all([game.load(), this.models.load(), audio.load(), this.presenter.load(), this.hud.load()])
    await this.view.init()
    this.presenter.bind(game)
    game.presenter = this.presenter
    game.options.goldMedal = loadPlayerData().medal >= 3 || this.params.has('gold')
    this.wireGameAudio()
    game.listener = {
      onWorld: (w) => this.view.setWorld(w),
      onEvents: (ev) => this.view.onEvents(ev),
      onPhase: () => {},
    }
    addEventListener('resize', () => this.resize())
    this.resize()
    this.debug = new DebugPanel(game, this.hud, document.body)
    let acc = 0
    let last = performance.now()
    const dt = 1000 / FPS
    const loop = (now: number) => {
      acc += Math.min(250, now - last)
      last = now
      while (acc >= dt) {
        acc -= dt
        this.step()
      }
      this.render()
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
    if (this.params.has('mission')) this.playClassic(this.params.get('p2') ? 2 : 1, Number(this.params.get('mission')) - 1)
    // [net] ?join=CODE (shared room link) / ?online opens the lobby
    handleJoinParam(this)
    ;(window as unknown as { game: Game; audio: Audio; app: App }).game = game
    ;(window as unknown as { audio: Audio }).audio = audio
    ;(window as unknown as { app: App }).app = this
  }

  private wireGameAudio() {
    const audio = this.audio
    const pan = (p?: { x: number; z: number }) => (p ? Math.max(-1, Math.min(1, p.x / 468)) * 0.6 : 0)
    this.game.audio = {
      // *_CSPK sounds come out of the Wii Remote speaker on the console; play them quieter
      se: (name, pos) => audio.play(name, { pan: pan(pos), volume: name.endsWith('_CSPK') ? 0.5 : 1 }),
      seHold: (name, key) => {
        if (!this.held.has(key)) audio.loop('hold' + key, name, 1)
        this.held.set(key, { name, seen: this.frame })
      },
      bgm: (name) => {
        if (name === 'RP_TNK_BGM_LOOP2') audio.playMusic(name, audio.layersFor(audio.pendingMask)).then(() => audio.setTrackMask(audio.pendingMask))
        else audio.playMusic(name)
      },
      bgmStop: (f) => audio.stopMusic(f / FPS),
      bgmTrackMask: (mask) => audio.setTrackMask(mask),
    }
  }

  private stopHeld() {
    for (const k of this.held.keys()) this.audio.loop('hold' + k, '', 0)
    this.held.clear()
  }

  resize() {
    const r = this.stage.getBoundingClientRect()
    this.view.resize(r.width, r.height)
    this.uiCanvas.width = Math.round(r.width * devicePixelRatio)
    this.uiCanvas.height = Math.round(r.height * devicePixelRatio)
  }

  /** one 60 Hz frame */
  private step() {
    const all = this.input.pollAll()
    const gamepads = [...all.gamepads.values()]
    const merged = gamepads.reduce((a, b) => Input.merge(a, b), all.kbm)
    this.pad = merged
    const pads: Pads = { kbm: all.kbm, gamepads, merged }
    this.frame++
    const view = this.view
    const cursors: Cursor[] | null = this.session.cursors ?? null
    // DOM screens with pointer focus, the pre-game screens, pause menu and scene fades own the
    // frame; the aiming cursors hide (RPTnkScene::pauseCallBack sets their display mode to 0)
    // [net] online sessions handle Esc / pre-game themselves (and the pre-game screens close)
    if (this.session.hudInput && this.hud.preGame.active) this.hud.preGame.close()
    if (this.router.modal || (this.session.hudInput ? this.session.hudInput(merged) : this.hud.input(merged))) {
      for (let i = 0; i < 4; i++) view.updateCursor(i, { x: 0, y: 0, visible: false, mode: 0 }, null)
      view.stepCursorFx()
      return
    }
    this.session.step(pads)
    view.stepFx()
    const game = this.game
    const w = game.world
    for (let i = 0; i < 4; i++) {
      const c: Cursor = cursors?.[i] ?? { x: 0, y: 0, clamped: false, far: false, visible: false }
      const t = w?.playerTanks[i]
      const on = i < game.players && game.state !== 0 && !game.paused
      view.updateCursor(i, { ...c, visible: c.visible && on, mode: game.cursorMode(i, c.clamped || c.far) }, t ? view.projectToLayout(t.pos.x, t.pos.y + 17.6, t.pos.z) : null)
    }
    view.stepCursorFx()
    // held loops (rocket shells, mine fuse) stop when the simulation stops asking for them
    for (const [k, h] of this.held)
      if (h.seen < this.frame) {
        this.audio.loop('hold' + k, h.name, 0)
        this.held.delete(k)
      }
  }

  private render() {
    if (!this.router.opaque) {
      this.view.sync()
      this.view.render()
    }
    const ctx = this.uiCanvas.getContext('2d')!
    const W = this.uiCanvas.width
    const H = this.uiCanvas.height
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, W, H)
    if (!this.router.opaque) {
      ctx.setTransform(W / LAYOUT_W, 0, 0, -H / LAYOUT_H, W / 2, H / 2)
      this.presenter.draw(ctx, LAYOUT_W / 608)
      this.hud.draw(ctx)
    }
    this.router.update()
    this.debug.update()
    this.gl.style.cursor = this.hud.wantsPointer || this.router.modal ? 'default' : 'none'
  }

  // ---- AppContext ------------------------------------------------------------------

  show(id: string | null, params?: Record<string, unknown>) {
    this.router.show(id, params)
  }
  get screen() {
    return this.router.id
  }
  setSession(s: Session) {
    this.session.dispose?.()
    this.session = s
  }
  playClassic(players: number, mission = 0) {
    this.show(null)
    this.setSession(new LocalSession(this.game))
    this.game.newGame(players, mission, undefined, null)
  }
  playPack(pack: LevelPack, players: number, level = 0) {
    this.show(null)
    this.setSession(new LocalSession(this.game))
    this.game.newGame(players, level, undefined, pack)
  }
  toMenu() {
    this.setSession(new LocalSession(this.game))
    this.game.quitToTitle()
    this.show('menu')
  }
  api(path: string, init?: RequestInit) {
    return fetch(`/api${path}`, init)
  }
}
