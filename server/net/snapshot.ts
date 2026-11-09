// World -> wire: simulation events to NetEvents, and per-client delta snapshots.

import {
  quantTank,
  TF_ACTIVE,
  TF_ALIVE,
  TF_STATE_SHIFT,
  TF_STEALTH,
  TREAD_SE,
  type Hold,
  type MarkRec,
  type MineRec,
  type NetEvent,
  type Snapshot,
  type TankRec,
  type TreadRec,
  type YouRec,
} from '../../src/net/protocol'
import type { SimEvent, Tank, World } from '../../src/sim/world'
import { round } from './presenter'

/** wire slot of a tank: players 0-3, enemies 4 + index */
export const slotOf = (t: Tank) => (t.isEnemy ? 4 + t.index : t.index)

/** what one tick produced for the clients */
export type TickOut = { events: NetEvent[]; treads: TreadRec[]; treadSe: [number, number][] }

export function convertEvents(ev: SimEvent[], out: TickOut, holds: Hold[]) {
  for (const e of ev)
    switch (e.t) {
      case 'se': {
        if (e.tank && e.name.startsWith('RP_TNK_SE_CATERPILLAR')) {
          const i = TREAD_SE.indexOf(e.name)
          if (i >= 0) {
            out.treadSe.push([slotOf(e.tank), i])
            break
          }
        }
        out.events.push(['s', e.name, e.pos ? round(e.pos.x) : null, e.pos ? round(e.pos.z) : null, e.tank ? slotOf(e.tank) : -1])
        break
      }
      case 'seHold':
        holds.push([e.key, e.name, e.pos ? round(e.pos.x) : 0, e.pos ? round(e.pos.z) : 0])
        break
      case 'bgm':
        out.events.push(['b', e.name])
        break
      case 'bgmStop':
        out.events.push(['bs', e.fade])
        break
      case 'bgmMask':
        out.events.push(['bm', e.mask])
        break
      case 'shoot':
        out.events.push(['sh', slotOf(e.tank), e.bullet ? 1 : 0])
        break
      case 'ricochet':
        out.events.push(['r', round(e.pos.x), round(e.pos.y), round(e.pos.z)])
        break
      case 'bulletDie':
        out.events.push(['bd', round(e.pos.x), round(e.pos.y), round(e.pos.z), e.reason])
        break
      case 'tankDie':
        out.events.push(['td', slotOf(e.tank), round(e.tank.pos.x), round(e.tank.pos.z)])
        break
      case 'mineExplode':
        out.events.push(['me', round(e.mine.pos.x), round(e.mine.pos.y), round(e.mine.pos.z)])
        break
      case 'blockBreak':
        out.events.push(['bb', e.cx, e.cz, e.height])
        break
      case 'stealth':
        out.events.push(['st', slotOf(e.tank)])
        break
      case 'tread':
        out.treads.push({ slot: slotOf(e.tank), x: e.pos.x, z: e.pos.z, dir: Math.atan2(e.dir.z, e.dir.x) })
        break
    }
}

/** the state every client sees this snapshot tick (computed once per room) */
export type Common = {
  tanks: TankRec[]
  tankKeys: string[]
  bullets: Snapshot['bullets']
  mines: MineRec[]
  minesKey: string
  marks: MarkRec[]
  marksKey: string
  aims: { x: number; z: number }[]
  aimsKey: string
}

export function common(w: World): Common {
  const tanks: TankRec[] = []
  const all = [...w.playerTanks.slice(0, w.players), ...w.enemyTanks]
  for (const t of all) {
    const flags = (t.active ? TF_ACTIVE : 0) | (t.lives > 0 ? TF_ALIVE : 0) | (t.stealth ? TF_STEALTH : 0) | ((t.state & 7) << TF_STATE_SHIFT)
    tanks.push(quantTank({ slot: slotOf(t), flags, type: t.isEnemy ? t.enemyType : 0, x: t.pos.x, z: t.pos.z, body: t.body, turret: t.turret }))
  }
  const bullets = w.shellPool.items.filter((s) => s.active).map((s) => ({ id: s.id, x: s.pos.x, z: s.pos.z, heading: Math.atan2(s.vel.z, s.vel.x), smoke: s.smokeType }))
  const mines = w.minePool.items.filter((m) => m.active && m.state !== 2).map((m) => ({ id: m.id, x: m.pos.x, z: m.pos.z, fuse: m.fuseLit }))
  const marks = w.marks.items.filter((m) => m.active).map((m) => ({ id: m.id, x: m.pos.x, z: m.pos.z, color: m.color }))
  const aims = w.playerTanks.slice(0, w.players).map((t) => ({ x: Math.round(t.intent.aimX * 8) / 8, z: Math.round(t.intent.aimZ * 8) / 8 }))
  return {
    tanks,
    tankKeys: tanks.map((t) => `${t.flags},${t.type},${t.x},${t.z},${t.body},${t.turret}`),
    bullets,
    mines,
    minesKey: mines.map((m) => `${m.id},${m.fuse ? 1 : 0}`).join(';'),
    marks,
    marksKey: marks.map((m) => m.id).join(','),
    aims,
    aimsKey: aims.map((a) => `${a.x},${a.z}`).join(';'),
  }
}

/** the receiving player's own tank, exact (prediction replays from here) */
export function youOf(w: World, player: number, ack: number): YouRec | undefined {
  const t = w.playerTanks[player]
  if (!t || !t.active || player >= w.players) return undefined
  const p = t.player
  return {
    ack,
    x: t.pos.x,
    z: t.pos.z,
    fx: t.rot.z.x,
    fz: t.rot.z.z,
    speed: p.speed,
    sign: p.sign,
    freeze: p.freeze,
    shellTimer: p.shellTimer,
    mineTimer: p.mineTimer,
    mineHeld: p.mineHeld,
    shells: w.shellPool.shellNum[player] ?? 0,
    mines: w.minePool.mineNum[player] ?? 0,
  }
}

/** per-client memory of what was last sent (deltas against it) */
export class Baseline {
  key = true
  tanks = new Map<number, string>()
  mines = ''
  marks = ''
  aims = ''
  meta = ''

  reset() {
    this.key = true
    this.tanks.clear()
    this.mines = this.marks = this.aims = this.meta = ''
  }
}
