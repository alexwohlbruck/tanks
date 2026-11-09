// Invite links: A plays Teams and shares its link, B opens it and lands in A's arena, on A's team.
//   node tools/dev/arenainvite.mjs [http://localhost:5300]
import { chromium } from 'playwright-core'
import { readdirSync } from 'fs'

const base = process.argv[2] ?? 'http://localhost:5300'
const home = process.env.HOME
const dir = readdirSync(`${home}/.cache/ms-playwright`).filter((d) => d.startsWith('chromium-')).sort().pop()
const browser = await chromium.launch({ executablePath: `${home}/.cache/ms-playwright/${dir}/chrome-linux64/chrome`, args: ['--autoplay-policy=no-user-gesture-required'] })
let fails = 0
const errors = []
try {
  const page = async (name) => {
    const p = await (await browser.newContext({ viewport: { width: 960, height: 540 } })).newPage()
    p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`))
    return p
  }
  const a = await page('A')
  await a.goto(`${base}/?webgl`)
  await a.waitForFunction(() => window.app && window.app.screen, null, { timeout: 60000 })
  await a.evaluate(() => window.app.show('arena'))
  await a.fill('.ar-input', 'Alice')
  await a.click('.ar-mode:nth-child(2)')
  await a.click('.ar-go')
  await a.waitForFunction(() => window.app.session.inviteLink, null, { timeout: 20000 })
  const link = await a.evaluate(() => window.app.session.inviteLink)
  console.log('link', link)
  const b = await page('B')
  await b.goto(link.replace(/^https?:\/\/[^/]+/, base).replace('?', '?webgl&'))
  await b.waitForSelector('.ar-invited', { timeout: 60000 })
  await b.fill('.ar-input', 'Bob')
  await b.screenshot({ path: '/tmp/invite_join.png' })
  await b.click('.ar-go')
  await b.waitForFunction(() => window.app.session.board, null, { timeout: 20000 })
  await b.waitForTimeout(800)
  const sa = await a.evaluate(() => { const s = window.app.session; return { arena: s.board.arena, team: s.board.players.find((p) => p[0] === s.pid)[2] } })
  const sb = await b.evaluate(() => { const s = window.app.session; return { arena: s.board.arena, team: s.board.players.find((p) => p[0] === s.pid)[2], mode: s.mode } })
  const ok = sa.arena === sb.arena && sa.team === sb.team && sb.mode === 'teams'
  if (!ok) fails++
  console.log(ok ? 'ok  ' : 'FAIL', 'A', sa, 'B', sb)
} finally {
  console.log('errors', errors.length, errors.slice(0, 3))
  await browser.close()
}
process.exit(fails ? 1 : 0)
