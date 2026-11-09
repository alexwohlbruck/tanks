// SQLite storage (bun:sqlite). Modules add their tables through `migrations`.

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'

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
