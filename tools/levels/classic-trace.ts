// Classic-mode regression check: the original 100-mission campaign must stay bit-for-bit the
// same while Tanks+ content is added. Runs fixed-seed games (1-4 players, missions across the
// campaign) with a scripted player and hashes every frame's events and actor state (exact
// float values, RNG state, phase). The hashes are compared with tools/levels/classic-trace.json,
// which was recorded on the commit before any Tanks+ hook existed.
//
//   bun tools/levels/classic-trace.ts            # check (exit 1 on a mismatch)
//   bun tools/levels/classic-trace.ts --update   # rewrite the golden file (only on a known-good tree!)

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { Game } from '../../src/game'
import { HeadlessPresenter } from '../../src/sim/presenter'
import type { SimEvent } from '../../src/sim/world'
import { randomBot } from './bot'

const root = new URL('../../', import.meta.url).pathname
const params = JSON.parse(readFileSync(root + 'public/assets/data/params.json', 'utf8'))
const maps = JSON.parse(readFileSync(root + 'public/assets/data/maps.json', 'utf8'))
const GOLDEN = root + 'tools/levels/classic-trace.json'
const FRAMES = 2400

/** FNV-1a over strings */
class Hash {
  h = 0x811c9dc5
  add(s: string) {
    for (let i = 0; i < s.length; i++) {
      this.h ^= s.charCodeAt(i)
      this.h = Math.imul(this.h, 0x01000193) >>> 0
    }
    this.h ^= 0x7c
    this.h = Math.imul(this.h, 0x01000193) >>> 0
  }
  get hex() {
    return this.h.toString(16).padStart(8, '0')
  }
}

const v = (p: { x: number; z: number }) => `${p.x},${p.z}`

function eventKey(e: SimEvent): string {
  switch (e.t) {
    case 'shoot':
      return `shoot ${e.tank.index}${e.tank.isEnemy ? 'e' : 'p'} ${e.bullet ? v(e.bullet.pos) : '-'}`
    case 'ricochet':
      return `ricochet ${e.bullet.index} ${v(e.pos)} ${e.super}`
    case 'bulletDie':
      return `bulletDie ${e.bullet.index} ${v(e.pos)} ${e.reason}`
    case 'tankDie':
      return `die ${e.tank.index}${e.tank.isEnemy ? 'e' : 'p'} ${e.by} ${e.cause} ${e.killer}`
    case 'mineSet':
    case 'mineFuse':
    case 'mineExplode':
    case 'mineGone':
      return `${e.t} ${e.mine.index} ${v(e.mine.pos)}`
    case 'blockBreak':
      return `break ${e.cx},${e.cz}`
    case 'tread':
      return `tread ${e.tank.index} ${v(e.pos)}`
    case 'se':
    case 'seHold':
      return `${e.t} ${e.name}`
    case 'bgm':
      return `bgm ${e.name}`
    case 'bgmMask':
      return `mask ${e.mask}`
    default:
      return e.t
  }
}

type Scenario = { name: string; players: number; mission: number; seed: number; gold: boolean }
const scenarios: Scenario[] = []
for (let m = 0; m < 20; m++) scenarios.push({ name: `1P M${m + 1}`, players: 1, mission: m, seed: 100 + m, gold: false })
for (const m of [24, 29, 37, 49, 50, 64, 79, 88, 99]) scenarios.push({ name: `1P M${m + 1} gold`, players: 1, mission: m, seed: 300 + m, gold: true })
for (const m of [0, 4, 9, 14, 19]) scenarios.push({ name: `2P M${m + 1}`, players: 2, mission: m, seed: 500 + m, gold: false })
for (const m of [2, 11]) scenarios.push({ name: `3P M${m + 1}`, players: 3, mission: m, seed: 700 + m, gold: false })
for (const m of [6, 17]) scenarios.push({ name: `4P M${m + 1}`, players: 4, mission: m, seed: 900 + m, gold: false })

function run(sc: Scenario): string {
  const g = new Game()
  g.setData({ params, maps })
  g.options.seed = sc.seed
  g.options.goldMedal = sc.gold
  const p = new HeadlessPresenter()
  p.menuAnswer = 1
  g.presenter = p
  const h = new Hash()
  g.listener = { onWorld() {}, onPhase: (ph) => h.add('phase ' + ph), onEvents: (ev) => ev.forEach((e) => h.add(eventKey(e))) }
  g.newGame(sc.players, sc.mission)
  const drive = randomBot(sc.seed * 7 + 1)
  for (let f = 0; f < FRAMES; f++) {
    g.tick(drive)
    const w = g.world!
    h.add(`f${f} ${g.state} ${g.rng.x},${g.rng.y} ${g.missionIndex} ${g.lives} ${w.enemyAliveNum}`)
    for (const t of w.tanks) h.add(`${t.pos.x},${t.pos.z},${t.body},${t.turret},${t.alive ? 1 : 0},${t.invisible ? 1 : 0}`)
    for (const b of w.bullets) h.add(`${b.pos.x},${b.pos.z},${b.vel.x},${b.vel.z},${b.smokeType},${b.shooterType}`)
    for (const m of w.mines) h.add(`${m.pos.x},${m.pos.z},${m.timer}`)
  }
  return h.hex
}

const update = process.argv.includes('--update')
const golden: Record<string, string> = existsSync(GOLDEN) && !update ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : {}
const out: Record<string, string> = {}
let bad = 0
const t0 = Date.now()
for (const sc of scenarios) {
  const hex = run(sc)
  out[sc.name] = hex
  if (!update) {
    const ok = golden[sc.name] === hex
    if (!ok) bad++
    console.log(`  ${ok ? 'ok  ' : 'DIFF'} ${sc.name.padEnd(14)} ${hex}${ok ? '' : ` (golden ${golden[sc.name] ?? 'missing'})`}`)
  }
}
if (update) {
  writeFileSync(GOLDEN, JSON.stringify(out, null, 1) + '\n')
  console.log(`wrote ${scenarios.length} scenario hashes to ${GOLDEN}`)
} else console.log(`${scenarios.length - bad}/${scenarios.length} classic traces identical (${((Date.now() - t0) / 1000).toFixed(1)} s)`)
process.exit(bad ? 1 : 0)
