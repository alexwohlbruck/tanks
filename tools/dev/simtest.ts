// Headless smoke test of the simulation port: bun tools/dev/simtest.ts [framesPerMission]
//
// 1. Missions 1-20 with a scripted player (drives around, aims at the nearest enemy, fires and
//    lays mines at random): no exceptions, no NaN, AI tanks move and fire, shells ricochet,
//    mines explode.
// 2. Game flow with the HeadlessPresenter: clear -> next mission, bonus life after mission 5,
//    death -> reload, game over -> results -> menu, the mission 20 cap and the gold-medal flag,
//    2P co-op (one life each, game ends when both are down).

import { readFileSync } from 'fs'
import { Game, padToIntent, type Phase } from '../../src/game'
import type { PadState } from '../../src/input'
import { HeadlessPresenter } from '../../src/sim/presenter'
import type { SimEvent, World } from '../../src/sim/world'

const root = new URL('../../', import.meta.url).pathname
const params = JSON.parse(readFileSync(root + 'public/assets/data/params.json', 'utf8'))
const maps = JSON.parse(readFileSync(root + 'public/assets/data/maps.json', 'utf8'))
const N = +(process.argv[2] ?? 2400)

let failures = 0
function check(cond: unknown, msg: string) {
  if (!cond) {
    failures++
    console.log('  FAIL ' + msg)
  }
}

function makeGame(seed: number) {
  const g = new Game()
  g.setData({ params, maps })
  g.options.seed = seed
  const p = new HeadlessPresenter()
  p.menuAnswer = 1
  g.presenter = p
  return g
}

const idlePad = (): PadState => ({
  moveX: 0,
  moveY: 0,
  pointer: null,
  aimStick: null,
  fire: false,
  mine: false,
  pause: false,
  confirm: false,
  back: false,
  up: false,
  down: false,
  left: false,
  right: false,
})

/** scripted player: wanders, aims at the nearest enemy, fires and lays mines */
function bot(seed: number) {
  let s = seed >>> 0 || 1
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32)
  let dir = rnd() * Math.PI * 2
  let hold = 0
  return (w: World) => {
    for (let i = 0; i < w.players; i++) {
      const t = w.playerTanks[i]
      if (!t.active) continue
      if (--hold <= 0) {
        dir = rnd() * Math.PI * 2
        hold = 20 + Math.floor(rnd() * 60)
      }
      const pad = idlePad()
      pad.moveX = Math.cos(dir)
      pad.moveY = Math.sin(dir)
      let best: { x: number; z: number } | null = null
      let bd = Infinity
      for (const e of w.enemyTanks)
        if (e.alive) {
          const d = Math.hypot(e.pos.x - t.pos.x, e.pos.z - t.pos.z)
          if (d < bd) {
            bd = d
            best = e.pos
          }
        }
      pad.fire = rnd() < 0.08
      pad.mine = rnd() < 0.004
      padToIntent(t, pad, best ? { x: best.x + (rnd() - 0.5) * 60, z: best.z + (rnd() - 0.5) * 60 } : null)
    }
  }
}

function finite(w: World) {
  const bad = (v: { x: number; z: number }) => !Number.isFinite(v.x) || !Number.isFinite(v.z)
  for (const t of w.tanks) if (t.active && (bad(t.pos) || bad(t.vel) || !Number.isFinite(t.body) || !Number.isFinite(t.turret))) return `tank ${t.type} ${JSON.stringify(t.pos)}`
  for (const b of w.bullets) if (bad(b.pos) || bad(b.vel)) return `shell ${JSON.stringify(b.pos)}`
  for (const m of w.mines) if (bad(m.pos)) return `mine ${JSON.stringify(m.pos)}`
  // tanks stay inside the field and out of the blocks (16-unit circle; tank-vs-tank pushes can
  // squeeze a tank a few units into a wall, as in the original min/max push accumulators)
  for (const t of w.tanks) {
    if (!t.active) continue
    if (Math.abs(t.pos.x) > w.field.width / 2 - 4 || Math.abs(t.pos.z) > w.field.depth / 2 - 4) return `tank outside the field ${JSON.stringify(t.pos)}`
    if (w.blocks.isPointInsideBlock(t.pos)) return `tank inside a block ${JSON.stringify(t.pos)}`
  }
  for (const b of w.bullets) if (Math.abs(b.pos.x) > w.field.width / 2 + 8 || Math.abs(b.pos.z) > w.field.depth / 2 + 8) return `shell outside ${JSON.stringify(b.pos)}`
  return null
}

// ---- 1. missions 1-20 ----------------------------------------------------------------------
console.log(`missions 1-20, ${N} play frames each`)
const total = { enemyShots: 0, ricochets: 0, mineExplode: 0, enemyMines: 0, kills: 0, deaths: 0, blockBreaks: 0, moved: 0, movers: 0, shellClash: 0 }
const t0 = Date.now()
for (let m = 0; m < 20; m++) {
  const st = { enemyShots: 0, ricochets: 0, mineExplode: 0, enemyMines: 0, kills: 0, deaths: 0, blockBreaks: 0, shellClash: 0 }
  const moved = new Map<number, { type: number; start: { x: number; z: number }; max: number }>()
  let play = 0
  let attempt = 0
  let error: unknown = null
  while (play < N && attempt < 40 && !error) {
    const g = makeGame(1000 * m + attempt++)
    const drive = bot(77 + m * 13 + attempt)
    g.listener = {
      onWorld() {},
      onPhase() {},
      onEvents(ev: SimEvent[]) {
        for (const e of ev) {
          if (e.t === 'shoot' && e.tank.isEnemy && e.bullet) st.enemyShots++
          else if (e.t === 'ricochet') st.ricochets++
          else if (e.t === 'mineExplode') st.mineExplode++
          else if (e.t === 'mineSet' && e.mine.slot >= 2) st.enemyMines++
          else if (e.t === 'tankDie') e.tank.isEnemy ? st.kills++ : st.deaths++
          else if (e.t === 'blockBreak') st.blockBreaks++
          else if (e.t === 'shellClash') st.shellClash++
        }
      },
    }
    try {
      g.newGame(1, m)
      for (let f = 0; f < N * 3 && play < N; f++) {
        g.tick(drive)
        const w = g.world!
        if (g.phase === 'play') {
          play++
          for (const t of w.enemyTanks) {
            if (!t.active) continue
            let r = moved.get(t.id)
            if (!r) moved.set(t.id, (r = { type: t.type, start: { x: t.pos.x, z: t.pos.z }, max: 0 }))
            r.max = Math.max(r.max, Math.hypot(t.pos.x - r.start.x, t.pos.z - r.start.z))
          }
        }
        const bad = finite(w)
        if (bad) throw new Error(`non-finite ${bad} at frame ${f}`)
        if (g.phase === 'gameover' || g.phase === 'results' || g.phase === 'title' || (g.phase === 'next' && g.missionIndex !== m)) break
      }
    } catch (e) {
      error = e
    }
  }
  if (error) {
    failures++
    console.log(`  mission ${m + 1}: EXCEPTION`, error)
    continue
  }
  const movers = [...moved.values()].filter((r) => r.type !== 1 && r.type !== 7)
  const movedFar = movers.filter((r) => r.max > 35).length
  total.moved += movedFar
  total.movers += movers.length
  for (const k of Object.keys(st) as (keyof typeof st)[]) total[k] += st[k]
  console.log(
    `  M${String(m + 1).padStart(2)} attempts ${attempt} enemy shots ${st.enemyShots} ricochets ${st.ricochets} mines ${st.enemyMines}/${st.mineExplode} kills ${st.kills} deaths ${st.deaths} breaks ${st.blockBreaks} clash ${st.shellClash} movers ${movedFar}/${movers.length}`,
  )
  if (movers.length) check(movedFar > 0, `mission ${m + 1}: mobile enemies never moved`)
}
console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)} s)`)
check(total.enemyShots > 50, 'AI tanks fire')
check(total.ricochets > 20, 'shells ricochet')
check(total.mineExplode > 5, 'mines explode')
check(total.enemyMines > 0, 'AI lays mines')
check(total.moved > total.movers * 0.6, 'AI tanks move')
check(total.blockBreaks > 0, 'mines break cork blocks')

// ---- 2. flow -------------------------------------------------------------------------------
console.log('flow')
function run(g: Game, until: (g: Game) => boolean, max = 5000, pads = (_w: World) => {}) {
  for (let i = 0; i < max; i++) {
    if (until(g)) return i
    g.tick(pads)
  }
  return -1
}
const phaseIs = (p: Phase) => (g: Game) => g.phase === p

{
  const g = makeGame(5)
  const phases: string[] = []
  g.listener = { onWorld() {}, onEvents() {}, onPhase: (p) => phases.push(p) }
  g.newGame(1, 0)
  const tIntro = run(g, phaseIs('start'))
  const tStart = run(g, phaseIs('play'))
  console.log(`  first fade ${tIntro} frames, start delay ${tStart} frames`)
  check(tStart === 165, 'StageStart lasts 165 frames')
  check(g.world!.enemyTanks.some((t) => t.active && t.state === 2), 'enemies activated')
  g.debugKillAll()
  check(run(g, phaseIs('cleared')) >= 0, 'all enemies dead -> cleared')
  const tClear = run(g, phaseIs('next'))
  const tNext = run(g, phaseIs('start'))
  console.log(`  clear message ${tClear} frames, fade to mission 2 ${tNext} frames`)
  check(g.missionIndex === 1, 'advanced to mission 2')
  check(tNext > 200 && tNext < 260, 'fade ~224 frames')
  run(g, phaseIs('play'))
  const livesBefore = g.lives
  g.debugKillPlayers()
  check(run(g, phaseIs('dead')) >= 0, 'player dead -> miss wait')
  check(g.lives === livesBefore - 1, 'life lost')
  const tMiss = run(g, phaseIs('next'))
  check(tMiss === 120 || tMiss === 119, `miss wait 120 frames (${tMiss})`)
  run(g, phaseIs('play'))
  check(g.missionIndex === 1, 'same mission after death')
  g.debugKillPlayers()
  run(g, phaseIs('play'))
  g.debugKillPlayers()
  check(run(g, phaseIs('gameover')) >= 0, 'last life -> gameover')
  check(run(g, phaseIs('results')) >= 0, 'gameover -> results')
  check(run(g, phaseIs('title')) >= 0, 'results -> medal -> menu -> quit')
  console.log('  phases: ' + phases.join(' '))
}
{
  // bonus life after mission 5 (index 4)
  const g = makeGame(6)
  g.newGame(1, 4)
  run(g, phaseIs('play'))
  const l = g.lives
  g.debugKillAll()
  run(g, phaseIs('start'))
  check(g.missionIndex === 5 && g.lives === l + 1, `bonus life after mission 5 (${l} -> ${g.lives})`)
}
{
  // mission 20 cap / gold medal flag
  const g = makeGame(7)
  g.newGame(1, 19)
  run(g, phaseIs('play'))
  g.debugKillAll()
  check(run(g, (g) => g.phase === 'complete' || g.phase === 'cleared') >= 0 && g.phase === 'complete', 'mission 20 completes the game without gold')
  const h = makeGame(7)
  h.options.goldMedal = true
  h.newGame(1, 19)
  run(h, phaseIs('play'))
  h.debugKillAll()
  run(h, (g) => g.phase === 'complete' || g.phase === 'cleared')
  check(h.phase === 'cleared', 'gold medal: mission 20 leads to 21')
}
{
  // 2P: one life each; one player down keeps playing; both down -> gameover
  const g = makeGame(8)
  g.newGame(2, 0)
  run(g, phaseIs('play'))
  check(g.livesOf(0) === 1 && g.livesOf(1) === 1, '2P starts with one life each')
  const p2 = g.world!.playerTanks[1]
  p2.lives = 0
  p2.explode(3, 'shell')
  run(g, () => false, 30)
  check(g.phase === 'play', '2P: one player down keeps playing')
  g.debugKillPlayers()
  check(run(g, phaseIs('gameover')) >= 0, '2P: both down -> gameover')
}
{
  // determinism: same seed, same pads -> same world
  const sig = () => {
    const g = makeGame(1234)
    g.newGame(1, 7)
    const d = bot(99)
    for (let i = 0; i < 1500; i++) g.tick(d)
    const w = g.world!
    return JSON.stringify([g.rng.state, w.tanks.map((t) => [t.pos.x, t.pos.z, t.alive]), w.bullets.length, g.phase])
  }
  check(sig() === sig(), 'deterministic for a fixed seed')
}

console.log(failures ? `${failures} FAILED` : 'all checks passed')
process.exit(failures ? 1 : 0)
