// The browser's connection to the game server (/ws/rooms): control messages, input frames,
// snapshots, ping, and reconnecting into the same seat (token kept in sessionStorage, so a
// reload of the tab rejoins; another tab is another player).

import {
  BIN_SNAPSHOT,
  decodeSnapshot,
  encodeInput,
  PROTO_VERSION,
  type C2S,
  type NetInput,
  type RoomInfo,
  type RoomListing,
  type S2C,
  type Snapshot,
} from './protocol'

const TOKEN_KEY = 'tanks-net-token'
const NAME_KEY = 'tanks-net-name'

export type NetStatus = 'offline' | 'connecting' | 'online'

type Msg = S2C | { t: 'snapshot'; s: Snapshot; bytes: number } | { t: 'status'; status: NetStatus }

function store(kind: 'session' | 'local') {
  try {
    return kind === 'session' ? sessionStorage : localStorage
  } catch {
    return null
  }
}

export class NetClient {
  ws: WebSocket | null = null
  status: NetStatus = 'offline'
  token = store('session')?.getItem(TOKEN_KEY) ?? ''
  name = store('local')?.getItem(NAME_KEY) ?? ''
  room: RoomInfo | null = null
  rooms: RoomListing[] = []
  /** smoothed round trip, ms */
  rtt = 0
  lastError = ''
  /** bytes received (for the KB/s readout) */
  bytesIn = 0
  bytesOut = 0
  private listeners = new Set<(m: Msg) => void>()
  private ping: ReturnType<typeof setInterval> | null = null
  private wanted = false
  private retries = 0
  private opening: Promise<void> | null = null

  constructor(private url = defaultUrl()) {}

  on(f: (m: Msg) => void) {
    this.listeners.add(f)
    return () => this.listeners.delete(f)
  }
  private emit(m: Msg) {
    for (const f of [...this.listeners]) f(m)
  }

  setName(n: string) {
    this.name = n.slice(0, 16)
    store('local')?.setItem(NAME_KEY, this.name)
    if (this.status === 'online') this.send({ t: 'name', name: this.name })
  }

  /** connects (once); resolves when the server has said welcome */
  connect(): Promise<void> {
    this.wanted = true
    if (this.status === 'online') return Promise.resolve()
    if (this.opening) return this.opening
    this.opening = new Promise<void>((resolve, reject) => {
      this.setStatus('connecting')
      const ws = new WebSocket(this.url)
      ws.binaryType = 'arraybuffer'
      this.ws = ws
      let welcomed = false
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', v: PROTO_VERSION, name: this.name || 'Player', token: this.token || undefined } satisfies C2S))
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') {
          const b = new Uint8Array(e.data as ArrayBuffer)
          this.bytesIn += b.length
          if (b[0] !== BIN_SNAPSHOT) return
          const s = decodeSnapshot(b)
          if (s) this.emit({ t: 'snapshot', s, bytes: b.length })
          return
        }
        this.bytesIn += e.data.length
        let m: S2C
        try {
          m = JSON.parse(e.data)
        } catch {
          return
        }
        if (m.t === 'welcome') {
          welcomed = true
          this.token = m.token
          store('session')?.setItem(TOKEN_KEY, m.token)
          this.retries = 0
          this.opening = null
          this.setStatus('online')
          this.startPing()
          resolve()
        } else if (m.t === 'room') this.room = m.room
        else if (m.t === 'rooms') this.rooms = m.rooms
        else if (m.t === 'error') this.lastError = m.msg
        else if (m.t === 'pong') {
          const rtt = performance.now() - m.c
          this.rtt = this.rtt ? this.rtt * 0.7 + rtt * 0.3 : rtt
        }
        this.emit(m)
      }
      ws.onclose = () => {
        if (this.ws !== ws) return
        this.ws = null
        this.opening = null
        this.stopPing()
        this.setStatus('offline')
        if (!welcomed) reject(new Error('could not reach the game server'))
        // a dropped connection while in a room: come back into the same seat
        if (this.wanted && this.room && this.retries < 40) {
          const wait = Math.min(3000, 300 * 2 ** this.retries++)
          setTimeout(() => this.wanted && this.status === 'offline' && this.connect().catch(() => {}), wait)
        }
      }
    })
    return this.opening
  }

  /** closes the connection for good (no reconnect) */
  disconnect() {
    this.wanted = false
    this.room = null
    this.ws?.close()
  }

  private setStatus(s: NetStatus) {
    this.status = s
    this.emit({ t: 'status', status: s })
  }

  private startPing() {
    this.stopPing()
    const tick = () => this.send({ t: 'ping', c: performance.now(), rtt: Math.round(this.rtt) })
    tick()
    this.ping = setInterval(tick, 1000)
  }
  private stopPing() {
    if (this.ping) clearInterval(this.ping)
    this.ping = null
  }

  send(m: C2S) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    const s = JSON.stringify(m)
    this.bytesOut += s.length
    this.ws.send(s)
    return true
  }

  sendInput(i: NetInput) {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    const b = encodeInput(i)
    this.bytesOut += b.length
    this.ws.send(b)
  }
}

function defaultUrl() {
  const l = typeof location !== 'undefined' ? location : ({ protocol: 'http:', host: 'localhost:5300' } as Location)
  return `${l.protocol === 'https:' ? 'wss' : 'ws'}://${l.host}/ws/rooms`
}

/** the app's connection (created on first use) */
let shared: NetClient | null = null
export function netClient() {
  return (shared ??= new NetClient())
}
