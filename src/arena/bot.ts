// Arena bots: drive the same tanks through the same inputs as players. Not the disc's AI (that
// one hunts players 1-2 on a 22 x 17 field); a small brain for a big map with teams:
//   - hunt the nearest enemy it can reach (grid BFS path), keep a fighting distance
//   - fire on a clear line, or bank a shot off one wall when that line is blocked
//   - dodge shells heading its way (teammates' too: every shell hits), flare when several
//     are coming or one is about to hit, back away from armed mines and nukes
//   - mines with a reason (see mineSense): behind it when chased, in a corridor an enemy is
//     coming down, against cork in its way, in a close fight; never near a teammate or on top
//     of another mine. Shoots mines that have an enemy next to them. Nukes go down where
//     enemies crowd, then it runs.
//   - Battle royale: heads back into the zone (the part it's closing to) before anything else
//   - plays to the mode (styleOf): Free-for-all hunts; Teams sticks near teammates; Battle
//     royale is cautious while many are left (fights only what's close, backs off when
//     outnumbered, takes pickups) and hunts once few are; Elimination moves as a pack, holds
//     when ahead late in a round and pushes when behind
//   - plays at human speed: the aim swings over like a hand on a mouse (HUMAN.turn), a shell is
//     only noticed after a reaction time, and it drives with eight keys, changing them takes a
//     moment
//   - the nuke is a trap: laid where enemies are or are heading, then it runs out of the blast
//     and shoots it once enemies are inside; also a last stand in one-life modes (a shell is
//     about to hit, enemies close), a wall against a push when outnumbered, and spent near the
//     end of a match rather than wasted

import { MINE, TANK } from '../sim/consts'
import { cellOf, cellPos } from './map'
import { ELIM, isOneLife, isTeamMode, nukeBlast, zoneNext } from './rules'
import type { AMine, AShell, ArenaSim, ATank, Player } from './sim'

type Brain = {
  path: [number, number][]
  goal: [number, number] | null
  repathAt: number
  thinkAt: number
  target: ATank | null
  bank: { x: number; z: number } | null
  /** run from `fleeFrom` (else the target) until this tick */
  fleeUntil: number
  fleeFrom: { x: number; z: number } | null
  jitter: number
  strafe: number
  seenSince: number
  /** next tick to weigh laying a mine; a mine worth shooting */
  mineAt: number
  shootMine: AMine | null
  /** the way out of a blast, recomputed every 20 frames */
  escape: [number, number][]
  escapeAt: number
  /** Battle royale: where it's heading to get back into the zone */
  zone: [number, number] | null
  /** the mode's play style (styleOf), refreshed with the target */
  style: Style | null
  /** a shell is about to hit this tick (too close to dodge) */
  doomed: boolean
  /** HUMAN: where the aim points now (radians, null until the first frame), this bot's reaction
   * time and key-change time, the direction held (0-7, -1: none) and the one it's changing to */
  aim: number | null
  react: number
  keyDelay: number
  held: number
  next: { dir: number; at: number } | null
  /** when each shell in flight was first noticed */
  noticed: Map<AShell, number>
  /** seconds into a round before this bot thinks about its nuke (on top of NUKE_AI.grace; -1:
   * not picked yet) */
  nukeWait: number
}

const brains = new WeakMap<Player, Brain>()

/**
 * Human limits. `turn`: the most the aim swings in a frame (radians, about 240° a second), and
 * `ease` the share of the remaining turn it covers (fast at first, slowing as it closes in);
 * `react`: frames before a shell is noticed (each bot gets its own in that range); `keys`:
 * frames it takes to change the keys held (the same); `shoot`: frames a target has to be in
 * sight before the first shot (plus the reaction time).
 */
const HUMAN = { turn: 0.07, ease: 0.2, shake: 0.006, react: [14, 26], keys: [5, 11], shoot: 14 }
/**
 * When bots go for their nuke. `grace`: seconds into a round (the match start, outside
 * Elimination) before any bot lays one, by mode; `wait`: a further spread of seconds, each bot
 * its own and by mode, so they don't all go at once; `gap`: seconds after a bot's nuke before the next bot
 * lays one (and never while one is on the map). A last stand and the end of the match skip the
 * waits.
 */
const NUKE_AI = { grace: { ffa: 60, teams: 60, royale: 25, elim: 20 }, wait: { ffa: [0, 60], teams: [0, 60], royale: [0, 25], elim: [0, 30] }, gap: { ffa: 25, teams: 25, royale: 20, elim: 12 } }
/** the tick each arena's last bot nuke went down */
const lastNuke = new WeakMap<ArenaSim, number>()
const between = ([a, b]: number[]) => a + Math.floor(Math.random() * (b - a + 1))

/** how a bot plays the mode it's in (worked out every think) */
type Style = {
  /** looks for a fight within this distance (a target further off is left alone) */
  hunt: number
  /** without a fight, drives back toward the nearest teammate when further than this (0: never) */
  regroup: number
  /** backs off when more enemies than friends are close */
  cautious: boolean
  /** how far it will detour for a pickup, as a share of the fight's distance */
  loot: number
}

function styleOf(sim: ArenaSim, p: Player): Style {
  const left = (team?: number) => sim.players.filter((q) => q.tank.alive && (team === undefined || q.team === team)).length
  if (sim.mode === 'royale') {
    // many left: survive (stay out of fights that aren't close, take pickups); few: hunt
    const late = left() <= 3 || sim.zoneR() < 450
    return late ? { hunt: 2000, regroup: 0, cautious: false, loot: 0.7 } : { hunt: 420, regroup: 0, cautious: true, loot: 1.2 }
  }
  if (sim.mode === 'elim') {
    const mine = left(p.team)
    const theirs = left(1 - p.team)
    const late = sim.phaseEnd - sim.tick < 40 * 60 && !sim.roundOverAt
    // ahead late in the round: hold (the timer decides for the team with more left); behind
    // late: push; otherwise move as a pack and take fights near it
    if (late && mine > theirs) return { hunt: 320, regroup: 260, cautious: true, loot: 0.3 }
    if (late && mine < theirs) return { hunt: 3000, regroup: 0, cautious: false, loot: 0.2 }
    return { hunt: 700, regroup: 300, cautious: mine < theirs, loot: 0.5 }
  }
  if (sim.mode === 'teams') return { hunt: 900, regroup: 360, cautious: false, loot: 0.7 }
  return { hunt: 900, regroup: 0, cautious: false, loot: 0.7 }
}

/**
 * Battle royale: outside (or near the edge of) the circle the zone is closing to, a cell well
 * inside it to drive to (kept until it's reached or falls outside); null when it's safe here.
 */
function zoneGoal(sim: ArenaSim, t: ATank, b: Brain): [number, number] | null {
  const z = sim.zone
  if (!z) return null
  const r = Math.min(sim.zoneR(), zoneNext(sim.tick - sim.roundStart, z.r0))
  const d = (x: number, y: number) => Math.hypot(x - z.x, y - z.z)
  if (d(t.pos.x, t.pos.z) < r * 0.85) return (b.zone = null)
  if (b.zone) {
    const p = cellPos(sim.map, b.zone[0], b.zone[1])
    if (d(p.x, p.z) < r * 0.6) return b.zone
  }
  for (let i = 0; i < 30; i++) {
    const c = sim.map.open[Math.floor(Math.random() * sim.map.open.length)]
    const p = cellPos(sim.map, c[0], c[1])
    if (d(p.x, p.z) < r * 0.5 && sim.field.at(c[0], c[1]) === 0) return (b.zone = c)
  }
  return (b.zone = cellOf(sim.map, z.x, z.z))
}

function brain(p: Player): Brain {
  let b = brains.get(p)
  if (!b) brains.set(p, (b = { path: [], goal: null, repathAt: 0, thinkAt: 0, target: null, bank: null, fleeUntil: 0, fleeFrom: null, jitter: 0, strafe: Math.random() < 0.5 ? 1 : -1, seenSince: -1, mineAt: 0, shootMine: null, escape: [], escapeAt: 0, zone: null, style: null, doomed: false, aim: null, react: between(HUMAN.react), keyDelay: between(HUMAN.keys), held: -1, next: null, noticed: new Map(), nukeWait: -1 }))
  return b
}

/** straight shell line from a to b (holes don't stop shells) */
export const clearLine = (sim: ArenaSim, ax: number, az: number, bx: number, bz: number) => sim.field.clearLine(ax, az, bx, bz)

/** traces a shell with one ricochet; returns the closest approach to (tx, tz) after a bounce */
function bankShot(sim: ArenaSim, x: number, z: number, dx: number, dz: number, tx: number, tz: number, self: ATank, friends: ATank[]): boolean {
  let bounced = false
  const step = 8
  for (let i = 0; i < 160; i++) {
    const nx = x + dx * step
    const nz = z + dz * step
    if (sim.field.pointInBlock(nx, nz) || Math.abs(nx) > sim.field.width / 2 || Math.abs(nz) > sim.field.depth / 2) {
      if (bounced) return false
      bounced = true
      const bx = sim.field.pointInBlock(nx, z) || Math.abs(nx) > sim.field.width / 2
      const bz = sim.field.pointInBlock(x, nz) || Math.abs(nz) > sim.field.depth / 2
      if (bx) dx = -dx
      if (bz) dz = -dz
      if (!bx && !bz) dx = -dx, dz = -dz
      continue
    }
    x = nx
    z = nz
    if (bounced) {
      if (Math.hypot(x - tx, z - tz) < 22) return true
      if (Math.hypot(x - self.pos.x, z - self.pos.z) < 40) return false
    }
    for (const f of friends) if (Math.hypot(x - f.pos.x, z - f.pos.z) < 30) return false
  }
  return false
}

/** the shortest way to a cell out of reach of every one of `mines` (at most ~600 cells) */
function escapePath(sim: ArenaSim, from: [number, number], mines: AMine[]): [number, number][] {
  const { cols } = sim.map
  const safe = (c: number, r: number) => {
    const p = cellPos(sim.map, c, r)
    return mines.every((m) => Math.hypot(p.x - m.pos.x, p.z - m.pos.z) > m.blastMax + TANK.mineRadius + 30)
  }
  const start = from[1] * cols + from[0]
  const prev = new Map<number, number>([[start, start]])
  const q = [start]
  // (far enough to get out of a nuke's blast, about 8-12 cells away)
  for (let h = 0; h < q.length && h < 3000; h++) {
    const i = q[h]
    const x = i % cols, y = (i / cols) | 0
    if (i !== start && safe(x, y)) {
      const out: [number, number][] = []
      for (let k = i; k !== start; k = prev.get(k)!) out.push([k % cols, (k / cols) | 0])
      return out.reverse()
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy
      const j = ny * cols + nx
      if (prev.has(j) || sim.field.at(nx, ny) !== 0) continue
      prev.set(j, i)
      q.push(j)
    }
  }
  return []
}

function bfs(sim: ArenaSim, from: [number, number], to: [number, number]): [number, number][] {
  const { cols, rows } = sim.map
  const prev = new Int32Array(cols * rows).fill(-1)
  const start = from[1] * cols + from[0]
  const goal = to[1] * cols + to[0]
  prev[start] = start
  // cells near a mine are off the path (bots used to drive back over their own)
  for (const m of sim.mines) {
    if (m.state === 2) continue
    const [mc, mr] = cellOf(sim.map, m.pos.x, m.pos.z)
    const R = m.nuke ? Math.ceil(m.blastMax / 35) : 2
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const j = (mr + dy) * cols + mc + dx
        if (j !== start && j !== goal && j >= 0 && j < prev.length && prev[j] < 0) prev[j] = -2
      }
  }
  const q = [start]
  for (let h = 0; h < q.length; h++) {
    const i = q[h]
    if (i === goal) break
    const x = i % cols, y = (i / cols) | 0
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy
      const j = ny * cols + nx
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || prev[j] !== -1 || sim.field.at(nx, ny) !== 0) continue
      prev[j] = i
      q.push(j)
    }
  }
  if (prev[goal] < 0) return []
  const out: [number, number][] = []
  for (let i = goal; i !== start; i = prev[i]) out.push([i % cols, (i / cols) | 0])
  return out.reverse()
}

export function botThink(sim: ArenaSim, p: Player) {
  const t = p.tank
  const inp = p.input
  inp.seq++
  if (!t.alive) {
    inp.mx = inp.mz = 0
    return
  }
  const b = brain(p)
  const now = sim.tick
  // a White enemy is as invisible to a bot as to a player
  const enemies = sim.tanks.filter((o) => o.alive && sim.enemies(p, o.player) && !sim.hiddenFrom(p, o))
  const friends = sim.tanks.filter((o) => o.alive && o !== t && !sim.enemies(p, o.player))
  // ---- pick a target (every 10 frames) and bank shots (every 20)
  if (now >= b.thinkAt) {
    b.thinkAt = now + 10
    b.style = styleOf(sim, p)
    let best: ATank | null = null
    let bd = b.style.hunt
    for (const e of enemies) {
      const d = Math.hypot(e.pos.x - t.pos.x, e.pos.z - t.pos.z)
      const seen = clearLine(sim, t.pos.x, t.pos.z, e.pos.x, e.pos.z)
      const score = d * (seen ? 0.7 : 1)
      if (score < bd) {
        bd = score
        best = e
      }
    }
    if (best !== b.target) b.seenSince = -1
    b.target = best
    b.jitter = (Math.random() - 0.5) * 0.2
    b.bank = null
    if (best && !clearLine(sim, t.pos.x, t.pos.z, best.pos.x, best.pos.z) && now % 20 < 10) {
      const base = Math.atan2(best.pos.z - t.pos.z, best.pos.x - t.pos.x)
      for (let i = 0; i < 24; i++) {
        const a = base + ((i % 2 ? 1 : -1) * Math.ceil(i / 2) * Math.PI) / 12
        if (bankShot(sim, t.pos.x + Math.cos(a) * TANK.muzzle, t.pos.z + Math.sin(a) * TANK.muzzle, Math.cos(a), Math.sin(a), best.pos.x, best.pos.z, t, friends)) {
          b.bank = { x: t.pos.x + Math.cos(a) * 200, z: t.pos.z + Math.sin(a) * 200 }
          break
        }
      }
    }
  }
  // (a target that has just gone White is lost at once, not at the next think)
  const e = b.target && b.target.alive && !sim.hiddenFrom(p, b.target) ? b.target : null
  // ---- aim and fire
  let fire = false
  const sm = b.shootMine && !b.shootMine.dead && b.shootMine.state !== 2 ? b.shootMine : null
  if (sm) {
    // a mine with an enemy next to it: set it off
    inp.ax = sm.pos.x
    inp.az = sm.pos.z
    const a = Math.atan2(sm.pos.z - t.pos.z, sm.pos.x - t.pos.x)
    const tz = t.turretRot.z
    fire = Math.cos(a) * tz.x + Math.sin(a) * tz.z > 0.997 && Math.random() < 0.2
  } else if (e) {
    const d = Math.hypot(e.pos.x - t.pos.x, e.pos.z - t.pos.z)
    const lead = d / sim.stats(t).shellSpeed
    const ax = e.pos.x + e.vel.x * lead
    const az = e.pos.z + e.vel.z * lead
    const a = Math.atan2(az - t.pos.z, ax - t.pos.x) + b.jitter
    if (b.bank) {
      inp.ax = b.bank.x
      inp.az = b.bank.z
      fire = Math.random() < 0.04
    } else {
      inp.ax = t.pos.x + Math.cos(a) * d
      inp.az = t.pos.z + Math.sin(a) * d
      const clear = clearLine(sim, t.pos.x, t.pos.z, e.pos.x, e.pos.z)
      // reaction time: a target has to be in sight for a moment first
      if (!clear) b.seenSince = -1
      else if (b.seenSince < 0) b.seenSince = now
      const reacted = clear && now - b.seenSince > b.react + HUMAN.shoot + (e.player.bot ? 0 : 10)
      // no teammate in the way
      const blocked = friends.some((f) => {
        const fx = f.pos.x - t.pos.x, fz = f.pos.z - t.pos.z
        const along = fx * Math.cos(a) + fz * Math.sin(a)
        return along > 0 && along < d && Math.abs(-fx * Math.sin(a) + fz * Math.cos(a)) < 30
      })
      // only once the turret is on target
      const tz = t.turretRot.z
      const on = Math.cos(a) * tz.x + Math.sin(a) * tz.z > 0.995
      // no mine close by in the line of fire (our own shell would set it off on top of us)
      const mined = sim.mines.some((m) => {
        if (m.state === 2) return false
        const mx = m.pos.x - t.pos.x, mz = m.pos.z - t.pos.z
        const along = mx * Math.cos(a) + mz * Math.sin(a)
        return along > 0 && along < m.blastMax + 60 && Math.abs(-mx * Math.sin(a) + mz * Math.cos(a)) < 26
      })
      fire = reacted && !blocked && !mined && on && d < 600 && Math.random() < 0.06
    }
    if (now < e.protectUntil) fire = false
  } else {
    // look where we drive
    inp.ax = t.pos.x + t.rot.z.x * 200
    inp.az = t.pos.z + t.rot.z.z * 200
  }
  // ---- the aim swings over at a human pace (the turret follows it; fire waits for the turret)
  {
    const want = Math.atan2(inp.az - t.pos.z, inp.ax - t.pos.x)
    const far = Math.max(60, Math.hypot(inp.ax - t.pos.x, inp.az - t.pos.z))
    if (b.aim === null) b.aim = want
    let d = want - b.aim
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    b.aim += Math.max(-HUMAN.turn, Math.min(HUMAN.turn, d * HUMAN.ease)) + (Math.random() - 0.5) * HUMAN.shake
    inp.ax = t.pos.x + Math.cos(b.aim) * far
    inp.az = t.pos.z + Math.sin(b.aim) * far
  }
  p.wantFire ||= fire
  // ---- where to go
  let mx = 0
  let mz = 0
  // threats first: shells heading this way, armed mines nearby
  let incoming = 0
  b.doomed = false
  for (const [s] of b.noticed) if (s.dead) b.noticed.delete(s)
  for (const s of sim.shells) {
    if (s.owner === t && s.age < 30) continue
    // a shell is only noticed after the reaction time
    let first = b.noticed.get(s)
    if (first === undefined) b.noticed.set(s, (first = now))
    if (now - first < b.react) continue
    const dx = t.pos.x - s.pos.x, dz = t.pos.z - s.pos.z
    const d = Math.hypot(dx, dz)
    if (d > 180) continue
    const sp = Math.hypot(s.vel.x, s.vel.z) || 1
    const vx = s.vel.x / sp, vz = s.vel.z / sp
    if (dx * vx + dz * vz <= 0) continue
    const side = -dx * vz + dz * vx
    if (Math.abs(side) > 40) continue
    // a flare's missiles shoot it down: when it's about to hit, or two are coming (now and
    // then a bot is too slow)
    const along = dx * vx + dz * vz
    incoming++
    // too close to dodge: the last moment to do anything (a last-stand nuke)
    if (along / sp < 8 && Math.abs(side) < 16) b.doomed = true
    if ((along / sp < 40 || incoming >= 2) && t.flares > 0 && now >= t.flareReady && Math.random() < 0.3) p.wantFlare = true
    // step out of the line, away from the side it would pass
    const k = side >= 0 ? 1 : -1
    mx += -vz * k * 2
    mz += vx * k * 2
  }
  // mines: drive to the nearest cell out of every blast that's coming (a short path search;
  // pushing straight away used to pin bots against walls next to their own mine)
  const danger = sim.mines.filter((m) => {
    // a fresh own mine is left behind on purpose (it arms once we're clear); after a moment,
    // or once its fuse is lit, it gets a wide berth like everything else
    if (m.state === 2 || (!m.armed && m.owner === t && m.age < 45 && !m.fuseLit)) return false
    // teammates' mines ignore us (nukes don't)
    if (!m.nuke && m.owner !== t && !sim.enemies(p, m.owner.player)) return false
    return Math.hypot(t.pos.x - m.pos.x, t.pos.z - m.pos.z) < m.blastMax + (m.nuke ? 70 : m.owner === t ? 80 : 50)
  })
  if (danger.length) {
    if (now >= b.escapeAt || !b.escape.length) {
      b.escape = escapePath(sim, cellOf(sim.map, t.pos.x, t.pos.z), danger)
      b.escapeAt = now + 20
    }
    const here = cellOf(sim.map, t.pos.x, t.pos.z)
    while (b.escape.length && b.escape[0][0] === here[0] && b.escape[0][1] === here[1]) b.escape.shift()
    const next = b.escape[0]
    if (next) {
      const c = cellPos(sim.map, next[0], next[1])
      mx += (c.x - t.pos.x) * 4
      mz += (c.z - t.pos.z) * 4
    } else {
      const m = danger[0]
      mx += t.pos.x - m.pos.x || t.rot.z.x
      mz += t.pos.z - m.pos.z || t.rot.z.z
    }
  } else b.escape = []
  if (!mx && !mz) {
    // fighting distance: close in along the path, hold and strafe near, back off when too close
    let goal: [number, number] | null = null
    let loot: { c: number; r: number } | null = null
    const dist = e ? Math.hypot(e.pos.x - t.pos.x, e.pos.z - t.pos.z) : 0
    const seen = e && clearLine(sim, t.pos.x, t.pos.z, e.pos.x, e.pos.z)
    const from = b.fleeFrom ?? e?.pos
    const zone = zoneGoal(sim, t, b)
    const style = b.style ?? styleOf(sim, p)
    // outnumbered close by (a cautious mode): back away from the enemies' middle for a moment
    const near = (l: ATank[]) => l.filter((o) => Math.hypot(o.pos.x - t.pos.x, o.pos.z - t.pos.z) < 330)
    const foes = style.cautious ? near(enemies) : []
    if (foes.length && foes.length > near(friends).length + 1 && now >= b.fleeUntil) {
      b.fleeFrom = { x: foes.reduce((a, o) => a + o.pos.x, 0) / foes.length, z: foes.reduce((a, o) => a + o.pos.z, 0) / foes.length }
      b.fleeUntil = now + 45
    }
    // the nearest teammate, when the pack has drifted apart
    let mate: ATank | null = null
    if (style.regroup && !(e && seen && dist < 400))
      for (const f of friends) {
        const d = Math.hypot(f.pos.x - t.pos.x, f.pos.z - t.pos.z)
        if (d > style.regroup && (!mate || d < Math.hypot(mate.pos.x - t.pos.x, mate.pos.z - t.pos.z))) mate = f
        if (d <= style.regroup) {
          mate = null
          break
        }
      }
    if (zone) goal = zone
    else if (now < b.fleeUntil && from) {
      mx = t.pos.x - from.x
      mz = t.pos.z - from.z
    } else if (e && seen && dist < 260) {
      // strafe around the target
      const ux = (e.pos.x - t.pos.x) / dist, uz = (e.pos.z - t.pos.z) / dist
      mx = -uz * b.strafe - ux * (dist < 150 ? 1 : 0)
      mz = ux * b.strafe - uz * (dist < 150 ? 1 : 0)
      if (Math.random() < 0.01) b.strafe = -b.strafe
    } else if ((loot = pickupNear(sim, t, e ? dist : 1e9, style.loot))) goal = [loot.c, loot.r]
    else if (mate) goal = cellOf(sim.map, mate.pos.x, mate.pos.z)
    else if (e) goal = cellOf(sim.map, e.pos.x, e.pos.z)
    else if (!b.goal || !b.path.length) {
      const o = sim.map.open[Math.floor(Math.random() * sim.map.open.length)]
      goal = o
    } else goal = b.goal
    if (goal) {
      const here = cellOf(sim.map, t.pos.x, t.pos.z)
      // a full-grid search is the expensive part: at most every 45-75 frames per bot
      if (now >= b.repathAt) {
        b.path = bfs(sim, here, goal)
        b.goal = b.path.length ? goal : null
        b.repathAt = now + 45 + Math.floor(Math.random() * 30)
      }
      while (b.path.length && b.path[0][0] === here[0] && b.path[0][1] === here[1]) b.path.shift()
      // look a cell further when the line there is open (smoother corners)
      const next = b.path.length > 1 && clearLine(sim, t.pos.x, t.pos.z, cellPos(sim.map, ...b.path[1]).x, cellPos(sim.map, ...b.path[1]).z) ? b.path[1] : b.path[0]
      if (next) {
        const c = cellPos(sim.map, next[0], next[1])
        mx = c.x - t.pos.x
        mz = c.z - t.pos.z
      } else b.goal = null
    }
    if (now >= b.fleeUntil) b.fleeFrom = null
  }
  if (now >= b.mineAt) {
    b.mineAt = now + 12
    mineSense(sim, p, b, enemies, friends, e)
  }
  // ---- eight keys, and a moment to change them
  const want = Math.hypot(mx, mz) > 0.01 ? Math.round(Math.atan2(mz, mx) / (Math.PI / 4)) & 7 : -1
  if (want === b.held) b.next = null
  else {
    if (!b.next || b.next.dir !== want) b.next = { dir: want, at: now + b.keyDelay }
    if (now >= b.next.at) {
      b.held = want
      b.next = null
    }
  }
  inp.mx = b.held < 0 ? 0 : Math.cos((b.held * Math.PI) / 4)
  inp.mz = b.held < 0 ? 0 : Math.sin((b.held * Math.PI) / 4)
  inp.analog = false
}

/** open (no block, no hole) */
const open = (sim: ArenaSim, c: number, r: number) => sim.field.at(c, r) === 0
const isCork = (code: number) => code >= 101 && code <= 107

/**
 * When to lay a mine or a nuke, and which mine to shoot (every 12 frames). A mine goes down
 * only with a reason, never with a teammate in reach of the blast or another mine close by.
 */
function mineSense(sim: ArenaSim, p: Player, b: Brain, enemies: ATank[], friends: ATank[], e: ATank | null) {
  const t = p.tank
  const now = sim.tick
  const dist = (o: { pos: { x: number; z: number } }) => Math.hypot(o.pos.x - t.pos.x, o.pos.z - t.pos.z)
  // ---- a mine worth shooting: an enemy right next to it, us (and teammates) well clear
  b.shootMine = null
  for (const m of sim.mines) {
    if (m.state === 2 || (!m.armed && !m.nuke)) continue
    const reach = m.blastMax + TANK.mineRadius
    const d = dist(m)
    if (d < reach + 40 || d > 520) continue
    if (friends.some((f) => Math.hypot(f.pos.x - m.pos.x, f.pos.z - m.pos.z) < reach + 20)) continue
    if (!enemies.some((o) => Math.hypot(o.pos.x - m.pos.x, o.pos.z - m.pos.z) < reach - 6)) continue
    if (!clearLine(sim, t.pos.x, t.pos.z, m.pos.x, m.pos.z)) continue
    b.shootMine = m
    break
  }
  const st = sim.stats(t)
  if (t.pc.mineTimer > 0) return
  const safe = (r: number) => !friends.some((f) => dist(f) < r + 30)
  // ---- the match's one nuke (nukeNow); the blast escape and shooting it once enemies are in
  // take over from there
  if (t.nukes > 0 && nukeNow(sim, p, b, enemies, friends, e)) {
    p.wantNuke = true
    b.fleeUntil = 0
    b.fleeFrom = null
    return
  }
  const mine = sim.mines.filter((m) => m.owner === t && m.state !== 2).length < st.maxMines
  if (!mine || !safe(MINE.blastMax) || sim.mines.some((m) => m.state !== 2 && dist(m) < 90)) return
  const lay = (flee: number) => {
    p.wantMine = true
    b.fleeUntil = now + flee
    b.fleeFrom = { x: t.pos.x, z: t.pos.z }
  }
  const [c, r] = cellOf(sim.map, t.pos.x, t.pos.z)
  if (e) {
    const d = dist(e)
    const ux = (t.pos.x - e.pos.x) / (d || 1), uz = (t.pos.z - e.pos.z) / (d || 1)
    // chased: the enemy closes in while we drive away; it runs into the mine
    const closing = -(e.vel.x * ux + e.vel.z * uz)
    const leaving = t.vel.x * ux + t.vel.z * uz
    if (d < 240 && closing > 0.3 && leaving > 0.3 && Math.random() < 0.5) return lay(40)
    // a corridor the enemy is coming down, out of its sight: an ambush
    const ns = open(sim, c, r - 1) && open(sim, c, r + 1) && !open(sim, c - 1, r) && !open(sim, c + 1, r)
    const ew = open(sim, c - 1, r) && open(sim, c + 1, r) && !open(sim, c, r - 1) && !open(sim, c, r + 1)
    if ((ns || ew) && d < 380 && d > 140 && closing > 0.3 && !clearLine(sim, t.pos.x, t.pos.z, e.pos.x, e.pos.z) && Math.random() < 0.3) return lay(70)
    // a close fight: between us and it, then back off
    if (d < 200 && Math.random() < 0.12) return lay(70)
  }
  // cork in the way of where we're going: blow it open
  const goal = e ? cellOf(sim.map, e.pos.x, e.pos.z) : b.goal
  if (goal && (!b.path.length || (e && !clearLine(sim, t.pos.x, t.pos.z, e.pos.x, e.pos.z)))) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (!isCork(sim.field.at(c + dx, r + dy))) continue
      const closer = Math.hypot(goal[0] - (c + dx), goal[1] - (r + dy)) < Math.hypot(goal[0] - c, goal[1] - r)
      if (closer && Math.random() < (b.path.length ? 0.1 : 0.5)) return lay(90)
    }
  }
}

/**
 * Whether to lay the nuke here and now. It's a trap more than a bomb: the fuse gives everyone
 * time to leave, so it goes where enemies are or are heading, and the bot shoots it once it's
 * clear and they're inside (the mine to shoot, in mineSense).
 */
function nukeNow(sim: ArenaSim, p: Player, b: Brain, enemies: ATank[], friends: ATank[], e: ATank | null) {
  const t = p.tank
  const R = nukeBlast(sim.level(t)) * 0.85
  const dist = (o: ATank) => Math.hypot(o.pos.x - t.pos.x, o.pos.z - t.pos.z)
  const inside = enemies.filter((o) => dist(o) < R)
  if (!inside.length && !enemies.some((o) => dist(o) < R + 260)) return false
  // a last stand (one-life modes): a shell is about to hit and enemies are close; it goes off
  // after we're gone and the kills are still ours
  if (b.doomed && isOneLife(sim.mode) && inside.length) return lay()
  // one at a time: never while another nuke is on the map, nor right after a bot's last one
  if (sim.mines.some((m) => m.nuke && !m.dead)) return false
  if (sim.tick - (lastNuke.get(sim) ?? -1e9) < NUKE_AI.gap[sim.mode] * 60) return false
  // teammates in reach: an enemy shooting it would catch them
  if (friends.some((f) => dist(f) < R + 30)) return false
  // Battle royale: no room left to get out of the blast
  if (sim.zone && sim.zoneR() < R * 1.7) return false
  // use it or lose it: the match is nearly over
  const ending =
    sim.mode === 'royale'
      ? sim.players.filter((q) => q.tank.alive).length <= 4
      : sim.mode === 'elim'
        ? sim.teamScore.some((s) => s === ELIM.rounds - 1)
        : sim.phaseEnd - sim.tick < 45 * 60
  // early on everyone is still spreading out from the bases: it waits for the fight to form
  if (b.nukeWait < 0) b.nukeWait = between(NUKE_AI.wait[sim.mode])
  if (!ending && sim.tick - sim.roundStart < (NUKE_AI.grace[sim.mode] + b.nukeWait) * 60) return false
  // enemies closing in on us (they'll drive into it)
  const coming = enemies.filter((o) => {
    const d = dist(o)
    if (d > R + 260 || d < 1) return false
    return (o.vel.x * (t.pos.x - o.pos.x) + o.vel.z * (t.pos.z - o.pos.z)) / d > 0.4
  })
  // what a catch is worth: a tank, more for the leader or one on a kill streak (worth ending
  // early), more again for one driving into it
  const top = Math.max(...sim.players.filter((q) => q.team !== p.team || !isTeamMode(sim.mode)).map((q) => q.score))
  const worth = (o: ATank) => 1 + (o.player.score >= top && top > 0 ? 1 : 0) + (sim.level(o) > 0 ? 1 : 0) + (coming.includes(o) ? 0.5 : 0)
  const value = inside.reduce((v, o) => v + worth(o), 0) + coming.filter((o) => dist(o) >= R).reduce((v, o) => v + worth(o) * 0.5, 0)
  // a crowd, or a prize (the leader or a streak) closing in
  if (value >= 3) return lay()
  if (value >= 2.5 && Math.random() < 0.3) return lay()
  const left = (team: number) => sim.players.filter((q) => q.tank.alive && q.team === team).length
  // Elimination, outnumbered: a wall in front of their push
  if (sim.mode === 'elim' && coming.length >= 2 && left(p.team) < left(1 - p.team) && Math.random() < 0.25) return lay()
  // chased by someone worth it: they drive over it
  if (e && dist(e) < R && coming.includes(e) && worth(e) >= 2.5 && t.speed > 1 && Math.random() < 0.12) return lay()
  return ending && inside.length > 0 && Math.random() < 0.3 && lay()

  // only with a way out of the blast that's short enough to drive before the fuse runs out
  // (about 18 cells; it's searched only when there's a reason to lay it)
  function lay() {
    const blast = { pos: t.pos, blastMax: nukeBlast(sim.level(t)) } as unknown as AMine
    const path = escapePath(sim, cellOf(sim.map, t.pos.x, t.pos.z), [blast])
    if (!b.doomed || !isOneLife(sim.mode)) {
      if (!path.length || path.length >= 18) return false
      // Battle royale: and one that ends inside the zone
      if (sim.zone) {
        const end = cellPos(sim.map, ...path[path.length - 1])
        if (Math.hypot(end.x - sim.zone.x, end.z - sim.zone.z) >= sim.zoneR() * 0.9) return false
      }
    }
    lastNuke.set(sim, sim.tick)
    return true
  }
}

/** a pickup worth the detour: one closer than the fight */
function pickupNear(sim: ArenaSim, t: ATank, fight: number, share = 0.7) {
  let best: { c: number; r: number } | null = null
  let bd = Infinity
  for (const k of sim.pickups) {
    const d = Math.hypot(k.x - t.pos.x, k.z - t.pos.z)
    const reach = Math.min(450 * share, fight * share)
    if (d < reach && d < bd) (bd = d), (best = k)
  }
  return best
}
