// Behaviours of the Tanks+ enemy types that the 42-word records cannot express. Each runs
// after the tank's own Calculate (the unchanged original AI), from Plus.afterCalc, and only for
// tanks whose meta opts in (src/sim/types/index.ts).

import { ENEMY_SLOT0, TANK } from '../consts'
import type { Plus, TankExt } from '../plus'
import type { Shell } from '../shell'
import type { Tank } from '../tank'
import { HIT_HAZARD } from '../tiles'
import { type V3, axesFromForward, cosDeg, normalize, sinDeg, v3, vcopy, vset } from '../vec'
import { Cell, type World } from '../world'

/** per-frame behaviours of one enemy tank (alive, in enemy control) */
export function enemyBehaviours(p: Plus, t: Tank) {
  const x = t.ext!
  const b = x.beh
  if (b.teleport) teleport(p, t, x)
  if (b.minePattern) minePattern(p, t, x)
  if (b.kamikaze) kamikaze(p, t, x)
  if (b.sniper) sniperCharge(p, t, x)
  if (b.medic) medic(p, t, x)
  if (b.spawner) spawner(p, t, x)
}

function nearestPlayer(w: World, pos: V3): { t: Tank; d: number } | null {
  let best: Tank | null = null
  let bd = Infinity
  for (let i = 0; i < w.players; i++) {
    const k = w.playerTanks[i]
    if (!k.active || k.lives <= 0) continue
    const d = Math.hypot(k.pos.x - pos.x, k.pos.z - pos.z)
    if (d < bd) {
      bd = d
      best = k
    }
  }
  return best ? { t: best, d: bd } : null
}

// ---- teleport (Blink, Overlord) -----------------------------------------------------------

function teleport(p: Plus, t: Tank, x: TankExt) {
  const b = x.beh.teleport!
  if (--x.timer[0] > 0) {
    x.warn = x.timer[0] <= b.warn ? x.timer[0] : 0
    if (x.timer[0] === b.warn) p.event('tpWarn', t.pos, t)
    return
  }
  x.timer[0] = b.interval + (p.rng.next() % 60)
  x.warn = 0
  const w = p.w
  const cells: [number, number][] = []
  for (let r = 0; r < w.height; r++)
    for (let c = 0; c < w.width; c++) {
      const g = w.grid[r][c]
      if (g.kind !== Cell.Empty || (g.code >= 500 && g.code !== 520 && g.code !== 521)) continue
      const q = w.cellCenter(c, r)
      let ok = true
      for (let i = 0; i < w.players && ok; i++) {
        const k = w.playerTanks[i]
        if (k.active && k.lives > 0 && Math.hypot(k.pos.x - q.x, k.pos.z - q.z) < b.minDist) ok = false
      }
      for (const k of w.tanks) if (ok && k !== t && k.active && Math.hypot(k.pos.x - q.x, k.pos.z - q.z) < 45) ok = false
      for (const m of w.mines) if (ok && Math.hypot(m.pos.x - q.x, m.pos.z - q.z) < 100) ok = false
      // the eight neighbours must be free too (no landing wedged against a block)
      for (let dr = -1; dr <= 1 && ok; dr++)
        for (let dc = -1; dc <= 1 && ok; dc++) {
          const n = w.grid[r + dr]?.[c + dc]
          if (!n || n.kind !== Cell.Empty) ok = false
        }
      if (ok) cells.push([c, r])
    }
  if (!cells.length) return
  const [c, r] = cells[p.rng.next() % cells.length]
  const q = w.cellCenter(c, r)
  p.event('teleport', t.pos, t, -1)
  p.moveTank(t, q.x, q.z)
  p.event('teleportIn', t.pos, t)
  w.sound('RP_TNK_SE_TNK_DISAPPEAR', t.pos)
}

// ---- mine patterns (Sapper, Titan) --------------------------------------------------------

function minePattern(p: Plus, t: Tank, x: TankExt) {
  const b = x.beh.minePattern!
  if (--x.timer[1] > 0) return
  const w = p.w
  const slot = t.index + ENEMY_SLOT0
  const mineNum = w.minePool.mineNum[slot]
  if (b.pattern === 'trail') {
    if (Math.hypot(t.vel.x, t.vel.z) < 0.5 || mineNum >= b.max) {
      x.timer[1] = 10
      return
    }
    for (const m of w.mines) if (Math.hypot(m.pos.x - t.pos.x, m.pos.z - t.pos.z) < 60) return void (x.timer[1] = 10)
    lay(w, t, v3(t.pos.x, 0, t.pos.z))
    x.timer[1] = b.interval
  } else {
    if (mineNum >= b.max) {
      x.timer[1] = 30
      return
    }
    const f = t.rot.z
    const s = t.rot.x
    for (const [a, c] of [
      [-40, 0],
      [-10, 45],
      [-10, -45],
    ]) {
      if (w.minePool.mineNum[slot]++ >= b.max) break
      const q = v3(t.pos.x + f.x * a + s.x * c, 0, t.pos.z + f.z * a + s.z * c)
      if (w.field.isInside(q) && !w.blocks.isPointInsideBlock(q)) lay(w, t, q)
    }
    x.timer[1] = b.interval
  }
}

function lay(w: World, t: Tank, at: V3) {
  const m = w.layMine(0, t, at, vcopy(at), t.index + ENEMY_SLOT0)
  if (m) t.playLayMineSe()
  return m
}

// ---- kamikaze (Rammer) ----------------------------------------------------------------------

function kamikaze(p: Plus, t: Tank, x: TankExt) {
  const b = x.beh.kamikaze!
  const w = p.w
  if (x.fuse === 0) {
    const n = nearestPlayer(w, t.pos)
    if (n && n.d < b.trigger) {
      x.fuse = b.fuse
      p.event('fuse', t.pos, t)
      w.sound('RP_TNK_SE_JIRAI_TIMER', t.pos)
    }
    return
  }
  // lit: stands still (movement freeze) while the fuse burns
  t.aiCtrl.attack.freeze = Math.max(t.aiCtrl.attack.freeze, 2)
  w.soundHold('RP_TNK_SE_JIRAI_EXP_MAE', 100 + t.index, t.pos)
  if (--x.fuse > 0) return
  const at = v3(t.pos.x, 0, t.pos.z)
  const m = w.layMine(0, t, at, vcopy(at), t.index + ENEMY_SLOT0)
  if (m) m.explode()
  t.explode(HIT_HAZARD, 'mine')
}

// ---- sniper ----------------------------------------------------------------------------------

/** AiAttack.executeActions decided to fire: start charging instead */
export function sniperIntercept(p: Plus, t: Tank): boolean {
  const x = t.ext!
  if (!x.beh.sniper) return false
  if (!x.charge) {
    x.charge = { dir: vcopy(t.turretRot.z), frames: x.beh.sniper.charge }
    p.event('charge', t.pos, t)
    p.w.sound('RP_TNK_SE_JIRAI_SET', t.pos)
  }
  return true
}

function sniperCharge(p: Plus, t: Tank, x: TankExt) {
  const c = x.charge
  if (!c) {
    x.laser = null
    return
  }
  const w = p.w
  const a = t.aiCtrl.attack
  // the turret holds the locked direction; the tank stands still
  a.setAimDirection(vcopy(c.dir))
  axesFromForward(t.turretRot, vcopy(c.dir))
  a.freeze = Math.max(a.freeze, 2)
  const from = v3(t.pos.x + c.dir.x * TANK.muzzle, 0, t.pos.z + c.dir.z * TANK.muzzle)
  const to = march(w, from, c.dir)
  x.laser = { x0: from.x, z0: from.z, x1: to.x, z1: to.z }
  if (--c.frames > 0) return
  x.charge = null
  x.laser = null
  const muzzle = v3(t.pos.x + c.dir.x * TANK.muzzle, t.pos.y + TANK.bodyHeight, t.pos.z + c.dir.z * TANK.muzzle)
  const look = p.shellLook(t.enemyType)
  const shell = w.fireShell(x.beh.sniper!.speed, t, muzzle, vcopy(c.dir), t.index + ENEMY_SLOT0, a.shellBounces, 1, look)
  t.playFireSe(shell)
  a.fireTimer = a.fireCooldown
  a.freeze = a.fireFreeze
}

/** straight line to the first block taller than a hole or the field edge */
function march(w: World, from: V3, dir: V3): V3 {
  const q = vcopy(from)
  for (let i = 0; i < 400; i++) {
    const n = v3(q.x + dir.x * 4, 0, q.z + dir.z * 4)
    if (!w.field.isInside(n) || w.blocks.isPointInsideBlock(n)) break
    vset(q, n)
  }
  return q
}

// ---- medic -----------------------------------------------------------------------------------

function medic(p: Plus, t: Tank, x: TankExt) {
  const b = x.beh.medic!
  if (--x.timer[2] > 0) return
  x.timer[2] = b.interval
  let n = 0
  for (const k of p.w.enemyTanks) {
    if (k === t || !k.active || k.lives <= 0 || !k.ext || k.ext.shield > 0) continue
    if (Math.hypot(k.pos.x - t.pos.x, k.pos.z - t.pos.z) > b.radius) continue
    k.ext.shield = 1
    p.event('shieldUp', k.pos, k)
    n++
  }
  if (n) {
    p.event('heal', t.pos, t, n)
    p.w.sound('RP_TNK_SE_TNK1UP', t.pos)
  }
}

// ---- spawner (Hive) -------------------------------------------------------------------------

function spawner(p: Plus, t: Tank, x: TankExt) {
  const b = x.beh.spawner!
  if (--x.timer[3] > 0) return
  x.timer[3] = b.interval
  const w = p.w
  let alive = 0
  for (const k of w.enemyTanks) if (k.active && k.lives > 0 && k.ext?.parent === t) alive++
  if (alive >= b.max) return
  const f = t.rot.z
  const s = t.rot.x
  for (const [a, c] of [
    [-38, 0],
    [0, 38],
    [0, -38],
    [38, 0],
  ]) {
    const q = v3(t.pos.x + f.x * a + s.x * c, 0, t.pos.z + f.z * a + s.z * c)
    if (!w.field.isInside(q) || Math.abs(q.x) > w.halfW - 18 || Math.abs(q.z) > w.halfH - 18) continue
    const [qc, qr] = w.cellAt(q)
    if (w.grid[qr]?.[qc]?.kind !== Cell.Empty) continue
    if (w.tanks.some((k) => k.active && Math.hypot(k.pos.x - q.x, k.pos.z - q.z) < 30)) continue
    const d = w.spawnExtraEnemy(q, b.type)
    if (d?.ext) {
      d.ext.parent = t
      p.event('spawn', q, d)
      w.sound('RP_TNK_SE_TNK_DISAPPEAR', q)
    }
    return
  }
}

// ---- shells ----------------------------------------------------------------------------------

/** fan shots: extra shells either side of the one AiAttack fired */
export function spreadShot(p: Plus, t: Tank, s: Shell) {
  const sp = t.ext!.beh.spread!
  const w = p.w
  const speed = Math.hypot(s.vel.x, s.vel.z)
  const d0 = normalize(v3(s.vel.x, 0, s.vel.z))
  for (let i = 1; i <= (sp.count - 1) / 2; i++)
    for (const sign of [1, -1]) {
      const a = sign * i * sp.angle
      const c = cosDeg(a)
      const n = sinDeg(a)
      const d = v3(c * d0.x - n * d0.z, 0, n * d0.x + c * d0.z)
      const muzzle = v3(t.pos.x + d.x * TANK.muzzle, s.pos.y, t.pos.z + d.z * TANK.muzzle)
      w.fireShell(speed, t, muzzle, d, s.slot, Math.max(0, s.bouncesLeft), s.smokeType, s.shooterType)
    }
}

/** homing shells: turn toward the nearest living player by at most `turn` degrees per frame */
export function steerShell(p: Plus, s: Shell, owner: Tank) {
  const h = owner.ext!.beh.homing!
  if (s.age < h.delay) return
  const n = nearestPlayer(p.w, s.pos)
  if (!n) return
  const sp = Math.hypot(s.vel.x, s.vel.z)
  if (sp === 0) return
  const cur = Math.atan2(s.vel.z, s.vel.x)
  const want = Math.atan2(n.t.pos.z + TANK.shellOffsetZ - s.pos.z, n.t.pos.x - s.pos.x)
  let diff = want - cur
  while (diff > Math.PI) diff -= 2 * Math.PI
  while (diff < -Math.PI) diff += 2 * Math.PI
  const max = (h.turn * Math.PI) / 180
  const a = cur + Math.max(-max, Math.min(max, diff))
  s.vel.x = Math.cos(a) * sp
  s.vel.z = Math.sin(a) * sp
}

