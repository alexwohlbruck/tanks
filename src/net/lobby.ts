// 'lobby': online play. Without a room: name, quick play, create (public / private, size),
// join by code, and the list of public rooms. In a room: the code and share link, the players
// (P1 blue, P2 red, P3 green, P4 yellow), the host's game settings (co-op classic, co-op level
// pack, versus) and Start. params: { join?: string } joins that room on open.
//
// Built from the web screens' pieces (src/ui/web: the wooden panel, the red band, cream button
// tiles, cards and segmented switches) like the arena's join panel.

import { registerScreen } from '../app/router'
import type { LevelPack } from '../levels/format'
import { PLAYER_COLORS, tankIcon } from '../ui/web/art'
import { backButton, band, button, WebScreen } from '../ui/web/base'
import { h, touch } from '../ui/web/dom'
import { ARENAS } from './arenas'
import { netClient, type NetClient } from './client'
import { bindNet, joinLink } from './index'
import './net.css'
import { PLAYER_COLOR_NAMES, type RoomInfo, type RoomSettings } from './protocol'

const MODES: { id: RoomSettings['mode']; name: string; desc: string }[] = [
  { id: 'coop', name: 'Co-op', desc: 'The original missions together, on the 2-player rules: a destroyed tank sits out until the next mission.' },
  { id: 'pack', name: 'Level pack', desc: 'A custom level pack from the level store (or a .json file), played co-op.' },
  { id: 'versus', name: 'Versus', desc: 'Free-for-all: last tank standing wins the round. Optional AI tanks join the fight.' },
]
const modeName = (m: string) => MODES.find((x) => x.id === m)?.name ?? m

class Lobby extends WebScreen {
  private net: NetClient = netClient()
  private off: (() => void) | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private view: 'home' | 'room' | 'offline' | 'connecting' | null = null
  private toastTimer: ReturnType<typeof setTimeout> | null = null
  private lastKey = ''
  private vis: 'private' | 'public' = 'private'
  private max = 4
  private head!: HTMLElement
  private body!: HTMLElement
  private status!: HTMLElement
  private toastEl!: HTMLElement

  protected build(root: HTMLElement) {
    bindNet(this.app)
    root.classList.add('net-lobby')
    // keys typed here are not game input (Input blocks Space / arrows on window)
    root.addEventListener('keydown', (e) => e.stopPropagation())
    root.addEventListener('pointerdown', (e) => e.stopPropagation())
    this.head = h('div.panel-head')
    this.status = h('div.nl-status')
    this.body = h('div.panel-scroll.nl-body')
    this.toastEl = h('div.nl-toast', { hidden: true })
    root.append(h('div.menu-screen.nl-screen', null, h('div.panel.nl-panel', null, this.head, this.status, this.body), this.toastEl))
    this.off = this.net.on((m) => {
      if (m.t === 'error') this.toast(m.msg)
      if (m.t === 'room' || m.t === 'rooms' || m.t === 'status') this.render()
    })
    this.poll = setInterval(() => {
      if (this.net.status === 'online' && !this.net.room) this.net.send({ t: 'list' })
      this.renderStatus()
    }, 2500)
    this.render()
    void this.connect()
  }

  private async connect() {
    try {
      await this.net.connect()
      this.net.send({ t: 'list' })
      const code = typeof this.params.join === 'string' ? this.params.join : ''
      if (code && this.net.room?.code !== code.toUpperCase()) this.net.send({ t: 'join', code })
    } catch (e) {
      this.toast((e as Error).message)
    }
    this.render()
  }

  unmount() {
    super.unmount()
    this.off?.()
    if (this.poll) clearInterval(this.poll)
    if (this.toastTimer) clearTimeout(this.toastTimer)
  }

  protected back() {
    if (this.net.room) {
      this.sound('back')
      this.net.send({ t: 'leave' })
      return
    }
    this.saveName()
    this.app.toMenu()
  }

  private toast(msg: string) {
    this.toastEl.textContent = msg
    this.toastEl.hidden = false
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => (this.toastEl.hidden = true), 4000)
  }

  private renderStatus() {
    const n = this.net
    const q = n.rtt < 80 ? 'good' : n.rtt < 160 ? 'ok' : 'bad'
    const [cls, text] = n.status === 'online' ? [q, `Online · ${Math.round(n.rtt)} ms`] : n.status === 'connecting' ? ['wait', 'Connecting…'] : ['off', 'Offline']
    this.status.replaceChildren(h('i.nl-dot', { class: cls }), h('span', null, text))
  }

  private render() {
    this.renderStatus()
    const n = this.net
    if (n.room) return this.renderRoom(n.room)
    if (n.status === 'online') return this.renderHome()
    if (n.status === 'offline') {
      if (this.view === 'offline') return
      this.view = 'offline'
      this.setHead('Online', () => this.app.toMenu())
      this.body.replaceChildren(
        h(
          'div.card.nl-center',
          null,
          h('div.card-title', null, 'Can’t reach the game server'),
          h('div.card-text', null, 'Online play needs the Tanks! server. Check your connection and try again.'),
          button('Try again', { icon: 'restart', class: 'primary', autofocus: true, onclick: () => this.retry() }),
        ),
      )
      this.refocus()
      return
    }
    if (this.view === 'connecting') return
    this.view = 'connecting'
    this.setHead('Online', () => this.app.toMenu())
    this.body.replaceChildren(h('div.nl-loading', null, 'Connecting…'))
  }

  private setHead(title: string, back: () => void, label = 'Back') {
    this.head.replaceChildren(backButton(back, label), band(title))
  }

  private retry() {
    this.view = null
    this.net.connect().then(
      () => (this.net.send({ t: 'list' }), this.render()),
      (er) => this.toast(er.message),
    )
    this.render()
  }

  // ---- no room ---------------------------------------------------------------------------

  private renderHome() {
    if (this.view !== 'home') {
      this.view = 'home'
      this.lastKey = ''
      this.setHead('Online', () => this.back())
      const name = h('input.nl-input', { maxLength: 16, placeholder: 'Player', value: this.net.name, spellcheck: 'false', autocomplete: 'nickname', 'data-k': 'name' })
      name.addEventListener('change', () => this.saveName())
      const code = h('input.nl-input.nl-code', { maxLength: 8, placeholder: 'ABCDE', spellcheck: 'false', autocapitalize: 'characters', autocomplete: 'off', 'data-k': 'code' })
      const join = () => {
        const c = code.value.trim()
        if (c) (this.sound('ok'), this.net.send({ t: 'join', code: c }))
      }
      code.addEventListener('keydown', (e) => e.key === 'Enter' && join())
      this.body.replaceChildren(
        h('p.nl-lede', null, 'Play the campaign together with up to 4 friends, or battle it out in Versus.'),
        h('label.nl-name', null, h('span', null, 'Your name'), name),
        this.k('quick', button('Quick play', { icon: 'play', class: 'primary big nl-quick', hint: 'Join an open room, or start one others can find', autofocus: true, onclick: () => this.act(() => this.net.send({ t: 'quick' })) })),
        h(
          'div.nl-two',
          null,
          h(
            'div.card',
            null,
            h('div.card-title', null, 'Create a room'),
            h('div.nl-row', null, h('span.row-label', null, 'Who can join'), this.seg('vis', [['private', 'Invite only'], ['public', 'Anyone']], this.vis, (v) => (this.vis = v as 'private' | 'public'))),
            h('div.nl-row', null, h('span.row-label', null, 'Players'), this.seg('max', [['2', '2'], ['3', '3'], ['4', '4']], String(this.max), (v) => (this.max = Number(v)))),
            h('div.card-actions.one', null, this.k('create', button('Create room', { icon: 'online', onclick: () => this.act(() => this.net.send({ t: 'create', public: this.vis === 'public', maxPlayers: this.max })) }))),
          ),
          h(
            'div.card',
            null,
            h('div.card-title', null, 'Join with a code'),
            h('div.card-text', null, 'Got a code or a link from a friend?'),
            code,
            h('div.card-actions.one', null, button('Join', { icon: 'play', onclick: () => (this.saveName(), join()) })),
          ),
        ),
        h('div.card.nl-roomlist', null, h('div.records-head', null, 'Open rooms'), h('div.nl-rooms')),
      )
      this.refocus()
    }
    const list = this.body.querySelector<HTMLElement>('.nl-rooms')!
    const key = JSON.stringify(this.net.rooms)
    if (key === this.lastKey) return
    this.lastKey = key
    const had = this.focusKey()
    const rooms = this.net.rooms
    list.replaceChildren(
      ...(rooms.length
        ? rooms.map((r) => {
            const full = r.players >= r.maxPlayers
            const seats = h('span.nl-seats')
            for (let s = 0; s < r.maxPlayers; s++) seats.append(tankIcon(s < r.players ? PLAYER_COLORS[s].body : '#d9c6a4', s < r.players ? PLAYER_COLORS[s].dark : '#b09a78'))
            const b = button(full ? 'Full' : 'Join', { class: 'small', disabled: full, onclick: () => this.act(() => this.net.send({ t: 'join', code: r.code })) })
            b.dataset.k = `room-${r.code}`
            return h(
              'div.nl-room',
              null,
              h('div.nl-room-name', null, h('b', null, r.name), h('small', null, `${modeName(r.mode)} · ${r.state === 'lobby' ? 'waiting' : 'in game'}`)),
              seats,
              b,
            )
          })
        : [h('div.nl-empty', null, 'No public rooms right now. Create one, or try Quick play!')]),
    )
    this.refocus(had)
  }

  // ---- in a room ---------------------------------------------------------------------------

  private renderRoom(room: RoomInfo) {
    const me = room.members.find((m) => m.slot === room.you)
    const host = !!me?.host
    const typing = document.activeElement?.tagName === 'INPUT' && this.body.contains(document.activeElement)
    // pings change all the time: they update in place, anything else rebuilds
    const key = JSON.stringify([{ ...room, members: room.members.map((m) => ({ ...m, ping: 0 })) }, host])
    if (this.view === 'room' && (key === this.lastKey || typing)) {
      for (const m of room.members) {
        const el = this.body.querySelector(`[data-ping="${m.slot}"]`)
        if (el && m.connected && !m.spectating) el.textContent = `${m.ping} ms`
      }
      return
    }
    const first = this.view !== 'room'
    this.view = 'room'
    this.lastKey = key
    const had = first ? undefined : this.focusKey()
    this.setHead(room.name, () => this.back(), 'Leave room')
    const s = room.settings
    const mode = MODES.find((m) => m.id === s.mode)!
    const share = touch() && typeof navigator.share === 'function'
    // the code and the invite link
    const codeCard = h(
      'div.nl-codebar',
      null,
      h('div.nl-codebox', null, h('small', null, room.public ? 'Public room · code' : 'Invite only · code'), h('b', null, room.code)),
      h(
        'div.nl-share',
        null,
        share ? this.k('share', button('Share invite', { icon: 'share', class: 'small', onclick: () => void this.share() })) : null,
        this.k('copy', button('Copy link', { icon: 'copy', class: 'small', onclick: () => void this.copy() })),
      ),
    )
    // the seats
    const seats = h('div.nl-players')
    for (let i = 0; i < room.maxPlayers; i++) {
      const m = room.members.find((x) => x.slot === i)
      const c = PLAYER_COLORS[i]
      seats.append(
        m
          ? h(
              'div.nl-player',
              { class: `${m.slot === room.you ? 'you' : ''} ${m.connected ? '' : 'away'}` },
              tankIcon(c.body, c.dark),
              h(
                'div.nl-who',
                null,
                h('b', null, m.name || 'Player'),
                h(
                  'span.nl-meta',
                  null,
                  m.host ? h('span.nl-tag.host', null, 'Host') : null,
                  m.slot === room.you ? h('span.nl-tag', null, 'You') : null,
                  h('small', { 'data-ping': m.slot }, m.connected ? (m.spectating ? 'next game' : `${m.ping} ms`) : 'reconnecting…'),
                ),
              ),
            )
          : h('div.nl-player.empty', null, tankIcon(c.body, c.dark), h('span', null, `${PLAYER_COLOR_NAMES[i]} · waiting for a player`)),
      )
    }
    // the game settings (the host's to change)
    const dis = !host
    const opts: (HTMLElement | null)[] = []
    if (s.mode === 'coop') {
      const top = s.allMissions ? 100 : 20
      opts.push(
        this.row('Start at mission', this.stepper('mission', s.mission + 1, 1, top, dis, (v) => this.set({ mission: v - 1 }))),
        this.row('All 100 missions', this.toggle('all', s.allMissions, dis, (on) => this.set({ allMissions: on })), 'Keep going after mission 20'),
      )
    } else if (s.mode === 'pack') {
      opts.push(h('div.nl-pack', null, s.packName ? h('span', null, h('b', null, s.packName), ` · ${s.packLevels} level${s.packLevels === 1 ? '' : 's'}`) : h('i', null, 'No pack chosen yet')))
      if (host) {
        const id = h('input.nl-input', { placeholder: 'Pack id from the level store', value: s.packId, spellcheck: 'false', 'data-k': 'packId' })
        const load = () => id.value.trim() && this.set({ mode: 'pack', packId: id.value.trim() })
        id.addEventListener('keydown', (e) => e.key === 'Enter' && load())
        const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true })
        file.addEventListener('change', () => this.upload(file))
        opts.push(
          h('div.nl-packrow', null, id, this.k('load', button('Load', { class: 'small', onclick: load }))),
          this.k('file', button('Upload a .json pack', { icon: 'share', class: 'small nl-upload', onclick: () => file.click() })),
          file,
        )
      }
    } else {
      opts.push(
        this.row('Arena', this.stepper('arena', s.arena, 0, ARENAS.length - 1, dis, (v) => this.set({ arena: v }), (v) => ARENAS[v]?.name ?? '?')),
        this.row('Rounds to win', this.stepper('rounds', s.rounds, 1, 9, dis, (v) => this.set({ rounds: v }))),
        this.row('AI tanks', this.stepper('ai', s.ai, 0, 4, dis, (v) => this.set({ ai: v }))),
      )
    }
    const canStart = s.mode !== 'pack' || s.packLevels > 0
    const running = room.state !== 'lobby'
    const start = host
      ? this.k('start', button(running ? 'Game running…' : 'Start game', { icon: 'play', class: 'primary big nl-start', disabled: !canStart || running, autofocus: true, onclick: () => this.act(() => this.net.send({ t: 'start' })) }))
      : h('div.nl-wait', null, running ? 'Game running… you join at the next mission' : 'Waiting for the host to start…')
    const game = h(
      'div.card.nl-game',
      null,
      h('div.nl-game-head', null, h('div.card-title', null, 'Game'), host ? null : h('span.nl-tag', null, 'Host’s choice')),
      this.seg('mode', MODES.map((m) => [m.id, m.name]), s.mode, (v) => this.set({ mode: v as RoomSettings['mode'] }), dis),
      h('div.card-text.nl-desc', null, mode.desc),
      h('div.nl-opts', null, ...opts),
      start,
    )
    this.body.replaceChildren(
      codeCard,
      h('div.nl-two.room', null, h('div.card', null, h('div.records-head', null, `Players · ${room.members.length} / ${room.maxPlayers}`), seats), game),
    )
    this.refocus(had)
  }

  // ---- pieces --------------------------------------------------------------------------------

  /** a labelled settings row */
  private row(label: string, ctl: HTMLElement, hint?: string) {
    return h('div.nl-row', null, h('span.row-label', null, label, hint ? h('small', null, hint) : null), ctl)
  }

  /** a segmented switch (the settings screen's .seg) */
  private seg(k: string, items: [string, string][], on: string, pick: (v: string) => void, disabled = false) {
    const box = h('span.seg')
    for (const [v, label] of items) {
      const b = h('button.seg-btn', { type: 'button', class: v === on ? 'on' : '', disabled, 'data-k': `${k}-${v}` }, label)
      b.addEventListener('click', () => {
        if (b.classList.contains('on')) return
        this.sound('move')
        box.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('on', x === b))
        pick(v)
      })
      box.append(b)
    }
    return box
  }

  /** − value + ; `show` formats the value (the arena's name) */
  private stepper(k: string, v: number, min: number, max: number, disabled: boolean, set: (v: number) => void, show: (v: number) => string = String) {
    const step = (d: number) => {
      const n = Math.max(min, Math.min(max, v + d))
      if (n === v) return
      this.sound('move')
      set(n)
    }
    return h(
      'span.nl-step',
      { class: show === String ? '' : 'wide' },
      h('button.nl-step-btn', { type: 'button', disabled: disabled || v <= min, 'data-k': `${k}-`, 'aria-label': 'Less', onclick: () => step(-1) }, '−'),
      h('output', null, show(v)),
      h('button.nl-step-btn', { type: 'button', disabled: disabled || v >= max, 'data-k': `${k}+`, 'aria-label': 'More', onclick: () => step(1) }, '+'),
    )
  }

  private toggle(k: string, on: boolean, disabled: boolean, set: (on: boolean) => void) {
    return h('button.toggle', { type: 'button', class: on ? 'on' : '', disabled, role: 'switch', 'aria-checked': String(on), 'data-k': k, onclick: () => (this.sound('move'), set(!on)) }, h('span.knob'))
  }

  /** tags a control so its focus survives a re-render */
  private k<T extends HTMLElement>(k: string, el: T) {
    el.dataset.k = k
    return el
  }

  private focusKey() {
    const a = document.activeElement as HTMLElement | null
    return a && this.root.contains(a) ? a.dataset.k : undefined
  }

  private refocus(k?: string) {
    const again = k ? this.root.querySelector<HTMLElement>(`[data-k="${k}"]`) : null
    if (again && !(again as HTMLButtonElement).disabled) again.focus({ preventScroll: true })
    else if (!this.root.contains(document.activeElement) || (document.activeElement as HTMLButtonElement).disabled) requestAnimationFrame(() => this.nav?.focus())
  }

  // ---- actions -------------------------------------------------------------------------------

  private act(f: () => void) {
    this.saveName()
    this.sound('ok')
    f()
  }

  private set(settings: Partial<RoomSettings>) {
    this.net.send({ t: 'settings', settings })
  }

  private upload(input: HTMLInputElement) {
    const f = input.files?.[0]
    if (!f) return
    f.text().then(
      (txt) => {
        try {
          this.net.send({ t: 'settings', settings: { mode: 'pack' }, pack: JSON.parse(txt) as LevelPack })
        } catch {
          this.toast('That file is not a level pack')
        }
      },
      () => this.toast('Could not read the file'),
    )
  }

  private async share() {
    const url = joinLink(this.net.room?.code ?? '')
    try {
      await navigator.share({ title: 'Tanks! online', text: 'Join my Tanks! game', url })
    } catch (e) {
      if ((e as Error).name !== 'AbortError') await this.copy()
    }
  }

  private async copy() {
    const link = joinLink(this.net.room?.code ?? '')
    try {
      await navigator.clipboard.writeText(link)
      this.toast('Invite link copied')
    } catch {
      this.toast(link)
    }
  }

  private saveName() {
    const el = this.root.querySelector<HTMLInputElement>('[data-k="name"]')
    const v = el?.value.trim()
    if (v !== undefined && v !== this.net.name) this.net.setName(v)
  }
}

registerScreen('lobby', () => new Lobby())
