// RPCPadCursor (cPadCursor_00): the four corner brackets that frame the button picked with the
// D-pad. They swing by +-2 units over a 35-frame cycle, fade in over 120 frames when the pad
// takes over and fade out over 60 frames when the pointer does.

import { loadLayout, Lyt } from '../lyt'
import { paneMatrix } from './common'

const CORNERS = ['P_cPadCuTL_00', 'P_cPadCuTR_00', 'P_cPadCuBL_00', 'P_cPadCuBR_00']
const SWING = 2
const MOVE_FRAMES = 35

type Target = { x: number; y: number; w: number; h: number; sx: number; sy: number; baseH: number; baseV: number }

export class PadCursor {
  l!: Lyt
  active = false
  private prevActive = false
  private moveTimer = 0
  /** 1 shown, 2 fading out, 3 fading in */
  private fadeState = 1
  private fadeTimer = 0
  private target: Target | null = null

  async load() {
    this.l = new Lyt(await loadLayout('cPadCursor_00'))
    this.reset()
  }

  reset() {
    this.l.reset()
    this.l.setVisible('N_cPadCursor_01', false)
    this.active = this.prevActive = false
    this.moveTimer = 0
    this.fadeState = 1
    this.fadeTimer = 0
    this.target = null
  }

  /** SetTarget: frame the (bounding) pane `name` of layout `src` */
  setTarget(src: Lyt, name: string) {
    if (!this.active && this.fadeState !== 2) return
    const p = src.pane(name)
    const m = paneMatrix(src, name)
    this.target = { x: m.e, y: m.f, w: p.size[0], h: p.size[1], sx: m.a, sy: m.d, baseH: p.origin % 3, baseV: Math.floor(p.origin / 3) }
  }

  calc() {
    if (this.prevActive && !this.active) {
      this.fadeState = 2
      this.fadeTimer = 60
    } else if (this.active && !this.prevActive) {
      this.fadeState = 3
      this.fadeTimer = 0
    }
    if ((this.active || this.fadeState === 2 || this.fadeState === 3) && this.target) this.updateCorners(this.target)
    this.l.calc()
    this.prevActive = this.active
  }

  private alpha() {
    if (this.fadeState === 2) {
      if (this.fadeTimer > 0) return (255 * this.fadeTimer--) / 60
      this.fadeState = 1
      return 255
    }
    if (this.fadeState === 3) {
      if (this.fadeTimer < 120) return (255 * this.fadeTimer++) / 120
      this.fadeState = 1
    }
    return 255
  }

  private updateCorners(t: Target) {
    if (++this.moveTimer > MOVE_FRAMES) this.moveTimer = 0
    const half = Math.floor(MOVE_FRAMES / 2)
    const f = this.moveTimer > half ? MOVE_FRAMES - this.moveTimer : this.moveTimer
    const off = -SWING + 2 * SWING * (f / half)
    const hw = (t.w / 2) * t.sx
    const hh = (t.h / 2) * t.sy
    const cx = t.baseH === 0 ? t.x + hw : t.baseH === 1 ? t.x : t.x - hw
    const cy = t.baseV === 0 ? t.y - hh : t.baseV === 1 ? t.y : t.y + hh
    const a = this.alpha()
    CORNERS.forEach((n, i) => {
      this.l.setAlpha(n, Math.round(a))
      // the corner panes are children of the (unmoved) N_cPadCursor_00
      this.l.setTranslate(n, cx + (i % 2 === 0 ? -(hw + off) : hw + off), cy + (i < 2 ? hh + off : -(hh + off)))
    })
  }

  draw(ctx: CanvasRenderingContext2D, wideX: number) {
    if (this.active || this.fadeState === 2) this.l.draw(ctx, wideX)
  }
}
