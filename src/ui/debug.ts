// Debug panel (not in the original): unlimited lives, mission select, skip/lose a mission.
// Open with ` (backquote) or ?debug in the URL. Settings persist in localStorage.

import type { Game } from '../game'
import type { Hud } from './hud'

const KEY = 'tanks.debug'

type Settings = { open: boolean; infiniteLives: boolean; unlockAll: boolean; mission: number; players: 1 | 2 }

function load(): Settings {
  const d: Settings = { open: false, infiniteLives: true, unlockAll: true, mission: 1, players: 1 }
  try {
    Object.assign(d, JSON.parse(localStorage.getItem(KEY) ?? '{}'))
  } catch {}
  return d
}

export class DebugPanel {
  private s = load()
  private el = document.createElement('div')
  /** debug mode is on once the panel has been opened this session (or via ?debug) */
  enabled = false

  constructor(private game: Game, private hud: Hud, parent: HTMLElement) {
    this.el.id = 'debug'
    this.el.innerHTML = `
      <div class="t">Debug <span>(\` to hide)</span></div>
      <label><input type="checkbox" name="lives"> Unlimited lives</label>
      <label><input type="checkbox" name="unlock"> All 100 missions</label>
      <div class="row">
        <label>Mission <input type="number" name="mission" min="1" max="100"></label>
        <select name="players"><option value="1">1P</option><option value="2">2P</option></select>
        <button name="go">Go</button>
      </div>
      <div class="row">
        <button name="prev">◀ Prev</button>
        <button name="next">Next ▶</button>
      </div>
      <div class="row">
        <button name="clear">Clear mission</button>
        <button name="die">Lose life</button>
      </div>
      <div class="info"></div>`
    parent.appendChild(this.el)
    const q = <T extends HTMLElement>(n: string) => this.el.querySelector(`[name=${n}]`) as T
    const lives = q<HTMLInputElement>('lives')
    const unlock = q<HTMLInputElement>('unlock')
    const mission = q<HTMLInputElement>('mission')
    const players = q<HTMLSelectElement>('players')
    lives.checked = this.s.infiniteLives
    unlock.checked = this.s.unlockAll
    mission.value = String(this.s.mission)
    players.value = String(this.s.players)
    lives.onchange = () => this.set({ infiniteLives: lives.checked })
    unlock.onchange = () => this.set({ unlockAll: unlock.checked })
    mission.onchange = () => this.set({ mission: clampMission(+mission.value) })
    players.onchange = () => this.set({ players: players.value === '2' ? 2 : 1 })
    const go = (m: number) => {
      m = clampMission(m)
      mission.value = String(m)
      this.set({ mission: m })
      this.hud.debugStart(this.s.players, m - 1)
    }
    q('go').onclick = () => go(+mission.value)
    q('prev').onclick = () => go((this.game.state ? this.game.stage + 1 : this.s.mission) - 1)
    q('next').onclick = () => go((this.game.state ? this.game.stage + 1 : this.s.mission) + 1)
    q('clear').onclick = () => this.game.debugKillAll()
    q('die').onclick = () => this.game.debugKillPlayers()
    // keep keys typed into the panel away from the game
    for (const ev of ['keydown', 'keyup', 'pointerdown'] as const) this.el.addEventListener(ev, (e) => e.stopPropagation())
    addEventListener('keydown', (e) => {
      if (e.code === 'Backquote') this.toggle()
    })
    if (new URLSearchParams(location.search).has('debug')) this.s.open = true
    this.show(this.s.open)
  }

  private set(p: Partial<Settings>) {
    Object.assign(this.s, p)
    localStorage.setItem(KEY, JSON.stringify(this.s))
    this.apply()
  }

  /** options only take effect while debug mode is on */
  private apply() {
    this.game.options.infiniteLives = this.enabled && this.s.infiniteLives
    this.game.options.unlockAll = this.enabled && this.s.unlockAll
    if (this.enabled && this.s.unlockAll && this.game.state) this.game.lastStage = 99
  }

  toggle() {
    this.show(!this.s.open)
  }

  private show(open: boolean) {
    this.s.open = open
    if (open) this.enabled = true
    localStorage.setItem(KEY, JSON.stringify(this.s))
    this.el.style.display = open ? '' : 'none'
    this.apply()
  }

  /** per rendered frame: live status line */
  update() {
    if (!this.s.open) return
    const g = this.game
    const info = this.el.querySelector('.info')!
    const text = g.state ? `Mission ${g.stage + 1}/${g.lastStage + 1} · lives ${g.livesOf(0)} · enemies ${g.world?.enemyAliveNum ?? 0} · state ${g.state}` : 'title'
    if (info.textContent !== text) info.textContent = text
  }
}

const clampMission = (m: number) => Math.max(1, Math.min(100, Math.round(m) || 1))
