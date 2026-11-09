// App bootstrap: loads the game, renderer, audio and UI, owns the 60 Hz loop and routes
// between DOM screens (menus, editor, lobby) and the game.
//
// Two front ends share the game:
// - modern (default): the window is filled at any aspect, the 2D layouts render as vectors
//   at device resolution, and the menus are DOM screens (src/ui/web: title, menu, settings,
//   pause, results, credits) over an attract-mode match;
// - classic (Settings > "Classic Wii UI", or ?classic): the 16:9 TV picture with Wii Play's
//   own pre-game, pause and result screens and bitmap fonts.

import { Vector3 } from 'three/webgpu'
import { Audio } from '../audio/audio'
import { Game } from '../game'
import { Input, type PadState } from '../input'
import type { LevelPack } from '../levels/format'
import { Models } from '../render/models'
import { SceneView } from '../render/scene'
import { FPS } from '../sim/consts'
import type { Tank } from '../sim/world'
import { DebugPanel } from '../ui/debug'
import { Hud } from '../ui/hud'
import { lytOptions, setLytResolution } from '../ui/lyt'
import { screenFilter, UiPresenter } from '../ui/presenter'
import { loadPlayerData } from '../ui/shared/save'
import { DemoSession } from '../ui/web/demo'
import { applyModernMessages } from '../ui/web/messages'
import { feedMenuPad } from '../ui/web/nav'
import { classicUi, onSettings, settings, type Settings } from '../ui/web/settings'
import { loadVectorFont } from '../ui/web/vectorText'
import '../ui/web/screens'
import { hasScreen, Router } from './router'
import { LocalSession, type AimFn, type Cursor } from './session'
import type { AppContext, Pads, Session } from './types'
// [net] online play: registers the 'lobby' and 'net-hud' screens (src/net/index.ts)
import { handleJoinParam } from '../net'

/** RPTnkCursor: the cursor line to the tank appears this far (layout units) from it */
const FAR = 480
/** turret plane the pointer is cast onto (RPTnkCursor::CalcWorldPos) */
const AIM_Y = 17.6
/** RPTnkGameManager states during which + opens the pause menu */
const PAUSABLE = (s: number) => s >= 1 && s <= 10

export class App implements AppContext {
  game = new Game()
  models = new Models()
  audio = new Audio()
  input: Input
  view: SceneView
  presenter: UiPresenter
  /** Wii Play's pre-game / pause screens (classic UI only) */
  hud: Hud | null = null
  router: Router
  debug!: DebugPanel
  session: Session
  params = new URLSearchParams(location.search)
  /** the original Wii Play front end (see the header) */
  readonly classic = classicUi()
  private pad: PadState
  private frame = 0
  /** held loops (rocket shells, mine fuse) by key, refreshed by the simulation every frame */
  private held = new Map<number, { name: string; seen: number }>()
  private musicVol: GainNode
  private sfxVol: GainNode
  private pauseBtn: HTMLElement | null
  private syncFailed = false

  constructor(
    private stage: HTMLElement,
    private gl: HTMLCanvasElement,
    private uiCanvas: HTMLCanvasElement,
    screens: HTMLElement,
  ) {
    document.body.classList.toggle('classic', this.classic)
    document.body.classList.toggle('modern', !this.classic)
    lytOptions.vectorText = lytOptions.hiresTextures = lytOptions.coverScreen = !this.classic
    this.input = new Input(stage)
    this.input.keyBindings = settings.keys
    this.pad = Input.merge(this.input.pollAll().kbm)
    this.view = new SceneView(gl, this.models)
    this.router = new Router(screens, () => this)
    // clicks on menus are not shots: keep them from the stage's game input
    screens.addEventListener('pointerdown', (e) => e.stopPropagation())
    const game = this.game
    const audio = this.audio
    // volume settings sit between the buses and the master (musicBus is also the pause mute)
    this.musicVol = audio.ctx.createGain()
    this.sfxVol = audio.ctx.createGain()
    audio.musicBus.disconnect()
    audio.sfxBus.disconnect()
    audio.musicBus.connect(this.musicVol).connect(audio.master)
    audio.sfxBus.connect(this.sfxVol).connect(audio.master)
    this.applySettings(settings)
    onSettings((s) => this.applySettings(s))
    this.presenter = new UiPresenter({
      project: (x, y, z) => this.view.projectToLayout(x, y, z),
      se: (id) => {
        const n = audio.nameOf(id)
        if (n) audio.play(n)
      },
      seName: (name) => audio.play(name),
      fanfare: (name) => audio.playMusic(name),
      confirm: () => this.pad.fire || this.pad.mine || this.pad.confirm || this.pad.back,
      menu: () => this.hud?.mi ?? { up: false, down: false, left: false, right: false, a: false, b: false, plus: false, ab: false, pointer: null },
      screenFade: (t) => (gl.style.filter = t > 0 ? screenFilter(t, gl.clientHeight) : ''),
      // RPPartyPlayerData medal >= 3 (gold) lifts the 20-mission cap of later runs
      medalSaved: (medal) => (game.options.goldMedal = medal >= 3 || this.params.has('gold')),
    })
    if (!this.classic) this.presenter.web = { results: (players) => this.show('results', { players }) }
    if (this.classic)
      this.hud = new Hud(uiCanvas, game, this.presenter, {
        se: (name) => audio.play(name),
        fanfare: (name) => audio.playMusic(name),
        music: (name, frames = 0) => this.music(name, frames),
        pauseAudio: (paused) => this.pauseAudio(paused),
        stopSounds: () => {
          audio.stopMusic()
          this.stopHeld()
        },
      })
    this.session = new LocalSession(game, this.aim)
    this.pauseBtn = document.getElementById('pause-btn')
    this.pauseBtn?.addEventListener('pointerdown', (e) => e.stopPropagation())
    this.pauseBtn?.addEventListener('click', () => this.pause())
  }

  async start() {
    const { game, audio } = this
    await Promise.all([game.load(), this.models.load(), audio.load(), this.presenter.load(), this.hud?.load(), this.classic ? null : loadVectorFont()])
    await this.view.init()
    // beyond the field's own floor model, the stage's CSS backdrop shows through
    if (!this.classic) {
      this.view.scene.background = null
      this.view.renderer.setClearColor(0x000000, 0)
    }
    this.presenter.bind(game)
    game.presenter = this.presenter
    if (!this.classic) {
      applyModernMessages(settings)
      onSettings((s) => applyModernMessages(s))
    }
    game.options.goldMedal = loadPlayerData().medal >= 3 || this.params.has('gold')
    this.wireGameAudio()
    let fieldW = 0
    game.listener = {
      onWorld: (w) => {
        this.view.setWorld(w)
        // a 4:3 field changes what the camera has to fit
        if (w.width !== fieldW) {
          fieldW = w.width
          this.resize()
        }
      },
      onEvents: (ev) => this.view.onEvents(ev),
      onPhase: () => {},
    }
    addEventListener('resize', () => this.resize())
    // phones report the new size a little after an orientation change
    screen.orientation?.addEventListener('change', () => setTimeout(() => this.resize(), 250))
    this.resize()
    this.debug = new DebugPanel(game, { debugStart: (players, mission) => this.debugStart(players, mission) }, document.body)
    let acc = 0
    let last = performance.now()
    const dt = 1000 / FPS
    let errors = 0
    const loop = (now: number) => {
      // one failing frame must not stop the loop (and with it every screen)
      requestAnimationFrame(loop)
      try {
        acc += Math.min(250, now - last)
        last = now
        while (acc >= dt) {
          acc -= dt
          this.step()
        }
        this.render()
      } catch (e) {
        acc = 0
        if (errors++ < 5) console.error(e)
      }
    }
    requestAnimationFrame(loop)
    if (this.params.has('mission')) this.playClassic(this.params.get('p2') ? 2 : 1, Number(this.params.get('mission')) - 1)
    else if (!this.classic) this.toTitle()
    // [net] ?join=CODE (shared room link) / ?online opens the lobby
    handleJoinParam(this)
    ;(window as unknown as { game: Game; audio: Audio; app: App }).game = game
    ;(window as unknown as { audio: Audio }).audio = audio
    ;(window as unknown as { app: App }).app = this
  }

  private applySettings(s: Settings) {
    const t = this.audio.ctx.currentTime
    this.musicVol.gain.setTargetAtTime(s.music, t, 0.02)
    this.sfxVol.gain.setTargetAtTime(s.sfx, t, 0.02)
    this.input.keyBindings = s.keys
    const dpr = devicePixelRatio || 1
    this.view?.renderer.setPixelRatio(s.quality === 'low' ? Math.min(dpr, 1) * 0.75 : s.quality === 'medium' ? Math.min(dpr, 1.5) : Math.min(dpr, 2))
    if (this.view) this.resize()
  }

  private wireGameAudio() {
    const audio = this.audio
    const pan = (p?: { x: number; z: number }) => (p ? Math.max(-1, Math.min(1, p.x / 468)) * 0.6 : 0)
    // the attract-mode match behind the title and menus plays silently
    const live = () => this.session.kind !== 'demo'
    this.game.audio = {
      // *_CSPK sounds come out of the Wii Remote speaker on the console; play them quieter
      se: (name, pos) => live() && audio.play(name, { pan: pan(pos), volume: name.endsWith('_CSPK') ? 0.5 : 1 }),
      seHold: (name, key) => {
        if (!live()) return
        if (!this.held.has(key)) audio.loop('hold' + key, name, 1)
        this.held.set(key, { name, seen: this.frame })
      },
      bgm: (name) => {
        if (!live()) return
        if (name === 'RP_TNK_BGM_LOOP2') audio.playMusic(name, audio.layersFor(audio.pendingMask)).then(() => audio.setTrackMask(audio.pendingMask))
        else audio.playMusic(name)
      },
      bgmStop: (f) => live() && audio.stopMusic(f / FPS),
      bgmTrackMask: (mask) => live() && audio.setTrackMask(mask),
    }
  }

  /** start a BGM by label (no restart when it is already playing); null stops with a fade */
  music(name: string | null, frames = 0) {
    const audio = this.audio
    if (!name) audio.stopMusic(frames / FPS)
    else if (audio.musicName !== name) audio.playMusic(name)
  }

  /** RPSndAudioMgr::enterPause / exitPause */
  private pauseAudio(paused: boolean) {
    const audio = this.audio
    audio.musicBus.gain.setTargetAtTime(paused ? 0 : 1, audio.ctx.currentTime, 0.02)
    if (paused) this.stopHeld()
  }

  private stopHeld() {
    for (const k of this.held.keys()) this.audio.loop('hold' + k, '', 0)
    this.held.clear()
  }

  resize() {
    const r = this.stage.getBoundingClientRect()
    this.view.resize(r.width, r.height, !this.classic)
    this.uiCanvas.width = Math.round(r.width * devicePixelRatio)
    this.uiCanvas.height = Math.round(r.height * devicePixelRatio)
    setLytResolution(this.uiCanvas.width / (2 * this.view.layoutHalf.x))
  }

  /**
   * Pointer [0,1]^2 over the stage -> the cursor (layout units) and the aim point: modern play
   * casts the pointer through the actual camera onto the turret plane, so it is exact at any
   * window shape; classic play keeps the Wii pointer box and the 480-unit cursor leash.
   */
  private aim: AimFn | undefined = this.classic
    ? undefined
    : (p, tank: Tank | null) => {
        const lh = this.view.layoutHalf
        const nx = p.x * 2 - 1
        const ny = 1 - p.y * 2
        const cam = this.view.camera
        const o = new Vector3(nx, ny, -1).unproject(cam)
        const d = cam.getWorldDirection(new Vector3())
        const k = (AIM_Y - o.y) / d.y
        const cursor = { x: nx * lh.x, y: ny * lh.y, clamped: false, far: false }
        if (tank && tank.lives) {
          const tp = this.view.projectToLayout(tank.pos.x, tank.pos.y + AIM_Y, tank.pos.z)
          cursor.far = Math.hypot(cursor.x - tp.x, cursor.y - tp.y) >= FAR
        }
        return { cursor, world: { x: o.x + d.x * k, z: o.z + d.z * k } }
      }

  /** one 60 Hz frame */
  private step() {
    const all = this.input.pollAll()
    const gamepads = [...all.gamepads.values()]
    const merged = gamepads.reduce((a, b) => Input.merge(a, b), all.kbm)
    this.pad = merged
    const pads: Pads = { kbm: all.kbm, gamepads, merged }
    // gamepad menu navigation (keyboard and pointer go through DOM events)
    for (const g of gamepads) feedMenuPad(g)
    this.frame++
    const view = this.view
    const game = this.game
    const cursors: Cursor[] | null = this.session.cursors ?? null
    const hideCursors = () => {
      for (let i = 0; i < 4; i++) view.updateCursor(i, { x: 0, y: 0, visible: false, mode: 0 }, null)
      view.stepCursorFx()
    }
    if (this.session.hudInput) {
      // [net] online sessions handle Esc / pre-game themselves (and the pre-game screens close)
      if (this.classic && this.hud?.preGame.active) this.hud.preGame.close()
      if (this.router.modal || this.session.hudInput(merged)) return hideCursors()
    } else if (this.classic) {
      // DOM screens with pointer focus, the pre-game screens, pause menu and scene fades own the
      // frame; the aiming cursors hide (RPTnkScene::pauseCallBack sets their display mode to 0)
      if (this.router.modal || this.hud!.input(merged)) return hideCursors()
    } else {
      const demo = this.session.kind === 'demo'
      if (this.router.modal && !demo) return hideCursors()
      // + / Esc / P opens the pause menu while the game manager allows it
      if (this.session.kind === 'local' && merged.pause && !this.router.id && PAUSABLE(game.state) && this.presenter.pauseEnabled && !game.paused) {
        this.pause()
        return hideCursors()
      }
      // quitting from the results screen returns the game to its idle state
      if (!demo && game.state === 0 && this.session.kind === 'local' && this.router.id !== 'results' && !this.router.modal) {
        this.toMenu()
        return hideCursors()
      }
    }
    this.session.step(pads)
    view.stepFx()
    const w = game.world
    const showCursors = this.session.kind !== 'demo'
    for (let i = 0; i < 4; i++) {
      const c: Cursor = cursors?.[i] ?? { x: 0, y: 0, clamped: false, far: false, visible: false }
      const t = w?.playerTanks[i]
      const on = showCursors && i < game.players && game.state !== 0 && !game.paused
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
      try {
        this.view.sync()
      } catch (e) {
        // a scene object that fails to build should not take the picture and the UI down
        if (!this.syncFailed) console.error(e)
        this.syncFailed = true
      }
      this.view.render()
    }
    const ctx = this.uiCanvas.getContext('2d')!
    const W = this.uiCanvas.width
    const H = this.uiCanvas.height
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, W, H)
    const demo = this.session.kind === 'demo'
    // the results screen replaces the layouts' result list
    if (!this.router.opaque && !demo && this.router.id !== 'results') {
      const lh = this.view.layoutHalf
      ctx.imageSmoothingQuality = this.classic ? 'low' : 'high'
      ctx.setTransform(W / (2 * lh.x), 0, 0, -H / (2 * lh.y), W / 2, H / 2)
      // panes flagged locationAdjust keep their distance from the screen's side edges
      this.presenter.draw(ctx, lh.x / 304)
      this.hud?.draw(ctx)
    }
    this.router.update()
    this.debug.update()
    const playing = !this.router.id && PAUSABLE(this.game.state) && !demo
    const local = this.session.kind === 'local'
    this.gl.style.cursor = this.hud?.wantsPointer || this.router.modal || !playing ? 'default' : 'none'
    if (this.pauseBtn) this.pauseBtn.hidden = this.classic || !playing || !local || !this.presenter.pauseEnabled
  }

  // ---- modern front end ------------------------------------------------------------

  /** the title screen over an attract-mode match */
  toTitle() {
    this.startDemo()
    this.show('title')
  }

  private startDemo() {
    if (this.session.kind !== 'demo') {
      this.stopHeld()
      this.audio.stopMusic()
      this.setSession(new DemoSession(this.game))
    }
    this.music('RP_COMMON_BGM_PARTY_MENU')
  }

  /** in-game pause overlay ('pause' screen) */
  pause() {
    const g = this.game
    if (this.classic || g.paused || !PAUSABLE(g.state) || !this.presenter.pauseEnabled) return
    g.paused = true
    this.pauseAudio(true)
    this.audio.play('RP_COM_GAME_SE_PAUSE_01_TVSP')
    this.show('pause')
  }

  /** close the pause overlay */
  resume() {
    if (!this.game.paused) return
    this.game.paused = false
    this.pauseAudio(false)
    this.show(null)
  }

  /** "Restart" in the pause menu: the same run from its first mission */
  restart() {
    const g = this.game
    g.paused = false
    this.pauseAudio(false)
    this.stopHeld()
    this.audio.stopMusic()
    this.show(null)
    this.setSession(new LocalSession(g, this.aim))
    g.newGame(g.players, 0)
  }

  /** the results screen's buttons: 0 play again, 1 back to the menu */
  resultChoice(c: 0 | 1) {
    this.presenter.choose(c)
    // 1: the game manager returns to its idle state, and step() opens the menu
    this.show(null)
  }

  private debugStart(players: 1 | 2, mission: number) {
    if (this.hud) return this.hud.debugStart(players, mission)
    this.game.paused = false
    this.pauseAudio(false)
    this.playClassic(players, mission)
  }

  // ---- AppContext ------------------------------------------------------------------

  show(id: string | null, params?: Record<string, unknown>) {
    this.router.show(id, params)
    // keys and clicks that changed the screen are not game input
    this.input.pollAll()
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
    this.stopHeld()
    this.audio.stopMusic()
    this.setSession(new LocalSession(this.game, this.aim))
    this.game.paused = false
    this.pauseAudio(false)
    this.game.newGame(players, mission, undefined, null)
  }
  playPack(pack: LevelPack, players: number, level = 0) {
    this.show(null)
    this.stopHeld()
    this.audio.stopMusic()
    this.setSession(new LocalSession(this.game, this.aim))
    this.game.paused = false
    this.pauseAudio(false)
    this.game.newGame(players, level, undefined, pack)
  }
  toMenu() {
    this.game.paused = false
    this.pauseAudio(false)
    if (this.classic) {
      this.setSession(new LocalSession(this.game, this.aim))
      this.game.quitToTitle()
      this.show(null)
      return
    }
    this.startDemo()
    this.show('menu')
  }
  api(path: string, init?: RequestInit) {
    return fetch(`/api${path}`, init)
  }
  /** whether a screen id is registered (menu entries for screens other modules provide) */
  hasScreen(id: string) {
    return hasScreen(id)
  }
}
