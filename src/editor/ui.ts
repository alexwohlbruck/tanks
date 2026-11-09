// Small DOM kit shared by the editor and the store: element builder, modals, toasts, files,
// and the test-play round trip (play a pack, come back to the screen afterwards).

import './ui.css'
import type { AppContext } from '../app/types'
import type { LevelPack } from '../levels/format'

type Attrs = Record<string, unknown> & { class?: string; style?: string; on?: Record<string, (e: any) => void> }
type Child = Node | string | number | null | undefined | false | Child[]

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (attrs)
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue
      if (k === 'on') for (const [ev, f] of Object.entries(v as Record<string, (e: Event) => void>)) el.addEventListener(ev, f)
      else if (k === 'class') el.className = String(v)
      else if (k === 'style') el.setAttribute('style', String(v))
      else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v
      else el.setAttribute(k, v === true ? '' : String(v))
    }
  append(el, children)
  return el
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c == null || c === false) continue
    if (Array.isArray(c)) append(el, c)
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)))
  }
}

export function clear(el: Element, ...children: Child[]) {
  el.replaceChildren()
  append(el, children)
  return el
}

/** keep typing in form fields away from the game's global key handlers (Space, arrows, Tab) */
export function isolateKeys(root: HTMLElement) {
  for (const ev of ['keydown', 'keyup'] as const)
    root.addEventListener(ev, (e) => {
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, select, [contenteditable]') || e.key === 'Tab') e.stopPropagation()
    })
}

export const isTyping = (e: Event) => !!(e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable]')

export type ModalButton = { label: string; kind?: 'primary' | 'danger' | 'ghost'; onClick?: () => boolean | void | Promise<boolean | void> }

/** a dialog over `host`; returns the close function. A button closes unless onClick returns false. */
export function modal(host: HTMLElement, title: string, body: Child, buttons: ModalButton[] = [{ label: 'Close' }], cls = '') {
  const close = () => {
    wrap.remove()
    removeEventListener('keydown', onKey, true)
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
    }
  }
  const foot = h(
    'div',
    { class: 'tk-modal-foot' },
    buttons.map((b) =>
      h(
        'button',
        {
          class: `tk-btn ${b.kind ? 'tk-' + b.kind : ''}`,
          on: {
            click: async () => {
              const r = await b.onClick?.()
              if (r !== false) close()
            },
          },
        },
        b.label,
      ),
    ),
  )
  const box = h('div', { class: `tk-modal ${cls}`, role: 'dialog' }, h('div', { class: 'tk-modal-head' }, h('h2', null, title), h('button', { class: 'tk-x', title: 'Close', on: { click: close } }, '×')), h('div', { class: 'tk-modal-body' }, body), buttons.length ? foot : null)
  const wrap = h('div', { class: 'tk-modal-wrap', on: { pointerdown: (e: PointerEvent) => e.target === wrap && close() } }, box)
  host.appendChild(wrap)
  addEventListener('keydown', onKey, true)
  return close
}

export function toast(host: HTMLElement, msg: string, kind: 'ok' | 'error' | 'info' = 'info', action?: { label: string; run: () => void }) {
  let box = host.querySelector<HTMLElement>('.tk-toasts')
  if (!box) host.appendChild((box = h('div', { class: 'tk-toasts' })))
  const t = h('div', { class: `tk-toast tk-toast-${kind}` }, h('span', null, msg), action ? h('button', { class: 'tk-btn tk-small', on: { click: () => (action.run(), t.remove()) } }, action.label) : null)
  box.appendChild(t)
  setTimeout(() => t.classList.add('tk-out'), action ? 6000 : 3200)
  setTimeout(() => t.remove(), action ? 6400 : 3600)
}

export function download(name: string, text: string) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: name })
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

export function pickFile(accept = '.json,application/json'): Promise<string | null> {
  return new Promise((resolve) => {
    const i = h('input', { type: 'file', accept, style: 'display:none' })
    i.addEventListener('change', async () => {
      const f = i.files?.[0]
      i.remove()
      resolve(f ? await f.text() : null)
    })
    document.body.appendChild(i)
    i.click()
  })
}

export const fileName = (s: string) => (s.trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-').toLowerCase() || 'level-pack') + '.tanks.json'

/**
 * Play a pack and come back to `screen` when it is over: right after "Mission complete!" or
 * "Mission failed!" has shown (`quickReturn`), or when the game returns to its idle state (pause
 * menu "Quit", or "Quit" after the results). Stops watching if anything else takes over.
 */
export function playAndReturn(
  app: AppContext,
  pack: LevelPack,
  players: number,
  level: number,
  screen: string,
  params?: Record<string, unknown>,
  quickReturn = false,
) {
  app.playPack(pack, players, level)
  const game = app.game
  let started = false
  let endedAt = 0
  const back = () => {
    clearInterval(iv)
    app.show(screen, params)
    app.audio.stopMusic()
    if (game.state !== 0) game.quitToTitle()
  }
  const iv = setInterval(() => {
    if (game.pack !== pack || (app.screen !== null && app.screen !== 'menu')) return clearInterval(iv)
    if (game.state !== 0) started = true
    else if (started) return back()
    // 8 complete, 9 failed, 10+ results: give the message a moment, then leave
    if (quickReturn && game.state >= 8) {
      endedAt ||= performance.now()
      if (performance.now() - endedAt > 2200) back()
    }
  }, 50)
}

export function relTime(t: number) {
  const s = (Date.now() - t) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`
  return new Date(t).toLocaleDateString()
}
