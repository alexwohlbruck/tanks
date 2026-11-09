// 'lobby': online play. Without a room: name, quick play, create (public / private, size),
// join by code, and the list of public rooms. In a room: the code and share link, the players
// (P1 blue, P2 red, P3 green, P4 yellow), the host's game settings (co-op classic, co-op level
// pack, versus) and Start. params: { join?: string } joins that room on open.

import { registerScreen } from '../app/router'
import type { AppContext, Screen } from '../app/types'
import type { LevelPack } from '../levels/format'
import { ARENAS } from './arenas'
import { netClient, type NetClient } from './client'
import { bindNet, joinLink } from './index'
import './net.css'
import { PLAYER_COLOR_NAMES, PLAYER_COLORS, type RoomInfo, type RoomSettings } from './protocol'

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const MODES: { id: RoomSettings['mode']; name: string; desc: string }[] = [
  { id: 'coop', name: 'Co-op', desc: 'The original missions together. One life each; the mission restarts when everyone is down.' },
  { id: 'pack', name: 'Level pack', desc: 'A custom level pack from the level store (or a .json file), played co-op.' },
  { id: 'versus', name: 'Versus', desc: 'Free-for-all: last tank standing wins the round. Optional AI tanks join the fight.' },
]

class Lobby implements Screen {
  readonly opaque = true
  readonly modal = true
  private root!: HTMLElement
  private app!: AppContext
  private net: NetClient = netClient()
  private off: (() => void) | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private view: 'home' | 'room' | null = null
  private toastTimer: ReturnType<typeof setTimeout> | null = null
  private lastSettings = ''

  async mount(root: HTMLElement, app: AppContext, params?: Record<string, unknown>) {
    this.root = root
    this.app = app
    bindNet(app)
    root.classList.add('net-ui', 'net-lobby')
    // keys typed here are not game input (Input blocks Space / arrows on window)
    root.addEventListener('keydown', (e) => e.stopPropagation())
    root.addEventListener('pointerdown', (e) => e.stopPropagation())
    root.innerHTML = `<div class="nl-wrap"><header class="nl-head"><button class="net-btn ghost" data-act="back">← Menu</button><h1>Tanks! <span>Online</span></h1><div class="nl-status"></div></header><main class="nl-main"><div class="nl-loading">Connecting…</div></main><div class="nl-toast" hidden></div></div>`
    root.addEventListener('click', (e) => this.onClick(e))
    root.addEventListener('change', (e) => this.onChange(e))
    this.off = this.net.on((m) => {
      if (m.t === 'error') this.toast(m.msg)
      if (m.t === 'room' || m.t === 'rooms' || m.t === 'status') this.render()
    })
    this.poll = setInterval(() => {
      if (this.net.status === 'online' && !this.net.room) this.net.send({ t: 'list' })
      this.renderStatus()
    }, 2500)
    try {
      await this.net.connect()
      this.net.send({ t: 'list' })
      const code = typeof params?.join === 'string' ? params.join : ''
      if (code && this.net.room?.code !== code.toUpperCase()) this.net.send({ t: 'join', code })
    } catch (e) {
      this.toast((e as Error).message)
    }
    this.render()
  }

  unmount() {
    this.off?.()
    if (this.poll) clearInterval(this.poll)
  }

  private toast(msg: string) {
    const t = this.root.querySelector<HTMLElement>('.nl-toast')!
    t.textContent = msg
    t.hidden = false
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => (t.hidden = true), 4000)
  }

  private renderStatus() {
    const el = this.root.querySelector('.nl-status')!
    const n = this.net
    el.innerHTML = n.status === 'online' ? `<span class="nh-dot ${n.rtt < 80 ? 'good' : n.rtt < 160 ? 'ok' : 'bad'}"></span>${Math.round(n.rtt)} ms` : n.status === 'connecting' ? 'connecting…' : '<span class="nh-dot off"></span>offline'
  }

  private render() {
    this.renderStatus()
    const main = this.root.querySelector<HTMLElement>('.nl-main')!
    const n = this.net
    if (n.status !== 'online' && !n.room) {
      if (n.status === 'offline') {
        this.view = null
        main.innerHTML = `<div class="nl-card nl-center"><h2>Can't reach the game server</h2><p>Online play needs the Tanks! server.</p><button class="net-btn primary" data-act="retry">Try again</button></div>`
      }
      return
    }
    if (n.room) this.renderRoom(main, n.room)
    else this.renderHome(main)
  }

  // ---- no room ---------------------------------------------------------------------------

  private renderHome(main: HTMLElement) {
    if (this.view !== 'home') {
      this.view = 'home'
      this.lastSettings = ''
      main.innerHTML = `
        <section class="nl-card nl-name"><label>Your name <input class="nl-input" data-f="name" maxlength="16" placeholder="Player" value="${esc(this.net.name)}"></label></section>
        <section class="nl-grid">
          <div class="nl-card"><h2>Quick play</h2><p>Jump into an open public room, or start one others can find.</p><button class="net-btn primary big" data-act="quick">Play now</button></div>
          <div class="nl-card"><h2>Create a room</h2>
            <div class="nl-seg" data-f="vis"><button class="on" data-v="private">Private</button><button data-v="public">Public</button></div>
            <label class="nl-row">Players <select class="nl-input" data-f="max"><option>2</option><option>3</option><option selected>4</option></select></label>
            <button class="net-btn primary" data-act="create">Create</button></div>
          <div class="nl-card"><h2>Join with a code</h2><p>Got a code or a link from a friend?</p>
            <input class="nl-input nl-code" data-f="code" maxlength="8" placeholder="ABCDE" autocapitalize="characters" spellcheck="false">
            <button class="net-btn primary" data-act="join">Join</button></div>
        </section>
        <section class="nl-card"><h2>Open rooms</h2><div class="nl-rooms"></div></section>`
    }
    const list = main.querySelector('.nl-rooms')!
    const rooms = this.net.rooms
    list.innerHTML = rooms.length
      ? rooms
          .map(
            (r) =>
              `<div class="nl-room"><b>${esc(r.name)}</b><span class="tag">${MODES.find((m) => m.id === r.mode)?.name ?? r.mode}</span><span>${r.players}/${r.maxPlayers}</span><span class="state ${r.state}">${r.state === 'lobby' ? 'waiting' : 'in game'}</span><button class="net-btn small" data-act="joinCode" data-code="${esc(r.code)}" ${r.players >= r.maxPlayers ? 'disabled' : ''}>Join</button></div>`,
          )
          .join('')
      : `<p class="nl-empty">No public rooms right now. Create one!</p>`
  }

  // ---- in a room ---------------------------------------------------------------------------

  private renderRoom(main: HTMLElement, room: RoomInfo) {
    const me = room.members.find((m) => m.slot === room.you)
    const host = !!me?.host
    if (this.view !== 'room') {
      this.view = 'room'
      this.lastSettings = ''
      main.innerHTML = `
        <section class="nl-card nl-roomhead">
          <div><h2 class="nl-roomname"></h2><span class="tag nl-vis"></span></div>
          <div class="nl-codebox"><small>Room code</small><b class="nl-bigcode"></b></div>
          <div class="nl-share"><button class="net-btn" data-act="copy">Copy invite link</button><button class="net-btn ghost" data-act="leave">Leave room</button></div>
        </section>
        <section class="nl-grid two">
          <div class="nl-card"><h2>Players</h2><div class="nl-players"></div></div>
          <div class="nl-card nl-settings"></div>
        </section>`
    }
    main.querySelector('.nl-roomname')!.textContent = room.name
    main.querySelector('.nl-vis')!.textContent = room.public ? 'Public' : 'Private'
    main.querySelector('.nl-bigcode')!.textContent = room.code
    const slots: string[] = []
    for (let s = 0; s < room.maxPlayers; s++) {
      const m = room.members.find((x) => x.slot === s)
      slots.push(
        m
          ? `<div class="nl-player${m.slot === room.you ? ' you' : ''}${m.connected ? '' : ' away'}"><i class="tankdot" style="--c:${PLAYER_COLORS[s]}"></i><b>${esc(m.name)}</b>${m.host ? '<span class="tag host">host</span>' : ''}${m.slot === room.you ? '<span class="tag">you</span>' : ''}<small>${m.connected ? `${m.ping} ms` : 'reconnecting…'}</small></div>`
          : `<div class="nl-player empty"><i class="tankdot" style="--c:${PLAYER_COLORS[s]}"></i><span>${PLAYER_COLOR_NAMES[s]} · waiting for a player</span></div>`,
      )
    }
    main.querySelector('.nl-players')!.innerHTML = slots.join('')
    // settings: rebuilt when they change, but not under the host's cursor
    const panel = main.querySelector<HTMLElement>('.nl-settings')!
    const key = JSON.stringify([room.settings, host, room.state, room.members.length])
    if (key !== this.lastSettings && !(panel.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT')) {
      this.lastSettings = key
      panel.innerHTML = this.settingsHtml(room, host)
    }
  }

  private settingsHtml(room: RoomInfo, host: boolean) {
    const s = room.settings
    const dis = host ? '' : 'disabled'
    const mode = MODES.find((m) => m.id === s.mode)!
    let opts = ''
    if (s.mode === 'coop') {
      opts = `<label class="nl-row">Start at mission <input class="nl-input num" type="number" data-f="mission" min="1" max="${s.allMissions ? 100 : 20}" value="${s.mission + 1}" ${dis}></label>
        <label class="nl-row check"><input type="checkbox" data-f="allMissions" ${s.allMissions ? 'checked' : ''} ${dis}> All 100 missions</label>`
    } else if (s.mode === 'pack') {
      opts = `<div class="nl-pack">${s.packName ? `<b>${esc(s.packName)}</b> · ${s.packLevels} level${s.packLevels === 1 ? '' : 's'}` : '<i>No pack chosen</i>'}</div>` +
        (host
          ? `<label class="nl-row">Store id <input class="nl-input" data-f="packId" placeholder="pack id" value="${esc(s.packId)}"></label>
             <div class="nl-row"><button class="net-btn small" data-act="loadPack">Load from store</button><label class="net-btn small file">Upload .json<input type="file" accept=".json,application/json" data-f="packFile" hidden></label></div>`
          : '')
    } else {
      opts = `<label class="nl-row">Arena <select class="nl-input" data-f="arena" ${dis}>${ARENAS.map((a, i) => `<option value="${i}" ${i === s.arena ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
        <label class="nl-row">Rounds to win <input class="nl-input num" type="number" data-f="rounds" min="1" max="9" value="${s.rounds}" ${dis}></label>
        <label class="nl-row">AI tanks <input class="nl-input num" type="number" data-f="ai" min="0" max="4" value="${s.ai}" ${dis}></label>`
    }
    const canStart = s.mode !== 'pack' || s.packLevels > 0
    const starting = room.state !== 'lobby'
    return `<h2>Game</h2>
      <div class="nl-seg modes" data-f="mode">${MODES.map((m) => `<button class="${m.id === s.mode ? 'on' : ''}" data-v="${m.id}" ${dis}>${m.name}</button>`).join('')}</div>
      <p class="nl-desc">${mode.desc}</p>
      <div class="nl-opts">${opts}</div>
      ${host ? `<button class="net-btn primary big" data-act="start" ${canStart && !starting ? '' : 'disabled'}>${starting ? 'Game running…' : 'Start game'}</button>` : `<p class="nl-wait">${starting ? 'Game running…' : 'Waiting for the host to start…'}</p>`}`
  }

  // ---- input ---------------------------------------------------------------------------------

  private field<T extends HTMLElement = HTMLInputElement>(f: string) {
    return this.root.querySelector<T>(`[data-f="${f}"]`)
  }

  private onClick(e: Event) {
    const t = e.target as HTMLElement
    const seg = t.closest('.nl-seg button') as HTMLButtonElement | null
    if (seg && !seg.disabled) {
      const box = seg.parentElement!
      const f = box.getAttribute('data-f')
      if (f === 'mode') this.net.send({ t: 'settings', settings: { mode: seg.dataset.v as RoomSettings['mode'] } })
      else {
        box.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === seg))
      }
      return
    }
    const btn = t.closest('[data-act]') as HTMLElement | null
    if (!btn || (btn as HTMLButtonElement).disabled) return
    const n = this.net
    this.saveName()
    switch (btn.dataset.act) {
      case 'back':
        if (n.room) n.send({ t: 'leave' })
        this.app.toMenu()
        return
      case 'retry':
        n.connect().then(() => this.render(), (er) => this.toast(er.message))
        this.render()
        return
      case 'quick':
        n.send({ t: 'quick' })
        return
      case 'create': {
        const pub = this.root.querySelector('[data-f="vis"] .on')?.getAttribute('data-v') === 'public'
        n.send({ t: 'create', public: pub, maxPlayers: Number(this.field<HTMLSelectElement>('max')?.value ?? 4) })
        return
      }
      case 'join': {
        const code = this.field('code')?.value.trim() ?? ''
        if (code) n.send({ t: 'join', code })
        return
      }
      case 'joinCode':
        n.send({ t: 'join', code: btn.dataset.code ?? '' })
        return
      case 'leave':
        n.send({ t: 'leave' })
        return
      case 'copy': {
        const link = joinLink(n.room?.code ?? '')
        navigator.clipboard?.writeText(link).then(
          () => this.toast('Invite link copied'),
          () => this.toast(link),
        ) ?? this.toast(link)
        return
      }
      case 'start':
        n.send({ t: 'start' })
        return
      case 'loadPack': {
        const id = this.field('packId')?.value.trim() ?? ''
        if (id) n.send({ t: 'settings', settings: { mode: 'pack', packId: id } })
        return
      }
    }
  }

  private onChange(e: Event) {
    const t = e.target as HTMLInputElement
    const f = t.dataset.f
    const n = this.net
    if (f === 'name') return this.saveName()
    if (f === 'mission') n.send({ t: 'settings', settings: { mission: Number(t.value) - 1 } })
    else if (f === 'allMissions') n.send({ t: 'settings', settings: { allMissions: t.checked } })
    else if (f === 'arena' || f === 'rounds' || f === 'ai') n.send({ t: 'settings', settings: { [f]: Number(t.value) } })
    else if (f === 'packFile' && t.files?.[0]) {
      t.files[0].text().then(
        (txt) => {
          try {
            n.send({ t: 'settings', settings: { mode: 'pack' }, pack: JSON.parse(txt) as LevelPack })
          } catch {
            this.toast('That file is not a level pack')
          }
        },
        () => this.toast('Could not read the file'),
      )
    }
  }

  private saveName() {
    const v = this.field('name')?.value.trim()
    if (v !== undefined && v !== this.net.name) this.net.setName(v)
  }
}

registerScreen('lobby', () => new Lobby())
