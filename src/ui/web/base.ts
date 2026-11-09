// Shared plumbing of the web screens: the app hooks they use beyond AppContext, focus
// navigation, UI sounds and common pieces (panel, header band, buttons).

import type { AppContext, Screen } from '../../app/types'
import type { UiPresenter } from '../presenter'
import { icon } from './art'
import { h } from './dom'
import { Nav } from './nav'
import './web.css'

/** what the web screens call on the App (src/app/app.ts) besides AppContext */
export type WebApp = AppContext & {
  readonly classic: boolean
  presenter: UiPresenter
  toTitle(): void
  pause(): void
  resume(): void
  restart(): void
  resultChoice(c: 0 | 1): void
  hasScreen(id: string): boolean
  music(name: string | null, frames?: number): void
}

const SOUNDS = { move: 'RP_COMMON_SE_KEY_CURSOR_01', ok: 'RP_COMMON_SE_KEY_A_04', back: 'RP_COMMON_SE_KEY_BACK_01' }

export abstract class WebScreen implements Screen {
  readonly modal: boolean = true
  readonly opaque: boolean = false
  protected app!: WebApp
  protected root!: HTMLElement
  protected nav!: Nav
  protected params: Record<string, unknown> = {}

  mount(root: HTMLElement, app: AppContext, params?: Record<string, unknown>) {
    this.app = app as WebApp
    this.root = root
    this.params = params ?? {}
    root.classList.add('web')
    this.build(root)
    this.nav = new Nav(root, {
      back: this.back ? () => this.back!() : undefined,
      start: this.start ? () => this.start!() : undefined,
      sound: (k) => this.sound(k),
    })
    requestAnimationFrame(() => this.nav.focus())
  }

  unmount() {
    this.nav?.dispose()
  }

  update() {
    this.nav.update()
  }

  sound(kind: keyof typeof SOUNDS) {
    this.app.audio.play(SOUNDS[kind])
  }

  protected abstract build(root: HTMLElement): void
  /** Esc / Backspace / B */
  protected back?(): void
  /** gamepad Start */
  protected start?(): void
}

/** a menu button: icon, label and an optional hint line */
export function button(label: string, opts: { icon?: string; hint?: string; class?: string; disabled?: boolean; badge?: string; onclick?: () => void; autofocus?: boolean } = {}) {
  return h(
    'button.btn',
    { class: opts.class, disabled: opts.disabled, onclick: opts.onclick, autofocus: opts.autofocus, type: 'button' },
    opts.icon ? icon(opts.icon) : null,
    h('span.label', null, h('span.t', null, label), opts.hint ? h('span.hint', null, opts.hint) : null),
    opts.badge ? h('span.badge', null, opts.badge) : null,
  )
}

/** the red mission band used as a header */
export function band(text: string, cls = '') {
  return h('div.band', { class: cls }, h('span', null, text))
}

/** back arrow button for panel headers */
export function backButton(onclick: () => void, label = 'Back') {
  return h('button.btn.back', { type: 'button', onclick, 'aria-label': label }, icon('back'), h('span.label', null, h('span.t', null, label)))
}
