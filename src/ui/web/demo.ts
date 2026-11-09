// Attract mode: a silent match behind the title screen and menus. A simple bot drives player
// 1 through random missions of the classic campaign; the run restarts before it reaches the
// result screens, so nothing is recorded.

import type { Session, Pads } from '../../app/types'
import { padToIntent, type Game } from '../../game'
import type { PadState } from '../../input'

const IDLE: PadState = {
  moveX: 0,
  moveY: 0,
  analog: true,
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
}

/** a mission lasts at most this long before the next one */
const MAX_FRAMES = 60 * 40

export class DemoSession implements Session {
  readonly kind = 'demo'
  private frames = 0
  private heading = Math.random() * Math.PI * 2
  private turnAt = 0
  private fireCd = 60
  private last = { x: 0, z: 0 }
  private stuck = 0

  constructor(private game: Game) {
    this.next()
  }

  private next() {
    // early missions are the most readable; later ones the most lively
    const pool = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
    this.game.paused = false
    this.game.newGame(1, pool[Math.floor(Math.random() * pool.length)], undefined, null)
    this.frames = 0
  }

  step(_pads: Pads) {
    const g = this.game
    // StateComplete / StateGameOver lead to the result screens: start another mission instead
    if (g.state === 0 || g.state >= 8 || this.frames > MAX_FRAMES) this.next()
    this.frames++
    g.tick((w) => {
      const me = w.playerTanks[0]
      if (!me || !me.lives) return
      let target: { x: number; z: number } | null = null
      let best = Infinity
      for (const e of w.enemyTanks)
        if (e.active && e.lives > 0) {
          const d = Math.hypot(e.pos.x - me.pos.x, e.pos.z - me.pos.z)
          if (d < best) {
            best = d
            target = e.pos
          }
        }
      // wander, turning every couple of seconds or when blocked; back off from close enemies
      const moved = Math.hypot(me.pos.x - this.last.x, me.pos.z - this.last.z)
      this.last = { x: me.pos.x, z: me.pos.z }
      this.stuck = moved < 0.2 ? this.stuck + 1 : 0
      if (this.frames >= this.turnAt || this.stuck > 20) {
        this.heading = this.stuck > 20 ? this.heading + Math.PI * (0.5 + Math.random()) : this.heading + (Math.random() - 0.5) * 2
        if (target && best < 160) this.heading = Math.atan2(me.pos.z - target.z, me.pos.x - target.x) + (Math.random() - 0.5)
        this.turnAt = this.frames + 90 + Math.floor(Math.random() * 120)
        this.stuck = 0
      }
      const go = this.frames % 400 < 330
      const pad: PadState = {
        ...IDLE,
        moveX: go ? Math.cos(this.heading) : 0,
        moveY: go ? Math.sin(this.heading) : 0,
      }
      if (--this.fireCd <= 0 && target && g.state === 4) {
        pad.fire = true
        this.fireCd = 35 + Math.floor(Math.random() * 50)
      }
      padToIntent(me, pad, target ? { x: target.x + (Math.random() - 0.5) * 20, z: target.z + (Math.random() - 0.5) * 20 } : null)
    })
  }
}
