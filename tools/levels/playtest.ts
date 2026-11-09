// Headless playtest of a level pack (default: Tanks+). For every level:
//   static  validateLevel, registered enemy types, player spawns for 4 players, every enemy
//           reachable by shells and by tank (through open cells, teleporters, breakable /
//           gated walls), spawns not boxed in
//   sim     1P and 4P runs with the aim bot and infinite lives: exceptions, NaN / out-of-field /
//           in-block tanks, deaths in the first 1.5 s of play ("instant deaths"), time to clear
//
//   bun tools/levels/playtest.ts [--frames 7200] [--level N] [--players 1,4] [--quiet]
// Exit code 1 when a level is broken (static errors, exceptions, instant deaths).

import { readFileSync } from 'fs'
import { Game } from '../../src/game'
import { validateLevel, type LevelDef, type LevelPack } from '../../src/levels/format'
import { tanksPlus } from '../../src/levels/packs/index'
import { HeadlessPresenter } from '../../src/sim/presenter'
import { paramsFor, setTankRecords, tankTypes } from '../../src/sim/stats'
import { tileType } from '../../src/sim/tiles'
import type { SimEvent, World } from '../../src/sim/world'
import { aimBot } from './bot'

const root = new URL('../../', import.meta.url).pathname
const params = JSON.parse(readFileSync(root + 'public/assets/data/params.json', 'utf8'))
const maps = JSON.parse(readFileSync(root + 'public/assets/data/maps.json', 'utf8'))
const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k)
  return i >= 0 ? process.argv[i + 1] : d
}
const FRAMES = +arg('--frames', '7200')
const ONLY = process.argv.includes('--level') ? +arg('--level', '1') - 1 : -1
const PLAYERS = arg('--players', '1,4').split(',').map(Number)
const QUIET = process.argv.includes('--quiet')
const EVENTS = process.argv.includes('--events')
setTankRecords(params.tanks)

const pack: LevelPack = tanksPlus
const names = new Map(tankTypes().map((t) => [t.id, t.name]))
let broken = 0

// ---- static checks --------------------------------------------------------------------------

function staticCheck(l: LevelDef): { errors: string[]; warnings: string[] } {
  const errors = validateLevel(l)
  const warnings: string[] = []
  const flat = l.cells.flat()
  for (const [i, e] of l.enemies.entries()) {
    const types = Array.isArray(e) ? [e[0], e[1]] : [e]
    for (const t of types) {
      if (!t) continue
      try {
        paramsFor(t)
      } catch {
        errors.push(`slot ${i}: unknown tank type ${t}`)
      }
    }
    if (e && !flat.includes(400 + i)) warnings.push(`slot ${i} has a type but no spawn cell`)
  }
  for (const c of flat) if (c >= 500 && c <= 599 && !tileType(c)) errors.push(`unknown tile code ${c}`)
  const players = [300, 301, 302, 303].filter((c) => flat.includes(c)).length
  if (players < 4) warnings.push(`${players}/4 player spawns (the rest are placed next to P1/P2)`)
  // reachability: cells by what can pass
  const H = l.cells.length
  const W = l.cells[0].length
  const solidForTank = (c: number) => (c >= 100 && c <= 207) || c === 530 || c === 550 || (c >= 560 && c <= 567)
  // shells: blocks taller than a hole stop them; glass / crates / gates can be opened
  const solidForShell = (c: number) => (c >= 100 && c <= 107) || (c >= 201 && c <= 207) || c === 530 || (c >= 560 && c <= 567)
  const find = (code: number) => {
    const out: [number, number][] = []
    l.cells.forEach((row, r) => row.forEach((c, x) => c === code && out.push([x, r])))
    return out
  }
  const flood = (solid: (c: number) => boolean, tele: boolean) => {
    const seen = new Set<number>()
    const start = find(300)[0]
    if (!start) return seen
    const q = [start]
    seen.add(start[1] * W + start[0])
    while (q.length) {
      const [c, r] = q.shift()!
      const next: [number, number][] = [
        [c + 1, r],
        [c - 1, r],
        [c, r + 1],
        [c, r - 1],
      ]
      const code = l.cells[r][c]
      if (tele && code >= 500 && code <= 503) next.push(...find(code))
      for (const [nc, nr] of next) {
        if (nc < 0 || nr < 0 || nc >= W || nr >= H) continue
        const k = nr * W + nc
        if (seen.has(k) || solid(l.cells[nr][nc])) continue
        seen.add(k)
        q.push([nc, nr])
      }
    }
    return seen
  }
  // tanks may also break glass / crates and open gates, so they count as open for driving
  const tankReach = flood((c) => solidForTank(c), true)
  const shellReach = flood(solidForShell, true)
  for (let i = 0; i < 12; i++)
    for (const [c, r] of find(400 + i)) {
      const k = r * W + c
      if (!shellReach.has(k) && !tankReach.has(k)) errors.push(`enemy ${String.fromCharCode(97 + i)} at ${c},${r} cannot be reached by shells or tanks`)
      else if (!tankReach.has(k) && paramsFor(+(l.enemies[i] as number) || 1).speed > 0) warnings.push(`mobile enemy ${String.fromCharCode(97 + i)} is walled off from the players`)
    }
  for (const code of [301, 302, 303])
    for (const [c, r] of find(code)) if (!tankReach.has(r * W + c)) warnings.push(`player ${code - 299} spawn is cut off from player 1`)
  // boxed-in spawns: every neighbour solid
  for (const code of [300, 301, 302, 303, ...Array.from({ length: 12 }, (_, i) => 400 + i)])
    for (const [c, r] of find(code)) {
      const open = [
        [c + 1, r],
        [c - 1, r],
        [c, r + 1],
        [c, r - 1],
      ].filter(([x, y]) => x >= 0 && y >= 0 && x < W && y < H && !solidForTank(l.cells[y][x]))
      const stationary = code >= 400 && paramsFor(+(l.enemies[code - 400] as number) || 1).speed === 0
      if (!open.length && !stationary) warnings.push(`spawn ${code} at ${c},${r} is boxed in`)
    }
  return { errors, warnings }
}

// ---- simulation -----------------------------------------------------------------------------

type SimResult = { cleared: number; deaths: number; early: number; error: string | null; kills: number; frames: number; events: Map<string, number>; earlyCause: string[] }

function finite(w: World): string | null {
  const bad = (v: { x: number; z: number }) => !Number.isFinite(v.x) || !Number.isFinite(v.z)
  for (const t of w.tanks) {
    if (!t.active) continue
    if (bad(t.pos) || bad(t.vel)) return `tank ${t.type} NaN`
    if (Math.abs(t.pos.x) > w.field.width / 2 - 4 || Math.abs(t.pos.z) > w.field.depth / 2 - 4) return `tank ${names.get(t.type) ?? 'player'} outside the field`
    if (w.blocks.isPointInsideBlock(t.pos)) return `tank ${names.get(t.type) ?? 'player'} inside a block at ${w.cellAt(t.pos)}`
  }
  for (const b of w.bullets) if (bad(b.pos) || bad(b.vel)) return 'shell NaN'
  return null
}

function simulate(level: number, players: number, seed: number): SimResult {
  const g = new Game()
  g.setData({ params, maps })
  g.options.seed = seed
  g.options.infiniteLives = true
  const pr = new HeadlessPresenter()
  pr.menuAnswer = 1
  g.presenter = pr
  const res: SimResult = { cleared: -1, deaths: 0, early: 0, error: null, kills: 0, frames: 0, events: new Map(), earlyCause: [] }
  let playFrames = 0
  let attemptStart = 0
  g.listener = {
    onWorld() {},
    onPhase(p) {
      if (p === 'play') attemptStart = playFrames
    },
    onEvents(ev: SimEvent[]) {
      for (const e of ev) {
        const k = e.t === 'plus' ? e.kind : e.t === 'shoot' && e.tank.isEnemy ? 'enemyShot' : e.t === 'mineSet' && e.mine.slot >= 4 ? 'enemyMine' : ''
        if (k) res.events.set(k, (res.events.get(k) ?? 0) + 1)
        if (e.t === 'tankDie') {
          if (e.tank.isEnemy) res.kills++
          else {
            res.deaths++
            // (bot friendly fire is not the level's fault)
            if (playFrames - attemptStart < 90 && !(e.by >= 1 && e.by <= 4)) {
              res.early++
              res.earlyCause.push(`P${e.tank.index + 1} by ${e.by === 9 ? 'enemy' : e.by === 15 ? 'hazard' : e.by <= 4 ? 'P' + e.by : e.by} ${e.cause} at ${playFrames - attemptStart}f`)
            }
          }
        }
      }
    },
  }
  const bot = aimBot(seed * 31 + 7)
  try {
    g.newGame(players, level, seed, pack)
    for (let f = 0; f < FRAMES * 2 && playFrames < FRAMES; f++) {
      g.tick(bot)
      if (g.phase === 'play') playFrames++
      const bad = finite(g.world!)
      if (bad) throw new Error(bad)
      if (g.missionIndex !== level || g.phase === 'cleared' || g.phase === 'complete') {
        res.cleared = playFrames
        break
      }
    }
  } catch (e) {
    res.error = e instanceof Error ? e.message : String(e)
  }
  res.frames = playFrames
  return res
}

// ---- run ------------------------------------------------------------------------------------

const rows: string[][] = []
const t0 = Date.now()
const levels = pack.levels.map((l, i) => [l, i] as const).filter(([, i]) => ONLY < 0 || i === ONLY)
for (const [l, i] of levels) {
  const { errors, warnings } = staticCheck(l)
  const enemies = l.enemies.filter(Boolean) as number[]
  const counts = new Map<number, number>()
  for (const e of enemies) counts.set(e, (counts.get(e) ?? 0) + 1)
  const sims = PLAYERS.map((p) => ({ p, r: simulate(i, p, 1000 + i * 17 + p) }))
  const problems = [...errors]
  for (const { p, r } of sims) {
    if (r.error) problems.push(`${p}P exception: ${r.error}`)
    if (r.early) problems.push(`${p}P: ${r.early} death(s) in the first 1.5 s (${r.earlyCause.join(', ')})`)
  }
  if (problems.length) broken++
  const fmt = (r: SimResult) => (r.cleared >= 0 ? `${(r.cleared / 60).toFixed(0)}s/${r.deaths}d` : `--/${r.deaths}d`)
  rows.push([
    String(i + 1).padStart(2),
    l.name.slice(0, 24).padEnd(24),
    String(enemies.length).padStart(2),
    [...counts].map(([t, n]) => `${n}${(names.get(t) ?? '?').slice(0, 3)}`).join(' ').padEnd(26),
    ...sims.map(({ r }) => fmt(r).padStart(9)),
    l.bonus ? '+1' : '  ',
    problems.length ? 'BROKEN ' + problems.join('; ') : warnings.length && !QUIET ? 'warn: ' + warnings.join('; ') : 'ok',
  ])
  if (EVENTS) rows.push(['     events (1P): ' + [...sims[0].r.events].map(([k, n]) => `${k} ${n}`).join(', ')])
}
console.log(`${pack.name}: ${pack.levels.length} levels, bot runs of ${FRAMES} play frames (${(FRAMES / 60).toFixed(0)} s), infinite lives; clear time / deaths`)
console.log(['  #', 'level'.padEnd(24), ' n', 'enemies'.padEnd(26), ...PLAYERS.map((p) => `${p}P`.padStart(9)), '  ', 'status'].join(' '))
for (const r of rows) console.log(r.join(' '))
const levelRows = rows.filter((r) => r.length > 1)
const cleared = PLAYERS.map((_, k) => levelRows.filter((r) => !r[4 + k].trim().startsWith('--')).length)
console.log(`cleared by the bot: ${PLAYERS.map((p, k) => `${p}P ${cleared[k]}/${levelRows.length}`).join(', ')}; broken levels: ${broken} (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
process.exit(broken ? 1 : 0)
