// Server modules plug HTTP routes and WebSocket endpoints into server/index.ts.

import type { Server, ServerWebSocket } from 'bun'

export type WsData = { module: string; url: string; [k: string]: unknown }

export interface ServerModule {
  name: string
  /** handle /api/<...>; return undefined to pass to the next module */
  http?(req: Request, url: URL, server: Server<WsData>): Response | undefined | Promise<Response | undefined>
  /** players connected and in a game or lobby right now (the title screen's live count) */
  online?(): number
  /** WebSocket endpoint at /ws/<name> */
  ws?: {
    /** accept the upgrade (return extra data for ws.data) or reject with a Response */
    upgrade?(req: Request, url: URL): Record<string, unknown> | Response
    open?(ws: ServerWebSocket<WsData>): void
    message?(ws: ServerWebSocket<WsData>, msg: string | Buffer): void
    close?(ws: ServerWebSocket<WsData>, code: number, reason: string): void
  }
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } })
