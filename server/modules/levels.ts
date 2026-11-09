// Community level store: REST API under /api/levels (docs/levels.md).
//
//   GET    /api/levels?sort=new|top|plays&q=&page=0&limit=24[&mine=1]   list
//   GET    /api/levels/:id                                              pack + stats
//   POST   /api/levels            { pack, author }                      publish -> { id }
//   PUT    /api/levels/:id        { pack, author }                      update (owner)
//   DELETE /api/levels/:id                                              delete (owner)
//   POST   /api/levels/:id/rate   { stars: 1-5 }
//   POST   /api/levels/:id/play
//   POST   /api/levels/:id/report { reason }
//
// Identity: `X-Author-Token` (a random secret the client keeps; the server stores its hash).

import type { Server } from 'bun'
import { checkPack, LIMITS, normalizePack } from '../../src/levels/check'
import type { LevelPack } from '../../src/levels/format'
import { register } from '../index'
import { json, type WsData } from '../module'
import { clientIp, RateLimit } from '../levels/ratelimit'
import { seedStore } from '../levels/seed'
import * as store from '../levels/store'

const reads = new RateLimit(120, 240)
const writes = new RateLimit(6, 6)
const publishes = new RateLimit(5, 0.2)
const votes = new RateLimit(30, 30)
/** play counts: one per ip + pack per 10 minutes */
const plays = new Map<string, number>()
const MAX_PACKS_PER_OWNER = 200

seedStore()

const bad = (error: string, status = 400) => json({ error }, status)

function ownerOf(req: Request): string | null {
  const t = req.headers.get('x-author-token')
  if (!t || !/^[0-9a-f]{32,128}$/i.test(t)) return null
  return store.hashToken(t)
}

async function body(req: Request): Promise<Record<string, unknown> | Response> {
  const len = Number(req.headers.get('content-length') ?? 0)
  if (len > LIMITS.bytes + 4096) return bad('request too large', 413)
  const text = await req.text()
  if (text.length > LIMITS.bytes + 4096) return bad('request too large', 413)
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? v : bad('expected a JSON object')
  } catch {
    return bad('invalid JSON')
  }
}

const cleanName = (s: unknown) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '')

function readPack(b: Record<string, unknown>): { pack: LevelPack; author: string } | Response {
  const author = cleanName(b.author)
  if (!author) return bad('a display name is required to publish')
  if (author.length > LIMITS.author) return bad(`display name is longer than ${LIMITS.author} characters`)
  const raw = b.pack as LevelPack
  const c = checkPack(raw)
  if (c.errors.length) return json({ error: 'invalid pack', details: c.errors.slice(0, 20) }, 422)
  const pack = normalizePack(raw)
  if (JSON.stringify(pack).length > LIMITS.bytes) return bad('pack is too large', 413)
  return { pack, author }
}

async function handle(req: Request, url: URL, server: Server<WsData>): Promise<Response | undefined> {
  const parts = url.pathname.split('/').filter(Boolean) // ['api', 'levels', id?, action?]
  if (parts[1] !== 'levels') return undefined
  const ip = clientIp(req, server)
  const owner = ownerOf(req)
  const [, , id, action] = parts
  const m = req.method

  if (!reads.take(ip)) return bad('too many requests', 429)

  if (!id) {
    if (m === 'GET') {
      const sort = url.searchParams.get('sort') ?? 'new'
      const q = (url.searchParams.get('q') ?? '').trim().slice(0, 64)
      const page = Math.max(0, Math.min(10000, Number(url.searchParams.get('page')) | 0))
      const limit = Math.max(1, Math.min(60, Number(url.searchParams.get('limit') ?? 24) | 0))
      return json(store.listPacks({ sort, q, page, limit, owner, mine: url.searchParams.get('mine') === '1' }))
    }
    if (m === 'POST') {
      if (!owner) return bad('missing X-Author-Token', 401)
      if (!writes.take(ip) || !publishes.take(ip)) return bad('publishing too fast; try again in a few minutes', 429)
      const b = await body(req)
      if (b instanceof Response) return b
      const p = readPack(b)
      if (p instanceof Response) return p
      if (store.ownedCount(owner) >= MAX_PACKS_PER_OWNER) return bad('too many packs published with this identity', 403)
      const nid = store.insertPack({ pack: p.pack, author: p.author, owner })
      return json({ id: nid }, 201)
    }
    return bad('method not allowed', 405)
  }

  if (!/^[\w-]{1,32}$/.test(id)) return bad('not found', 404)
  const row = store.getRow(id)
  if (!row || (row.hidden && row.owner_hash !== owner)) return bad('not found', 404)

  if (!action) {
    if (m === 'GET') return json(store.getPack(id, owner))
    if (m === 'PUT' || m === 'DELETE') {
      if (!owner || row.owner_hash !== owner) return bad('only the author can change this pack', 403)
      if (!writes.take(ip)) return bad('too many requests', 429)
      if (m === 'DELETE') {
        store.deletePack(id)
        return json({ ok: true })
      }
      const b = await body(req)
      if (b instanceof Response) return b
      const p = readPack(b)
      if (p instanceof Response) return p
      store.updatePack(id, p.pack, p.author)
      return json({ id })
    }
    return bad('method not allowed', 405)
  }

  if (m !== 'POST') return bad('method not allowed', 405)
  if (!votes.take(ip)) return bad('too many requests', 429)
  const voter = owner ?? store.hashToken('ip:' + ip)
  if (action === 'play') {
    const k = `${ip}|${id}`
    const now = Date.now()
    if ((plays.get(k) ?? 0) > now - 10 * 60000) return json({ plays: row.plays })
    plays.set(k, now)
    if (plays.size > 20000) for (const [pk, t] of plays) if (t < now - 10 * 60000) plays.delete(pk)
    return json({ plays: store.addPlay(id) })
  }
  const b = await body(req)
  if (b instanceof Response) return b
  if (action === 'rate') {
    const stars = Number(b.stars)
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) return bad('stars must be 1-5')
    if (row.owner_hash && row.owner_hash === owner) return bad('you cannot rate your own pack', 403)
    return json(store.ratePack(id, voter, stars))
  }
  if (action === 'report') {
    const reason = cleanName(b.reason).slice(0, 200) || 'unspecified'
    store.reportPack(id, voter, reason)
    return json({ ok: true })
  }
  return bad('not found', 404)
}

register({ name: 'levels', http: handle })
