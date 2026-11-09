// Scripted players for headless runs (classic regression trace, Tanks+ playtests).

import { padToIntent } from '../../src/game'
import type { PadState } from '../../src/input'
import type { World } from '../../src/sim/world'

export const idlePad = (): PadState => ({
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
})

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
