// Arena wire protocol (WebSocket /ws/arena, JSON text frames). The server simulates at 60 Hz
// and sends every client a snapshot of what is near its tank 20 times a second, a scoreboard +
// minimap every half second, and global events (kills, broken blocks, match state) to all.

import type { ArenaMode, PickupKind } from './rules'

export const ARENA_PROTO = 2

export type C2S =
  | { t: 'join'; v: number; name: string; mode: ArenaMode }
  /** input for one tick: seq, move x/z, analog, aim x/z, fire / mine pressed this tick (0/1) */
  | { t: 'i'; s: number; mx: number; mz: number; an: number; ax: number; az: number; f: number; m: number }
  | { t: 'ping'; c: number }
  | { t: 'leave' }
  /** development servers only (ARENA_DEV=1): become a special tank */
  | { t: 'dev'; power: string }

/** [id, x, z, body, turret, flags, pid] */
export type TankRec = [number, number, number, number, number, number, number]
/** [id, x, z, vx, vz, smoke] */
export type ShellRec = [number, number, number, number, number, number]
/** [id, x, z, fuseLit 0/1] */
export type MineRec = [number, number, number, number]
/** [id, x, z, kind] */
export type PickupRec = [number, number, number, PickupKind]

export const TF_ALIVE = 1
export const TF_PROTECT = 2
/** a White tank this client cannot see (only its tracks show) */
export const TF_STEALTH = 4
/** power index + 1 in bits 3-5 (rules PICKUP_KINDS order) */
export const TF_POWER_SHIFT = 3

/** the receiving client's own tank, full precision for prediction */
export type YouRec = {
  /** input seq applied last */
  a: number
  x: number
  z: number
  vx: number
  vz: number
  /** body forward x / z */
  fx: number
  fz: number
  /** controller: speed, sign, freeze, shell / mine timers */
  sp: number
  sg: number
  fr: number
  st: number
  mt: number
  alive: number
  /** ticks until respawn / protection / power end */
  respawn: number
  protect: number
  power: PickupKind | null
  powerLeft: number
  /** shells / mines ready, and the most the tank may have out */
  shells: number
  mines: number
  maxShells: number
  maxMines: number
}

/** compact events: kind first (see sim ArenaEvent) */
export type NetEv =
  | ['shot', number, number, number, number, number] // tank, x, z, smoke, type
  | ['ric', number, number]
  | ['die', number, number, number] // x, z, wall
  | ['clash', number, number]
  | ['kill', number, number, number, number, number, string, number] // tank, x, z, victim, killer, cause, streak
  | ['mset', number, number]
  | ['fuse', number, number, number]
  | ['boom', number, number]
  | ['brk', number, number, number]
  | ['pick', number, string, number, number]
  | ['spawn', number, number, number]
  | ['match', string]

export type BoardPlayer = [number, string, number, string, number, number, number, number] // pid, name, team, color, kills, deaths, score, bot
export type Board = {
  t: 'board'
  players: BoardPlayer[]
  teams: number[]
  state: 'play' | 'over'
  secs: number
  winner: { name: string; color: string } | null
  /** minimap dots: [pid, x, z] (teammates always, enemies while they are firing) */
  mm: [number, number, number][]
}

export type S2C =
  | { t: 'welcome'; v: number; arena: string; pid: number; tank: number; mode: ArenaMode; seed: number; broken: [number, number][]; tick: number; online: number }
  | { t: 'map'; seed: number; tick: number }
  | { t: 's'; k: number; T: TankRec[]; S: ShellRec[]; M: MineRec[]; K: PickupRec[]; E: NetEv[]; you: YouRec }
  | Board
  | { t: 'pong'; c: number }
  | { t: 'error'; message: string }

export const r1 = (v: number) => Math.round(v * 10) / 10
