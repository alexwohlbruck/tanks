// Headless arena: bots only, reports kills / shots / tick time. bun tools/arena/headless.ts [ffa|teams] [seconds]
import { readFileSync } from 'node:fs'
import { normalizeData } from '../../src/data'
import { setTankRecords } from '../../src/sim/stats'
import { ArenaSim } from '../../src/arena/sim'
import { botThink } from '../../src/arena/bot'

const params = JSON.parse(readFileSync('public/assets/data/params.json', 'utf8'))
const maps = JSON.parse(readFileSync('public/assets/data/maps.json', 'utf8'))
setTankRecords(normalizeData({ params, maps }).params.tanks)
const mode = (process.argv[2] ?? 'ffa') as 'ffa' | 'teams'
const secs = Number(process.argv[3] ?? 120)
const n = Number(process.argv[4] ?? 16)
const sim = new ArenaSim(mode, 1234)
for (let i = 0; i < n; i++) sim.addPlayer(sim.botName(), true)
const count: Record<string, number> = {}
let worst = 0
const t0 = performance.now()
for (let i = 0; i < secs * 60; i++) {
  const a = performance.now()
  for (const p of sim.players) botThink(sim, p)
  sim.step()
  worst = Math.max(worst, performance.now() - a)
  for (const e of sim.events) count[e.t] = (count[e.t] ?? 0) + 1
  sim.events = []
}
const ms = performance.now() - t0
console.log(mode, `${n} bots, ${secs}s: ${(ms / (secs * 60)).toFixed(3)} ms/tick avg, worst ${worst.toFixed(1)} ms`)
console.log(count)
console.log('state', sim.state, 'team', sim.teamScore, 'open', sim.map.open.length, 'spawns', sim.map.spawns.map((s) => s.length))
console.log(sim.players.map((p) => `${p.name} ${p.team} k${p.kills} d${p.deaths} s${p.score}`).join('\n'))
