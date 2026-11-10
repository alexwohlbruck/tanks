// 'arena': the massively-multiplayer mode's screen, in the web screens' toy-wood style.
// Before playing: name, Free-for-all or Teams, players online, the special tanks you can turn
// into. While playing: the HUD over the game view (timer band, scores, leaderboard, kill feed,
// minimap, ammo and the special tank you are, respawn countdown, names over tanks; pickups and
// team rings drawn in the scene), Tab for the scoreboard, Esc for the menu, wheel to zoom,
// V for first person.

import * as THREE from 'three/webgpu'
import { registerScreen } from '../app/router'
import type { AppContext, Screen } from '../app/types'
import { logo, tankIcon } from '../ui/web/art'
import { backButton, band, button, fullscreenButton, type WebApp } from '../ui/web/base'
import { h } from '../ui/web/dom'
import { Nav } from '../ui/web/nav'
import { keyName, settings } from '../ui/web/settings'
import type { Board } from './protocol'
import { ARENA_SIZES, EMOTES, FFA_COLORS, FLARE, ITEM_INFO, ITEM_KINDS, NUKE, PICKUP_INFO, PICKUP_KINDS, PICKUP_TICKS, PICKUP_TYPE, SHIELD, SIZES, STREAK_LEVELS, TEAM_COLORS, TEAM_NAMES, THEME_INFO, ELIM, MODE_NAMES, ROYALE, isItem, isTeamMode, pickupInfo, sizeOf, type AnyPickup, type ArenaMode, type ArenaSize, type ItemKind, type MapTheme } from './rules'
import { TANK } from '../sim/consts'
import type { Tank } from '../sim/world'
import { ArenaSession } from './session'
import './arena.css'

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
const ord = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`

/** a darker shade of a player colour (tank icon outlines) */
function shade(hex: string, k = 0.55) {
  const c = new THREE.Color(hex)
  return `#${c.multiplyScalar(k).getHexString()}`
}
const icoHtml = (body: string, dark = shade(body), cls = 'tank-icon') => tankIcon(body, dark, cls).outerHTML

const SHELL_SVG = '<svg viewBox="0 0 10 24" class="ar-shell"><path d="M5 1C8 4 9 8 9 11v11H1V11c0-3 1-7 4-10z" fill="#f6f3ea" stroke="#5b3a19" stroke-width="1.4"/><path d="M1 17h8" stroke="#c99556" stroke-width="2"/></svg>'
const NUKE_SVG = '<svg viewBox="0 0 24 24" class="ar-item ar-nuke"><circle cx="12" cy="12" r="10.5" fill="#f2c230" stroke="#5b3a19" stroke-width="1.6"/><path d="M12 12L7 3.5a10 10 0 0 1 10 0zM12 12l9.8 1.5a10 10 0 0 1-5 8.6zM12 12l-4.8 9.1a10 10 0 0 1-5-8.6z" fill="#2a1a0a"/><circle cx="12" cy="12" r="2" fill="#f2c230" stroke="#2a1a0a"/></svg>'
const SHIELD_SVG = '<svg viewBox="0 0 24 24" class="ar-item ar-shieldi"><path d="M12 1.8l8.5 3.2v6.2c0 5.3-3.6 9.4-8.5 11-4.9-1.6-8.5-5.7-8.5-11V5z" fill="#7fe0c2" stroke="#1f5e4b" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 4.6l5.6 2.1v4.6c0 3.6-2.3 6.5-5.6 7.8z" fill="#fff" opacity="0.45"/></svg>'
const FLARE_SVG = '<svg viewBox="0 0 24 24" class="ar-item ar-flare"><path d="M12 2l2.2 6.3L20.5 6l-3.6 5.4L22 14l-6 .9 1.2 6.6L12 17l-5.2 4.5L8 14.9 2 14l5.1-2.6L3.5 6l6.3 2.3z" fill="#ff8a2a" stroke="#5b3a19" stroke-width="1.4" stroke-linejoin="round"/><circle cx="12" cy="12.5" r="3" fill="#fff3c4"/></svg>'
const ITEM_SVG: Record<ItemKind, string> = { shield: SHIELD_SVG, flares: FLARE_SVG }
const MINE_SVG = '<svg viewBox="0 0 24 24" class="ar-mine"><circle cx="12" cy="13" r="9.5" fill="#e8c33a" stroke="#5b3a19" stroke-width="1.6"/><circle cx="12" cy="13" r="4" fill="#cf2a31" stroke="#5b3a19" stroke-width="1.2"/></svg>'

const SIZE_KEY = 'tanks-arena-size'
function savedSize(): ArenaSize {
  try {
    return sizeOf(localStorage.getItem(SIZE_KEY))
  } catch {
    return 'medium'
  }
}

class ArenaScreen implements Screen {
  readonly opaque = false
  private root!: HTMLElement
  private app!: WebApp
  private phase: 'join' | 'play' = 'join'
  private menuOpen = false
  private session: ArenaSession | null = null
  private mode: ArenaMode = 'ffa'
  private size: ArenaSize = savedSize()
  private nav: Nav | null = null
  private els: Record<string, HTMLElement> = {}
  private last: Record<string, string> = {}
  private minimap!: HTMLCanvasElement
  private mapBg: HTMLCanvasElement | null = null
  private mapVersion = -1
  private labels = new Map<number, HTMLElement>()
  private fx = new THREE.Group()
  private pickupObjs = new Map<number, THREE.Object3D>()
  private rings = new Map<number, THREE.Object3D>()
  private lasers = new Map<Tank, THREE.Mesh>()
  private bubbles = new Map<Tank, THREE.Object3D>()
  private missiles = new Map<number, { o: THREE.Object3D; trail: { x: number; z: number }[] }>()
  private nukeRings = new Map<number, THREE.Object3D>()
  /** where you just spawned: rings closing in on the tank, and a bouncing tag over it */
  private youRings: THREE.Object3D | null = null
  /** Battle royale: the zone's edge, a red wash over everything outside it, and where it's closing to */
  private zoneObj: THREE.Group | null = null
  private youTag: HTMLElement | null = null
  private burstObjs = new Map<object, THREE.Object3D>()
  private poll: ReturnType<typeof setInterval> | null = null
  private sheetHeld = false
  private onKey = (e: KeyboardEvent) => {
    if (this.phase === 'play' && e.code === 'Tab') {
      e.preventDefault()
      this.sheetHeld = e.type === 'keydown'
    }
    // quick chat: 1-6
    const n = /^Digit([1-6])$/.exec(e.code)
    if (n && e.type === 'keydown' && !e.repeat && this.phase === 'play' && !this.menuOpen && this.session) this.session.emote(Number(n[1]) - 1)
  }
  private invite: { arena: string; with?: number } | null = null
  private onWheel = (e: WheelEvent) => {
    if (this.phase !== 'play' || this.menuOpen || !this.session) return
    this.session.zoom = Math.max(0.5, Math.min(1.3, this.session.zoom * (e.deltaY > 0 ? 0.92 : 1.08)))
  }

  get modal() {
    return this.phase !== 'play' || this.menuOpen
  }

  mount(root: HTMLElement, app: AppContext, params?: Record<string, unknown>) {
    this.root = root
    this.app = app as WebApp
    if (typeof params?.arena === 'string') this.invite = { arena: params.arena, with: Number(params.with) || undefined }
    root.classList.add('web', 'arena-ui')
    addEventListener('keydown', this.onKey)
    addEventListener('keyup', this.onKey)
    addEventListener('wheel', this.onWheel, { passive: true })
    this.renderJoin()
  }

  unmount() {
    removeEventListener('keydown', this.onKey)
    removeEventListener('keyup', this.onKey)
    removeEventListener('wheel', this.onWheel)
    if (this.poll) clearInterval(this.poll)
    this.nav?.dispose()
    document.body.classList.remove('arena-playing', 'arena-menu')
    this.app.view.root.remove(this.fx)
  }

  /** focus navigation (keys / gamepad) for the panels; off while driving (WASD is the tank's) */
  private setNav(on: boolean, back?: () => void) {
    this.nav?.dispose()
    this.nav = on ? new Nav(this.root, { back, sound: (k) => this.sound(k) }) : null
    if (on) requestAnimationFrame(() => this.nav?.focus())
  }

  private sound(k: 'move' | 'ok' | 'back') {
    this.app.audio.play({ move: 'RP_COMMON_SE_KEY_CURSOR_01', ok: 'RP_COMMON_SE_KEY_A_04', back: 'RP_COMMON_SE_KEY_BACK_01' }[k])
  }

  // ---- join -------------------------------------------------------------------------------

  private renderJoin() {
    this.phase = 'join'
    this.root.classList.remove('playing')
    document.body.classList.remove('arena-playing')
    const name = h('input.ar-input', { maxlength: 16, value: ArenaSession.savedName(), placeholder: 'Player', autocomplete: 'nickname', 'aria-label': 'Your name' })
    name.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') this.play(name.value)
    })
    const modeCard = (m: ArenaMode, title: string, text: string, art: Node) => {
      const b = h('button.card.ar-mode', { type: 'button', class: this.mode === m ? 'on' : '' }, h('div.ar-mode-art', null, art), h('div.card-title', null, title), h('div.card-text', null, text))
      b.addEventListener('click', () => {
        this.mode = m
        this.root.querySelectorAll('.ar-mode').forEach((x) => x.classList.toggle('on', x === b))
        this.sound('move')
      })
      return b
    }
    const sizeButton = (z: ArenaSize) => {
      const S = SIZES[z]
      // the map's outline, to scale
      const art = h('i.ar-size-art', { style: `width:${(S.cols / 114) * 2.6}em;height:${(S.rows / 114) * 2.6}em` })
      const b = h(
        'button.ar-size',
        { type: 'button', class: this.size === z ? 'on' : '', 'data-size': z },
        h('span.ar-size-box', null, art),
        h('b', null, S.name),
        h('small', null, `${S.maxHumans} players`),
        h('small.ar-size-live'),
      )
      b.addEventListener('click', () => {
        this.size = z
        try {
          localStorage.setItem(SIZE_KEY, z)
        } catch {}
        this.root.querySelectorAll('.ar-size').forEach((x) => x.classList.toggle('on', x === b))
        this.sound('move')
      })
      return b
    }
    const ffaArt = h('div.ar-tanks')
    for (const c of FFA_COLORS.slice(0, 5)) ffaArt.append(tankIcon(c, shade(c)))
    const blue = () => tankIcon(TEAM_COLORS[0], shade(TEAM_COLORS[0]))
    const red = () => flip(tankIcon(TEAM_COLORS[1], shade(TEAM_COLORS[1])))
    const teamArt = h('div.ar-tanks.vs', null, blue(), blue(), h('b', null, 'vs'), red(), red())
    // the last tank in the circle; Blue and Red with tanks knocked out
    const royaleArt = h('div.ar-tanks.royale', null, h('i.ar-ring'), tankIcon(FFA_COLORS[3], shade(FFA_COLORS[3])))
    const down = (el: SVGSVGElement) => (el.classList.add('down'), el)
    const elimArt = h('div.ar-tanks.vs', null, blue(), down(blue()), h('b', null, 'vs'), down(red()), down(red()))
    const online = h('div.ar-online', null, h('i.dot'), h('span', null, 'Checking the server…'))
    const leaderCard = this.leaderCard()
    const powers = h(
      'div.ar-powers',
      null,
      ...PICKUP_KINDS.map((k) => h('div.ar-power-row', null, tankIcon(PICKUP_INFO[k].color, PICKUP_INFO[k].dark), h('b', null, PICKUP_INFO[k].name), h('span', null, PICKUP_INFO[k].trick))),
    )
    const items = h(
      'div.ar-powers',
      null,
      ...ITEM_KINDS.map((k) => {
        const row = h('div.ar-power-row', null, h('b', null, ITEM_INFO[k].name), h('span', null, ITEM_INFO[k].trick))
        row.insertAdjacentHTML('afterbegin', ITEM_SVG[k])
        return row
      }),
    )
    this.root.replaceChildren(
      h(
        'div.menu-screen.ar-join',
        null,
        h('div.menu-logo', null, logo()),
        h(
          'div.panel.ar-panel',
          null,
          h('div.panel-head', null, backButton(() => this.app.toMenu()), band('Arena')),
          h(
            'div.panel-scroll',
            null,
            h('p.ar-lede', null, 'One huge map and a lot of tanks. Jump in any time.'),
            h('label.ar-name', null, h('span', null, 'Your name'), name),
            // an invite picks the arena (and its mode) for you
            this.invite
              ? h('div.card.ar-invited', null, h('div.ar-mode-art', null, teamArt), h('div.card-title', null, 'You\u2019re invited!'), h('div.card-text', null, 'Play joins your friend\u2019s arena, on their team in a Teams match.'))
              : h(
                  'div.ar-modes',
                  null,
                  modeCard('ffa', 'Free-for-all', 'Every tank for itself. The top score wins.', ffaArt),
                  modeCard('teams', 'Teams', 'Blue against Red. Watch your fire: shells hit teammates too.', teamArt),
                  modeCard('royale', 'Battle royale', 'One life each, and the zone closes in. Be the last tank standing.', royaleArt),
                  modeCard('elim', 'Elimination', `Blue against Red, one life a round. First to ${ELIM.rounds} rounds wins.`, elimArt),
                ),
            this.invite ? null : h('div.ar-sizes', { role: 'group', 'aria-label': 'Map size' }, h('span.ar-sizes-head', null, 'Map size'), ...ARENA_SIZES.map(sizeButton)),
            button('Play', { icon: 'play', class: 'primary big ar-go', autofocus: true, onclick: () => this.play(name.value) }),
            online,
            leaderCard,
            h(
              'div.card.ar-rules',
              null,
              h('div.records-head', null, 'Special tanks'),
              h('div.card-text', null, 'Drive over a spinning tank to become it for a while.'),
              powers,
              h('div.card-text', null, 'Or grab an item:'),
              items,
              h('div.records-head', null, 'Rules'),
              h(
                'ul',
                null,
                h('li', null, 'One hit destroys a tank. In Free-for-all and Teams you’re back 3 seconds later, near the fighting but out of sight of enemies, and protected until you fire.'),
                h('li', null, `Free-for-all and Teams matches last 6 minutes, or until someone reaches the score limit (${ARENA_SIZES.map((z) => `${SIZES[z].name.toLowerCase()}: ${SIZES[z].ffaLimit}, teams ${SIZES[z].teamLimit}`).join('; ')}). Then a new map is built.`),
                h('li', null, `Battle royale: one life. A red zone closes in on a spot near the middle; ${ROYALE.outside / 60} seconds outside it destroys you. The last tank standing wins.`),
                h('li', null, `Elimination: Blue against Red with one life a round. Wipe out the other team to win the round (after ${ELIM.roundTicks / 3600} minutes, the team with more tanks left wins it). First to ${ELIM.rounds} rounds wins.`),
                h('li', null, 'In Battle royale and Elimination, if you join once a round is under way, you watch until the next one starts.'),
                h('li', null, 'Every shell hits every tank, teammates too. Destroying yourself or a teammate costs a point.'),
                h('li', null, `Kill streaks power you up: ×2 at ${STREAK_LEVELS[0]} kills in a row, ×3 at ${STREAK_LEVELS[1]}. More shells, mines and ricochets, and a stronger special tank, until you're hit.`),
                h('li', null, `One nuke a match: a huge mine on its own key (N) that clears every block around it. Lay it and run: it goes off ${NUKE.fuse / 60} seconds later. You keep it when you're hit; a new one comes with the next match.`),
                h('li', null, `A flare launches ${FLARE.swarm[0]}-${FLARE.swarm[1]} tiny homing missiles that shoot down shells and rockets in flight. You carry ${FLARE.base}; it comes back after ${FLARE.recharge / 60} seconds.`),
                h('li', null, 'The minimap shows teammates, and enemies right after they fire.'),
              ),
            ),
            h('div.foot-hint', null, 'WASD drive · mouse aim · click fire · Space mine · F flare · N nuke · wheel zoom · V first person · Tab scores'),
          ),
        ),
      ),
    )
    this.setNav(true, () => this.app.toMenu())
    const refresh = async () => {
      try {
        const r = await this.app.api('/arena').then((x) => x.json())
        const by = (m: string) => r.arenas.filter((a: { mode: string }) => a.mode === m).reduce((n: number, a: { humans: number }) => n + a.humans, 0)
        online.classList.add('up')
        const modes = (['ffa', 'teams', 'royale', 'elim'] as const).filter((m) => by(m)).map((m) => `${by(m)} ${MODE_NAMES[m].toLowerCase()}`)
        online.querySelector('span')!.textContent = r.online ? [`${r.online} playing now`, ...modes].join(' · ') : 'Nobody online yet: the bots are ready'
        // players in each size, for the chosen mode
        for (const el of this.root.querySelectorAll<HTMLElement>('.ar-size')) {
          const n = r.arenas.filter((a: { mode: string; size?: string }) => a.mode === this.mode && sizeOf(a.size) === el.dataset.size).reduce((n: number, a: { humans: number }) => n + a.humans, 0)
          el.querySelector('.ar-size-live')!.textContent = n ? `${n} here now` : ''
        }
      } catch {
        online.classList.remove('up')
        online.querySelector('span')!.textContent = 'The server can’t be reached'
      }
    }
    void refresh()
    if (this.poll) clearInterval(this.poll)
    this.poll = setInterval(refresh, 4000)
  }

  private play(raw: string) {
    const name = raw.trim() || 'Player'
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    this.sound('ok')
    this.app.audio.stopMusic()
    const s = new ArenaSession(this.app.view, this.app.audio, name, this.mode, this.invite, this.size)
    this.invite = null
    s.onPause = () => this.toggleMenu()
    this.session = s
    this.app.setSession(s)
    this.phase = 'play'
    this.buildHud()
  }

  // ---- HUD --------------------------------------------------------------------------------

  private buildHud() {
    this.setNav(false)
    document.body.classList.add('arena-playing')
    // the game under the HUD takes the mouse (aim, fire, mine); only panels catch it
    this.root.classList.add('playing')
    this.root.innerHTML = `
      <div class="ar-hud">
        <div class="ar-top"><div class="band ar-timer"><span></span></div><div class="ar-score"></div></div>
        <div class="ar-board"></div>
        <div class="ar-feed"></div>
        <div class="ar-banner band"><span></span></div>
        <div class="ar-respawn band dark"><span></span></div>
        <div class="ar-dock"><div class="ar-ammo"></div><div class="ar-power"></div></div>
        <div class="ar-mapframe"><canvas class="ar-minimap"></canvas></div>
        <div class="ar-labels"></div>
        <div class="ar-net"></div>
        <div class="ar-chat"><button class="ar-chat-btn" type="button" aria-label="Quick chat">💬</button><div class="ar-chat-list" hidden></div></div>
        <div class="ar-sheet results-screen" hidden></div>
        <div class="ar-menu pause-screen" hidden></div>
        <div class="ar-connecting pause-screen"><div class="panel pause">${band('Connecting…', 'dark').outerHTML}</div></div>
      </div>`
    for (const k of ['timer', 'score', 'board', 'feed', 'banner', 'respawn', 'ammo', 'power', 'labels', 'net', 'sheet', 'menu', 'connecting']) this.els[k] = this.root.querySelector(`.ar-${k}`)!
    this.minimap = this.root.querySelector('.ar-minimap')!
    this.last = {}
    this.app.view.root.add(this.fx)
    // quick chat button (touch; keys 1-6 do the same)
    const chat = this.root.querySelector<HTMLElement>('.ar-chat-list')!
    chat.innerHTML = EMOTES.map((t, i) => `<button type="button" data-emote="${i}"><kbd>${i + 1}</kbd>${esc(t)}</button>`).join('')
    this.root.querySelector('.ar-chat-btn')!.addEventListener('click', () => (chat.hidden = !chat.hidden))
    chat.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-emote]')
      if (!b) return
      this.session?.emote(Number(b.dataset.emote))
      chat.hidden = true
    })
    // votes for the next map (results sheet)
    this.els.sheet.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-theme]')
      if (!b || !this.session) return
      this.session.vote(b.dataset.theme as MapTheme)
      this.sound('ok')
    })
  }

  /** the join screen's leaderboard: today / all time, and this browser's own numbers */
  private leaderCard() {
    const list = h('div.ar-leaders', null, h('div.card-text', null, 'Loading…'))
    const mine = h('div.ar-mine-stats')
    let range: 'today' | 'all' = 'today'
    let data: { today: { name: string; kills: number; wins: number; me?: boolean }[]; all: { name: string; kills: number; wins: number; me?: boolean }[] } | null = null
    const draw = () => {
      const rows = data?.[range] ?? []
      list.replaceChildren(
        ...(rows.length
          ? rows.map((r, i) => h('div.ar-leader', { class: r.me ? 'me' : '' }, h('i', null, String(i + 1)), h('span', null, r.name), h('b', null, String(r.kills)), h('small', null, `${r.wins} won`)))
          : [h('div.card-text', null, range === 'today' ? 'Nobody has scored today yet. Be the first!' : 'No scores yet.')]),
      )
      seg.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.r === range))
    }
    const seg = h(
      'div.seg',
      null,
      ...(['today', 'all'] as const).map((r) =>
        h('button.seg-btn', { type: 'button', 'data-r': r, onclick: () => ((range = r), draw()) }, r === 'today' ? 'Today' : 'All time'),
      ),
    )
    const id = ArenaSession.statId()
    void this.app
      .api(`/arena/leaders?id=${id ?? ''}`)
      .then((r) => r.json())
      .then((d) => ((data = d), draw()))
      .catch(() => list.replaceChildren(h('div.card-text', null, 'Leaderboard unavailable')))
    void this.app
      .api(`/arena/me?id=${id ?? ''}`)
      .then((r) => r.json())
      .then((d) => {
        const st = d.stats
        if (st) mine.replaceChildren(h('b', null, 'You'), ` ${st.kills} kills · ${st.wins} wins · best streak ${st.best} · ${st.matches} matches`)
      })
      .catch(() => {})
    draw()
    return h('div.card.ar-board-card', null, h('div.ar-board-head', null, h('div.records-head', null, 'Leaderboard'), seg), list, mine)
  }

  /** shares (phones) or copies an invite link to this arena */
  private async shareInvite() {
    const link = this.session?.inviteLink
    if (!link) return
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: 'Tanks! Arena', text: 'Join me in the Tanks! arena', url: link })
      else {
        await navigator.clipboard.writeText(link)
        this.session!.banner = { text: 'Invite link copied', until: performance.now() + 1600 }
      }
    } catch {
      prompt('Send this link to a friend:', link)
    }
  }

  private toggleMenu(on = !this.menuOpen) {
    this.menuOpen = on
    if (this.session) this.session.inputBlocked = on
    const m = this.els.menu
    m.hidden = !on
    document.body.classList.toggle('arena-menu', on)
    if (on) {
      if (document.pointerLockElement) document.exitPointerLock()
      m.replaceChildren(
        h(
          'div.panel.pause',
          null,
          band('Arena'),
          h(
            'div.pause-actions',
            null,
            button('Resume', { icon: 'play', class: 'primary', autofocus: true, onclick: () => this.toggleMenu(false) }),
            button(this.app.fpvOn ? 'Top-down view' : 'First-person view', {
              icon: 'arena',
              hint: 'V',
              onclick: () => {
                this.toggleMenu(false)
                this.app.toggleFpv()
              },
            }),
            button('Invite friends', { icon: 'online', hint: 'Copy a link to this arena', onclick: () => void this.shareInvite() }),
            fullscreenButton(),
            button('Leave arena', { icon: 'home', onclick: () => this.leave() }),
          ),
        ),
      )
      this.setNav(true, () => this.toggleMenu(false))
    } else this.setNav(false)
    this.app.audio.play(on ? 'RP_COM_GAME_SE_PAUSE_01_TVSP' : 'RP_COMMON_SE_KEY_BACK_01')
  }

  private leave() {
    if (this.app.fpvOn) this.app.toggleFpv(false)
    this.session = null
    this.app.toMenu()
  }

  /** sets innerHTML only when it changed (the HUD updates every frame) */
  private set(k: string, html: string) {
    if (this.last[k] === html) return
    this.last[k] = html
    this.els[k].innerHTML = html
  }

  update() {
    this.nav?.update()
    const s = this.session
    if (this.phase !== 'play' || !s) return
    if (s.error || s.status === 'closed') {
      if (this.last.err !== s.error) {
        this.last.err = s.error
        const c = this.els.connecting
        c.hidden = false
        c.replaceChildren(
          h(
            'div.panel.pause',
            null,
            band('Disconnected', 'dark'),
            h('p.ar-msg', null, s.error || 'The connection to the server was lost.'),
            h('div.pause-actions', null, button('Back to the menu', { icon: 'home', class: 'primary', autofocus: true, onclick: () => this.leave() })),
          ),
        )
        this.setNav(true, () => this.leave())
      }
      return
    }
    this.els.connecting.hidden = !!s.world && !!s.you
    const b = s.board
    const you = s.you
    if (b) {
      this.set('timer', `<span>${b.state === 'over' ? 'Match over' : b.roundOver ? `Next round ${b.secs}` : fmt(b.secs)}</span>`)
      this.els.timer.classList.toggle('hurry', b.state === 'play' && !b.roundOver && b.secs <= 30)
      this.set('score', this.scoreHtml(b, s))
      this.set('board', this.boardHtml(b, s))
      const sheet = b.state === 'over' || this.sheetHeld
      this.els.sheet.hidden = !sheet
      if (sheet) {
        this.set('sheet', this.sheetHtml(b, s))
        // the countdown ticks without rebuilding the sheet (its vote buttons stay put)
        const secs = this.els.sheet.querySelector('.ar-secs')
        if (secs) secs.textContent = String(b.secs)
      }
    }
    // kill feed
    const now = performance.now()
    s.feed = s.feed.filter((f) => now - f.at < 7000)
    this.set('feed', s.feed.map((f) => `<div class="ar-kill">${f.html}</div>`).join(''))
    // banner
    this.els.banner.classList.toggle('on', !!s.banner)
    if (s.banner) this.set('banner', `<span>${esc(s.banner.text)}</span>`)
    // own tank
    if (you) {
      // waiting to respawn (or, in the one-life modes, for the next round), or outside the zone
      const outside = !!you.alive && you.zo > 0
      this.els.respawn.classList.toggle('on', (!you.alive || outside) && b?.state !== 'over')
      this.els.respawn.classList.toggle('zone', outside)
      if (outside) this.set('respawn', `<span>Get back in the zone! ${Math.max(1, Math.ceil((ROYALE.outside - you.zo) / 60))}</span>`)
      else if (!you.alive) {
        const w = s.spectating !== null ? s.nameOf(s.spectating) : undefined
        const watching = w ? ` · watching ${esc(w.name)}` : ''
        const wait = !you.out ? `Back in ${Math.max(1, Math.ceil(you.respawn / 60))}` : s.mode === 'elim' ? (b?.roundOver ? `Next round in ${b.secs}` : 'Out until the next round') : 'Out until the next match'
        this.set('respawn', `<span>${wait}${watching}</span>`)
      }
      // the arsenal: one slot per weapon, with its key
      const pips = (n: number, max: number, svg: string) => Array.from({ length: max }, (_, i) => `<i class="${i < n ? 'on' : ''}">${svg}</i>`).join('')
      const key = (a: 'mine' | 'flare' | 'nuke') => esc(settings.keys[a]?.[0] ? keyName(settings.keys[a][0]) : '')
      this.set(
        'ammo',
        `<div class="ar-slot"><div class="pips">${pips(you.shells, you.maxShells, SHELL_SVG)}</div><kbd>Click</kbd></div>` +
          `<div class="ar-slot"><div class="pips">${pips(you.mines, you.maxMines, MINE_SVG)}</div><kbd>${key('mine')}</kbd></div>` +
          `<div class="ar-slot"><div class="pips">${pips(you.flares, you.flareMax, FLARE_SVG)}</div><kbd>${key('flare')}</kbd>${you.flareBack ? `<span class="back">${Math.ceil(you.flareBack / 60)}</span>` : ''}</div>` +
          `<div class="ar-slot nuke ${you.nukes ? '' : 'used'}" title="${you.nukes ? 'Your nuke for this match' : 'Nuke used: you get a new one next match'}"><div class="pips">${NUKE_SVG}</div><kbd>${key('nuke')}</kbd></div>`,
      )
      const chips: string[] = []
      if (you.power) {
        const info = PICKUP_INFO[you.power]
        chips.push(`<div class="ar-chip pw-power" style="--c:${info.color};--d:${info.dark}" title="${info.trick}">${icoHtml(info.color, info.dark)}<div><b>${info.name}</b><u><i></i></u></div></div>`)
      }
      if (you.shield > 0 && you.alive) chips.push(`<div class="ar-chip pw-shield" style="--c:${ITEM_INFO.shield.color};--d:${ITEM_INFO.shield.dark}">${SHIELD_SVG}<div><b>Shield</b><u><i></i></u></div></div>`)
      if (you.level > 0 && you.alive) chips.push(`<div class="ar-chip pw-streak" style="--c:#e8901c;--d:#8a4a08"><span class="ar-mult">×${you.level + 1}</span><div><b>${you.streak} streak</b><small>${you.level < STREAK_LEVELS.length ? `×${you.level + 2} at ${STREAK_LEVELS[you.level]}` : 'full power'}</small></div></div>`)
      if (!chips.length && you.protect && you.alive) chips.push(`<div class="ar-chip dim"><div><b>Protected</b><small>until you fire</small></div></div>`)
      this.set('power', chips.join(''))
      // the time bars move every frame: set their widths without rebuilding the chips
      const bar = (sel: string, f: number) => {
        const el = this.els.power.querySelector<HTMLElement>(`${sel} u i`)
        if (el) el.style.width = `${(Math.max(0, Math.min(1, f)) * 100).toFixed(1)}%`
      }
      if (you.power) bar('.pw-power', you.powerLeft / PICKUP_TICKS[you.power])
      if (you.shield > 0) bar('.pw-shield', you.shield / SHIELD.ticks)
    }
    this.els.net.textContent = `${Math.round(s.rtt)} ms`
    this.drawMinimap(s)
    this.drawLabels(s)
    this.syncFx(s)
  }

  private colorOf(s: ArenaSession, team: number, color: string) {
    return isTeamMode(s.mode) ? TEAM_COLORS[team] : color
  }

  private scoreHtml(b: Board, s: ArenaSession) {
    if (s.mode === 'elim') {
      // rounds won, and the tanks each team has left
      const left = b.alive ?? [0, 0]
      const lead = b.teams[0] === b.teams[1] ? -1 : b.teams[0] > b.teams[1] ? 0 : 1
      return `<div class="ar-plaque teams"><span class="t ${lead === 0 ? 'lead' : ''}">${icoHtml(TEAM_COLORS[0])}<b>${b.teams[0]}</b><em>${left[0]} left</em></span><small>round ${b.round ?? 1} · first to ${ELIM.rounds}</small><span class="t ${lead === 1 ? 'lead' : ''}"><em>${left[1]} left</em><b>${b.teams[1]}</b>${icoHtml(TEAM_COLORS[1], undefined, 'tank-icon flip')}</span></div>`
    }
    if (s.mode === 'royale') {
      const me = b.players.find((p) => p[0] === s.pid)
      return `<div class="ar-plaque">${me ? icoHtml(me[3]) : ''}<b>${b.alive?.[0] ?? 0}</b><small>left of ${b.players.length}</small>${me ? `<span class="rank">${me[4]} kill${me[4] === 1 ? '' : 's'}</span>` : ''}</div>`
    }
    if (s.mode === 'teams') {
      const lead = b.teams[0] === b.teams[1] ? -1 : b.teams[0] > b.teams[1] ? 0 : 1
      return `<div class="ar-plaque teams"><span class="t ${lead === 0 ? 'lead' : ''}">${icoHtml(TEAM_COLORS[0])}<b>${b.teams[0]}</b></span><small>first to ${SIZES[s.size].teamLimit}</small><span class="t ${lead === 1 ? 'lead' : ''}"><b>${b.teams[1]}</b>${icoHtml(TEAM_COLORS[1], undefined, 'tank-icon flip')}</span></div>`
    }
    const me = b.players.find((p) => p[0] === s.pid)
    if (!me) return ''
    const sorted = [...b.players].sort((x, y) => y[6] - x[6] || x[5] - y[5])
    const rank = sorted.findIndex((p) => p[0] === s.pid) + 1
    return `<div class="ar-plaque">${icoHtml(me[3])}<b>${me[6]}</b><small>/ ${SIZES[s.size].ffaLimit}</small><span class="rank">${ord(rank)} of ${b.players.length}</span></div>`
  }

  private boardHtml(b: Board, s: ArenaSession) {
    const sorted = [...b.players].sort((x, y) => y[6] - x[6] || x[5] - y[5])
    const rows = sorted.slice(0, 5)
    const mine = sorted.find((p) => p[0] === s.pid)
    if (mine && !rows.includes(mine)) rows.push(mine)
    return `<div class="records-head">Leaders</div>${rows
      .map((p) => `<div class="ar-row ${p[0] === s.pid ? 'me' : ''}"><i>${sorted.indexOf(p) + 1}</i>${icoHtml(this.colorOf(s, p[2], p[3]))}<span>${esc(p[1])}</span><b>${p[6]}</b></div>`)
      .join('')}`
  }

  private sheetHtml(b: Board, s: ArenaSession) {
    const sorted = [...b.players].sort((x, y) => y[6] - x[6] || x[5] - y[5])
    const table = (list: typeof sorted, title?: string, color?: string) =>
      `<div class="kills ar-table">${title ? `<div class="ar-table-title" style="color:${color}">${title}</div>` : ''}<div class="kills-head"><span></span><span>Tank</span><span class="pcol">Kills</span><span class="pcol">Lost</span><span class="pcol">Score</span></div><div class="kills-rows">${list
        .map(
          (p, i) =>
            `<div class="kill-row ${p[0] === s.pid ? 'me' : ''}" style="--i:${i}"><span class="rk">${sorted.indexOf(p) + 1}</span><span class="kname">${icoHtml(this.colorOf(s, p[2], p[3]))}<span>${esc(p[1])}</span>${p[7] ? '<small>bot</small>' : ''}</span><span class="pcol">${p[4]}</span><span class="pcol">${p[5]}</span><b class="pcol">${p[6]}</b></div>`,
        )
        .join('')}</div></div>`
    const over = b.state === 'over'
    const w = b.winner
    const head = band(over ? (w ? `${w.name} wins!` : 'A draw!') : 'Scores').outerHTML
    const body =
      isTeamMode(s.mode)
        ? `<div class="ar-teams">${table(sorted.filter((p) => p[2] === 0), `${TEAM_NAMES[0]} · ${b.teams[0]}`, TEAM_COLORS[0])}${table(sorted.filter((p) => p[2] === 1), `${TEAM_NAMES[1]} · ${b.teams[1]}`, TEAM_COLORS[1])}</div>`
        : table(sorted)
    const vote = over && b.vote
      ? `<div class="ar-vote"><div class="records-head">Vote for the next map</div><div class="ar-vote-row">${b.vote.options
          .map((o, i) => `<button type="button" class="btn ar-vote-btn ${b.vote!.mine === o ? 'on' : ''}" data-theme="${o}"><span class="label"><span class="t">${THEME_INFO[o].name}${o === b.theme ? ' <small>again</small>' : ''}</span><span class="hint">${THEME_INFO[o].text}</span></span><b>${b.vote!.counts[i]}</b></button>`)
          .join('')}</div></div>`
      : ''
    return `<div class="panel results ar-results">${head}<div class="ar-sheet-body">${body}</div>${vote}<div class="results-sub">${over ? 'A new map in <span class="ar-secs"></span>…' : 'Release Tab to play on'}</div></div>`
  }

  // ---- minimap ----------------------------------------------------------------------------

  private drawMinimap(s: ArenaSession) {
    const map = s.map
    if (!map) return
    const scale = 3
    const W = map.cols * scale
    const H = map.rows * scale
    if (this.mapVersion !== s.mapVersion || !this.mapBg) {
      this.mapVersion = s.mapVersion
      const c = (this.mapBg ??= document.createElement('canvas'))
      c.width = W
      c.height = H
      const g = c.getContext('2d')!
      g.fillStyle = '#f0dcae'
      g.fillRect(0, 0, W, H)
      for (let r = 0; r < map.rows; r++)
        for (let q = 0; q < map.cols; q++) {
          const k = map.cells[r][q]
          if (!k) continue
          g.fillStyle = k === 200 ? '#6d5a44' : k < 200 ? '#d2905a' : '#9a6a3c'
          g.fillRect(q * scale, r * scale, scale, scale)
        }
      this.minimap.width = W
      this.minimap.height = H
    }
    const g = this.minimap.getContext('2d')!
    g.drawImage(this.mapBg!, 0, 0)
    const toMap = (x: number, z: number) => [(x / 35 + (map.cols - 1) / 2 + 0.5) * scale, (z / 35 + (map.rows - 1) / 2 + 0.5) * scale]
    const f = this.app.view.follow
    if (f && !this.app.view.fpv) {
      const cam = this.app.view.camera
      const hw = (cam.right - cam.left) / 2 / cam.zoom
      const hh = (cam.top - cam.bottom) / 2 / cam.zoom / Math.sin((42 * Math.PI) / 180)
      const [x0, y0] = toMap(f.x - hw, f.z - hh * 0.9)
      const [x1, y1] = toMap(f.x + hw, f.z + hh * 0.9)
      g.fillStyle = 'rgba(255,255,255,0.22)'
      g.fillRect(x0, y0, x1 - x0, y1 - y0)
      g.strokeStyle = 'rgba(91,58,25,0.55)'
      g.lineWidth = 1.5
      g.strokeRect(x0, y0, x1 - x0, y1 - y0)
    }
    for (const k of s.pickupList) {
      const [x, y] = toMap(k.x, k.z)
      g.fillStyle = pickupInfo(k.kind).color
      g.strokeStyle = pickupInfo(k.kind).dark
      g.lineWidth = 1.5
      g.beginPath()
      g.moveTo(x, y - 4.5)
      g.lineTo(x + 4.5, y)
      g.lineTo(x, y + 4.5)
      g.lineTo(x - 4.5, y)
      g.closePath()
      g.fill()
      g.stroke()
    }
    // Battle royale: shade what's outside the zone; a white line where it's closing to
    const zn = s.zoneNow()
    if (zn) {
      const [cx, cy] = toMap(zn.x, zn.z)
      const k = scale / 35
      g.save()
      g.fillStyle = 'rgba(200, 30, 40, 0.28)'
      g.beginPath()
      g.rect(0, 0, W, H)
      g.arc(cx, cy, zn.r * k, 0, Math.PI * 2, true)
      g.fill('evenodd')
      g.strokeStyle = '#d8202a'
      g.lineWidth = 2
      g.beginPath()
      g.arc(cx, cy, zn.r * k, 0, Math.PI * 2)
      g.stroke()
      if (zn.next < zn.r - 1) {
        g.strokeStyle = 'rgba(255,255,255,0.9)'
        g.lineWidth = 1.5
        g.setLineDash([4, 3])
        g.beginPath()
        g.arc(cx, cy, zn.next * k, 0, Math.PI * 2)
        g.stroke()
      }
      g.restore()
    }
    for (const [pid, x, z] of s.board?.mm ?? []) {
      if (pid === s.pid) continue
      const p = s.nameOf(pid)
      const [mx, my] = toMap(x, z)
      g.fillStyle = p ? this.colorOf(s, p.team, p.color) : '#fff'
      g.strokeStyle = '#3b2512'
      g.lineWidth = 1.2
      g.beginPath()
      g.arc(mx, my, 3.8, 0, Math.PI * 2)
      g.fill()
      g.stroke()
    }
    const me = s.world?.playerTanks[0]
    if (me?.active) {
      const [mx, my] = toMap(me.pos.x, me.pos.z)
      g.save()
      g.translate(mx, my)
      g.rotate(me.body)
      g.fillStyle = '#fff'
      g.strokeStyle = '#cf2a31'
      g.lineWidth = 2
      g.beginPath()
      g.moveTo(7.5, 0)
      g.lineTo(-5, 5.5)
      g.lineTo(-2.5, 0)
      g.lineTo(-5, -5.5)
      g.closePath()
      g.fill()
      g.stroke()
      g.restore()
    }
  }

  // ---- in-world extras: names, pickups, team rings ------------------------------------------

  private drawLabels(s: ArenaSession) {
    const w = s.world
    const view = this.app.view
    const seen = new Set<number>()
    if (w && !view.fpv) {
      const rect = this.root.getBoundingClientRect()
      const v = new THREE.Vector3()
      for (const t of w.tanks) {
        const pid = t.ai?.pid as number | undefined
        // hidden Whites keep their names to themselves
        const own = t === w.playerTanks[0]
        const id = own ? s.pid : pid
        const emote = id !== undefined ? s.emotes.get(id) : undefined
        if (emote && performance.now() > emote[1]) s.emotes.delete(id!)
        const saying = emote && performance.now() <= emote[1] ? EMOTES[emote[0]] : ''
        // the own tank only gets a tag while it says something
        if (own ? !saying : pid === undefined || pid === s.pid) continue
        if (!t.alive || s.hidden(t)) continue
        const p = s.nameOf(id!)
        if (!p) continue
        const pid2 = id!
        seen.add(pid2)
        let el = this.labels.get(pid2)
        if (!el) {
          el = document.createElement('div')
          el.className = 'ar-tag'
          this.els.labels.appendChild(el)
          this.labels.set(pid2, el)
        }
        const color = this.colorOf(s, p.team, p.color)
        const power = s.powerOf(t)
        const lv = s.levelOf(t)
        const key = p.name + color + (power ?? '') + saying + lv
        if (el.dataset.k !== key) {
          el.dataset.k = key
          el.innerHTML = `${saying ? `<q>${esc(saying)}</q>` : ''}<i style="background:${color}"></i>${esc(p.name)}${power ? `<em style="background:${PICKUP_INFO[power].color};color:${power === 'white' || power === 'yellow' ? '#3b2512' : '#fff'}">${PICKUP_INFO[power].name}</em>` : ''}${lv ? `<b class="lv">×${lv + 1}</b>` : ''}`
        }
        v.set(t.pos.x, 52, t.pos.z).project(view.camera)
        el.style.transform = `translate(${((v.x + 1) / 2) * rect.width}px, ${((1 - v.y) / 2) * rect.height}px) translate(-50%, -100%)`
      }
    }
    for (const [pid, el] of this.labels)
      if (!seen.has(pid)) {
        el.remove()
        this.labels.delete(pid)
      }
    this.drawYou(s)
  }

  /** a "You" tag bouncing over the own tank for a few seconds after it spawns */
  private drawYou(s: ArenaSession) {
    const me = s.world?.playerTanks[0]
    const age = performance.now() - s.spawnedAt
    const p = s.nameOf(s.pid)
    if (!me || !me.alive || !p || this.app.view.fpv || age > SPAWN_MARK_MS) {
      if (this.youTag) this.youTag.hidden = true
      return
    }
    if (!this.youTag) {
      this.youTag = h('div.ar-you', null, h('span', null, 'You'))
      this.els.labels.appendChild(this.youTag)
    }
    const el = this.youTag
    el.hidden = false
    el.style.setProperty('--c', this.colorOf(s, p.team, p.color))
    el.style.opacity = String(Math.min(1, (SPAWN_MARK_MS - age) / 500))
    const rect = this.root.getBoundingClientRect()
    const v = new THREE.Vector3(me.pos.x, 52, me.pos.z).project(this.app.view.camera)
    el.style.transform = `translate(${((v.x + 1) / 2) * rect.width}px, ${((1 - v.y) / 2) * rect.height}px) translate(-50%, -100%)`
  }

  /** the model floating over a pickup: the special tank, or the item */
  private itemModel(k: AnyPickup): THREE.Object3D {
    if (!isItem(k)) return this.app.view.tankModelOf(PICKUP_TYPE[k]).root
    const g = new THREE.Group()
    if (k === 'shield') {
      const b = new THREE.Mesh(new THREE.SphereGeometry(19, 24, 16), bubbleMat())
      b.position.y = 16
      const core = new THREE.Mesh(new THREE.OctahedronGeometry(8), new THREE.MeshBasicNodeMaterial({ color: 0x2fb38c }))
      core.position.y = 16
      g.add(b, core)
    } else {
      // three flare sticks with glowing tips
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2
        const stick = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 22, 10), new THREE.MeshBasicNodeMaterial({ color: i === 1 ? 0xd8383a : 0xff7a2a }))
        stick.position.set(Math.cos(a) * 5, 13, Math.sin(a) * 5)
        stick.rotation.set(Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35)
        const tip = new THREE.Mesh(new THREE.SphereGeometry(4, 10, 8), new THREE.MeshBasicNodeMaterial({ color: 0xfff1b0 }))
        tip.position.set(Math.cos(a) * 9, 24, Math.sin(a) * 9)
        g.add(stick, tip)
      }
    }
    // the pickup code scales its model like a tank's
    g.scale.setScalar(1 / 0.62)
    return g
  }

  private syncFx(s: ArenaSession) {
    const t = performance.now() / 1000
    // pickups: a little model of the special tank, spinning over a glowing ring
    const seen = new Set<number>()
    for (const k of s.pickupList) {
      seen.add(k.id)
      let o = this.pickupObjs.get(k.id)
      if (!o) {
        o = pickupObject(k.kind, this.itemModel(k.kind))
        o.position.set(k.x, 0, k.z)
        this.fx.add(o)
        this.pickupObjs.set(k.id, o)
      }
      const tank = o.children[0]
      tank.rotation.y = t * 1.8
      tank.position.y = 6 + Math.sin(t * 3 + k.id) * 3
      o.children[1].scale.setScalar(1 + 0.08 * Math.sin(t * 4 + k.id))
    }
    for (const [id, o] of this.pickupObjs)
      if (!seen.has(id)) {
        this.fx.remove(o)
        this.pickupObjs.delete(id)
      }
    // Sniper: a red laser sight along the turret to the first block, seen by everyone
    const lasers = new Set<Tank>()
    for (const tk of s.world?.tanks ?? []) {
      if (!tk.alive || tk.invisible || s.powerOf(tk) !== 'sniper' || !s.field) continue
      lasers.add(tk)
      let o = this.lasers.get(tk)
      if (!o) {
        o = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicNodeMaterial({ color: 0xff2a2a, transparent: true, opacity: 0.75, depthWrite: false }))
        this.fx.add(o)
        this.lasers.set(tk, o)
      }
      const dx = tk.turretRot.z.x, dz = tk.turretRot.z.z
      const x0 = tk.pos.x + dx * TANK.muzzle, z0 = tk.pos.z + dz * TANK.muzzle
      let len = 0
      while (len < 1600 && !s.field.pointInBlock(x0 + dx * len, z0 + dz * len) && s.field.isInside({ x: x0 + dx * len, y: 0, z: z0 + dz * len })) len += 6
      o.scale.set(len, 1.1, 1.1)
      o.position.set(x0 + (dx * len) / 2, TANK.bodyHeight, z0 + (dz * len) / 2)
      o.rotation.y = -Math.atan2(dz, dx)
      ;(o.material as THREE.MeshBasicNodeMaterial).opacity = 0.55 + 0.25 * Math.sin(t * 12)
    }
    for (const [k, o] of this.lasers)
      if (!lasers.has(k)) {
        this.fx.remove(o)
        this.lasers.delete(k)
      }
    // shields: a bubble around the tank
    const bubbled = new Set<Tank>()
    for (const tk of s.world?.tanks ?? []) {
      if (!tk.alive || s.hidden(tk) || !s.shieldOf(tk)) continue
      bubbled.add(tk)
      let o = this.bubbles.get(tk)
      if (!o) {
        o = new THREE.Mesh(new THREE.SphereGeometry(30, 28, 18), bubbleMat())
        this.fx.add(o)
        this.bubbles.set(tk, o)
      }
      o.position.set(tk.pos.x, 14, tk.pos.z)
      o.scale.setScalar(1 + 0.03 * Math.sin(t * 6))
    }
    for (const [k, o] of this.bubbles) if (!bubbled.has(k)) (this.fx.remove(o), this.bubbles.delete(k))
    // flare missiles: a tiny glowing dart with a short fading trail
    const flying = new Set<number>()
    for (const f of s.flareShots) {
      flying.add(f.id)
      let m = this.missiles.get(f.id)
      if (!m) {
        m = { o: missileObject(), trail: [] }
        this.fx.add(m.o)
        this.missiles.set(f.id, m)
      }
      m.trail.unshift({ x: f.x, z: f.z })
      if (m.trail.length > 10) m.trail.pop()
      const [dart, ...puffs] = m.o.children
      dart.position.set(f.x, TANK.bodyHeight, f.z)
      dart.rotation.y = Math.atan2(f.vx, f.vz)
      puffs.forEach((p, i) => {
        const q = m!.trail[Math.min(m!.trail.length - 1, (i + 1) * 2)]
        p.position.set(q.x, TANK.bodyHeight, q.z)
        p.scale.setScalar(1 - i * 0.22)
      })
    }
    for (const [k, m] of this.missiles) if (!flying.has(k)) (this.fx.remove(m.o), this.missiles.delete(k))
    // a nuke on the ground: its blast radius, blinking red
    const nk = new Set<number>()
    for (const n of s.nukes) {
      nk.add(n.id)
      let o = this.nukeRings.get(n.id)
      if (!o) {
        o = ringObject('#ff2a1a', n.r - 5, n.r, 0.7)
        const fill = new THREE.Mesh(new THREE.CircleGeometry(n.r, 64), new THREE.MeshBasicNodeMaterial({ color: 0xff3a1a, transparent: true, opacity: 0.08, depthWrite: false }))
        fill.rotation.x = -Math.PI / 2
        fill.position.y = 0.6
        o.add(fill)
        // the time left: a ring closing in from the edge to the nuke
        const clock = new THREE.Mesh(new THREE.RingGeometry(0.965, 1, 64), new THREE.MeshBasicNodeMaterial({ color: 0xffd23a, transparent: true, opacity: 0.85, depthWrite: false }))
        clock.rotation.x = -Math.PI / 2
        clock.position.y = 0.8
        o.add(clock)
        o.userData.clock = clock
        this.fx.add(o)
        this.nukeRings.set(n.id, o)
      }
      o.position.set(n.x, 0, n.z)
      const clock = o.userData.clock as THREE.Mesh
      clock.scale.setScalar(Math.max(1, n.r * n.left))
      // blinks faster as the fuse burns down
      o.visible = Math.sin(performance.now() / 1000 * (4 + (1 - n.left) * 26)) > -0.3
    }
    for (const [k, o] of this.nukeRings) if (!nk.has(k)) (this.fx.remove(o), this.nukeRings.delete(k))
    // bursts: a nuke's shockwave and flash, a flare's ring
    const now = performance.now()
    s.bursts = s.bursts.filter((b) => now - b.at < 900)
    const live = new Set<object>(s.bursts)
    for (const b of s.bursts) {
      let o = this.burstObjs.get(b)
      if (!o) {
        o = new THREE.Group()
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 64), new THREE.MeshBasicNodeMaterial({ color: b.kind === 'nuke' ? 0xfff0c0 : 0xffb04a, transparent: true, opacity: 0.9, depthWrite: false }))
        ring.rotation.x = -Math.PI / 2
        const flash = new THREE.Mesh(new THREE.CircleGeometry(1, 64), new THREE.MeshBasicNodeMaterial({ color: b.kind === 'nuke' ? 0xffe28a : 0xffd080, transparent: true, opacity: 0.5, depthWrite: false }))
        flash.rotation.x = -Math.PI / 2
        flash.position.y = -0.2
        o.add(ring, flash)
        o.position.set(b.x, 2, b.z)
        this.fx.add(o)
        this.burstObjs.set(b, o)
      }
      const f = (now - b.at) / (b.kind === 'nuke' ? 900 : 450)
      const [ring, flash] = o.children as THREE.Mesh[]
      ring.scale.setScalar(Math.max(1, b.r * (b.kind === 'nuke' ? 1.35 : 1) * Math.min(1, 0.25 + f * 1.1)))
      ;(ring.material as THREE.MeshBasicNodeMaterial).opacity = 0.9 * Math.max(0, 1 - f)
      flash.scale.setScalar(Math.max(1, b.r * Math.min(1, 0.4 + f * 1.5)))
      ;(flash.material as THREE.MeshBasicNodeMaterial).opacity = 0.5 * Math.max(0, 1 - f * 1.6)
    }
    for (const [k, o] of this.burstObjs) if (!live.has(k)) (this.fx.remove(o), this.burstObjs.delete(k))
    // where you spawned: three rings of your colour closing in on the tank, again and again
    const me = s.world?.playerTanks[0]
    const you = s.nameOf(s.pid)
    const age = now - s.spawnedAt
    if (me?.alive && you && age < SPAWN_MARK_MS) {
      if (!this.youRings) {
        this.youRings = new THREE.Group()
        for (let i = 0; i < 3; i++) this.youRings.add(ringObject('#ffffff', 0.9, 1, 0.9))
        this.fx.add(this.youRings)
      }
      const g = this.youRings
      g.visible = true
      g.position.set(me.pos.x, 0, me.pos.z)
      const fade = Math.min(1, (SPAWN_MARK_MS - age) / 500)
      g.children.forEach((r, i) => {
        const f = ((age / 900 + i / 3) % 1) ** 0.8
        const ring = r.children[0] as THREE.Mesh
        ring.scale.setScalar(26 + (1 - f) * 150)
        const m = ring.material as THREE.MeshBasicNodeMaterial
        m.color.set(this.colorOf(s, you.team, you.color))
        m.opacity = 0.85 * fade * Math.min(1, f * 4)
      })
    } else if (this.youRings) this.youRings.visible = false
    // Battle royale: the zone
    const zn = s.zoneNow()
    if (zn && s.board?.state === 'play') {
      if (!this.zoneObj) {
        const g = (this.zoneObj = new THREE.Group())
        const flat = (geo: THREE.BufferGeometry, color: number, opacity: number, y: number) => {
          const m = new THREE.Mesh(geo, new THREE.MeshBasicNodeMaterial({ color, transparent: true, opacity, depthWrite: false }))
          m.rotation.x = -Math.PI / 2
          m.position.y = y
          return m
        }
        // outside: from the edge out past the map's corners (scaled with the radius)
        g.add(flat(new THREE.RingGeometry(1, 60, 128, 1), 0xd8202a, 0.22, 0.9))
        g.add(flat(new THREE.RingGeometry(0.985, 1, 128), 0xff3b30, 0.9, 1))
        g.add(flat(new THREE.RingGeometry(0.99, 1, 128), 0xffffff, 0.55, 1))
        this.fx.add(g)
      }
      const [wash, edge, next] = this.zoneObj.children as THREE.Mesh[]
      this.zoneObj.visible = true
      this.zoneObj.position.set(zn.x, 0, zn.z)
      wash.scale.setScalar(zn.r)
      edge.scale.setScalar(zn.r)
      next.scale.setScalar(zn.next)
      next.visible = zn.next < zn.r - 1
    } else if (this.zoneObj) this.zoneObj.visible = false
    // teams: a ring of the team colour under every visible tank
    const shown = new Set<number>()
    if (isTeamMode(s.mode))
      for (const tk of s.world?.tanks ?? []) {
        const own = tk === s.world?.playerTanks[0]
        const pid = own ? s.pid : (tk.ai?.pid as number | undefined)
        const p = pid !== undefined ? s.nameOf(pid) : undefined
        if (pid === undefined || !p || !tk.alive || s.hidden(tk)) continue
        shown.add(pid)
        let o = this.rings.get(pid)
        if (!o || o.userData.team !== p.team) {
          if (o) this.fx.remove(o)
          o = ringObject(TEAM_COLORS[p.team], 24, 29)
          o.userData.team = p.team
          this.fx.add(o)
          this.rings.set(pid, o)
        }
        o.position.set(tk.pos.x, 0, tk.pos.z)
      }
    for (const [id, o] of this.rings)
      if (!shown.has(id)) {
        this.fx.remove(o)
        this.rings.delete(id)
      }
  }
}

function flip(el: SVGSVGElement) {
  el.classList.add('flip')
  return el
}

let missileMats: THREE.MeshBasicNodeMaterial[] | null = null
/** a flare missile: a red-orange dart with a white-hot tip and a glowing exhaust trail */
function missileObject() {
  const [body, tip, puff] = (missileMats ??= [
    new THREE.MeshBasicNodeMaterial({ color: 0xff4a12 }),
    new THREE.MeshBasicNodeMaterial({ color: 0xffffe0 }),
    new THREE.MeshBasicNodeMaterial({ color: 0xffa020, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }),
  ])
  const g = new THREE.Group()
  const dart = new THREE.Group()
  const b = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 11, 8), body)
  b.rotation.x = Math.PI / 2
  const h = new THREE.Mesh(new THREE.ConeGeometry(2.8, 5, 8), tip)
  h.rotation.x = Math.PI / 2
  h.position.z = 8
  const glow = new THREE.Mesh(new THREE.SphereGeometry(4.5, 10, 8), puff)
  glow.position.z = -6
  dart.add(b, h, glow)
  dart.scale.setScalar(1.25)
  g.add(dart)
  for (let i = 0; i < 4; i++) g.add(new THREE.Mesh(new THREE.SphereGeometry(3.6, 8, 6), puff))
  return g
}

let bubble: THREE.MeshBasicNodeMaterial | null = null
/** the shield's clear mint bubble (shared) */
function bubbleMat() {
  return (bubble ??= new THREE.MeshBasicNodeMaterial({ color: 0x9ff0d6, transparent: true, opacity: 0.3, depthWrite: false }))
}

/** how long the "you are here" marker shows after spawning (ms) */
const SPAWN_MARK_MS = 3000

function ringObject(color: string, r0: number, r1: number, opacity = 0.75) {
  const m = new THREE.Mesh(new THREE.RingGeometry(r0, r1, 40), new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(color), transparent: true, opacity, depthWrite: false }))
  m.rotation.x = -Math.PI / 2
  m.position.y = 0.7
  const g = new THREE.Group()
  g.add(m)
  return g
}

function pickupObject(kind: AnyPickup, tank: THREE.Object3D) {
  const g = new THREE.Group()
  const holder = new THREE.Group()
  tank.scale.multiplyScalar(0.62)
  holder.add(tank)
  const info = pickupInfo(kind)
  const ring = ringObject(info.color, 17, 23, 0.9)
  const glow = new THREE.Mesh(new THREE.CircleGeometry(23, 40), new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(info.color), transparent: true, opacity: 0.25, depthWrite: false }))
  glow.rotation.x = -Math.PI / 2
  glow.position.y = 0.5
  ring.add(glow)
  g.add(holder, ring)
  return g
}

registerScreen('arena', () => new ArenaScreen())
