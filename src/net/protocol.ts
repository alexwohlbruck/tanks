// Online play protocol, shared by the client (src/net) and the game server (server/net).
// DOM-free: the server imports this file.
//
// Transport: one WebSocket per client at /ws/rooms.
//   text frames   JSON control messages (C2S / S2C below)
//   binary frames client -> server: input (12 bytes, every 60 Hz frame)
//                 server -> client: snapshot (30 Hz, delta against the previous one sent to
//                 that client; WebSocket is ordered and reliable, so no acks are needed)
// See docs/netcode.md.

import type { LevelPack } from '../levels/format'

export const PROTO_VERSION = 1
/** simulation rate (the original's 60 Hz frame) */
export const TICK_HZ = 60
export const TICK_MS = 1000 / TICK_HZ
/** a snapshot every N ticks (2 = 30 Hz) */
export const SNAPSHOT_EVERY = 2
export const MAX_ROOM_PLAYERS = 4
/** a disconnected player keeps their slot this long */
export const REJOIN_MS = 60_000
/** P1 blue, P2 red, P3 green, P4 yellow */
export const PLAYER_COLORS = ['#3d7be0', '#e0483f', '#38a84a', '#e6b923']
export const PLAYER_COLOR_NAMES = ['Blue', 'Red', 'Green', 'Yellow']

export type Mode = 'coop' | 'pack' | 'versus'

export type RoomSettings = {
  mode: Mode
  /** co-op classic: first mission (0-based) */
  mission: number
  /** co-op classic: all 100 missions instead of stopping after 20 */
  allMissions: boolean
  /** co-op pack: store id (resolved by the server) or the name of an inline pack */
  packId: string
  packName: string
  packLevels: number
  /** versus: rounds needed to win the match, AI tanks per round, arena index */
  rounds: number
  ai: number
  arena: number
}

export const DEFAULT_SETTINGS: RoomSettings = {
  mode: 'coop',
  mission: 0,
  allMissions: false,
  packId: '',
  packName: '',
  packLevels: 0,
  rounds: 3,
  ai: 0,
  arena: 0,
}

export type MemberInfo = {
  slot: number
  name: string
  host: boolean
  connected: boolean
  /** round trip in ms as measured by the client */
  ping: number
  /** joined while a game runs; plays from the next mission / round */
  spectating: boolean
}

export type RoomState = 'lobby' | 'playing' | 'ended'

export type RoomInfo = {
  code: string
  name: string
  public: boolean
  maxPlayers: number
  state: RoomState
  settings: RoomSettings
  members: MemberInfo[]
  /** the receiving client's slot */
  you: number
}

export type RoomListing = { code: string; name: string; mode: Mode; players: number; maxPlayers: number; state: RoomState }

// ---- JSON control messages ----------------------------------------------------------------

export type C2S =
  | { t: 'hello'; v: number; name: string; token?: string }
  | { t: 'name'; name: string }
  | { t: 'list' }
  | { t: 'create'; public: boolean; maxPlayers: number; name?: string }
  | { t: 'join'; code: string }
  /** join the fullest public room that has space, or create a public one */
  | { t: 'quick' }
  | { t: 'leave' }
  /** host, in the lobby; `pack` = an inline LevelPack for mode 'pack' */
  | { t: 'settings'; settings: Partial<RoomSettings>; pack?: LevelPack }
  | { t: 'start' }
  /** host, once the game has ended: play again or back to the room */
  | { t: 'end'; choice: 'again' | 'lobby' }
  /** the result screens finished on this client (the server waits for the host's) */
  | { t: 'gate'; g: Gate }
  | { t: 'ping'; c: number; rtt: number }

export type Gate = 'result' | 'totals' | 'winner' | 'medal'

/** stage (re)load: the client rebuilds its World from this */
export type StageMsg = {
  t: 'stage'
  tick: number
  gen: number
  players: number
  enemyCap: number
  /** current cell codes (destroyed blocks already removed) */
  cells: number[][]
  /** start balloon facing in degrees */
  facing: [number, number]
  rules: Record<string, unknown>
}

export type S2C =
  | { t: 'welcome'; token: string; v: number; tick: number }
  | { t: 'error'; msg: string }
  | { t: 'rooms'; rooms: RoomListing[] }
  | { t: 'room'; room: RoomInfo | null }
  /** a game started (or the client attached to a running one) */
  | { t: 'game'; mode: Mode; tick: number }
  | StageMsg
  | { t: 'pong'; c: number; tick: number }

// ---- game meta (JSON inside snapshots, sent when it changes) --------------------------------

export type VersusInfo = {
  round: number
  target: number
  /** round wins per player */
  scores: number[]
  /** tanks destroyed per player this match (players and AI) */
  frags: number[]
  phase: 'start' | 'play' | 'over' | 'result' | 'end'
  /** round / match winner (-1 draw) during 'result' / 'end' */
  winner: number
}

export type Meta = {
  mode: Mode
  /** Game.state */
  st: number
  stage: number
  last: number
  players: number
  lives: number[]
  kills: number[]
  /** [player, type, count] for non-zero killsByType entries */
  kt: [number, number, number][]
  order: number[]
  freeze: boolean
  enemies: number
  vs?: VersusInfo
}

/**
 * Discrete events, compact arrays (positions rounded to 0.1):
 *   ['s', name, x, z, slot]   one-shot SE (x/z null for system sounds, slot -1 without tank)
 *   ['b', name] ['bs', fade] ['bm', mask]    BGM start / stop / track mask
 *   ['sh', slot, fired]       shot effect at the tank's cannon
 *   ['r', x, y, z]            ricochet
 *   ['bd', x, y, z, reason]   shell died
 *   ['td', slot, x, z]        tank destroyed
 *   ['me', x, y, z]           mine explosion
 *   ['bb', col, row, height]  block destroyed
 *   ['st', slot]              stealth (White tank vanishes)
 *   ['u', method, ...args]    a Presenter call (layouts: fade, messages, HUD, results)
 */
export type NetEvent = (string | number | null | { x: number; z: number })[]

/** a looped SE that is sounding this tick: [key, name, x, z] */
export type Hold = [number, string, number, number]

// ---- binary: input (client -> server) ---------------------------------------------------------

export const BIN_SNAPSHOT = 1
export const BIN_INPUT = 2

export type NetInput = {
  seq: number
  /** drive direction, -1..1 (quantized to 1/127) */
  mx: number
  my: number
  analog: boolean
  fire: boolean
  mine: boolean
  /** aim point on the field, or null to keep the previous one */
  ax: number | null
  az: number | null
}

const q8 = (v: number) => Math.max(-127, Math.min(127, Math.round(v * 127)))
const qPos = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * 16)))
const qAim = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * 8)))
const qAng = (a: number) => Math.round(((((a / (2 * Math.PI)) % 1) + 1) % 1) * 65536) & 0xffff
const dAng = (u: number) => {
  const a = (u / 65536) * 2 * Math.PI
  return a > Math.PI ? a - 2 * Math.PI : a
}
const qAng8 = (a: number) => Math.round(((((a / (2 * Math.PI)) % 1) + 1) % 1) * 256) & 0xff
const dAng8 = (u: number) => (u / 256) * 2 * Math.PI

/** rounds an input to what the server will decode (client prediction uses the same values) */
export function quantizeInput(i: NetInput): NetInput {
  return {
    ...i,
    mx: q8(i.mx) / 127,
    my: q8(i.my) / 127,
    ax: i.ax === null ? null : qAim(i.ax) / 8,
    az: i.az === null ? null : qAim(i.az) / 8,
  }
}

export function encodeInput(i: NetInput): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(12)
  const v = new DataView(b.buffer)
  v.setUint8(0, BIN_INPUT)
  v.setUint32(1, i.seq >>> 0, true)
  v.setInt8(5, q8(i.mx))
  v.setInt8(6, q8(i.my))
  const aim = i.ax !== null && i.az !== null
  v.setUint8(7, (i.analog ? 1 : 0) | (i.fire ? 2 : 0) | (i.mine ? 4 : 0) | (aim ? 8 : 0))
  v.setInt16(8, aim ? qAim(i.ax!) : 0, true)
  v.setInt16(10, aim ? qAim(i.az!) : 0, true)
  return b
}

export function decodeInput(b: Uint8Array): NetInput | null {
  if (b.byteLength !== 12 || b[0] !== BIN_INPUT) return null
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const f = v.getUint8(7)
  const aim = !!(f & 8)
  return {
    seq: v.getUint32(1, true),
    mx: Math.max(-1, Math.min(1, v.getInt8(5) / 127)),
    my: Math.max(-1, Math.min(1, v.getInt8(6) / 127)),
    analog: !!(f & 1),
    fire: !!(f & 2),
    mine: !!(f & 4),
    ax: aim ? v.getInt16(8, true) / 8 : null,
    az: aim ? v.getInt16(10, true) / 8 : null,
  }
}

// ---- binary: snapshot (server -> client) -----------------------------------------------------

/** tank flags */
export const TF_ACTIVE = 1
export const TF_ALIVE = 2
export const TF_STEALTH = 4
/** bits 3-5: Tank.state */
export const TF_STATE_SHIFT = 3

/** slot: players 0-3, enemies 4 + enemy index */
export type TankRec = { slot: number; flags: number; type: number; x: number; z: number; body: number; turret: number }
export type BulletRec = { id: number; x: number; z: number; heading: number; smoke: number }
export type MineRec = { id: number; x: number; z: number; fuse: boolean }
export type MarkRec = { id: number; x: number; z: number; color: number }
export type TreadRec = { slot: number; x: number; z: number; dir: number }
/** the receiving player's own tank, unquantized, for prediction / reconciliation */
export type YouRec = {
  ack: number
  x: number
  z: number
  /** body forward (rot.z) */
  fx: number
  fz: number
  speed: number
  sign: number
  freeze: number
  shellTimer: number
  mineTimer: number
  mineHeld: boolean
  shells: number
  mines: number
}
export type SnapJson = { m?: Meta; e?: NetEvent[]; h?: Hold[] }

export type Snapshot = {
  tick: number
  gen: number
  /** keyframe: tanks are complete, and mines / marks / aims are present */
  key: boolean
  /** only events / treads of the world that is about to be replaced (sent right before a stage) */
  evOnly?: boolean
  tanks: TankRec[]
  bullets: BulletRec[]
  mines?: MineRec[]
  marks?: MarkRec[]
  /** every player's aim point (remote cursors) */
  aims?: { x: number; z: number }[]
  you?: YouRec
  treads: TreadRec[]
  /** [slot, sound index into TREAD_SE] */
  treadSe: [number, number][]
  json?: SnapJson
}

/** tread sounds, sent by index */
export const TREAD_SE = ['RP_TNK_SE_CATERPILLAR_1P', 'RP_TNK_SE_CATERPILLAR_2P', 'RP_TNK_SE_CATERPILLAR_SLOW', 'RP_TNK_SE_CATERPILLAR_MID', 'RP_TNK_SE_CATERPILLAR_SAME', 'RP_TNK_SE_CATERPILLAR_FAST']

const F_MINES = 1
const F_MARKS = 2
const F_AIMS = 4
const F_YOU = 8
const F_JSON = 16
const F_KEY = 32
const F_EVONLY = 64

class Writer {
  buf: Uint8Array<ArrayBuffer> = new Uint8Array(512)
  v = new DataView(this.buf.buffer)
  n = 0
  private room(k: number) {
    if (this.n + k <= this.buf.length) return
    let len = this.buf.length * 2
    while (len < this.n + k) len *= 2
    const b = new Uint8Array(len)
    b.set(this.buf)
    this.buf = b
    this.v = new DataView(b.buffer)
  }
  u8(x: number) {
    this.room(1)
    this.v.setUint8(this.n++, x)
  }
  i8(x: number) {
    this.room(1)
    this.v.setInt8(this.n++, x)
  }
  u16(x: number) {
    this.room(2)
    this.v.setUint16(this.n, x, true)
    this.n += 2
  }
  i16(x: number) {
    this.room(2)
    this.v.setInt16(this.n, x, true)
    this.n += 2
  }
  u32(x: number) {
    this.room(4)
    this.v.setUint32(this.n, x >>> 0, true)
    this.n += 4
  }
  f32(x: number) {
    this.room(4)
    this.v.setFloat32(this.n, x, true)
    this.n += 4
  }
  bytes(b: Uint8Array) {
    this.room(b.length)
    this.buf.set(b, this.n)
    this.n += b.length
  }
  done(): Uint8Array<ArrayBuffer> {
    return this.buf.slice(0, this.n)
  }
}

class Reader {
  v: DataView
  n = 0
  constructor(private b: Uint8Array) {
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  }
  u8() {
    return this.v.getUint8(this.n++)
  }
  i8() {
    return this.v.getInt8(this.n++)
  }
  u16() {
    const x = this.v.getUint16(this.n, true)
    this.n += 2
    return x
  }
  i16() {
    const x = this.v.getInt16(this.n, true)
    this.n += 2
    return x
  }
  u32() {
    const x = this.v.getUint32(this.n, true)
    this.n += 4
    return x
  }
  f32() {
    const x = this.v.getFloat32(this.n, true)
    this.n += 4
    return x
  }
  bytes(k: number) {
    const s = this.b.subarray(this.n, this.n + k)
    this.n += k
    return s
  }
}

const enc = new TextEncoder()
const dec = new TextDecoder()

/** quantizes a tank record the way it goes on the wire (for change detection) */
export function quantTank(t: TankRec): TankRec {
  return { slot: t.slot, flags: t.flags, type: t.type, x: qPos(t.x), z: qPos(t.z), body: qAng(t.body), turret: qAng(t.turret) }
}

/** `tanks` must already be quantized (quantTank) */
export function encodeSnapshot(s: Snapshot): Uint8Array<ArrayBuffer> {
  const w = new Writer()
  w.u8(BIN_SNAPSHOT)
  w.u32(s.tick)
  w.u8(s.gen & 0xff)
  const json = s.json && (s.json.m || s.json.e?.length || s.json.h?.length) ? enc.encode(JSON.stringify(s.json)) : null
  w.u8((s.mines ? F_MINES : 0) | (s.marks ? F_MARKS : 0) | (s.aims ? F_AIMS : 0) | (s.you ? F_YOU : 0) | (json ? F_JSON : 0) | (s.key ? F_KEY : 0) | (s.evOnly ? F_EVONLY : 0))
  w.u8(s.tanks.length)
  for (const t of s.tanks) {
    w.u8(t.slot)
    w.u8(t.flags)
    w.u8(t.type)
    w.i16(t.x)
    w.i16(t.z)
    w.u16(t.body)
    w.u16(t.turret)
  }
  w.u8(Math.min(255, s.bullets.length))
  for (const b of s.bullets.slice(0, 255)) {
    w.u16(b.id & 0xffff)
    w.i16(qPos(b.x))
    w.i16(qPos(b.z))
    w.u8(qAng8(b.heading))
    w.u8(b.smoke)
  }
  if (s.mines) {
    w.u8(s.mines.length)
    for (const m of s.mines) {
      w.u16(m.id & 0xffff)
      w.i16(qPos(m.x))
      w.i16(qPos(m.z))
      w.u8(m.fuse ? 1 : 0)
    }
  }
  if (s.marks) {
    w.u8(s.marks.length)
    for (const m of s.marks) {
      w.u16(m.id & 0xffff)
      w.i16(qPos(m.x))
      w.i16(qPos(m.z))
      w.u8(m.color)
    }
  }
  if (s.aims) {
    w.u8(s.aims.length)
    for (const a of s.aims) {
      w.i16(qAim(a.x))
      w.i16(qAim(a.z))
    }
  }
  if (s.you) {
    const y = s.you
    w.u32(y.ack)
    w.f32(y.x)
    w.f32(y.z)
    w.f32(y.fx)
    w.f32(y.fz)
    w.f32(y.speed)
    w.i8(y.sign < 0 ? -1 : 1)
    w.u8(Math.min(255, y.freeze))
    w.u8(Math.min(255, y.shellTimer))
    w.u8(Math.min(255, y.mineTimer))
    w.u8(y.mineHeld ? 1 : 0)
    w.u8(y.shells)
    w.u8(y.mines)
  }
  w.u16(Math.min(65535, s.treads.length))
  for (const t of s.treads) {
    w.u8(t.slot)
    w.i16(qPos(t.x))
    w.i16(qPos(t.z))
    w.u8(qAng8(t.dir))
  }
  w.u8(Math.min(255, s.treadSe.length))
  for (const [slot, i] of s.treadSe.slice(0, 255)) {
    w.u8(slot)
    w.u8(i)
  }
  if (json) {
    w.u32(json.length)
    w.bytes(json)
  }
  return w.done()
}

export function decodeSnapshot(b: Uint8Array): Snapshot | null {
  if (b[0] !== BIN_SNAPSHOT) return null
  const r = new Reader(b)
  r.u8()
  const tick = r.u32()
  const gen = r.u8()
  const f = r.u8()
  const s: Snapshot = { tick, gen, key: !!(f & F_KEY), evOnly: !!(f & F_EVONLY), tanks: [], bullets: [], treads: [], treadSe: [] }
  for (let i = r.u8(); i > 0; i--)
    s.tanks.push({ slot: r.u8(), flags: r.u8(), type: r.u8(), x: r.i16() / 16, z: r.i16() / 16, body: dAng(r.u16()), turret: dAng(r.u16()) })
  for (let i = r.u8(); i > 0; i--) s.bullets.push({ id: r.u16(), x: r.i16() / 16, z: r.i16() / 16, heading: dAng8(r.u8()), smoke: r.u8() })
  if (f & F_MINES) {
    s.mines = []
    for (let i = r.u8(); i > 0; i--) s.mines.push({ id: r.u16(), x: r.i16() / 16, z: r.i16() / 16, fuse: r.u8() === 1 })
  }
  if (f & F_MARKS) {
    s.marks = []
    for (let i = r.u8(); i > 0; i--) s.marks.push({ id: r.u16(), x: r.i16() / 16, z: r.i16() / 16, color: r.u8() })
  }
  if (f & F_AIMS) {
    s.aims = []
    for (let i = r.u8(); i > 0; i--) s.aims.push({ x: r.i16() / 8, z: r.i16() / 8 })
  }
  if (f & F_YOU) {
    s.you = {
      ack: r.u32(),
      x: r.f32(),
      z: r.f32(),
      fx: r.f32(),
      fz: r.f32(),
      speed: r.f32(),
      sign: r.i8(),
      freeze: r.u8(),
      shellTimer: r.u8(),
      mineTimer: r.u8(),
      mineHeld: r.u8() === 1,
      shells: r.u8(),
      mines: r.u8(),
    }
  }
  for (let i = r.u16(); i > 0; i--) s.treads.push({ slot: r.u8(), x: r.i16() / 16, z: r.i16() / 16, dir: dAng8(r.u8()) })
  for (let i = r.u8(); i > 0; i--) s.treadSe.push([r.u8(), r.u8()])
  if (f & F_JSON) {
    const n = r.u32()
    s.json = JSON.parse(dec.decode(r.bytes(n)))
  }
  return s
}

// ---- helpers --------------------------------------------------------------------------------

/** room codes: 5 letters without look-alikes */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const normalizeCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
export const cleanName = (n: unknown) =>
  (typeof n === 'string' ? n : '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, 16)

/** Presenter methods a server may call on the client's layouts (['u', ...] events) */
export const UI_CALLS = [
  'reset',
  'fadeStart',
  'hudIn',
  'hudOut',
  'hudScore',
  'setBalloons',
  'startMsgPlay',
  'clearMsgShow',
  'clearMsgHide',
  'failedMsgShow',
  'completeMsgShow',
  'exGuideStart',
  'exGuideStop',
  'exMsgShow',
  'exMsgOutAll',
  'resultStart',
  'resultShowTotals',
  'hitPopup',
  'medalStart',
  'winnerStart',
] as const
