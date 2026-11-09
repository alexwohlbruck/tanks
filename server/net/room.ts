// A room: up to 4 members, a lobby, and a game runner ticked at 60 Hz by the rooms module.
// Server-owned: the room lives while it has members (disconnected members keep their slot for
// REJOIN_MS); the host is just the member who picks the settings and moves on when it leaves.

import type { GameData } from '../../src/data'
import type { LevelPack } from '../../src/levels/format'
import {
  DEFAULT_SETTINGS,
  encodeSnapshot,
  REJOIN_MS,
  SNAPSHOT_EVERY,
  TICK_MS,
  type Gate,
  type Hold,
  type MemberInfo,
  type NetEvent,
  type NetInput,
  type RoomInfo,
  type RoomListing,
  type RoomSettings,
  type RoomState,
  type S2C,
  type Snapshot,
  type StageMsg,
} from '../../src/net/protocol'
import { Cell, type World } from '../../src/sim/world'
import { CoopRunner, VersusRunner, type Runner } from './runners'
import { Baseline, common, convertEvents, youOf, type Common, type TickOut } from './snapshot'

/** a connection, whatever carries it (Bun ServerWebSocket in production) */
export interface Conn {
  send(data: string | Uint8Array): void
  /** bytes queued on the socket (snapshots are skipped while a client is backed up) */
  buffered(): number
  close(code?: number, reason?: string): void
}

const IDLE: NetInput = { seq: 0, mx: 0, my: 0, analog: false, fire: false, mine: false, ax: null, az: null }
/** inputs queued beyond this are merged (the client is ahead; keeps the input delay bounded) */
const MAX_QUEUE = 6
/** no input for this many ticks: the tank stops (tab in the background, lag spike) */
const STALE_TICKS = 8
const MAX_BUFFERED = 256 * 1024

export class Member {
  conn: Conn | null = null
  disconnectedAt = 0
  ping = 0
  private queue: NetInput[] = []
  private last: NetInput = IDLE
  private lastRecv = -1
  /** the seq of the input used in the latest tick (the client replays everything after it) */
  ack = 0
  private empty = 0
  /** smallest queue length seen in the current window (adaptive jitter buffer) */
  private minQueue = 99
  private window = 0
  base = new Baseline()
  pending: TickOut = { events: [], treads: [], treadSe: [] }

  constructor(
    public token: string,
    public name: string,
    public slot: number,
  ) {}

  get connected() {
    return !!this.conn
  }

  pushInput(i: NetInput) {
    if (i.seq <= this.lastRecv) return
    this.lastRecv = i.seq
    this.queue.push(i)
    while (this.queue.length > MAX_QUEUE) this.mergeOldest()
  }

  /** drops the oldest queued input, keeping its button presses (edges must never be lost) */
  private mergeOldest() {
    const [a, b] = this.queue
    if (!b) return
    b.fire ||= a.fire
    b.mine ||= a.mine
    this.queue.shift()
  }

  /** this tick's input */
  next(): NetInput {
    if (!this.conn) return { ...IDLE, ax: this.last.ax, az: this.last.az }
    // inputs that sat in the queue for a whole window are latency, not jitter: drop one
    this.minQueue = Math.min(this.minQueue, this.queue.length)
    if (++this.window >= 30) {
      if (this.minQueue >= 2) this.mergeOldest()
      this.minQueue = 99
      this.window = 0
    }
    const i = this.queue.shift()
    if (i) {
      this.ack = i.seq
      this.last = i
      this.empty = 0
      return i
    }
    // nothing arrived in time: hold the stick (a late packet) but never repeat a press
    const stale = ++this.empty > STALE_TICKS
    return { ...this.last, fire: false, mine: false, mx: stale ? 0 : this.last.mx, my: stale ? 0 : this.last.my }
  }

  resetInput() {
    this.queue = []
    this.last = IDLE
    this.lastRecv = -1
    this.ack = 0
    this.empty = 0
  }

  send(m: S2C) {
    this.conn?.send(JSON.stringify(m))
  }
}

export type RoomDeps = {
  data: () => GameData
  /** store pack lookup (mode 'pack' with a packId) */
  resolvePack: (id: string) => Promise<LevelPack>
  onEmpty: (r: Room) => void
}

export class Room {
  members: Member[] = []
  host: Member | null = null
  state: RoomState = 'lobby'
  settings: RoomSettings = { ...DEFAULT_SETTINGS }
  pack: LevelPack | null = null
  runner: Runner | null = null
  tick = 0
  private gen = 0
  private nextAt = performance.now()
  lastActive = Date.now()
  private holds: Hold[] = []
  private uiPending: NetEvent[] = []
  /** bytes sent per member (tests / stats) */
  sentBytes = 0

  constructor(
    public code: string,
    public name: string,
    public isPublic: boolean,
    public maxPlayers: number,
    private deps: RoomDeps,
  ) {}

  // ---- membership --------------------------------------------------------------------------

  freeSlot(): number {
    for (let s = 0; s < this.maxPlayers; s++) if (!this.members.some((m) => m.slot === s)) return s
    return -1
  }

  get full() {
    return this.freeSlot() < 0
  }

  add(token: string, name: string, conn: Conn): Member | null {
    const slot = this.freeSlot()
    if (slot < 0) return null
    const m = new Member(token, name, slot)
    this.members.push(m)
    this.members.sort((a, b) => a.slot - b.slot)
    if (!this.host) this.host = m
    this.attach(m, conn)
    return m
  }

  /** (re)connects a member: room info, and the running game from a keyframe */
  attach(m: Member, conn: Conn) {
    m.conn = conn
    m.disconnectedAt = 0
    m.resetInput()
    m.base.reset()
    m.pending = { events: [], treads: [], treadSe: [] }
    if (!this.host || !this.host.connected) this.host = m
    this.lastActive = Date.now()
    if (this.runner) {
      m.send({ t: 'game', mode: this.runner.mode, tick: this.tick })
      const w = this.runner.world
      if (w) m.send(this.stageMsg(w))
      // a client joining mid-mission: bring the HUD in
      const st = this.runner.meta().st
      if (st === 4 && this.runner.mode !== 'versus') m.pending.events.push(['u', 'hudIn'])
    }
    this.broadcastRoom()
  }

  detach(m: Member) {
    m.conn = null
    m.disconnectedAt = Date.now()
    if (this.host === m) this.host = this.members.find((x) => x.connected) ?? m
    this.broadcastRoom()
  }

  remove(m: Member) {
    this.members = this.members.filter((x) => x !== m)
    if (this.host === m) this.host = this.members.find((x) => x.connected) ?? this.members[0] ?? null
    if (!this.members.length) {
      this.deps.onEmpty(this)
      return
    }
    if (this.state === 'lobby') this.compact()
    this.broadcastRoom()
  }

  /** in the lobby, slots (= colours) stay 0..n-1 */
  private compact() {
    this.members.sort((a, b) => a.slot - b.slot).forEach((m, i) => (m.slot = i))
  }

  /** drops members whose rejoin window ran out */
  expire(now: number) {
    for (const m of [...this.members]) if (!m.connected && now - m.disconnectedAt > REJOIN_MS) this.remove(m)
  }

  isHost(m: Member) {
    return this.host === m
  }

  // ---- info --------------------------------------------------------------------------------

  info(you: Member | null): RoomInfo {
    const players = this.runner?.players ?? 0
    const members: MemberInfo[] = this.members.map((m) => ({
      slot: m.slot,
      name: m.name,
      host: m === this.host,
      connected: m.connected,
      ping: Math.round(m.ping),
      spectating: !!this.runner && m.slot >= players,
    }))
    return { code: this.code, name: this.name, public: this.isPublic, maxPlayers: this.maxPlayers, state: this.state, settings: this.settings, members, you: you?.slot ?? -1 }
  }

  listing(): RoomListing {
    return { code: this.code, name: this.name, mode: this.settings.mode, players: this.members.length, maxPlayers: this.maxPlayers, state: this.state }
  }

  broadcastRoom() {
    for (const m of this.members) m.send({ t: 'room', room: this.info(m) })
  }

  // ---- settings / game control -------------------------------------------------------------

  setSettings(s: Partial<RoomSettings>) {
    const cur = this.settings
    const int = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d)
    if (s.mode === 'coop' || s.mode === 'pack' || s.mode === 'versus') cur.mode = s.mode
    if (typeof s.allMissions === 'boolean') cur.allMissions = s.allMissions
    cur.mission = int(s.mission, 0, cur.allMissions ? 99 : 19, Math.min(cur.mission, cur.allMissions ? 99 : 19))
    cur.rounds = int(s.rounds, 1, 9, cur.rounds)
    cur.ai = int(s.ai, 0, 4, cur.ai)
    cur.arena = int(s.arena, 0, 99, cur.arena)
    this.broadcastRoom()
  }

  setPack(pack: LevelPack | null, id = '') {
    this.pack = pack
    this.settings.packId = id
    this.settings.packName = pack?.name ?? ''
    this.settings.packLevels = pack?.levels.length ?? 0
    if (pack) this.settings.mode = 'pack'
    this.broadcastRoom()
  }

  /** starts (or restarts) the game with every member */
  start(): string | null {
    if (this.settings.mode === 'pack' && !this.pack) return 'choose a level pack first'
    if (this.state === 'lobby') this.compact()
    const players = Math.max(1, Math.max(...this.members.map((m) => m.slot)) + 1)
    let data: GameData
    try {
      data = this.deps.data()
    } catch (e) {
      return 'game data missing on the server'
    }
    this.gen++
    this.holds = []
    this.uiPending = []
    for (const m of this.members) {
      m.resetInput()
      m.base.reset()
      m.pending = { events: [], treads: [], treadSe: [] }
      m.send({ t: 'game', mode: this.settings.mode, tick: this.tick })
    }
    const host = { stage: (w: World) => this.onStage(w), events: (ev: Parameters<typeof convertEvents>[0]) => this.onEvents(ev) }
    const s = this.settings
    this.runner =
      s.mode === 'versus'
        ? new VersusRunner(players, { rounds: s.rounds, ai: s.ai, arena: s.arena }, host)
        : new CoopRunner(data, players, { mission: s.mission, allMissions: s.allMissions, pack: s.mode === 'pack' ? this.pack : null }, host)
    this.state = 'playing'
    this.nextAt = performance.now()
    this.broadcastRoom()
    return null
  }

  /** back to the room (host's choice at the end of a game, or nobody left playing) */
  toLobby() {
    this.runner = null
    this.state = 'lobby'
    this.compact()
    this.broadcastRoom()
  }

  gate(m: Member, g: Gate) {
    // the host's screens pace the room; anybody's if the host is away
    if (this.isHost(m) || !this.host?.connected) this.runner?.gate(g)
  }

  // ---- runner callbacks --------------------------------------------------------------------

  private stageMsg(w: World): StageMsg {
    const cells = w.grid.map((row) => row.map((g) => (g.kind === Cell.Empty && g.code >= 100 && g.code < 300 ? 0 : g.code)))
    return {
      t: 'stage',
      tick: this.tick,
      gen: this.gen & 0xff,
      players: w.players,
      enemyCap: w.enemyCap,
      cells,
      facing: [w.playerFacing[0], w.playerFacing[1]],
      rules: w.rules,
    }
  }

  private onStage(w: World) {
    // what the old world still produced goes out first, tagged as events only
    for (const m of this.members) if (m.connected) this.flushEvents(m)
    this.gen++
    const msg = JSON.stringify(this.stageMsg(w))
    for (const m of this.members) {
      m.base.reset()
      if (m.conn) {
        m.conn.send(msg)
        this.sentBytes += msg.length
      }
    }
  }

  private onEvents(ev: Parameters<typeof convertEvents>[0]) {
    const out: TickOut = { events: [], treads: [], treadSe: [] }
    const holds: Hold[] = []
    convertEvents(ev, out, holds)
    this.holds = holds
    const ui = this.runner?.uiCalls() ?? []
    // newGame() records 'reset' before the runner exists
    if (this.uiPending.length) {
      ui.unshift(...this.uiPending)
      this.uiPending = []
    }
    out.events.push(...ui)
    for (const m of this.members) {
      if (!m.conn) continue
      const p = m.pending
      p.events.push(...out.events)
      p.treads.push(...out.treads)
      p.treadSe.push(...out.treadSe)
      // a client that stopped reading must not grow without bound
      if (p.events.length > 2000) p.events.splice(0, p.events.length - 2000)
      if (p.treads.length > 2000) p.treads.splice(0, p.treads.length - 2000)
      if (p.treadSe.length > 500) p.treadSe.splice(0, p.treadSe.length - 500)
    }
  }

  private flushEvents(m: Member) {
    const p = m.pending
    if (!p.events.length && !p.treads.length && !p.treadSe.length) return
    const s: Snapshot = { tick: this.tick, gen: this.gen, key: false, evOnly: true, tanks: [], bullets: [], treads: p.treads, treadSe: p.treadSe, json: { e: p.events } }
    m.pending = { events: [], treads: [], treadSe: [] }
    const b = encodeSnapshot(s)
    this.sentBytes += b.length
    m.conn!.send(b)
  }

  // ---- 60 Hz -------------------------------------------------------------------------------

  /** runs the ticks that are due */
  advance(now: number) {
    if (!this.runner) {
      this.nextAt = now
      return
    }
    let n = 0
    while (this.nextAt <= now && n++ < 5) {
      this.step()
      this.nextAt += TICK_MS
    }
    // more than 5 ticks behind (the process stalled): skip ahead rather than fast-forward
    if (now - this.nextAt > 100) this.nextAt = now
  }

  step() {
    const r = this.runner
    if (!r) return
    this.tick++
    const byPlayer: (Member | undefined)[] = []
    for (const m of this.members) if (m.slot < r.players) byPlayer[m.slot] = m
    r.tick((w) => {
      for (let i = 0; i < w.players; i++) {
        const m = byPlayer[i]
        const inp = m ? m.next() : IDLE
        const t = w.playerTanks[i]
        const it = t.intent
        it.moveX = inp.mx
        it.moveZ = inp.my
        it.analog = inp.analog
        if (inp.ax !== null && inp.az !== null) {
          it.aimX = inp.ax
          it.aimZ = inp.az
        }
        it.aim = Math.atan2(it.aimZ - t.pos.z, it.aimX - t.pos.x)
        it.fire = inp.fire
        it.mine = inp.mine
      }
    })
    // players who joined during the game come in at the next mission / round
    const want = Math.max(0, ...this.members.map((m) => m.slot + 1))
    if (want > r.players) r.grow(want)
    if (this.tick % SNAPSHOT_EVERY === 0) this.snapshot()
    if (r.ended() && this.state === 'playing') {
      this.state = 'ended'
      this.broadcastRoom()
    }
  }

  private snapshot() {
    const r = this.runner!
    const w = r.world
    if (!w) return
    const c = common(w)
    const meta = r.meta()
    const metaKey = JSON.stringify(meta)
    for (const m of this.members) if (m.conn) this.sendSnapshot(m, w, c, meta, metaKey)
  }

  private sendSnapshot(m: Member, w: World, c: Common, meta: ReturnType<Runner['meta']>, metaKey: string) {
    const conn = m.conn!
    // a backed-up client skips snapshots (the baseline only moves when one is sent)
    if (conn.buffered() > MAX_BUFFERED) return
    const b = m.base
    const key = b.key
    const tanks = c.tanks.filter((t, i) => key || b.tanks.get(t.slot) !== c.tankKeys[i])
    c.tanks.forEach((t, i) => b.tanks.set(t.slot, c.tankKeys[i]))
    const s: Snapshot = {
      tick: this.tick,
      gen: this.gen,
      key,
      tanks,
      bullets: c.bullets,
      treads: m.pending.treads,
      treadSe: m.pending.treadSe,
    }
    if (key || b.mines !== c.minesKey) s.mines = c.mines
    if (key || b.marks !== c.marksKey) s.marks = c.marks
    if (key || b.aims !== c.aimsKey) s.aims = c.aims
    b.mines = c.minesKey
    b.marks = c.marksKey
    b.aims = c.aimsKey
    s.you = m.slot < w.players ? youOf(w, m.slot, m.ack) : undefined
    const json: Snapshot['json'] = {}
    if (key || b.meta !== metaKey) json.m = meta
    b.meta = metaKey
    if (m.pending.events.length) json.e = m.pending.events
    if (this.holds.length) json.h = this.holds
    s.json = json
    b.key = false
    m.pending = { events: [], treads: [], treadSe: [] }
    const bytes = encodeSnapshot(s)
    this.sentBytes += bytes.length
    conn.send(bytes)
  }
}
