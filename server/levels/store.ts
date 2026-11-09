// Community level store: SQLite tables and queries (used by server/modules/levels.ts).
//
//   level_packs    one row per published pack; `data` is the pack JSON (src/levels/format.ts)
//   level_ratings  1-5 stars, one per (pack, voter)
//   level_reports  one per (pack, voter); a pack with REPORT_HIDE reports is hidden from lists
//
// Owners and voters are identified by sha256 of the random token the client keeps in
// localStorage (no accounts). Seeded example packs have no owner.

import { db, migrate } from '../db'
import type { LevelPack } from '../../src/levels/format'

migrate(
  'levels-1',
  `CREATE TABLE level_packs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    author TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner_hash TEXT,
    data TEXT NOT NULL,
    level_count INTEGER NOT NULL,
    cover TEXT NOT NULL,
    plays INTEGER NOT NULL DEFAULT 0,
    rating_sum INTEGER NOT NULL DEFAULT 0,
    rating_count INTEGER NOT NULL DEFAULT 0,
    reports INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    seed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX level_packs_created ON level_packs (created_at);
  CREATE INDEX level_packs_owner ON level_packs (owner_hash);
  CREATE TABLE level_ratings (
    pack_id TEXT NOT NULL REFERENCES level_packs (id) ON DELETE CASCADE,
    voter_hash TEXT NOT NULL,
    stars INTEGER NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (pack_id, voter_hash)
  );
  CREATE TABLE level_reports (
    pack_id TEXT NOT NULL REFERENCES level_packs (id) ON DELETE CASCADE,
    voter_hash TEXT NOT NULL,
    reason TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (pack_id, voter_hash)
  );`,
)

export const REPORT_HIDE = 5
/** Bayesian prior for "top rated": REVIEW_PRIOR votes of PRIOR_STARS */
const PRIOR_STARS = 3
const REVIEW_PRIOR = 2

type Row = {
  id: string
  name: string
  author: string
  description: string
  owner_hash: string | null
  data: string
  level_count: number
  cover: string
  plays: number
  rating_sum: number
  rating_count: number
  reports: number
  hidden: number
  seed: number
  created_at: number
  updated_at: number
}

export type PackSummary = {
  id: string
  name: string
  author: string
  description: string
  levels: number
  /** cells of the first level (thumbnails) */
  cover: number[][]
  plays: number
  /** average stars (0 when unrated) */
  rating: number
  ratings: number
  created: number
  updated: number
  official: boolean
  /** the requesting token owns this pack */
  mine: boolean
}

export function hashToken(t: string) {
  return new Bun.CryptoHasher('sha256').update('tanks-levels:' + t).digest('hex')
}

export function newId() {
  const abc = '0123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ'
  const b = crypto.getRandomValues(new Uint8Array(9))
  return [...b].map((x) => abc[x % abc.length]).join('')
}

function summary(r: Row, owner: string | null): PackSummary {
  return {
    id: r.id,
    name: r.name,
    author: r.author,
    description: r.description,
    levels: r.level_count,
    cover: JSON.parse(r.cover),
    plays: r.plays,
    rating: r.rating_count ? Math.round((r.rating_sum / r.rating_count) * 10) / 10 : 0,
    ratings: r.rating_count,
    created: r.created_at,
    updated: r.updated_at,
    official: !!r.seed,
    mine: !!owner && r.owner_hash === owner,
  }
}

const SORTS: Record<string, string> = {
  new: 'created_at DESC',
  top: `((rating_sum + ${PRIOR_STARS * REVIEW_PRIOR}) * 1.0 / (rating_count + ${REVIEW_PRIOR})) DESC, rating_count DESC, created_at DESC`,
  plays: 'plays DESC, created_at DESC',
}

export function listPacks(o: { sort: string; q: string; page: number; limit: number; owner: string | null; mine: boolean }) {
  const where = ['hidden = 0']
  const args: (string | number)[] = []
  if (o.mine) {
    where[0] = 'owner_hash = ?'
    args.push(o.owner ?? '-')
  }
  if (o.q) {
    where.push(`(name LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\')`)
    const like = '%' + o.q.replace(/[\\%_]/g, (c) => '\\' + c) + '%'
    args.push(like, like)
  }
  const w = where.join(' AND ')
  const total = (db.query(`SELECT COUNT(*) AS n FROM level_packs WHERE ${w}`).get(...args) as { n: number }).n
  const rows = db
    .query(
      `SELECT id, name, author, description, owner_hash, level_count, cover, plays, rating_sum, rating_count, seed, created_at, updated_at, '' AS data, 0 AS reports, 0 AS hidden
       FROM level_packs WHERE ${w} ORDER BY ${SORTS[o.sort] ?? SORTS.new} LIMIT ? OFFSET ?`,
    )
    .all(...args, o.limit, o.page * o.limit) as Row[]
  return { items: rows.map((r) => summary(r, o.owner)), total, page: o.page, limit: o.limit }
}

export function getRow(id: string): Row | null {
  return (db.query('SELECT * FROM level_packs WHERE id = ?').get(id) as Row | null) ?? null
}

export function getPack(id: string, owner: string | null) {
  const r = getRow(id)
  if (!r || (r.hidden && r.owner_hash !== owner)) return null
  const pack = JSON.parse(r.data) as LevelPack
  pack.id = r.id
  pack.author = r.author
  const mine = owner ? (db.query('SELECT stars FROM level_ratings WHERE pack_id = ? AND voter_hash = ?').get(id, owner) as { stars: number } | null) : null
  return { ...summary(r, owner), pack, myRating: mine?.stars ?? 0 }
}

export function insertPack(p: { id?: string; pack: LevelPack; author: string; owner: string | null; seed?: boolean }) {
  const id = p.id ?? newId()
  const now = Date.now()
  const pack = { ...p.pack, author: p.author }
  delete pack.id
  db.query(
    `INSERT OR IGNORE INTO level_packs (id, name, author, description, owner_hash, data, level_count, cover, seed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, pack.name, p.author, pack.description ?? '', p.owner, JSON.stringify(pack), pack.levels.length, JSON.stringify(pack.levels[0].cells), p.seed ? 1 : 0, now, now)
  return id
}

export function updatePack(id: string, pack: LevelPack, author: string) {
  const data = { ...pack, author }
  delete data.id
  db.query(`UPDATE level_packs SET name = ?, author = ?, description = ?, data = ?, level_count = ?, cover = ?, updated_at = ? WHERE id = ?`).run(
    pack.name,
    author,
    pack.description ?? '',
    JSON.stringify(data),
    pack.levels.length,
    JSON.stringify(pack.levels[0].cells),
    Date.now(),
    id,
  )
}

export function deletePack(id: string) {
  db.query('DELETE FROM level_packs WHERE id = ?').run(id)
}

export function ownedCount(owner: string) {
  return (db.query('SELECT COUNT(*) AS n FROM level_packs WHERE owner_hash = ?').get(owner) as { n: number }).n
}

export function ratePack(id: string, voter: string, stars: number) {
  db.transaction(() => {
    db.query(
      `INSERT INTO level_ratings (pack_id, voter_hash, stars, at) VALUES (?, ?, ?, ?)
       ON CONFLICT (pack_id, voter_hash) DO UPDATE SET stars = excluded.stars, at = excluded.at`,
    ).run(id, voter, stars, Date.now())
    db.query(
      `UPDATE level_packs SET rating_sum = (SELECT COALESCE(SUM(stars), 0) FROM level_ratings WHERE pack_id = ?),
       rating_count = (SELECT COUNT(*) FROM level_ratings WHERE pack_id = ?) WHERE id = ?`,
    ).run(id, id, id)
  })()
  const r = getRow(id)!
  return { rating: r.rating_count ? Math.round((r.rating_sum / r.rating_count) * 10) / 10 : 0, ratings: r.rating_count }
}

export function addPlay(id: string) {
  db.query('UPDATE level_packs SET plays = plays + 1 WHERE id = ?').run(id)
  return getRow(id)?.plays ?? 0
}

export function reportPack(id: string, voter: string, reason: string) {
  const res = db.query('INSERT OR IGNORE INTO level_reports (pack_id, voter_hash, reason, at) VALUES (?, ?, ?, ?)').run(id, voter, reason, Date.now())
  if (res.changes) db.query(`UPDATE level_packs SET reports = reports + 1, hidden = CASE WHEN reports + 1 >= ? AND seed = 0 THEN 1 ELSE hidden END WHERE id = ?`).run(REPORT_HIDE, id)
}
