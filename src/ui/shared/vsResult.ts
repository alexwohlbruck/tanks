// RPVsWinner (ptVsWinner_00: anchors for the two Mii avatars and the 3D "P1 WINS" / "P2 WINS" /
// "TIE" model) and RPResultMenu (ptGOMenu_00 "Play again" / "Play a different game" with the
// RPCPadCursor, plus ptVsResult_00's running 2P win tally).

import { fullWidth, loadLayout, Lyt, msg } from '../lyt'
import { animLen, hitPane, panePos, plural, Seq, type MenuInput, type SoundHost, WIDE_X } from './common'
import { drawWinnerText } from './medal'
import { drawMiiFigure } from './mii'
import { PadCursor } from './padCursor'
import { vsSession } from './save'

/** RPVsWinner::sPlayerOffsets (x scaled by the 16:9 width ratio) and sTrophyOffset */
const PLAYER_OFFSET = [
  { x: 50, y: 95 },
  { x: -50, y: 95 },
]
const TROPHY_OFFSET = { x: 0, y: -30 }
/** win_xP_0 / win_xP_1 frame counts (CHR0) */
const APPEAR_FRAMES = 64
const LEAVE_FRAMES = 21

/** RPVsWinnerLyt states: 0 off, 1 in, 2 shown, 3 out, 4 done */
class VsWinnerLyt {
  l!: Lyt
  seq = new Seq()

  constructor(private snd: SoundHost) {}

  async load() {
    this.l = new Lyt(await loadLayout('ptVsWinner_00'))
  }
  reset() {
    this.seq.reset(0)
    this.l.reset()
  }
  open() {
    if (this.seq.state === 0) this.seq.change(1)
  }
  close() {
    if (!this.seq.orNext(3) && !this.seq.orNext(4)) this.seq.change(3)
  }
  calc() {
    this.seq.run(
      (s) => {
        if (s === 1) {
          this.l.unbindAll()
          this.l.play('ptVsWinner_00_in_00', { key: 'main' })
          this.snd.se('RP_COM_GAME_SE_2P_WIN_LOSE_01')
        } else if (s === 3) {
          this.l.unbindAll()
          this.l.play('ptVsWinner_00_out_00', { key: 'main' })
        }
      },
      (s) => {
        if (s === 1 && this.l.done('main')) this.seq.change(2)
        else if (s === 3 && this.l.done('main')) this.seq.change(4)
      },
    )
    if (this.seq.state !== 0 && this.seq.state !== 4) this.l.calc()
  }
}

/** RPVsWinner states: 0 off, 1 in, 2 show, 3 close, 4 save, 5 done */
export class VsWinner {
  seq = new Seq()
  lyt: VsWinnerLyt
  winner: -1 | 0 | 1 = -1
  private modelFrame = 0
  private leaveFrame = -1
  private showModel = false
  private t = 0
  private players = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ]
  private trophy = { x: 0, y: 0 }
  private confetti: { x: number; y: number; vx: number; vy: number; r: number; c: string; s: number }[] = []

  constructor(snd: SoundHost) {
    this.lyt = new VsWinnerLyt(snd)
  }

  async load() {
    await this.lyt.load()
    this.reset()
  }

  reset() {
    this.seq.reset(0)
    this.lyt.reset()
    this.showModel = false
    this.leaveFrame = -1
    this.confetti = []
  }

  get state() {
    return this.seq.state
  }
  /** IsStateEntered(3): the frame after entering close */
  get closing() {
    return this.seq.state === 3 && this.seq.timer === 1
  }

  /** RPVsWinner::Start */
  start(winner: -1 | 0 | 1) {
    if (this.seq.state !== 0) return
    this.winner = winner
    this.seq.change(1)
  }

  calc(input: MenuInput) {
    if (this.seq.state !== 0) this.lyt.calc()
    this.seq.run(
      (s) => {
        if (s === 1) {
          this.lyt.open()
          this.showModel = false
          this.t = 0
        } else if (s === 2) {
          this.modelFrame = 0
          this.showModel = true
          if (this.winner !== -1) this.spawnConfetti()
        } else if (s === 3) {
          this.leaveFrame = 0
          this.lyt.close()
        }
      },
      (s) => {
        if (s === 1) {
          if (this.lyt.seq.state === 2) this.seq.change(2)
        } else if (s === 2) {
          if (this.modelFrame >= APPEAR_FRAMES - 1 && (input.ab || this.seq.timer >= 300)) this.seq.change(3)
        } else if (s === 3) {
          if (this.leaveFrame >= LEAVE_FRAMES - 1 && this.lyt.seq.state === 4) this.seq.change(4)
        } else if (s === 4) this.seq.change(5)
        this.updatePositions()
      },
    )
    if (this.seq.state !== 0) {
      this.t++
      if (this.showModel) this.modelFrame++
      if (this.leaveFrame >= 0) this.leaveFrame++
      for (const c of this.confetti) {
        c.x += c.vx + Math.sin((this.t + c.s) * 0.1) * 0.6
        c.y += c.vy
        if (c.y < -240) c.y += 480
      }
    }
  }

  private updatePositions() {
    const L = this.lyt.l
    const names = ['N_pLPosition_00', 'N_pRPosition_00']
    for (let i = 0; i < 2; i++) {
      const p = panePos(L, names[i])
      this.players[i] = { x: p.x + PLAYER_OFFSET[i].x * WIDE_X, y: p.y + PLAYER_OFFSET[i].y }
    }
    const t = panePos(L, 'N_tPosition_00')
    this.trophy = { x: t.x + TROPHY_OFFSET.x * WIDE_X, y: t.y + TROPHY_OFFSET.y }
  }

  /** Bcm_win_fubuki */
  private spawnConfetti() {
    const cols = ['#ff5a5a', '#ffd23f', '#4fc3ff', '#7dff7a', '#ff8bf0', '#ffffff']
    this.confetti = Array.from({ length: 70 }, (_, i) => ({
      x: -400 + ((i * 97) % 800),
      y: 240 + ((i * 53) % 260),
      vx: ((i % 7) - 3) * 0.12,
      vy: -1.2 - (i % 5) * 0.25,
      r: 2.5 + (i % 3),
      c: cols[i % cols.length],
      s: i * 13,
    }))
  }

  draw(ctx: CanvasRenderingContext2D) {
    const s = this.seq.state
    if (s === 0 || s === 5 || this.lyt.seq.state === 0) return
    const w = this.winner
    // Bcm_win_spot01 on the winner
    if (w !== -1 && this.showModel) {
      const k = this.leaveFrame >= 0 ? Math.max(0, 1 - this.leaveFrame / 15) : Math.min(1, this.modelFrame / 15)
      const p = this.players[w]
      ctx.save()
      ctx.globalAlpha = 0.6 * k
      const g = ctx.createRadialGradient(p.x, p.y + 90, 10, p.x, p.y + 90, 150)
      g.addColorStop(0, 'rgba(255,250,210,1)')
      g.addColorStop(1, 'rgba(255,250,210,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.ellipse(p.x, p.y + 90, 150 * k, 170, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
    for (let i = 0; i < 2; i++) {
      const p = this.players[i]
      const pose = w === -1 ? 'draw' : i === w ? 'win' : 'lose'
      drawMiiFigure(ctx, p.x, p.y, 170, i, pose, this.t, 1, w === -1 ? 'normal' : i === w ? 'smile' : 'sad')
    }
    if (this.showModel) {
      // the model is placed halfway towards the camera, so it reads larger than the avatars
      drawWinnerText(ctx, this.trophy.x, this.trophy.y + 125, 19, w, this.modelFrame, this.leaveFrame)
    }
    if (this.confetti.length && this.showModel && this.leaveFrame < 0) {
      ctx.save()
      for (const c of this.confetti) {
        ctx.fillStyle = c.c
        ctx.save()
        ctx.translate(c.x, c.y)
        ctx.rotate((this.t + c.s) * 0.08)
        ctx.fillRect(-c.r, -c.r * 0.5, c.r * 2, c.r)
        ctx.restore()
      }
      ctx.restore()
    }
  }
}

/** RPChoiceLyt (ptGOMenu_00) states: 0 off, 1 in, 2 select, 3 push, 4 out, 5 done */
class ChoiceLyt {
  l!: Lyt
  state = 0
  private next = 0
  private changing = false
  cursor = -1
  private prevCursor = -1
  private inFrame = 0
  /** active_00 frame and rate per button */
  private btn = [
    { f: 0, rate: 0 },
    { f: 0, rate: 0 },
  ]

  constructor(private snd: SoundHost) {}

  async load() {
    this.l = new Lyt(await loadLayout('ptGOMenu_00'))
  }

  reset() {
    this.state = this.next = 0
    this.changing = false
    this.cursor = this.prevCursor = -1
    this.l.reset()
    this.l.setText('T_choicesF_00', msg(0x1f55, 0))
    this.l.setText('T_choicesS_00', msg(0x1f55, 1))
  }

  open() {
    if (this.state !== 0 || this.changing) return
    this.next = 1
    this.changing = true
  }

  decide() {
    if (this.state !== 2 || this.changing) return
    this.next = 3
    this.changing = true
  }

  setCursor(c: number) {
    if (!((this.state === 0 && this.changing) || this.state === 1 || (this.state === 2 && !this.changing))) return
    this.prevCursor = this.cursor
    this.cursor = c
    for (let i = 0; i < 2; i++) {
      if (i === this.cursor && i !== this.prevCursor) this.btn[i].rate = 1
      if (i !== this.cursor && i === this.prevCursor) this.btn[i].rate = -1
    }
  }

  calc() {
    const l = this.l
    const n = animLen(l, 'ptGOMenu_00_active_00')
    if (this.changing) {
      this.state = this.next
      this.changing = false
      if (this.state === 1) {
        this.inFrame = 0
        this.btn = [
          { f: 0, rate: 0 },
          { f: 0, rate: 0 },
        ]
      } else if (this.state === 3) {
        l.play('ptGOMenu_00_push_00', { key: 'push', bind: this.cursor === 0 ? 'N_choicesF_00' : 'N_choicesS_00' })
        this.snd.se(this.cursor === 0 ? 'RP_COM_GAME_PARTY_SE_RESULT_KEY_A_01_TVSP' : 'RP_COM_GAME_PARTY_SE_RESULT_KEY_A_02_TVSP')
      }
    }
    if (this.state === 1) {
      // N_choices_00 alpha follows the in_00 frame
      const end = animLen(l, 'ptGOMenu_00_in_00') - 1
      l.setAlpha('N_choices_00', Math.max(0, Math.min(255, Math.floor((this.inFrame * 255) / end))))
      if (this.inFrame >= end) {
        this.next = 2
        this.changing = true
      } else this.inFrame++
    } else if (this.state === 3 && l.done('push')) {
      this.next = 5
      this.changing = true
    }
    if (this.state !== 0) {
      // the buttons' active_00: forward when lit, backwards (then reset) when unlit
      this.btn.forEach((b, i) => {
        b.f = Math.max(0, Math.min(n - 1, b.f + b.rate))
        l.play('ptGOMenu_00_active_00', { key: 'btn' + i, bind: i === 0 ? 'N_choicesF_00' : 'N_choicesS_00', frame: b.f, rate: 0 })
      })
      if (this.state === 3) l.play('ptGOMenu_00_push_00', { key: 'push', bind: this.cursor === 0 ? 'N_choicesF_00' : 'N_choicesS_00', frame: l.frameOf('push'), rate: 1 })
      l.calc()
    }
  }

  hitTest(p: MenuInput['pointer']) {
    if (hitPane(this.l, 'B_choicesF_00', p)) return 0
    if (hitPane(this.l, 'B_choicesS_00', p)) return 1
    return -1
  }

  buttonPane(i: number) {
    return i === 0 ? 'B_choicesF_00' : 'B_choicesS_00'
  }

  draw(ctx: CanvasRenderingContext2D, wideX: number) {
    if (this.state !== 0) this.l.draw(ctx, wideX)
  }
}

/** RPVsResultLyt (ptVsResult_00) states: 0 off, 1 in, 2 shown, 3 out, 4 done */
class VsResultLyt {
  l!: Lyt
  seq = new Seq()
  private wins = [0, 0]

  async load() {
    this.l = new Lyt(await loadLayout('ptVsResult_00'))
  }
  reset() {
    // RPVsResultLyt keeps its own state fields: Reset leaves no change pending
    this.seq.reset(0)
    this.seq.changing = false
    this.l.reset()
    for (const n of ['T_P1_00', 'T_P1_01']) this.l.setText(n, msg(0x1f56, 0))
    for (const n of ['T_P2_00', 'T_P2_01']) this.l.setText(n, msg(0x1f56, 1))
  }
  open(wins: number[]) {
    if (this.seq.state !== 0 || this.seq.changing) return
    this.wins = wins.slice()
    this.seq.change(1)
  }
  close() {
    if (this.seq.state !== 2 || this.seq.changing) return
    this.seq.change(3)
  }
  calc() {
    const l = this.l
    this.seq.run(
      (s) => {
        if (s === 1) {
          l.unbindAll()
          l.play('ptVsResult_00_in_00', { key: 'main' })
          ;[
            ['T_P1wins_00', 'T_P1wins_01'],
            ['T_P2wins_00', 'T_P2wins_01'],
          ].forEach((names, i) => names.forEach((n) => l.setText(n, msg(0x1f54, plural(this.wins[i]), fullWidth(this.wins[i])))))
        } else if (s === 3) {
          l.unbindAll()
          l.play('ptVsResult_00_out_00', { key: 'main' })
        }
      },
      (s) => {
        if (s === 1 && l.done('main')) this.seq.change(2)
        else if (s === 3 && l.done('main')) this.seq.change(4)
      },
    )
    if (this.seq.state !== 0 && this.seq.state !== 4) l.calc()
  }
  draw(ctx: CanvasRenderingContext2D, wideX: number) {
    if (this.seq.state !== 0 && this.seq.state !== 4) this.l.draw(ctx, wideX)
  }
}

/** RPResultMenu states: 0 off, 1 show, 2 select, 3 decide, 4 done */
export class ResultMenu {
  seq = new Seq()
  choiceLyt: ChoiceLyt
  vsResult = new VsResultLyt()
  cursor = new PadCursor()
  players: 1 | 2 = 1
  winner: -1 | 0 | 1 = -1
  choice = 0
  private lastChoice = 0
  private hit = -1
  private usePad = true

  constructor(private snd: SoundHost) {
    this.choiceLyt = new ChoiceLyt(snd)
  }

  async load() {
    await Promise.all([this.choiceLyt.load(), this.vsResult.load(), this.cursor.load()])
    this.reset()
  }

  reset() {
    this.seq.reset(0)
    this.choice = this.lastChoice = 0
    this.hit = -1
    this.usePad = true
    this.choiceLyt.reset()
    this.cursor.reset()
    this.vsResult.reset()
  }

  get state() {
    return this.seq.state
  }

  /** RPResultMenu::Start(players, winner) */
  start(players: 1 | 2, winner: -1 | 0 | 1) {
    if (this.seq.state !== 0) return
    this.players = players
    this.winner = winner
    this.seq.change(1)
  }

  /** GetChoice: 0 play again, 1 play a different game, -1 not decided */
  getChoice() {
    return this.seq.state === 4 ? this.choice : -1
  }

  calc(input: MenuInput) {
    this.hit = this.choiceLyt.hitTest(input.pointer)
    if (this.choice !== -1) this.lastChoice = this.choice
    const c = this.choiceLyt
    this.seq.run(
      (s) => {
        if (s === 1) {
          if (this.players >= 2) {
            const S = vsSession
            if (this.winner === 0) S.streak = Math.max(-3, Math.min(3, S.streak + 1))
            if (this.winner === 1) S.streak = Math.max(-3, Math.min(3, S.streak - 1))
            if (this.winner !== -1 && S.wins[this.winner] < 99) S.wins[this.winner]++
            this.vsResult.open(S.wins)
          }
          c.open()
        } else if (s === 3) {
          c.decide()
          if (this.players >= 2) this.vsResult.close()
          this.cursor.active = false
        }
      },
      (s) => {
        if (s === 1) {
          if (c.state === 2 && (this.players === 1 || this.vsResult.seq.state === 2)) this.seq.change(2)
        } else if (s === 2) this.calcSelect(input)
        else if (s === 3) {
          if (c.state === 5 && (this.players === 1 || this.vsResult.seq.state === 4)) this.seq.change(4)
        }
        if (s >= 1 && s <= 3) {
          c.calc()
          this.cursor.calc()
          this.vsResult.calc()
        }
      },
    )
  }

  private calcSelect(input: MenuInput) {
    const prev = this.choice
    const prevUsePad = this.usePad
    if (this.hit !== -1) {
      this.choice = this.hit
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
    this.choiceLyt.setCursor(this.choice)
    if (this.choice !== -1 && input.a) this.seq.change(3)
    if (this.usePad) {
      this.cursor.active = true
      this.cursor.setTarget(this.choiceLyt.l, this.choiceLyt.buttonPane(this.choice))
    } else this.cursor.active = false
    if (this.choice !== -1 && ((this.seq.prev === 1 && this.seq.timer === 0) || this.choice !== prev || (prevUsePad && !this.usePad))) this.snd.se('RP_COM_GAME_PARTY_SE_Cursor_01')
  }

  draw(ctx: CanvasRenderingContext2D, wideX: number) {
    if (this.seq.state === 0) return
    this.choiceLyt.draw(ctx, wideX)
    this.cursor.draw(ctx, wideX)
    this.vsResult.draw(ctx, wideX)
  }
}
