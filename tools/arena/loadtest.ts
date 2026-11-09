// N websocket clients in the arena sending random inputs at 60 Hz; reports bytes and snapshots
// per client. bun tools/arena/loadtest.ts [n=20] [seconds=20] [url]
const n = Number(process.argv[2] ?? 20)
const secs = Number(process.argv[3] ?? 20)
const url = process.argv[4] ?? 'ws://localhost:3001/ws/arena'
let bytes = 0
let snaps = 0
for (let i = 0; i < n; i++) {
  const ws = new WebSocket(url)
  let seq = 0
  let mx = 0
  let mz = 0
  ws.onopen = () => {
    ws.send(JSON.stringify({ t: 'join', v: 1, name: `Load${i}`, mode: 'ffa' }))
    setInterval(() => {
      if (Math.random() < 0.02) (mx = Math.random() * 2 - 1), (mz = Math.random() * 2 - 1)
      ws.send(JSON.stringify({ t: 'i', s: ++seq, mx, mz, an: 0, ax: Math.random() * 2000 - 1000, az: Math.random() * 1400 - 700, f: Math.random() < 0.02 ? 1 : 0, m: 0 }))
    }, 1000 / 60)
  }
  ws.onmessage = (e) => {
    bytes += String(e.data).length
    if (String(e.data).startsWith('{"t":"s"')) snaps++
  }
}
await new Promise((r) => setTimeout(r, secs * 1000))
console.log(`${n} clients ${secs}s: ${(bytes / n / secs / 1024).toFixed(1)} KB/s per client, ${(snaps / n / secs).toFixed(1)} snapshots/s per client`)
console.log(JSON.stringify(await fetch(url.replace('ws', 'http').replace('/ws/arena', '/api/arena')).then((x) => x.json())))
process.exit(0)
