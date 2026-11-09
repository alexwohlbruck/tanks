// Arena: the massively-multiplayer mode (src/arena). Arenas run on their own 60 Hz loop; a
// player joins the fullest arena of the chosen mode with room left (a new one when all are
// full). Bots fill every arena up to BOT_FILL tanks.
//   WS  /ws/arena                 JSON, src/arena/protocol.ts
//   GET /api/arena                arenas and player counts
//   GET /api/arena/leaders?id=    top 10 today / all time (server/arena/stats.ts)
//   GET /api/arena/me?id=         one player's lifetime stats
// Invite links (?arena=A3&with=<pid>) join that arena, on the inviting player's team.

import type { ServerWebSocket } from 'bun'
import { botThink } from '../../src/arena/bot'
import { ARENA_PROTO, r1, type Board, type C2S, type NetEv, type S2C, type YouRec } from '../../src/arena/protocol'
import { ARENA_TPS, BOT_FILL, EMOTES, MAX_HUMANS, PICKUP_KINDS, SNAPSHOT_EVERY, WHITE_REVEAL, type ArenaMode } from '../../src/arena/rules'
import { ArenaSim, IDLE_INPUT, type ArenaEvent, type ArenaInput, type Player } from '../../src/arena/sim'
import { cleanName } from '../../src/net/protocol'
import { register } from '../index'
import { json, type WsData } from '../module'
import { ipOf, loadGameData } from './rooms'
import { addStats, emptyDelta, isStatId, leaders, playerStats, type StatDelta } from '../arena/stats'
import { TF_ALIVE, TF_POWER_SHIFT, TF_PROTECT, TF_STEALTH } from '../../src/arena/protocol'

const MAX_ARENAS = Number(process.env.ARENAS_MAX ?? 16)
const MAX_QUEUE = 6
const STALE_TICKS = 8
const MAX_BUFFERED = 512 * 1024
/** what a client is sent around its tank (world units, half extents) */
const VIEW = { x: 1500, z: 1100 }
/** one browser's tabs / one household: at most this many players per address in an arena */
const MAX_PER_IP = 6
const EMOTE_MS = 1500
const STATS_FLUSH_MS = 15_000

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
  /** stats id (null: stats off) and the numbers not yet written */
  statId: string | null
  stats: StatDelta
  statsAt: number
  playSince: number
  emoteAt: number
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

  /** `team`: an invite from a teammate (teams mode) */
  join(c: Client, name: string, team?: number) {
    const p = this.sim.addPlayer(name, false, team)
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
      theme: this.sim.map.theme,
      broken: this.sim.broken,
      tick: this.sim.tick,
      online: totalHumans(),
    })
    send(c, this.board(c))
  }

  leave(c: Client) {
    flushStats(c)
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
    if (s.map.seed !== seed) for (const c of this.clients) send(c, { t: 'map', seed: s.map.seed, theme: s.map.theme, tick: s.tick })
    this.tally(ev)
    for (const c of this.clients) {
      const t = c.player?.tank
      if (t?.alive) c.focus = { x: t.pos.x, z: t.pos.z }
      else {
        // waiting to respawn: the view follows whoever destroyed you
        const k = c.player?.killedBy?.tank
        if (k?.alive && s.players.includes(k.player)) c.focus = { x: k.pos.x, z: k.pos.z }
      }
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
      spec: !t.alive && p.killedBy?.tank.alive && s.players.includes(p.killedBy) ? p.killedBy.tank.id : 0,
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
      theme: s.map.theme,
      vote: s.state === 'over' && s.voteOptions.length ? { options: s.voteOptions, counts: s.voteOptions.map((o) => [...s.votes.values()].filter((v) => v === o).length), mine: (me && s.votes.get(me.pid)) || null } : null,
      arena: this.id,
    }
  }

  /** stats: kills / deaths / streaks as they happen, wins and matches at the end */
  private tally(ev: ArenaEvent[]) {
    const s = this.sim
    for (const e of ev) {
      if (e.t === 'kill') {
        for (const c of this.clients) {
          const p = c.player
          if (!p) continue
          if (p.pid === e.victim) c.stats.deaths++
          if (p.pid === e.killer && e.killer !== e.victim) {
            c.stats.kills++
            c.stats.best = Math.max(c.stats.best, e.streak)
          }
        }
      } else if (e.t === 'match' && e.state === 'over') {
        for (const c of this.clients) {
          if (!c.player) continue
          c.stats.matches++
          if (s.winners.includes(c.player)) c.stats.wins++
          flushStats(c)
        }
      }
    }
    const now = Date.now()
    for (const c of this.clients) if (now - c.statsAt > STATS_FLUSH_MS) flushStats(c)
  }

  /** quick chat: everyone who can see the tank (and the sender) */
  emote(c: Client, i: number) {
    const p = c.player
    if (!p || !Number.isInteger(i) || i < 0 || i >= EMOTES.length) return
    const now = Date.now()
    if (now - c.emoteAt < EMOTE_MS) return
    c.emoteAt = now
    const t = p.tank
    for (const o of this.clients)
      if (o === c || (Math.abs(t.pos.x - o.focus.x) < VIEW.x && Math.abs(t.pos.z - o.focus.z) < VIEW.z) || (this.mode === 'teams' && o.player?.team === p.team)) o.pending.push(['emo', p.pid, i])
  }
}

function flushStats(c: Client) {
  const p = c.player
  const now = Date.now()
  c.stats.seconds += (now - c.playSince) / 1000
  c.playSince = now
  c.statsAt = now
  if (c.statId && p) {
    try {
      addStats(c.statId, p.name, c.stats)
    } catch (e) {
      console.error('[arena] stats', e)
    }
  }
  c.stats = emptyDelta()
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

const fromIp = (a: Arena, ip: string) => [...a.clients].filter((c) => c.ip === ip).length

function pickArena(mode: ArenaMode, ip: string): Arena | null {
  const open = [...arenas.values()].filter((a) => a.mode === mode && a.humans < MAX_HUMANS && fromIp(a, ip) < MAX_PER_IP).sort((a, b) => b.humans - a.humans)
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
      let mode: ArenaMode = m.mode === 'teams' ? 'teams' : 'ffa'
      if (c.arena) c.arena.leave(c)
      c.statId = isStatId(m.id) ? m.id : null
      // an invite: that arena (its mode wins), on the inviting player's team
      const invited = typeof m.arena === 'string' ? arenas.get(m.arena) : undefined
      let team: number | undefined
      let a: Arena | null = null
      if (invited && invited.humans < MAX_HUMANS && fromIp(invited, c.ip) < MAX_PER_IP) {
        a = invited
        mode = a.mode
        const host = a.sim.players.find((p) => p.pid === Number(m.with) && !p.bot)
        if (host && mode === 'teams') team = host.team
      }
      a ??= pickArena(mode, c.ip)
      if (!a) return send(c, { t: 'error', message: 'Every arena is full. Try again in a minute.' })
      c.playSince = Date.now()
      c.statsAt = Date.now()
      a.join(c, cleanName(m.name) || 'Player', team)
      return
    }
    case 'emote':
      return c.arena?.emote(c, Number(m.i))
    case 'vote':
      if (c.arena && c.player && typeof m.theme === 'string') c.arena.sim.vote(c.player, m.theme)
      return
    case 'leave':
      return c.arena?.leave(c)
    case 'dev': {
      const t = c.player?.tank
      if (!process.env.ARENA_DEV || !t) return
      // 'end': finish the match now (results + map vote)
      if (m.power === 'end') return void (c.arena!.sim.phaseEnd = c.arena!.sim.tick)
      if (!(PICKUP_KINDS as string[]).includes(m.power)) return
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
    if (req.method !== 'GET') return
    if (url.pathname === '/api/arena')
      return json({ arenas: [...arenas.values()].map((a) => ({ id: a.id, mode: a.mode, humans: a.humans, players: a.sim.players.length })), online: totalHumans() })
    const id = url.searchParams.get('id')
    if (url.pathname === '/api/arena/leaders') return json(leaders(isStatId(id) ? id : undefined))
    if (url.pathname === '/api/arena/me') return json({ stats: isStatId(id) ? playerStats(id) : null })
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
      clients.set(ws, { ws, ip, arena: null, player: null, queue: [], last: { ...IDLE_INPUT }, lastRecv: -1, ack: 0, empty: 0, minQueue: 99, window: 0, pending: [], focus: { x: 0, z: 0 }, tokens: 240, tokenAt: performance.now(), statId: null, stats: emptyDelta(), statsAt: Date.now(), playSince: Date.now(), emoteAt: 0 })
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
