// What a room runs while a game is on. Both runners own a World the room snapshots:
//   CoopRunner   the original game flow (src/game.ts) with the ServerPresenter: the classic
//                campaign or a custom LevelPack, 1-4 players on the 2P rules
//   VersusRunner free-for-all rounds on the versus arenas (src/net/arenas.ts), optional AI tanks;
//                the last tank standing wins the round, first to `rounds` wins the match

import { Game, type Phase } from '../../src/game'
import type { GameData } from '../../src/data'
import type { LevelPack } from '../../src/levels/format'
import { arenaCells } from '../../src/net/arenas'
import type { Gate, Meta, Mode, NetEvent, VersusInfo } from '../../src/net/protocol'
import { BgmMix } from '../../src/sim/bgm'
import { MAX_PLAYERS } from '../../src/sim/consts'
import { RPRandom } from '../../src/sim/rng'
import { World, type SimEvent } from '../../src/sim/world'
import { ServerPresenter } from './presenter'

export interface RunnerHost {
  /** a stage was (re)loaded into `w` (or `w` is a new World) */
  stage(w: World): void
  /** the frame's simulation events */
  events(ev: SimEvent[], w: World): void
}

export interface Runner {
  readonly mode: Mode
  readonly world: World | null
  /** player tanks in the game (players 0..n-1) */
  readonly players: number
  /** one 60 Hz frame; `apply` fills the player intents */
  tick(apply: (w: World) => void): void
  meta(): Meta
  /** the game is over (waiting for the host to play again or go back to the room) */
  ended(): boolean
  /** recorded layout calls since the last drain */
  uiCalls(): NetEvent[]
  gate(g: Gate): void
  /** players joined: take them in at the next safe point (next mission / round) */
  grow(players: number): void
}

const kt = (byType: number[][], players: number) => {
  const out: [number, number, number][] = []
  for (let p = 0; p < Math.min(MAX_PLAYERS, Math.max(2, players)); p++) byType[p].forEach((n, type) => n && out.push([p, type, n]))
  return out
}

export class CoopRunner implements Runner {
  readonly mode: Mode
  game = new Game()
  presenter = new ServerPresenter()
  private want = 0

  constructor(data: GameData, players: number, opts: { mission: number; allMissions: boolean; pack: LevelPack | null }, host: RunnerHost) {
    this.mode = opts.pack ? 'pack' : 'coop'
    const g = this.game
    g.data = data
    g.options = { goldMedal: false, unlockAll: opts.allMissions }
    g.presenter = this.presenter
    g.listener = {
      onWorld: (w) => host.stage(w),
      onEvents: (ev, w) => host.events(ev, w),
      onPhase: (p: Phase) => {
        if (p === 'next') this.applyGrow()
      },
    }
    g.newGame(players, opts.mission, undefined, opts.pack)
  }

  get world() {
    return this.game.world
  }
  get players() {
    return this.game.players
  }

  tick(apply: (w: World) => void) {
    this.game.tick(apply)
  }

  grow(players: number) {
    this.want = Math.max(this.want, Math.min(MAX_PLAYERS, players))
  }

  /** between missions (the fade card is up, the stage loads next): add the waiting players */
  private applyGrow() {
    const g = this.game
    const w = g.world
    if (!w || this.want <= g.players) return
    const n = this.want
    for (let i = g.players; i < n; i++) g.stats.lives[i] = Math.max(1, g.stats.lives[0])
    g.players = n
    w.players = n
    w.twoPlayerMode = n >= 2
    g.stats.players = Math.max(2, n)
  }

  meta(): Meta {
    const g = this.game
    return {
      mode: this.mode,
      st: g.state,
      stage: g.stage,
      last: g.lastStage,
      players: g.players,
      lives: g.stats.lives.slice(0, MAX_PLAYERS),
      kills: g.stats.kills.slice(0, MAX_PLAYERS),
      kt: kt(g.stats.killsByType, g.players),
      order: g.stats.typeOrder.slice(),
      freeze: g.freeze,
      enemies: g.world?.enemyAliveNum ?? 0,
    }
  }

  ended() {
    return this.game.state === 12 || this.game.state === 0
  }
  uiCalls() {
    return this.presenter.drain()
  }
  gate(g: Gate) {
    this.presenter.gate(g)
  }
}

/** AI tank types a versus round draws from (Brown, Ash, Marine, Pink, Green) */
const AI_TYPES = [1, 2, 3, 4, 7]
const VS = { start: 150, over: 90, result: 240 }

export class VersusRunner implements Runner {
  readonly mode: Mode = 'versus'
  world: World | null = null
  players: number
  private want: number
  private rng = new RPRandom((Math.random() * 2 ** 32) >>> 0)
  private ev: SimEvent[] = []
  private calls: NetEvent[] = []
  private bgm = new BgmMix({
    bgm: (name) => this.ev.push({ t: 'bgm', name }),
    bgmStop: (fade) => this.ev.push({ t: 'bgmStop', fade }),
    mask: (mask) => this.ev.push({ t: 'bgmMask', mask }),
  })
  private phase: VersusInfo['phase'] = 'start'
  private timer = 0
  private round = 0
  private winner = -1
  private scores = [0, 0, 0, 0]
  private frags = [0, 0, 0, 0]
  private target: number
  private ai: number
  private arena: number
  private stepCount = 0

  constructor(players: number, opts: { rounds: number; ai: number; arena: number }, private host: RunnerHost) {
    this.players = this.want = players
    this.target = Math.max(1, Math.min(9, opts.rounds | 0))
    // a lone player needs someone to fight
    this.ai = Math.max(players === 1 ? 1 : 0, Math.min(4, opts.ai | 0))
    this.arena = opts.arena | 0
    this.calls.push(['u', 'reset'])
    this.startRound()
  }

  grow(players: number) {
    this.want = Math.max(this.want, Math.min(MAX_PLAYERS, players))
  }

  private startRound() {
    this.players = Math.max(this.players, this.want)
    this.round++
    const w = new World(this.players, { rng: this.rng, enemyCap: 8 })
    w.hooks = {
      addKill: (p) => this.frags[p]++,
      enemySpawned() {},
      enemyDestroyed() {},
    }
    const { cells, slots } = arenaCells(this.arena, this.ai)
    const types = Array.from({ length: slots }, () => AI_TYPES[this.rng.next() % AI_TYPES.length])
    w.loadStage({ width: 22, height: 17, cells, facing: [0, 0] }, types, { swap: false })
    this.world = w
    this.stepCount = 0
    this.phase = 'start'
    this.timer = VS.start
    this.winner = -1
    this.host.stage(w)
  }

  private alivePlayers() {
    const w = this.world!
    const out: number[] = []
    for (let i = 0; i < this.players; i++) if (w.playerTanks[i].alive) out.push(i)
    return out
  }

  tick(apply: (w: World) => void) {
    const w = this.world!
    let next = false
    apply(w)
    w.countPools()
    const frozen = this.phase === 'result' || this.phase === 'end'
    if (!frozen) {
      w.physics()
      this.stepCount++
    }
    switch (this.phase) {
      case 'start':
        if (--this.timer <= 0) {
          w.activatePlayers()
          w.activateEnemies()
          this.calls.push(['u', 'startMsgPlay'])
          this.bgm.startStageBgm(Math.min(20, 4 + this.round), w.enemyAliveNum, w.maxActiveEnemyType())
          this.phase = 'play'
        }
        break
      case 'play': {
        const alive = this.alivePlayers()
        const over = this.players >= 2 ? alive.length <= 1 : alive.length === 0 || w.enemyAliveNum === 0
        if (over) {
          this.phase = 'over'
          this.timer = VS.over
        }
        break
      }
      case 'over':
        // a short grace period: shells and mines already on their way still count
        if (--this.timer <= 0) {
          const alive = this.alivePlayers()
          this.winner = this.players >= 2 ? (alive.length === 1 ? alive[0] : -1) : alive.length === 1 && w.enemyAliveNum === 0 ? 0 : -1
          if (this.winner >= 0) this.scores[this.winner]++
          w.shellPool.stopAllEffects()
          this.bgm.stop()
          if (this.winner >= 0) this.bgm.playStageClearBgm()
          else this.ev.push({ t: 'bgm', name: 'RP_TNK_BGM_MISS' })
          this.phase = 'result'
          this.timer = VS.result
        }
        break
      case 'result':
        if (--this.timer <= 0) {
          const best = Math.max(...this.scores)
          if (best >= this.target) {
            this.phase = 'end'
            this.winner = this.scores.indexOf(best)
            this.ev.push({ t: 'bgm', name: 'RP_TNK_BGM_COMP20' })
          } else next = true
        }
        break
    }
    if (this.phase === 'play') this.bgm.setParams(w.enemyAliveNum, w.maxActiveEnemyType())
    // frags: player tanks destroyed by another player's weapon (hit id = player + 1)
    for (const e of w.events)
      if (e.t === 'tankDie' && !e.tank.isEnemy && e.by >= 1 && e.by <= MAX_PLAYERS && e.by - 1 !== e.tank.index) this.frags[e.by - 1]++
    if (this.stepCount >= 10) w.drawTreadMarks()
    const ev = [...this.ev, ...w.events]
    this.ev = []
    w.events = []
    this.host.events(ev, w)
    if (next) this.startRound()
  }

  meta(): Meta {
    const w = this.world
    const vs: VersusInfo = { round: this.round, target: this.target, scores: this.scores.slice(), frags: this.frags.slice(), phase: this.phase, winner: this.winner }
    return {
      mode: 'versus',
      st: this.phase === 'start' ? 2 : this.phase === 'end' ? 12 : 4,
      stage: this.round,
      last: 99,
      players: this.players,
      lives: [1, 1, 1, 1],
      kills: this.frags.slice(),
      kt: [],
      order: [],
      freeze: this.phase === 'result' || this.phase === 'end',
      enemies: w?.enemyAliveNum ?? 0,
      vs,
    }
  }

  ended() {
    return this.phase === 'end'
  }
  uiCalls() {
    const c = this.calls
    this.calls = []
    return c
  }
  gate() {}
}
