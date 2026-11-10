// LocalSession: the game runs here, driven by local input devices (1-4 players).

import type { Game } from '../game'
import { padToIntent, pointerToScreen, projectToScreen, screenToField } from '../game'
import { Input, type PadState } from '../input'
import type { Tank } from '../sim/world'
import type { Pads, Session } from './types'

/** layout space the remote pointer maps into (832 x 456, 16:9) */
const LAYOUT_W = 832
const LAYOUT_H = 456

export type Cursor = { x: number; y: number; clamped: boolean; far: boolean; visible: boolean }

/**
 * Pointer [0,1]^2 over the stage -> cursor (layout units) and aim point on the turret plane.
 * Without one, the remote pointer rules for the 16:9 picture apply (pointerToScreen/screenToField).
 */
export type AimFn = (pointer: { x: number; y: number }, tank: Tank | null) => { cursor: Omit<Cursor, 'visible'>; world: { x: number; z: number } }

/** world point -> layout units (the app's camera; the original camera's projectToScreen without one) */
export type ProjectFn = (x: number, y: number, z: number) => { x: number; y: number }

/** RPTnkCursor: the cursor line to the tank appears this far (layout units) from it */
const CURSOR_FAR = 480
/** turret height: the aim plane */
const AIM_Y = 17.6

/** stage pointer [0,1]^2 -> remote pointer units (x right, y down, both in half screen widths) */
export function pointerUnits(p: { x: number; y: number }) {
  return { x: p.x * 2 - 1, y: (p.y * 2 - 1) * (LAYOUT_H / LAYOUT_W) }
}

/**
 * Which device drives which player: 1P takes every device; with more players the keyboard
 * and mouse are player 1 and gamepads follow, unless there is a gamepad for everyone.
 */
export function assignPads(p: Pads, players: number): PadState[] {
  if (players === 1) return [p.merged]
  const gp = p.gamepads
  if (gp.length >= players) return gp.slice(0, players).map((g, i) => (i === 0 ? Input.merge(p.kbm, g) : g))
  const out = [p.kbm, ...gp]
  while (out.length < players) out.push({ ...p.kbm, fire: false, mine: false, moveX: 0, moveY: 0, pointer: null, aimStick: null })
  return out.slice(0, players)
}

/** first-person view: the player whose tank carries the camera, and the view heading
 * (simulation angle convention: atan2(z, x)) */
export type Fpv = { player: number; yaw: number }

/** rotate a stick/keys move (x right, y down the screen) into the world, relative to `yaw` */
export function fpvMove(pd: PadState, yaw: number): PadState {
  const fwd = -pd.moveY
  const side = pd.moveX
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  // forward is (cos, sin); right (seen from the camera, y up) is (-sin, cos)
  return { ...pd, moveX: fwd * c - side * s, moveY: fwd * s + side * c, analog: true }
}

export class LocalSession implements Session {
  readonly kind = 'local'
  cursors: Cursor[] = [0, 1, 2, 3].map(() => ({ x: 0, y: 0, clamped: false, far: false, visible: false }))
  /** set by the app while the first-person view is on */
  fpv: Fpv | null = null

  constructor(
    private game: Game,
    private aim?: AimFn,
    private project: ProjectFn = (x, y, z) => projectToScreen({ x, y, z }),
  ) {}

  step(pads: Pads) {
    const game = this.game
    const per = assignPads(pads, game.players)
    game.tick((w) => {
      for (let i = 0; i < game.players; i++) {
        const t = w.playerTanks[i]
        const cur = this.cursors[i]
        if (this.fpv?.player === i) {
          // first person: aim straight ahead, drive relative to the view
          const yaw = this.fpv.yaw
          cur.visible = false
          padToIntent(t, fpvMove(per[i], yaw), { x: t.pos.x + Math.cos(yaw) * 400, z: t.pos.z + Math.sin(yaw) * 400 })
          continue
        }
        const pd = per[i]
        const ptr = pd.pointer ? pointerUnits(pd.pointer) : null
        let aim: { x: number; z: number } | null = null
        if (pd.pointer && this.aim) {
          const a = this.aim(pd.pointer, t.lives ? t : null)
          Object.assign(cur, a.cursor, { visible: true })
          aim = a.world
        } else if (ptr) {
          const s = pointerToScreen(ptr.x, ptr.y, game.aspect, t.lives ? t : null)
          Object.assign(cur, s, { visible: true })
          aim = screenToField(s.x, s.y)
        } else if (pd.aimStick) {
          // touch aim stick: the cursor where the stick points around the tank (padToIntent's
          // 200 units), so the classic cursor follows the aim like it follows the pointer
          aim = { x: t.pos.x + pd.aimStick.x * 200, z: t.pos.z + pd.aimStick.y * 200 }
          const c = this.project(aim.x, AIM_Y, aim.z)
          const tp = this.project(t.pos.x, t.pos.y + AIM_Y, t.pos.z)
          Object.assign(cur, c, { clamped: false, far: !!t.lives && Math.hypot(c.x - tp.x, c.y - tp.y) >= CURSOR_FAR, visible: true })
        } else cur.visible = false
        padToIntent(t, pd, aim)
      }
    })
  }
}
