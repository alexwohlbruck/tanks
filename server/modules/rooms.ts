// Online rooms: lobby, matchmaking and the realtime game (see docs/netcode.md).
//   WS  /ws/rooms            control (JSON) + input / snapshots (binary), src/net/protocol.ts
//   GET /api/rooms           public rooms
//   GET /api/rooms/<CODE>    one room (join links check it exists)
// Env: ROOMS_MAX (default 200), LEVELS_URL (pack lookup base, default http://127.0.0.1:$PORT/api/levels)

import type { ServerWebSocket } from 'bun'
import { readFileSync } from 'node:fs'
import { normalizeData, type GameData } from '../../src/data'
import { validateLevel, type LevelDef, type LevelPack } from '../../src/levels/format'
import { CODE_ALPHABET, cleanName, decodeInput, normalizeCode, PROTO_VERSION, type C2S, type S2C } from '../../src/net/protocol'
import { setTankRecords } from '../../src/sim/stats'
import { register } from '../index'
import { json, type WsData } from '../module'
import { Room, type Conn, type Member } from '../net/room'

const MAX_ROOMS = Number(process.env.ROOMS_MAX ?? 200)
const MAX_TEXT = 512 * 1024
const PORT = Number(process.env.PORT ?? 3001)
const LEVELS_URL = process.env.LEVELS_URL ?? `http://127.0.0.1:${PORT}/api/levels`

// ---- game data (public/assets/data, generated from the disc) ---------------------------------

let gameData: GameData | null = null
function data(): GameData {
  if (gameData) return gameData
  const base = new URL('../../public/assets/data/', import.meta.url)
  const params = JSON.parse(readFileSync(new URL('params.json', base), 'utf8'))
  const maps = JSON.parse(readFileSync(new URL('maps.json', base), 'utf8'))
  gameData = normalizeData({ params, maps })
  setTankRecords(gameData.params.tanks)
  return gameData
}

// ---- packs -----------------------------------------------------------------------------------

/** accepts a LevelPack, { pack }, { levels }, or a single LevelDef */
export function parsePack(raw: unknown): LevelPack {
  let p = raw as any
  if (p && typeof p === 'object' && p.pack) p = p.pack
  if (p && typeof p === 'object' && Array.isArray(p.cells)) p = { v: 1, name: p.name ?? 'Level', levels: [p] }
  if (!p || typeof p !== 'object' || !Array.isArray(p.levels)) throw new Error('not a level pack')
  const levels: LevelDef[] = p.levels.slice(0, 100)
  if (!levels.length) throw new Error('the pack has no levels')
  levels.forEach((l, i) => {
    const errs = validateLevel({ ...l, v: 1 } as LevelDef)
    if (errs.length) throw new Error(`level ${i + 1}: ${errs[0]}`)
  })
  const lives = typeof p.lives === 'number' ? Math.max(1, Math.min(9, Math.round(p.lives))) : undefined
  return { v: 1, id: typeof p.id === 'string' ? p.id : undefined, name: cleanName(p.name) || 'Custom pack', levels: levels.map((l) => ({ ...l, v: 1 })), lives }
}

async function resolvePack(id: string): Promise<LevelPack> {
  const safe = encodeURIComponent(id)
  for (const url of [`${LEVELS_URL}/packs/${safe}`, `${LEVELS_URL}/${safe}`]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) })
      if (r.ok) return parsePack(await r.json())
    } catch {}
  }
  throw new Error(`level pack "${id}" not found`)
}

// ---- rooms -----------------------------------------------------------------------------------

const rooms = new Map<string, Room>()

function newCode() {
  for (;;) {
    let c = ''
    for (let i = 0; i < 5; i++) c += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0]
    if (!rooms.has(c)) return c
  }
}

const deps = {
  data,
  resolvePack,
  onEmpty: (r: Room) => rooms.delete(r.code),
}

// ---- clients ---------------------------------------------------------------------------------

/** token bucket: `rate` per second, up to `burst` */
class Bucket {
  private t = performance.now()
  private n: number
  constructor(
    private rate: number,
    private burst: number,
  ) {
    this.n = burst
  }
  take() {
    const now = performance.now()
    this.n = Math.min(this.burst, this.n + ((now - this.t) / 1000) * this.rate)
    this.t = now
    if (this.n < 1) return false
    this.n--
    return true
  }
}

type Client = {
  ws: ServerWebSocket<WsData>
  conn: Conn
  ip: string
  token: string
  name: string
  hello: boolean
  member: Member | null
  room: Room | null
  ctl: Bucket
  inp: Bucket
  dropped: number
}

const clients = new Map<ServerWebSocket<WsData>, Client>()
/** token -> where that player sits (survives reconnects) */
const seats = new Map<string, { room: Room; member: Member }>()
const createLimit = new Map<string, Bucket>()
const perIp = new Map<string, number>()

const send = (c: Client, m: S2C) => c.conn.send(JSON.stringify(m))
const err = (c: Client, msg: string) => send(c, { t: 'error', msg })
const token = () => crypto.randomUUID().replace(/-/g, '')

function listPublic() {
  return [...rooms.values()].filter((r) => r.isPublic && r.members.length).map((r) => r.listing())
}

function seat(c: Client, room: Room, member: Member) {
  c.room = room
  c.member = member
  seats.set(c.token, { room, member })
}

function leave(c: Client) {
  const { room, member } = c
  c.room = null
  c.member = null
  seats.delete(c.token)
  if (room && member) room.remove(member)
  send(c, { t: 'room', room: null })
}

function joinRoom(c: Client, room: Room) {
  if (c.room === room) return room.broadcastRoom()
  if (c.room) leave(c)
  const m = room.add(c.token, c.name, c.conn)
  if (!m) return err(c, 'that room is full')
  seat(c, room, m)
}

function createRoom(c: Client, isPublic: boolean, maxPlayers: number) {
  if (rooms.size >= MAX_ROOMS) return err(c, 'the server is full, try again later')
  let b = createLimit.get(c.ip)
  if (!b) createLimit.set(c.ip, (b = new Bucket(10 / 60, 10)))
  if (!b.take()) return err(c, 'too many rooms created, wait a minute')
  const max = Math.max(1, Math.min(4, Math.round(Number(maxPlayers) || 4)))
  const room = new Room(newCode(), `${c.name || 'Player'}'s room`, !!isPublic, max, deps)
  rooms.set(room.code, room)
  joinRoom(c, room)
}

function handle(c: Client, m: C2S) {
  if (m.t === 'ping') {
    send(c, { t: 'pong', c: Number(m.c) || 0, tick: c.room?.tick ?? 0 })
    if (c.member && typeof m.rtt === 'number' && Number.isFinite(m.rtt)) c.member.ping = Math.max(0, Math.min(9999, m.rtt))
    return
  }
  if (m.t === 'hello') {
    c.name = cleanName(m.name) || 'Player'
    c.hello = true
    const s = typeof m.token === 'string' ? seats.get(m.token) : undefined
    if (s && rooms.get(s.room.code) === s.room && s.room.members.includes(s.member)) {
      // rejoin: same seat, same slot; an older socket for the token is dropped
      c.token = m.token!
      for (const o of clients.values()) if (o !== c && o.token === c.token) o.ws.close(4000, 'replaced')
      send(c, { t: 'welcome', token: c.token, v: PROTO_VERSION, tick: s.room.tick })
      s.member.name = c.name
      seat(c, s.room, s.member)
      s.room.attach(s.member, c.conn)
      return
    }
    if (typeof m.token === 'string' && /^[a-f0-9]{32}$/.test(m.token)) c.token = m.token
    send(c, { t: 'welcome', token: c.token, v: PROTO_VERSION, tick: 0 })
    send(c, { t: 'room', room: null })
    return
  }
  if (!c.hello) return err(c, 'say hello first')
  const room = c.room
  const member = c.member
  switch (m.t) {
    case 'name':
      c.name = cleanName(m.name) || c.name
      if (member && room) {
        member.name = c.name
        room.broadcastRoom()
      }
      return
    case 'list':
      return send(c, { t: 'rooms', rooms: listPublic() })
    case 'create':
      return createRoom(c, !!m.public, m.maxPlayers)
    case 'join': {
      const r = rooms.get(normalizeCode(String(m.code ?? '')))
      if (!r) return err(c, 'no room with that code')
      return joinRoom(c, r)
    }
    case 'quick': {
      const open = [...rooms.values()].filter((r) => r.isPublic && r.members.length && !r.full && r.state !== 'ended').sort((a, b) => b.members.length - a.members.length || +(a.state !== 'lobby') - +(b.state !== 'lobby'))
      if (open[0]) return joinRoom(c, open[0])
      return createRoom(c, true, 4)
    }
    case 'leave':
      return leave(c)
  }
  if (!room || !member) return err(c, 'not in a room')
  const host = room.isHost(member)
  room.lastActive = Date.now()
  switch (m.t) {
    case 'settings': {
      if (!host) return err(c, 'only the host can change the game')
      if (room.state !== 'lobby') return err(c, 'the game is running')
      if (m.settings && typeof m.settings === 'object') room.setSettings(m.settings)
      if (m.pack) {
        try {
          room.setPack(parsePack(m.pack))
        } catch (e) {
          err(c, (e as Error).message)
        }
      } else if (m.settings && typeof m.settings.packId === 'string' && m.settings.packId.trim()) {
        const id = m.settings.packId.trim().slice(0, 80)
        resolvePack(id)
          .then((p) => room.setPack(p, id))
          .catch((e) => err(c, (e as Error).message))
      }
      return
    }
    case 'start': {
      if (!host) return err(c, 'only the host can start')
      if (room.state === 'playing') return
      const e = room.start()
      if (e) err(c, e)
      return
    }
    case 'end':
      if (!host) return err(c, 'only the host decides')
      if (room.state !== 'ended') return
      if (m.choice === 'again') {
        const e = room.start()
        if (e) err(c, e)
      } else room.toLobby()
      return
    case 'gate':
      if (m.g === 'result' || m.g === 'totals' || m.g === 'winner' || m.g === 'medal') room.gate(member, m.g)
      return
  }
}

function ipOf(req: Request) {
  return (req.headers.get('x-forwarded-for')?.split(',')[0] ?? req.headers.get('x-real-ip') ?? 'local').trim()
}

register({
  name: 'rooms',
  http(req, url) {
    if (req.method !== 'GET') return
    if (url.pathname === '/api/rooms') return json({ rooms: listPublic() })
    const m = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{3,8})$/)
    if (m) {
      const r = rooms.get(normalizeCode(m[1]))
      return r ? json({ room: r.listing() }) : json({ error: 'not found' }, 404)
    }
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
      const c: Client = {
        ws,
        ip,
        token: token(),
        name: 'Player',
        hello: false,
        member: null,
        room: null,
        ctl: new Bucket(20, 60),
        inp: new Bucket(130, 260),
        dropped: 0,
        conn: {
          send: (d) => {
            ws.send(d)
          },
          buffered: () => ws.getBufferedAmount(),
          close: (code, reason) => ws.close(code, reason),
        },
      }
      clients.set(ws, c)
    },
    message(ws, msg) {
      const c = clients.get(ws)
      if (!c) return
      if (typeof msg !== 'string') {
        // input frames
        if (!c.inp.take()) {
          if (++c.dropped > 2000) ws.close(4008, 'rate limit')
          return
        }
        const i = decodeInput(msg)
        if (i && c.member && c.room?.runner) c.member.pushInput(i)
        return
      }
      if (msg.length > MAX_TEXT) return ws.close(4009, 'message too big')
      if (!c.ctl.take()) {
        if (++c.dropped > 2000) ws.close(4008, 'rate limit')
        return err(c, 'slow down')
      }
      let m: C2S
      try {
        m = JSON.parse(msg)
      } catch {
        return err(c, 'bad message')
      }
      if (!m || typeof m !== 'object' || typeof m.t !== 'string') return err(c, 'bad message')
      try {
        handle(c, m)
      } catch (e) {
        console.error('[rooms]', e)
        err(c, 'server error')
      }
    },
    close(ws) {
      const c = clients.get(ws)
      clients.delete(ws)
      if (!c) return
      perIp.set(c.ip, Math.max(0, (perIp.get(c.ip) ?? 1) - 1))
      // keep the seat for REJOIN_MS (a reload or a network blip reconnects into it)
      if (c.room && c.member && c.member.conn === c.conn) c.room.detach(c.member)
    },
  },
})

// ---- 60 Hz loop ------------------------------------------------------------------------------

setInterval(() => {
  const now = performance.now()
  for (const r of rooms.values()) {
    try {
      r.advance(now)
    } catch (e) {
      console.error(`[rooms] ${r.code} crashed`, e)
      r.toLobby()
    }
  }
}, 4)

setInterval(() => {
  const now = Date.now()
  for (const r of [...rooms.values()]) {
    r.expire(now)
    r.refreshPings()
    // idle lobbies go away after an hour
    if (r.state === 'lobby' && now - r.lastActive > 3600_000) for (const m of [...r.members]) r.remove(m)
  }
  for (const [t, s] of seats) if (!rooms.has(s.room.code) || !s.room.members.includes(s.member)) seats.delete(t)
}, 1000)

/** for tests: live rooms */
export const _rooms = rooms
