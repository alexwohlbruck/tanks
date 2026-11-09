// 'arena': the massively-multiplayer mode's screen. Before playing: name, Free-for-all or
// Teams, how many are online. While playing: the HUD over the game view (timer and scores,
// leaderboard, kill feed, minimap, ammo / power-ups, respawn countdown, names over tanks,
// pickups and shields drawn in the scene), Tab for the full scoreboard, Esc for the menu,
// mouse wheel to zoom the camera, V for first person.

import * as THREE from 'three/webgpu'
import { registerScreen } from '../app/router'
import type { AppContext, Screen } from '../app/types'
import type { WebApp } from '../ui/web/base'
import { TF_POWER_SHIFT, TF_SHIELD } from './protocol'
import { FFA_LIMIT, PICKUP_INFO, PICKUP_KINDS, PICKUP_TICKS, TEAM_COLORS, TEAM_LIMIT, TEAM_NAMES, type ArenaMode, type PickupKind } from './rules'
import { ArenaSession, PICKUP_LABEL } from './session'
import './arena.css'

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

const PICKUP_ICON: Record<PickupKind, string> = { rocket: '🚀', bounce: '↯', shield: '🛡', speed: '⚡' }

class ArenaScreen implements Screen {
  readonly opaque = false
  private root!: HTMLElement
  private app!: WebApp
  private phase: 'join' | 'play' = 'join'
  private menuOpen = false
  private session: ArenaSession | null = null
  private mode: ArenaMode = 'ffa'
  private els: Record<string, HTMLElement> = {}
  private minimap!: HTMLCanvasElement
  private mapBg: HTMLCanvasElement | null = null
  private mapVersion = -1
  private labels = new Map<number, HTMLElement>()
  private fx = new THREE.Group()
  private pickupObjs = new Map<number, THREE.Object3D>()
  private shieldObjs = new Map<number, THREE.Object3D>()
  private poll: ReturnType<typeof setInterval> | null = null
  private onKey = (e: KeyboardEvent) => this.key(e)
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
    root.classList.add('arena-ui')
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
    document.body.classList.remove('arena-playing')
    this.app.view.root.remove(this.fx)
  }

  // ---- join -------------------------------------------------------------------------------

  private renderJoin(error = '') {
    this.phase = 'join'
    document.body.classList.remove('arena-playing')
    const name = ArenaSession.savedName()
    this.root.innerHTML = `
      <div class="ar-join">
        <div class="ar-card">
          <button class="ar-back" data-act="back">← Menu</button>
          <h1>Tanks! <span>Arena</span></h1>
          <p class="ar-lede">One huge map, lots of tanks. Drive in any time, respawn when you're hit.</p>
          <label class="ar-field"><span>Your name</span><input class="ar-name" maxlength="16" value="${esc(name)}" placeholder="Player" autocomplete="nickname"></label>
          <div class="ar-modes">
            <button class="ar-mode ${this.mode === 'ffa' ? 'on' : ''}" data-mode="ffa"><b>Free-for-all</b><span>Every tank for itself. First to ${FFA_LIMIT} wins.</span></button>
            <button class="ar-mode ${this.mode === 'teams' ? 'on' : ''}" data-mode="teams"><b>Teams</b><span><i style="color:${TEAM_COLORS[0]}">Blue</i> vs <i style="color:${TEAM_COLORS[1]}">Red</i>. First team to ${TEAM_LIMIT}.</span></button>
          </div>
          <button class="ar-play" data-act="play">Play</button>
          <div class="ar-online"></div>
          ${error ? `<div class="ar-error">${esc(error)}</div>` : ''}
          <details class="ar-rules"><summary>How it works</summary>
            <ul>
              <li>One hit destroys a tank. You respawn after 3 seconds, protected until you fire or 2.5 s pass.</li>
              <li>Matches last 6 minutes, then a new map is generated.</li>
              <li>Teams: no friendly fire. Your shells pass your teammates and your mines ignore them.</li>
              <li>Destroying yourself costs a point.</li>
              <li>Pickups: ${PICKUP_KINDS.map((k) => `<b style="color:${PICKUP_INFO[k].color}">${PICKUP_INFO[k].name}</b>`).join(', ')}.</li>
              <li>The minimap shows teammates, and enemies for a moment after they fire.</li>
              <li>WASD drive · mouse aim · click fire · Space / right click mine · wheel zoom · V first person · Tab scores</li>
            </ul>
          </details>
        </div>
      </div>`
    const input = this.root.querySelector<HTMLInputElement>('.ar-name')!
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') this.play()
    })
    this.root.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => {
        this.mode = b.dataset.mode as ArenaMode
        this.root.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b))
        this.app.audio.play('RP_COMMON_SE_KEY_CURSOR_01')
      }),
    )
    this.root.querySelector('[data-act="play"]')!.addEventListener('click', () => this.play())
    this.root.querySelector('[data-act="back"]')!.addEventListener('click', () => this.app.toMenu())
    setTimeout(() => input.focus(), 50)
    const online = async () => {
      try {
        const r = await this.app.api('/arena').then((x) => x.json())
        const by = (m: string) => r.arenas.filter((a: { mode: string }) => a.mode === m).reduce((n: number, a: { humans: number }) => n + a.humans, 0)
        const el = this.root.querySelector('.ar-online')
        if (el) el.textContent = `${r.online} playing now · ${by('ffa')} free-for-all · ${by('teams')} teams`
      } catch {
        const el = this.root.querySelector('.ar-online')
        if (el) el.textContent = 'Server unreachable'
      }
    }
    void online()
    if (this.poll) clearInterval(this.poll)
    this.poll = setInterval(online, 4000)
  }

  private play() {
    const name = (this.root.querySelector<HTMLInputElement>('.ar-name')?.value ?? '').trim() || 'Player'
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    this.app.audio.play('RP_COMMON_SE_KEY_A_04')
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
    document.body.classList.add('arena-playing')
    this.root.innerHTML = `
      <div class="ar-hud">
        <div class="ar-top"><div class="ar-timer"></div><div class="ar-score"></div></div>
        <div class="ar-board"></div>
        <div class="ar-feed"></div>
        <div class="ar-banner"></div>
        <div class="ar-respawn"></div>
        <div class="ar-bottom"><div class="ar-ammo"></div><div class="ar-power"></div></div>
        <canvas class="ar-minimap"></canvas>
        <div class="ar-labels"></div>
        <div class="ar-net"></div>
        <div class="ar-scores" hidden></div>
        <div class="ar-over" hidden></div>
        <div class="ar-menu" hidden>
          <div class="ar-card small">
            <h2>Arena</h2>
            <button data-act="resume">Resume</button>
            <button data-act="fpv">First-person view</button>
            <button data-act="leave">Leave arena</button>
          </div>
        </div>
        <div class="ar-connecting">Connecting…</div>
      </div>`
    for (const k of ['timer', 'score', 'board', 'feed', 'banner', 'respawn', 'ammo', 'power', 'labels', 'net', 'scores', 'over', 'menu', 'connecting'])
      this.els[k] = this.root.querySelector(`.ar-${k}`)!
    this.minimap = this.root.querySelector('.ar-minimap')!
    this.els.menu.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act
      if (act === 'resume') this.toggleMenu(false)
      if (act === 'fpv') {
        this.toggleMenu(false)
        this.app.toggleFpv()
      }
      if (act === 'leave') this.leave()
    })
    this.app.view.root.add(this.fx)
  }

  private toggleMenu(on = !this.menuOpen) {
    this.menuOpen = on
    if (this.session) this.session.inputBlocked = on
    this.els.menu.hidden = !on
    if (on && document.pointerLockElement) document.exitPointerLock()
    const fpv = this.els.menu.querySelector<HTMLElement>('[data-act="fpv"]')
    if (fpv) fpv.textContent = this.app.fpvOn ? 'Top-down view' : 'First-person view'
    this.app.audio.play(on ? 'RP_COM_GAME_SE_PAUSE_01_TVSP' : 'RP_COMMON_SE_KEY_BACK_01')
  }

  private leave() {
    if (this.app.fpvOn) this.app.toggleFpv(false)
    this.session = null
    this.app.toMenu()
  }

  private key(e: KeyboardEvent) {
    if (this.phase !== 'play') {
      if (e.type === 'keydown' && e.key === 'Escape' && (e.target as HTMLElement)?.tagName !== 'INPUT') this.app.toMenu()
      return
    }
    if (e.code === 'Tab') {
      e.preventDefault()
      this.els.scores.hidden = e.type !== 'keydown'
      return
    }
    if (e.type === 'keydown' && e.code === 'Escape' && this.menuOpen) {
      e.preventDefault()
      this.toggleMenu(false)
    }
  }

  update() {
    const s = this.session
    if (this.phase !== 'play' || !s) return
    if (s.status === 'closed' || s.error) {
      if (s.error && !this.els.connecting.dataset.err) {
        this.els.connecting.dataset.err = '1'
        this.els.connecting.innerHTML = `${esc(s.error)}<br><button data-act="rejoin">Back</button>`
        this.els.connecting.querySelector('button')!.onclick = () => this.leave()
      }
      this.els.connecting.hidden = false
      return
    }
    this.els.connecting.hidden = !!s.world && !!s.you
    const b = s.board
    const you = s.you
    // timer + headline scores
    if (b) {
      this.els.timer.textContent = b.state === 'over' ? `Next map in ${b.secs}` : fmt(b.secs)
      const me = b.players.find((p) => p[0] === s.pid)
      if (s.mode === 'teams') {
        this.els.score.innerHTML = `<span style="color:${TEAM_COLORS[0]}">${TEAM_NAMES[0]} ${b.teams[0]}</span><i>/ ${TEAM_LIMIT}</i><span style="color:${TEAM_COLORS[1]}">${b.teams[1]} ${TEAM_NAMES[1]}</span>`
      } else if (me) {
        const sorted = [...b.players].sort((x, y) => y[6] - x[6])
        const rank = sorted.findIndex((p) => p[0] === s.pid) + 1
        this.els.score.innerHTML = `<b>${me[6]}</b><i>/ ${FFA_LIMIT}</i> <span>#${rank} of ${b.players.length}</span>`
      }
      // leaderboard: top 5 + you
      const sorted = [...b.players].sort((x, y) => y[6] - x[6] || x[5] - y[5])
      const rows = sorted.slice(0, 5)
      const mine = sorted.find((p) => p[0] === s.pid)
      if (mine && !rows.includes(mine)) rows.push(mine)
      this.els.board.innerHTML = rows
        .map((p) => `<div class="${p[0] === s.pid ? 'me' : ''}"><i>${sorted.indexOf(p) + 1}</i><span><u style="background:${p[3]}"></u>${esc(p[1])}</span><b>${p[6]}</b></div>`)
        .join('')
      if (!this.els.scores.hidden || b.state === 'over') this.renderScores(b, s)
      this.els.over.hidden = b.state !== 'over'
      if (b.state === 'over') {
        const w = b.winner
        this.els.over.innerHTML = `<div class="ar-card"><h2>${w ? `<span style="color:${w.color}">${esc(w.name)}</span> wins!` : 'A draw!'}</h2>${this.scoresTable(b, s)}<p>Next map in ${b.secs}…</p></div>`
      }
    }
    // feed
    const now = performance.now()
    s.feed = s.feed.filter((f) => now - f.at < 7000)
    this.els.feed.innerHTML = s.feed.map((f) => `<div>${f.html}</div>`).join('')
    this.els.banner.textContent = s.banner?.text ?? ''
    this.els.banner.classList.toggle('on', !!s.banner)
    // own state
    if (you) {
      this.els.respawn.hidden = !!you.alive
      if (!you.alive) this.els.respawn.innerHTML = `Respawning in <b>${Math.max(1, Math.ceil(you.respawn / 60))}</b>`
      const pips = (n: number, max: number, cls: string) => Array.from({ length: max }, (_, i) => `<i class="${cls} ${i < n ? 'on' : ''}"></i>`).join('')
      this.els.ammo.innerHTML = `<div class="row">${pips(you.shells, 5, 'shell')}</div><div class="row">${pips(you.mines, 2, 'mine')}</div>`
      const pw: string[] = []
      if (you.power) pw.push(`<div class="pw" style="--c:${PICKUP_INFO[you.power].color}"><span>${PICKUP_ICON[you.power]} ${PICKUP_LABEL[you.power]}</span><u style="width:${(100 * you.powerLeft) / PICKUP_TICKS[you.power]}%"></u></div>`)
      if (you.shield) pw.push(`<div class="pw" style="--c:${PICKUP_INFO.shield.color}"><span>${PICKUP_ICON.shield} Shield</span></div>`)
      if (you.protect && you.alive) pw.push(`<div class="pw dim"><span>Spawn protection</span></div>`)
      this.els.power.innerHTML = pw.join('')
    }
    this.els.net.textContent = `${Math.round(s.rtt)} ms`
    this.drawMinimap(s)
    this.drawLabels(s)
    this.syncFx(s)
  }

  private scoresTable(b: NonNullable<ArenaSession['board']>, s: ArenaSession) {
    const sorted = [...b.players].sort((x, y) => y[6] - x[6] || x[5] - y[5])
    const row = (p: (typeof sorted)[number], i: number) =>
      `<tr class="${p[0] === s.pid ? 'me' : ''}"><td>${i + 1}</td><td style="color:${p[3]}">${esc(p[1])}${p[7] ? ' <small>bot</small>' : ''}</td><td>${p[4]}</td><td>${p[5]}</td><td><b>${p[6]}</b></td></tr>`
    const head = '<tr><th></th><th>Tank</th><th>Kills</th><th>Deaths</th><th>Score</th></tr>'
    if (s.mode === 'teams')
      return `<div class="ar-teams">${[0, 1]
        .map((t) => `<table><caption style="color:${TEAM_COLORS[t]}">${TEAM_NAMES[t]} · ${b.teams[t]}</caption>${head}${sorted.filter((p) => p[2] === t).map(row).join('')}</table>`)
        .join('')}</div>`
    return `<table>${head}${sorted.map(row).join('')}</table>`
  }

  private renderScores(b: NonNullable<ArenaSession['board']>, s: ArenaSession) {
    this.els.scores.innerHTML = `<div class="ar-card">${this.scoresTable(b, s)}</div>`
  }

  // ---- minimap ----------------------------------------------------------------------------

  private drawMinimap(s: ArenaSession) {
    const map = s.map
    if (!map) return
    const scale = 2.2
    const W = Math.round(map.cols * scale), H = Math.round(map.rows * scale)
    if (this.mapVersion !== s.mapVersion || !this.mapBg) {
      this.mapVersion = s.mapVersion
      const c = (this.mapBg ??= document.createElement('canvas'))
      c.width = W
      c.height = H
      const g = c.getContext('2d')!
      g.fillStyle = 'rgba(232, 214, 170, 0.85)'
      g.fillRect(0, 0, W, H)
      for (let r = 0; r < map.rows; r++)
        for (let q = 0; q < map.cols; q++) {
          const k = map.cells[r][q]
          if (!k) continue
          g.fillStyle = k === 200 ? 'rgba(60,40,20,0.55)' : k < 200 ? '#b57a45' : '#7a5230'
          g.fillRect(q * scale, r * scale, scale, scale)
        }
      this.minimap.width = W
      this.minimap.height = H
    }
    const g = this.minimap.getContext('2d')!
    g.drawImage(this.mapBg!, 0, 0)
    const toMap = (x: number, z: number) => [(x / 35 + (map.cols - 1) / 2 + 0.5) * scale, (z / 35 + (map.rows - 1) / 2 + 0.5) * scale]
    // view rectangle
    const f = this.app.view.follow
    if (f) {
      const cam = this.app.view.camera
      const hw = (cam.right - cam.left) / 2 / cam.zoom, hh = (cam.top - cam.bottom) / 2 / cam.zoom / Math.sin((42 * Math.PI) / 180)
      const [x0, y0] = toMap(f.x - hw, f.z - hh * 0.9)
      const [x1, y1] = toMap(f.x + hw, f.z + hh * 0.9)
      g.strokeStyle = 'rgba(255,255,255,0.8)'
      g.lineWidth = 1
      g.strokeRect(x0, y0, x1 - x0, y1 - y0)
    }
    for (const k of s.pickupList) {
      const [x, y] = toMap(k.x, k.z)
      g.fillStyle = PICKUP_INFO[k.kind].color
      g.fillRect(x - 2, y - 2, 4, 4)
    }
    for (const [pid, x, z] of s.board?.mm ?? []) {
      if (pid === s.pid) continue
      const p = s.nameOf(pid)
      const [mx, my] = toMap(x, z)
      g.fillStyle = p?.color ?? '#fff'
      g.beginPath()
      g.arc(mx, my, 3, 0, Math.PI * 2)
      g.fill()
    }
    const me = s.world?.playerTanks[0]
    if (me?.active) {
      const [mx, my] = toMap(me.pos.x, me.pos.z)
      g.fillStyle = '#fff'
      g.strokeStyle = '#000'
      g.lineWidth = 1.5
      g.beginPath()
      g.arc(mx, my, 4, 0, Math.PI * 2)
      g.fill()
      g.stroke()
    }
  }

  // ---- in-world extras: names, pickups, shields --------------------------------------------

  private drawLabels(s: ArenaSession) {
    const w = s.world
    const view = this.app.view
    const seen = new Set<number>()
    if (w && !view.fpv) {
      const rect = this.root.getBoundingClientRect()
      const v = new THREE.Vector3()
      for (const t of w.tanks) {
        const pid = t.ai?.pid as number | undefined
        if (pid === undefined || pid === s.pid || !t.alive) continue
        const p = s.nameOf(pid)
        if (!p) continue
        seen.add(pid)
        let el = this.labels.get(pid)
        if (!el) {
          el = document.createElement('div')
          this.els.labels.appendChild(el)
          this.labels.set(pid, el)
        }
        if (el.dataset.n !== p.name + p.color) {
          el.dataset.n = p.name + p.color
          el.textContent = p.name
          el.style.color = p.color
        }
        v.set(t.pos.x, 48, t.pos.z).project(view.camera)
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
    // pickups: a spinning painted crate on a glowing ring
    const seen = new Set<number>()
    for (const k of s.pickupList) {
      seen.add(k.id)
      let o = this.pickupObjs.get(k.id)
      if (!o) {
        o = pickupObject(k.kind)
        o.position.set(k.x, 0, k.z)
        this.fx.add(o)
        this.pickupObjs.set(k.id, o)
      }
      const box = o.children[0]
      box.rotation.y = t * 1.6
      box.position.y = 14 + Math.sin(t * 3 + k.id) * 3
    }
    for (const [id, o] of this.pickupObjs)
      if (!seen.has(id)) {
        this.fx.remove(o)
        this.pickupObjs.delete(id)
      }
    // shields and powered-up tanks
    const shown = new Set<number>()
    for (const tk of s.world?.tanks ?? []) {
      const flags = (tk.ai?.flags as number) ?? 0
      const power = (flags >> TF_POWER_SHIFT) & 7
      const shield = flags & TF_SHIELD
      if (!shield && !power) continue
      const id = tk.ai?.pid as number
      shown.add(id)
      let o = this.shieldObjs.get(id)
      const want = shield ? 'shield' : PICKUP_KINDS[power - 1]
      if (!o || o.userData.kind !== want) {
        if (o) this.fx.remove(o)
        o = auraObject(want as PickupKind)
        this.fx.add(o)
        this.shieldObjs.set(id, o)
      }
      o.position.set(tk.pos.x, 0, tk.pos.z)
      o.rotation.y = t * 2
    }
    for (const [id, o] of this.shieldObjs)
      if (!shown.has(id)) {
        this.fx.remove(o)
        this.shieldObjs.delete(id)
      }
  }
}

function pickupObject(kind: PickupKind) {
  const g = new THREE.Group()
  const color = new THREE.Color(PICKUP_INFO[kind].color)
  const box = new THREE.Group()
  const body = new THREE.Mesh(new THREE.BoxGeometry(18, 18, 18), new THREE.MeshBasicNodeMaterial({ color }))
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(18.4, 18.4, 18.4)), new THREE.LineBasicNodeMaterial({ color: 0xffffff }))
  box.add(body, edges)
  const ring = new THREE.Mesh(new THREE.RingGeometry(14, 19, 32), new THREE.MeshBasicNodeMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false }))
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.5
  g.add(box, ring)
  return g
}

function auraObject(kind: PickupKind) {
  const color = new THREE.Color(PICKUP_INFO[kind].color)
  const g = new THREE.Group()
  g.userData.kind = kind
  if (kind === 'shield') {
    const m = new THREE.Mesh(new THREE.SphereGeometry(30, 24, 16), new THREE.MeshBasicNodeMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false }))
    m.position.y = 12
    g.add(m)
  }
  const ring = new THREE.Mesh(new THREE.RingGeometry(24, 28, 6), new THREE.MeshBasicNodeMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false }))
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.6
  g.add(ring)
  return g
}

registerScreen('arena', () => new ArenaScreen())
