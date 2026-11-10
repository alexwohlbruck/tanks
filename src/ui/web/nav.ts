// Focus navigation for the web screens: arrow keys / WASD and the gamepad D-pad or left stick
// move the focus spatially between controls, Enter / Space / A activate, Esc / Backspace / B
// go back. The pointer focuses what it hovers (like a remote pointer), so key and pointer use
// mix freely. Gamepad edges come from the app's 60 Hz input poll (feedMenuPad).

import type { PadState } from '../../input'

type Edges = { up: boolean; down: boolean; left: boolean; right: boolean; confirm: boolean; back: boolean; pause: boolean }
const NONE = (): Edges => ({ up: false, down: false, left: false, right: false, confirm: false, back: false, pause: false })
let pending = NONE()

/** gamepad presses this frame (called by the app for every gamepad) */
export function feedMenuPad(p: PadState) {
  pending.up ||= p.up
  pending.down ||= p.down
  pending.left ||= p.left
  pending.right ||= p.right
  pending.confirm ||= p.confirm
  pending.back ||= p.back
  pending.pause ||= p.pause
}

export type NavOptions = {
  /** Esc / Backspace / gamepad B */
  back?: () => void
  /** gamepad Start (defaults to activating the focused control) */
  start?: () => void
  /** UI sounds */
  sound?: (kind: 'move' | 'ok' | 'back') => void
}

const FOCUSABLE = 'button:not([disabled]), [data-nav]:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]'

export class Nav {
  private onKey = (e: KeyboardEvent) => this.key(e)
  private onPointer = () => document.body.classList.remove('kbd')
  private onOver = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return
    const t = (e.target as HTMLElement).closest?.(FOCUSABLE) as HTMLElement | null
    if (t && this.root.contains(t) && document.activeElement !== t) t.focus({ preventScroll: true })
  }

  constructor(
    private root: HTMLElement,
    private opts: NavOptions = {},
  ) {
    addEventListener('keydown', this.onKey, true)
    addEventListener('pointermove', this.onPointer, true)
    root.addEventListener('pointerover', this.onOver)
    pending = NONE()
  }

  dispose() {
    removeEventListener('keydown', this.onKey, true)
    removeEventListener('pointermove', this.onPointer, true)
    this.root.removeEventListener('pointerover', this.onOver)
  }

  /** focus the first control (or `el`) */
  focus(el?: HTMLElement | null) {
    const t = el ?? (this.root.querySelector('[autofocus]') as HTMLElement | null) ?? this.items()[0]
    t?.focus({ preventScroll: false })
  }

  private items() {
    return [...this.root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => e.offsetParent !== null || e === document.activeElement)
  }

  private current() {
    const a = document.activeElement as HTMLElement | null
    return a && this.root.contains(a) ? a : null
  }

  /** per rendered frame: gamepad edges */
  update() {
    const p = pending
    pending = NONE()
    if (p.up) this.move('up', true)
    if (p.down) this.move('down', true)
    if (p.left) this.side(-1)
    if (p.right) this.side(1)
    if (p.confirm) this.activate()
    if (p.back) this.back()
    if (p.pause) {
      if (this.opts.start) this.opts.start()
      else this.activate()
    }
  }

  private key(e: KeyboardEvent) {
    if (!this.root.isConnected) return
    const a = this.current()
    const typing = a instanceof HTMLInputElement && a.type !== 'range' && a.type !== 'checkbox'
    if (typing) {
      if (e.code === 'Escape') a.blur()
      return
    }
    let handled = true
    switch (e.code) {
      case 'ArrowUp':
      case 'KeyW':
        this.move('up', true)
        break
      case 'ArrowDown':
      case 'KeyS':
        this.move('down', true)
        break
      case 'ArrowLeft':
      case 'KeyA':
        if (a instanceof HTMLInputElement && a.type === 'range') handled = false
        else this.move('left', true)
        break
      case 'ArrowRight':
      case 'KeyD':
        if (a instanceof HTMLInputElement && a.type === 'range') handled = false
        else this.move('right', true)
        break
      case 'Enter':
      case 'Space':
      case 'NumpadEnter':
        // the browser clicks a focused button itself
        if (a && (a instanceof HTMLButtonElement || a instanceof HTMLAnchorElement)) {
          handled = false
          if (!e.repeat) this.opts.sound?.('ok')
        } else this.activate()
        break
      case 'Escape':
      case 'Backspace':
        this.back()
        break
      default:
        handled = false
    }
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  private activate() {
    const a = this.current()
    if (!a) return this.focus()
    document.body.classList.add('kbd')
    this.opts.sound?.('ok')
    if (a instanceof HTMLInputElement && a.type === 'checkbox') a.click()
    else a.click()
  }

  private back() {
    if (this.opts.back) {
      this.opts.sound?.('back')
      this.opts.back()
    }
  }

  /** gamepad left/right: step sliders, else move */
  private side(d: -1 | 1) {
    const a = this.current()
    if (a instanceof HTMLInputElement && a.type === 'range') {
      if (d < 0) a.stepDown()
      else a.stepUp()
      a.dispatchEvent(new Event('input', { bubbles: true }))
      return
    }
    this.move(d < 0 ? 'left' : 'right', true)
  }

  /** spatial navigation: the nearest control in that direction */
  move(dir: 'up' | 'down' | 'left' | 'right', fromKeys = false) {
    if (fromKeys) document.body.classList.add('kbd')
    const items = this.items()
    const a = this.current()
    if (!a) return this.focus()
    const r = a.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    let best: HTMLElement | null = null
    let bestD = Infinity
    for (const e of items) {
      if (e === a) continue
      const q = e.getBoundingClientRect()
      const qx = q.left + q.width / 2
      const qy = q.top + q.height / 2
      const dx = qx - cx
      const dy = qy - cy
      let along: number
      let across: number
      if (dir === 'up' || dir === 'down') {
        along = dir === 'up' ? -dy : dy
        // overlapping columns count as aligned
        across = Math.max(q.left, r.left) - Math.min(q.right, r.right) > 0 ? Math.abs(dx) : 0
        if (dir === 'up' && qy >= cy - 1) continue
        if (dir === 'down' && qy <= cy + 1) continue
      } else {
        along = dir === 'left' ? -dx : dx
        across = Math.max(q.top, r.top) - Math.min(q.bottom, r.bottom) > 0 ? Math.abs(dy) : 0
        if (dir === 'left' && qx >= cx - 1) continue
        if (dir === 'right' && qx <= cx + 1) continue
      }
      if (along <= 0) continue
      const d = along + across * 2.5
      if (d < bestD) {
        bestD = d
        best = e
      }
    }
    if (best) {
      best.focus()
      best.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      this.opts.sound?.('move')
    }
  }
}
