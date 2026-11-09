// 'settings': volumes, graphics quality, fullscreen, the Classic Wii UI switch, and the
// controls (keyboard rebinding, mouse and gamepad reference). params.from: the screen to
// return to ('menu', 'pause', 'title').

import { registerScreen } from '../../app/router'
import { backButton, band, WebScreen } from './base'
import { h } from './dom'
import { DEFAULT_KEYS, keyName, settings, updateSettings, type KeyAction, type Quality } from './settings'

const ACTIONS: { id: KeyAction; label: string }[] = [
  { id: 'up', label: 'Drive up' },
  { id: 'down', label: 'Drive down' },
  { id: 'left', label: 'Drive left' },
  { id: 'right', label: 'Drive right' },
  { id: 'fire', label: 'Fire' },
  { id: 'mine', label: 'Lay a mine' },
  { id: 'pause', label: 'Pause' },
]

class SettingsScreen extends WebScreen {
  private listening: { action: KeyAction; el: HTMLElement } | null = null
  private keysEl!: HTMLElement
  private onKey = (e: KeyboardEvent) => {
    if (!this.listening) return
    e.preventDefault()
    e.stopImmediatePropagation()
    const { action } = this.listening
    if (e.code !== 'Escape') {
      const keys = structuredClone(settings.keys)
      // a key drives one action only
      for (const a of Object.keys(keys) as KeyAction[]) keys[a] = keys[a].filter((c) => c !== e.code)
      keys[action] = [e.code, ...keys[action].filter((c) => c !== e.code)].slice(0, 2)
      updateSettings({ keys })
    }
    this.listening = null
    this.renderKeys()
  }

  protected build(root: HTMLElement) {
    addEventListener('keydown', this.onKey, true)
    const s = settings
    const slider = (label: string, value: number, set: (v: number) => void) => {
      const out = h('output', null, `${Math.round(value * 100)}`)
      const input = h('input', {
        type: 'range',
        min: '0',
        max: '100',
        step: '5',
        value: String(Math.round(value * 100)),
        'aria-label': label,
        style: `--p:${Math.round(value * 100)}%`,
        oninput: (e: Event) => {
          const el = e.target as HTMLInputElement
          const v = +el.value / 100
          out.textContent = `${Math.round(v * 100)}`
          el.style.setProperty('--p', `${Math.round(v * 100)}%`)
          set(v)
        },
      })
      return h('label.row', null, h('span.row-label', null, label), h('span.slider', null, input, out))
    }
    const seg = <T extends string>(label: string, options: [T, string][], value: T, set: (v: T) => void) => {
      const wrap = h('span.seg', { role: 'radiogroup', 'aria-label': label })
      const draw = (cur: T) => {
        wrap.replaceChildren(
          ...options.map(([v, l]) =>
            h('button.seg-btn', { type: 'button', class: v === cur ? 'on' : '', 'aria-pressed': String(v === cur), onclick: () => (set(v), draw(v)) }, l),
          ),
        )
      }
      draw(value)
      return h('div.row', null, h('span.row-label', null, label), wrap)
    }
    const toggle = (label: string, hint: string, value: boolean, set: (v: boolean) => void) => {
      const b = h('button.toggle', { type: 'button', role: 'switch', 'aria-checked': String(value), class: value ? 'on' : '' }, h('span.knob'))
      b.addEventListener('click', () => {
        const v = b.getAttribute('aria-checked') !== 'true'
        b.setAttribute('aria-checked', String(v))
        b.classList.toggle('on', v)
        set(v)
      })
      return h('div.row', null, h('span.row-label', null, label, h('small', null, hint)), b)
    }
    this.keysEl = h('div.keys')
    this.renderKeys()
    const fsSupported = !!document.documentElement.requestFullscreen
    root.append(
      h(
        'div.settings-screen',
        { class: this.params.from === 'pause' ? 'over-game' : '' },
        h(
          'div.panel.settings',
          null,
          h('div.panel-head', null, backButton(() => this.back()), band('Settings')),
          h(
            'div.panel-scroll',
            null,
            h('h3', null, 'Sound'),
            slider('Music', s.music, (v) => updateSettings({ music: v })),
            slider('Sound effects', s.sfx, (v) => {
              updateSettings({ sfx: v })
              this.sound('move')
            }),
            h('h3', null, 'Display'),
            seg<Quality>('Graphics quality', [['classic', 'Classic'], ['high', 'High'], ['ultra', 'Ultra']], s.quality, (v) => updateSettings({ quality: v })),
            fsSupported ? toggle('Fullscreen', 'Fill the whole screen', !!document.fullscreenElement, (v) => this.fullscreen(v)) : null,
            toggle('Classic Wii UI', "Wii Play's own menus and fonts in a 16:9 picture. Reloads the game.", s.classicUi, (v) => {
              updateSettings({ classicUi: v })
              setTimeout(() => location.reload(), 300)
            }),
            h('h3', null, 'Controls'),
            h(
              'div.ref',
              null,
              h('div', null, h('b', null, 'Mouse'), ' aim · left click fire · right click mine'),
              h('div', null, h('b', null, 'Gamepad'), ' left stick drive · right stick aim · RT / A fire · LT / X mine · Start pause'),
            ),
            this.keysEl,
          ),
        ),
      ),
    )
  }

  private renderKeys() {
    const k = settings.keys
    this.keysEl.replaceChildren(
      ...ACTIONS.map(({ id, label }) => {
        const listening = this.listening?.action === id
        const b = h(
          'button.key',
          {
            type: 'button',
            class: listening ? 'listening' : '',
            onclick: () => {
              this.listening = { action: id, el: b }
              this.renderKeys()
            },
          },
          listening ? 'Press a key…' : k[id].map(keyName).join(' / ') || '—',
        )
        return h('div.row', null, h('span.row-label', null, label), b)
      }),
      h(
        'div.row',
        null,
        h('span.row-label', null, ''),
        h(
          'button.key.reset',
          {
            type: 'button',
            onclick: () => {
              updateSettings({ keys: structuredClone(DEFAULT_KEYS) })
              this.renderKeys()
            },
          },
          'Reset keys',
        ),
      ),
    )
    if (this.listening) this.keysEl.querySelector<HTMLElement>('.listening')?.focus()
  }

  private async fullscreen(on: boolean) {
    try {
      if (on && !document.fullscreenElement) {
        await document.documentElement.requestFullscreen()
        // phones: prefer landscape while fullscreen
        await (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.('landscape').catch(() => {})
      } else if (!on && document.fullscreenElement) await document.exitFullscreen()
    } catch {
      /* not allowed */
    }
  }

  unmount() {
    removeEventListener('keydown', this.onKey, true)
    super.unmount()
  }

  protected back() {
    if (this.listening) return
    const from = (this.params.from as string) || 'menu'
    this.app.show(from === 'pause' ? 'pause' : from)
  }
}

registerScreen('settings', () => new SettingsScreen())
