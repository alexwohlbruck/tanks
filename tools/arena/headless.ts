// Headless arena: bots only, reports kills / shots / tick time. bun tools/arena/headless.ts [ffa|teams] [seconds] [bots] [small|medium|large]
// Also: how far from the nearest enemy each respawn lands, and how often one is in sight.
import { readFileSync } from 'node:fs'
import { normalizeData } from '../../src/data'
import { setTankRecords } from '../../src/sim/stats'
import { ArenaSim } from '../../src/arena/sim'
import { botThink } from '../../src/arena/bot'
import { arenaModeOf, sizeOf } from '../../src/arena/rules'

const params = JSON.parse(readFileSync('public/assets/data/params.json', 'utf8'))
const maps = JSON.parse(readFileSync('public/assets/data/maps.json', 'utf8'))
setTankRecords(normalizeData({ params, maps }).params.tanks)
const mode = arenaModeOf(process.argv[2])
const secs = Number(process.argv[3] ?? 120)
const n = Number(process.argv[4] ?? 16)
const size = sizeOf(process.argv[5])
const sim = new ArenaSim(mode, 1234, size)
for (let i = 0; i < n; i++) sim.addPlayer(sim.botName(), true)
const count: Record<string, number> = {}
let worst = 0
const near: number[] = []
let seen = 0
const kinds: Record<string, number> = {}
const t0 = performance.now()
for (let i = 0; i < secs * 60; i++) {
  const a = performance.now()
  for (const p of sim.players) botThink(sim, p)
  sim.step()
  worst = Math.max(worst, performance.now() - a)
  for (const e of sim.events) {
    count[e.t] = (count[e.t] ?? 0) + 1
    // the match flow: rounds and results, with the time and who is left
    if (e.t === 'round' || e.t === 'match') {
      const left = sim.players.filter((p) => p.tank.alive).length
      console.log(`${(i / 60).toFixed(1)}s ${e.t} ${JSON.stringify(e)} left ${left}${sim.zone ? ` zone r ${Math.round(sim.zoneR())}` : ''}${e.t === 'match' && e.state === 'over' ? ` winner ${sim.winner?.name ?? 'none'}` : ''}`)
    }
    if (e.t === 'kill') {
      const k = e.killer === e.victim ? `self-${e.cause}` : e.tk ? `team-${e.cause}` : `kill-${e.cause}`
      kinds[k] = (kinds[k] ?? 0) + 1
    }
    if (e.t !== 'spawn' || i < 120) continue
    const me = sim.tanks.find((t) => t.id === e.tank)!
    const foes = sim.tanks.filter((t) => t.alive && sim.enemies(me.player, t.player))
    if (!foes.length) continue
    near.push(Math.min(...foes.map((t) => Math.hypot(t.pos.x - e.x, t.pos.z - e.z))))
    if (foes.some((t) => Math.hypot(t.pos.x - e.x, t.pos.z - e.z) < 620 && sim.field.clearLine(e.x, e.z, t.pos.x, t.pos.z))) seen++
  }
  sim.events = []
}
const ms = performance.now() - t0
console.log(mode, `${n} bots, ${secs}s: ${(ms / (secs * 60)).toFixed(3)} ms/tick avg, worst ${worst.toFixed(1)} ms`)
console.log(count)
console.log('kills', kinds)
near.sort((a, b) => a - b)
const q = (f: number) => Math.round(near[Math.floor(near.length * f)] ?? 0)
console.log(`map ${sim.map.cols}x${sim.map.rows}; respawns ${near.length}: nearest enemy p10 ${q(0.1)} median ${q(0.5)} p90 ${q(0.9)}; in sight ${seen}`)
console.log('state', sim.state, 'team', sim.teamScore, 'open', sim.map.open.length, 'spawns', sim.map.spawns.map((s) => s.length))
console.log(sim.players.map((p) => `${p.name} ${p.team} k${p.kills} d${p.deaths} s${p.score}`).join('\n'))
