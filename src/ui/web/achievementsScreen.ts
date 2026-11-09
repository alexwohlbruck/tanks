// 'achievements': the medals (classic, Tanks+) and every achievement by mode, with progress
// for the counted ones. params.from: 'campaign' returns to the Campaign page.

import { registerScreen } from '../../app/router'
import { tanksPlus } from '../../levels/packs'
import { ACHIEVEMENTS, collected, goalOf, GROUPS, isUnlocked, progressOf, unlockedAt, unlockedCount, type Achievement } from '../shared/achievements'
import { loadPackRecord, loadPlayerData } from '../shared/save'
import { icon, medalIcon, MEDALS, tankIcon, tankStyle } from './art'
import { backButton, band, WebScreen } from './base'
import { h } from './dom'
import './achievements.css'

class AchievementsScreen extends WebScreen {
  protected build(root: HTMLElement) {
    const total = ACHIEVEMENTS.length
    const got = unlockedCount()
    const classic = loadPlayerData().medal
    const plus = loadPackRecord('tanksplus')
    const medal = (m: number, label: string) => h('div.ach-medal', null, medalIcon(m), h('span', null, h('small', null, label), h('b', null, m ? MEDALS[m - 1].name : 'None yet')))
    root.append(
      h(
        'div.achievements-screen',
        null,
        h(
          'div.panel.achievements',
          null,
          h('div.panel-head', null, backButton(() => this.back()), band('Achievements')),
          h(
            'div.ach-summary',
            null,
            h('div.ach-count', null, h('b', null, String(got)), h('span', null, `of ${total} unlocked`), bar(got, total)),
            medal(classic, 'Classic medal'),
            medal(plus.medal, 'Tanks+ medal'),
          ),
          h(
            'div.panel-scroll.ach-list',
            null,
            ...GROUPS.map((g) => {
              const list = ACHIEVEMENTS.filter((a) => a.group === g.id)
              const n = list.filter((a) => isUnlocked(a.id)).length
              return h(
                'section.ach-group',
                null,
                h('h3', null, g.name, h('span', null, `${n} / ${list.length}`)),
                h('div.ach-grid', null, ...list.map((a, i) => card(a, i))),
              )
            }),
            h('div.foot-hint', null, `Tanks+ medals: ${plus.cleared} of ${tanksPlus.levels.length} levels cleared so far.`),
          ),
        ),
      ),
    )
  }

  protected back() {
    this.app.show('menu', this.params.from === 'campaign' ? { page: 'campaign' } : undefined)
  }
}

function bar(v: number, max: number) {
  return h('div.ach-bar', null, h('i', { style: `width:${Math.round((100 * Math.min(v, max)) / Math.max(1, max))}%` }))
}

function card(a: Achievement, i: number) {
  const on = isUnlocked(a.id)
  const goal = goalOf(a)
  const st = tankStyle(a.tank ?? 0)
  const at = unlockedAt(a.id)
  return h(
    'div.ach',
    { class: on ? 'on' : '', 'data-nav': '', tabindex: 0, style: `--i:${i}`, title: on && at > 1 ? `Unlocked ${new Date(at).toLocaleDateString()}` : undefined },
    h('div.ach-badge', { class: on ? 'on' : '' }, icon(on ? 'trophy' : 'lock')),
    h(
      'div.ach-text',
      null,
      h('b', null, a.name),
      h('span', null, a.desc),
      goal && !on ? h('div.ach-prog', null, bar(progressOf(a.id), goal), h('small', null, `${Math.min(progressOf(a.id), goal)} / ${goal}`)) : null,
      a.keys && !on ? h('div.ach-keys', null, ...a.keys.map((k) => h('span', { class: collected(a.id).includes(k) ? 'got' : '' }, k))) : null,
    ),
    tankIcon(st.body, st.dark),
  )
}

registerScreen('achievements', () => new AchievementsScreen())
