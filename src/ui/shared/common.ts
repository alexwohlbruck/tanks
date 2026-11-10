// Helpers shared by the ports of the original game's common screens (RPPartyCommon / RPKernel):
// the RPStateMachine pattern, pane matrices for hit tests and cursor targets, menu input.

import type { Lyt } from '../lyt'

/** layout space of the 16:9 canvas (see main.ts) */
export const LAYOUT_W = 832
export const LAYOUT_H = 456
/** horizontal factor for locationAdjust panes */
export const WIDE_X = LAYOUT_W / 608

/** What the shared screens read from the controllers each 60 Hz frame. */
export type MenuInput = {
  up: boolean
  down: boolean
  left: boolean
  right: boolean
  /** A (Enter / Space / click / gamepad A) */
  a: boolean
  /** B (Backspace / X / gamepad B) */
  b: boolean
  /** + (Escape / P / Start) */
  plus: boolean
  /** A or B on any controller (RPCommon::IsAnyABPressed): skips result screens */
  ab: boolean
  /** pointer in layout units (origin centre, y up) while it points at the screen, else null */
  pointer: { x: number; y: number } | null
}

export const NO_INPUT: MenuInput = { up: false, down: false, left: false, right: false, a: false, b: false, plus: false, ab: false, pointer: null }

/** Sounds the shared screens play (labels from the brsar, see audio manifest). */
export type SoundHost = {
  se(name: string): void
  /** RPSndAudioMgr::startFanfare (medal jingles) */
  fanfare(name: string): void
}

/**
 * RPStateMachine: ChangeState() takes effect at the next calc(), which enters the new state
 * (timer = 0), runs its calc and then advances the timer.
 */
export class Seq {
  state = 0
  prev = 0
  next = 0
  changing = false
  timer = 0

  reset(s: number) {
    this.prev = this.state = this.next = s
    this.changing = true
    this.timer = 0
  }
  change(s: number) {
    this.next = s
    this.changing = true
  }
  run(enter: (s: number) => void, calc: (s: number) => void) {
    if (this.changing) {
      this.prev = this.state
      this.state = this.next
      this.changing = false
      this.timer = 0
      enter(this.state)
    }
    calc(this.state)
    this.timer++
  }
  /** IsStateOrNext */
  orNext(s: number) {
    return this.state === s || (this.next === s && this.changing)
  }
  /** IsStateSettled */
  settled(s: number) {
    return this.state === s && (this.next === s || !this.changing)
  }
}

/** frame count of an animation (BRLAN frameSize) */
export function animLen(l: Lyt, anim: string): number {
  return l.R.anims[anim].frameSize
}

/** an animation of `l` held at `frame` (an RPSysLytAnmObj driven by code) */
export function holdFrame(l: Lyt, anim: string, key: string, frame: number, bind?: string, force = false) {
  const n = animLen(l, anim)
  l.play(anim, { key, bind, force, frame: Math.max(0, Math.min(n - 1, frame)), rate: 0, loop: false })
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function pathTo(root: any, name: string): any[] | null {
  if (root.name === name) return [root]
  for (const c of root.children) {
    const r = pathTo(c, name)
    if (r) return [root, ...r]
  }
  return null
}

/** Pane::GetGlobalMtx in layout units (locationAdjust panes spread by wideX, as drawn). */
export function paneMatrix(l: Lyt, name: string, wideX = WIDE_X): DOMMatrix {
  const path = pathTo(l.L.root, name)
  const m = new DOMMatrix()
  if (!path) return m
  for (const p of path) {
    m.translateSelf(p.translate[0] * (p.locationAdjust ? wideX : 1), p.translate[1])
    m.rotateSelf(0, 0, p.rotate[2])
    m.scaleSelf(p.scale[0] * Math.cos((p.rotate[1] * Math.PI) / 180), p.scale[1] * Math.cos((p.rotate[0] * Math.PI) / 180))
  }
  return m
}

/** translation of a pane's global matrix */
export function panePos(l: Lyt, name: string, wideX = WIDE_X) {
  const m = paneMatrix(l, name, wideX)
  return { x: m.e, y: m.f }
}

/** pane rectangle relative to its own origin (y up), as in lyt.ts paneRect */
export function paneRect(p: any) {
  const [w, h] = p.size
  const hx = p.origin % 3
  const vy = Math.floor(p.origin / 3)
  return { x: (-w * hx) / 2, top: (h * vy) / 2, w, h }
}

/** RPSysLayout::isInsideBounding */
export function hitPane(l: Lyt, name: string, pt: { x: number; y: number } | null, wideX = WIDE_X) {
  if (!pt) return false
  const m = paneMatrix(l, name, wideX)
  const q = m.inverse().transformPoint(new DOMPoint(pt.x, pt.y))
  const r = paneRect(l.pane(name))
  const x0 = Math.min(r.x, r.x + r.w)
  const x1 = Math.max(r.x, r.x + r.w)
  const y1 = Math.max(r.top, r.top - r.h)
  const y0 = Math.min(r.top, r.top - r.h)
  return q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** RPSysStringUtility::IsSingular -> message sub index (0 singular, 1 plural) */
export const plural = (n: number) => (n === 1 ? 0 : 1)

/** Draws a layout with a callback run at a pane (RPDrawKokeshiIcon, reparented panes). */
export function drawWithHooks(ctx: CanvasRenderingContext2D, l: Lyt, wideX: number, hooks: Record<string, (ctx: CanvasRenderingContext2D, alpha: number) => void>) {
  const prev = l.hook
  l.hook = (name, c, alpha) => {
    prev?.(name, c, alpha)
    hooks[name]?.(c, alpha)
  }
  l.draw(ctx, wideX)
  l.hook = prev
}

/** Draws an image (canvas, y down) centred at the origin of a y-up layout transform. */
export function blitCentered(ctx: CanvasRenderingContext2D, img: CanvasImageSource, w: number, h: number, alpha = 1) {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.scale(1, -1)
  ctx.drawImage(img, -w / 2, -h / 2, w, h)
  ctx.restore()
}

/** Scene change fader (RPSysSceneMgr: EGG::ColorFader, black, 20 frames). */
export class SceneFader {
  static FRAMES = 20
  /** 0 transparent .. FRAMES opaque */
  t = 0
  dir: -1 | 0 | 1 = 0
  private then: (() => void) | null = null

  /** fade to black, then run `then` (once) and fade back in */
  out(then: () => void) {
    if (this.dir === 1) return
    this.dir = 1
    this.then = then
  }
  get busy() {
    return this.dir !== 0 || this.t > 0
  }
  get closing() {
    return this.dir === 1
  }
  calc() {
    if (this.dir === 1) {
      if (this.t < SceneFader.FRAMES) this.t++
      else {
        const f = this.then
        this.then = null
        this.dir = -1
        f?.()
      }
    } else if (this.dir === -1) {
      if (this.t > 0) this.t--
      else this.dir = 0
    }
  }
  draw(ctx: CanvasRenderingContext2D) {
    if (this.t <= 0) return
    ctx.save()
    ctx.globalAlpha = Math.min(1, this.t / SceneFader.FRAMES)
    ctx.fillStyle = '#000'
    ctx.fillRect(-LAYOUT_W / 2 - 2, -LAYOUT_H / 2 - 2, LAYOUT_W + 4, LAYOUT_H + 4)
    ctx.restore()
  }
}

/** loads an image from public/assets (null when missing) */
export function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((res) => {
    const im = new Image()
    im.onload = () => res(im)
    im.onerror = () => res(null)
    im.src = src
  })
}
