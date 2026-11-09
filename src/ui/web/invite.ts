// 'invite': play a campaign online with a friend. Opened from the Campaign page with
// params.campaign 'classic' | 'tanksplus': creates a private online room (src/net, the same
// rooms the lobby uses) set to co-op on that campaign, shows the join link (?join=CODE) to copy
// or share, and starts as soon as a friend has joined (or when the host presses Start). Once the
// game runs, src/net takes over (the 'net-hud' screen, back to the 'lobby' room afterwards).

import { registerScreen } from '../../app/router'
import { TANKS_PLUS_WORLDS, tanksPlus } from '../../levels/packs'
import { netClient } from '../../net/client'
import { bindNet, joinLink } from '../../net'
import type { RoomInfo } from '../../net/protocol'
import { loadPlayerData } from '../shared/save'
import { PLAYER_COLORS, tankIcon } from './art'
import { backButton, band, button, WebScreen } from './base'
import { h, touch } from './dom'
import { plusProgress } from './tanksplus'
import './achievements.css'

/** a friend joined: start after this long (time to see who it is) */
const START_DELAY = 1500

class InviteScreen extends WebScreen {
  private net = netClient()
  private off: (() => void) | null = null
  private campaign: 'classic' | 'tanksplus' = 'classic'
  /** Tanks+: first level of the chosen world */
  private first = 0
  /** the room this screen created */
  private code = ''
  /** the create request is out (and the room the app was in before, which is not ours) */
  private creating = false
  private oldCode = ''
  private settingsSent = ''
  private started = false
  private leaving = false
  private startTimer: ReturnType<typeof setTimeout> | null = null
  private status = 'Connecting…'
  private error = false
  private body!: HTMLElement
  private lastKey = ''

  protected build(root: HTMLElement) {
    this.campaign = this.params.campaign === 'tanksplus' ? 'tanksplus' : 'classic'
    const reached = plusProgress()
    const w = TANKS_PLUS_WORLDS.findIndex((x) => reached >= x.first && reached < x.first + x.count)
    this.first = TANKS_PLUS_WORLDS[Math.max(0, w)].first
    this.body = h('div.invite-body')
    root.append(
      h(
        'div.invite-screen',
        null,
        h('div.panel.invite', null, h('div.panel-head', null, backButton(() => this.back(), 'Cancel'), band('Play online')), this.body),
      ),
    )
    // typing in the page is not game input
    root.addEventListener('keydown', (e) => e.stopPropagation())
    this.off = this.net.on((m) => {
      if (m.t === 'error') this.fail(m.msg)
      if (m.t === 'room' || m.t === 'status') this.sync()
    })
    this.render()
    void this.open()
  }

  private async open() {
    bindNet(this.app)
    try {
      await this.net.connect()
    } catch {
      return this.fail("Can't reach the game server.")
    }
    if (this.leaving) return
    this.oldCode = this.net.room?.code ?? ''
    if (this.net.room) this.net.send({ t: 'leave' })
    this.creating = true
    this.status = 'Creating a private room…'
    this.net.send({ t: 'create', public: false, maxPlayers: 4 })
    this.render()
  }

  private fail(msg: string) {
    this.status = msg
    this.error = true
    this.render()
  }

  /** room updates: settings once it exists, then start when a friend is in */
  private sync() {
    const room = this.net.room
    if (room && this.creating && !this.code && room.code !== this.oldCode && room.members.length === 1 && room.state === 'lobby') {
      this.code = room.code
      this.creating = false
    }
    if (!room || room.code !== this.code) return this.render()
    const me = room.members.find((m) => m.slot === room.you)
    if (!me?.host) return this.render()
    this.sendSettings()
    const friends = room.members.filter((m) => m.slot !== room.you && m.connected).length
    if (friends > 0 && this.ready(room) && room.state === 'lobby' && !this.started && !this.startTimer) {
      this.status = 'Your friend is here. Starting…'
      this.startTimer = setTimeout(() => this.startGame(), START_DELAY)
    }
    this.render()
  }

  private sendSettings() {
    const key = `${this.campaign}:${this.first}`
    if (this.settingsSent === key) return
    const packSent = this.settingsSent.startsWith('tanksplus:')
    this.settingsSent = key
    if (this.campaign === 'classic') this.net.send({ t: 'settings', settings: { mode: 'coop', mission: 0, allMissions: loadPlayerData().medal >= 3 } })
    // the pack goes once; another world only moves the start level
    else if (packSent) this.net.send({ t: 'settings', settings: { mission: this.first } })
    else this.net.send({ t: 'settings', settings: { mode: 'pack', allMissions: true, mission: this.first }, pack: tanksPlus })
    this.status = 'Waiting for your friend to join…'
  }

  /** the room is set up for this campaign */
  private ready(room: RoomInfo) {
    const s = room.settings
    return this.campaign === 'classic' ? s.mode === 'coop' : s.mode === 'pack' && s.packLevels > 0 && s.mission === this.first
  }

  private startGame() {
    this.startTimer = null
    const room = this.net.room
    if (this.started || !room || room.code !== this.code || !this.ready(room)) return
    this.started = true
    this.status = 'Starting…'
    this.net.send({ t: 'start' })
    this.render()
  }

  private link() {
    return this.code ? joinLink(this.code) : ''
  }

  /** phones: the share sheet; elsewhere (or when it fails) the clipboard */
  private async share() {
    const url = this.link()
    if (!url) return
    if (canShare()) {
      const title = this.campaign === 'classic' ? 'Tanks! co-op' : 'Tanks+ co-op'
      try {
        await navigator.share({ title, text: `Join my ${title} game`, url })
        return
      } catch (e) {
        if ((e as Error).name === 'AbortError') return
      }
    }
    await this.copyLink()
  }

  private flash(msg: string) {
    const prev = this.status
    this.status = msg
    this.render(true)
    setTimeout(() => {
      if (this.status === msg) {
        this.status = prev
        this.render(true)
      }
    }, 2000)
  }

  private render(force = false) {
    const room = this.net.room && this.net.room.code === this.code ? this.net.room : null
    const key = JSON.stringify([room?.members, room?.state, this.status, this.error, this.first, this.started, this.code])
    if (key === this.lastKey && !force) return
    this.lastKey = key
    const had = this.root.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.k : undefined
    const classic = this.campaign === 'classic'
    const reached = plusProgress()
    const kids: (Node | null)[] = [
      h(
        'div.invite-what',
        null,
        tankIcon(PLAYER_COLORS[1].body, PLAYER_COLORS[1].dark),
        h(
          'div',
          null,
          h('b', null, classic ? 'Classic co-op' : 'Tanks+ co-op'),
          h('span', null, classic ? 'The Wii missions together, on the 2-player rules.' : 'The Tanks+ campaign together, up to 4 players.'),
        ),
      ),
    ]
    if (!classic) {
      const worlds = TANKS_PLUS_WORLDS.filter((w) => w.first <= reached)
      if (worlds.length > 1)
        kids.push(
          h(
            'div.row',
            null,
            h('span.row-label', null, 'Start at'),
            h(
              'span.seg',
              null,
              ...worlds.map((w) =>
                h('button.seg-btn', { type: 'button', class: w.first === this.first ? 'on' : '', 'data-k': `w${w.first}`, disabled: this.started, onclick: () => this.setStart(w.first) }, w.name),
              ),
            ),
          ),
        )
    }
    if (this.code) {
      kids.push(
        h('div.invite-box', null, h('small', null, 'Send your friend this link'), h('div.invite-code', null, this.code), h('div.invite-link', null, this.link())),
        h(
          'div.invite-actions',
          null,
          canShare() ? keyed('share', button('Share invite', { icon: 'share', class: 'primary', autofocus: true, onclick: () => void this.share() })) : null,
          keyed('copy', button('Copy link', { icon: 'copy', class: canShare() ? '' : 'primary', autofocus: !canShare(), onclick: () => void this.copyLink() })),
        ),
      )
      const members = room?.members ?? []
      kids.push(
        h(
          'div.invite-players',
          null,
          ...members.map((m) =>
            h('div.invite-player', null, tankIcon(PLAYER_COLORS[m.slot].body, PLAYER_COLORS[m.slot].dark), h('span', null, m.name || 'Player'), h('small', null, m.slot === room!.you ? 'you' : m.connected ? 'joined' : 'reconnecting…')),
          ),
          members.length < 2 ? h('div.invite-player.waiting', null, tankIcon(PLAYER_COLORS[1].body, PLAYER_COLORS[1].dark), h('span', null, 'Waiting for a friend…')) : null,
        ),
      )
    }
    kids.push(h('div.invite-status', { class: this.error ? 'err' : '' }, this.status))
    if (this.error) kids.push(h('div.invite-actions', null, button('Try again', { icon: 'restart', class: 'primary', autofocus: true, onclick: () => this.retry() })))
    else if (this.code)
      kids.push(
        h(
          'div.invite-start',
          null,
          keyed('start', button(room && room.members.length > 1 ? 'Start now' : 'Start without waiting', { icon: 'play', disabled: this.started || !room || !this.ready(room), onclick: () => this.startGame() })),
        ),
      )
    this.body.replaceChildren(...kids.filter((k): k is Node => !!k))
    const again = had ? this.body.querySelector<HTMLElement>(`[data-k="${had}"]`) : null
    if (again) again.focus({ preventScroll: true })
    else if (!this.root.contains(document.activeElement)) requestAnimationFrame(() => this.nav?.focus())
  }

  private async copyLink() {
    try {
      await navigator.clipboard.writeText(this.link())
      this.flash('Invite link copied')
    } catch {
      // no clipboard (plain http on a LAN address): select the link for a manual copy
      const el = this.root.querySelector('.invite-link')
      if (el) getSelection()?.selectAllChildren(el)
      this.flash('Copy the link above')
    }
  }

  private setStart(first: number) {
    if (this.started) return
    this.first = first
    this.sync()
  }

  private retry() {
    this.error = false
    this.status = 'Connecting…'
    this.code = ''
    this.creating = false
    this.settingsSent = ''
    this.render()
    void this.open()
  }

  unmount() {
    super.unmount()
    this.off?.()
    if (this.startTimer) clearTimeout(this.startTimer)
    // closed without starting: the room goes too
    if (!this.started && this.code && this.net.room?.code === this.code && this.net.room.state === 'lobby') this.net.send({ t: 'leave' })
  }

  protected back() {
    this.leaving = true
    this.app.show('menu', { page: 'campaign' })
  }
}

/** the Web Share API on a phone / tablet */
const canShare = () => typeof navigator.share === 'function' && touch()

/** tags a control so its focus survives a re-render */
function keyed<T extends HTMLElement>(k: string, el: T) {
  el.dataset.k = k
  return el
}

registerScreen('invite', () => new InviteScreen())
