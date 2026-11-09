// Arena: the massively-multiplayer mode (not in the original). Many players and bots share one
// big procedurally generated map; free-for-all or two teams; timed matches with respawns.
// Tank, shell and mine rules are the player tank's from the disc (TnkGameParam record 0).
//
// Rules
//   - one hit destroys a tank (a Shield pickup absorbs one); respawn after RESPAWN_TICKS at a
//     spawn point away from enemies, protected for PROTECT_TICKS (ends early on firing)
//   - Free-for-all: a kill scores 1, destroying yourself costs 1; first to FFA_LIMIT wins
//   - Teams (Blue vs Red): no friendly fire (shells pass teammates, their mines ignore you);
//     every kill scores for the team; first team to TEAM_LIMIT wins
//   - otherwise the match ends after MATCH_TICKS; the best score wins
//   - INTERMISSION_TICKS of results, then a new map
//   - pickups appear around the map: Rockets (fast shells), Ricochet (3 bounces), Shield, Turbo
//   - bots fill an arena up to BOT_FILL tanks and leave as players arrive

export const ARENA_TPS = 60
/** snapshots per second (every SNAPSHOT_EVERY ticks) */
export const SNAPSHOT_EVERY = 3

export type ArenaMode = 'ffa' | 'teams'

export const MAP = { cols: 84, rows: 56 } as const
export const MAX_HUMANS = 24
export const BOT_FILL = 10

export const MATCH_TICKS = 6 * 60 * 60
export const INTERMISSION_TICKS = 12 * 60
export const FFA_LIMIT = 25
export const TEAM_LIMIT = 50

export const RESPAWN_TICKS = 3 * 60
export const PROTECT_TICKS = Math.round(2.5 * 60)

export type PickupKind = 'rocket' | 'bounce' | 'shield' | 'speed'
export const PICKUP_KINDS: PickupKind[] = ['rocket', 'bounce', 'shield', 'speed']
export const PICKUP_TICKS: Record<PickupKind, number> = { rocket: 20 * 60, bounce: 20 * 60, shield: 30 * 60, speed: 15 * 60 }
export const PICKUP_INFO: Record<PickupKind, { name: string; color: string }> = {
  rocket: { name: 'Rockets', color: '#3fbf6a' },
  bounce: { name: 'Ricochet', color: '#e8b21c' },
  shield: { name: 'Shield', color: '#4aa8ff' },
  speed: { name: 'Turbo', color: '#ff5d8f' },
}
export const PICKUPS_MAX = 10
export const PICKUP_RESPAWN = 6 * 60
export const PICKUP_RADIUS = 22
export const ROCKET_SPEED = 1.75
export const TURBO_SPEED = 1.35

/** team colours: Blue / Red are the 1P / 2P tanks */
export const TEAM_NAMES = ['Blue', 'Red']
export const TEAM_COLORS = ['#2f6fdf', '#d8383a']
/** free-for-all liveries (the 1p model recoloured) */
export const FFA_COLORS = [
  '#2f6fdf', '#d8383a', '#34a34a', '#e8901c', '#8d4fd0', '#1fb5b0', '#d64fa0', '#c9b21c',
  '#5f6a78', '#7a4a2a', '#9ad13a', '#e0e0e0', '#33405a', '#ff7a59', '#4f7d2f', '#b03a5b',
]

export const BOT_NAMES = ['Brown', 'Grey', 'Teal', 'Yellow', 'Pink', 'Green', 'Violet', 'White', 'Black', 'Ash', 'Cork', 'Felt', 'Moss', 'Rust', 'Slate', 'Plum']
