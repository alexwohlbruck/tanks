// 'net-hud': the overlay of an online game. Never modal (the game keeps the input), except
// for its own panels: the Esc menu (leave) and the end-of-game choice (host: play again / back
// to the room). Shows ping, the players, the versus scoreboard and round banners.

import { registerScreen } from '../app/router'
import type { AppContext, Screen } from '../app/types'
import { unlock } from '../ui/shared/achievements'
import { netClient } from './client'
import { currentSession } from './index'
import './net.css'
import { PLAYER_COLORS as TANK_COLORS, tankIcon } from '../ui/web/art'
import '../ui/web/web.css'
import { PLAYER_COLOR_NAMES, PLAYER_COLORS, type RoomInfo } from './protocol'

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

class NetHud implements Screen {
  readonly opaque = false
  readonly modal = false
  private el: Record<string, HTMLElement> = {}
  private menu = false
  private frame = 0
  private last: Record<string, string> = {}

  mount(root: HTMLElement, _app: AppContext) {
    root.classList.add('web', 'net-ui', 'net-hud')
    root.innerHTML = `
      <div class="nh-bar"><span class="nh-dot"></span><span class="nh-ping"></span><span class="nh-room"></span></div>
      <div class="nh-players"></div>
      <div class="nh-vs"></div>
      <div class="nh-banner"></div>
      <div class="panel nh-panel nh-end" hidden></div>
      <div class="panel nh-panel nh-menu" hidden>
        <div class="band"><span>Online game</span></div>
        <p>The game keeps running while this is open.</p>
        <div class="nh-buttons">
          ${btn('resume', 'Resume', 'primary')}
          ${btn('leave', 'Leave game')}
        </div>
      </div>`
    for (const k of ['ping', 'room', 'dot', 'players', 'vs', 'banner', 'end', 'menu']) this.el[k] = root.querySelector(`.nh-${k}`)!
    root.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest('[data-act]')?.getAttribute('data-act')
      if (!act) return
      e.stopPropagation()
      const net = netClient()
      if (act === 'resume') this.setMenu(false)
      else if (act === 'leave') {
        this.setMenu(false)
        net.send({ t: 'leave' })
      } else if (act === 'again') net.send({ t: 'end', choice: 'again' })
      else if (act === 'lobby') net.send({ t: 'end', choice: 'lobby' })
    })
    // clicks on the panels are not shots
    root.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.nh-panel')) e.stopPropagation()
    })
    const s = currentSession()
    if (s) s.onPause = () => this.setMenu(!this.menu)
    this.update()
  }

  unmount() {
    const s = currentSession()
    if (s) {
      s.onPause = null
      s.inputBlocked = false
    }
  }

  private setMenu(on: boolean) {
    this.menu = on
    this.el.menu.hidden = !on
    const s = currentSession()
    if (s) s.inputBlocked = on
  }

  private set(k: string, html: string) {
    if (this.last[k] === html) return
    this.last[k] = html
    this.el[k].innerHTML = html
  }

  update() {
    if (this.frame++ % 6) return
    const net = netClient()
    const s = currentSession()
    const room = net.room
    const st = s?.stats
    const online = net.status === 'online'
    this.el.dot.className = `nh-dot ${online ? (net.rtt < 80 ? 'good' : net.rtt < 160 ? 'ok' : 'bad') : 'off'}`
    this.set('ping', online ? `${Math.round(net.rtt)} ms` : 'reconnecting…')
    this.set('room', room ? `${esc(room.code)}${st ? ` · ${st.kbIn.toFixed(1)} KB/s` : ''}` : '')
    this.set('players', room ? this.players(room) : '')
    const meta = s?.meta
    const vs = meta?.vs
    this.set('vs', vs ? this.scoreboard(room, vs.scores, vs.frags, vs.round, vs.target, meta!.players) : '')
    // achievements: a campaign with a friend, a versus match won
    if (s && s.me >= 0 && room && room.state === 'playing' && room.members.length >= 2 && room.settings.mode !== 'versus') unlock('online-coop')
    if (s && vs && vs.phase === 'end' && vs.winner >= 0 && vs.winner === s.me && meta!.players >= 2) unlock('vs-win')
    let banner = ''
    if (s && s.me < 0 && room && room.state === 'playing') banner = `<div class="nh-spec">Spectating · you join ${vs ? 'next round' : 'at the next mission'}</div>`
    if (vs) {
      const who = (i: number) => `<b class="nh-who" style="--c:${PLAYER_COLORS[i]}">${esc(nameOf(room, i))}</b>`
      if (vs.phase === 'start') banner += `<div class="band nh-big"><span>Round ${vs.round}</span></div>`
      else if (vs.phase === 'result') banner += `<div class="band nh-big"><span>${vs.winner >= 0 ? `${who(vs.winner)} wins the round` : 'Draw'}</span></div>`
      else if (vs.phase === 'end') banner += `<div class="band nh-big"><span>${vs.winner >= 0 ? `${who(vs.winner)} wins the match!` : 'Match over'}</span></div>`
    }
    this.set('banner', banner)
    // end of the game: the host decides
    const ended = room?.state === 'ended'
    this.el.end.hidden = !ended
    if (ended && room) {
      const me = room.members.find((m) => m.slot === room.you)
      const title = vs ? 'Match over' : meta && meta.st === 12 ? 'Game over' : 'Game over'
      this.set(
        'end',
        `<div class="band"><span>${title}</span></div>` +
          (me?.host
            ? `<div class="nh-buttons">${btn('again', 'Play again', 'primary')}${btn('lobby', 'Back to room')}</div>`
            : `<p>Waiting for the host…</p><div class="nh-buttons">${btn('leave', 'Leave')}</div>`),
      )
    }
  }

  private players(room: RoomInfo) {
    return room.members
      .map(
        (m) =>
          `<div class="nh-chip${m.connected ? '' : ' away'}${m.slot === room.you ? ' you' : ''}">${tank(m.slot)}<b>${esc(m.name)}</b>${m.host ? ' <span class="nh-host" title="host">★</span>' : ''}<small>${m.connected ? `${m.ping} ms` : 'away'}${m.spectating ? ' · next' : ''}</small></div>`,
      )
      .join('')
  }

  private scoreboard(room: RoomInfo | null, scores: number[], frags: number[], round: number, target: number, players: number) {
    let rows = ''
    for (let i = 0; i < players; i++) {
      let pips = ''
      for (let k = 0; k < target; k++) pips += `<span class="pip${k < scores[i] ? ' on' : ''}" style="--c:${PLAYER_COLORS[i]}"></span>`
      rows += `<div class="nh-row">${tank(i)}<span class="nm">${esc(nameOf(room, i))}</span>${pips}<small>${frags[i]} ✕</small></div>`
    }
    return `<div class="records-head">Versus · round ${round} · first to ${target}</div>${rows}`
  }
}

/** a cream button tile (web.css .btn) */
function btn(act: string, label: string, cls = '') {
  return `<button class="btn ${cls}" type="button" data-act="${act}"><span class="label"><span class="t">${label}</span></span></button>`
}

/** a player's toy tank icon */
function tank(slot: number) {
  const c = TANK_COLORS[slot] ?? { body: '#b9b3a6', dark: '#6b665c' }
  return tankIcon(c.body, c.dark).outerHTML
}

function nameOf(room: RoomInfo | null, slot: number) {
  return room?.members.find((m) => m.slot === slot)?.name ?? PLAYER_COLOR_NAMES[slot] ?? `P${slot + 1}`
}

registerScreen('net-hud', () => new NetHud())
