// 'tanksplus' screen: the Tanks+ campaign (src/levels/packs) — world tabs, level select with
// unlocks, 1-4 local players. Progress (furthest level reached) is kept in localStorage.

import { registerScreen } from '../../app/router'
import { TANKS_PLUS_WORLDS, tanksPlus } from '../../levels/packs'
import { loadPackRecord } from '../shared/save'
import { packMedalRule } from '../shared/track'
import { medalIcon, MEDALS } from './art'
import { backButton, band, button, WebScreen } from './base'
import { h } from './dom'

const KEY = 'tanks.plus.progress'

/** furthest Tanks+ level index unlocked (0-based) */
export function plusProgress(): number {
  return Math.max(0, Number(localStorage.getItem(KEY) ?? 0) || 0)
}

function saveProgress(level: number) {
  if (level > plusProgress()) localStorage.setItem(KEY, String(Math.min(level, tanksPlus.levels.length - 1)))
}

let tracking = false

class TanksPlusScreen extends WebScreen {
  private world = 0
  private players = 1

  protected build(root: HTMLElement) {
    this.trackProgress()
    const reached = plusProgress()
    this.world = Math.max(0, TANKS_PLUS_WORLDS.findIndex((w) => reached >= w.first && reached < w.first + w.count))
    this.render(root)
  }

  /** reaching level N of the pack unlocks it (the game manager loads the next stage on a clear) */
  private trackProgress() {
    if (tracking) return
    tracking = true
    const game = this.app.game
    setInterval(() => {
      if (game.pack?.id === 'tanksplus' && game.state >= 1 && game.state <= 7) saveProgress(game.stage)
    }, 1000)
  }

  private render(root = this.root) {
    root.replaceChildren()
    const reached = plusProgress()
    const w = TANKS_PLUS_WORLDS[this.world]
    root.append(
      h(
        'div.panel.tanksplus',
        null,
        h('div.panel-head', null, backButton(() => this.back()), band('Tanks+')),
        h(
          'div.tp-tabs',
          null,
          ...TANKS_PLUS_WORLDS.map((wd, i) =>
            button(`${i + 1}. ${wd.name}`, {
              class: i === this.world ? 'primary' : '',
              disabled: wd.first > reached,
              onclick: () => {
                this.world = i
                this.render()
              },
            }),
          ),
        ),
        h(
          'div.tp-players',
          null,
          h('span', null, 'Players'),
          ...[1, 2, 3, 4].map((n) =>
            button(String(n), {
              class: n === this.players ? 'primary' : '',
              onclick: () => {
                this.players = n
                this.render()
              },
            }),
          ),
          this.medal(),
        ),
        h(
          'div.panel-scroll.tp-levels',
          null,
          ...Array.from({ length: w.count }, (_, k) => {
            const i = w.first + k
            const lvl = tanksPlus.levels[i]
            const locked = i > reached
            const boss = (i + 1) % 10 === 0
            return button(`${i + 1}. ${lvl.name}`, {
              hint: locked ? 'Locked' : boss ? 'Boss' : lvl.bonus ? 'Bonus life' : undefined,
              icon: locked ? 'lock' : 'play',
              class: boss ? 'tp-boss' : '',
              disabled: locked,
              autofocus: i === Math.min(reached, w.first + w.count - 1),
              onclick: () => this.app.playPack(tanksPlus, this.players, i),
            })
          }),
        ),
        h('div.foot-hint', null, 'Clear a level to unlock the next. More players: keyboard + mouse and gamepads.'),
      ),
    )
    requestAnimationFrame(() => this.nav?.focus())
  }

  /** the pack medal won so far and what the next one asks for */
  private medal() {
    const r = loadPackRecord('tanksplus')
    const n = tanksPlus.levels.length
    return h(
      'div.tp-medal',
      null,
      medalIcon(r.medal),
      h('span', null, h('b', null, r.medal ? `${MEDALS[r.medal - 1].name} medal` : 'No medal yet'), h('small', null, r.medal < 4 ? `${MEDALS[r.medal].name}: ${packMedalRule(n, r.medal + 1)}` : 'The highest medal!')),
    )
  }

  protected back() {
    this.app.show('menu')
  }
}

registerScreen('tanksplus', () => new TanksPlusScreen())
