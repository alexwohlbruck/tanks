// Bot behaviour by mode: nukes laid / kills by nukes / self-nukes, kills, how long one-life
// rounds last. [MODES=ffa,royale] bun tools/arena/botstats.ts [seconds=240] [seeds=4]
import { readFileSync } from 'node:fs'
import { normalizeData } from '../../src/data'
import { setTankRecords } from '../../src/sim/stats'
import { ArenaSim } from '../../src/arena/sim'
import { botThink } from '../../src/arena/bot'
import { ARENA_MODES, PERSONAS, personaOf, temperOf } from '../../src/arena/rules'
import { cellOf } from '../../src/arena/map'
const params = JSON.parse(readFileSync('public/assets/data/params.json', 'utf8'))
const maps = JSON.parse(readFileSync('public/assets/data/maps.json', 'utf8'))
setTankRecords(normalizeData({ params, maps }).params.tanks)
const secs = Number(process.argv[2] ?? 240)
const seeds = Number(process.argv[3] ?? 4)
// by personality, all modes together: kills, deaths, mines laid, pickups taken, shots
const by = Object.fromEntries(PERSONAS.map((k) => [k, { n: 0, kills: 0, mineKills: 0, deaths: 0, mines: 0, picks: 0, shots: 0 }]))
// by play style (temperOf): kills, deaths, mines, distance to the nearest enemy and teammate
const STYLES = ['no mines', 'lays mines', 'aggressive', 'defensive', 'team player', 'lone wolf'] as const
const stylesOf = (name: string) => {
  const t = temperOf(name)
  return [t.mines ? 'lays mines' : 'no mines', ...(t.stance > 0.35 ? ['aggressive'] : t.stance < -0.35 ? ['defensive'] : []), ...(t.social > 0.67 ? ['team player'] : t.social < 0.33 ? ['lone wolf'] : [])]
}
const sty = Object.fromEntries(STYLES.map((k) => [k, { n: 0, kills: 0, deaths: 0, mines: 0, foe: 0, foeN: 0, mate: 0, mateN: 0 }]))
let pacts = 0
for (const mode of (process.env.MODES?.split(",") ?? ARENA_MODES) as typeof ARENA_MODES) {
  let spread = 0
  let spreadN = 0
  const n = { yellowMines: 0, yellowSecs: 0, chainKills: 0, selfMined: 0, mines: 0, hiddenMines: 0, mineKills: 0, early: 0, at: 0, nukes: 0, nukeKills: 0, nukeVictims: 0, selfNuke: 0, teamNuke: 0, kills: 0, matches: 0, rounds: 0 }
  for (let seed = 1; seed <= seeds; seed++) {
    const sim = new ArenaSim(mode, seed * 101, 'medium')
    for (let i = 0; i < 14; i++) sim.addPlayer(sim.botName(), true)
    for (const p of sim.players) by[personaOf(p.name)].n++
    for (const p of sim.players) for (const k of stylesOf(p.name)) sty[k].n++
    const who = (pid: number) => sim.players.find((p) => p.pid === pid)
    const tankWho = (id: number) => sim.tanks.find((t) => t.id === id)?.player
    const booms = new Map<number, number>()
    for (let i = 0; i < secs * 60; i++) {
      for (const p of sim.players) botThink(sim, p)
      for (const p of sim.players) if (p.say != null) (pacts++, (p.say = null))
      if (i % 30 === 0)
        for (const t of sim.tanks) {
          if (!t.alive) continue
          const d = (l: typeof sim.tanks) => Math.min(...l.filter((o) => o !== t && o.alive).map((o) => Math.hypot(o.pos.x - t.pos.x, o.pos.z - t.pos.z)))
          const foe = d(sim.tanks.filter((o) => sim.enemies(t.player, o.player)))
          const mate = mode === 'teams' || mode === 'elim' ? d(sim.tanks.filter((o) => !sim.enemies(t.player, o.player))) : Infinity
          for (const k of stylesOf(t.player.name)) {
            if (foe < 5000) (sty[k].foe += foe), sty[k].foeN++
            if (mate < 5000) (sty[k].mate += mate), sty[k].mateN++
          }
        }
      sim.step()
      for (const e of sim.events) {
        if (e.t === 'kill') {
          n.kills++
          const k = who(e.killer), v = who(e.victim)
          if (k && k !== v && !e.tk) by[personaOf(k.name)].kills++
          if (k && k !== v && !e.tk) for (const s of stylesOf(k.name)) sty[s].kills++
          if (v) for (const s of stylesOf(v.name)) sty[s].deaths++
          if (k && k !== v && !e.tk && e.cause === 'mine') by[personaOf(k.name)].mineKills++
          if (v) by[personaOf(v.name)].deaths++
          if (e.cause === 'mine' && e.killer !== e.victim && !e.tk) n.mineKills++
          if (e.cause === 'mine' && e.killer !== e.victim && !e.tk && e.chain > 0) n.chainKills++
          if (e.cause === 'mine' && e.killer === e.victim) n.selfMined++
          if (e.cause === 'nuke') {
            n.nukeVictims++
            if (e.killer === e.victim) n.selfNuke++
            else if (e.tk) n.teamNuke++
            else n.nukeKills++
          }
        }
        if (e.t === 'pickup') { const q = tankWho(e.tank); if (q) by[personaOf(q.name)].picks++ }
        if (e.t === 'shot') { const q = tankWho(e.tank); if (q) by[personaOf(q.name)].shots++ }
        if (e.t === 'match' && e.state === 'over') n.matches++
        if (e.t === 'round' && !e.start) n.rounds++
      }
      sim.events = []
      for (const m of sim.mines)
        if (!m.nuke && !booms.has(m.id)) {
          booms.set(m.id, 1)
          n.mines++
          if (m.owner.power === 'yellow') n.yellowMines++
          by[personaOf(m.owner.player.name)].mines++
          for (const s of stylesOf(m.owner.player.name)) sty[s].mines++
          // laid where the camera can't see it (a block on the row in front)
          const [c, r] = cellOf(sim.map, m.pos.x, m.pos.z)
          if (sim.field.height(c, r + 1) > 1) n.hiddenMines++
        }
      for (const m of sim.mines)
        if (m.nuke && !booms.has(m.id)) {
          booms.set(m.id, 1)
          n.nukes++
          // when in the round it went down, and whether it was in the first 30 seconds
          const since = (sim.tick - sim.roundStart) / 60
          n.at += since
          if (since < 30) n.early++
        }
      if (i % 60 === 0) n.yellowSecs += sim.tanks.filter((t) => t.alive && t.power === 'yellow').length
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
  console.log(`${mode.padEnd(6)} per ${secs}s match-time: mines ${per(n.mines)} (${n.mines ? Math.round((n.hiddenMines / n.mines) * 100) : 0}% hidden), enemies killed by mines ${per(n.mineKills)}, nukes laid ${per(n.nukes)} (${per(n.early)} in a round's first 30s, on average ${n.nukes ? Math.round(n.at / n.nukes) : '-'}s in), enemies killed by nukes ${per(n.nukeKills)}, self-nuked ${per(n.selfNuke)}, team-nuked ${per(n.teamNuke)}, kills ${per(n.kills)}, Yellow: ${n.yellowSecs ? ((n.yellowMines / n.yellowSecs) * 10).toFixed(1) : '-'} mines per 10 s held, enemies killed down a chain ${per(n.chainKills)}, own-mine deaths ${per(n.selfMined)}, matches over ${per(n.matches)}${mode === 'elim' ? `, rounds ${per(n.rounds)}` : ''}${spreadN ? `, nearest teammate ${Math.round(spread / spreadN)} units` : ''}`)
}
for (const k of PERSONAS) {
  const v = by[k]
  const per = (x: number) => (x / Math.max(1, v.n)).toFixed(1)
  console.log(`${k.padEnd(9)} (${v.n} bots) per bot: kills ${per(v.kills)}, deaths ${per(v.deaths)}, K/D ${(v.kills / Math.max(1, v.deaths)).toFixed(2)}, mines ${per(v.mines)} (kills ${per(v.mineKills)}), pickups ${per(v.picks)}, shots ${per(v.shots)}`)
}
for (const k of STYLES) {
  const v = sty[k]
  const per = (x: number) => (x / Math.max(1, v.n)).toFixed(1)
  console.log(`${k.padEnd(11)} (${v.n} bots) per bot: kills ${per(v.kills)}, deaths ${per(v.deaths)}, mines ${per(v.mines)}, nearest enemy ${Math.round(v.foe / Math.max(1, v.foeN))}, nearest teammate (team modes) ${Math.round(v.mate / Math.max(1, v.mateN))}`)
}
console.log(`pacts made (Free-for-all, Battle royale): ${pacts}`)
