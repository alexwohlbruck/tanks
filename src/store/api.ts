// Client for the level store API (server/modules/levels.ts) and the anonymous author identity.

import type { AppContext } from '../app/types'
import type { LevelPack } from '../levels/format'

const TOKEN = 'tanks.author.token'
const NAME = 'tanks.author.name'

/** the random secret that identifies this browser as an author / voter (the server keeps a hash) */
export function authorToken(): string {
  let t = localStorage.getItem(TOKEN)
  if (!t || !/^[0-9a-f]{64}$/.test(t)) {
    t = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')
    localStorage.setItem(TOKEN, t)
  }
  return t
}
export function setAuthorToken(t: string) {
  localStorage.setItem(TOKEN, t)
}

export function authorName(): string {
  return localStorage.getItem(NAME) ?? ''
}
export function setAuthorName(n: string) {
  localStorage.setItem(NAME, n.trim())
}

export type Sort = 'new' | 'top' | 'plays'

export type PackSummary = {
  id: string
  name: string
  author: string
  description: string
  levels: number
  cover: number[][]
  plays: number
  rating: number
  ratings: number
  created: number
  updated: number
  official: boolean
  mine: boolean
}

export type PackDetail = PackSummary & { pack: LevelPack; myRating: number }

export class ApiError extends Error {
  constructor(public status: number, message: string, public details: string[] = []) {
    super(message)
  }
}

export class StoreApi {
  constructor(private app: AppContext) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('x-author-token', authorToken())
    if (init.body) headers.set('content-type', 'application/json')
    let r: Response
    try {
      r = await this.app.api(`/levels${path}`, { ...init, headers })
    } catch {
      throw new ApiError(0, 'cannot reach the level server')
    }
    const data = await r.json().catch(() => null)
    if (!r.ok) throw new ApiError(r.status, data?.error ?? `server error ${r.status}`, data?.details ?? [])
    return data as T
  }

  list(o: { sort: Sort; q?: string; page?: number; limit?: number; mine?: boolean }) {
    const p = new URLSearchParams({ sort: o.sort, page: String(o.page ?? 0), limit: String(o.limit ?? 24) })
    if (o.q) p.set('q', o.q)
    if (o.mine) p.set('mine', '1')
    return this.call<{ items: PackSummary[]; total: number; page: number; limit: number }>(`?${p}`)
  }
  get(id: string) {
    return this.call<PackDetail>(`/${encodeURIComponent(id)}`)
  }
  publish(pack: LevelPack, author: string) {
    return this.call<{ id: string }>('', { method: 'POST', body: JSON.stringify({ pack, author }) })
  }
  update(id: string, pack: LevelPack, author: string) {
    return this.call<{ id: string }>(`/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ pack, author }) })
  }
  remove(id: string) {
    return this.call<{ ok: true }>(`/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }
  rate(id: string, stars: number) {
    return this.call<{ rating: number; ratings: number }>(`/${encodeURIComponent(id)}/rate`, { method: 'POST', body: JSON.stringify({ stars }) })
  }
  play(id: string) {
    return this.call<{ plays: number }>(`/${encodeURIComponent(id)}/play`, { method: 'POST' })
  }
  report(id: string, reason: string) {
    return this.call<{ ok: true }>(`/${encodeURIComponent(id)}/report`, { method: 'POST', body: JSON.stringify({ reason }) })
  }
}
