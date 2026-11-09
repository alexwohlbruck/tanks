// Watches local games for achievements and pack medal progress: the game's phases (missions
// cleared, lives lost) and simulation events (kills, ricochets, mines). Observes only; the game
// and the simulation are not changed. Installed once by the App (trackGame), counting only while
// `live()` (local play, not the attract-mode match or online sessions).

import type { Game, Listener } from '../../game'
import type { LevelPack } from '../../levels/format'
import { MAX_PLAYERS } from '../../sim/consts'
import { progress, unlock } from './achievements'
import { loadPackRecord, loadPlayerData, MEDAL_PACKS, savePackRecord } from './save'

/** the run being played (reset when a game starts) */
export type Run = {
  pack: LevelPack | null
  players: number
  /** first mission / level of the run (0-based) */
  start: number
  /** furthest mission / level cleared (0-based), -1 none */
  cleared: number
  /** the last mission / level was cleared */
  complete: boolean
  /** lives lost (all players down, or the game over) */
  lost: number
}

let run: Run | null = null

/** the current (or just finished) run */
export function currentRun() {
  return run
}

/** Black tank (art.ts TANK_TYPES) */
const BLACK = 9

export function trackGame(game: Game, live: () => boolean) {
  // medals won before achievements existed
  const pd = loadPlayerData()
  if (pd.medal >= 3) unlock('classic-gold')
  if (pd.medal >= 4) unlock('classic-platinum')
  for (const id of MEDAL_PACKS) if (loadPackRecord(id).medal >= 4) unlock('tp-platinum')

  const prev: Listener = game.listener ?? { onWorld() {}, onEvents() {}, onPhase() {} }
  /** ids of player shells that have bounced */
  const bounced = new Set<number>()
  /** recent mine kills per player (frame numbers) */
  const mineKills: number[][] = Array.from({ length: MAX_PLAYERS }, () => [])
  let frame = 0
  game.listener = {
    onWorld(w) {
      bounced.clear()
      prev.onWorld(w)
    },
    onEvents(ev, w) {
      prev.onEvents(ev, w)
      frame++
      if (!live()) return
      for (const e of ev) {
        if (e.t === 'ricochet' && !e.bullet.isEnemy) {
          bounced.add(e.bullet.id)
          if (bounced.size > 256) bounced.delete(bounced.values().next().value!)
        } else if (e.t === 'tankDie' && e.tank.isEnemy && e.killer !== null) {
          progress('tanks-1000')
          if (e.tank.enemyType === BLACK) progress('black-100')
          // the player's own weapon (in 1P enemy-on-enemy kills are credited to P1 too)
          const own = e.by >= 1 && e.by <= MAX_PLAYERS
          if (!own) continue
          if (e.cause === 'mine') {
            unlock('mine-kill')
            const k = mineKills[e.by - 1]
            k.push(frame)
            while (k.length && frame - k[0] > 40) k.shift()
            if (k.length >= 2) unlock('mine-double')
          } else {
            // the shell that hit dies this frame
            const hit = ev.find((d) => d.t === 'bulletDie' && d.reason === 'tank' && d.bullet.slot === e.by - 1 && bounced.has(d.bullet.id))
            if (hit) unlock('ricochet')
          }
        }
      }
    },
    onPhase(p, g) {
      prev.onPhase(p, g)
      if (!live()) return
      if (p === 'intro') run = { pack: g.pack, players: g.players, start: g.stage, cleared: -1, complete: false, lost: 0 }
      if (!run) return
      if (p === 'dead' || p === 'gameover') run.lost++
      if (p === 'cleared' || p === 'complete') {
        run.cleared = Math.max(run.cleared, g.stage)
        if (p === 'complete') run.complete = true
        onClear(g, run, g.stage, p === 'complete')
      }
    },
  }
}

function onClear(g: Game, r: Run, stage: number, complete: boolean) {
  const pack = g.pack
  if (!pack) {
    if (stage === 0) unlock('classic-first')
    if (stage >= 19) unlock('classic-20')
    if (stage >= 99) unlock('classic-100')
    if (stage >= 9 && g.players === 2) unlock('classic-duo')
    if (stage >= 19 && r.start === 0 && r.lost === 0) unlock('classic-flawless')
    return
  }
  if (MEDAL_PACKS.includes(pack.id ?? '')) {
    const rec = loadPackRecord(pack.id!)
    if (stage + 1 > rec.cleared) savePackRecord(pack.id!, { ...rec, cleared: stage + 1 })
  }
  if (pack.id === 'tanksplus') {
    if ((stage + 1) % 10 === 0 && stage < 40) unlock(`tp-boss-${(stage + 1) / 10}`)
    if (complete) unlock('tp-complete')
  }
}

// ---- pack medals ---------------------------------------------------------------------------

/**
 * The medal a pack run reaches: bronze for clearing a quarter of the levels (Tanks+: the first
 * boss), silver for clearing the last one, gold for every level in one run from level 1,
 * platinum for that without losing a life.
 */
export function packMedal(levels: number, cleared: number, r: Run | null) {
  if (r && r.complete && r.start === 0 && r.lost === 0) return 4
  if (r && r.complete && r.start === 0) return 3
  if (cleared >= levels) return 2
  if (cleared >= Math.ceil(levels / 4)) return 1
  return 0
}

/** what each medal (1-4) asks for */
export function packMedalRule(levels: number, medal: number) {
  return [
    `Clear level ${Math.ceil(levels / 4)}`,
    `Clear all ${levels} levels`,
    `Clear all ${levels} levels in one run from level 1`,
    `All ${levels} levels in one run without losing a life`,
  ][medal - 1]
}

export type PackRunRecord = { reached: number; newMedal: number; best: number; cleared: number }

/** results of a pack run: award a better medal and save it */
export function recordPackRun(pack: LevelPack, r: Run | null): PackRunRecord {
  const id = pack.id!
  const rec = loadPackRecord(id)
  const n = pack.levels.length
  const cleared = Math.max(rec.cleared, r && r.pack === pack ? r.cleared + 1 : 0)
  const reached = packMedal(n, cleared, r && r.pack === pack ? r : null)
  const newMedal = reached > rec.medal ? reached : 0
  const best = Math.max(rec.medal, reached)
  savePackRecord(id, { medal: best, cleared })
  if (id === 'tanksplus' && best >= 4) unlock('tp-platinum')
  return { reached, newMedal, best, cleared }
}
