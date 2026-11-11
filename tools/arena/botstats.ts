// Bot behaviour by mode: nukes laid / kills by nukes / self-nukes, kills, how long one-life
// rounds last. bun tools/arena/botstats.ts [seconds=240] [seeds=4]
import { readFileSync } from 'node:fs'
import { normalizeData } from '../../src/data'
import { setTankRecords } from '../../src/sim/stats'
import { ArenaSim } from '../../src/arena/sim'
import { botThink } from '../../src/arena/bot'
import { ARENA_MODES } from '../../src/arena/rules'
const params = JSON.parse(readFileSync('public/assets/data/params.json', 'utf8'))
const maps = JSON.parse(readFileSync('public/assets/data/maps.json', 'utf8'))
setTankRecords(normalizeData({ params, maps }).params.tanks)
const secs = Number(process.argv[2] ?? 240)
const seeds = Number(process.argv[3] ?? 4)
for (const mode of ARENA_MODES) {
  let spread = 0
  let spreadN = 0
  const n = { nukes: 0, nukeKills: 0, nukeVictims: 0, selfNuke: 0, teamNuke: 0, kills: 0, matches: 0, rounds: 0 }
  for (let seed = 1; seed <= seeds; seed++) {
    const sim = new ArenaSim(mode, seed * 101, 'medium')
    for (let i = 0; i < 14; i++) sim.addPlayer(sim.botName(), true)
    const booms = new Map<number, number>()
    for (let i = 0; i < secs * 60; i++) {
      for (const p of sim.players) botThink(sim, p)
      sim.step()
      for (const e of sim.events) {
        if (e.t === 'kill') {
          n.kills++
          if (e.cause === 'nuke') {
            n.nukeVictims++
            if (e.killer === e.victim) n.selfNuke++
            else if (e.tk) n.teamNuke++
            else n.nukeKills++
          }
        }
        if (e.t === 'match' && e.state === 'over') n.matches++
        if (e.t === 'round' && !e.start) n.rounds++
      }
      sim.events = []
      for (const m of sim.mines) if (m.nuke && !booms.has(m.id)) (booms.set(m.id, 1), n.nukes++)
      // team modes: how far a tank is from its nearest teammate (every second)
      if (i % 60 === 0 && (mode === 'teams' || mode === 'elim'))
        for (const t of sim.tanks) {
          if (!t.alive) continue
          const mates = sim.tanks.filter((o) => o !== t && o.alive && o.player.team === t.player.team)
          if (!mates.length) continue
          spread += Math.min(...mates.map((o) => Math.hypot(o.pos.x - t.pos.x, o.pos.z - t.pos.z)))
          spreadN++
        }
    }
  }
  const per = (k: number) => (k / seeds).toFixed(1)
  console.log(`${mode.padEnd(6)} per ${secs}s match-time: nukes laid ${per(n.nukes)}, enemies killed by nukes ${per(n.nukeKills)}, self-nuked ${per(n.selfNuke)}, team-nuked ${per(n.teamNuke)}, kills ${per(n.kills)}, matches over ${per(n.matches)}${mode === 'elim' ? `, rounds ${per(n.rounds)}` : ''}${spreadN ? `, nearest teammate ${Math.round(spread / spreadN)} units` : ''}`)
}
