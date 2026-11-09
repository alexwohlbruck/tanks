// Arena: the massively-multiplayer mode (not in the original). Many players and bots share one
// big procedurally generated map; free-for-all or two teams; timed matches with respawns.
// Tank, shell and mine rules are the player tank's from the disc (TnkGameParam record 0).
//
// Rules
//   - one hit destroys a tank; respawn after RESPAWN_TICKS near the fighting (out of enemy
//     sight, not too close), protected for PROTECT_TICKS (ends early on firing)
//   - Free-for-all: a kill scores 1, destroying yourself costs 1; first to the size's limit wins
//   - Teams (Blue vs Red): no friendly fire (shells pass teammates, their mines ignore you);
//     every kill scores for the team; first team to its limit wins
//   - otherwise the match ends after MATCH_TICKS; the best score wins
//   - INTERMISSION_TICKS of results, then a new map
//   - pickups around the map turn you into one of the disc's special tanks for a while, or
//     give an item: a nuke (a huge mine), a shield (takes one hit) or flares
//   - flares: the third weapon. Every tank carries one (it comes back after FLARE.recharge);
//     a flare bursts around the tank and turns shells and rockets back on their shooter
//   - bots fill an arena up to its size's bot count and leave as players arrive

export const ARENA_TPS = 60
/** snapshots per second (every SNAPSHOT_EVERY ticks) */
export const SNAPSHOT_EVERY = 3

export type ArenaMode = 'ffa' | 'teams'

/**
 * Map sizes (each arena has one; players pick when they join). Bigger maps hold more players
 * and bots, more pickups, and a higher score to win.
 */
export type ArenaSize = 'small' | 'medium' | 'large'
export const ARENA_SIZES: ArenaSize[] = ['small', 'medium', 'large']
export const SIZES: Record<ArenaSize, { cols: number; rows: number; maxHumans: number; bots: number; pickups: number; ffaLimit: number; teamLimit: number; name: string }> = {
  small: { cols: 51, rows: 37, maxHumans: 10, bots: 6, pickups: 5, ffaLimit: 15, teamLimit: 30, name: 'Small' },
  medium: { cols: 84, rows: 56, maxHumans: 24, bots: 10, pickups: 10, ffaLimit: 25, teamLimit: 50, name: 'Medium' },
  large: { cols: 114, rows: 79, maxHumans: 40, bots: 16, pickups: 16, ffaLimit: 35, teamLimit: 75, name: 'Large' },
}
export const sizeOf = (v: unknown): ArenaSize => ((ARENA_SIZES as unknown[]).includes(v) ? (v as ArenaSize) : 'medium')

export const MATCH_TICKS = 6 * 60 * 60
export const INTERMISSION_TICKS = 12 * 60

export const RESPAWN_TICKS = 3 * 60
export const PROTECT_TICKS = Math.round(2.5 * 60)
/** respawns: the best distance to the nearest enemy (about a screen away), the least, and how
 * far an enemy's line of sight counts against a spawn cell */
export const SPAWN_IDEAL = 480
export const SPAWN_SAFE = 260
export const SPAWN_SIGHT = 620

/**
 * Pickups are the disc's special tanks: drive over one and your tank becomes that type for a
 * while (its model, and its trick on top of the player tank's rules):
 *   Teal    rockets (shell speed 6, no ricochet)        Green  rockets with 2 ricochets
 *   Black   very fast, rockets                          Pink   fires in bursts of three
 *   Yellow  fast mine layer: 4 mines, short cooldown    Violet aggressive: 8 shells, 3 mines
 *   White   invisible to enemies (only its tracks show; firing gives it away for a moment)
 */
//   and two Tanks+ types (src/sim/types):
//   Hornet  homing rockets (no ricochet)               Sniper very fast shells along a laser
//                                                      sight everyone can see
export type PickupKind = 'teal' | 'green' | 'black' | 'pink' | 'yellow' | 'violet' | 'white' | 'hornet' | 'sniper'
export const PICKUP_KINDS: PickupKind[] = ['teal', 'green', 'black', 'pink', 'yellow', 'violet', 'white', 'hornet', 'sniper']
/** the enemy type (1-9, Tanks+ 10+) each pickup turns you into */
export const PICKUP_TYPE: Record<PickupKind, number> = { teal: 3, pink: 4, yellow: 5, violet: 6, green: 7, white: 8, black: 9, hornet: 13, sniper: 16 }
export const PICKUP_TICKS: Record<PickupKind, number> = { teal: 20 * 60, green: 20 * 60, black: 15 * 60, pink: 20 * 60, yellow: 20 * 60, violet: 20 * 60, white: 15 * 60, hornet: 18 * 60, sniper: 18 * 60 }
export const PICKUP_INFO: Record<PickupKind, { name: string; color: string; dark: string; trick: string }> = {
  teal: { name: 'Teal', color: '#2fa5a0', dark: '#196560', trick: 'Rockets' },
  green: { name: 'Green', color: '#5bb046', dark: '#2f6b22', trick: 'Ricochet rockets' },
  black: { name: 'Black', color: '#3a3a3e', dark: '#141416', trick: 'Speed + rockets' },
  pink: { name: 'Pink', color: '#e2676f', dark: '#932a31', trick: 'Triple shot' },
  yellow: { name: 'Yellow', color: '#e8c33a', dark: '#9b7d14', trick: 'Mine layer' },
  violet: { name: 'Violet', color: '#9a5ac9', dark: '#5c2f82', trick: '8 shells, 3 mines' },
  white: { name: 'White', color: '#f3f1ea', dark: '#9d9a90', trick: 'Invisible' },
  hornet: { name: 'Hornet', color: '#e0482a', dark: '#7d2212', trick: 'Homing rockets' },
  sniper: { name: 'Sniper', color: '#3f5a2e', dark: '#1f2d16', trick: 'Laser sight, fast shells' },
}
/** items: pickups that give a weapon or a shield instead of a special tank */
export type ItemKind = 'nuke' | 'shield' | 'flares'
export const ITEM_KINDS: ItemKind[] = ['nuke', 'shield', 'flares']
export type AnyPickup = PickupKind | ItemKind
export const isItem = (k: string): k is ItemKind => (ITEM_KINDS as string[]).includes(k)
export const ITEM_INFO: Record<ItemKind, { name: string; color: string; dark: string; trick: string }> = {
  nuke: { name: 'Nuke', color: '#f2c230', dark: '#7a5a08', trick: 'A huge mine: lay it, then run' },
  shield: { name: 'Shield', color: '#7fe0c2', dark: '#2a8a6e', trick: 'Takes one hit for you' },
  flares: { name: 'Flares', color: '#ff7a2a', dark: '#9b3a0a', trick: '+2 flares: turn shells back' },
}
/** name / colours / what it does, for any pickup */
export const pickupInfo = (k: AnyPickup) => (isItem(k) ? ITEM_INFO[k] : PICKUP_INFO[k])
/** how often each pickup appears, against 1 for each special tank */
export const PICKUP_WEIGHT: Partial<Record<AnyPickup, number>> = { shield: 1.6, flares: 0.9, nuke: 0.6 }

/** Nuke: a mine with a long fuse that no tank sets off (a shell or a blast can), and a blast
 * about three times a mine's */
export const NUKE = { fuse: 170, blast: 230, growFrames: 14, killFrames: 34, frames: 70, bodyRadius: 20, max: 2 }
/** Shield: lasts this long or until it takes a hit (then a moment of protection) */
export const SHIELD = { ticks: 25 * 60, afterHit: 40 }
/** Flares: a burst `radius` around the tank for `frames`; shells and rockets coming in are
 * turned back and become the flaring tank's. Every tank has `base` (recharged one at a time
 * every `recharge` ticks); a pickup adds `pickup`, up to `max`. */
export const FLARE = { radius: 95, frames: 26, cooldown: 40, recharge: 22 * 60, base: 1, pickup: 2, max: 3 }

/**
 * Kill streaks: level 1 (x2) at 3 kills in a row, level 2 (x3) at 6; lost when destroyed.
 * Each level: +1 shell, +1 mine, +1 ricochet (shells that already ricochet), and the special
 * tank's trick grows (see powerStats); a nuke's blast and a flare's burst grow too.
 */
export const STREAK_LEVELS = [3, 6]
export const streakLevel = (streak: number) => STREAK_LEVELS.filter((n) => streak >= n).length

/** Hornet: shells turn toward the nearest enemy by up to `turn` degrees a frame after `delay`
 * frames, if it is within `range` and `cone` degrees of the flight direction (Tanks+ Hornet) */
export const HOMING = { turn: 1.5, delay: 14, range: 520, cone: 75 }
/** Sniper: the Tanks+ Sniper's shell speed */
export const SNIPER_SHELL_SPEED = 7.5
export const PICKUP_RESPAWN = 6 * 60
export const PICKUP_RADIUS = 22
/** Teal / Green / Black shell speed (their records: 6, the player's 3) */
export const ROCKET_SHELL_SPEED = 6
/** Black: speed 2.4 against the player's 1.8 */
export const BLACK_SPEED = 2.4 / 1.8
/** White is seen by enemies for this long after firing */
export const WHITE_REVEAL = 40

/** what a power (and the streak level) does to the tank's numbers; the speed never depends
 * on the level (the client predicts it from the power alone) */
export function powerStats(p: PickupKind | null, base: { speed: number; shellSpeed: number; ricochets: number; maxShells: number; maxMines: number; mineCooldown: number }, level = 0) {
  const s = { speedMul: 1, shellSpeed: base.shellSpeed, ricochets: base.ricochets, maxShells: base.maxShells, maxMines: base.maxMines, mineCooldown: base.mineCooldown, smoke: 0, burst: 1, homing: false, homingTurn: HOMING.turn }
  if (p === 'teal') Object.assign(s, { shellSpeed: ROCKET_SHELL_SPEED, ricochets: 0, smoke: 1 })
  if (p === 'green') Object.assign(s, { shellSpeed: ROCKET_SHELL_SPEED, ricochets: 2, smoke: 2 })
  if (p === 'black') Object.assign(s, { shellSpeed: ROCKET_SHELL_SPEED, ricochets: 0, smoke: 1, speedMul: BLACK_SPEED })
  if (p === 'pink') Object.assign(s, { burst: 3, maxShells: 7 })
  if (p === 'yellow') Object.assign(s, { maxMines: 4 })
  if (p === 'violet') Object.assign(s, { maxShells: 8, maxMines: 3 })
  if (p === 'hornet') Object.assign(s, { ricochets: 0, smoke: 1, homing: true, maxShells: 3 })
  if (p === 'sniper') Object.assign(s, { shellSpeed: SNIPER_SHELL_SPEED, ricochets: 1, smoke: 1, maxShells: 3 })
  if (level) {
    const L = level
    s.maxShells += L
    s.maxMines += L
    if (s.ricochets > 0) s.ricochets += L
    // the trick itself grows
    if (p === 'green') s.ricochets += L
    if (p === 'pink') s.burst += L
    if (p === 'yellow') s.maxMines += L
    if (p === 'violet') s.maxShells += L
    if (p === 'teal' || p === 'black') s.shellSpeed += 0.7 * L
    if (p === 'hornet') s.homingTurn *= 1 + 0.5 * L
    if (p === 'sniper') s.shellSpeed += 1.2 * L
  }
  return s
}

/** a nuke's blast and a flare's burst at a streak level */
export const nukeBlast = (level: number) => NUKE.blast * (1 + 0.2 * level)
export const flareRadius = (level: number) => FLARE.radius * (1 + 0.25 * level)

/** map themes (src/arena/map.ts); between matches everyone votes for the next one */
export type MapTheme = 'mixed' | 'cork' | 'pits' | 'maze'
export const MAP_THEMES: MapTheme[] = ['mixed', 'cork', 'pits', 'maze']
export const THEME_INFO: Record<MapTheme, { name: string; text: string }> = {
  mixed: { name: 'Toy box', text: 'A bit of everything' },
  cork: { name: 'Cork forest', text: 'Cork everywhere: mine your way through' },
  pits: { name: 'Sinkholes', text: 'Holes stop tanks, shells fly over' },
  maze: { name: 'Maze', text: 'Long walls and tight corridors' },
}

/** quick chat (keys 1-6) */
export const EMOTES = ['Nice shot!', 'Behind you!', 'Help!', 'Follow me!', 'Oops!', 'GG!']
export const EMOTE_TICKS = 150

/** team colours: Blue / Red are the 1P / 2P tanks */
export const TEAM_NAMES = ['Blue', 'Red']
export const TEAM_COLORS = ['#2f6fdf', '#d8383a']
/** free-for-all liveries (the 1p model recoloured) */
export const FFA_COLORS = [
  '#2f6fdf', '#d8383a', '#34a34a', '#e8901c', '#8d4fd0', '#1fb5b0', '#d64fa0', '#c9b21c',
  '#5f6a78', '#7a4a2a', '#9ad13a', '#e0e0e0', '#33405a', '#ff7a59', '#4f7d2f', '#b03a5b',
]

export const BOT_NAMES = ['Brown', 'Grey', 'Teal', 'Yellow', 'Pink', 'Green', 'Violet', 'White', 'Black', 'Ash', 'Cork', 'Felt', 'Moss', 'Rust', 'Slate', 'Plum']
