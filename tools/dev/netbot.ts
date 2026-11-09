// Headless online test: 4 bot clients join one room and play.
//   bun tools/dev/netbot.ts [ws://localhost:3003/ws/rooms] [seconds=8] [mode=coop|versus|pack]
// Checks: room join by code, game start, snapshots at ~30 Hz that decode, every bot's tank
// moves under its input (server applies inputs, acks advance), events arrive, ping; then a
// disconnect + rejoin into the same slot. Reports KB/s per client and latency.

import { decodeSnapshot, encodeInput, PROTO_VERSION, type C2S, type S2C, type Snapshot } from '../../src/net/protocol'

const url = process.argv[2] ?? 'ws://localhost:3003/ws/rooms'
const seconds = Number(process.argv[3] ?? 8)
const mode = (process.argv[4] ?? 'coop') as 'coop' | 'versus' | 'pack'
const N = 4

let failures = 0
const check = (ok: unknown, msg: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!ok) failures++
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class Bot {
  ws!: WebSocket
  token = ''
  room: any = null
  msgs: S2C[] = []
  snaps: Snapshot[] = []
  bytes = 0
  binBytes = 0
  firstSnapAt = 0
  lastSnapAt = 0
  rtts: number[] = []
  seq = 0
  events = 0
  maxAck = 0
  /** input frames sent but not yet applied, sampled at every own-tank update */
  lags: number[] = []
  start = { x: 0, z: 0, set: false }
  pos = { x: 0, z: 0 }
  stages = 0
  errors: string[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private dir = Math.random() * Math.PI * 2

  constructor(public name: string) {}

  connect(token?: string) {
    return new Promise<void>((res, rej) => {
      this.ws = new WebSocket(url)
      this.ws.binaryType = 'arraybuffer'
      this.ws.onopen = () => {
        this.send({ t: 'hello', v: PROTO_VERSION, name: this.name, token })
        res()
      }
      this.ws.onerror = (e) => rej(e)
      this.ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
          this.bytes += e.data.length
          const m = JSON.parse(e.data) as S2C
          this.msgs.push(m)
          if (m.t === 'welcome') this.token = m.token
          if (m.t === 'room') this.room = m.room
          if (m.t === 'error') this.errors.push(m.msg)
          if (m.t === 'stage') this.stages++
          if (m.t === 'pong') this.rtts.push(performance.now() - m.c)
          return
        }
        const b = new Uint8Array(e.data as ArrayBuffer)
        this.bytes += b.length
        this.binBytes += b.length
        const s = decodeSnapshot(b)
        if (!s) return this.errors.push('bad snapshot')
        if (s.evOnly) return
        const now = performance.now()
        if (!this.firstSnapAt) this.firstSnapAt = now
        this.lastSnapAt = now
        this.snaps.push(s)
        this.events += s.json?.e?.length ?? 0
        if (s.you) {
          this.maxAck = Math.max(this.maxAck, s.you.ack)
          if (s.you.ack) this.lags.push(this.seq - s.you.ack)
          this.pos = { x: s.you.x, z: s.you.z }
          if (!this.start.set) this.start = { x: s.you.x, z: s.you.z, set: true }
        }
      }
    })
  }
  send(m: C2S) {
    this.ws.send(JSON.stringify(m))
  }
  wait(pred: (b: Bot) => boolean, ms = 4000) {
    return new Promise<boolean>((res) => {
      const t0 = Date.now()
      const iv = setInterval(() => {
        if (pred(this)) {
          clearInterval(iv)
          res(true)
        } else if (Date.now() - t0 > ms) {
          clearInterval(iv)
          res(false)
        }
      }, 10)
    })
  }
  play() {
    let n = 0
    this.timer = setInterval(() => {
      n++
      if (n % 90 === 0) this.dir += (Math.random() - 0.5) * 2
      const fire = n % 47 === 0
      const mine = n % 400 === 200
      this.ws.readyState === 1 &&
        this.ws.send(encodeInput({ seq: ++this.seq, mx: Math.cos(this.dir), my: Math.sin(this.dir), analog: true, fire, mine, ax: this.pos.x + Math.cos(n / 30) * 150, az: this.pos.z + Math.sin(n / 30) * 150 }))
      if (n % 60 === 0) this.send({ t: 'ping', c: performance.now(), rtt: this.rtts.at(-1) ?? 0 })
    }, 1000 / 60)
  }
  stop() {
    if (this.timer) clearInterval(this.timer)
  }
}

console.log(`netbot: ${N} clients, ${mode}, ${seconds}s against ${url}`)
const bots = Array.from({ length: N }, (_, i) => new Bot(`bot${i + 1}`))
await bots[0].connect()
await bots[0].wait((b) => !!b.token)
bots[0].send({ t: 'create', public: false, maxPlayers: 4 })
check(await bots[0].wait((b) => !!b.room), 'host created a room')
const code = bots[0].room.code
for (const b of bots.slice(1)) {
  await b.connect()
  b.send({ t: 'join', code })
}
for (const b of bots) check(await b.wait((x) => x.room?.members.length === N), `${b.name} sees ${N} members (slot ${b.room?.you})`)
if (mode === 'versus') bots[0].send({ t: 'settings', settings: { mode: 'versus', rounds: 2, ai: 2, arena: 1 } })
if (mode === 'pack') {
  const cells = Array.from({ length: 17 }, () => new Array(22).fill(0))
  cells[8][2] = 300
  cells[8][19] = 400
  cells[4][10] = 202
  bots[0].send({ t: 'settings', settings: { mode: 'pack' }, pack: { v: 1, name: 'Bot pack', levels: [{ v: 1, name: 'One', cells, enemies: [1] }] } })
}
await sleep(200)
bots[0].send({ t: 'start' })
for (const b of bots) check(await b.wait((x) => x.room?.state === 'playing' && x.stages > 0 && x.snaps.length > 0), `${b.name} got the game, stage and snapshots`)
for (const b of bots) b.play()
const t0 = performance.now()
const bytes0 = bots.map((b) => b.bytes)
const snaps0 = bots.map((b) => b.snaps.length)
await sleep(seconds * 1000)
const dt = (performance.now() - t0) / 1000
for (const b of bots) b.stop()

console.log('results')
for (const [i, b] of bots.entries()) {
  const kbs = (b.bytes - bytes0[i]) / 1024 / dt
  const hz = (b.snaps.length - snaps0[i]) / dt
  const rtt = b.rtts.length ? b.rtts.reduce((a, x) => a + x, 0) / b.rtts.length : NaN
  const moved = Math.hypot(b.pos.x - b.start.x, b.pos.z - b.start.z)
  const lag = b.lags.length ? b.lags.reduce((a, x) => a + x, 0) / b.lags.length : NaN
  console.log(`  ${b.name}: ${kbs.toFixed(2)} KB/s down, ${hz.toFixed(1)} snapshots/s, rtt ${rtt.toFixed(1)} ms, input lag ${lag.toFixed(1)} frames (sent - acked), moved ${moved.toFixed(0)}, events ${b.events}, errors ${b.errors.join('; ') || 'none'}`)
  check(hz > 25 && hz < 35, `${b.name} snapshot rate ~30 Hz`)
  check(b.lags.length > 0 && lag < 8, `${b.name} inputs applied promptly`)
  check(b.errors.length === 0, `${b.name} no errors`)
}
const last = bots[0].snaps.at(-1)!
check(last.tanks !== undefined, 'snapshots decode')
check(bots.filter((b) => Math.hypot(b.pos.x - b.start.x, b.pos.z - b.start.z) > 5 || !b.snaps.at(-1)?.you).length === N, 'every bot moved (or was destroyed)')
check(bots[0].events > 0, 'events (sounds, shots) arrive')
const sizes = bots[0].snaps.map((s) => s).length
console.log(`  snapshot count ${sizes}; up ~${((12 + 6) * 60) / 1024} KB/s per client (12-byte inputs + ws framing)`)

// disconnect + rejoin
const b3 = bots[3]
const slot = b3.room.you
const tok = b3.token
b3.ws.close()
check(await bots[0].wait((b) => b.room?.members.some((m: any) => m.slot === slot && !m.connected)), 'room shows the dropped player as disconnected')
const again = new Bot('bot4-again')
await again.connect(tok)
check(await again.wait((b) => b.room?.you === slot && b.stages > 0 && b.snaps.length > 0), `rejoined into slot ${slot} with stage + keyframe`)
check(again.snaps[0]?.key === true, 'first snapshot after rejoin is a keyframe')
check(await bots[0].wait((b) => b.room?.members.every((m: any) => m.connected)), 'everyone connected again')

for (const b of [...bots, again]) b.ws.close()
console.log(failures ? `${failures} failure(s)` : 'all checks passed')
process.exit(failures ? 1 : 0)
