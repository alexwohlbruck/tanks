// Touch controls for phones and tablets: twin virtual sticks over the game, in every mode
// (campaign, Tanks+, editor test play, online rooms, arena). Input folds them into the
// keyboard+mouse pad, so the sessions see an analog move stick and a gamepad-style aimStick.
//
//   left half    the drive stick appears under the thumb (analog; the base follows a thumb that
//                runs past its rim)
//   right half   the aim stick appears under the thumb: dragging turns the turret (relative to
//                the tank, like a gamepad's right stick) and releasing fires; a quick tap fires
//                where the turret already points; sliding back to the centre before letting go
//                cancels the shot. The aim stays where it was left.
//   MINE         lays a mine
//
// Phones held upright get a hint to turn sideways (and a fullscreen button where the browser
// has one); in landscape a small fullscreen button sits by the pause button.
//
// Shown only while a game is being played on a touch screen: `(hover: none) and (pointer:
// coarse)` or the first touch; a real mouse hides them again. Elements only change on touch
// events, never per frame.

import './touch.css'

/** pixels a thumb must travel before a touch on the aim side counts as aiming */
const AIM_DEAD = 14
/** a touch on the aim side shorter than this (ms) without aiming is a tap: fire */
const TAP_MS = 320
/** drive stick dead zone (fraction of the radius) */
const MOVE_DEAD = 0.12

export type TouchState = { moveX: number; moveY: number; aimStick: { x: number; y: number } | null; fire: boolean; mine: boolean }

type Stick = { base: HTMLElement; knob: HTMLElement; id: number | null; ox: number; oy: number; r: number; dx: number; dy: number; t0: number }

const MINE_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="9.5" fill="#e8c33a" stroke="#5b3a19" stroke-width="1.6"/><circle cx="12" cy="13" r="4" fill="#cf2a31" stroke="#5b3a19" stroke-width="1.2"/><path d="M12 3.5v-2" stroke="#5b3a19" stroke-width="1.6" stroke-linecap="round"/></svg>'
const AIM_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 1.5v5M12 17.5v5M1.5 12h5M17.5 12h5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>'
const MOVE_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l3 3.5H9zM12 21.5l3-3.5H9zM2.5 12L6 9v6zM21.5 12L18 9v6z" fill="currentColor"/></svg>'

const ROTATE_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2.5" width="10" height="17" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 15a9 9 0 0 0 9 7l-2-2.4M21 9a9 9 0 0 0-5-6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
const FS_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'

/** fullscreen, then landscape where the browser allows locking it (Android Chrome) */
export async function fullscreenLandscape() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' })
    await (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.('landscape').catch(() => {})
  } catch {
    /* not allowed */
  }
}

export class TouchControls {
  /** a touch screen is in use (the controls show during play) */
  enabled = matchMedia('(hover: none) and (pointer: coarse)').matches
  readonly root: HTMLElement
  private active = false
  private move: Stick
  private aim: Stick
  private mineBtn: HTMLElement
  private pointer: HTMLElement
  private aimDir: { x: number; y: number } | null = null
  private aimMag = 1
  private armed = false
  private firePulse = false
  private minePulse = false
  private used = false

  constructor(parent: HTMLElement, before: Node | null) {
    const root = (this.root = document.createElement('div'))
    root.id = 'touch'
    root.hidden = true
    root.innerHTML = `
      <div class="tc-stick tc-move"><i class="tc-knob">${MOVE_SVG}</i><span class="tc-label">Drive</span></div>
      <div class="tc-stick tc-aim"><b class="tc-dir"></b><i class="tc-knob">${AIM_SVG}</i><span class="tc-label">Aim · release to fire</span></div>
      <button type="button" class="tc-mine" aria-label="Lay a mine">${MINE_SVG}<span>Mine</span></button>
      <div class="tc-rotate"><i>${ROTATE_SVG}</i><span>Turn sideways for a bigger view</span><button type="button" class="tc-fs">Fullscreen</button><button type="button" class="tc-x" aria-label="Dismiss">×</button></div>
      <button type="button" class="tc-fs tc-fs-corner" aria-label="Fullscreen">${FS_SVG}</button>`
    parent.insertBefore(root, before)
    const stick = (sel: string): Stick => {
      const base = root.querySelector<HTMLElement>(sel)!
      return { base, knob: base.querySelector('.tc-knob')!, id: null, ox: 0, oy: 0, r: 60, dx: 0, dy: 0, t0: 0 }
    }
    this.move = stick('.tc-move')
    this.aim = stick('.tc-aim')
    this.pointer = root.querySelector('.tc-dir')!
    this.mineBtn = root.querySelector('.tc-mine')!
    // the portrait hint and the fullscreen buttons are plain buttons, not stick touches
    const hint = root.querySelector<HTMLElement>('.tc-rotate')!
    for (const b of root.querySelectorAll<HTMLElement>('.tc-rotate, .tc-fs-corner')) b.addEventListener('pointerdown', (e) => e.stopPropagation())
    for (const b of root.querySelectorAll<HTMLElement>('.tc-fs')) b.addEventListener('click', () => void fullscreenLandscape())
    root.querySelector('.tc-x')!.addEventListener('click', () => hint.remove())
    // shown once: it fades out by itself
    hint.addEventListener('animationend', () => hint.remove())
    const fs = () => root.classList.toggle('can-fs', !!document.documentElement.requestFullscreen && !document.fullscreenElement)
    document.addEventListener('fullscreenchange', fs)
    fs()

    root.addEventListener('pointerdown', (e) => this.down(e))
    root.addEventListener('pointermove', (e) => this.moveTo(e))
    root.addEventListener('pointerup', (e) => this.up(e, false))
    root.addEventListener('pointercancel', (e) => this.up(e, true))
    root.addEventListener('contextmenu', (e) => e.preventDefault())
    this.mineBtn.addEventListener('pointerdown', (e) => {
      e.stopPropagation()
      e.preventDefault()
      if (e.pointerType === 'mouse') return
      this.minePulse = true
      navigator.vibrate?.(12)
      this.mineBtn.classList.add('on')
      this.used = true
    })
    const release = () => this.mineBtn.classList.remove('on')
    this.mineBtn.addEventListener('pointerup', release)
    this.mineBtn.addEventListener('pointercancel', release)
    this.mineBtn.addEventListener('pointerleave', release)
    // the first touch anywhere turns the controls on; a real mouse turns them off
    addEventListener(
      'pointerdown',
      (e) => {
        if (e.pointerType === 'touch') this.setEnabled(true)
        else if (e.pointerType === 'mouse') this.setEnabled(false)
      },
      true,
    )
    addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse' && (e.movementX || e.movementY) && this.enabled && !matchMedia('(hover: none)').matches) this.setEnabled(false)
    })
    // iOS Safari: no pinch zoom of the page during play
    document.addEventListener('gesturestart', (e) => e.preventDefault())
    this.setEnabled(this.enabled)
  }

  /** called when touch controls are switched on or off (a touch, or a real mouse) */
  onEnabled: ((on: boolean) => void) | null = null

  private setEnabled(on: boolean) {
    if (on !== this.enabled) this.onEnabled?.(on)
    this.enabled = on
    document.body.classList.toggle('touch-ui', on)
    if (!on) this.setActive(false)
  }

  /** per rendered frame from the app: whether a game is being played (controls visible) */
  setActive(on: boolean) {
    on &&= this.enabled
    if (on === this.active) return
    this.active = on
    this.root.hidden = !on
    document.body.classList.toggle('touch-play', on)
    if (!on) {
      this.release(this.move)
      this.release(this.aim)
      this.armed = false
      this.root.classList.remove('armed')
      this.firePulse = this.minePulse = false
    }
  }

  get visible() {
    return this.active
  }

  /** a thumb is on the aim stick (the aim it reports otherwise is the one left behind) */
  get aimHeld() {
    return this.aim.id !== null
  }

  /** this frame's touch input, or null while the controls are hidden */
  poll(): TouchState | null {
    if (!this.active) return null
    const m = this.move
    let mx = 0
    let my = 0
    if (m.id !== null) {
      const len = Math.hypot(m.dx, m.dy) / m.r
      if (len > MOVE_DEAD) {
        const k = Math.min(1, (len - MOVE_DEAD) / (1 - MOVE_DEAD)) / len
        mx = (m.dx / m.r) * k
        my = (m.dy / m.r) * k
      }
    }
    const s: TouchState = {
      moveX: mx,
      moveY: my,
      // the aim cursor sits 0.55-1.2 stick lengths out (sessions scale by 200-250 world units)
      aimStick: this.aimDir ? { x: this.aimDir.x * (0.55 + 0.65 * this.aimMag), y: this.aimDir.y * (0.55 + 0.65 * this.aimMag) } : null,
      fire: this.firePulse,
      mine: this.minePulse,
    }
    this.firePulse = this.minePulse = false
    return s
  }

  /** forget the aim direction (a new game) */
  reset() {
    this.aimDir = null
    this.pointer.style.opacity = '0'
  }

  // ---- pointer events -----------------------------------------------------------------------

  private down(e: PointerEvent) {
    // the game's own input never sees touches on the controls
    e.stopPropagation()
    if (e.pointerType === 'mouse') return
    e.preventDefault()
    const right = e.clientX > innerWidth / 2
    const s = right ? this.aim : this.move
    if (s.id !== null) return
    this.root.setPointerCapture?.(e.pointerId)
    s.id = e.pointerId
    s.t0 = performance.now()
    s.base.classList.add('on')
    s.r = s.base.offsetWidth / 2 || 60
    // keep the whole stick on screen
    s.ox = Math.min(innerWidth - s.r * 0.6, Math.max(s.r * 0.6, e.clientX))
    s.oy = Math.min(innerHeight - s.r * 0.6, Math.max(s.r * 0.6, e.clientY))
    s.dx = e.clientX - s.ox
    s.dy = e.clientY - s.oy
    s.base.style.left = `${s.ox}px`
    s.base.style.top = `${s.oy}px`
    s.base.style.right = s.base.style.bottom = 'auto'
    if (right) this.armed = false
    this.draw(s)
    if (!this.used) {
      this.used = true
      this.root.classList.add('used')
    }
  }

  private moveTo(e: PointerEvent) {
    const s = e.pointerId === this.move.id ? this.move : e.pointerId === this.aim.id ? this.aim : null
    if (!s) return
    e.stopPropagation()
    e.preventDefault()
    s.dx = e.clientX - s.ox
    s.dy = e.clientY - s.oy
    const len = Math.hypot(s.dx, s.dy)
    if (s === this.move && len > s.r) {
      // the base follows a thumb that runs past its rim
      const k = (len - s.r) / len
      s.ox += s.dx * k
      s.oy += s.dy * k
      s.dx -= s.dx * k
      s.dy -= s.dy * k
      s.base.style.left = `${s.ox}px`
      s.base.style.top = `${s.oy}px`
    }
    if (s === this.aim) {
      const armed = len > AIM_DEAD
      if (armed) {
        this.aimDir = { x: s.dx / len, y: s.dy / len }
        this.aimMag = Math.min(1, len / s.r)
      }
      if (armed !== this.armed) {
        this.armed = armed
        this.root.classList.toggle('armed', armed)
      }
    }
    this.draw(s)
  }

  private up(e: PointerEvent, cancel: boolean) {
    const s = e.pointerId === this.move.id ? this.move : e.pointerId === this.aim.id ? this.aim : null
    if (!s) return
    e.stopPropagation()
    if (s === this.aim && !cancel) {
      const moved = Math.hypot(s.dx, s.dy)
      // released while aiming: fire; a short tap: fire where the turret points
      if (this.armed || (moved <= AIM_DEAD && performance.now() - s.t0 < TAP_MS && !this.wasArmed(s))) {
        this.firePulse = true
        navigator.vibrate?.(6)
      }
    }
    if (s === this.aim) {
      this.armed = false
      this.root.classList.remove('armed')
    }
    this.release(s)
  }

  /** a drag that went out and came back to the centre is a cancelled shot, not a tap */
  private wasArmed(s: Stick) {
    return s.base.classList.contains('was-armed')
  }

  private release(s: Stick) {
    s.id = null
    s.dx = s.dy = 0
    s.base.classList.remove('on', 'was-armed')
    s.base.style.left = s.base.style.top = s.base.style.right = s.base.style.bottom = ''
    this.draw(s)
  }

  private draw(s: Stick) {
    const len = Math.hypot(s.dx, s.dy)
    const k = len > s.r ? s.r / len : 1
    s.knob.style.transform = `translate(${s.dx * k}px, ${s.dy * k}px)`
    if (s === this.aim) {
      if (this.armed) s.base.classList.add('was-armed')
      if (this.aimDir) {
        this.pointer.style.opacity = '1'
        this.pointer.style.transform = `rotate(${Math.atan2(this.aimDir.y, this.aimDir.x)}rad)`
      }
    }
  }
}
