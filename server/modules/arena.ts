// Arena: the massively-multiplayer mode (src/arena). Arenas run on their own 60 Hz loop; a
// player joins the fullest arena of the chosen mode with room left (a new one when all are
// full). Bots fill every arena up to BOT_FILL tanks.
//   WS  /ws/arena        JSON, src/arena/protocol.ts
//   GET /api/arena       arenas and player counts

import type { ServerWebSocket } from 'bun'
import { botThink } from '../../src/arena/bot'
import { ARENA_PROTO, r1, type Board, type C2S, type NetEv, type S2C, type YouRec } from '../../src/arena/protocol'
import { ARENA_TPS, BOT_FILL, MAX_HUMANS, PICKUP_KINDS, SNAPSHOT_EVERY, WHITE_REVEAL, type ArenaMode } from '../../src/arena/rules'
import { ArenaSim, IDLE_INPUT, type ArenaEvent, type ArenaInput, type Player } from '../../src/arena/sim'
import { cleanName } from '../../src/net/protocol'
import { register } from '../index'
import { json, type WsData } from '../module'
import { ipOf, loadGameData } from './rooms'
import { TF_ALIVE, TF_POWER_SHIFT, TF_PROTECT, TF_STEALTH } from '../../src/arena/protocol'

const MAX_ARENAS = Number(process.env.ARENAS_MAX ?? 16)
const MAX_QUEUE = 6
const STALE_TICKS = 8
const MAX_BUFFERED = 512 * 1024
/** what a client is sent around its tank (world units, half extents) */
const VIEW = { x: 1500, z: 1100 }

type Client = {
  ws: ServerWebSocket<WsData>
  ip: string
  arena: Arena | null
  player: Player | null
  queue: ArenaInput[]
  last: ArenaInput
  lastRecv: number
  ack: number
  empty: number
  minQueue: number
  window: number
  /** events for the next snapshot */
  pending: NetEv[]
  /** where the client looks from (its tank, or where it died) */
  focus: { x: number; z: number }
  tokens: number
  tokenAt: number
}

let nextArena = 1

class Arena {
  sim: ArenaSim
  clients = new Set<Client>()
  id = `A${nextArena++}`
  private nextAt = performance.now()
  emptySince = Date.now()

  constructor(public mode: ArenaMode) {
    loadGameData()
    this.sim = new ArenaSim(mode)
    this.balanceBots()
  }

  get humans() {
    return this.sim.players.filter((p) => !p.bot).length
  }

  balanceBots() {
    const s = this.sim
    const want = Math.max(0, BOT_FILL - this.humans)
    let bots = s.players.filter((p) => p.bot)
    while (bots.length < want) {
      s.addPlayer(s.botName(), true)
      bots = s.players.filter((p) => p.bot)
    }
    while (bots.length > want) {
      // the bot on the bigger team leaves (teams), else the lowest scorer
      const n = [0, 0]
      for (const p of s.players) n[p.team]++
      const pool = s.mode === 'teams' ? bots.filter((b) => b.team === (n[0] > n[1] ? 0 : 1)) : bots
      const out = (pool.length ? pool : bots).sort((a, b) => a.score - b.score)[0]
      s.removePlayer(out)
      bots = s.players.filter((p) => p.bot)
    }
    // keep teams even: move a bot across when one side has two more
    if (s.mode === 'teams') {
      const n = [0, 0]
      for (const p of s.players) n[p.team]++
      if (Math.abs(n[0] - n[1]) >= 2) {
        const from = n[0] > n[1] ? 0 : 1
        const b = bots.find((x) => x.team === from)
        if (b) {
          s.removePlayer(b)
          s.addPlayer(b.name, true)
        }
      }
    }
  }

  join(c: Client, name: string) {
    const p = this.sim.addPlayer(name, false)
    c.arena = this
    c.player = p
    c.queue = []
    c.last = { ...IDLE_INPUT }
    c.lastRecv = -1
    c.ack = 0
    c.pending = []
    this.clients.add(c)
    this.balanceBots()
    send(c, {
      t: 'welcome',
      v: ARENA_PROTO,
      arena: this.id,
      pid: p.pid,
      tank: p.tank.id,
      mode: this.mode,
      seed: this.sim.map.seed,
      broken: this.sim.broken,
      tick: this.sim.tick,
      online: totalHumans(),
    })
    send(c, this.board(c))
  }

  leave(c: Client) {
    if (c.player) this.sim.removePlayer(c.player)
    this.clients.delete(c)
    c.arena = null
    c.player = null
    this.balanceBots()
    if (!this.clients.size) this.emptySince = Date.now()
  }

  advance(now: number) {
    const dt = 1000 / ARENA_TPS
    if (now - this.nextAt > 250) this.nextAt = now - dt
    while (now >= this.nextAt) {
      this.nextAt += dt
      this.tick()
    }
  }

  private tick() {
    const s = this.sim
    for (const c of this.clients) if (c.player) nextInput(c)
    for (const p of s.players) if (p.bot) botThink(s, p)
    const seed = s.map.seed
    s.step()
    const ev = s.events
    s.events = []
    if (s.map.seed !== seed) for (const c of this.clients) send(c, { t: 'map', seed: s.map.seed, tick: s.tick })
    for (const c of this.clients) {
      const t = c.player?.tank
      if (t?.alive) c.focus = { x: t.pos.x, z: t.pos.z }
      for (const e of ev) {
        const n = toNet(e, c)
        if (n) c.pending.push(n)
      }
    }
    if (s.tick % SNAPSHOT_EVERY === 0) for (const c of this.clients) this.snapshot(c)
    if (s.tick % 30 === 0) for (const c of this.clients) send(c, this.board(c))
  }

  private snapshot(c: Client) {
    const s = this.sim
    const p = c.player
    if (!p) return
    if (c.ws.getBufferedAmount() > MAX_BUFFERED) return
    const near = (x: number, z: number) => Math.abs(x - c.focus.x) < VIEW.x && Math.abs(z - c.focus.z) < VIEW.z
    const T = s.tanks
      .filter((t) => t.alive && near(t.pos.x, t.pos.z))
      .map((t) => {
        const [b, tu] = ArenaSim.headings(t)
        const pw = t.power ? PICKUP_KINDS.indexOf(t.power) + 1 : 0
        // White: enemies only see its tracks, except right after it fires
        const hidden = t.power === 'white' && s.enemies(p, t.player) && s.tick - t.firedAt > WHITE_REVEAL
        const flags = (t.alive ? TF_ALIVE : 0) | (s.tick < t.protectUntil ? TF_PROTECT : 0) | (hidden ? TF_STEALTH : 0) | (pw << TF_POWER_SHIFT)
        return [t.id, r1(t.pos.x), r1(t.pos.z), Math.round(b * 1000) / 1000, Math.round(tu * 1000) / 1000, flags, t.player.pid] as [number, number, number, number, number, number, number]
      })
    const S = s.shells.filter((x) => near(x.pos.x, x.pos.z)).map((x) => [x.id, r1(x.pos.x), r1(x.pos.z), r1(x.vel.x * 10) / 10, r1(x.vel.z * 10) / 10, x.smoke] as [number, number, number, number, number, number])
    const M = s.mines.filter((m) => m.state !== 2 && near(m.pos.x, m.pos.z)).map((m) => [m.id, r1(m.pos.x), r1(m.pos.z), m.fuseLit ? 1 : 0] as [number, number, number, number])
    const K = s.pickups.map((k) => [k.id, k.x, k.z, k.kind] as [number, number, number, (typeof k)['kind']])
    const t = p.tank
    const pc = t.pc
    const st = s.stats(t)
    const you: YouRec = {
      a: c.ack,
      x: t.pos.x,
      z: t.pos.z,
      vx: t.vel.x,
      vz: t.vel.z,
      fx: t.rot.z.x,
      fz: t.rot.z.z,
      sp: pc.speed,
      sg: pc.sign,
      fr: pc.freeze,
      st: pc.shellTimer,
      mt: pc.mineTimer,
      alive: t.alive ? 1 : 0,
      respawn: t.alive ? 0 : Math.max(0, t.respawnAt - s.tick),
      protect: Math.max(0, t.protectUntil - s.tick),
      power: t.power,
      powerLeft: t.power ? t.powerUntil - s.tick : 0,
      shells: st.maxShells - s.shells.filter((x) => x.owner === t).length,
      mines: st.maxMines - s.mines.filter((m) => m.owner === t && m.state !== 2).length,
      maxShells: st.maxShells,
      maxMines: st.maxMines,
    }
    send(c, { t: 's', k: s.tick, T, S, M, K, E: c.pending, you })
    c.pending = []
  }

  board(c: Client): Board {
    const s = this.sim
    const me = c.player
    const mm: [number, number, number][] = []
    for (const t of s.tanks) {
      if (!t.alive || !me) continue
      const friend = t.player === me || (s.mode === 'teams' && t.player.team === me.team)
      if (friend || s.tick - t.firedAt < 120) mm.push([t.player.pid, Math.round(t.pos.x), Math.round(t.pos.z)])
    }
    return {
      t: 'board',
      players: s.players.map((p) => [p.pid, p.name, p.team, p.color, p.kills, p.deaths, p.score, p.bot ? 1 : 0]),
      teams: s.teamScore,
      state: s.state,
      secs: s.secondsLeft,
      winner: s.winner,
      mm,
    }
  }
}

/** sim event -> wire, if this client should hear about it */
function toNet(e: ArenaEvent, c: Client): NetEv | null {
  const near = (x: number, z: number) => Math.abs(x - c.focus.x) < VIEW.x + 200 && Math.abs(z - c.focus.z) < VIEW.z + 200
  switch (e.t) {
    case 'kill':
      return ['kill', e.tank, r1(e.x), r1(e.z), e.victim, e.killer, e.cause, e.streak]
    case 'break':
      return ['brk', e.c, e.r, e.h]
    case 'match':
      return ['match', e.state]
    case 'pickup':
      return ['pick', e.tank, e.kind, r1(e.x), r1(e.z)]
  }
  if (!near(e.x, e.z)) return null
  switch (e.t) {
    case 'shot':
      return ['shot', e.tank, r1(e.x), r1(e.z), e.smoke, e.type]
    case 'ricochet':
      return ['ric', r1(e.x), r1(e.z)]
    case 'shellDie':
      return ['die', r1(e.x), r1(e.z), e.wall ? 1 : 0]
    case 'clash':
      return ['clash', r1(e.x), r1(e.z)]
    case 'mineSet':
      return ['mset', r1(e.x), r1(e.z)]
    case 'mineFuse':
      return ['fuse', e.id, r1(e.x), r1(e.z)]
    case 'boom':
      return ['boom', r1(e.x), r1(e.z)]
    case 'spawn':
      return ['spawn', e.tank, r1(e.x), r1(e.z)]
  }
  return null
}

/** one queued input per tick; a small adaptive jitter buffer like the rooms' (server/net/room.ts) */
function nextInput(c: Client) {
  const p = c.player!
  c.minQueue = Math.min(c.minQueue, c.queue.length)
  if (++c.window >= 30) {
    if (c.minQueue >= 2) mergeOldest(c)
    c.minQueue = 99
    c.window = 0
  }
  const i = c.queue.shift()
  if (i) {
    c.ack = i.seq
    c.last = i
    c.empty = 0
    p.input = i
    p.wantFire ||= i.fire
    p.wantMine ||= i.mine
    return
  }
  const stale = ++c.empty > STALE_TICKS
  p.input = { ...c.last, fire: false, mine: false, mx: stale ? 0 : c.last.mx, mz: stale ? 0 : c.last.mz }
}

function mergeOldest(c: Client) {
  const [a, b] = c.queue
  if (!b) return
  b.fire ||= a.fire
  b.mine ||= a.mine
  c.queue.shift()
}

const arenas = new Map<string, Arena>()
const clients = new Map<ServerWebSocket<WsData>, Client>()
const perIp = new Map<string, number>()

const send = (c: Client, m: S2C) => {
  if (c.ws.readyState === 1) c.ws.send(JSON.stringify(m))
}
const totalHumans = () => [...arenas.values()].reduce((a, r) => a + r.humans, 0)

function pickArena(mode: ArenaMode): Arena | null {
  const open = [...arenas.values()].filter((a) => a.mode === mode && a.humans < MAX_HUMANS).sort((a, b) => b.humans - a.humans)
  if (open[0]) return open[0]
  if (arenas.size >= MAX_ARENAS) return null
  const a = new Arena(mode)
  arenas.set(a.id, a)
  return a
}

const num = (v: unknown, lo: number, hi: number) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0
}

function onMessage(c: Client, raw: string | Buffer) {
  if (typeof raw !== 'string' || raw.length > 2048) return
  // rate limit: ~2x the input rate
  const now = performance.now()
  c.tokens = Math.min(240, c.tokens + ((now - c.tokenAt) / 1000) * 150)
  c.tokenAt = now
  if (c.tokens < 1) return
  c.tokens--
  let m: C2S
  try {
    m = JSON.parse(raw)
  } catch {
    return
  }
  switch (m.t) {
    case 'ping':
      return send(c, { t: 'pong', c: Number(m.c) || 0 })
    case 'join': {
      if (m.v !== ARENA_PROTO) return send(c, { t: 'error', message: 'The game was updated: reload the page.' })
      const mode: ArenaMode = m.mode === 'teams' ? 'teams' : 'ffa'
      if (c.arena) c.arena.leave(c)
      const a = pickArena(mode)
      if (!a) return send(c, { t: 'error', message: 'Every arena is full. Try again in a minute.' })
      a.join(c, cleanName(m.name) || 'Player')
      return
    }
    case 'leave':
      return c.arena?.leave(c)
    case 'dev': {
      const t = c.player?.tank
      if (!process.env.ARENA_DEV || !t || !(PICKUP_KINDS as string[]).includes(m.power)) return
      t.power = m.power as (typeof PICKUP_KINDS)[number]
      t.powerUntil = c.arena!.sim.tick + 60 * 60
      return
    }
    case 'i': {
      if (!c.player) return
      const seq = num(m.s, 0, 2 ** 31)
      if (seq <= c.lastRecv) return
      c.lastRecv = seq
      const W = 5000
      c.queue.push({ seq, mx: num(m.mx, -1, 1), mz: num(m.mz, -1, 1), analog: !!m.an, ax: num(m.ax, -W, W), az: num(m.az, -W, W), fire: !!m.f, mine: !!m.m })
      while (c.queue.length > MAX_QUEUE) mergeOldest(c)
      return
    }
  }
}

register({
  name: 'arena',
  http(req, url) {
    if (req.method === 'GET' && url.pathname === '/api/arena')
      return json({ arenas: [...arenas.values()].map((a) => ({ id: a.id, mode: a.mode, humans: a.humans, players: a.sim.players.length })), online: totalHumans() })
  },
  ws: {
    upgrade(req) {
      const ip = ipOf(req)
      if ((perIp.get(ip) ?? 0) >= 16) return new Response('too many connections', { status: 429 })
      return { ip }
    },
    open(ws) {
      const ip = String(ws.data.ip ?? 'local')
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1)
      clients.set(ws, { ws, ip, arena: null, player: null, queue: [], last: { ...IDLE_INPUT }, lastRecv: -1, ack: 0, empty: 0, minQueue: 99, window: 0, pending: [], focus: { x: 0, z: 0 }, tokens: 240, tokenAt: performance.now() })
    },
    message(ws, msg) {
      const c = clients.get(ws)
      if (c) onMessage(c, msg as string)
    },
    close(ws) {
      const c = clients.get(ws)
      clients.delete(ws)
      if (!c) return
      perIp.set(c.ip, Math.max(0, (perIp.get(c.ip) ?? 1) - 1))
      c.arena?.leave(c)
    },
  },
})

setInterval(() => {
  const now = performance.now()
  for (const a of arenas.values()) {
    try {
      a.advance(now)
    } catch (e) {
      console.error(`[arena] ${a.id} crashed`, e)
      for (const c of [...a.clients]) {
        send(c, { t: 'error', message: 'The arena crashed. Rejoin to play on.' })
        a.leave(c)
      }
      arenas.delete(a.id)
    }
  }
}, 4)

// arenas without players close after a minute
setInterval(() => {
  const now = Date.now()
  for (const a of [...arenas.values()]) if (!a.clients.size && now - a.emptySince > 60_000) arenas.delete(a.id)
}, 5000)
