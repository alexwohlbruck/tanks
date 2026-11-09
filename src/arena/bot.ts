// Arena bots: drive the same tanks through the same inputs as players. Not the disc's AI (that
// one hunts players 1-2 on a 22 x 17 field); a small brain for a big map with teams:
//   - hunt the nearest enemy it can reach (grid BFS path), keep a fighting distance
//   - fire on a clear line, or bank a shot off one wall when that line is blocked
//   - dodge shells heading its way, back away from armed mines, now and then lay one when close

import { MINE, TANK } from '../sim/consts'
import { cellOf, cellPos } from './map'
import type { ArenaSim, ATank, Player } from './sim'

type Brain = { path: [number, number][]; goal: [number, number] | null; repathAt: number; thinkAt: number; target: ATank | null; bank: { x: number; z: number } | null; fleeUntil: number; jitter: number; strafe: number; seenSince: number }

const brains = new WeakMap<Player, Brain>()

function brain(p: Player): Brain {
  let b = brains.get(p)
  if (!b) brains.set(p, (b = { path: [], goal: null, repathAt: 0, thinkAt: 0, target: null, bank: null, fleeUntil: 0, jitter: 0, strafe: Math.random() < 0.5 ? 1 : -1, seenSince: -1 }))
  return b
}

/** straight shell line from a to b (holes don't stop shells) */
export function clearLine(sim: ArenaSim, ax: number, az: number, bx: number, bz: number) {
  const d = Math.hypot(bx - ax, bz - az)
  const n = Math.ceil(d / 8)
  for (let i = 1; i < n; i++) if (sim.field.pointInBlock(ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n)) return false
  return true
}

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
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
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
  if (e) {
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
      fire = reacted && !blocked && on && d < 600 && Math.random() < 0.06
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
    if (!sim.enemies(p, s.owner.player) && s.owner !== t) continue
    const dx = t.pos.x - s.pos.x, dz = t.pos.z - s.pos.z
    const d = Math.hypot(dx, dz)
    if (d > 180) continue
    const sp = Math.hypot(s.vel.x, s.vel.z) || 1
    const vx = s.vel.x / sp, vz = s.vel.z / sp
    if (dx * vx + dz * vz <= 0) continue
    const side = -dx * vz + dz * vx
    if (Math.abs(side) > 40) continue
    // step out of the line, away from the side it would pass
    const k = side >= 0 ? 1 : -1
    mx += -vz * k * 2
    mz += vx * k * 2
  }
  for (const m of sim.mines) {
    // fresh own mines are left behind on purpose; everything else gets a wide berth
    if (m.state === 2 || (!m.armed && m.owner === t)) continue
    const dx = t.pos.x - m.pos.x, dz = t.pos.z - m.pos.z
    const d = Math.hypot(dx, dz)
    if (d < MINE.blastMax + (m.owner === t ? 80 : 50)) {
      mx += (dx / (d || 1)) * 2
      mz += (dz / (d || 1)) * 2
    }
  }
  if (!mx && !mz) {
    // fighting distance: close in along the path, hold and strafe near, back off when too close
    let goal: [number, number] | null = null
    const dist = e ? Math.hypot(e.pos.x - t.pos.x, e.pos.z - t.pos.z) : 0
    const seen = e && clearLine(sim, t.pos.x, t.pos.z, e.pos.x, e.pos.z)
    if (now < b.fleeUntil && e) {
      mx = t.pos.x - e.pos.x
      mz = t.pos.z - e.pos.z
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
    // lay a mine when an enemy is close, then get away
    if (e && dist < 220 && Math.random() < 0.006) {
      p.wantMine = true
      b.fleeUntil = now + 70
    }
  }
  const l = Math.hypot(mx, mz)
  inp.mx = l > 0.01 ? mx / l : 0
  inp.mz = l > 0.01 ? mz / l : 0
  inp.analog = false
}
