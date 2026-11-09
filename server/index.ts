// Tanks server: REST API under /api and WebSockets under /ws/<module>.
// Modules: see server/modules/*.ts (registered in MODULES below).
//   bun server/index.ts            (PORT, default 3001; DATA_DIR for SQLite, default ./data)

import type { ServerModule, WsData } from './module'
import { json } from './module'

const MODULES: ServerModule[] = []

/** modules register themselves: `register({ name, http, ws })` */
export function register(m: ServerModule) {
  MODULES.push(m)
}

// module imports (each calls register)
await import('./modules/index')

const port = Number(process.env.PORT ?? 3001)

const server = Bun.serve<WsData, never>({
  port,
  async fetch(req, server) {
    const url = new URL(req.url)
    if (url.pathname === '/api/health') return json({ ok: true, modules: MODULES.map((m) => m.name) })
    if (url.pathname.startsWith('/ws/')) {
      const name = url.pathname.split('/')[2]
      const m = MODULES.find((x) => x.name === name && x.ws)
      if (!m) return new Response('no such endpoint', { status: 404 })
      const extra = m.ws!.upgrade ? m.ws!.upgrade(req, url) : {}
      if (extra instanceof Response) return extra
      if (server.upgrade(req, { data: { module: name, url: url.toString(), ...extra } })) return undefined as never
      return new Response('upgrade failed', { status: 400 })
    }
    if (url.pathname.startsWith('/api/')) {
      for (const m of MODULES) {
        const r = await m.http?.(req, url, server)
        if (r) return r
      }
      return json({ error: 'not found' }, 404)
    }
    return new Response('not found', { status: 404 })
  },
  websocket: {
    open: (ws) => MODULES.find((m) => m.name === ws.data.module)?.ws?.open?.(ws),
    message: (ws, msg) => MODULES.find((m) => m.name === ws.data.module)?.ws?.message?.(ws, msg),
    close: (ws, code, reason) => MODULES.find((m) => m.name === ws.data.module)?.ws?.close?.(ws, code, reason),
  },
})

console.log(`tanks server on :${server.port} (${MODULES.map((m) => m.name).join(', ') || 'no modules'})`)
