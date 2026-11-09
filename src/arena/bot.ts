// Arena bots: drive the same tanks through the same inputs as players. Not the disc's AI (that
// one hunts players 1-2 on a 22 x 17 field); a small brain for a big map with teams:
//   - hunt the nearest enemy it can reach (grid BFS path), keep a fighting distance
//   - fire on a clear line, or bank a shot off one wall when that line is blocked
//   - dodge shells heading its way (teammates' too: every shell hits), flare the ones it can't
//     dodge, back away from armed mines and nukes
//   - mines with a reason (see mineSense): behind it when chased, in a corridor an enemy is
//     coming down, against cork in its way, in a close fight; never near a teammate or on top
//     of another mine. Shoots mines that have an enemy next to them. Nukes go down where
//     enemies crowd, then it runs.

import { MINE, TANK } from '../sim/consts'
import { cellOf, cellPos } from './map'
import { NUKE } from './rules'
import type { AMine, ArenaSim, ATank, Player } from './sim'

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
}

const brains = new WeakMap<Player, Brain>()

function brain(p: Player): Brain {
  let b = brains.get(p)
  if (!b) brains.set(p, (b = { path: [], goal: null, repathAt: 0, thinkAt: 0, target: null, bank: null, fleeUntil: 0, fleeFrom: null, jitter: 0, strafe: Math.random() < 0.5 ? 1 : -1, seenSince: -1, mineAt: 0, shootMine: null, escape: [], escapeAt: 0 }))
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
  for (let h = 0; h < q.length && h < 600; h++) {
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
  // a White enemy is only seen up close or right after it fires
  const enemies = sim.tanks.filter((o) => o.alive && sim.enemies(p, o.player) && (o.power !== 'white' || now - o.firedAt < 40 || Math.hypot(o.pos.x - t.pos.x, o.pos.z - t.pos.z) < 110))
  const friends = sim.tanks.filter((o) => o.alive && o !== t && !sim.enemies(p, o.player))
  // ---- pick a target (every 10 frames) and bank shots (every 20)
  if (now >= b.thinkAt) {
    b.thinkAt = now + 10
    let best: ATank | null = null
    let bd = 900
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
  const e = b.target && b.target.alive ? b.target : null
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
      const reacted = clear && now - b.seenSince > 24 + (e.player.bot ? 0 : 18)
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
  p.wantFire ||= fire
  // ---- where to go
  let mx = 0
  let mz = 0
  // threats first: shells heading this way, armed mines nearby
  for (const s of sim.shells) {
    if (s.owner === t && s.age < 30) continue
    const dx = t.pos.x - s.pos.x, dz = t.pos.z - s.pos.z
    const d = Math.hypot(dx, dz)
    if (d > 180) continue
    const sp = Math.hypot(s.vel.x, s.vel.z) || 1
    const vx = s.vel.x / sp, vz = s.vel.z / sp
    if (dx * vx + dz * vz <= 0) continue
    const side = -dx * vz + dz * vx
    if (Math.abs(side) > 40) continue
    // too close to step aside: a flare turns it back (now and then a bot is too slow)
    const along = dx * vx + dz * vz
    if (Math.abs(side) < 28 && along / sp < 22 && t.flares > 0 && now >= t.flareReady && Math.random() < 0.5) p.wantFlare = true
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
    const dist = e ? Math.hypot(e.pos.x - t.pos.x, e.pos.z - t.pos.z) : 0
    const seen = e && clearLine(sim, t.pos.x, t.pos.z, e.pos.x, e.pos.z)
    const from = b.fleeFrom ?? e?.pos
    if (now < b.fleeUntil && from) {
      mx = t.pos.x - from.x
      mz = t.pos.z - from.z
    } else if (e && seen && dist < 260) {
      // strafe around the target
      const ux = (e.pos.x - t.pos.x) / dist, uz = (e.pos.z - t.pos.z) / dist
      mx = -uz * b.strafe - ux * (dist < 150 ? 1 : 0)
      mz = ux * b.strafe - uz * (dist < 150 ? 1 : 0)
      if (Math.random() < 0.01) b.strafe = -b.strafe
    } else if (e) goal = cellOf(sim.map, e.pos.x, e.pos.z)
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
  const l = Math.hypot(mx, mz)
  inp.mx = l > 0.01 ? mx / l : 0
  inp.mz = l > 0.01 ? mz / l : 0
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
  // ---- a nuke: where two enemies are in reach (or one, now and then), then run
  if (t.nukes > 0) {
    const R = NUKE.blast * 0.8
    const near = enemies.filter((o) => dist(o) < R).length
    if ((near >= 2 || (near === 1 && Math.random() < 0.15)) && safe(NUKE.blast)) {
      p.wantMine = true
      b.fleeUntil = now + NUKE.fuse - 10
      b.fleeFrom = { x: t.pos.x, z: t.pos.z }
      return
    }
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
