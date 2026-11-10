// SQLite storage (bun:sqlite). Modules add their tables through `migrations`.

import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'

const dir = process.env.DATA_DIR ?? './data'
mkdirSync(dir, { recursive: true })

export const db = new Database(`${dir}/tanks.db`, { create: true })
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
db.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, at INTEGER NOT NULL)')

/** run `sql` once, keyed by `name` (modules call this at import time) */
export function migrate(name: string, sql: string) {
  const done = db.query('SELECT 1 FROM migrations WHERE name = ?').get(name)
  if (done) return
  db.transaction(() => {
    db.exec(sql)
    db.query('INSERT INTO migrations (name, at) VALUES (?, ?)').run(name, Date.now())
  })()
}

// ---- snapshots ---------------------------------------------------------------------------
// A consistent copy of the whole database (VACUUM INTO, safe while it's in use) once a day into
// DATA_DIR/backups, keeping the last SNAPSHOT_KEEP days. The host's file backup picks them up,
// so a restore never depends on copying a live WAL database.

const SNAPSHOT_KEEP = 14
const backups = `${dir}/backups`

/** write today's snapshot if there isn't one yet, then drop the oldest; returns its path */
export function snapshot(now = new Date()) {
  mkdirSync(backups, { recursive: true })
  const path = `${backups}/tanks-${now.toISOString().slice(0, 10)}.db`
  if (!existsSync(path)) db.query('VACUUM INTO ?').run(path)
  const old = readdirSync(backups)
    .filter((f) => /^tanks-\d{4}-\d\d-\d\d\.db$/.test(f))
    .sort()
    .slice(0, -SNAPSHOT_KEEP)
  for (const f of old) rmSync(`${backups}/${f}`)
  return path
}

/** a snapshot now and every hour after (only the first each day writes anything) */
export function scheduleSnapshots() {
  const run = () => {
    try {
      snapshot()
    } catch (e) {
      console.error('db snapshot failed', e)
    }
  }
  run()
  setInterval(run, 60 * 60 * 1000).unref?.()
}
