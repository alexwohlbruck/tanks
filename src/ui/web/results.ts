// 'results': the end-of-run summary that replaces Wii Play's medal / VS winner / result menu
// screens in the modern UI. Opened by the game manager's result flow (UiPresenter.web,
// params.players); answers through App.resultChoice (0 play again, 1 menu).
//
// 1P classic campaign: the medal per the original thresholds (TANKS_MEDALS: 11 / 32 / 84 / 125
// tanks; a medal is awarded when it beats the saved one) and the five-entry "My Record" list,
// saved with Wii Play's own data (src/ui/shared/save.ts). 2P: winner and the session's win tally.

import { registerScreen } from '../../app/router'
import type { Game } from '../../game'
import { TANKS_MEDALS } from '../shared/medalResult'
import { loadPlayerData, savePlayerData, vsSession } from '../shared/save'
import { medalIcon, MEDALS, PLAYER_COLORS, tankIcon, tankStyle } from './art'
import { band, button, WebScreen } from './base'
import { h } from './dom'

export type RunRecord = {
  score: number
  /** the medal this score reaches (0-4) */
  reached: number
  /** a better medal than the saved one (0 when none) */
  newMedal: number
  /** the best medal saved after this run */
  best: number
  /** index of the score in the new top five, -1 when it did not make it */
  rank: number
  records: number[]
}

/** RPMedalResult: insert the score into "My Record", award a better medal, save both */
export function recordRun(score: number): RunRecord {
  const d = loadPlayerData()
  let rank = -1
  for (let i = 0; i < 5; i++)
    if (score > d.records[i]) {
      rank = i
      break
    }
  const records = d.records.slice()
  if (rank >= 0) {
    for (let i = 4; i > rank; i--) records[i] = records[i - 1]
    records[rank] = score
  }
  let reached = 0
  for (let m = 4; m >= 1; m--)
    if (score >= TANKS_MEDALS[m - 1]) {
      reached = m
      break
    }
  const newMedal = reached > d.medal ? reached : 0
  savePlayerData({ medal: Math.max(d.medal, reached), records })
  return { score, reached, newMedal, best: Math.max(d.medal, reached), rank, records }
}

/** RPResultMenu: the 2P session tally (wins capped at 99, streak -3..3) */
function tallyVs(winner: number) {
  const S = vsSession
  if (winner === 0) S.streak = Math.max(-3, Math.min(3, S.streak + 1))
  if (winner === 1) S.streak = Math.max(-3, Math.min(3, S.streak - 1))
  if (winner === 0 || winner === 1) if (S.wins[winner] < 99) S.wins[winner]++
}

class ResultsScreen extends WebScreen {
  /** the game keeps running (StateResultMenu / StateEndMenu wait for the choice) */
  readonly modal = false
  private chosen = false

  protected build(root: HTMLElement) {
    const g = this.app.game
    const players = Math.max(1, Math.min(4, Number(this.params.players) || g.players))
    const failed = g.nextAction === 4
    const classic = !g.pack
    const stats = g.stats
    const reachedText = classic ? `Mission ${g.stage + 1}` : `${g.pack!.name} · level ${g.stage + 1}`
    const title = failed ? 'Game over' : classic ? 'Campaign complete!' : 'All levels cleared!'
    const right: (Node | null)[] = []
    if (players === 1 && classic) {
      const r = recordRun(stats.kills[0])
      g.options.goldMedal = r.best >= 3 || new URLSearchParams(location.search).has('gold')
      if (r.newMedal) this.app.audio.playMusic(['RP_COM_BGM_GET_COPPER', 'RP_COM_BGM_GET_SILVER', 'RP_COM_BGM_GET_GOLD', 'RP_COM_BGM_GET_PLATINA'][r.newMedal - 1])
      else if (r.rank >= 0) this.app.audio.play('RP_COM_BGM_RENEW_RECORD')
      const next = TANKS_MEDALS.find((t) => t > r.score)
      right.push(
        h(
          'div.medal-box',
          { class: r.newMedal ? 'new' : '' },
          medalIcon(r.reached, 'medal-icon big'),
          h(
            'div.medal-text',
            null,
            r.newMedal ? h('div.flag', null, 'New medal!') : null,
            h('div.medal-name', null, r.reached ? `${MEDALS[r.reached - 1].name} medal` : 'No medal yet'),
            h('small', null, next ? `${next - r.score} more tank${next - r.score === 1 ? '' : 's'} for ${MEDALS[TANKS_MEDALS.indexOf(next)].name}` : 'The highest medal!'),
          ),
        ),
        h(
          'div.records',
          null,
          h('div.records-head', null, 'My record'),
          h(
            'ol',
            null,
            ...r.records.map((v, i) =>
              h('li', { class: i === r.rank ? 'new' : '', style: `--i:${i}` }, h('span.rank', null, `${i + 1}`), h('b', null, String(v)), h('span', null, v === 1 ? 'tank' : 'tanks'), i === r.rank ? h('span.flag', null, 'New!') : null),
            ),
          ),
        ),
      )
    } else if (players >= 2) {
      const w = g.winner()
      if (players === 2) tallyVs(w)
      right.push(
        h(
          'div.winner',
          null,
          w >= 0 ? tankIcon(PLAYER_COLORS[w].body, PLAYER_COLORS[w].dark, 'tank-icon big') : null,
          h('div.winner-name', null, w >= 0 ? `Player ${w + 1} wins!` : "It's a tie!"),
          players === 2 ? h('div.tally', null, h('span.p1', null, String(vsSession.wins[0])), h('small', null, 'wins'), h('span.p2', null, String(vsSession.wins[1]))) : null,
        ),
      )
    }
    root.append(
      h(
        'div.results-screen',
        null,
        h(
          'div.panel.results',
          null,
          band(title, failed ? 'dark' : ''),
          h('div.results-sub', null, `Reached ${reachedText}`),
          h('div.results-body', null, this.killTable(g, players), right.length ? h('div.results-side', null, ...right) : null),
          h(
            'div.results-actions',
            null,
            button('Play again', { icon: 'restart', class: 'primary', autofocus: true, onclick: () => this.choose(0) }),
            button('Main menu', { icon: 'home', onclick: () => this.choose(1) }),
          ),
        ),
      ),
    )
  }

  /** tanks destroyed by type (in first-seen order) per player, and the totals */
  private killTable(g: Game, players: number) {
    const s = g.stats
    const types = s.typeOrder.filter((t) => [0, 1, 2, 3].some((p) => (s.killsByType[p]?.[t] ?? 0) > 0))
    const cols = Array.from({ length: players }, (_, p) => p)
    return h(
      'div.kills',
      { style: `--cols:${players}` },
      h('div.kills-head', null, h('span', null, 'Tanks destroyed'), ...(players > 1 ? cols.map((p) => h('span.pcol', { style: `color:${PLAYER_COLORS[p].body}` }, `P${p + 1}`)) : [])),
      h(
        'div.kills-rows',
        null,
        types.length
          ? types.map((t, i) => {
              const st = tankStyle(t)
              return h(
                'div.kill-row',
                { style: `--i:${i}` },
                tankIcon(st.body, st.dark),
                h('span.kname', null, st.name),
                ...cols.map((p) => h('b.pcol', null, String(s.killsByType[p]?.[t] ?? 0))),
              )
            })
          : h('div.kill-row.empty', null, 'No tanks destroyed'),
      ),
      h('div.kill-total', null, h('span', null, 'Total'), ...cols.map((p) => h('b.pcol', null, String(s.kills[p] ?? 0)))),
    )
  }

  private choose(c: 0 | 1) {
    if (this.chosen) return
    this.chosen = true
    this.app.audio.stopMusic(0.3)
    this.app.resultChoice(c)
  }

  protected back() {
    this.choose(1)
  }
}

registerScreen('results', () => new ResultsScreen())
