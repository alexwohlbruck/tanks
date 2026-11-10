// NetSession: the online Session. The server runs the game; this keeps a client-side mirror
// of it in the app's own Game / World, so the renderer, HUD layouts and audio work unchanged:
//   - snapshots are reassembled from deltas on arrival and queued on a timeline
//   - the view plays the timeline ~80-120 ms behind the server clock (interpolation buffer):
//     remote tanks / shells are interpolated, discrete things (events, sounds, layout calls,
//     game state, stage loads) are applied when the playhead reaches their tick
//   - the local player's tank is predicted: the ported player controller + field collision
//     re-run with this client's inputs, reconciled against the server's state of that tank
//     (replay of the unacknowledged inputs) and smoothed
// See docs/netcode.md.

import type { Pads, Session } from '../app/types'
import { pointerUnits, type Cursor } from '../app/session'
import { pointerToScreen, projectToScreen, screenToField, type Game } from '../game'
import type { PadState } from '../input'
import { TANK } from '../sim/consts'
import { collideActor } from '../sim/field'
import { Tank } from '../sim/tank'
import { axesFromForward, mag, v3 } from '../sim/vec'
import { Cell, World, type Mine, type Shell, type SimEvent } from '../sim/world'
import type { NetClient } from './client'
import {
  quantizeInput,
  SNAPSHOT_EVERY,
  TF_ACTIVE,
  TF_ALIVE,
  TF_STATE_SHIFT,
  TF_STEALTH,
  TICK_MS,
  TREAD_SE,
  UI_CALLS,
  type BulletRec,
  type Hold,
  type MarkRec,
  type Meta,
  type MineRec,
  type NetEvent,
  type NetInput,
  type Snapshot,
  type StageMsg,
  type TankRec,
  type YouRec,
} from './protocol'

/** a snapshot with its delta resolved */
type Full = {
  tick: number
  gen: number
  tanks: Map<number, TankRec>
  bullets: BulletRec[]
  mines: MineRec[]
  marks: MarkRec[]
  aims: { x: number; z: number }[]
}

type Item =
  | { kind: 'stage'; tick: number; msg: StageMsg }
  | { kind: 'snap'; tick: number; full: Full | null; snap: Snapshot }

/** reconciliation error above this snaps instead of smoothing */
const SNAP_DIST = 48
const UI = new Set<string>(UI_CALLS)
const BOOL_ARGS = new Set(['fadeStart', 'setBalloons'])

export type NetStats = { rtt: number; delayMs: number; kbIn: number; predError: number; snapshotHz: number }

export class NetSession implements Session {
  readonly kind = 'net'
  cursors: Cursor[] = [0, 1, 2, 3].map(() => ({ x: 0, y: 0, clamped: false, far: false, visible: false }))
  /** this client's player index in the game, -1 when spectating */
  me = -1
  meta: Meta | null = null
  /** input is ignored while the in-game menu is open */
  inputBlocked = false
  /** Esc / Start pressed (the HUD toggles its menu) */
  onPause: (() => void) | null = null
  stats: NetStats = { rtt: 0, delayMs: 0, kbIn: 0, predError: 0, snapshotHz: 0 }

  private items: Item[] = []
  /** the latest reassembled state (arrival order, not delayed) */
  private cur: Full | null = null
  /** the snapshot the view is at */
  private a: (Item & { kind: 'snap'; full: Full }) | null = null
  private world: World | null = null
  private gen = -1
  private offset: number | null = null
  private jitter = 0
  private delay = 6
  private unsub: () => void
  // prediction
  private ghost: Tank | null = null
  private inputs: NetInput[] = []
  private seq = 0
  private aim = { x: 0, z: 0 }
  private predicting = false
  /** prediction ended (our tank was destroyed): hold the last predicted pose until the
   * playhead reaches the destruction, instead of snapping back to the older server pose */
  private hold: { x: number; z: number; fx: number; fz: number } | null = null
  private err = { x: 0, z: 0 }
  private shells = 0
  private mines = 0
  private suppress: { name: string; until: number }[] = []
  private gates = new Set<string>()
  private lastState = -1
  private statT = performance.now()
  private statBytes = 0
  private statSnaps = 0

  constructor(
    private game: Game,
    private net: NetClient,
  ) {
    this.unsub = net.on((m) => {
      if (m.t === 'stage') this.items.push({ kind: 'stage', tick: m.tick, msg: m })
      else if (m.t === 'snapshot') this.onSnapshot(m.s, m.bytes)
      else if (m.t === 'game') this.restart()
    })
    game.paused = false
    // until the first snapshot: not the title state (the app would open the pre-game screens)
    game.state = 1
  }

  /** a new game in the same session (play again): the timeline starts over */
  private restart() {
    this.items = []
    this.cur = null
    this.a = null
    this.inputs = []
    this.predicting = false
    this.gates.clear()
  }

  dispose() {
    this.unsub()
  }

  private get mySlot() {
    return this.net.room?.you ?? -1
  }

  // ---- arrival --------------------------------------------------------------------------

  private onSnapshot(s: Snapshot, bytes: number) {
    this.statBytes += bytes
    if (!s.evOnly) {
      this.statSnaps++
      // clock: server tick - local tick, smoothed; jitter widens the buffer
      const sample = s.tick - performance.now() / TICK_MS
      if (this.offset === null || Math.abs(sample - this.offset) > 30) this.offset = sample
      else {
        const d = sample - this.offset
        this.jitter = this.jitter * 0.95 + Math.abs(d) * 0.05
        this.offset += d * 0.05
      }
      // reassemble the delta
      const prev = this.cur && this.cur.gen === s.gen && !s.key ? this.cur : null
      const tanks = new Map(prev?.tanks ?? [])
      if (s.key) tanks.clear()
      for (const t of s.tanks) tanks.set(t.slot, t)
      const full: Full = {
        tick: s.tick,
        gen: s.gen,
        tanks,
        bullets: s.bullets,
        mines: s.mines ?? prev?.mines ?? [],
        marks: s.marks ?? prev?.marks ?? [],
        aims: s.aims ?? prev?.aims ?? [],
      }
      this.cur = full
      this.items.push({ kind: 'snap', tick: s.tick, full, snap: s })
      if (s.you) this.reconcile(s.you, s.gen)
      else this.stopPredicting()
    } else this.items.push({ kind: 'snap', tick: s.tick, full: null, snap: s })
  }

  // ---- the 60 Hz frame ------------------------------------------------------------------

  /** online: no pause menu or pre-game screens; Esc / Start goes to the HUD's menu */
  hudInput(pad: PadState) {
    if (pad.pause) this.onPause?.()
    return false
  }

  step(pads: Pads) {
    const game = this.game
    const now = performance.now()
    this.updateStats(now)
    // the playhead: server clock minus the interpolation delay
    const want = Math.max(4, Math.min(15, SNAPSHOT_EVERY + 3 + this.jitter * 2.5))
    this.delay += (want - this.delay) * 0.02
    const rt = this.offset === null ? -Infinity : now / TICK_MS + this.offset - this.delay
    // a long stall (background tab): don't replay seconds of sounds and effects
    const behind = this.items.length > 120
    while (this.items.length && (this.items[0].tick <= rt || behind && this.items.length > 4)) {
      const it = this.items.shift()!
      if (it.kind === 'stage') this.applyStage(it.msg)
      else this.applySnap(it, it.tick < rt - 60 || behind)
    }
    const w = this.world
    if (!w) return
    if (this.me >= 0) this.localInput(pads.merged, w)
    this.applyContinuous(rt, w)
    this.applyHolds()
    this.checkGates()
    // the start balloons belong to the start state; the local fade layout may switch them back
    // on after the server's setBalloons(false) when this client runs behind
    if (game.state === 4) game.presenter.setBalloons(false)
    game.presenter.tick(game)
    game.phaseTime++
  }

  private updateStats(now: number) {
    const dt = now - this.statT
    if (dt < 1000) return
    this.stats.kbIn = this.statBytes / 1024 / (dt / 1000)
    this.stats.snapshotHz = this.statSnaps / (dt / 1000)
    this.statBytes = this.statSnaps = 0
    this.statT = now
    this.stats.rtt = this.net.rtt
    this.stats.delayMs = this.delay * TICK_MS
  }

  // ---- stage ----------------------------------------------------------------------------

  private applyStage(m: StageMsg) {
    const w = new World(m.players, { aspect: '16_9', enemyCap: m.enemyCap })
    w.loadStage({ width: m.cells[0]?.length ?? 22, height: m.cells.length, cells: m.cells, facing: [0, 0] }, [], { swap: false, rules: m.rules })
    w.playerFacing = [m.facing[0], m.facing[1]]
    w.hooks = { addKill() {}, enemySpawned() {}, enemyDestroyed() {} }
    // tanks come from the snapshots
    for (const t of [...w.playerTanks, ...w.enemyTanks]) t.age = -999
    w.tanks = []
    this.world = w
    this.gen = m.gen
    this.a = null
    this.game.world = w
    this.game.players = m.players
    this.me = this.mySlot >= 0 && this.mySlot < m.players ? this.mySlot : -1
    this.ghost = this.me >= 0 ? new Tank(w, false, this.me) : null
    if (this.ghost) this.ghost.spawn(v3(), 0)
    this.predicting = false
    this.hold = null
    this.inputs = []
    if (this.meta) w.enemyAliveNum = this.meta.enemies
    this.game.listener?.onWorld(w)
  }

  private tankAt(w: World, slot: number): Tank | null {
    return slot < 4 ? (w.playerTanks[slot] ?? null) : (w.enemyTanks[slot - 4] ?? null)
  }

  // ---- discrete: events, meta, layout calls ---------------------------------------------

  private applySnap(it: Item & { kind: 'snap' }, stale: boolean) {
    const s = it.snap
    const w = this.world
    if (s.json?.m) this.applyMeta(s.json.m)
    if (!w || s.gen !== this.gen) return
    const sim: SimEvent[] = []
    const audio = this.game.audio
    for (const e of s.json?.e ?? []) this.applyEvent(e, w, sim, stale)
    if (!stale) {
      for (const t of s.treads) {
        const tank = this.tankAt(w, t.slot)
        if (tank) sim.push({ t: 'tread', tank, pos: v3(t.x, 0, t.z), dir: v3(Math.cos(t.dir), 0, Math.sin(t.dir)) })
      }
      for (const [slot, i] of s.treadSe) {
        const tank = this.tankAt(w, slot)
        const name = TREAD_SE[i]
        if (tank && name) audio?.se(name, tank.pos)
      }
    }
    if (sim.length) this.game.listener?.onEvents(sim, w)
    if (it.full) {
      this.a = it as Item & { kind: 'snap'; full: Full }
      this.holds = s.json?.h ?? []
    }
  }
  private holds: Hold[] = []

  private applyEvent(e: NetEvent, w: World, sim: SimEvent[], stale: boolean) {
    const audio = this.game.audio
    const n = (i: number) => Number(e[i])
    const pos = (i: number) => v3(n(i), n(i + 1), n(i + 2))
    switch (e[0]) {
      case 's': {
        if (stale) return
        const name = String(e[1])
        const slot = n(4)
        if (slot === this.me && this.me >= 0 && this.consumeSuppressed(name)) return
        audio?.se(name, e[2] === null ? undefined : { x: n(2), z: n(3) })
        return
      }
      case 'b':
        return audio?.bgm(String(e[1]))
      case 'bs':
        return audio?.bgmStop(n(1))
      case 'bm':
        return audio?.bgmTrackMask(n(1))
      case 'sh': {
        const tank = this.tankAt(w, n(1))
        if (tank && !stale) sim.push({ t: 'shoot', tank, bullet: n(2) ? ({} as Shell) : null })
        return
      }
      case 'r':
        if (!stale) sim.push({ t: 'ricochet', bullet: null as unknown as Shell, pos: pos(1), super: false })
        return
      case 'bd':
        if (!stale) sim.push({ t: 'bulletDie', bullet: null as unknown as Shell, pos: pos(1), reason: String(e[4]) as 'wall' })
        return
      case 'td': {
        const real = this.tankAt(w, n(1))
        if (!real || stale) return
        // the effect takes the position and the model (livery) of the destroyed tank
        const fake = { pos: v3(n(2), 0, n(3)), isEnemy: real.isEnemy, type: real.type, team: real.team } as unknown as Tank
        sim.push({ t: 'tankDie', tank: fake, by: 0, cause: 'shell', killer: null })
        return
      }
      case 'me':
        if (!stale) sim.push({ t: 'mineExplode', mine: { pos: pos(1) } as unknown as Mine })
        return
      case 'bb': {
        const cx = n(1)
        const cz = n(2)
        const g = w.grid[cz]?.[cx]
        if (g) {
          g.kind = Cell.Empty
          g.height = 0
        }
        for (const b of w.blocks.items) if (b.active && b.col === cx && b.row === cz) b.kill()
        sim.push({ t: 'blockBreak', cx, cz, height: n(3) })
        return
      }
      case 'st': {
        const tank = this.tankAt(w, n(1))
        if (tank && !stale) sim.push({ t: 'stealth', tank })
        return
      }
      case 'u': {
        const name = String(e[1])
        if (!UI.has(name)) return
        const p = this.game.presenter as unknown as Record<string, (...a: unknown[]) => void>
        const args = e.slice(2).map((a) => (BOOL_ARGS.has(name) ? !!a : a))
        p[name]?.(...args)
        return
      }
    }
  }

  private applyMeta(m: Meta) {
    const g = this.game
    if (g.state !== m.st) g.phaseTime = 0
    g.state = m.st
    g.stage = m.stage
    g.lastStage = m.last
    g.players = m.players
    g.freeze = m.freeze
    const st = g.stats
    st.players = Math.max(2, m.players)
    st.lives = [...m.lives]
    st.kills = [...m.kills]
    for (const row of st.killsByType) row.fill(0)
    for (const [p, type, k] of m.kt) if (st.killsByType[p]) st.killsByType[p][type] = k
    st.typeOrder = [...m.order]
    st.typeSeen.fill(false)
    for (const t of m.order) st.typeSeen[t] = true
    if (this.world) this.world.enemyAliveNum = m.enemies
    this.meta = m
  }

  /** looped SEs (rocket shells, mine fuses) must be refreshed every frame */
  private applyHolds() {
    const a = this.game.audio
    if (!a?.seHold) return
    for (const [key, name, x, z] of this.holds) a.seHold(name, key, { x, z })
  }

  /** the result screens finished here: tell the server (it waits for the host) */
  private checkGates() {
    const g = this.game
    const p = g.presenter
    if (g.state !== this.lastState) {
      if (g.state < 10) this.gates.clear()
      this.lastState = g.state
    }
    const gate = (k: 'result' | 'totals' | 'winner' | 'medal', done: boolean) => {
      if (done && !this.gates.has(k)) {
        this.gates.add(k)
        this.net.send({ t: 'gate', g: k })
      }
    }
    if (g.state === 10) gate('result', p.resultDone())
    else if (g.state === 11) {
      if (g.players === 1) gate('medal', p.medalDone())
      else {
        gate('totals', p.winnerTotals())
        gate('winner', p.winnerDone())
      }
    }
  }

  // ---- continuous: tanks, shells, mines, marks, cursors -------------------------------------

  private applyContinuous(rt: number, w: World) {
    const a = this.a
    if (!a || a.full.gen !== this.gen) return
    const b = this.items.find((x): x is Item & { kind: 'snap'; full: Full } => x.kind === 'snap' && !!x.full)
    const bb = b && b.full.gen === a.full.gen ? b.full : null
    const k = bb ? Math.max(0, Math.min(1, (rt - a.tick) / (bb.tick - a.tick || 1))) : 0
    const A = a.full
    const lerp = (x: number, y: number) => x + (y - x) * k
    const lerpAng = (x: number, y: number) => {
      let d = y - x
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      return x + d * k
    }
    // tanks
    const tanks: Tank[] = []
    const all = [...w.playerTanks.slice(0, w.players), ...w.enemyTanks]
    for (const t of all) {
      const slot = t.isEnemy ? 4 + t.index : t.index
      const ra = A.tanks.get(slot)
      if (!ra || !(ra.flags & TF_ACTIVE)) {
        if (slot === this.me && this.predicting) {
          // still alive in the prediction (the death arrives with the playhead)
        } else {
          if (slot === this.me) this.hold = null
          if (t.active) t.age = -999
          continue
        }
      }
      const rb = bb?.tanks.get(slot)
      if (!t.active) {
        t.spawn(v3(ra?.x ?? 0, 0, ra?.z ?? 0), 0)
        if (t.isEnemy) {
          t.enemyType = ra?.type ?? 1
          t.modelIdx = t.enemyType + 1
        }
      }
      if (ra) {
        const near = rb && rb.flags & TF_ACTIVE && Math.hypot(rb.x - ra.x, rb.z - ra.z) < 40
        const x = near ? lerp(ra.x, rb.x) : ra.x
        const z = near ? lerp(ra.z, rb.z) : ra.z
        const body = near ? lerpAng(ra.body, rb.body) : ra.body
        const turret = near ? lerpAng(ra.turret, rb.turret) : ra.turret
        t.pos.x = x
        t.pos.z = z
        axesFromForward(t.rot, v3(Math.cos(body), 0, Math.sin(body)))
        axesFromForward(t.turretRot, v3(Math.cos(turret), 0, Math.sin(turret)))
        t.lives = ra.flags & TF_ALIVE ? 1 : 0
        t.state = (ra.flags >> TF_STATE_SHIFT) & 7
        t.stealth = !!(ra.flags & TF_STEALTH)
        if (t.isEnemy && ra.type && ra.type !== t.enemyType) {
          t.enemyType = ra.type
          t.modelIdx = ra.type + 1
        }
      }
      if (slot === this.me) this.showLocal(t)
      tanks.push(t)
    }
    w.tanks = tanks
    // shells: interpolated by id
    const bIdx = new Map(bb?.bullets.map((x) => [x.id, x]) ?? [])
    w.bullets = A.bullets.map((s) => {
      const n = bIdx.get(s.id)
      const near = n && Math.hypot(n.x - s.x, n.z - s.z) < 30
      const x = near ? lerp(s.x, n.x) : s.x
      const z = near ? lerp(s.z, n.z) : s.z
      const h = near ? lerpAng(s.heading, n.heading) : s.heading
      return { id: s.id, pos: v3(x, TANK.bodyHeight, z), vel: v3(Math.cos(h), 0, Math.sin(h)), smokeType: s.smoke } as unknown as Shell
    })
    w.mines = A.mines.map((m) => ({ id: m.id, pos: v3(m.x, 0, m.z), fuseLit: m.fuse }) as unknown as Mine)
    w.explosions = []
    w.checkMarks = A.marks.map((m) => ({ id: m.id, pos: v3(m.x, 0.2, m.z), color: m.color }) as unknown as World['checkMarks'][number])
    if (this.meta) w.enemyAliveNum = this.meta.enemies
    // the other players' cursors
    const aims = bb?.aims ?? A.aims
    for (let i = 0; i < 4; i++) {
      if (i === this.me) continue
      const c = this.cursors[i]
      const aim = aims[i] && A.aims[i] ? { x: lerp(A.aims[i].x, aims[i].x), z: lerp(A.aims[i].z, aims[i].z) } : null
      if (!aim || i >= w.players) {
        c.visible = false
        continue
      }
      const s = projectToScreen({ x: aim.x, y: TANK.bodyHeight, z: aim.z })
      Object.assign(c, { x: s.x, y: s.y, clamped: false, far: false, visible: true })
    }
  }

  // ---- local player: input, prediction, reconciliation ------------------------------------

  private localInput(pad: PadState, w: World) {
    const me = this.me
    const t = w.playerTanks[me]
    const cur = this.cursors[me]
    const blocked = this.inputBlocked
    const ptr = pad.pointer ? pointerUnits(pad.pointer) : null
    if (ptr && !blocked) {
      const s = pointerToScreen(ptr.x, ptr.y, this.game.aspect, t.lives ? t : null)
      Object.assign(cur, s, { visible: true })
      const at = screenToField(s.x, s.y)
      this.aim = { x: at.x, z: at.z }
    } else if (pad.aimStick && !blocked) {
      this.aim = { x: t.pos.x + pad.aimStick.x * 200, z: t.pos.z + pad.aimStick.y * 200 }
      const s = projectToScreen({ x: this.aim.x, y: TANK.bodyHeight, z: this.aim.z })
      Object.assign(cur, { x: s.x, y: s.y, clamped: false, far: false, visible: true })
    }
    const raw: NetInput = {
      seq: ++this.seq,
      mx: blocked ? 0 : pad.moveX,
      my: blocked ? 0 : pad.moveY,
      analog: pad.analog,
      fire: !blocked && pad.fire,
      mine: !blocked && pad.mine,
      ax: this.aim.x,
      az: this.aim.z,
    }
    const inp = quantizeInput(raw)
    this.net.sendInput(inp)
    this.inputs.push(inp)
    if (this.inputs.length > 240) this.inputs.shift()
    if (this.predicting && this.ghost) this.stepGhost(inp, true)
  }

  /** the server's state of our tank arrived (at arrival, not at the playhead) */
  private reconcile(you: YouRec, gen: number) {
    const w = this.world
    const g = this.ghost
    const rec = this.cur?.tanks.get(this.me)
    const canPredict = !!w && !!g && gen === this.gen && this.me >= 0 && !!rec && !!(rec.flags & TF_ALIVE) && ((rec.flags >> TF_STATE_SHIFT) & 7) === 1
    while (this.inputs.length && this.inputs[0].seq <= you.ack) this.inputs.shift()
    if (!canPredict) {
      this.stopPredicting()
      return
    }
    this.hold = null
    const before = { x: g.pos.x + this.err.x, z: g.pos.z + this.err.z }
    const was = this.predicting
    // rewind to the server's tank...
    g.pos.x = you.x
    g.pos.z = you.z
    g.pos.y = 0
    axesFromForward(g.rot, v3(you.fx, 0, you.fz))
    const p = g.player
    p.speed = you.speed
    p.sign = you.sign
    p.freeze = you.freeze
    p.shellTimer = you.shellTimer
    p.mineTimer = you.mineTimer
    p.mineHeld = you.mineHeld
    const s = p.speed * p.sign
    g.vel.x = g.rot.z.x * s
    g.vel.z = g.rot.z.z * s
    g.vel.y = 0
    this.shells = you.shells
    this.mines = you.mines
    // ...and replay what it has not seen yet
    for (const i of this.inputs) this.stepGhost(i, false)
    this.predicting = true
    if (was) {
      this.err.x = before.x - g.pos.x
      this.err.z = before.z - g.pos.z
      const e = Math.hypot(this.err.x, this.err.z)
      this.stats.predError = this.stats.predError * 0.9 + e * 0.1
      if (e > SNAP_DIST) this.err.x = this.err.z = 0
    } else this.err.x = this.err.z = 0
  }

  private stopPredicting() {
    const g = this.ghost
    if (this.predicting && g && this.world) this.hold = { x: g.pos.x + this.err.x, z: g.pos.z + this.err.z, fx: g.rot.z.x, fz: g.rot.z.z }
    this.predicting = false
  }

  /** one frame of RPTnkTank physics + StatePlayerControl for the predicted tank */
  private stepGhost(inp: NetInput, live: boolean) {
    const g = this.ghost!
    const w = this.world!
    const it = g.intent
    it.moveX = inp.mx
    it.moveZ = inp.my
    it.analog = inp.analog
    if (inp.ax !== null && inp.az !== null) {
      it.aimX = inp.ax
      it.aimZ = inp.az
    }
    it.fire = inp.fire
    it.mine = inp.mine
    // World.physics for this tank: ApplyVelocity, ClearForces, CollideWithField, Integrate
    g.applyVelocity()
    g.clearForcesStep()
    g.hitRadius = TANK.fieldRadius
    const me = w.playerTanks[this.me]
    for (let i = 0; i < w.players; i++) {
      const o = w.playerTanks[i]
      if (o !== me && o.active && w.players >= 2) o.pushApartFrom(g)
    }
    for (const e of w.enemyTanks) if (e.active) e.pushApartFrom(g)
    collideActor(w, g, 0)
    g.integrateStep()
    // StatePlayerControl: aim, fire / mine (timers and the freeze only), drive
    const p = g.player
    p.aimAtCursor(g.turretRot, g.pos)
    if (it.mine) {
      if (!p.mineHeld && p.mineTimer === 0 && p.maxMines > this.mines) {
        this.mines++
        p.mineTimer = p.mineCooldown
        p.freeze = p.mineFreeze
        if (live) this.predictSound(['RP_TNK_SE_JIRAI_SET', 'RP_TNK_SE_JIRAI_SET_CSPK'], g)
      }
      p.mineHeld = true
    } else {
      if (it.fire && p.shellTimer === 0 && p.maxShells > this.shells) {
        this.shells++
        p.shellTimer = p.fireCooldown
        p.freeze = p.fireFreeze
        if (live) this.predictSound([this.me === 0 ? 'RP_TNK_SE_SHOOT_1P' : 'RP_TNK_SE_SHOOT_2P'], g)
      }
      p.mineHeld = false
    }
    if (--p.shellTimer < 0) p.shellTimer = 0
    if (--p.mineTimer < 0) p.mineTimer = 0
    p.calcMoveVelocity(g.rot, g.vel)
    g.speed = mag(g.vel)
  }

  /** our own shot / mine sounds play at once; the server's copy is skipped when it arrives */
  private predictSound(names: string[], g: Tank) {
    const until = performance.now() + 1500
    for (const n of names) {
      this.game.audio?.se(n, n.endsWith('_CSPK') ? undefined : g.pos)
      this.suppress.push({ name: n, until })
    }
  }
  private consumeSuppressed(name: string) {
    const now = performance.now()
    this.suppress = this.suppress.filter((s) => s.until > now)
    const i = this.suppress.findIndex((s) => s.name === name)
    if (i < 0) return false
    this.suppress.splice(i, 1)
    return true
  }

  /** our tank on screen: the prediction (smoothed), or the server's with our own turret aim */
  private showLocal(t: Tank) {
    const g = this.ghost
    if (this.predicting && g) {
      this.err.x *= 0.85
      this.err.z *= 0.85
      t.pos.x = g.pos.x + this.err.x
      t.pos.z = g.pos.z + this.err.z
      axesFromForward(t.rot, v3(g.rot.z.x, 0, g.rot.z.z))
      t.lives = 1
      t.state = 1
      t.speed = g.speed
    } else if (this.hold) {
      if (!t.lives || t.state !== 1) this.hold = null
      else {
        t.pos.x = this.hold.x
        t.pos.z = this.hold.z
        axesFromForward(t.rot, v3(this.hold.fx, 0, this.hold.fz))
      }
    }
    // the turret follows this client's cursor immediately (idle and driving states)
    if (t.lives && (t.state === 0 || t.state === 1)) {
      const dx = this.aim.x - t.pos.x
      const dz = this.aim.z - t.pos.z
      const len = Math.hypot(dx, dz)
      if (len > 0) axesFromForward(t.turretRot, v3(dx / len, 0, dz / len))
    }
  }
}
