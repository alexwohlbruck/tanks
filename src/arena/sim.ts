// Arena simulation (server-authoritative; the client re-runs `driveTank` + `collideTank` to
// predict its own tank). The pieces follow the ported game (src/sim): the player tank's
// controller (PlayerController.calcMoveVelocity), RPTnkTestCircleVsWall against block edges,
// the push-out accumulators, shell ricochets, the mine arm / fuse / blast cycle and the hit radii.
// What changes for a big shared map: any number of tanks, a cell lookup instead of scanning every
// block, owners by tank id, teams, respawns, pickups and the match flow.

import { MINE, SHELL, TANK, WALL_MARGIN } from '../sim/consts'
import { testCircleVsWall, type Wall } from '../sim/field'
import { PlayerController } from '../sim/player'
import { paramsFor } from '../sim/stats'
import { type Axes, type V3, accumulate, axesFromForward, dot, heading, identityAxes, mag, normalize, v3 } from '../sim/vec'
import { cellOf, cellPos, generateMap, mulberry, type ArenaMap } from './map'
import {
  ARENA_TPS,
  BOT_NAMES,
  FFA_COLORS,
  INTERMISSION_TICKS,
  MATCH_TICKS,
  PICKUP_KINDS,
  PICKUP_RADIUS,
  PICKUP_RESPAWN,
  PICKUP_TICKS,
  PICKUP_TYPE,
  PROTECT_TICKS,
  SPAWN_IDEAL,
  SPAWN_SAFE,
  SPAWN_SIGHT,
  RESPAWN_TICKS,
  TEAM_COLORS,
  powerStats,
  HOMING,
  FLARE,
  NUKE,
  PICKUP_WEIGHT,
  ITEM_KINDS,
  SHIELD,
  flareRange,
  flareSwarm,
  nukeBlast,
  streakLevel,
  type AnyPickup,
  MAP_THEMES,
  SIZES,
  type ArenaSize,
  type MapTheme,
  type ArenaMode,
  type PickupKind,
  ELIM,
  ROYALE,
  isOneLife,
  isTeamMode,
  zoneRadius,
} from './rules'

export type ArenaInput = { seq: number; mx: number; mz: number; analog: boolean; ax: number; az: number; fire: boolean; mine: boolean; flare?: boolean; nuke?: boolean }
export const IDLE_INPUT: ArenaInput = { seq: 0, mx: 0, mz: 0, analog: false, ax: 0, az: 0, fire: false, mine: false, flare: false, nuke: false }

type Accum = { p: [V3, V3]; v: [V3, V3] }
const accum = (): Accum => ({ p: [v3(), v3()], v: [v3(), v3()] })
function clearAccum(a: Accum) {
  for (const k of [a.p[0], a.p[1], a.v[0], a.v[1]]) k.x = k.y = k.z = 0
}
function integrate(pos: V3, vel: V3, a: Accum) {
  pos.x += a.p[0].x + a.p[1].x
  pos.z += a.p[0].z + a.p[1].z
  vel.x += a.v[0].x + a.v[1].x
  vel.z += a.v[0].z + a.v[1].z
}

/** the parts of a tank the movement code needs (shared with the client's prediction) */
export type TankBody = {
  pos: V3
  vel: V3
  rot: Axes
  turretRot: Axes
  intent: { moveX: number; moveZ: number; analog: boolean; aimX: number; aimZ: number }
  pc: PlayerController
  acc: Accum
}

export function newBody(): TankBody {
  const b = {
    pos: v3(),
    vel: v3(),
    rot: identityAxes(),
    turretRot: identityAxes(),
    intent: { moveX: 0, moveZ: 0, analog: false, aimX: 0, aimZ: 0 },
    acc: accum(),
  } as TankBody
  // the controller only reads `tank.intent` for driving and aiming
  b.pc = new PlayerController(b as never, null as never)
  b.pc.reset()
  return b
}

/** static map geometry + the cells still standing */
export class ArenaField {
  cols: number
  rows: number
  /** current code per cell (cork cells become 0 when broken) */
  code: Int16Array
  walls: Wall[]
  width: number
  depth: number

  constructor(public map: ArenaMap) {
    this.cols = map.cols
    this.rows = map.rows
    this.code = new Int16Array(map.cols * map.rows)
    for (let y = 0; y < map.rows; y++) for (let x = 0; x < map.cols; x++) this.code[y * map.cols + x] = map.cells[y][x]
    this.width = map.cols * 35
    this.depth = map.rows * 35
    // RPTnkField::InitWalls for this size
    const h = 0.5, m = WALL_MARGIN, w = this.width, d = this.depth
    this.walls = [
      { pos: v3(h * w + m, 0, h * -d), normal: v3(0, 0, 1), length: w + 2 * m, id: 0 },
      { pos: v3(h * w, 0, h * d + m), normal: v3(-1, 0, 0), length: d + 2 * m, id: 0 },
      { pos: v3(-(h * w + m), 0, h * d), normal: v3(0, 0, -1), length: w + 2 * m, id: 0 },
      { pos: v3(-(h * w), 0, -(h * d + m)), normal: v3(1, 0, 0), length: d + 2 * m, id: 0 },
    ]
  }

  at(c: number, r: number) {
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return 202
    return this.code[r * this.cols + c]
  }
  /** stack height of a cell (0 = empty, 1 = hole) */
  height(c: number, r: number) {
    const k = this.at(c, r)
    return k >= 100 && k <= 107 ? k - 99 : k >= 200 && k <= 207 ? k - 199 : 0
  }
  isInside(p: V3) {
    return Math.abs(p.x) <= this.width / 2 && Math.abs(p.z) <= this.depth / 2
  }
  /** RPTnkBlockPool::IsPointInsideBlock (holes don't count) */
  pointInBlock(x: number, z: number) {
    const [c, r] = cellOf(this, x, z)
    return this.height(c, r) > 1
  }

  /** straight shell line from a to b (holes don't stop shells) */
  clearLine(ax: number, az: number, bx: number, bz: number) {
    const d = Math.hypot(bx - ax, bz - az)
    const n = Math.ceil(d / 8)
    for (let i = 1; i < n; i++) if (this.pointInBlock(ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n)) return false
    return true
  }

  /**
   * RPTnkField::CollideActor: border walls, then the blocks near the circle. mode bit 0 = pass
   * over holes (shells), bit 1 = skip edges shared with a non-hole neighbour (shells).
   */
  collide(center: V3, radius: number, mode: number, hit: (depth: number, n: V3) => void): boolean {
    let any = false
    for (const wall of this.walls) {
      const h = testCircleVsWall(radius, center, wall)
      if (h) {
        hit(h.depth, h.normal)
        any = true
      }
    }
    const [c0, r0] = cellOf(this, center.x, center.z)
    const k = Math.ceil((35 + radius) / 35)
    for (let r = r0 - k; r <= r0 + k; r++)
      for (let c = c0 - k; c <= c0 + k; c++) {
        const h = this.height(c, r)
        if (!h || (mode & 1 && h === 1)) continue
        if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) continue
        const p = cellPos(this, c, r)
        if (Math.abs(center.x - p.x) > 35 + radius || Math.abs(center.z - p.z) > 35 + radius) continue
        const edges = blockEdges(p.x, p.z)
        const nb = [this.height(c, r - 1), this.height(c + 1, r), this.height(c, r + 1), this.height(c - 1, r)]
        for (let i = 0; i < 4; i++) {
          if (mode & 2 && nb[i] > 1) continue
          const e = testCircleVsWall(radius, center, edges[i])
          if (e) {
            hit(e.depth, e.normal)
            any = true
          }
        }
      }
    return any
  }
}

const EDGE_N = [v3(0, 0, -1), v3(1, 0, 0), v3(0, 0, 1), v3(-1, 0, 0)]
/** RPTnkBlock::SetupEdges for a 35 x 35 cell */
function blockEdges(x: number, z: number): Wall[] {
  return [
    { pos: v3(x - 17.5, 0, z - 17.5), normal: EDGE_N[0], length: 35, id: 0 },
    { pos: v3(x + 17.5, 0, z - 17.5), normal: EDGE_N[1], length: 35, id: 0 },
    { pos: v3(x + 17.5, 0, z + 17.5), normal: EDGE_N[2], length: 35, id: 0 },
    { pos: v3(x - 17.5, 0, z + 17.5), normal: EDGE_N[3], length: 35, id: 0 },
  ]
}

/** RPTnkTank::AccumulatePushOut (against a static wall: vel = 0) */
function pushOut(b: TankBody, depth: number, n: V3, other: V3 = ZERO3) {
  accumulate(b.acc.p[0], b.acc.p[1], depth, n)
  const along = -((b.vel.x - other.x) * n.x + (b.vel.z - other.z) * n.z)
  if (along > 0) accumulate(b.acc.v[0], b.acc.v[1], along, n)
}
const ZERO3 = v3()

/** controls for one frame: aim, then the drive velocity (RPTnkTank::StatePlayerControl order) */
export function driveTank(b: TankBody, inp: ArenaInput, speedMul: number) {
  b.intent.moveX = inp.mx
  b.intent.moveZ = inp.mz
  b.intent.analog = inp.analog
  b.intent.aimX = inp.ax
  b.intent.aimZ = inp.az
  b.pc.aimAtCursor(b.turretRot, b.pos)
  const base = paramsFor(0).speed
  b.pc.maxSpeed = base * speedMul
  b.pc.calcMoveVelocity(b.rot, b.vel)
}

/** field collision for one frame (pos already advanced by vel) */
export function collideTank(f: ArenaField, b: TankBody) {
  f.collide(b.pos, TANK.fieldRadius, 0, (d, n) => pushOut(b, d, n))
}

// ---- entities ---------------------------------------------------------------------------------

export type Player = {
  pid: number
  name: string
  bot: boolean
  team: number
  color: string
  kills: number
  deaths: number
  score: number
  streak: number
  best: number
  tank: ATank
  input: ArenaInput
  /** button edges not yet consumed */
  wantFire: boolean
  wantMine: boolean
  wantFlare: boolean
  wantNuke: boolean
  joinedAt: number
  /** who destroyed this player last (spectated while waiting to respawn) */
  killedBy: Player | null
  /** matches won in this arena */
  wins: number
}

export type ATank = TankBody & {
  id: number
  player: Player
  alive: boolean
  respawnAt: number
  protectUntil: number
  /** the special tank this one has turned into (a pickup), null = the player tank */
  power: PickupKind | null
  powerUntil: number
  /** Pink: shells still to fire in the current burst */
  burst: number
  /** last tick this tank fired (the minimap shows recent shooters) */
  firedAt: number
  speed: number
  /** nukes left this match (kept through respawns), shield until (tick), flares and the tick the next one comes back,
   * and the next tick one may be fired */
  nukes: number
  shieldUntil: number
  flares: number
  flareBack: number
  flareReady: number
  /** Battle royale: ticks spent outside the zone in a row */
  outside: number
}

export type AShell = { id: number; owner: ATank; pid: number; team: number; pos: V3; vel: V3; age: number; bounces: number; smoke: number; acc: Accum; hitWall: boolean; dead: boolean; homing: boolean; turn: number }
export type AMine = {
  id: number
  owner: ATank
  pid: number
  team: number
  pos: V3
  age: number
  state: 0 | 1 | 2
  armed: boolean
  fuseLit: boolean
  timer: number
  blast: number
  dead: boolean
  /** a nuke: no tank sets it off, a long fuse, a huge blast (`blastMax`) */
  nuke: boolean
  blastMax: number
  /** who set it off: the shooter of the shell that hit it (or of the blast that chained it);
   * null when its own fuse or a tank driving close did. Its kills are credited to them. */
  by: Player | null
  /** how far down a chain its blast came: 0 set off by itself, a shell or a tank; n + 1 set off
   * by the blast of a mine at n */
  chain: number
}
/** a flare missile */
export type AFlare = { id: number; owner: ATank; pos: V3; vel: V3; age: number; range: number; target: AShell | null; dead: boolean }
export type APickup = { id: number; kind: AnyPickup; c: number; r: number; x: number; z: number }

export type ArenaEvent =
  | { t: 'shot'; tank: number; x: number; z: number; smoke: number; type: number }
  | { t: 'ricochet'; x: number; z: number }
  | { t: 'shellDie'; x: number; z: number; wall: boolean }
  | { t: 'clash'; x: number; z: number }
  /** `tk`: a teammate did it (scores nothing, costs the killer a point) */
  | { t: 'kill'; tank: number; x: number; z: number; victim: number; killer: number; cause: 'shell' | 'mine' | 'nuke' | 'zone'; streak: number; layer: number; tk: boolean; chain: number }
  | { t: 'shieldPop'; tank: number; x: number; z: number }
  | { t: 'flare'; tank: number; x: number; z: number; n: number }
  | { t: 'flareHit'; x: number; z: number }
  | { t: 'mineSet'; x: number; z: number }
  | { t: 'mineFuse'; id: number; x: number; z: number }
  | { t: 'boom'; x: number; z: number; nuke: boolean; r: number }
  | { t: 'break'; c: number; r: number; h: number }
  | { t: 'pickup'; tank: number; kind: AnyPickup; x: number; z: number }
  | { t: 'spawn'; tank: number; x: number; z: number }
  | { t: 'match'; state: 'play' | 'over' }
  /** Elimination: round `n` starts (team -1), or was won by `team` (-1: nobody) */
  | { t: 'round'; n: number; team: number; start: boolean }

const P = () => paramsFor(0)

export class ArenaSim {
  tick = 0
  map!: ArenaMap
  field!: ArenaField
  players: Player[] = []
  tanks: ATank[] = []
  shells: AShell[] = []
  flareShots: AFlare[] = []
  mines: AMine[] = []
  pickups: APickup[] = []
  events: ArenaEvent[] = []
  state: 'play' | 'over' = 'play'
  /** tick the current phase ends */
  phaseEnd = 0
  teamScore = [0, 0]
  winner: { name: string; color: string } | null = null
  /** the players who won the last match (the winning team, or the top scorer) */
  winners: Player[] = []
  /** next map: the themes on the ballot during the intermission, and the votes by pid */
  voteOptions: MapTheme[] = []
  votes = new Map<number, MapTheme>()
  private nextId = 1
  private nextPid = 1
  private pickupAt = 0
  /** the current round's first tick (the match's, outside Elimination) */
  roundStart = 0
  /** Elimination: the round number, and the tick the pause after a decided round ends (0: playing) */
  round = 0
  roundOverAt = 0
  /** Battle royale: the zone's centre and its starting radius */
  zone: { x: number; z: number; r0: number } | null = null
  private rnd: () => number
  /** cells broken this match (sent to joining clients) */
  broken: [number, number][] = []

  constructor(
    public mode: ArenaMode,
    seed = (Math.random() * 2 ** 31) | 0,
    public size: ArenaSize = 'medium',
  ) {
    this.rnd = mulberry(seed ^ 0x5bd1e995)
    this.newMatch(seed)
  }

  private id() {
    return this.nextId++ & 0xffffff
  }

  newMatch(seed = (this.rnd() * 2 ** 31) | 0, theme = this.votedTheme()) {
    this.map = generateMap(seed, this.mode, theme, this.size)
    this.voteOptions = []
    this.votes.clear()
    this.field = new ArenaField(this.map)
    this.shells = []
    this.flareShots = []
    this.mines = []
    this.pickups = []
    this.broken = []
    this.teamScore = [0, 0]
    this.winner = null
    this.state = 'play'
    this.phaseEnd = this.tick + MATCH_TICKS
    this.pickupAt = this.tick + 60
    this.round = 0
    this.roundOverAt = 0
    this.zone = this.mode === 'royale' ? this.newZone() : null
    for (const p of this.players) {
      p.kills = p.deaths = p.score = p.streak = p.best = 0
      p.tank.nukes = NUKE.perMatch
    }
    this.events.push({ t: 'match', state: 'play' })
    this.startRound()
  }

  /** everyone back at their base (Elimination: a new round; otherwise the match start) */
  private startRound() {
    this.roundStart = this.tick
    this.roundOverAt = 0
    if (this.mode === 'elim') {
      this.round++
      this.phaseEnd = this.tick + ELIM.roundTicks
      this.shells = []
      this.flareShots = []
      this.mines = []
      this.events.push({ t: 'round', n: this.round, team: -1, start: true })
    }
    for (const p of this.players) p.tank.alive = false
    for (const p of this.players) {
      p.killedBy = null
      this.spawn(p.tank)
    }
  }

  /** Battle royale: a centre near the middle of the map, and a radius that covers all of it */
  private newZone() {
    const W = (this.map.cols * 35) / 2
    const H = (this.map.rows * 35) / 2
    let x = 0
    let z = 0
    for (let i = 0; i < 40; i++) {
      const [c, r] = this.map.open[Math.floor(this.rnd() * this.map.open.length)]
      const p = cellPos(this.map, c, r)
      if (Math.abs(p.x) < W * 0.35 && Math.abs(p.z) < H * 0.35) {
        x = p.x
        z = p.z
        break
      }
    }
    return { x, z, r0: Math.hypot(W + Math.abs(x), H + Math.abs(z)) }
  }

  /** the zone's radius now */
  zoneR() {
    return this.zone ? zoneRadius(this.tick - this.roundStart, this.zone.r0) : Infinity
  }

  /** a newcomer gets a tank now, or (one-life modes, once the round is under way) waits for the next */
  canEnter() {
    if (this.state !== 'play') return false
    if (this.mode === 'royale') return this.tick - this.roundStart < ROYALE.late
    if (this.mode === 'elim') return !this.roundOverAt && this.tick - this.roundStart < ELIM.late
    return true
  }

  // ---- players --------------------------------------------------------------------------

  /** `team`: join that team (an invite from a teammate) instead of the smaller one */
  addPlayer(name: string, bot: boolean, team = isTeamMode(this.mode) ? this.smallerTeam() : 0): Player {
    const used = new Set(this.players.map((p) => p.color))
    const color = isTeamMode(this.mode) ? TEAM_COLORS[team] : (FFA_COLORS.find((c) => !used.has(c)) ?? FFA_COLORS[this.players.length % FFA_COLORS.length])
    const tank = Object.assign(newBody(), {
      id: this.id(),
      alive: false,
      respawnAt: this.tick,
      protectUntil: 0,
      power: null,
      powerUntil: 0,
      burst: 0,
      firedAt: -999,
      speed: 0,
      nukes: NUKE.perMatch,
      shieldUntil: 0,
      flares: FLARE.base,
      flareBack: 0,
      flareReady: 0,
      outside: 0,
    }) as ATank
    const p: Player = { pid: this.nextPid++, name, bot, team, color, kills: 0, deaths: 0, score: 0, streak: 0, best: 0, tank, input: { ...IDLE_INPUT }, wantFire: false, wantMine: false, wantFlare: false, wantNuke: false, joinedAt: this.tick, killedBy: null, wins: 0 }
    tank.player = p
    this.players.push(p)
    this.tanks.push(tank)
    if (this.canEnter()) this.spawn(tank)
    else tank.respawnAt = Infinity
    return p
  }

  removePlayer(p: Player) {
    this.players = this.players.filter((x) => x !== p)
    this.tanks = this.tanks.filter((t) => t !== p.tank)
    // their weapons stay in play, credited to nobody
  }

  smallerTeam() {
    const n = [0, 0]
    for (const p of this.players) n[p.team]++
    // humans count double so bots fill the thinner human side
    for (const p of this.players) if (!p.bot) n[p.team]++
    return n[0] <= n[1] ? 0 : 1
  }

  botName() {
    const used = new Set(this.players.map((p) => p.name))
    for (const n of BOT_NAMES) if (!used.has(`${n} Bot`)) return `${n} Bot`
    return `Bot ${this.players.length}`
  }

  enemies(a: Player, b: Player) {
    return a !== b && (!isTeamMode(this.mode) || a.team !== b.team)
  }

  /** White: invisible to its enemies (players and bots alike) for as long as the power lasts,
   * firing included, like the disc's White tank: only its tracks and its shells show */
  hiddenFrom(viewer: Player, t: ATank) {
    return t.power === 'white' && this.enemies(viewer, t.player)
  }

  // ---- spawning ---------------------------------------------------------------------------

  /**
   * Where a tank comes back: near the fighting, but not on top of it. Samples roomy cells of
   * the tank's side (Teams: its own half; at the start of a match, its base) and scores them:
   * best when the nearest enemy is about SPAWN_IDEAL away, out of every nearby enemy's sight,
   * and clear of mines. Without enemies on the field, near the middle.
   */
  private spawnPoint(p: Player): V3 {
    const side = isTeamMode(this.mode) ? p.team : 0
    const foes = this.tanks.filter((t) => t.alive && this.enemies(p, t.player))
    const start = this.tick - this.roundStart < 60
    const list = start || !foes.length ? this.map.spawns[side] : this.map.halves[side]
    const friends = isTeamMode(this.mode) ? this.tanks.filter((t) => t.alive && t.player !== p && t.player.team === p.team) : []
    let best: V3 | null = null
    let bestScore = -Infinity
    for (let i = 0; i < 24; i++) {
      const [c, r] = list[Math.floor(this.rnd() * list.length)]
      if (this.field.at(c, r) !== 0) continue
      const pos = cellPos(this.map, c, r)
      let score: number
      if (start) {
        // the match start: spread out over the base
        score = Math.min(...this.tanks.filter((t) => t.alive).map((t) => Math.hypot(t.pos.x - pos.x, t.pos.z - pos.z)), 1e4)
      } else if (!foes.length) {
        score = -Math.hypot(pos.x, pos.z)
      } else {
        let near = 1e9
        let seen = 0
        for (const t of foes) {
          const d = Math.hypot(t.pos.x - pos.x, t.pos.z - pos.z)
          near = Math.min(near, d)
          if (d < SPAWN_SIGHT && this.field.clearLine(pos.x, pos.z, t.pos.x, t.pos.z)) seen++
        }
        score = -Math.abs(near - SPAWN_IDEAL)
        if (near < SPAWN_SAFE) score -= 4000 + (SPAWN_SAFE - near) * 10
        score -= seen * 1500
        // Teams: next to a teammate is better (joins the push)
        if (friends.length) score -= Math.min(...friends.map((t) => Math.hypot(t.pos.x - pos.x, t.pos.z - pos.z))) * 0.25
      }
      for (const m of this.mines) {
        const d = Math.hypot(m.pos.x - pos.x, m.pos.z - pos.z)
        if (d < 200) score -= 3000 + (200 - d) * 10
      }
      if (score > bestScore) {
        bestScore = score
        best = v3(pos.x, 0, pos.z)
      }
    }
    return best ?? v3()
  }

  spawn(t: ATank) {
    const pos = this.spawnPoint(t.player)
    t.pos = pos
    t.vel = v3()
    // face the nearest enemy (else the middle of the map)
    let f = normalize(v3(-pos.x || 1, 0, -pos.z * 0.3))
    let near = 1e9
    for (const o of this.tanks)
      if (o.alive && o !== t && this.enemies(t.player, o.player)) {
        const d = Math.hypot(o.pos.x - pos.x, o.pos.z - pos.z)
        if (d < near && d > 1) (near = d), (f = normalize(v3(o.pos.x - pos.x, 0, o.pos.z - pos.z)))
      }
    axesFromForward(t.rot, f)
    axesFromForward(t.turretRot, f)
    t.pc.reset()
    t.alive = true
    t.protectUntil = this.tick + PROTECT_TICKS
    t.power = null
    t.burst = 0
    t.speed = 0
    t.shieldUntil = 0
    t.flares = Math.max(t.flares, FLARE.base)
    // presses made while waiting to respawn don't carry over
    t.player.wantFire = t.player.wantMine = t.player.wantFlare = t.player.wantNuke = false
    t.player.input = { ...IDLE_INPUT, seq: t.player.input.seq, ax: pos.x + f.x * 100, az: pos.z + f.z * 100 }
    this.events.push({ t: 'spawn', tank: t.id, x: pos.x, z: pos.z })
  }

  // ---- step -------------------------------------------------------------------------------

  step() {
    this.tick++
    if (this.state === 'over') {
      if (this.tick >= this.phaseEnd) this.newMatch()
      // the world keeps moving (shells finish, tanks stop) but nobody scores
    }
    const live = this.tanks.filter((t) => t.alive)
    // ApplyVelocities
    for (const t of live) t.pos.x += t.vel.x, t.pos.z += t.vel.z
    for (const s of this.shells) {
      if (s.homing) this.steer(s)
      s.pos.x += s.vel.x
      s.pos.z += s.vel.z
    }
    this.stepFlares()
    // ClearHitInfo
    for (const t of live) clearAccum(t.acc)
    for (const s of this.shells) clearAccum(s.acc), (s.hitWall = false)
    // CollideWithField: tank separation (RPTnkTankManager::SeparateTank), then the field
    for (const t of live) {
      for (const o of live) {
        if (o === t) continue
        const dx = t.pos.x - o.pos.x, dz = t.pos.z - o.pos.z
        const r = TANK.separation
        if (dx * dx > r * r || dz * dz > r * r) continue
        const d2 = dx * dx + dz * dz
        if (d2 > r * r || d2 === 0) continue
        const d = Math.sqrt(d2)
        pushOut(t, r - d, v3(dx / d, 0, dz / d), o.vel)
      }
      collideTank(this.field, t)
    }
    const shellHits = new Map<ATank, { s: AShell; d: number }>()
    for (const s of this.shells) this.collideShell(s, live, shellHits)
    // Integrate
    for (const t of live) integrate(t.pos, t.vel, t.acc)
    for (const s of this.shells) integrate(s.pos, s.vel, s.acc)
    // mines (RPTnkMine::CollideWithField + Calculate)
    const mineHits = new Map<ATank, AMine>()
    this.stepMines(live, mineHits)
    // tanks: hits, then controls
    for (const t of live) {
      const mh = mineHits.get(t)
      const sh = shellHits.get(t)
      if (mh || sh) {
        if (this.tick < t.protectUntil) continue
        // a shield takes the hit (then a moment of protection, for the rest of a blast)
        if (this.tick < t.shieldUntil) {
          t.shieldUntil = 0
          t.protectUntil = this.tick + SHIELD.afterHit
          this.events.push({ t: 'shieldPop', tank: t.id, x: t.pos.x, z: t.pos.z })
          this.control(t)
          continue
        }
        if (mh) this.kill(t, this.detonator(mh), mh.nuke ? 'nuke' : 'mine', mh.owner.player.pid, mh.chain)
        else this.kill(t, sh!.s.owner.player, 'shell')
        continue
      }
      this.control(t)
    }
    // shells: StateResolveHits
    for (const s of this.shells) this.resolveShell(s)
    this.shells = this.shells.filter((s) => !s.dead)
    this.mines = this.mines.filter((m) => !m.dead)
    // respawns, powers, pickups
    for (const t of this.tanks) {
      if (!t.alive && this.state === 'play' && this.tick >= t.respawnAt) this.spawn(t)
      if (t.power && this.tick >= t.powerUntil) t.power = null
      // flares come back one at a time, up to the base count
      if (t.flares < FLARE.base) {
        if (!t.flareBack) t.flareBack = this.tick + FLARE.recharge
        else if (this.tick >= t.flareBack) (t.flares++, (t.flareBack = 0))
      } else t.flareBack = 0
    }
    this.stepPickups(live)
    if (this.zone && this.state === 'play') this.stepZone()
    if (this.state === 'play') this.checkEnd()
  }

  /** the tank's numbers: the player record, changed by its special-tank power */
  stats(t: ATank) {
    return powerStats(t.power, P(), this.level(t))
  }

  /** the tank's kill-streak level (0-2) */
  level(t: ATank) {
    return streakLevel(t.player.streak)
  }

  /** flare missiles: lock on to an enemy shell in flight, chase it, destroy both on contact */
  private stepFlares() {
    const locked = new Set<AShell>(this.flareShots.map((f) => f.target).filter((x): x is AShell => !!x && !x.dead))
    for (const f of this.flareShots) {
      f.age++
      if (f.target?.dead) f.target = null
      if (!f.target && f.age > 4) {
        // the nearest shell not yet locked on to (else the nearest)
        let best: AShell | null = null
        let bestFree: AShell | null = null
        let bd = f.range
        let bdFree = f.range
        for (const s of this.shells) {
          if (s.dead || !this.enemies(f.owner.player, s.owner.player)) continue
          const d = Math.hypot(s.pos.x - f.pos.x, s.pos.z - f.pos.z)
          if (d < bd) (bd = d), (best = s)
          if (d < bdFree && !locked.has(s)) (bdFree = d), (bestFree = s)
        }
        best = bestFree ?? best
        if (best) locked.add((f.target = best))
      }
      const sp = Math.min(FLARE.speed, Math.hypot(f.vel.x, f.vel.z) + 0.25)
      let a = Math.atan2(f.vel.z, f.vel.x)
      if (f.target) {
        // aim where the shell will be
        const s = f.target
        const k = Math.hypot(s.pos.x - f.pos.x, s.pos.z - f.pos.z) / (sp + 1)
        let diff = Math.atan2(s.pos.z + s.vel.z * k - f.pos.z, s.pos.x + s.vel.x * k - f.pos.x) - a
        while (diff > Math.PI) diff -= 2 * Math.PI
        while (diff < -Math.PI) diff += 2 * Math.PI
        const max = (FLARE.turn * Math.PI) / 180
        a += Math.max(-max, Math.min(max, diff))
      }
      f.vel.x = Math.cos(a) * sp
      f.vel.z = Math.sin(a) * sp
      f.pos.x += f.vel.x
      f.pos.z += f.vel.z
      const s = f.target
      if (s && Math.hypot(s.pos.x - f.pos.x, s.pos.z - f.pos.z) < FLARE.hit) {
        s.dead = true
        f.dead = true
        this.events.push({ t: 'flareHit', x: s.pos.x, z: s.pos.z })
      } else if (f.age >= FLARE.life || this.field.pointInBlock(f.pos.x, f.pos.z) || !this.field.isInside(f.pos)) f.dead = true
    }
    this.flareShots = this.flareShots.filter((f) => !f.dead)
  }

  private control(t: ATank) {
    const p = t.player
    const inp = p.input
    const st = this.stats(t)
    driveTank(t, inp, st.speedMul)
    t.speed = Math.hypot(t.vel.x, t.vel.z)
    const pc = t.pc
    // RPTnkPlayerController::HandleFireInput, with the arena's counters
    const fire = p.wantFire
    const mine = p.wantMine
    const flare = p.wantFlare
    const nuke = p.wantNuke
    p.wantFire = p.wantMine = p.wantFlare = p.wantNuke = false
    if (this.state !== 'play') return
    if (flare && t.flares > 0 && this.tick >= t.flareReady) {
      t.flares--
      t.flareReady = this.tick + FLARE.cooldown
      t.protectUntil = 0
      // the swarm fans out all round the tank
      const L = this.level(t)
      const n = flareSwarm(L, this.rnd())
      const a0 = this.rnd() * Math.PI * 2
      for (let i = 0; i < n; i++) {
        const a = a0 + (i / n) * Math.PI * 2
        this.flareShots.push({ id: this.id(), owner: t, pos: v3(t.pos.x + Math.cos(a) * 16, 0, t.pos.z + Math.sin(a) * 16), vel: v3(Math.cos(a) * FLARE.launch, 0, Math.sin(a) * FLARE.launch), age: 0, range: flareRange(L), target: null, dead: false })
      }
      this.events.push({ t: 'flare', tank: t.id, x: t.pos.x, z: t.pos.z, n })
    }
    if (nuke && t.nukes > 0 && pc.mineTimer === 0) {
      t.nukes--
      this.mines.push({ id: this.id(), owner: t, pid: p.pid, team: p.team, pos: v3(t.pos.x, 0, t.pos.z), age: 0, state: 1, armed: true, fuseLit: true, timer: NUKE.fuse, blast: MINE.blastIdle, dead: false, by: null, chain: 0, nuke: true, blastMax: nukeBlast(this.level(t)) })
      this.events.push({ t: 'mineSet', x: t.pos.x, z: t.pos.z })
      pc.mineTimer = pc.mineCooldown
      pc.freeze = pc.mineFreeze
      t.protectUntil = 0
    } else if (mine) {
      if (pc.mineTimer === 0 && this.mines.filter((m) => m.owner === t && m.state !== 2).length < st.maxMines) {
        this.mines.push({ id: this.id(), owner: t, pid: p.pid, team: p.team, pos: v3(t.pos.x, 0, t.pos.z), age: 0, state: 1, armed: false, fuseLit: false, timer: 0, blast: MINE.blastIdle, dead: false, by: null, chain: 0, nuke: false, blastMax: MINE.blastMax })
        this.events.push({ t: 'mineSet', x: t.pos.x, z: t.pos.z })
        pc.mineTimer = pc.mineCooldown
        pc.freeze = pc.mineFreeze
        t.protectUntil = 0
      }
    } else if (fire && pc.shellTimer === 0) {
      if (this.fire(t, st)) {
        // Pink: the rest of the burst follows every 6 frames
        t.burst = st.burst - 1
        pc.shellTimer = pc.fireCooldown
        pc.freeze = pc.fireFreeze
      }
    } else if (t.burst > 0 && pc.shellTimer === 0) {
      t.burst--
      if (this.fire(t, st)) pc.shellTimer = pc.fireCooldown
    }
    if (--pc.shellTimer < 0) pc.shellTimer = 0
    if (--pc.mineTimer < 0) pc.mineTimer = 0
  }

  private fire(t: ATank, st: ReturnType<typeof powerStats>) {
    const p = t.player
    const dir = t.turretRot.z
    const at = v3(t.pos.x + TANK.muzzle * dir.x, 0, t.pos.z + TANK.muzzle * dir.z)
    if (this.shells.filter((s) => s.owner === t).length >= st.maxShells || !this.field.isInside(at) || this.field.pointInBlock(at.x, at.z)) return false
    this.shells.push({
      id: this.id(),
      owner: t,
      pid: p.pid,
      team: p.team,
      pos: at,
      vel: v3(dir.x * st.shellSpeed, 0, dir.z * st.shellSpeed),
      age: 0,
      bounces: st.ricochets,
      smoke: st.smoke,
      homing: st.homing,
      turn: st.homingTurn,
      acc: accum(),
      hitWall: false,
      dead: false,
    })
    this.events.push({ t: 'shot', tank: t.id, x: at.x, z: at.z, smoke: st.smoke, type: t.power ? PICKUP_TYPE[t.power] : 0 })
    t.firedAt = this.tick
    t.protectUntil = 0
    return true
  }

  /** Hornet shells (src/sim/types/behaviours.ts steerShell): turn toward the nearest enemy ahead */
  private steer(s: AShell) {
    if (s.age < HOMING.delay) return
    const sp = Math.hypot(s.vel.x, s.vel.z)
    if (!sp) return
    const cur = Math.atan2(s.vel.z, s.vel.x)
    let best: ATank | null = null
    let bd = HOMING.range
    for (const t of this.tanks) {
      if (!t.alive || t === s.owner || !this.enemies(s.owner.player, t.player) || this.hiddenFrom(s.owner.player, t)) continue
      const d = Math.hypot(t.pos.x - s.pos.x, t.pos.z - s.pos.z)
      if (d >= bd) continue
      let off = Math.atan2(t.pos.z - s.pos.z, t.pos.x - s.pos.x) - cur
      while (off > Math.PI) off -= 2 * Math.PI
      while (off < -Math.PI) off += 2 * Math.PI
      if (Math.abs(off) > (HOMING.cone * Math.PI) / 180) continue
      bd = d
      best = t
    }
    if (!best) return
    let diff = Math.atan2(best.pos.z + TANK.shellOffsetZ - s.pos.z, best.pos.x - s.pos.x) - cur
    while (diff > Math.PI) diff -= 2 * Math.PI
    while (diff < -Math.PI) diff += 2 * Math.PI
    const max = (s.turn * Math.PI) / 180
    const a = cur + Math.max(-max, Math.min(max, diff))
    s.vel.x = Math.cos(a) * sp
    s.vel.z = Math.sin(a) * sp
  }

  /** RPTnkShell::CollideWithField */
  private collideShell(s: AShell, live: ATank[], hits: Map<ATank, { s: AShell; d: number }>) {
    if (s.dead) return
    this.field.collide(s.pos, SHELL.radius, 3, (depth, n) => {
      // RPTnkShell::OnHitWall: mirror reflection via the push accumulators
      const d = dot(s.vel, n)
      const speed = mag(s.vel)
      if (d < 0) {
        const back = normalize(v3(-s.vel.x, 0, -s.vel.z))
        let dist = dot(back, n)
        if (dist !== 0) dist = depth / dist
        if (dist > speed) accumulate(s.acc.p[0], s.acc.p[1], depth, n)
        else accumulate(s.acc.p[0], s.acc.p[1], dist, back)
      } else accumulate(s.acc.p[0], s.acc.p[1], depth, n)
      const refl = -2 * d
      if (refl > 0) accumulate(s.acc.v[0], s.acc.v[1], refl, n)
      s.hitWall = true
    })
    // FindShellHit: the nearest tank whose shell circle (pos + (0,0,9), 15 + 6) touches
    let best: ATank | null = null
    let bestD = 1e9
    for (const t of live) {
      // every shell hits every tank (its own only once it has flown a while)
      if (t === s.owner && s.age < SHELL.selfHitAge) continue
      const dx = s.pos.x - t.pos.x, dz = s.pos.z - (t.pos.z + TANK.shellOffsetZ)
      const r = TANK.shellRadius + SHELL.radius
      const d2 = dx * dx + dz * dz
      if (d2 <= r * r && d2 < bestD) {
        bestD = d2
        best = t
      }
    }
    if (best) {
      s.dead = true
      const prev = hits.get(best)
      if (!prev || bestD < prev.d) hits.set(best, { s, d: bestD })
      ;(s as AShell & { why?: string }).why = 'tank'
      return
    }
    // shells vs mines (young shells pass their own tank's mines)
    for (const m of this.mines) {
      if (m.state === 2) continue
      const dx = s.pos.x - m.pos.x, dz = s.pos.z - (m.pos.z + MINE.shellOffsetZ)
      const r = (m.nuke ? NUKE.bodyRadius : MINE.bodyRadius) + SHELL.radius
      if (dx * dx + dz * dz <= r * r && (s.age >= SHELL.ownMineAge || m.owner !== s.owner)) {
        s.dead = true
        this.explodeMine(m, s.owner.player)
        return
      }
    }
    // shell vs shell: both die
    for (const o of this.shells) {
      if (o === s || o.dead) continue
      const dx = s.pos.x - o.pos.x, dz = s.pos.z - o.pos.z
      const r = 2 * SHELL.radius
      if (dx * dx + dz * dz <= r * r) {
        s.dead = o.dead = true
        this.events.push({ t: 'clash', x: (s.pos.x + o.pos.x) / 2, z: (s.pos.z + o.pos.z) / 2 })
        return
      }
    }
  }

  /** RPTnkShell::Calculate -> StateResolveHits */
  private resolveShell(s: AShell) {
    if (s.dead) return
    s.age++
    const sp = Math.hypot(s.vel.x, s.vel.z)
    if (s.hitWall) {
      if (--s.bounces <= -1 || s.age - 1 <= SHELL.earlyWallAge) {
        s.dead = true
        this.events.push({ t: 'shellDie', x: s.pos.x, z: s.pos.z, wall: true })
        return
      }
      this.events.push({ t: 'ricochet', x: s.pos.x, z: s.pos.z })
    }
    if (sp === 0 || !this.field.isInside(s.pos)) s.dead = true
  }

  /** the player a mine's blast belongs to */
  private detonator(m: AMine) {
    return m.by ?? m.owner.player
  }

  /** a blast hurts the detonator's enemies, the detonator, and the mine's owner */
  private blastHits(m: AMine, t: ATank) {
    const d = this.detonator(m)
    return t === m.owner || t.player === d || this.enemies(d, t.player)
  }

  private explodeMine(m: AMine, by: Player | null = null, chain = 0) {
    if (m.state === 2) return
    if (by) m.by = by
    m.chain = chain
    m.state = 2
    m.fuseLit = true
    m.timer = 0
    this.events.push({ t: 'boom', x: m.pos.x, z: m.pos.z, nuke: m.nuke, r: m.blastMax })
  }

  /** RPTnkMine: arm once the owner is clear, fuse, blast (kills, breaks cork, chains) */
  private stepMines(live: ATank[], hits: Map<ATank, AMine>) {
    for (const m of this.mines) {
      m.age++
      if (m.state === 1 && m.nuke) {
        // a nuke: only its fuse, a shell or another blast
        for (const o of this.mines)
          if (o !== m && o.state === 2 && Math.hypot(o.pos.x - m.pos.x, o.pos.z - m.pos.z) <= o.blast + NUKE.bodyRadius) {
            this.explodeMine(m, this.detonator(o), o.chain + 1)
            break
          }
        if ((m.state as number) !== 2 && --m.timer <= 0) this.explodeMine(m)
        continue
      }
      if (m.state === 1) {
        if (!m.armed) {
          const o = m.owner
          const r = TANK.mineRadius + MINE.armRadius
          if (!o.alive || Math.hypot(o.pos.x - m.pos.x, o.pos.z - m.pos.z) > r) m.armed = true
        }
        let near = false
        if (m.armed)
          for (const t of live) {
            if (t !== m.owner && !this.enemies(m.owner.player, t.player)) continue
            if (Math.hypot(t.pos.x - m.pos.x, t.pos.z - m.pos.z) <= TANK.mineRadius + MINE.triggerRadius) near = true
          }
        // chained by another blast
        for (const o of this.mines)
          if (o !== m && o.state === 2 && Math.hypot(o.pos.x - m.pos.x, o.pos.z - m.pos.z) <= o.blast + MINE.bodyRadius) {
            this.explodeMine(m, this.detonator(o), o.chain + 1)
            break
          }
        if ((m.state as number) === 2) continue
        if (!m.fuseLit) {
          if (m.age >= MINE.fuse) {
            m.timer = MINE.fuseLit
            m.fuseLit = true
            this.events.push({ t: 'mineFuse', id: m.id, x: m.pos.x, z: m.pos.z })
          } else if (near) {
            m.timer = MINE.fuseNear
            m.fuseLit = true
            this.events.push({ t: 'mineFuse', id: m.id, x: m.pos.x, z: m.pos.z })
          }
        } else if (--m.timer <= 0) this.explodeMine(m)
      } else if (m.state === 2) {
        // StateExplode: radius 8 -> 80 over 6 frames, kills while timer < 20, gone at 40
        const grow = m.nuke ? NUKE.growFrames : MINE.blastGrowFrames
        m.blast = m.timer >= grow ? m.blastMax : (m.timer / grow) * (m.blastMax - MINE.blastStart) + MINE.blastStart
        if (m.timer < (m.nuke ? NUKE.killFrames : MINE.blastKillFrames)) {
          for (const t of live) {
            if (!this.blastHits(m, t)) continue
            if (Math.hypot(t.pos.x - m.pos.x, t.pos.z - m.pos.z) <= m.blast + TANK.mineRadius && !hits.has(t)) hits.set(t, m)
          }
          // cork blocks inside the blast break (RPTnkBlock::CollideWithField); a nuke breaks
          // wood blocks too (never the border)
          const [c0, r0] = cellOf(this.map, m.pos.x, m.pos.z)
          const reach = Math.ceil(m.blast / 35) + 1
          for (let r = r0 - reach; r <= r0 + reach; r++)
            for (let c = c0 - reach; c <= c0 + reach; c++) {
              const code = this.field.at(c, r)
              const wood = code >= 201 && code <= 207
              if (!((code >= 100 && code <= 107) || (wood && m.nuke)) || c <= 0 || r <= 0 || c >= this.map.cols - 1 || r >= this.map.rows - 1) continue
              const p = cellPos(this.map, c, r)
              if (Math.hypot(p.x - m.pos.x, p.z - m.pos.z) <= m.blast + 17.5) {
                this.field.code[r * this.map.cols + c] = 0
                this.broken.push([c, r])
                this.events.push({ t: 'break', c, r, h: wood ? code - 199 : code - 99 })
              }
            }
          // shells caught in the blast
          for (const s of this.shells) if (!s.dead && Math.hypot(s.pos.x - m.pos.x, s.pos.z - m.pos.z) <= m.blast) s.dead = true
        }
        if (++m.timer >= (m.nuke ? NUKE.frames : MINE.blastFrames)) m.dead = true
      }
    }
  }

  /** `layer`: whoever laid the mine; `chain`: how far down a chain of blasts it was (a mine kill) */
  private kill(t: ATank, by: Player, cause: 'shell' | 'mine' | 'nuke' | 'zone', layer = 0, chain = 0) {
    const v = t.player
    t.alive = false
    t.vel = v3()
    t.power = null
    t.burst = 0
    t.shieldUntil = 0
    t.respawnAt = isOneLife(this.mode) ? Infinity : this.tick + RESPAWN_TICKS
    t.outside = 0
    v.deaths++
    v.streak = 0
    v.killedBy = by === v ? null : by
    let killer = by.pid
    // a teammate's shell (or blast): scores nothing, costs the shooter a point
    const tk = by !== v && this.players.includes(by) && !this.enemies(by, v)
    if (cause === 'zone') killer = 0
    else if (this.state === 'play') {
      if (by === v || !this.players.includes(by)) {
        // self-destruction (or a player who left)
        if (by === v) v.score--
        killer = by === v ? v.pid : 0
      } else if (tk) {
        by.score--
        by.streak = 0
      } else {
        by.kills++
        by.score++
        by.streak++
        by.best = Math.max(by.best, by.streak)
        // (Elimination counts rounds, not kills)
        if (this.mode === 'teams') this.teamScore[by.team]++
      }
    }
    this.events.push({ t: 'kill', tank: t.id, x: t.pos.x, z: t.pos.z, victim: v.pid, killer, cause, streak: by !== v && !tk ? by.streak : 0, layer, tk, chain })
  }

  private stepPickups(live: ATank[]) {
    for (const k of this.pickups) {
      for (const t of live) {
        if (Math.hypot(t.pos.x - k.x, t.pos.z - k.z) > PICKUP_RADIUS + TANK.fieldRadius) continue
        if (k.kind === 'shield') t.shieldUntil = this.tick + SHIELD.ticks
        else if (k.kind === 'flares') t.flares = Math.min(FLARE.max + this.level(t), t.flares + FLARE.pickup)
        else {
          t.power = k.kind
          t.powerUntil = this.tick + PICKUP_TICKS[k.kind]
          t.burst = 0
        }
        this.events.push({ t: 'pickup', tank: t.id, kind: k.kind, x: k.x, z: k.z })
        k.id = -1
        break
      }
    }
    this.pickups = this.pickups.filter((k) => k.id >= 0)
    if (this.state === 'play' && this.tick >= this.pickupAt && this.pickups.length < SIZES[this.size].pickups) {
      this.pickupAt = this.tick + PICKUP_RESPAWN
      for (let i = 0; i < 10; i++) {
        const [c, r] = this.map.open[Math.floor(this.rnd() * this.map.open.length)]
        if (this.field.at(c, r) !== 0) continue
        const p = cellPos(this.map, c, r)
        if (this.pickups.some((k) => Math.hypot(k.x - p.x, k.z - p.z) < 400)) continue
        if (live.some((t) => Math.hypot(t.pos.x - p.x, t.pos.z - p.z) < 120)) continue
        this.pickups.push({ id: this.id(), kind: this.randomPickup(), c, r, x: p.x, z: p.z })
        break
      }
    }
  }

  /** a special tank or an item, by PICKUP_WEIGHT */
  private randomPickup(): AnyPickup {
    const all: AnyPickup[] = [...PICKUP_KINDS, ...ITEM_KINDS]
    const w = all.map((k) => PICKUP_WEIGHT[k] ?? 1)
    let r = this.rnd() * w.reduce((a, b) => a + b, 0)
    for (let i = 0; i < all.length; i++) if ((r -= w[i]) < 0) return all[i]
    return all[0]
  }

  /** the theme with most votes (ties: random among them); the first match is mixed */
  private votedTheme(): MapTheme {
    if (!this.voteOptions.length) return 'mixed'
    const n = new Map<MapTheme, number>(this.voteOptions.map((t) => [t, 0]))
    for (const t of this.votes.values()) if (n.has(t)) n.set(t, n.get(t)! + 1)
    const top = Math.max(...n.values())
    const best = this.voteOptions.filter((t) => n.get(t) === top)
    return best[Math.floor(this.rnd() * best.length)]
  }

  vote(p: Player, theme: string) {
    if (this.state === 'over' && (this.voteOptions as string[]).includes(theme)) this.votes.set(p.pid, theme as MapTheme)
  }

  /** Battle royale: a tank left outside the zone too long is destroyed */
  private stepZone() {
    const z = this.zone!
    const r = this.zoneR()
    for (const t of this.tanks) {
      if (!t.alive) continue
      if (Math.hypot(t.pos.x - z.x, t.pos.z - z.z) <= r) t.outside = 0
      else if (++t.outside >= ROYALE.outside) this.kill(t, t.player, 'zone')
    }
  }

  private checkEnd() {
    if (this.mode === 'royale') return this.checkRoyale()
    if (this.mode === 'elim') return this.checkElim()
    let done = this.tick >= this.phaseEnd
    if (this.mode === 'teams') done ||= this.teamScore.some((s) => s >= SIZES[this.size].teamLimit)
    else done ||= this.players.some((p) => p.score >= SIZES[this.size].ffaLimit)
    if (!done) return
    if (this.mode === 'teams') this.finishTeams()
    else this.finishPlayer([...this.players].sort((a, b) => b.score - a.score || a.deaths - b.deaths)[0])
  }

  /** the last tank standing wins (or, at the time limit, the best score among those left) */
  private checkRoyale() {
    const alive = this.players.filter((p) => p.tank.alive)
    const out = this.tick >= this.phaseEnd
    if (!out && (alive.length > 1 || this.players.length < 2)) return
    const best = (l: Player[]) => [...l].sort((a, b) => b.score - a.score || a.deaths - b.deaths)[0]
    // nobody left (the last two went at once): nobody wins
    this.finishPlayer(alive.length ? best(alive) : undefined)
  }

  /** a round ends when a team is wiped out, or at its time limit (more tanks left wins it) */
  private checkElim() {
    if (this.roundOverAt) {
      if (this.tick < this.roundOverAt) return
      if (this.teamScore.some((s) => s >= ELIM.rounds)) return this.finishTeams()
      return this.startRound()
    }
    const left = [0, 1].map((k) => this.players.filter((p) => p.team === k && p.tank.alive).length)
    if (left[0] && left[1] && this.tick < this.phaseEnd) return
    const team = left[0] === left[1] ? -1 : left[0] > left[1] ? 0 : 1
    if (team >= 0) this.teamScore[team]++
    this.events.push({ t: 'round', n: this.round, team, start: false })
    this.roundOverAt = this.phaseEnd = this.tick + ELIM.between
  }

  private finishTeams() {
    const [a, b] = this.teamScore
    this.winner = a === b ? null : { name: a > b ? 'Blue' : 'Red', color: TEAM_COLORS[a > b ? 0 : 1] }
    this.winners = this.winner ? this.players.filter((p) => p.team === (a > b ? 0 : 1)) : []
    this.finish()
  }

  private finishPlayer(top: Player | undefined) {
    this.winner = top ? { name: top.name, color: top.color } : null
    this.winners = top ? [top] : []
    this.finish()
  }

  /** results, then the ballot for the next map */
  private finish() {
    for (const p of this.winners) p.wins++
    // three themes on the ballot, the current one last
    const others = MAP_THEMES.filter((t) => t !== this.map.theme).sort(() => this.rnd() - 0.5)
    this.voteOptions = [...others.slice(0, 2), this.map.theme]
    this.state = 'over'
    this.roundOverAt = 0
    this.phaseEnd = this.tick + INTERMISSION_TICKS
    this.events.push({ t: 'match', state: 'over' })
  }

  get secondsLeft() {
    return Math.max(0, Math.ceil((this.phaseEnd - this.tick) / ARENA_TPS))
  }

  /** body / turret headings for the wire */
  static headings(t: ATank) {
    return [heading(t.rot.z), heading(t.turretRot.z)]
  }
}
