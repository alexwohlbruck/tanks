// 'pause': the in-game pause overlay (Continue / Restart / Settings / Quit). Esc, P and Start
// close it again. The App pauses the game and its music before showing it.

import { registerScreen } from '../../app/router'
import { tankIcon, PLAYER_COLORS } from './art'
import { band, button, WebScreen } from './base'
import { h } from './dom'

class PauseScreen extends WebScreen {
  private onKey = (e: KeyboardEvent) => {
    // the pause keys toggle (Escape is also "back")
    if (!e.repeat && (e.code === 'KeyP' || e.code === 'Pause')) {
      e.preventDefault()
      this.back()
    }
  }

  protected build(root: HTMLElement) {
    const g = this.app.game
    const custom = !!g.pack
    const mission = g.stage + 1
    const players = Math.max(1, g.players)
    root.append(
      h(
        'div.pause-screen',
        null,
        h(
          'div.panel.pause',
          null,
          band('Paused'),
          h(
            'div.pause-info',
            null,
            h('div.pause-mission', null, h('small', null, custom ? 'Level' : 'Mission'), h('b', null, String(mission))),
            h(
              'div.pause-players',
              null,
              ...Array.from({ length: players }, (_, p) =>
                h(
                  'div.pause-player',
                  null,
                  tankIcon(PLAYER_COLORS[p].body, PLAYER_COLORS[p].dark),
                  h('span', null, `×${g.livesOf(p as 0 | 1)}`),
                  h('small', null, `${g.stats.kills[p] ?? 0} destroyed`),
                ),
              ),
            ),
          ),
          h(
            'div.pause-actions',
            null,
            button('Continue', { icon: 'play', class: 'primary', autofocus: true, onclick: () => this.back() }),
            button('Restart', { icon: 'restart', onclick: () => this.app.restart() }),
            button('Settings', { icon: 'settings', onclick: () => this.app.show('settings', { from: 'pause' }) }),
            button('Quit to menu', { icon: 'home', onclick: () => this.app.toMenu() }),
          ),
        ),
      ),
    )
    addEventListener('keydown', this.onKey)
  }

  unmount() {
    removeEventListener('keydown', this.onKey)
    super.unmount()
  }

  protected back() {
    this.app.audio.play('RP_COM_GAME_SE_PAUSE_KEY_A_01_TVSP')
    this.app.resume()
  }

  protected start() {
    this.back()
  }
}

registerScreen('pause', () => new PauseScreen())
