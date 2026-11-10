// RPSysPauseMgr / RPSysPauseMenu (pause_00: Continue / Start over / Quit, the original game's three-button
// version with D-pad and pointer selection) and RPPauseTextLyt (ptPauseText_00, the "+ Pause" hint).

import { loadLayout, Lyt, msg } from '../lyt'
import { animLen, hitPane, type MenuInput, type SoundHost } from './common'
import { PadCursor } from './padCursor'

const BUTTONS = ['N_choicesF_00', 'N_choicesS_00', 'N_choicesT_00']
const BOUNDS = ['B_choicesF_00', 'B_choicesS_00', 'B_choicesT_00']
const TEXTS = ['T_choicesF_00', 'T_choicesS_00', 'T_choicesT_00']
/** common_message 750 / 751 / 752 */
const MESSAGES = [750, 751, 752]

export class PauseMenu {
  l!: Lyt
  cursor = new PadCursor()
  /** RPSysPauseMgr::isPause */
  open = false
  /** 1 opening, 2 selecting, 4 pushed, 8 closing (mUNK_0x74) */
  private phase = 0
  private counter = 0
  private pointing = false
  private padMode = true
  private pointed = 0
  private padNext = 0
  private sel = 0
  private lit = [false, false, false]
  private wasLit = [false, false, false]
  /** frames during which pointing is ignored (a button animation is playing) */
  private hold = 0
  private result = -1

  constructor(private snd: SoundHost) {}

  async load() {
    this.l = new Lyt(await loadLayout('pause_00'))
    await this.cursor.load()
  }

  private prepare() {
    this.l.reset()
    // The original (PartyPack) hides the dark backdrop
    this.l.setVisible('N_bg_00', false)
    TEXTS.forEach((t, i) => this.l.setText(t, msg(MESSAGES[i], 0)))
  }

  /** RPSysPauseMgr::checkStart + RPSysPauseMenu::open */
  start(input: MenuInput) {
    this.prepare()
    this.open = true
    this.result = -1
    this.pointing = false
    this.padMode = true
    this.hold = 0
    this.lit = [false, false, false]
    this.wasLit = [false, false, false]
    this.pointed = this.padNext = this.sel = 0
    this.phase = 1
    this.counter = animLen(this.l, 'pause_00_in_00')
    this.l.play('pause_00_in_00', { key: 'center', bind: 'N_center_00' })
    BUTTONS.forEach((b, i) => this.l.play('pause_00_active_00', { key: 'btn' + i, bind: b, frame: 0, rate: 0 }))
    this.cursor.reset()
    this.cursor.active = false
    this.readInput(input)
    this.snd.se('RP_COM_GAME_SE_PAUSE_01_TVSP')
  }

  private readInput(input: MenuInput) {
    if (this.hold === 0) {
      const i = BOUNDS.findIndex((b) => hitPane(this.l, b, input.pointer))
      this.pointing = i >= 0
      if (this.pointing) this.pointed = i
    }
    let moved = false
    if (input.up) {
      this.padNext = (this.sel + 2) % 3
      moved = true
    } else if (input.down) {
      this.padNext = (this.sel + 4) % 3
      moved = true
    } else if (input.left || input.right) moved = true
    return moved
  }

  private updateHighlight(moved: boolean) {
    this.lit = [false, false, false]
    if (this.pointing) {
      this.sel = this.pointed
      this.lit[this.pointed] = true
      if (!this.wasLit[this.sel]) this.snd.se('RP_COM_GAME_SE_PAUSE_Cursor_01')
      this.padMode = false
    } else if (moved) {
      if (this.padMode) {
        if (this.sel !== this.padNext) {
          this.sel = this.padNext
          this.snd.se('RP_COM_GAME_SE_PAUSE_Cursor_01')
        }
      } else {
        this.padMode = true
        this.snd.se('RP_COM_GAME_SE_PAUSE_Cursor_01')
      }
    }
    if (this.padMode) this.lit[this.sel] = true
    for (let i = 0; i < 3; i++) {
      if (this.lit[i] !== this.wasLit[i]) {
        // highlight: active_00 forward from 0; unhighlight: EPlayMode_Reset from the last frame,
        // which snaps back to frame 0
        this.l.play('pause_00_active_00', { key: 'btn' + i, bind: BUTTONS[i], frame: 0, rate: this.lit[i] ? 1 : 0 })
        this.hold = animLen(this.l, 'pause_00_active_00') - 1
      }
      this.wasLit[i] = this.lit[i]
    }
  }

  private decide() {
    this.phase = 4
    this.l.play('pause_00_push_00', { key: 'push', bind: BUTTONS[this.sel] })
    this.hold = this.counter = animLen(this.l, 'pause_00_push_00') - 1
    this.snd.se(['RP_COM_GAME_SE_PAUSE_KEY_A_01_TVSP', 'RP_COM_GAME_SE_PAUSE_KEY_A_02_TVSP', 'RP_COM_GAME_SE_PAUSE_KEY_A_03_TVSP'][this.sel])
    this.padMode = false
  }

  /** RPSysPauseMenu::calc: -1 while open, else the choice (0 continue, 1 start over, 2 quit) */
  calc(input: MenuInput): number {
    if (this.hold > 0) this.hold--
    switch (this.phase) {
      case 1:
        if (this.counter === 0) {
          this.phase = 2
          this.updateHighlight(this.readInput(input))
          this.cursor.active = this.padMode
        } else this.counter--
        break
      case 2: {
        this.updateHighlight(this.readInput(input))
        if (input.plus) {
          // + closes the menu as Continue
          if (this.sel !== 0) {
            this.l.play('pause_00_active_00', { key: 'btn' + this.sel, bind: BUTTONS[this.sel], frame: 0, rate: 0 })
            this.wasLit[this.sel] = false
            this.sel = 0
          }
          this.decide()
        } else if (input.a && (this.pointing || this.padMode)) this.decide()
        this.cursor.active = this.padMode
        break
      }
      case 4:
        if (this.counter === 0) {
          this.phase = 8
          // The original always plays the closing animation (another game's path skips it)
          this.l.play('pause_00_out_00', { key: 'center', bind: 'N_center_00' })
          this.counter = animLen(this.l, 'pause_00_out_00') - 1
          // resetButtonAnims: the chosen button stays lit, the others go back to frame 0
          BUTTONS.forEach((b, i) => {
            const n = animLen(this.l, 'pause_00_active_00')
            this.l.play('pause_00_active_00', { key: 'btn' + i, bind: b, frame: i === this.sel ? n - 1 : 0, rate: 0 })
          })
        } else this.counter--
        break
      case 8:
        if (this.counter === 0) {
          this.result = this.sel
          this.counter = -1
        } else if (this.counter > 0) this.counter--
        break
    }
    this.l.calc()
    this.cursor.setTarget(this.l, BOUNDS[this.sel])
    this.cursor.calc()
    if (this.result >= 0) {
      this.open = false
      return this.result
    }
    return -1
  }

  draw(ctx: CanvasRenderingContext2D, wideX: number) {
    if (!this.open) return
    this.l.draw(ctx, wideX)
    this.cursor.draw(ctx, wideX)
  }
}

/** RPPauseText / RPPauseTextLyt for player 1 (the Tanks game manager only ever enables P1's) */
export class PauseText {
  l!: Lyt
  enabled = false
  /** 0 idle, 1 in, 2 shown, 3 out */
  private state = 0

  async load() {
    this.l = new Lyt(await loadLayout('ptPauseText_00'))
    this.reset()
  }

  reset() {
    this.l.reset()
    this.l.setText('T_pause_00', msg(0x2383))
    this.l.setText('T_pause_01', msg(0x2383))
    this.l.setVisible('N_pause_00', false)
    this.l.setVisible('N_pause_01', false)
    this.enabled = false
    this.state = 0
  }

  calc() {
    switch (this.state) {
      case 0:
        if (this.enabled) {
          this.l.setVisible('N_pause_00', true)
          this.l.play('ptPauseText_00_in_00', { key: 'a', bind: 'N_pause_00' })
          this.state = 1
        }
        break
      case 1:
        if (this.l.done('a')) this.state = 2
        break
      case 2:
        if (!this.enabled) {
          this.l.play('ptPauseText_00_out_00', { key: 'a', bind: 'N_pause_00' })
          this.state = 3
        }
        break
      case 3:
        if (this.l.done('a')) {
          this.l.setVisible('N_pause_00', false)
          this.state = 0
        }
        break
    }
    if (this.state !== 0) this.l.calc()
  }

  draw(ctx: CanvasRenderingContext2D, wideX: number) {
    if (this.state !== 0) this.l.draw(ctx, wideX)
  }
}
