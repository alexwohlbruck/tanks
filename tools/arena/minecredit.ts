// A shoots B's mine next to C: C's destruction is credited to A. bun tools/arena/minecredit.ts
import { readFileSync } from 'node:fs'
import { normalizeData } from '../../src/data'
import { setTankRecords } from '../../src/sim/stats'
import { ArenaSim } from '../../src/arena/sim'
import { MINE } from '../../src/sim/consts'
import { v3 } from '../../src/sim/vec'

const params = JSON.parse(readFileSync('public/assets/data/params.json', 'utf8'))
const maps = JSON.parse(readFileSync('public/assets/data/maps.json', 'utf8'))
setTankRecords(normalizeData({ params, maps }).params.tanks)
let fails = 0
for (const mode of ['ffa', 'teams'] as const) {
  const sim = new ArenaSim(mode, 7)
  const [a, b, c] = [sim.addPlayer('A', false), sim.addPlayer('B', false), sim.addPlayer('C', false)]
  if (mode === 'teams') (a.team = 0), (b.team = 1), (c.team = 1)
  // an open stretch of floor: clear the cells around the origin
  for (let r = 20; r < 36; r++) for (let q = 20; q < 64; q++) sim.field.code[r * sim.map.cols + q] = 0
  const place = (p: typeof a, x: number) => {
    p.tank.pos = v3(x, 0, 0)
    p.tank.protectUntil = 0
  }
  place(a, -300)
  place(b, 400)
  place(c, 90)
  // C sits outside the trigger radius (70 + 14) but inside the blast (80 + 14)
  sim.mines.push({ id: 999, owner: b.tank, pid: b.pid, team: b.team, pos: v3(0, 0, 0), age: 0, state: 1, armed: false, fuseLit: false, timer: 0, blast: MINE.blastIdle, dead: false, by: null })
  // A aims at the mine (it sits 16 behind its shell hit circle) and fires
  a.input = { ...a.input, ax: 0, az: 16, mx: 0, mz: 0 }
  b.input = { ...b.input, ax: 400, az: 100 }
  c.input = { ...c.input, ax: 90, az: 100 }
  a.wantFire = true
  let kill = null as null | { victim: number; killer: number }
  for (let i = 0; i < 400 && !kill; i++) {
    sim.step()
    for (const e of sim.events) if (e.t === 'kill' && e.victim === c.pid) kill = e
    sim.events = []
  }
  const ok = !!kill && kill.killer === a.pid && a.kills === 1
  if (!ok) fails++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode}: C destroyed by ${kill ? sim.players.find((p) => p.pid === kill!.killer)?.name : 'nobody'}, A kills ${a.kills}, team score ${sim.teamScore}`)
}
process.exit(fails ? 1 : 0)
