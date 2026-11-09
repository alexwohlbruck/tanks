// Server presenter: the game flow runs against HeadlessPresenter's layout timings, and every
// layout call is recorded so the clients can replay it on their real layouts (['u', ...]).
// The result screens (result list, medal, VS winner) wait for the host's client to report
// that its screen finished (C2S 'gate'), with a timeout so a missing host cannot stall a room.

import type { Game } from '../../src/game'
import type { Gate, NetEvent } from '../../src/net/protocol'
import { HeadlessPresenter, type Presenter } from '../../src/sim/presenter'

/** frames to wait for a gate before going on without it */
const GATE_TIMEOUT = 20 * 60

/** layout SEs are played by the clients' layouts themselves; the timing model must not emit them */
const MUTE = { se() {} } as unknown as Game

export class ServerPresenter implements Presenter {
  private h = new HeadlessPresenter()
  /** recorded calls since the last drain */
  calls: NetEvent[] = []
  private gates = new Set<Gate>()
  private waiting: { gate: Gate; frames: number } | null = null

  constructor() {
    this.h.menuAnswer = -1
  }

  private rec(name: string, ...args: (number | boolean | { x: number; z: number })[]) {
    this.calls.push(['u', name, ...args.map((a) => (typeof a === 'boolean' ? (a ? 1 : 0) : typeof a === 'object' ? { x: round(a.x), z: round(a.z) } : a))])
  }

  /** a client's result screen finished */
  gate(g: Gate) {
    this.gates.add(g)
  }
  private wait(g: Gate) {
    if (this.gates.has(g)) {
      this.gates.delete(g)
      this.waiting = null
      return true
    }
    if (!this.waiting || this.waiting.gate !== g) this.waiting = { gate: g, frames: 0 }
    if (++this.waiting.frames >= GATE_TIMEOUT) {
      this.waiting = null
      return true
    }
    return false
  }

  reset() {
    this.h.reset()
    this.gates.clear()
    this.waiting = null
    this.lastEx = -1
    this.rec('reset')
  }

  fadeStart(bonus: boolean, fast: boolean) {
    this.h.fadeStart(bonus, fast)
    this.rec('fadeStart', bonus, fast)
  }
  fadeStageReady() {
    return this.h.fadeStageReady()
  }
  fadeBonusLife() {
    return this.h.fadeBonusLife()
  }
  fadeJingle() {
    return this.h.fadeJingle()
  }
  fadeStageBgm() {
    return this.h.fadeStageBgm()
  }
  fadeDone() {
    return this.h.fadeDone()
  }
  hudIn() {
    this.rec('hudIn')
  }
  hudOut() {
    this.rec('hudOut')
  }
  hudScore(p: number) {
    this.rec('hudScore', p)
  }
  setBalloons(on: boolean) {
    this.rec('setBalloons', on)
  }
  startMsgPlay() {
    this.rec('startMsgPlay')
  }
  clearMsgShow() {
    this.h.clearMsgShow()
    this.rec('clearMsgShow')
  }
  clearMsgActive() {
    return this.h.clearMsgActive()
  }
  clearMsgHide() {
    this.h.clearMsgHide()
    this.rec('clearMsgHide')
  }
  failedMsgShow() {
    this.h.failedMsgShow()
    this.rec('failedMsgShow')
  }
  failedMsgActive() {
    return this.h.failedMsgActive()
  }
  completeMsgShow() {
    this.h.completeMsgShow()
    this.rec('completeMsgShow')
  }
  completeMsgActive() {
    return this.h.completeMsgActive()
  }
  exGuideStart() {
    this.rec('exGuideStart')
  }
  exGuideStop() {
    this.lastEx = -1
    this.rec('exGuideStop')
  }
  private lastEx = -1
  /** called every frame while shown; RPTnkExMsg::Show only acts on a change */
  exMsgShow(m: number) {
    if (m !== this.lastEx) this.rec('exMsgShow', m)
    this.lastEx = m
  }
  exMsgOutAll() {
    this.lastEx = -1
    this.rec('exMsgOutAll')
  }
  resultStart() {
    this.h.resultStart()
    this.rec('resultStart')
  }
  resultDone() {
    return this.h.resultDone() && this.wait('result')
  }
  resultShowTotals() {
    this.rec('resultShowTotals')
  }
  hitPopup(pos: { x: number; z: number }, player: number) {
    this.rec('hitPopup', pos, player)
  }
  medalStart(kills: number) {
    this.h.medalStart()
    this.rec('medalStart', kills)
  }
  medalDone() {
    return this.wait('medal')
  }
  winnerStart(winner: number) {
    this.h.winnerStart()
    this.rec('winnerStart', winner)
  }
  winnerDone() {
    return this.wait('winner')
  }
  winnerTotals() {
    return this.gates.has('totals') ? (this.gates.delete('totals'), true) : false
  }
  /** the room decides what happens after a game (host's 'end' message), never the layout */
  menuStart() {}
  menuChoice(): -1 | 0 | 1 {
    return -1
  }

  tick(_game: Game) {
    this.h.tick(MUTE)
  }

  drain() {
    const c = this.calls
    this.calls = []
    return c
  }
}

export const round = (v: number) => Math.round(v * 10) / 10
