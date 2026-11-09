// Versus rooms credit a mine's kills to whoever set it off. bun tools/dev/vsminecredit.ts
//   shot:   A shoots B's mine next to C        -> C's destruction is A's frag (not B's)
//   chain:  A shoots B's mine, its blast sets off B's second mine next to D -> D is A's frag too
//   owner:  the same shot with the flag off (the campaign / co-op rule) -> B's frag
import { readFileSync } from 'node:fs'
import { VersusRunner } from '../../server/net/runners'
import { normalizeData } from '../../src/data'
import { setTankRecords } from '../../src/sim/stats'
import { v3 } from '../../src/sim/vec'
import type { World } from '../../src/sim/world'

const params = JSON.parse(readFileSync('public/assets/data/params.json', 'utf8'))
const maps = JSON.parse(readFileSync('public/assets/data/maps.json', 'utf8'))
setTankRecords(normalizeData({ params, maps }).params.tanks)

/** row 1 of Crossroads (arena 0) is open floor from wall to wall */
const Z = -245
const NAMES = ['A', 'B', 'C', 'D']

function run(kind: 'shot' | 'chain' | 'owner') {
  const r = new VersusRunner(4, { rounds: 3, ai: 0, arena: 0 }, { stage() {}, events() {} })
  const idle = (w: World) => {
    for (const t of w.playerTanks) Object.assign(t.intent, { moveX: 0, moveZ: 0, fire: false, mine: false })
  }
  // the round's start countdown
  for (let i = 0; i < 200; i++) r.tick(idle)
  const w = r.world!
  if (kind === 'owner') w.mineCreditTrigger = false
  const [a, b, c, d] = w.playerTanks
  const put = (t: typeof a, x: number, z: number) => Object.assign(t.pos, { x, z })
  put(a, -300, Z)
  put(b, 330, Z)
  // C: 90 from the first mine (outside its trigger radius, inside the blast)
  put(c, 0, Z + 90)
  // D: 90 beyond the second mine (chain) or far away
  put(d, kind === 'chain' ? 160 : 250, kind === 'chain' ? Z : Z + 400)
  w.layMine(0, b, v3(0, 0, Z), v3(0, 0, Z), 1)
  if (kind === 'chain') w.layMine(0, b, v3(70, 0, Z), v3(70, 0, Z), 1)
  const deaths: number[] = []
  let frame = 0
  for (; frame < 300 && deaths.length < (kind === 'chain' ? 2 : 1); frame++) {
    r.tick((w) => {
      idle(w)
      // A aims at the mine's shell hit point (16 in front of it) and fires once
      Object.assign(a.intent, { aimX: 0, aimZ: Z + 16, fire: frame === 5 })
      for (const t of [b, c, d]) Object.assign(t.intent, { aimX: t.pos.x, aimZ: t.pos.z + 100 })
    })
    // VersusRunner drained the events to the host; read the tanks instead
    for (const [i, t] of [a, b, c, d].entries()) if (!t.alive && !deaths.includes(i)) deaths.push(i)
  }
  const frags = r.meta().vs!.frags
  return { deaths, frags }
}

let fails = 0
const expect: Record<string, { frags: number[]; dead: number[] }> = {
  shot: { frags: [1, 0, 0, 0], dead: [2] },
  chain: { frags: [2, 0, 0, 0], dead: [2, 3] },
  owner: { frags: [0, 1, 0, 0], dead: [2] },
}
for (const kind of ['shot', 'chain', 'owner'] as const) {
  const { deaths, frags } = run(kind)
  const e = expect[kind]
  const dead = deaths.slice().sort()
  const ok = frags.join() === e.frags.join() && dead.join() === e.dead.join()
  if (!ok) fails++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${kind}: destroyed ${dead.map((i) => NAMES[i]).join(', ') || 'nobody'}; frags ${frags.map((f, i) => `${NAMES[i]} ${f}`).join(', ')}`)
}
process.exit(fails ? 1 : 0)
