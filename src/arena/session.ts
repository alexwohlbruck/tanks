// ArenaSession: the client side of the arena (src/arena/rules.ts). Mirrors what the server
// sends into a World for the existing renderer and effects, like NetSession does for rooms:
//   - snapshots (20 Hz) go on a timeline played ~120 ms behind the server: other tanks and
//     shells are interpolated, events fire when the playhead reaches them
//   - the own tank is predicted with the same drive + field collision code as the server
//     (driveTank / collideTank), reconciled against the server state of the last applied input
//   - the camera pans with the own tank; first person (V) works as in local play

import type { Pads, Session } from '../app/types'
import { fpvMove } from '../app/session'
import type { PadState } from '../input'
import type { Audio } from '../audio/audio'
import type { SceneView } from '../render/scene'
import { TANK } from '../sim/consts'
import { axesFromForward, v3 } from '../sim/vec'
import { cellHeight, cellKind, World, type Mine, type Shell, type SimEvent, Tank } from '../sim/world'
import * as THREE from 'three/webgpu'
import { generateMap, type ArenaMap } from './map'
import { ARENA_PROTO, TF_ALIVE, TF_LEVEL_SHIFT, TF_POWER_SHIFT, TF_PROTECT, TF_SHIELD, TF_STEALTH, type Board, type C2S, type NetEv, type S2C, type YouRec } from './protocol'
import { EMOTE_TICKS, ITEM_INFO, NUKE, PICKUP_INFO, PICKUP_KINDS, PICKUP_TYPE, powerStats, TEAM_COLORS, TEAM_NAMES, isItem, isTeamMode, type AnyPickup, type ArenaMode, type ArenaSize, type MapTheme, type PickupKind } from './rules'
import { paramsFor } from '../sim/stats'
import type { BaseModel } from '../render/registry'
import { tankIcon } from '../ui/web/art'
import { collect, progress, reach, unlock } from '../ui/shared/achievements'
import { ArenaField, collideTank, driveTank, newBody, type ArenaInput, type TankBody } from './sim'

type Snap = Extract<S2C, { t: 's' }>
type Feed = { at: number; text: string; html: string }

const DELAY = 7
/** most floor depth (world units, each way from the tank) the following camera shows */
const VIEW_DEPTH = 640
/** RPTnkCursor: the line to the tank shows from this far (layout units; app.ts FAR) */
const CURSOR_FAR = 480
const SNAP_DIST = 48
const NAME_KEY = 'tanks-net-name'
const ID_KEY = 'tanks-arena-id'

export function arenaUrl() {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/arena`
}

export class ArenaSession implements Session {
  readonly kind = 'arena'
  cursors = [0, 1, 2, 3].map(() => ({ x: 0, y: 0, clamped: false, far: false, visible: false }))
  status: 'connecting' | 'online' | 'closed' = 'connecting'
  error = ''
  mode: ArenaMode
  /** the arena's map size (an invite's arena decides it) */
  size: ArenaSize
  pid = 0
  tankId = 0
  /** when the own tank last spawned (performance.now), for the "you are here" marker */
  spawnedAt = 0
  map: ArenaMap | null = null
  field: ArenaField | null = null
  world: World | null = null
  board: Board | null = null
  /** when the last board arrived (performance.now), to move the zone between boards */
  boardAt = 0
  you: YouRec | null = null
  feed: Feed[] = []
  /** big centre messages (streaks, match end) */
  banner: { text: string; until: number } | null = null
  rtt = 0
  /** first person heading (set by the app while the view is on) */
  fpv: { player: number; yaw: number } | null = null
  /** the in-game menu is open: no input */
  inputBlocked = false
  onPause: (() => void) | null = null
  /** mouse wheel zoom of the following camera */
  zoom = 0.85
  /** set when the server changes the map (screen redraws its minimap) */
  mapVersion = 0

  private ws: WebSocket
  private snaps: Snap[] = []
  private a: Snap | null = null
  private localTick = 0
  private offset: number | null = null
  private body: TankBody = newBody()
  private inputs: ArenaInput[] = []
  private seq = 0
  private aim = { x: 0, z: 0 }
  private err = { x: 0, z: 0 }
  private predicting = false
  private mirror = new Map<number, Tank>()
  private free: Tank[] = []
  private names = new Map<number, { name: string; team: number; color: string }>()
  private treadOdo = new Map<Tank, { x: number; z: number; d: number }>()
  private marks: { id: number; x: number; z: number; color: number }[] = []
  private markId = 1
  private pickups: { id: number; x: number; z: number; kind: AnyPickup }[] = []
  /** live nukes (their danger rings) and recent big moments for the screen to draw:
   * nuke blasts and flare launches, by start time (ms); flare missiles in flight */
  nukes: { id: number; x: number; z: number; r: number; left: number }[] = []
  bursts: { kind: 'nuke' | 'flare'; x: number; z: number; r: number; at: number }[] = []
  flareShots: { id: number; x: number; z: number; vx: number; vz: number }[] = []
  /** a short camera shake (a nuke nearby), in world units, decaying */
  shake = 0
  private pingTimer: ReturnType<typeof setInterval>
  private lastFire = false
  private lastMine = false
  private lastFlare = false
  private lastNuke = false

  /** `invite`: join that arena, on that player's team (an invite link) */
  constructor(
    private view: SceneView,
    private audio: Audio,
    name: string,
    mode: ArenaMode,
    invite: { arena: string; with?: number } | null = null,
    size: ArenaSize = 'medium',
  ) {
    this.mode = mode
    this.size = size
    try {
      localStorage.setItem(NAME_KEY, name)
    } catch {}
    this.ws = new WebSocket(arenaUrl())
    this.ws.onopen = () => {
      this.status = 'online'
      this.send({ t: 'join', v: ARENA_PROTO, name, mode, size, id: ArenaSession.statId(), arena: invite?.arena, with: invite?.with })
    }
    this.ws.onclose = () => {
      this.status = 'closed'
      if (!this.error) this.error = 'Disconnected from the server.'
    }
    this.ws.onmessage = (e) => this.onMessage(JSON.parse(String(e.data)) as S2C)
    this.pingTimer = setInterval(() => this.send({ t: 'ping', c: performance.now() }), 2000)
    view.tankLook = (t) => this.lookOf(t)
  }

  /** this browser's stats id (server/arena/stats.ts), made once */
  static statId() {
    try {
      let id = localStorage.getItem(ID_KEY)
      if (!id || !/^[a-z0-9]{16,40}$/.test(id)) {
        id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 24)
        localStorage.setItem(ID_KEY, id)
      }
      return id
    } catch {
      return undefined
    }
  }

  /** a link that brings a friend into this arena, on this player's team */
  get inviteLink() {
    const a = this.board?.arena
    return a ? `${location.origin}${location.pathname}?arena=${encodeURIComponent(a)}&with=${this.pid}` : null
  }

  emote(i: number) {
    this.send({ t: 'emote', i })
  }
  vote(theme: string) {
    this.send({ t: 'vote', theme })
  }

  /** emotes on screen: pid -> [emote index, until (ms)] */
  emotes = new Map<number, [number, number]>()
  /** the player being watched while waiting to respawn */
  spectating: number | null = null

  static savedName() {
    try {
      return localStorage.getItem(NAME_KEY) ?? ''
    } catch {
      return ''
    }
  }

  /** development servers only */
  dev(power: string) {
    this.send({ t: 'dev', power })
  }

  private send(m: C2S) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(m))
  }

  dispose() {
    clearInterval(this.pingTimer)
    this.send({ t: 'leave' })
    this.ws.close()
    this.view.follow = null
    this.view.tankLook = null
    this.view.fpv = null
    this.audio.stopMusic(0.5)
    for (const k of this.loops) void this.audio.loop(k, '', 0)
  }

  // ---- messages ---------------------------------------------------------------------------

  private onMessage(m: S2C) {
    switch (m.t) {
      case 'welcome':
        this.pid = m.pid
        this.tankId = m.tank
        this.mode = m.mode
        this.size = m.size
        this.loadMap(m.seed, m.theme, m.broken)
        this.audio.playMusic('RP_TNK_BGM_LOOP2')
        return
      case 'map':
        this.loadMap(m.seed, m.theme, [])
        this.marks = []
        this.audio.playMusic('RP_TNK_BGM_LOOP2')
        return
      case 'board':
        // the match just ended: the campaign's victory fanfare if this player (or their team)
        // won it, the results music otherwise
        if (m.state === 'over' && this.board?.state === 'play') {
          const me = m.players.find((p) => p[0] === this.pid)
          const won = !!m.winner && !!me && (isTeamMode(this.mode) ? m.winner.name === ['Blue', 'Red'][me[2]] : m.winner.name === me[1] && m.winner.color === me[3])
          if (won) unlock('arena-win')
          this.audio.stopMusic(0.3)
          this.audio.playMusic(won ? 'RP_TNK_BGM_COMP20' : 'RP_TNK_BGM_RESULT2')
        }
        this.board = m
        this.boardAt = performance.now()
        for (const p of m.players) this.names.set(p[0], { name: p[1], team: p[2], color: p[3] })
        return
      case 's':
        this.onSnap(m)
        return
      case 'pong':
        this.rtt = this.rtt ? this.rtt * 0.8 + (performance.now() - m.c) * 0.2 : performance.now() - m.c
        return
      case 'error':
        this.error = m.message
        return
    }
  }

  private loadMap(seed: number, theme: MapTheme, broken: [number, number][]) {
    const map = generateMap(seed, this.mode, theme, this.size)
    for (const [c, r] of broken) map.cells[r][c] = 0
    this.map = map
    this.field = new ArenaField(map)
    const w = new World(1, { size: { cols: map.cols, rows: map.rows }, enemyCap: 100 })
    w.grid = map.cells.map((row) => row.map((code) => ({ kind: cellKind(code), code, height: cellHeight(code) })))
    for (const t of [...w.playerTanks, ...w.enemyTanks]) t.age = -999
    w.tanks = []
    this.world = w
    this.mirror.clear()
    this.free = [...w.enemyTanks]
    this.snaps = []
    this.a = null
    this.inputs = []
    this.predicting = false
    this.view.setWorld(w)
    this.mapVersion++
  }

  private onSnap(s: Snap) {
    const o = s.k - this.localTick
    if (this.offset === null || Math.abs(o - this.offset) > 30) this.offset = o
    else this.offset += (o - this.offset) * 0.05
    this.snaps.push(s)
    this.you = s.you
    this.reconcile(s.you)
  }

  // ---- per frame --------------------------------------------------------------------------

  step(pads: Pads) {
    this.localTick++
    const w = this.world
    if (!w || this.offset === null) return
    const pad = pads.merged
    this.localInput(pad)
    // playhead
    const rt = this.localTick + this.offset - DELAY
    while (this.snaps.length && this.snaps[0].k <= rt) {
      const s = this.snaps.shift()!
      this.applyEvents(s.E)
      this.a = s
    }
    this.applyContinuous(rt, w)
    w.frame++
    // the camera follows the own tank (or where it was destroyed)
    const me = w.playerTanks[0]
    // waiting to respawn: watch whoever destroyed you (the server sends the area around them)
    const spec = !me.active && this.you && !this.you.alive && this.you.spec ? this.mirror.get(this.you.spec) : undefined
    this.spectating = spec?.active ? ((spec.ai?.pid as number | undefined) ?? null) : null
    if (me.active) this.view.follow = { x: me.pos.x, z: me.pos.z }
    else if (spec?.active) {
      const f = this.view.follow ?? { x: spec.pos.x, z: spec.pos.z }
      this.view.follow = { x: f.x + (spec.pos.x - f.x) * 0.12, z: f.z + (spec.pos.z - f.z) * 0.12 }
    } else if (this.a?.you && !this.view.follow) this.view.follow = { x: this.a.you.x, z: this.a.you.z }
    this.view.followZoom = this.viewZoom()
    this.clampFollow()
    if (this.shake > 0.3 && this.view.follow) {
      this.view.follow = { x: this.view.follow.x + (Math.random() - 0.5) * this.shake, z: this.view.follow.z + (Math.random() - 0.5) * this.shake }
      this.shake *= 0.9
    } else this.shake = 0
    if (this.banner && performance.now() > this.banner.until) this.banner = null
  }

  /** keeps the view over the map: no wide strips of empty table past the border walls
   * (phones in portrait see far more depth than width) */
  /** the wheel / pinch zoom, but never showing more floor depth than VIEW_DEPTH each way
   * (a phone in portrait would otherwise see the whole map from edge to edge) */
  private viewZoom() {
    const cam = this.view.camera
    const depth = (cam.top - cam.bottom) / 2 / Math.sin((42 * Math.PI) / 180)
    return Math.max(this.zoom, depth / VIEW_DEPTH)
  }

  private clampFollow() {
    const f = this.view.follow
    const m = this.map
    if (!f || !m || this.view.fpv) return
    const cam = this.view.camera
    const zoom = this.viewZoom()
    const hw = (cam.right - cam.left) / 2 / zoom
    // the tilted view covers about half its height / sin(42) of floor depth each way
    const hd = (cam.top - cam.bottom) / 2 / zoom / Math.sin((42 * Math.PI) / 180)
    const W = (m.cols * 35) / 2 + 40
    const D = (m.rows * 35) / 2 + 40
    const clamp = (v: number, half: number, lim: number) => (half >= lim ? 0 : Math.max(-lim + half, Math.min(lim - half, v)))
    this.view.follow = { x: clamp(f.x, hw, W), z: clamp(f.z, hd, D) }
  }

  hudInput(pad: PadState) {
    if (pad.pause && !this.inputBlocked) {
      this.onPause?.()
      return true
    }
    return false
  }

  /** the own tank for first person */
  fpvTank(): Tank | null {
    const t = this.world?.playerTanks[0]
    return t && t.active ? t : null
  }

  // ---- input & prediction -----------------------------------------------------------------

  private localInput(pad: PadState) {
    const you = this.you
    const blocked = this.inputBlocked
    const alive = !!you?.alive
    const b = this.body
    // aim: the pointer on the turret plane, the right stick around the tank, or the view
    if (this.fpv) {
      this.aim = { x: b.pos.x + Math.cos(this.fpv.yaw) * 400, z: b.pos.z + Math.sin(this.fpv.yaw) * 400 }
    } else if (pad.aimStick && !blocked) {
      this.aim = { x: b.pos.x + pad.aimStick.x * 250, z: b.pos.z + pad.aimStick.y * 250 }
    } else if (pad.pointer && !blocked) {
      const p = this.pointerToWorld(pad.pointer.x, pad.pointer.y)
      if (p) this.aim = p
    }
    this.updateCursor(pad, blocked)
    const mv = blocked ? { ...pad, moveX: 0, moveY: 0 } : this.fpv ? fpvMove(pad, this.fpv.yaw) : pad
    const fire = !blocked && pad.fire && !this.lastFire
    const mine = !blocked && pad.mine && !this.lastMine
    this.lastFire = pad.fire
    this.lastMine = pad.mine
    const flare = !blocked && pad.flare && !this.lastFlare
    this.lastFlare = pad.flare
    const nuke = !blocked && pad.nuke && !this.lastNuke
    this.lastNuke = pad.nuke
    const inp: ArenaInput = { seq: ++this.seq, mx: mv.moveX, mz: mv.moveY, analog: mv.analog, ax: this.aim.x, az: this.aim.z, fire, mine, flare, nuke }
    this.send({ t: 'i', s: inp.seq, mx: r3(inp.mx), mz: r3(inp.mz), an: inp.analog ? 1 : 0, ax: Math.round(inp.ax), az: Math.round(inp.az), f: fire ? 1 : 0, m: mine ? 1 : 0, fl: flare ? 1 : 0, nk: nuke ? 1 : 0 })
    if (!alive || !this.field) {
      this.predicting = false
      this.inputs = []
      return
    }
    this.inputs.push(inp)
    if (this.inputs.length > 120) this.inputs.shift()
    if (this.predicting) this.predictStep(inp)
    this.err.x *= 0.85
    this.err.z *= 0.85
  }

  private predictStep(inp: ArenaInput) {
    const b = this.body
    b.pos.x += b.vel.x
    b.pos.z += b.vel.z
    for (const k of [b.acc.p[0], b.acc.p[1], b.acc.v[0], b.acc.v[1]]) k.x = k.y = k.z = 0
    collideTank(this.field!, b)
    b.pos.x += b.acc.p[0].x + b.acc.p[1].x
    b.pos.z += b.acc.p[0].z + b.acc.p[1].z
    b.vel.x += b.acc.v[0].x + b.acc.v[1].x
    b.vel.z += b.acc.v[0].z + b.acc.v[1].z
    driveTank(b, inp, powerStats(this.you?.power ?? null, paramsFor(0)).speedMul)
  }

  /** server state of the own tank after input `you.a`: replay what came after */
  private reconcile(you: YouRec) {
    if (!you.alive || !this.field) {
      this.predicting = false
      return
    }
    const b = this.body
    const before = this.predicting ? { x: b.pos.x, z: b.pos.z } : null
    b.pos.x = you.x
    b.pos.z = you.z
    b.vel.x = you.vx
    b.vel.z = you.vz
    axesFromForward(b.rot, v3(you.fx, 0, you.fz))
    b.pc.speed = you.sp
    b.pc.sign = you.sg
    b.pc.freeze = you.fr
    this.inputs = this.inputs.filter((i) => i.seq > you.a)
    for (const i of this.inputs) this.predictStep(i)
    if (before) {
      const dx = before.x - b.pos.x, dz = before.z - b.pos.z
      if (Math.hypot(dx + this.err.x, dz + this.err.z) > SNAP_DIST) this.err = { x: 0, z: 0 }
      else this.err = { x: this.err.x + dx, z: this.err.z + dz }
    }
    this.predicting = true
  }

  /** the classic aiming cursor (RPTnkCursor effects, drawn by the app): on the pointer, or
   * where the right stick aims; its line to the tank shows once it is CURSOR_FAR away */
  private updateCursor(pad: PadState, blocked: boolean) {
    const c = this.cursors[0]
    const lh = this.view.layoutHalf
    if (blocked || this.fpv || (!pad.pointer && !pad.aimStick)) return void (c.visible = false)
    if (pad.aimStick) Object.assign(c, this.view.projectToLayout(this.aim.x, TANK.bodyHeight, this.aim.z))
    else if (pad.pointer) Object.assign(c, { x: (pad.pointer.x * 2 - 1) * lh.x, y: (1 - pad.pointer.y * 2) * lh.y })
    const t = this.world?.playerTanks[0]
    if (t?.active) {
      const tp = this.view.projectToLayout(t.pos.x, t.pos.y + TANK.bodyHeight, t.pos.z)
      c.far = Math.hypot(c.x - tp.x, c.y - tp.y) >= CURSOR_FAR
    } else c.far = false
    c.visible = true
  }

  cursorInfo() {
    const t = this.world?.playerTanks[0]
    const alive = !!t?.active && !!this.you?.alive
    return { tanks: [alive ? t! : null], mode: (_p: number, far: boolean): 0 | 1 | 2 | 3 => (alive && far ? 2 : 1) }
  }

  private ray = new THREE.Raycaster()
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -TANK.bodyHeight)
  private pointerToWorld(px: number, py: number) {
    const cam = this.view.camera
    this.ray.setFromCamera(new THREE.Vector2(px * 2 - 1, 1 - py * 2), cam)
    const out = new THREE.Vector3()
    return this.ray.ray.intersectPlane(this.plane, out) ? { x: out.x, z: out.z } : null
  }

  // ---- mirror -----------------------------------------------------------------------------

  private tankFor(id: number): Tank | null {
    const w = this.world!
    if (id === this.tankId) return w.playerTanks[0]
    let t = this.mirror.get(id)
    if (!t) {
      t = this.free.pop()
      if (!t) return null
      t.ai = { arenaId: id }
      this.mirror.set(id, t)
    }
    return t
  }

  /** an enemy White this client cannot see */
  hidden(t: Tank) {
    return !!(((t.ai?.flags as number) ?? 0) & TF_STEALTH)
  }

  /** a tank's shield is up / its kill-streak level */
  shieldOf(t: Tank) {
    return !!(((t.ai?.flags as number) ?? 0) & TF_SHIELD)
  }
  levelOf(t: Tank) {
    return (((t.ai?.flags as number) ?? 0) >> TF_LEVEL_SHIFT) & 3
  }

  /** the special tank a tank has turned into (from its snapshot flags) */
  powerOf(t: Tank): PickupKind | null {
    const pw = (((t.ai?.flags as number) ?? 0) >> TF_POWER_SHIFT) & 15
    return pw ? PICKUP_KINDS[pw - 1] : null
  }

  /** Battle royale: the zone now, moved on from the last board at its closing speed */
  zoneNow(): { x: number; z: number; r: number; next: number } | null {
    const z = this.board?.zone
    if (!z) return null
    const [x, y, r, next, speed] = z
    return { x, z: y, r: Math.max(next, r - (speed * (performance.now() - this.boardAt)) / 1000), next }
  }

  private lookOf(t: Tank): { base: BaseModel; color?: string } | { type: number } {
    const pid = t === this.world?.playerTanks[0] ? this.pid : (t.ai?.pid as number | undefined)
    const p = pid !== undefined ? this.names.get(pid) : undefined
    const power = this.powerOf(t)
    if (power) return { type: PICKUP_TYPE[power] }
    if (!p) return { base: '1p', color: '#8a8a8a' }
    if (isTeamMode(this.mode)) return { base: p.team === 1 ? '2p' : '1p' }
    if (p.color === TEAM_COLORS[0]) return { base: '1p' }
    if (p.color === TEAM_COLORS[1]) return { base: '2p' }
    return { base: '1p', color: p.color }
  }

  nameOf(pid: number) {
    return this.names.get(pid)
  }

  private applyContinuous(rt: number, w: World) {
    const A = this.a
    if (!A) return
    const B = this.snaps[0]
    const k = B ? Math.max(0, Math.min(1, (rt - A.k) / (B.k - A.k || 1))) : 0
    const lerp = (x: number, y: number) => x + (y - x) * k
    const lerpAng = (x: number, y: number) => {
      let d = y - x
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      return x + d * k
    }
    const bT = new Map(B?.T.map((r) => [r[0], r]) ?? [])
    const tanks: Tank[] = []
    const seen = new Set<number>()
    for (const ra of A.T) {
      const id = ra[0]
      const t = this.tankFor(id)
      if (!t) continue
      seen.add(id)
      const rb = bT.get(id)
      const near = rb && Math.hypot(rb[1] - ra[1], rb[2] - ra[2]) < 40
      if (!t.active) {
        t.spawn(v3(ra[1], 0, ra[2]), 0)
        this.treadOdo.delete(t)
      }
      t.ai = { ...t.ai, pid: ra[6], flags: ra[5] }
      t.lives = ra[5] & TF_ALIVE ? 1 : 0
      if (id === this.tankId && this.predicting) {
        // own tank: the prediction (+ the decaying correction)
        const b = this.body
        t.pos.x = b.pos.x + this.err.x
        t.pos.z = b.pos.z + this.err.z
        axesFromForward(t.rot, v3(b.rot.z.x, 0, b.rot.z.z))
        axesFromForward(t.turretRot, v3(b.turretRot.z.x, 0, b.turretRot.z.z))
        t.lives = 1
      } else {
        t.pos.x = near ? lerp(ra[1], rb![1]) : ra[1]
        t.pos.z = near ? lerp(ra[2], rb![2]) : ra[2]
        const body = near ? lerpAng(ra[3], rb![3]) : ra[3]
        const turret = near ? lerpAng(ra[4], rb![4]) : ra[4]
        axesFromForward(t.rot, v3(Math.cos(body), 0, Math.sin(body)))
        axesFromForward(t.turretRot, v3(Math.cos(turret), 0, Math.sin(turret)))
      }
      // spawn protection blinks
      // spawn protection blinks; an enemy White is hidden (its tracks still show)
      const prot = ra[5] & TF_PROTECT
      const hidden = !!(ra[5] & TF_STEALTH)
      t.state = hidden || (prot && Math.floor(this.localTick / 4) % 4 === 0) ? 2 : 1
      t.stealth = hidden || !!prot
      this.tread(t)
      tanks.push(t)
    }
    // the own tank keeps moving with the prediction even before the playhead has it
    const me = w.playerTanks[0]
    if (this.predicting && !seen.has(this.tankId) && this.you?.alive) {
      if (!me.active) me.spawn(v3(this.body.pos.x, 0, this.body.pos.z), 0)
      me.lives = 1
      me.pos.x = this.body.pos.x
      me.pos.z = this.body.pos.z
      axesFromForward(me.rot, v3(this.body.rot.z.x, 0, this.body.rot.z.z))
      axesFromForward(me.turretRot, v3(this.body.turretRot.z.x, 0, this.body.turretRot.z.z))
      seen.add(this.tankId)
      tanks.push(me)
    }
    for (const [id, t] of this.mirror)
      if (!seen.has(id)) {
        t.age = -999
        this.mirror.delete(id)
        this.free.push(t)
      }
    if (!seen.has(this.tankId) && me.active) me.age = -999
    w.tanks = tanks
    // shells
    const bS = new Map(B?.S.map((r) => [r[0], r]) ?? [])
    w.bullets = A.S.map((s) => {
      const n = bS.get(s[0])
      const near = n && Math.hypot(n[1] - s[1], n[2] - s[2]) < 30
      const x = near ? lerp(s[1], n![1]) : s[1]
      const z = near ? lerp(s[2], n![2]) : s[2]
      const vx = near ? n![3] : s[3]
      const vz = near ? n![4] : s[4]
      return { id: s[0], pos: v3(x, TANK.bodyHeight, z), vel: v3(vx, 0, vz), smokeType: s[5] } as unknown as Shell
    })
    // flare missiles
    const bF = new Map(B?.F.map((r) => [r[0], r]) ?? [])
    this.flareShots = A.F.map((f) => {
      const n = bF.get(f[0])
      const near = n && Math.hypot(n[1] - f[1], n[2] - f[2]) < 40
      return { id: f[0], x: near ? lerp(f[1], n![1]) : f[1], z: near ? lerp(f[2], n![2]) : f[2], vx: near ? n![3] : f[3], vz: near ? n![4] : f[4] }
    })
    // a nuke is drawn as a big mine
    w.mines = A.M.map((m) => ({ id: m[0], pos: v3(m[1], 0, m[2]), fuseLit: !!m[3], arenaScale: m[4] ? NUKE_SCALE : 1 }) as unknown as Mine)
    this.nukes = A.M.filter((m) => m[4]).map((m) => ({ id: m[0], x: m[1], z: m[2], r: m[4], left: m[5] / NUKE.fuse }))
    w.explosions = []
    w.checkMarks = this.marks.map((m) => ({ id: m.id, pos: v3(m.x, 0.2, m.z), color: m.color }) as unknown as World['checkMarks'][number])
    this.pickups = A.K.map((k) => ({ id: k[0], x: k[1], z: k[2], kind: k[3] }))
    // mine fuse beeps
    for (const m of A.M) if (m[3] && Math.floor(this.localTick / (m[4] ? 5 : 8)) % 4 === 0) this.sound('RP_TNK_SE_JIRAI_TIMER', m[1], m[2], m[4] ? 0.9 : 0.6)
    this.rocketLoops(w.bullets)
  }

  private loops = new Set<string>()
  /** rockets' flight loops (RP_TNK_SE_SHOOT_ENEMY3/7_LV), the nearest few */
  private rocketLoops(shells: Shell[]) {
    const f = this.view.follow ?? { x: 0, z: 0 }
    const near = shells
      .filter((s) => s.smokeType > 0)
      .map((s) => ({ s, d: Math.hypot(s.pos.x - f.x, s.pos.z - f.z) }))
      .filter((x) => x.d < 1000)
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
    const keep = new Set<string>()
    for (const { s, d } of near) {
      const key = `rk${s.id}`
      keep.add(key)
      this.loops.add(key)
      void this.audio.loop(key, s.smokeType === 2 ? 'RP_TNK_SE_SHOOT_ENEMY7_LV' : 'RP_TNK_SE_SHOOT_ENEMY3_LV', 0.6 * Math.max(0, 1 - d / 1000))
    }
    for (const k of this.loops)
      if (!keep.has(k)) {
        void this.audio.loop(k, '', 0)
        this.loops.delete(k)
      }
  }

  /** tread marks every 10 units of travel (RPTnkTank::DrawTreadMark) */
  private tread(t: Tank) {
    const o = this.treadOdo.get(t)
    if (!o) return void this.treadOdo.set(t, { x: t.pos.x, z: t.pos.z, d: 0 })
    const dx = t.pos.x - o.x, dz = t.pos.z - o.z
    const d = Math.hypot(dx, dz)
    if (d > 60) return void this.treadOdo.set(t, { x: t.pos.x, z: t.pos.z, d: 0 })
    o.d += d
    o.x = t.pos.x
    o.z = t.pos.z
    if (o.d >= 10 && d > 0) {
      o.d -= 10
      this.view.onEvents([{ t: 'tread', tank: t, pos: v3(t.pos.x - (dx / d) * 4, 0, t.pos.z - (dz / d) * 4), dir: v3(-dx / d, 0, -dz / d) }])
    }
  }

  get pickupList() {
    return this.pickups
  }

  // ---- events -----------------------------------------------------------------------------

  private sound(name: string, x: number, z: number, vol = 1) {
    const f = this.view.follow ?? { x: 0, z: 0 }
    const d = Math.hypot(x - f.x, z - f.z)
    const v = Math.max(0, 1 - d / 1300) ** 1.5 * vol
    if (v < 0.03) return
    this.audio.play(name, { volume: v, pan: Math.max(-0.8, Math.min(0.8, (x - f.x) / 800)) })
  }

  private applyEvents(E: NetEv[]) {
    const w = this.world!
    const sim: SimEvent[] = []
    for (const e of E) {
      switch (e[0]) {
        case 'shot': {
          const t = this.tankFor(e[1])
          const mine = e[1] === this.tankId
          if (t?.active) sim.push({ t: 'shoot', tank: t, bullet: {} as Shell })
          // the special tanks' own shot sounds (rockets have a flight loop instead, see rocketLoops)
          const type = e[5]
          const se = SHOT_SE[type] ?? (type ? 'RP_TNK_SE_SHOOT' : mine ? 'RP_TNK_SE_SHOOT_1P' : 'RP_TNK_SE_SHOOT_2P')
          this.sound(se, e[2], e[3], mine ? 1 : 0.7)
          break
        }
        case 'ric':
          sim.push({ t: 'ricochet', bullet: {} as Shell, pos: v3(e[1], TANK.bodyHeight, e[2]), super: false })
          this.sound('RP_TNK_SE_REFLECT', e[1], e[2])
          break
        case 'die':
          sim.push({ t: 'bulletDie', bullet: {} as Shell, pos: v3(e[1], TANK.bodyHeight, e[2]), reason: e[3] ? 'wall' : 'tank' })
          if (e[3]) this.sound('RP_TNK_SE_BROKEN', e[1], e[2], 0.8)
          break
        case 'clash':
          sim.push({ t: 'bulletDie', bullet: {} as Shell, pos: v3(e[1], TANK.bodyHeight, e[2]), reason: 'wall' })
          this.sound('RP_TNK_SE_BROKEN', e[1], e[2], 0.8)
          break
        case 'kill': {
          const [, id, x, z, victim, killer, cause, streak, layer, tk] = e
          // achievements (src/ui/shared/achievements.ts arena hooks), for this player only
          if (killer === this.pid && victim !== this.pid && !tk) {
            unlock('arena-first-kill')
            progress('arena-kills-100')
            reach('arena-streak-5', streak)
            if ((cause === 'mine' || cause === 'nuke') && layer && layer !== this.pid) unlock('arena-mine-steal')
          }
          const t = this.tankFor(id)
          if (t) {
            t.pos.x = x
            t.pos.z = z
            t.ai = { ...t.ai, pid: victim }
            sim.push({ t: 'tankDie', tank: t, by: 0, cause: cause as 'shell' | 'mine', killer: null })
            if (id === this.tankId) this.predicting = false
          }
          const v = this.names.get(victim)
          const color = isTeamMode(this.mode) ? (v?.team ?? 9) : 9
          this.marks.push({ id: this.markId++, x, z, color })
          if (this.marks.length > 60) this.marks.shift()
          this.sound('RP_TNK_SE_HIT', x, z, 1)
          this.killFeed(victim, killer, cause, streak, !!tk)
          break
        }
        case 'mset':
          this.sound('RP_TNK_SE_JIRAI_SET', e[1], e[2])
          break
        case 'fuse':
          break
        case 'boom':
          sim.push({ t: 'mineExplode', mine: { pos: v3(e[1], 0, e[2]), arenaScale: e[3] ? NUKE_SCALE : 1 } as unknown as Mine })
          this.sound('RP_TNK_SE_JIRAI_EXP', e[1], e[2])
          if (e[3]) {
            // a nuke: a ring of blasts and a shockwave, the view shakes
            for (let i = 0; i < 8; i++) {
              const a = (i / 8) * Math.PI * 2
              sim.push({ t: 'mineExplode', mine: { pos: v3(e[1] + Math.cos(a) * e[3] * 0.55, 0, e[2] + Math.sin(a) * e[3] * 0.55), arenaScale: 1.2 } as unknown as Mine })
            }
            this.bursts.push({ kind: 'nuke', x: e[1], z: e[2], r: e[3], at: performance.now() })
            this.view.scorch(e[1], e[2], e[3])
            this.sound('RP_TNK_SE_HIT', e[1], e[2], 1)
            const f = this.view.follow ?? { x: 0, z: 0 }
            this.shake = Math.max(this.shake, 14 * Math.max(0, 1 - Math.hypot(e[1] - f.x, e[2] - f.z) / 1400))
          }
          break
        case 'shpop':
          sim.push({ t: 'ricochet', bullet: {} as Shell, pos: v3(e[2], TANK.bodyHeight, e[3]), super: false })
          this.sound('RP_TNK_SE_REFLECT', e[2], e[3], 1)
          this.sound('RP_TNK_SE_BROKEN', e[2], e[3], 0.8)
          if (e[1] === this.tankId) this.banner = { text: 'Shield down!', until: performance.now() + 1400 }
          break
        case 'flare':
          this.bursts.push({ kind: 'flare', x: e[2], z: e[3], r: 45, at: performance.now() })
          this.sound('RP_TNK_SE_SHOOT_ENEMY8', e[2], e[3], 1)
          this.sound('RP_TNK_SE_SHOOT_ENEMY4', e[2], e[3], 0.7)
          break
        case 'fhit':
          // a missile got a shell
          sim.push({ t: 'bulletDie', bullet: {} as Shell, pos: v3(e[1], TANK.bodyHeight, e[2]), reason: 'wall' })
          this.sound('RP_TNK_SE_BROKEN', e[1], e[2], 0.8)
          break
        case 'brk': {
          const [, c, r, h] = e
          if (this.field) this.field.code[r * this.field.cols + c] = 0
          const g = w.grid[r]?.[c]
          if (g) {
            g.kind = 0
            g.code = 0
            g.height = 0
          }
          if (this.map) this.map.cells[r][c] = 0
          sim.push({ t: 'blockBreak', cx: c, cz: r, height: h })
          this.mapVersion++
          break
        }
        case 'pick': {
          const [, id, kind, x, z] = e
          if (id === this.tankId) {
            this.audio.play('RP_TNK_SE_TNK1UP')
            if (isItem(kind)) {
              const it = ITEM_INFO[kind]
              this.banner = { text: `${it.name}: ${it.trick}!`, until: performance.now() + 1800 }
            } else {
              const info = PICKUP_INFO[kind as PickupKind]
              if (info) collect('arena-all-specials', info.name)
              if (info) this.banner = { text: `${info.name} tank: ${info.trick}!`, until: performance.now() + 1800 }
            }
          } else this.sound('RP_TNK_SE_GET_TNKNUM', x, z, 0.6)
          break
        }
        case 'emo':
          this.emotes.set(e[1], [e[2], performance.now() + (EMOTE_TICKS / 60) * 1000])
          if (e[1] !== this.pid) this.audio.play('RP_COMMON_SE_Balloon_OPEN_01', { volume: 0.5 })
          break
        case 'spawn':
          if (e[1] === this.tankId) {
            this.view.follow = { x: e[2], z: e[3] }
            this.spawnedAt = performance.now()
            this.audio.play('RP_TNK_SE_GAMESTART')
          }
          break
        case 'round': {
          // Elimination: a round starts, or is decided
          const [, n, team, start] = e
          const me = this.board?.players.find((p) => p[0] === this.pid)
          if (start) this.banner = { text: `Round ${n}`, until: performance.now() + 1800 }
          else this.banner = { text: team < 0 ? `Round ${n}: a draw` : me && me[2] === team ? `Your team wins round ${n}!` : `${TEAM_NAMES[team]} wins round ${n}`, until: performance.now() + 3000 }
          this.audio.play(start ? 'RP_TNK_SE_GAMESTART' : 'RP_TNK_SE_MISSION_BONUS')
          break
        }
        case 'match':
          // (the end-of-match music starts with the board that names the winner)
          if (e[1] === 'over') this.audio.stopMusic(0.3)
          break
      }
    }
    if (sim.length) this.view.onEvents(sim)
  }

  private killFeed(victim: number, killer: number, cause: string, streak: number, tk: boolean) {
    const v = this.names.get(victim)
    const k = this.names.get(killer)
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
    const tag = (p: { name: string; color: string; team: number } | undefined, pid: number) => {
      if (!p) return '<b>?</b>'
      const c = isTeamMode(this.mode) ? TEAM_COLORS[p.team] : p.color
      const dark = `#${new THREE.Color(c).multiplyScalar(0.55).getHexString()}`
      return `<span class="who ${pid === this.pid ? 'me' : ''}">${tankIcon(c, dark).outerHTML}<b>${esc(p.name)}</b></span>`
    }
    const how = cause === 'nuke' ? NUKE_ICON : cause === 'mine' ? MINE_ICON : SHELL_ICON
    let html: string
    let text: string
    if (killer === victim) {
      html = `${tag(v, victim)} <i>${cause === 'nuke' ? 'caught in their own nuke' : cause === 'mine' ? 'stepped on their own mine' : 'hit by their own shell'}</i>`
      text = `${v?.name} self-destructed`
    } else if (cause === 'zone') {
      html = `${tag(v, victim)} <i>was caught outside the zone</i>`
      text = `${v?.name} was caught outside the zone`
    } else if (!killer) {
      html = `${tag(v, victim)} <i>was destroyed</i>`
      text = `${v?.name} was destroyed`
    } else if (tk) {
      html = `${tag(k, killer)} <span class="how">${how}</span> ${tag(v, victim)} <i>teammate!</i>`
      text = `${k?.name} destroyed a teammate`
    } else {
      html = `${tag(k, killer)} <span class="how">${how}</span> ${tag(v, victim)}`
      text = `${k?.name} destroyed ${v?.name}`
    }
    this.feed.push({ at: performance.now(), text, html })
    if (this.feed.length > 6) this.feed.shift()
    if (killer === this.pid && victim !== this.pid && tk) {
      this.banner = { text: 'That was a teammate! −1', until: performance.now() + 1800 }
      this.audio.play('RP_TNK_SE_GET_HIT')
    } else if (killer === this.pid && victim !== this.pid) {
      const word = STREAKS[streak]
      const up = LEVEL_UP[streak]
      this.banner = { text: up ? `${word ?? 'Streak!'} ${up}` : word ? `${word}` : `Destroyed ${v?.name ?? ''}`, until: performance.now() + (up ? 2400 : 1600) }
      this.audio.play(streak >= 3 ? 'RP_TNK_SE_MISSION_BONUS' : 'RP_TNK_SE_GET_HIT')
    } else if (victim === this.pid) {
      this.banner = { text: cause === 'zone' ? 'Caught outside the zone!' : killer === victim ? 'Oops!' : `Destroyed by ${k?.name ?? '?'}`, until: performance.now() + 2600 }
    }
  }
}

const r3 = (v: number) => Math.round(v * 1000) / 1000
const SHELL_ICON = '<svg class="how" viewBox="0 0 24 10"><path d="M1 5c3-3 7-4 10-4h12v8H11C8 9 4 8 1 5z" fill="#f6f3ea" stroke="#5b3a19" stroke-width="1.4"/></svg>'
const MINE_ICON = '<svg class="how" viewBox="0 0 24 24"><circle cx="12" cy="13" r="9.5" fill="#e8c33a" stroke="#5b3a19" stroke-width="1.6"/><circle cx="12" cy="13" r="4" fill="#cf2a31"/></svg>'
const STREAKS: Record<number, string> = { 3: 'Triple!', 5: 'Rampage!', 6: 'On fire!', 8: 'Unstoppable!', 12: 'Tank legend!' }
/** the streak levels (rules STREAK_LEVELS) */
const LEVEL_UP: Record<number, string> = { 3: 'Power ×2', 6: 'Power ×3' }
/** a nuke is drawn as a mine this much bigger */
const NUKE_SCALE = 3
const NUKE_ICON = '<svg class="how" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10.5" fill="#f2c230" stroke="#5b3a19" stroke-width="1.6"/><path d="M12 12L7 3.5a10 10 0 0 1 10 0zM12 12l9.8 1.5a10 10 0 0 1-5 8.6zM12 12l-4.8 9.1a10 10 0 0 1-5-8.6z" fill="#2a1a0a"/><circle cx="12" cy="12" r="2" fill="#f2c230" stroke="#2a1a0a"/></svg>'
/** RPTnkTank::PlayFireSe per enemy type (3 / 7 / 9 fire rockets: their flight loop plays) */
const SHOT_SE: Record<number, string> = { 4: 'RP_TNK_SE_SHOOT_ENEMY4', 5: 'RP_TNK_SE_SHOOT_ENEMY5', 6: 'RP_TNK_SE_SHOOT_ENEMY6', 8: 'RP_TNK_SE_SHOOT_ENEMY8' }
