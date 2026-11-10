// The screens before Tanks starts, as the original shows them: the player count (RPRimoconEntryLyt,
// rimoconEntry_00 in its 2-player form) and the game info / how-to-play card (RPGameInfoLyt:
// ptSelectGame_01 with ptG8RemoteH_00's N_remote_00 reparented under N_remoteP_00).
// The 3D menu backdrop (PT_menu_BG_model), the Mii dolls and the remote pairing panel have no
// web counterpart: a plain backdrop stands in and the pairing panel is left out.

import { loadLayout, Lyt, msg } from '../lyt'
import { animLen, drawWithHooks, hitPane, LAYOUT_H, LAYOUT_W, Seq, type MenuInput, type SoundHost } from './common'
import { PadCursor } from './padCursor'
import { resetVsSession } from './save'

/** Party game index of Tanks: messages use 9, textures / remote layouts use 8 */
const GAME_MSG = 9

const BUTTONS = ['P_button_04', 'P_button_05']
const BOUNDS = ['B_button_04', 'B_button_05']

/** RPPlayerNumSelect on rimoconEntry_00. States: 0 off, 1 in, 2 select, 3 pushed, 4 out, 5 done */
class PlayerNumSelect {
  l!: Lyt
  seq = new Seq()
  cursor = new PadCursor()
  choice = 0
  private lastChoice = 0
  private usePad = true
  /** activeButton_00 frame / rate per button (forward when lit, backwards when not) */
  private btn = [
    { f: 0, rate: 0 },
    { f: 0, rate: 0 },
  ]

  constructor(private snd: SoundHost) {}

  async load() {
    this.l = new Lyt(await loadLayout('rimoconEntry_00'))
    await this.cursor.load()
  }

  open(players: 1 | 2) {
    const l = this.l
    l.reset()
    l.setText('T_playMenber_00', msg(500))
    l.setText('T_text_04', msg(510))
    l.setText('T_text_05', msg(511))
    // countSelect = false: the 1 / 2 player buttons
    for (const n of ['N_play4_00', 'N_rimo4_00', 'N_rimocon4']) l.setVisible(n, false)
    // no remote pairing on the web
    l.setVisible('N_rimoconBg_00', false)
    this.seq.reset(0)
    this.seq.change(1)
    this.choice = this.lastChoice = players - 1
    this.usePad = true
    this.btn = [
      { f: 0, rate: 0 },
      { f: 0, rate: 0 },
    ]
    this.cursor.reset()
  }

  get done() {
    return this.seq.state === 5
  }

  calc(input: MenuInput) {
    const l = this.l
    this.seq.run(
      (s) => {
        if (s === 1) {
          l.play('rimoconEntry_00_inScene_00', { key: 'scene', bind: 'N_rimoEntry_00' })
          this.snd.se('RP_COMMON_SE_WIN_OPEN_01')
        } else if (s === 3) {
          l.play('rimoconEntry_00_pushButton_00', { key: 'push', bind: BUTTONS[this.choice], force: true })
          this.snd.se('RP_COMMON_SE_KEY_A_02_TVSP')
          this.cursor.active = false
        } else if (s === 4) {
          l.play('rimoconEntry_00_outScene_00', { key: 'scene', bind: 'N_rimoEntry_00' })
          this.snd.se('RP_COMMON_SE_WIN_CLOSE_01')
        }
      },
      (s) => {
        if (s === 1 && l.done('scene')) this.seq.change(2)
        else if (s === 2) this.select(input)
        else if (s === 3 && l.done('push')) this.seq.change(4)
        else if (s === 4 && l.done('scene')) this.seq.change(5)
      },
    )
    const n = animLen(l, 'rimoconEntry_00_activeButton_00')
    this.btn.forEach((b, i) => {
      b.f = Math.max(0, Math.min(n - 1, b.f + b.rate))
      l.play('rimoconEntry_00_activeButton_00', { key: 'btn' + i, bind: BUTTONS[i], force: true, frame: b.f, rate: 0 })
    })
    if (this.seq.state === 3) l.play('rimoconEntry_00_pushButton_00', { key: 'push', bind: BUTTONS[this.choice], force: true, frame: l.frameOf('push'), rate: 1 })
    l.calc()
    // the player panel alone, centred (its slide offset assumes the pairing panel beside it)
    l.setTranslate('N_playerBg_00', 0, 0)
    if (this.usePad && this.seq.state === 2) this.cursor.setTarget(l, BOUNDS[this.choice])
    this.cursor.calc()
  }

  private select(input: MenuInput) {
    const prev = this.choice
    const prevPad = this.usePad
    const hit = BOUNDS.findIndex((b) => hitPane(this.l, b, input.pointer))
    if (this.choice !== -1) this.lastChoice = this.choice
    if (hit !== -1) {
      this.choice = hit
      this.usePad = false
    } else if (!this.usePad) {
      if (input.up || input.down || input.left || input.right) {
        this.usePad = true
        this.choice = this.lastChoice
      } else this.choice = -1
    } else {
      if (input.up) this.choice = 0
      if (input.down) this.choice = 1
    }
    this.btn.forEach((b, i) => (b.rate = i === this.choice ? 1 : -1))
    this.cursor.active = this.usePad
    if (this.choice !== -1 && (this.choice !== prev || (prevPad && !this.usePad) || (this.seq.prev === 1 && this.seq.timer === 0)))
      this.snd.se(this.usePad ? 'RP_COMMON_SE_KEY_CURSOR_01' : 'RP_COMMON_SE_KEY_CURSOR_02')
    if (this.choice !== -1 && input.a) this.seq.change(3)
  }

  draw(ctx: CanvasRenderingContext2D, wideX: number) {
    if (this.seq.state === 0) return
    this.l.draw(ctx, wideX)
    this.cursor.draw(ctx, wideX)
  }
}

/** RPGameInfoLyt. States: 0 off, 1 in, 2 idle, 3 push A, 4 out, 5 closed */
class GameInfo {
  l!: Lyt
  remote!: Lyt
  seq = new Seq()
  /** mConfirmed + the frame at which the scene moves on (pushA length - 20) */
  confirmed = false
  private pushEnd = 0

  constructor(private snd: SoundHost) {}

  async load() {
    const [a, b] = await Promise.all([loadLayout('ptSelectGame_01'), loadLayout('ptG8RemoteH_00')])
    this.l = new Lyt(a)
    this.remote = new Lyt(b)
  }

  /** Open(game): texts for Tanks; T_comment_00 depends on the player count (7001 / 7002) */
  open(players: 1 | 2) {
    const l = this.l
    l.reset()
    this.remote.reset()
    l.setText('T_start_00', msg(7003, 0))
    l.setText('T_gameTitle_00', msg(7000, GAME_MSG))
    l.setText('T_comment_00', msg(players === 1 ? 7001 : 7002, GAME_MSG))
    l.setText('T_step_00', msg(7004, GAME_MSG))
    l.setText('T_step_01', msg(7004, GAME_MSG))
    this.confirmed = false
    this.seq.reset(0)
    this.seq.change(1)
  }

  /** Confirm: true once the A press is accepted */
  confirm() {
    if (!this.seq.settled(2)) return false
    if (this.seq.orNext(3) || this.seq.orNext(5)) return true
    this.confirmed = true
    this.seq.change(3)
    return true
  }

  close() {
    if (this.seq.settled(4) || this.seq.orNext(5)) return
    this.seq.change(4)
  }

  /** the select scene's IsGameInfoConfirmDone */
  get confirmDone() {
    return this.confirmed && this.seq.state === 3 && this.seq.timer > this.pushEnd
  }

  calc() {
    const l = this.l
    this.seq.run(
      (s) => {
        if (s === 1) {
          l.unbindAll()
          l.play('ptSelectGame_01_in_00', { key: 'main' })
          this.remote.unbindAll()
          this.remote.play('ptG8RemoteH_00_remote_00', { key: 'remote', bind: 'N_remote_00', rate: 0, loop: true })
        } else if (s === 2) this.remote.setRate('remote', 1)
        else if (s === 3) {
          l.unbindAll()
          l.play('ptSelectGame_01_pushA_00', { key: 'main' })
          this.pushEnd = animLen(l, 'ptSelectGame_01_pushA_00') - 20
          this.snd.se('RP_COMMON_SE_KEY_A_01_TVSP')
        } else if (s === 4) {
          l.unbindAll()
          l.play('ptSelectGame_01_out_00', { key: 'main' })
        }
      },
      (s) => {
        if (s === 1 && l.done('main')) this.seq.change(2)
        else if (s === 3 && l.done('main')) this.seq.change(2)
        else if (s === 4 && l.done('main')) this.seq.change(5)
      },
    )
    l.calc()
    this.remote.calc()
  }

  draw(ctx: CanvasRenderingContext2D, wideX: number) {
    const s = this.seq.state
    if (s === 0 || s === 5) return
    drawWithHooks(ctx, this.l, wideX, {
      // ptG8RemoteH_00's N_remote_00, reparented under N_remoteP_00
      N_remoteP_00: (c, alpha) => {
        const root = this.remote.L.root
        root.alpha = Math.round(alpha * 255)
        root.influencedAlpha = true
        this.remote.draw(c, wideX)
      },
    })
  }
}

/** Light backdrop standing in for the 3D party-menu background. */
function drawBackdrop(ctx: CanvasRenderingContext2D, t: number) {
  const W = LAYOUT_W
  const H = LAYOUT_H
  ctx.save()
  const g = ctx.createLinearGradient(0, H / 2, 0, -H / 2)
  g.addColorStop(0, '#f7f9fa')
  g.addColorStop(0.6, '#e6ecef')
  g.addColorStop(1, '#cfd8dd')
  ctx.fillStyle = g
  ctx.fillRect(-W / 2 - 2, -H / 2 - 2, W + 4, H + 4)
  // slow diagonal bands
  ctx.globalAlpha = 0.35
  ctx.fillStyle = '#ffffff'
  const off = (t * 0.25) % 96
  for (let x = -W - 96; x < W; x += 96) {
    ctx.beginPath()
    ctx.moveTo(x + off, -H / 2)
    ctx.lineTo(x + off + 40, -H / 2)
    ctx.lineTo(x + off + 40 + H * 0.5, H / 2)
    ctx.lineTo(x + off + H * 0.5, H / 2)
    ctx.closePath()
    ctx.fill()
  }
  ctx.restore()
}

export type PreGameEvents = {
  /** Start Tanks with this many players (called while the screen is black) */
  start(players: 1 | 2): void
  /** scene change through black (RPSysSceneCreator::changeSceneAfterFade) */
  fadeOut(then: () => void): void
  music(name: string | null, fadeFrames?: number): void
}

/** The pre-game flow: player count -> game info -> Tanks. */
export class PreGame {
  num: PlayerNumSelect
  info: GameInfo
  active = false
  players: 1 | 2 = 1
  /** 'num' | 'info' */
  private screen: 'num' | 'info' = 'num'
  private t = 0
  private leaving = false

  constructor(
    private snd: SoundHost,
    private ev: PreGameEvents,
  ) {
    this.num = new PlayerNumSelect(snd)
    this.info = new GameInfo(snd)
  }

  async load() {
    await Promise.all([this.num.load(), this.info.load()])
  }

  /** enter at the player count ('num', the party main menu) or the Tanks card ('info') */
  open(at: 'num' | 'info', players: 1 | 2 = this.players) {
    this.active = true
    this.leaving = false
    this.players = players
    this.screen = at
    if (at === 'num') this.num.open(players)
    else this.info.open(players)
    this.ev.music('RP_COMMON_BGM_PARTY_MENU')
  }

  close() {
    this.active = false
  }

  calc(input: MenuInput) {
    if (!this.active) return
    this.t++
    if (this.screen === 'num') {
      this.num.calc(input)
      if (this.num.done) {
        this.players = (this.num.choice + 1) as 1 | 2
        // a new player count starts a new 2P tally (RPSceneInfo)
        resetVsSession()
        this.screen = 'info'
        this.info.open(this.players)
      }
      return
    }
    const info = this.info
    if (!this.leaving && info.seq.settled(2)) {
      if (input.a) info.confirm()
      else if (input.b || input.plus) {
        this.snd.se('RP_COMMON_SE_KEY_BACK_01_TVSP')
        info.close()
      }
    }
    info.calc()
    if (info.seq.state === 5) {
      this.screen = 'num'
      this.num.open(this.players)
    }
    if (!this.leaving && info.confirmDone) {
      this.leaving = true
      this.ev.music(null, 35)
      this.ev.fadeOut(() => {
        this.active = false
        this.ev.start(this.players)
      })
    }
  }

  draw(ctx: CanvasRenderingContext2D, wideX: number) {
    if (!this.active) return
    drawBackdrop(ctx, this.t)
    if (this.screen === 'num') this.num.draw(ctx, wideX)
    else this.info.draw(ctx, wideX)
  }
}
