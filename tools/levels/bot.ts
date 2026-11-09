// Scripted players for headless runs (classic regression trace, Tanks+ playtests).

import { padToIntent } from '../../src/game'
import type { PadState } from '../../src/input'
import type { World } from '../../src/sim/world'

/** a released pad; `analog` stays unset so padToIntent infers it from the stick values (as
 * tools/dev/simtest.ts does; the classic trace depends on it) */
export const idlePad = (): PadState =>
  ({
  moveX: 0,
  moveY: 0,
  pointer: null,
  aimStick: null,
  fire: false,
  mine: false,
  pause: false,
  confirm: false,
  back: false,
  up: false,
  down: false,
  left: false,
  right: false,
  }) as Omit<PadState, 'analog'> as PadState

function lcg(seed: number) {
  let s = seed >>> 0 || 1
  return () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32
}

/** random wanderer: drives in random directions, aims near the nearest enemy, fires and mines */
export function randomBot(seed: number) {
  const rnd = lcg(seed)
  const dir = [0, 0, 0, 0]
  const hold = [0, 0, 0, 0]
  return (w: World) => {
    for (let i = 0; i < w.players; i++) {
      const t = w.playerTanks[i]
      if (!t.active) continue
      if (--hold[i] <= 0) {
        dir[i] = rnd() * Math.PI * 2
        hold[i] = 20 + Math.floor(rnd() * 60)
      }
      const p = idlePad()
      p.moveX = Math.cos(dir[i])
      p.moveY = Math.sin(dir[i])
      let best: { x: number; z: number } | null = null
      let bd = Infinity
      for (const e of w.enemyTanks)
        if (e.alive) {
          const d = Math.hypot(e.pos.x - t.pos.x, e.pos.z - t.pos.z)
          if (d < bd) {
            bd = d
            best = e.pos
          }
        }
      p.fire = rnd() < 0.08
      p.mine = rnd() < 0.004
      padToIntent(t, p, best ? { x: best.x + (rnd() - 0.5) * 60, z: best.z + (rnd() - 0.5) * 60 } : null)
    }
  }
}

/**
 * A simple competent player: paths toward the nearest enemy over the grid, fires when it has a
 * clear line, dodges shells flying at it, drops a mine when an enemy is close, picks up
 * power-ups nearby. Good enough to tell a clearable level from a broken one.
 */
export function aimBot(seed: number) {
  const rnd = lcg(seed)
  const state = [0, 1, 2, 3].map(() => ({ path: [] as [number, number][], repath: 0, fireWait: 0, stuck: 0, last: { x: 0, z: 0 }, jiggle: 0 }))
  return (w: World) => {
    for (let i = 0; i < w.players; i++) {
      const t = w.playerTanks[i]
      const st = state[i]
      if (!t.active || t.lives <= 0) continue
      const p = idlePad()
      // target: nearest living enemy (hidden ones by their last position anyway)
      let target: { x: number; z: number } | null = null
      let td = Infinity
      for (const e of w.enemyTanks)
        if (e.alive) {
          const d = Math.hypot(e.pos.x - t.pos.x, e.pos.z - t.pos.z)
          if (d < td) {
            td = d
            target = e.pos
          }
        }
      // a power-up close by wins over the enemy for driving
      let goal = target
      const items = w.plus?.powerups.items ?? []
      for (const it of items) if (Math.hypot(it.pos.x - t.pos.x, it.pos.z - t.pos.z) < 140) goal = it.pos
      if (goal && --st.repath <= 0) {
        st.path = gridPath(w, t.pos, goal)
        st.repath = 20
        // walled off: try a switch (gates), else wander
        if (!st.path.length && w.plus) {
          const sw = w.plus.tiles.list.filter((x) => x.code === 540)
          const s = sw[Math.floor(rnd() * sw.length)]
          if (s && Math.hypot(s.x - t.pos.x, s.z - t.pos.z) > 20) st.path = gridPath(w, t.pos, s)
          else st.jiggle = 20
        }
      }
      let mx = 0
      let mz = 0
      const line = target && w.clearShot(t.pos, target)
      if (st.path.length > 1 && !(line && td < 220)) {
        const [c, r] = st.path[1]
        const q = w.cellCenter(c, r)
        mx = q.x - t.pos.x
        mz = q.z - t.pos.z
        const [tc, tr] = w.cellAt(t.pos)
        if (tc === c && tr === r) st.path.shift()
      } else if (target && td < 120) {
        // too close: back off
        mx = t.pos.x - target.x
        mz = t.pos.z - target.z
      }
      // dodge shells heading at us
      for (const s of w.bullets) {
        const dx = t.pos.x - s.pos.x
        const dz = t.pos.z - s.pos.z
        const d = Math.hypot(dx, dz)
        const sp = Math.hypot(s.vel.x, s.vel.z) || 1
        const vx = s.vel.x / sp
        const vz = s.vel.z / sp
        if (d > 140 || dx * vx + dz * vz <= 0 || (s.age < 6 && s.owner === t)) continue
        const perp = dx * vz - dz * vx
        if (Math.abs(perp) < 30) {
          const side = perp >= 0 ? 1 : -1
          mx = vz * side * 2
          mz = -vx * side * 2
        }
      }
      // unstick
      if (Math.hypot(t.pos.x - st.last.x, t.pos.z - st.last.z) < 0.2 && (mx || mz)) st.stuck++
      else st.stuck = 0
      st.last = { x: t.pos.x, z: t.pos.z }
      if (st.stuck > 30) {
        st.jiggle = 25
        st.stuck = 0
        st.repath = 0
      }
      if (st.jiggle > 0) {
        st.jiggle--
        const a = rnd() * Math.PI * 2
        mx = Math.cos(a)
        mz = Math.sin(a)
      }
      const m = Math.hypot(mx, mz)
      if (m > 0) {
        p.moveX = mx / m
        p.moveY = mz / m
      }
      if (--st.fireWait <= 0 && target && line) {
        p.fire = true
        st.fireWait = 14 + Math.floor(rnd() * 10)
      }
      if (target && td < 75 && rnd() < 0.05) p.mine = true
      padToIntent(t, p, target ? { x: target.x, z: target.z } : null)
    }
  }
}

/** BFS over cells a tank can drive through (teleporters not used) */
function gridPath(w: World, from: { x: number; z: number }, to: { x: number; z: number }): [number, number][] {
  const [sc, sr] = w.cellAt(from)
  const [gc, gr] = w.cellAt(to)
  const W = w.width
  const H = w.height
  const prev = new Int32Array(W * H).fill(-1)
  const ok = (c: number, r: number) => c >= 0 && r >= 0 && c < W && r < H && w.grid[r][c].kind === 0
  const q = [sr * W + sc]
  prev[sr * W + sc] = sr * W + sc
  while (q.length) {
    const k = q.shift()!
    const c = k % W
    const r = (k - c) / W
    if (c === gc && r === gr) break
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nc = c + dc
      const nr = r + dr
      const n = nr * W + nc
      if ((ok(nc, nr) || (nc === gc && nr === gr)) && prev[n] < 0) {
        prev[n] = k
        q.push(n)
      }
    }
  }
  const g = gr * W + gc
  if (prev[g] < 0) return []
  const out: [number, number][] = []
  for (let k = g; ; k = prev[k]) {
    out.unshift([k % W, Math.floor(k / W)])
    if (prev[k] === k) break
  }
  return out
}
