// 'menu': the main menu over the attract-mode match. Campaign (classic Wii campaign for 1-2
// local players, the Tanks+ campaign when its screen exists), Online, Level Editor, Community
// Levels, Settings, Credits. Entries for screens other modules register ('lobby', 'editor',
// 'store', 'tanksplus') show a "coming soon" state until those screens exist.

import { registerScreen } from '../../app/router'
import { loadPlayerData } from '../shared/save'
import { TANKS_MEDALS } from '../shared/medalResult'
import { logo, medalIcon, MEDALS, tankIcon, PLAYER_COLORS } from './art'
import { backButton, band, button, WebScreen } from './base'
import { h } from './dom'

class MenuScreen extends WebScreen {
  private page: 'main' | 'campaign' = 'main'
  private body!: HTMLElement

  protected build(root: HTMLElement) {
    this.page = this.params.page === 'campaign' ? 'campaign' : 'main'
    this.body = h('div.menu-body')
    root.append(h('div.menu-screen', null, h('div.menu-logo', null, logo()), this.body))
    this.render()
  }

  private open(id: string, params?: Record<string, unknown>) {
    if (this.app.hasScreen(id)) this.app.show(id, params)
  }

  private soon(id: string) {
    return this.app.hasScreen(id) ? undefined : 'Coming soon'
  }

  private render() {
    const b = this.body
    b.replaceChildren()
    if (this.page === 'main') {
      b.append(
        h(
          'div.menu-grid',
          null,
          button('Campaign', { icon: 'campaign', hint: 'Classic Wii missions', class: 'primary big', autofocus: true, onclick: () => this.setPage('campaign') }),
          button('Online', { icon: 'online', hint: 'Play with friends', disabled: !this.app.hasScreen('lobby'), badge: this.soon('lobby'), onclick: () => this.open('lobby') }),
          button('Level Editor', { icon: 'editor', hint: 'Build your own', disabled: !this.app.hasScreen('editor'), badge: this.soon('editor'), onclick: () => this.open('editor') }),
          button('Community Levels', { icon: 'store', hint: 'Play shared levels', disabled: !this.app.hasScreen('store'), badge: this.soon('store'), onclick: () => this.open('store') }),
          h(
            'div.menu-row',
            null,
            button('Settings', { icon: 'settings', class: 'small', onclick: () => this.app.show('settings', { from: 'menu' }) }),
            button('Credits', { icon: 'credits', class: 'small', onclick: () => this.app.show('credits') }),
          ),
        ),
      )
    } else {
      const d = loadPlayerData()
      const best = d.records[0]
      const plus = this.app.hasScreen('tanksplus')
      b.append(
        h(
          'div.panel.campaign',
          null,
          h('div.panel-head', null, backButton(() => this.setPage('main')), band('Campaign')),
          h(
            'div.campaign-cards',
            null,
            h(
              'div.card',
              null,
              h('div.card-title', null, 'Classic'),
              h('div.card-text', null, 'The original 20 missions of Wii Play — 100 once the gold medal is won.'),
              h(
                'div.card-stats',
                null,
                h('div.stat', null, medalIcon(d.medal), h('span', null, d.medal ? `${MEDALS[d.medal - 1].name} medal` : `Medal at ${TANKS_MEDALS[0]} tanks`)),
                h('div.stat', null, h('b', null, String(best)), h('span', null, 'best score')),
              ),
              h(
                'div.card-actions',
                null,
                withTank(button('1 Player', { class: 'primary', autofocus: true, onclick: () => this.app.playClassic(1) }), tankIcon(PLAYER_COLORS[0].body, PLAYER_COLORS[0].dark)),
                withTank(button('2 Players', { onclick: () => this.app.playClassic(2) }), tankIcon(PLAYER_COLORS[1].body, PLAYER_COLORS[1].dark)),
              ),
            ),
            h(
              'div.card',
              { class: plus ? '' : 'locked' },
              h('div.card-title', null, 'Tanks+'),
              h('div.card-text', null, 'New missions, new tanks and new tricks.'),
              h(
                'div.card-actions',
                null,
                button(plus ? 'Play' : 'Coming soon', { icon: plus ? 'play' : 'lock', disabled: !plus, onclick: () => this.open('tanksplus') }),
              ),
            ),
          ),
          h('div.foot-hint', null, '2 players: keyboard + mouse and a gamepad, or two gamepads.'),
        ),
      )
    }
    requestAnimationFrame(() => this.nav?.focus())
  }

  private setPage(p: 'main' | 'campaign') {
    this.page = p
    this.render()
  }

  protected back() {
    if (this.page !== 'main') this.setPage('main')
    else this.app.show('title')
  }
}

/** button() with a tank picture in front of the label */
function withTank(btn: HTMLButtonElement, tank: SVGSVGElement) {
  btn.prepend(tank)
  return btn
}

registerScreen('menu', () => new MenuScreen())
