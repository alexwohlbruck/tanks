// Wii Play's shared screens around the Tanks scene that are not driven by the game manager:
// the pre-game flow (player count, how-to-play card), the pause menu (RPSysPauseMgr) and the
// scene-change fader. The result screens (medal, VS winner, result menu) live in the presenter,
// which the game manager drives. Drawn in layout space (832 x 456, origin centre, y up).

import type { Game } from '../game'
import type { PadState } from '../input'
import type { UiPresenter } from './presenter'
import { LAYOUT_H, LAYOUT_W, NO_INPUT, WIDE_X, type MenuInput, type SoundHost } from './shared/common'
import { PauseMenu } from './shared/pause'
import { PreGame } from './shared/preGame'

export type HudEnv = SoundHost & {
  /** start a BGM by label (no restart when it is already playing); null stops with a fade */
  music(name: string | null, fadeFrames?: number): void
  /** RPSndAudioMgr::enterPause / exitPause */
  pauseAudio(paused: boolean): void
  /** stopAllSoundOnPauseOff ("Start over" / "Quit") */
  stopSounds(): void
}

export class Hud {
  preGame: PreGame
  pause: PauseMenu
  /** this frame's menu input (shared with the presenter's result screens) */
  mi: MenuInput = NO_INPUT
  private pointerActive = false
  private lastPointer: { x: number; y: number } | null = null
  private clicked = false
  private prevState = -1
  /** where the pre-game flow starts the next time the game returns to state 0 */
  private entry: 'num' | 'info' = 'num'

  constructor(
    canvas: HTMLCanvasElement,
    private game: Game,
    private presenter: UiPresenter,
    private env: HudEnv,
  ) {
    this.pause = new PauseMenu(env)
    this.preGame = new PreGame(env, {
      start: (players) => this.game.newGame(players, 0),
      fadeOut: (then) => this.presenter.fader.out(then),
      music: (name, frames) => this.env.music(name, frames),
    })
    // a click points at the screen even if the mouse has not moved since a key was pressed
    ;(canvas.parentElement ?? canvas).addEventListener('pointerdown', () => (this.clicked = true))
  }

  load() {
    return Promise.all([this.pause.load(), this.preGame.load()])
  }

  /** Wii pointer semantics: the pointer selects while it moves; D-pad presses hand over to the pad. */
  private makeInput(pad: PadState): MenuInput {
    const p = pad.pointer ? { x: (pad.pointer.x - 0.5) * LAYOUT_W, y: (0.5 - pad.pointer.y) * LAYOUT_H } : null
    const last = this.lastPointer
    if (p && (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1.5)) this.pointerActive = true
    if (this.clicked && p) this.pointerActive = true
    if (pad.up || pad.down || pad.left || pad.right) this.pointerActive = false
    this.lastPointer = p
    this.clicked = false
    return {
      up: pad.up,
      down: pad.down,
      left: pad.left,
      right: pad.right,
      a: pad.confirm,
      b: pad.back,
      plus: pad.pause,
      ab: pad.confirm || pad.back || pad.fire || pad.mine,
      pointer: this.pointerActive ? p : null,
    }
  }

  /** Per 60 Hz frame. Returns true when a screen owns the frame (the game is not ticked). */
  input(pad: PadState): boolean {
    const g = this.game
    const mi = (this.mi = this.makeInput(pad))
    const fader = this.presenter.fader
    fader.calc()
    // the pre-game screens are the game's idle state: "Play a different game" returns to the
    // Tanks card, everything else (boot, pause menu "Quit") to the player count
    if (g.state === 0) {
      if (!this.preGame.active && !fader.closing) {
        this.preGame.open(this.prevState === 12 ? 'info' : this.entry, g.players)
        this.entry = 'num'
        this.prevState = 0
      }
    } else {
      if (this.preGame.active) this.preGame.close()
      this.prevState = g.state
    }

    if (this.pause.open) {
      const r = this.pause.calc(mi)
      if (r === 0) {
        g.paused = false
        this.env.pauseAudio(false)
      } else if (r === 1 || r === 2) {
        // RPSysPauseMgr: restart the scene / go back to the party menu, through black
        this.env.stopSounds()
        fader.out(() => {
          g.paused = false
          this.env.pauseAudio(false)
          if (r === 1) g.newGame(g.players, 0)
          else {
            this.entry = 'num'
            g.quitToTitle()
          }
        })
      }
      return true
    }
    if (fader.closing) return true
    if (g.state === 0) {
      this.preGame.calc(mi)
      return true
    }
    // RPSysPauseMgr::checkStart: + opens the menu while the scene allows it
    if (mi.plus && g.state >= 1 && g.state <= 10 && this.presenter.pauseEnabled && !fader.busy) {
      g.paused = true
      this.env.pauseAudio(true)
      this.pause.start(mi)
      return true
    }
    return false
  }

  /** debug: start a mission from any screen (closes the pause menu and pre-game screens) */
  debugStart(players: 1 | 2, mission: number) {
    if (this.pause.open) {
      this.pause.open = false
      this.game.paused = false
      this.env.pauseAudio(false)
    }
    this.env.stopSounds()
    this.preGame.close()
    this.game.newGame(players, mission)
  }

  /** the OS pointer is shown while a menu takes pointer input */
  get wantsPointer() {
    const m = this.presenter.menu.state
    return this.preGame.active || this.pause.open || (m >= 1 && m <= 3)
  }

  draw(ctx: CanvasRenderingContext2D) {
    if (this.preGame.active) this.preGame.draw(ctx, WIDE_X)
    this.pause.draw(ctx, WIDE_X)
    this.presenter.fader.draw(ctx)
  }
}
