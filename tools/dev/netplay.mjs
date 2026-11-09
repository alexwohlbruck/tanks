// Two real browsers in one online co-op game (one Chromium, two contexts = two players).
//   node tools/dev/netplay.mjs [http://localhost:5303] [outPrefix=/tmp/netplay] [mode=coop|versus]
// Page A opens the lobby and creates a private room, page B joins through the ?join= link,
// A starts; both drive and fire. Checks both mirrors agree (same tanks, P1 where A put it),
// the local tank is predicted (moves at once), ping / KB/s readouts, then B leaves.
import { chromium } from 'playwright-core'
import { readdirSync } from 'fs'

const base = process.argv[2] ?? 'http://localhost:5303'
const out = process.argv[3] ?? '/tmp/netplay'
const mode = process.argv[4] ?? 'coop'
const home = process.env.HOME
const dir = readdirSync(`${home}/.cache/ms-playwright`).filter((d) => d.startsWith('chromium-')).sort().pop()
const W = 960, H = 540
let failures = 0
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!ok) failures++
}
const browser = await chromium.launch({ executablePath: `${home}/.cache/ms-playwright/${dir}/chrome-linux64/chrome`, args: ['--autoplay-policy=no-user-gesture-required'] })
const errors = []
async function page(name) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`))
  p.on('console', (m) => m.type() === 'error' && !/favicon|AudioContext|Failed to load resource/.test(m.text()) && errors.push(`${name} console: ${m.text()}`))
  p.on('response', (r) => r.status() >= 400 && !/favicon/.test(r.url()) && errors.push(`${name} ${r.status()} ${r.url()}`))
  return p
}
const state = (p) =>
  p.evaluate(() => {
    const g = window.app.game
    const w = g.world
    const s = window.app.session
    return {
      kind: s.kind,
      screen: window.app.screen,
      state: g.state,
      players: g.players,
      me: s.me,
      tanks: w ? w.tanks.map((t) => ({ e: t.isEnemy, i: t.index, x: Math.round(t.pos.x), z: Math.round(t.pos.z), alive: t.alive })) : [],
      stats: s.stats,
    }
  })
try {
  const a = await page('A')
  const b = await page('B')
  await a.goto(`${base}/?online`)
  await a.waitForSelector('.net-lobby [data-act="create"]', { timeout: 30000 })
  await a.fill('[data-f="name"]', 'Alice')
  await a.click('[data-act="create"]')
  await a.waitForSelector('.nl-bigcode')
  await a.waitForFunction(() => document.querySelector('.nl-bigcode')?.textContent?.length >= 5)
  const code = await a.textContent('.nl-bigcode')
  check(/^[A-Z0-9]{5}$/.test(code), `room created (${code})`)
  if (mode === 'versus') {
    await a.click('.nl-seg.modes [data-v="versus"]')
    await a.waitForTimeout(300)
  }
  await b.goto(`${base}/?join=${code}`)
  await b.waitForFunction(() => document.querySelectorAll('.nl-player:not(.empty)').length === 2, null, { timeout: 30000 })
  check(true, 'B joined through the link')
  await a.waitForFunction(() => document.querySelectorAll('.nl-player:not(.empty)').length === 2)
  await a.screenshot({ path: `${out}-lobby.png` })
  await a.click('[data-act="start"]')
  for (const [n, p] of [['A', a], ['B', b]]) {
    await p.waitForFunction(() => window.app.screen === 'net-hud' && window.app.game.world, null, { timeout: 15000 })
    check(true, `${n} is in the game`)
  }
  // wait for the play state (intro fade + start delay, ~6.5 s; versus: 2.5 s)
  await a.waitForFunction(() => window.app.game.state === 4, null, { timeout: 20000 })
  await b.waitForFunction(() => window.app.game.state === 4, null, { timeout: 20000 })
  const s0 = await state(a)
  check(s0.me === 0 && s0.players === 2, `A is player 1 of 2 (me ${s0.me}, players ${s0.players})`)
  const p0 = s0.tanks.find((t) => !t.e && t.i === 0)
  // A drives right (prediction: moves within a few frames), B drives down; both fire
  await a.mouse.move(W * 0.8, H * 0.5)
  await b.mouse.move(W * 0.05, H * 0.95)
  await a.keyboard.down('KeyD')
  await b.keyboard.down('KeyS')
  await a.waitForTimeout(150)
  const early = (await state(a)).tanks.find((t) => !t.e && t.i === 0)
  check(early && p0 && Math.abs(early.x - p0.x) > 1, `A's tank moves immediately (prediction: ${p0?.x} -> ${early?.x} after 150 ms)`)
  for (let i = 0; i < 4; i++) {
    await a.mouse.click(W * 0.8, H * (0.3 + i * 0.1))
    await b.mouse.click(W * 0.05, H * 0.95)
    await a.waitForTimeout(300)
  }
  await a.keyboard.up('KeyD')
  await b.keyboard.up('KeyS')
  // let the interpolation buffer and the inputs in flight settle
  await a.waitForTimeout(2500)
  const fps = await a.evaluate(() => new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => (++n, performance.now() - t0 < 1000 ? requestAnimationFrame(f) : r(n)); requestAnimationFrame(f) }))
  console.log(`  page A renders at ${fps} fps (two headless pages share this machine)`)
  const sa = await state(a)
  const sb = await state(b)
  await a.screenshot({ path: `${out}-a.png` })
  await b.screenshot({ path: `${out}-b.png` })
  const ta = sa.tanks.find((t) => !t.e && t.i === 0)
  const tb = sb.tanks.find((t) => !t.e && t.i === 0)
  console.log('  A:', JSON.stringify(sa.tanks), JSON.stringify(sa.stats))
  console.log('  B:', JSON.stringify(sb.tanks), JSON.stringify(sb.stats))
  check(ta && p0 && ta.x - p0.x > 20, `A's tank drove right on A (${p0?.x} -> ${ta?.x})`)
  check(ta && tb && Math.hypot(ta.x - tb.x, ta.z - tb.z) < 12, `both pages agree where P1 is (A ${ta?.x},${ta?.z} / B ${tb?.x},${tb?.z})`)
  const b1a = sa.tanks.find((t) => !t.e && t.i === 1)
  const b1b = sb.tanks.find((t) => !t.e && t.i === 1)
  check(b1a && b1b && Math.hypot(b1a.x - b1b.x, b1a.z - b1b.z) < 12, `both pages agree where P2 is`)
  check(sa.tanks.filter((t) => t.e).length === sb.tanks.filter((t) => t.e).length, 'same enemy count on both pages')
  check(sa.stats.snapshotHz > 20 && sa.stats.kbIn > 0.3, `A receives ${sa.stats.snapshotHz.toFixed(1)} snapshots/s, ${sa.stats.kbIn.toFixed(2)} KB/s, rtt ${sa.stats.rtt.toFixed(1)} ms, buffer ${sa.stats.delayMs.toFixed(0)} ms, prediction error ${sa.stats.predError.toFixed(2)}`)
  const ping = await a.textContent('.nh-ping')
  check(/\d+ ms/.test(ping ?? ''), `ping shown in the HUD (${ping})`)
  // B leaves through the Esc menu
  await b.keyboard.press('Escape')
  await b.waitForSelector('.nh-menu:not([hidden])')
  await b.click('[data-act="leave"]')
  await b.waitForFunction(() => window.app.screen === 'lobby' && window.app.session.kind === 'local', null, { timeout: 5000 })
  check(true, 'B left back to the lobby')
  await a.waitForFunction(() => document.querySelectorAll('.nh-chip').length === 1, null, { timeout: 5000 })
  check(true, 'A sees B gone')
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''}`)
} catch (e) {
  console.log('  FAIL', e.message)
  failures++
} finally {
  await browser.close()
}
console.log(failures ? `${failures} failure(s)` : 'all checks passed')
process.exit(failures ? 1 : 0)
