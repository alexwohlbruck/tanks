import { Audio } from './audio/audio'
import { Game, padToIntent, pointerToScreen, screenToField } from './game'
import { Input, type PadState } from './input'
import { Models } from './render/models'
import { SceneView } from './render/scene'
import { FPS } from './sim/consts'
import { Hud } from './ui/hud'
import { screenFilter, UiPresenter } from './ui/presenter'
import { loadPlayerData } from './ui/shared/save'

const stage = document.getElementById('stage')!
const gl = document.getElementById('gl') as HTMLCanvasElement
const uiCanvas = document.getElementById('ui') as HTMLCanvasElement
const params = new URLSearchParams(location.search)

/** layout space: 832 x 456 in 16:9, panes with locationAdjust spread by 832/608 */
const LAYOUT_W = 832
const LAYOUT_H = 456

async function main() {
  const game = new Game()
  const models = new Models()
  const audio = new Audio()
  const input = new Input(stage)
  let pad: PadState = Input.merge(input.pollAll().kbm)
  /** per-player pads: 1P = keyboard/mouse + first gamepad; 2P = keyboard/mouse (or pad 1) and the next pad */
  let pads: PadState[] = [pad, pad]

  const view = new SceneView(gl, models)
  // held loops (rocket shells, mine fuse) by key, refreshed by the simulation every frame
  const held = new Map<number, { name: string; seen: number }>()
  const stopHeld = () => {
    for (const k of held.keys()) audio.loop('hold' + k, '', 0)
    held.clear()
  }
  const presenter = new UiPresenter({
    project: (x, y, z) => view.projectToLayout(x, y, z),
    se: (id) => {
      const n = audio.nameOf(id)
      if (n) audio.play(n)
    },
    seName: (name) => audio.play(name),
    fanfare: (name) => audio.playMusic(name),
    confirm: () => pad.fire || pad.mine || pad.confirm || pad.back,
    menu: () => hud.mi,
    screenFade: (t) => (gl.style.filter = t > 0 ? screenFilter(t, gl.clientHeight) : ''),
    // RPPartyPlayerData medal >= 3 (gold) lifts the 20-mission cap of later runs
    medalSaved: (medal) => (game.options.goldMedal = medal >= 3 || params.has('gold')),
  })
  const hud: Hud = new Hud(uiCanvas, game, presenter, {
    se: (name) => audio.play(name),
    fanfare: (name) => audio.playMusic(name),
    music: (name, frames = 0) => {
      if (!name) audio.stopMusic(frames / FPS)
      else if (audio.musicName !== name) audio.playMusic(name)
    },
    pauseAudio: (paused) => {
      audio.musicBus.gain.setTargetAtTime(paused ? 0 : 1, audio.ctx.currentTime, 0.02)
      if (paused) stopHeld()
    },
    stopSounds: () => {
      audio.stopMusic()
      stopHeld()
    },
  })
  await Promise.all([game.load(), models.load(), audio.load(), presenter.load(), hud.load()])
  await view.init()
  presenter.bind(game)
  game.presenter = presenter
  game.options.goldMedal = loadPlayerData().medal >= 3 || params.has('gold')

  // ---- audio: brsar labels straight from the simulation ----
  let frame = 0
  const pan = (p?: { x: number; z: number }) => (p ? Math.max(-1, Math.min(1, p.x / 468)) * 0.6 : 0)
  game.audio = {
    // *_CSPK sounds come out of the Wii Remote speaker on the console; play them quieter
    se: (name, pos) => audio.play(name, { pan: pan(pos), volume: name.endsWith('_CSPK') ? 0.5 : 1 }),
    seHold: (name, key, pos) => {
      const h = held.get(key)
      if (!h) audio.loop('hold' + key, name, 1)
      held.set(key, { name, seen: frame })
      void pos
    },
    bgm: (name) => {
      if (name === 'RP_TNK_BGM_LOOP2') audio.playMusic(name, audio.layersFor(audio.pendingMask)).then(() => audio.setTrackMask(audio.pendingMask))
      else audio.playMusic(name)
    },
    bgmStop: (f) => audio.stopMusic(f / FPS),
    bgmTrackMask: (mask) => audio.setTrackMask(mask),
  }

  game.listener = {
    onWorld: (w) => view.setWorld(w),
    onEvents: (ev) => view.onEvents(ev),
    onPhase: () => {},
  }

  const resize = () => {
    const r = stage.getBoundingClientRect()
    view.resize(r.width, r.height)
    uiCanvas.width = Math.round(r.width * devicePixelRatio)
    uiCanvas.height = Math.round(r.height * devicePixelRatio)
  }
  addEventListener('resize', resize)
  resize()

  /** stage pointer [0,1]^2 -> Wii pointer units (x right, y down, both in half screen widths) */
  const wiiPointer = (p: { x: number; y: number }) => ({ x: p.x * 2 - 1, y: (p.y * 2 - 1) * (LAYOUT_H / LAYOUT_W) })
  const cursors = [0, 1].map(() => ({ x: 0, y: 0, clamped: false, far: false, visible: false }))

  let acc = 0
  let last = performance.now()
  const dt = 1000 / FPS
  function step() {
    const all = input.pollAll()
    const gps = [...all.gamepads.values()]
    pad = gps.reduce((a, b) => Input.merge(a, b), all.kbm)
    if (game.players === 1) pads = [pad, pad]
    else if (gps.length >= 2) pads = [Input.merge(all.kbm, gps[0]), gps[1]]
    else pads = [all.kbm, gps[0] ?? Input.merge(all.kbm)]
    frame++
    // pre-game screens, pause menu and scene fades own the frame; the aiming cursors hide
    // (RPTnkScene::pauseCallBack sets their display mode to 0)
    if (hud.input(pad)) {
      for (let i = 0; i < 2; i++) view.updateCursor(i, { ...cursors[i], visible: false, mode: 0 }, null)
      view.stepCursorFx()
      return
    }
    game.tick((w) => {
      for (let i = 0; i < game.players; i++) {
        const t = w.playerTanks[i]
        const pd = pads[i]
        const cur = cursors[i]
        const ptr = pd.pointer ? wiiPointer(pd.pointer) : null
        let aim: { x: number; z: number } | null = null
        if (ptr) {
          const s = pointerToScreen(ptr.x, ptr.y, game.aspect, t.lives ? t : null)
          Object.assign(cur, s, { visible: true })
          aim = screenToField(s.x, s.y)
        } else cur.visible = false
        padToIntent(t, pd, aim)
      }
    })
    view.stepFx()
    const w = game.world
    for (let i = 0; i < 2; i++) {
      const c = cursors[i]
      const t = w?.playerTanks[i]
      const on = i < game.players && game.state !== 0 && !game.paused
      view.updateCursor(i, { ...c, visible: c.visible && on, mode: game.cursorMode(i as 0 | 1, c.clamped || c.far) }, t ? view.projectToLayout(t.pos.x, t.pos.y + 17.6, t.pos.z) : null)
    }
    view.stepCursorFx()
    // held loops (rocket shells, mine fuse) stop when the simulation stops asking for them
    for (const [k, h] of held)
      if (h.seen < frame) {
        audio.loop('hold' + k, h.name, 0)
        held.delete(k)
      }
  }

  function render(now: number) {
    acc += Math.min(250, now - last)
    last = now
    while (acc >= dt) {
      acc -= dt
      step()
    }
    view.sync()
    view.render()
    const ctx = uiCanvas.getContext('2d')!
    const W = uiCanvas.width
    const H = uiCanvas.height
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, W, H)
    ctx.setTransform(W / LAYOUT_W, 0, 0, -H / LAYOUT_H, W / 2, H / 2)
    presenter.draw(ctx, LAYOUT_W / 608)
    hud.draw(ctx)
    gl.style.cursor = hud.wantsPointer ? 'default' : 'none'
    requestAnimationFrame(render)
  }
  requestAnimationFrame(render)

  if (params.has('mission')) game.newGame(params.get('p2') ? 2 : 1, Number(params.get('mission')) - 1)
  ;(window as unknown as { game: Game; audio: Audio }).game = game
  ;(window as unknown as { audio: Audio }).audio = audio
}

main().catch((e) => {
  console.error(e)
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#f88;position:fixed;top:0;white-space:pre-wrap">${e?.stack ?? e}</pre>`)
})
