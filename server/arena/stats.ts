// Arena player stats (SQLite): lifetime totals per player id, and a per-day table for the
// "Today" leaderboard. Players have no accounts: the browser makes a random id once
// (localStorage) and sends it with every join, so stats follow that browser.

import { db, migrate } from '../db'

migrate(
  'arena-stats-1',
  `CREATE TABLE arena_players (
     id TEXT PRIMARY KEY, name TEXT NOT NULL,
     kills INTEGER NOT NULL DEFAULT 0, deaths INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0,
     matches INTEGER NOT NULL DEFAULT 0, best_streak INTEGER NOT NULL DEFAULT 0, seconds INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL);
   CREATE INDEX arena_players_kills ON arena_players (kills DESC);
   CREATE TABLE arena_daily (
     day TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
     kills INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (day, id));
   CREATE INDEX arena_daily_kills ON arena_daily (day, kills DESC);`,
)

export type StatDelta = { kills: number; deaths: number; wins: number; matches: number; best: number; seconds: number }
export const emptyDelta = (): StatDelta => ({ kills: 0, deaths: 0, wins: 0, matches: 0, best: 0, seconds: 0 })
export const isStatId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9]{16,40}$/.test(id)

const day = () => new Date().toISOString().slice(0, 10)

const upsertPlayer = db.query(
  `INSERT INTO arena_players (id, name, kills, deaths, wins, matches, best_streak, seconds, updated_at)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
   ON CONFLICT (id) DO UPDATE SET name = ?2, kills = kills + ?3, deaths = deaths + ?4, wins = wins + ?5,
     matches = matches + ?6, best_streak = MAX(best_streak, ?7), seconds = seconds + ?8, updated_at = ?9`,
)
const upsertDaily = db.query(
  `INSERT INTO arena_daily (day, id, name, kills, wins) VALUES (?1, ?2, ?3, ?4, ?5)
   ON CONFLICT (day, id) DO UPDATE SET name = ?3, kills = kills + ?4, wins = wins + ?5`,
)

/** adds a player's pending numbers (no-op when there is nothing to add) */
export function addStats(id: string, name: string, d: StatDelta) {
  if (!d.kills && !d.deaths && !d.wins && !d.matches && !d.best && d.seconds < 5) return
  db.transaction(() => {
    upsertPlayer.run(id, name, d.kills, d.deaths, d.wins, d.matches, d.best, Math.round(d.seconds), Date.now())
    if (d.kills || d.wins) upsertDaily.run(day(), id, name, d.kills, d.wins)
  })()
}

export type Leader = { name: string; kills: number; wins: number; me?: boolean }

/** top 10 of today and of all time (by kills, then wins); `me` marks the asking player */
export function leaders(me?: string) {
  const mark = (rows: (Leader & { id: string })[]) => rows.map(({ id, ...r }) => (id === me ? { ...r, me: true } : r))
  const today = db.query('SELECT id, name, kills, wins FROM arena_daily WHERE day = ? ORDER BY kills DESC, wins DESC LIMIT 10').all(day()) as (Leader & { id: string })[]
  const all = db.query('SELECT id, name, kills, wins FROM arena_players ORDER BY kills DESC, wins DESC LIMIT 10').all() as (Leader & { id: string })[]
  return { today: mark(today), all: mark(all) }
}

export function playerStats(id: string) {
  return db.query('SELECT name, kills, deaths, wins, matches, best_streak AS best, seconds FROM arena_players WHERE id = ?').get(id) as
    | { name: string; kills: number; deaths: number; wins: number; matches: number; best: number; seconds: number }
    | null
}
