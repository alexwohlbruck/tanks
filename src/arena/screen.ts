// 'arena': the massively-multiplayer mode's screen, in the web screens' toy-wood style.
// Before playing: name, Free-for-all or Teams, players online, the special tanks you can turn
// into. While playing: the HUD over the game view (timer band, scores, leaderboard, kill feed,
// minimap, ammo and the special tank you are, respawn countdown, names over tanks; pickups and
// team rings drawn in the scene), Tab for the scoreboard, Esc for the menu, wheel to zoom,
// V for first person.

import * as THREE from 'three/webgpu'
import { registerScreen } from '../app/router'
import type { AppContext, Screen } from '../app/types'
import type { BaseModel } from '../render/registry'
import { logo, tankIcon } from '../ui/web/art'
import { backButton, band, button, type WebApp } from '../ui/web/base'
import { h } from '../ui/web/dom'
import { Nav } from '../ui/web/nav'
import type { Board } from './protocol'
import { FFA_COLORS, FFA_LIMIT, PICKUP_INFO, PICKUP_KINDS, PICKUP_TICKS, PICKUP_TYPE, TEAM_COLORS, TEAM_LIMIT, TEAM_NAMES, type ArenaMode, type PickupKind } from './rules'
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
const MINE_SVG = '<svg viewBox="0 0 24 24" class="ar-mine"><circle cx="12" cy="13" r="9.5" fill="#e8c33a" stroke="#5b3a19" stroke-width="1.6"/><circle cx="12" cy="13" r="4" fill="#cf2a31" stroke="#5b3a19" stroke-width="1.2"/></svg>'

class ArenaScreen implements Screen {
  readonly opaque = false
  private root!: HTMLElement
  private app!: WebApp
  private phase: 'join' | 'play' = 'join'
  private menuOpen = false
  private session: ArenaSession | null = null
  private mode: ArenaMode = 'ffa'
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
  private poll: ReturnType<typeof setInterval> | null = null
  private sheetHeld = false
  private onKey = (e: KeyboardEvent) => {
    if (this.phase === 'play' && e.code === 'Tab') {
      e.preventDefault()
      this.sheetHeld = e.type === 'keydown'
    }
  }
  private onWheel = (e: WheelEvent) => {
    if (this.phase !== 'play' || this.menuOpen || !this.session) return
    this.session.zoom = Math.max(0.5, Math.min(1.3, this.session.zoom * (e.deltaY > 0 ? 0.92 : 1.08)))
  }

  get modal() {
    return this.phase !== 'play' || this.menuOpen
  }

  mount(root: HTMLElement, app: AppContext) {
    this.root = root
    this.app = app as WebApp
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
    document.body.classList.remove('arena-playing')
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
    const ffaArt = h('div.ar-tanks')
    for (const c of FFA_COLORS.slice(0, 5)) ffaArt.append(tankIcon(c, shade(c)))
    const blue = () => tankIcon(TEAM_COLORS[0], shade(TEAM_COLORS[0]))
    const red = () => flip(tankIcon(TEAM_COLORS[1], shade(TEAM_COLORS[1])))
    const teamArt = h('div.ar-tanks.vs', null, blue(), blue(), h('b', null, 'vs'), red(), red())
    const online = h('div.ar-online', null, h('i.dot'), h('span', null, 'Checking the server…'))
    const powers = h(
      'div.ar-powers',
      null,
      ...PICKUP_KINDS.map((k) => h('div.ar-power-row', null, tankIcon(PICKUP_INFO[k].color, PICKUP_INFO[k].dark), h('b', null, PICKUP_INFO[k].name), h('span', null, PICKUP_INFO[k].trick))),
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
            h('p.ar-lede', null, 'One huge map and a lot of tanks. Jump in any time; you respawn when you’re hit.'),
            h('label.ar-name', null, h('span', null, 'Your name'), name),
            h(
              'div.ar-modes',
              null,
              modeCard('ffa', 'Free-for-all', `Every tank for itself. First to ${FFA_LIMIT} wins.`, ffaArt),
              modeCard('teams', 'Teams', `Blue against Red. First team to ${TEAM_LIMIT}.`, teamArt),
            ),
            button('Play', { icon: 'play', class: 'primary big ar-go', autofocus: true, onclick: () => this.play(name.value) }),
            online,
            h(
              'div.card.ar-rules',
              null,
              h('div.records-head', null, 'Special tanks'),
              h('div.card-text', null, 'Drive over a spinning tank to become it for a while.'),
              powers,
              h('div.records-head', null, 'Rules'),
              h(
                'ul',
                null,
                h('li', null, 'One hit destroys a tank. You’re back 3 seconds later, protected until you fire.'),
                h('li', null, 'Matches last 6 minutes, then a new map is built.'),
                h('li', null, 'Teams: no friendly fire. Destroying yourself costs a point.'),
                h('li', null, 'The minimap shows teammates, and enemies right after they fire.'),
              ),
            ),
            h('div.foot-hint', null, 'WASD drive · mouse aim · click fire · Space mine · wheel zoom · V first person · Tab scores'),
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
        online.querySelector('span')!.textContent = r.online ? `${r.online} playing now · ${by('ffa')} free-for-all · ${by('teams')} teams` : 'Nobody online yet: the bots are ready'
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
    const s = new ArenaSession(this.app.view, this.app.audio, name, this.mode)
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
        <div class="ar-sheet results-screen" hidden></div>
        <div class="ar-menu pause-screen" hidden></div>
        <div class="ar-connecting pause-screen"><div class="panel pause">${band('Connecting…', 'dark').outerHTML}</div></div>
      </div>`
    for (const k of ['timer', 'score', 'board', 'feed', 'banner', 'respawn', 'ammo', 'power', 'labels', 'net', 'sheet', 'menu', 'connecting']) this.els[k] = this.root.querySelector(`.ar-${k}`)!
    this.minimap = this.root.querySelector('.ar-minimap')!
    this.last = {}
    this.app.view.root.add(this.fx)
  }

  private toggleMenu(on = !this.menuOpen) {
    this.menuOpen = on
    if (this.session) this.session.inputBlocked = on
    const m = this.els.menu
    m.hidden = !on
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
      this.set('timer', `<span>${b.state === 'over' ? 'Match over' : fmt(b.secs)}</span>`)
      this.els.timer.classList.toggle('hurry', b.state === 'play' && b.secs <= 30)
      this.set('score', this.scoreHtml(b, s))
      this.set('board', this.boardHtml(b, s))
      const sheet = b.state === 'over' || this.sheetHeld
      this.els.sheet.hidden = !sheet
      if (sheet) this.set('sheet', this.sheetHtml(b, s))
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
      this.els.respawn.classList.toggle('on', !you.alive && b?.state !== 'over')
      if (!you.alive) this.set('respawn', `<span>Back in ${Math.max(1, Math.ceil(you.respawn / 60))}</span>`)
      const pips = (n: number, max: number, svg: string) => Array.from({ length: max }, (_, i) => `<i class="${i < n ? 'on' : ''}">${svg}</i>`).join('')
      this.set('ammo', `<div class="row">${pips(you.shells, you.maxShells, SHELL_SVG)}</div><div class="row">${pips(you.mines, you.maxMines, MINE_SVG)}</div>`)
      if (you.power) {
        const info = PICKUP_INFO[you.power]
        const left = Math.max(0, you.powerLeft / PICKUP_TICKS[you.power])
        const pw = `<div class="ar-pw" style="--c:${info.color};--d:${info.dark}">${icoHtml(info.color, info.dark)}<div><b>${info.name} tank</b><small>${info.trick}</small><u><i></i></u></div></div>`
        this.set('power', pw)
        // the time bar moves every frame: set its width without rebuilding the box
        const bar = this.els.power.querySelector<HTMLElement>('u i')
        if (bar) bar.style.width = `${(left * 100).toFixed(1)}%`
      } else this.set('power', you.protect && you.alive ? `<div class="ar-pw dim"><div><b>Protected</b><small>until you fire</small></div></div>` : '')
    }
    this.els.net.textContent = `${Math.round(s.rtt)} ms`
    this.drawMinimap(s)
    this.drawLabels(s)
    this.syncFx(s)
  }

  private colorOf(s: ArenaSession, team: number, color: string) {
    return s.mode === 'teams' ? TEAM_COLORS[team] : color
  }

  private scoreHtml(b: Board, s: ArenaSession) {
    if (s.mode === 'teams') {
      const lead = b.teams[0] === b.teams[1] ? -1 : b.teams[0] > b.teams[1] ? 0 : 1
      return `<div class="ar-plaque teams"><span class="t ${lead === 0 ? 'lead' : ''}">${icoHtml(TEAM_COLORS[0])}<b>${b.teams[0]}</b></span><small>first to ${TEAM_LIMIT}</small><span class="t ${lead === 1 ? 'lead' : ''}"><b>${b.teams[1]}</b>${icoHtml(TEAM_COLORS[1], undefined, 'tank-icon flip')}</span></div>`
    }
    const me = b.players.find((p) => p[0] === s.pid)
    if (!me) return ''
    const sorted = [...b.players].sort((x, y) => y[6] - x[6] || x[5] - y[5])
    const rank = sorted.findIndex((p) => p[0] === s.pid) + 1
    return `<div class="ar-plaque">${icoHtml(me[3])}<b>${me[6]}</b><small>/ ${FFA_LIMIT}</small><span class="rank">${ord(rank)} of ${b.players.length}</span></div>`
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
      s.mode === 'teams'
        ? `<div class="ar-teams">${table(sorted.filter((p) => p[2] === 0), `${TEAM_NAMES[0]} · ${b.teams[0]}`, TEAM_COLORS[0])}${table(sorted.filter((p) => p[2] === 1), `${TEAM_NAMES[1]} · ${b.teams[1]}`, TEAM_COLORS[1])}</div>`
        : table(sorted)
    return `<div class="panel results ar-results">${head}${body}<div class="results-sub">${over ? `A new map in ${b.secs}…` : 'Release Tab to play on'}</div></div>`
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
      g.fillStyle = PICKUP_INFO[k.kind].color
      g.strokeStyle = PICKUP_INFO[k.kind].dark
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
        if (pid === undefined || pid === s.pid || !t.alive || s.hidden(t)) continue
        const p = s.nameOf(pid)
        if (!p) continue
        seen.add(pid)
        let el = this.labels.get(pid)
        if (!el) {
          el = document.createElement('div')
          el.className = 'ar-tag'
          this.els.labels.appendChild(el)
          this.labels.set(pid, el)
        }
        const color = this.colorOf(s, p.team, p.color)
        const power = s.powerOf(t)
        const key = p.name + color + (power ?? '')
        if (el.dataset.k !== key) {
          el.dataset.k = key
          el.innerHTML = `<i style="background:${color}"></i>${esc(p.name)}${power ? `<em style="background:${PICKUP_INFO[power].color};color:${power === 'white' || power === 'yellow' ? '#3b2512' : '#fff'}">${PICKUP_INFO[power].name}</em>` : ''}`
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
  }

  private syncFx(s: ArenaSession) {
    const t = performance.now() / 1000
    const models = this.app.view.models
    // pickups: a little model of the special tank, spinning over a glowing ring
    const seen = new Set<number>()
    for (const k of s.pickupList) {
      seen.add(k.id)
      let o = this.pickupObjs.get(k.id)
      if (!o) {
        o = pickupObject(k.kind, models)
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
    // teams: a ring of the team colour under every visible tank
    const shown = new Set<number>()
    if (s.mode === 'teams')
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

function ringObject(color: string, r0: number, r1: number, opacity = 0.75) {
  const m = new THREE.Mesh(new THREE.RingGeometry(r0, r1, 40), new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(color), transparent: true, opacity, depthWrite: false }))
  m.rotation.x = -Math.PI / 2
  m.position.y = 0.7
  const g = new THREE.Group()
  g.add(m)
  return g
}

function pickupObject(kind: PickupKind, models: { tank(l: { key: string; base: BaseModel }): { root: THREE.Object3D } }) {
  const g = new THREE.Group()
  const base = `e_${PICKUP_TYPE[kind]}` as BaseModel
  const holder = new THREE.Group()
  const tank = models.tank({ key: base, base }).root
  tank.scale.setScalar(0.62)
  holder.add(tank)
  const info = PICKUP_INFO[kind]
  const ring = ringObject(info.color, 17, 23, 0.9)
  const glow = new THREE.Mesh(new THREE.CircleGeometry(23, 40), new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(info.color), transparent: true, opacity: 0.25, depthWrite: false }))
  glow.rotation.x = -Math.PI / 2
  glow.position.y = 0.5
  ring.add(glow)
  g.add(holder, ring)
  return g
}

registerScreen('arena', () => new ArenaScreen())
