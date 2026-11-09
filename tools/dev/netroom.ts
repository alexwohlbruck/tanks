// Room flow without sockets or real time: bun tools/dev/netroom.ts
// Fake connections, room.step() driven directly. Checks join-in-progress (spectate, then play
// from the next mission), versus rounds / match end / play again, the result-screen gates,
// rejoin keyframes and lobby slot compaction.

import { readFileSync } from 'fs'
import { normalizeData } from '../../src/data'
import { decodeSnapshot, type S2C, type Snapshot } from '../../src/net/protocol'
import { setTankRecords } from '../../src/sim/stats'
import { Room, type Conn } from '../../server/net/room'
import type { CoopRunner, VersusRunner } from '../../server/net/runners'

const root = new URL('../../', import.meta.url).pathname
const data = normalizeData({
  params: JSON.parse(readFileSync(root + 'public/assets/data/params.json', 'utf8')),
  maps: JSON.parse(readFileSync(root + 'public/assets/data/maps.json', 'utf8')),
})
setTankRecords(data.params.tanks)

let failures = 0
const check = (ok: unknown, msg: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!ok) failures++
}

class Fake implements Conn {
  json: S2C[] = []
  snaps: Snapshot[] = []
  send(d: string | Uint8Array) {
    if (typeof d === 'string') this.json.push(JSON.parse(d))
    else {
      const s = decodeSnapshot(d)
      if (s) this.snaps.push(s)
    }
  }
  buffered() {
    return 0
  }
  close() {}
  last<T extends S2C['t']>(t: T) {
    return this.json.filter((m) => m.t === t).at(-1) as Extract<S2C, { t: T }> | undefined
  }
}

const deps = { data: () => data, resolvePack: async () => Promise.reject(new Error('no store')), onEmpty: () => {} }
const run = (r: Room, n: number, until?: () => boolean) => {
  for (let i = 0; i < n; i++) {
    r.step()
    if (until?.()) return i + 1
  }
  return -1
}

console.log('join in progress (co-op)')
{
  const r = new Room('TEST1', 'Test', false, 4, deps)
  const c = [new Fake(), new Fake(), new Fake()]
  const m0 = r.add('t0', 'A', c[0])!
  r.add('t1', 'B', c[1])
  check(!r.start(), 'co-op starts')
  const coop = r.runner as CoopRunner
  check(run(r, 1200, () => coop.game.state === 4) > 0, 'reaches play')
  const m2 = r.add('t2', 'C', c[2])!
  check(m2.slot === 2 && r.info(m2).members[2].spectating, 'late joiner gets slot 2 and spectates')
  check(c[2].last('stage') && c[2].last('game'), 'late joiner gets the game and the stage')
  r.step()
  r.step()
  check(c[2].snaps.at(-1)?.key && !c[2].snaps.at(-1)?.you, 'late joiner: keyframe, no own tank yet')
  coop.game.debugKillAll()
  check(run(r, 1500, () => coop.game.state === 4 && coop.players === 3) > 0, 'mission 2 starts with 3 players')
  r.step()
  r.step()
  check(!!c[2].snaps.at(-1)?.you, 'the late joiner now drives a tank')
  check(!r.info(m2).members[2].spectating, 'no longer spectating')
  // rejoin
  r.detach(m0)
  check(!r.info(null).members[0].connected, 'detached member shows as away')
  const c0b = new Fake()
  r.attach(m0, c0b)
  r.step()
  r.step()
  check(c0b.last('stage') && c0b.snaps[0]?.key, 'reattach: stage + keyframe')
}

console.log('result gates (1 player, game over)')
{
  const r = new Room('TEST2', 'Test', false, 4, deps)
  const c = new Fake()
  const m = r.add('t0', 'A', c)!
  r.start()
  const coop = r.runner as CoopRunner
  const states = new Set<number>()
  for (let k = 0; k < 6 && coop.game.state < 9; k++) {
    run(r, 1500, () => coop.game.state === 4)
    coop.game.debugKillPlayers()
    run(r, 5, () => false)
  }
  run(r, 2000, () => (states.add(coop.game.state), coop.game.state === 10))
  check(coop.game.state === 10, 'game over reaches the result list')
  run(r, 300)
  check(coop.game.state === 10, 'the result list waits for the host')
  r.gate(m, 'result')
  run(r, 5)
  check(coop.game.state === 11, 'gate "result" moves on to the medal screen')
  r.gate(m, 'medal')
  run(r, 5)
  check(coop.game.state === 12 && r.state === 'ended', 'gate "medal": game ended, room waits for the host')
  const ui = c.snaps.flatMap((s) => s.json?.e ?? []).filter((e) => e[0] === 'u').map((e) => e[1])
  check(['fadeStart', 'hudIn', 'failedMsgShow', 'resultStart', 'medalStart'].every((n) => ui.includes(n)), `layout calls forwarded (${[...new Set(ui)].join(', ')})`)
  check(!r.start() && r.state === 'playing', 'play again restarts')
}

console.log('versus')
{
  const r = new Room('TEST3', 'Test', false, 4, deps)
  const c = [new Fake(), new Fake(), new Fake()]
  r.add('t0', 'A', c[0])
  r.add('t1', 'B', c[1])
  r.setSettings({ mode: 'versus', rounds: 2, ai: 1, arena: 2 })
  check(!r.start(), 'versus starts')
  const vs = r.runner as VersusRunner
  check(run(r, 400, () => vs.meta().vs!.phase === 'play') > 0, 'round 1 starts')
  check(vs.world!.enemyAliveNum === 1, 'one AI tank')
  const t1 = vs.world!.playerTanks[1]
  t1.lives = 0
  t1.explode(1, 'shell') // P1's shell (hit id 1)
  check(run(r, 200, () => vs.meta().vs!.phase === 'result') > 0, 'round over')
  check(vs.meta().vs!.winner === 0 && vs.meta().vs!.scores[0] === 1, 'P1 wins the round')
  check(vs.meta().vs!.frags[0] === 1, 'P1 credited with the frag')
  const m2 = r.add('t2', 'C', c[2])!
  check(run(r, 400, () => vs.meta().vs!.round === 2) > 0, 'round 2')
  check(vs.players === 3 && vs.world!.players === 3, 'the late joiner plays from round 2')
  run(r, 400, () => vs.meta().vs!.phase === 'play')
  for (const i of [1, 2]) {
    const t = vs.world!.playerTanks[i]
    t.lives = 0
    t.explode(9, 'shell') // the AI's
  }
  check(run(r, 600, () => r.state === 'ended') > 0, 'match over at 2 round wins')
  check(vs.meta().vs!.winner === 0 && vs.meta().st === 12, 'P1 wins the match')
  const kinds = new Set(c[0].snaps.flatMap((s) => s.json?.e ?? []).map((e) => e[0]))
  check(kinds.has('td') && kinds.has('b'), `events forwarded (${[...kinds].join(' ')})`)
  r.toLobby()
  r.remove(r.members[1])
  check(r.members.map((m) => m.slot).join() === '0,1' && m2.slot === 1, 'lobby compacts the slots (colours)')
}

console.log('bandwidth model (snapshot sizes)')
{
  const r = new Room('TEST4', 'Test', false, 4, deps)
  const c = [new Fake(), new Fake(), new Fake(), new Fake()]
  c.forEach((x, i) => r.add('t' + i, 'P' + i, x))
  r.setSettings({ mission: 9 })
  r.start()
  const coop = r.runner as CoopRunner
  run(r, 1500, () => coop.game.state === 4)
  const sizes: number[] = []
  const conn = c[0] as Fake & { send: Conn['send'] }
  const orig = conn.send.bind(conn)
  conn.send = (d) => {
    if (typeof d !== 'string') sizes.push(d.length)
    orig(d)
  }
  run(r, 600)
  const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length
  console.log(`  mission 10, 4 players idle: ${sizes.length} snapshots in 10 s, avg ${avg.toFixed(0)} B, max ${Math.max(...sizes)} B -> ${((avg * sizes.length) / 10 / 1024).toFixed(2)} KB/s`)
  check(avg < 400, 'snapshots stay small')
}

console.log(failures ? `${failures} failure(s)` : 'all checks passed')
process.exit(failures ? 1 : 0)
