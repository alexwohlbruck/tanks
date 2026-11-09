// One browser in the arena: join, drive, fire, screenshots, errors.
//   node tools/dev/arenaplay.mjs [http://localhost:5300] [out=/tmp/arena] [mode=ffa|teams] [quality] [size=small|medium|large]
import { chromium } from 'playwright-core'
import { readdirSync } from 'fs'

const base = process.argv[2] ?? 'http://localhost:5300'
const out = process.argv[3] ?? '/tmp/arena'
const mode = process.argv[4] ?? 'ffa'
const quality = process.argv[5] ?? 'high'
const size = process.argv[6] ?? 'medium'
const home = process.env.HOME
const dir = readdirSync(`${home}/.cache/ms-playwright`).filter((d) => d.startsWith('chromium-')).sort().pop()
const W = 1280, H = 720
const browser = await chromium.launch({ executablePath: `${home}/.cache/ms-playwright/${dir}/chrome-linux64/chrome`, args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-webgpu', '--use-angle=vulkan', '--enable-features=Vulkan'] })
const errors = []
try {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => errors.push(e.message))
  p.on('console', (m) => m.type() === 'error' && !/favicon|AudioContext|Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`))
  await p.goto(`${base}/?quality=${quality}`)
  await p.waitForFunction(() => window.app && window.app.screen, null, { timeout: 60000 })
  await p.waitForTimeout(1500)
  await p.evaluate(() => window.app.show('arena'))
  await p.waitForSelector('.ar-input')
  await p.fill('.ar-input', 'Tester')
  await p.click(mode === 'teams' ? '.ar-mode:nth-child(2)' : '.ar-mode:nth-child(1)')
  await p.click(`.ar-size[data-size=${size}]`)
  await p.waitForTimeout(800)
  await p.screenshot({ path: `${out}_join.png` })
  await p.click('.ar-go')
  await p.waitForFunction(() => window.app.session.you, null, { timeout: 20000 })
  await p.waitForTimeout(1500)
  await p.screenshot({ path: `${out}_1.png` })
  const st = () => p.evaluate(() => { const s = window.app.session; const t = s.world.playerTanks[0]; return { x: Math.round(t.pos.x), z: Math.round(t.pos.z), alive: s.you.alive, tanks: s.world.tanks.length, shells: s.world.bullets.length, ammo: s.you.shells, aim: s.aim, rtt: Math.round(s.rtt), score: s.board?.players.find((q) => q[0] === s.pid) } })
  console.log('start', await st(), await p.evaluate(() => [window.app.session.size, window.app.session.map.cols, window.app.session.map.rows]))
  await p.mouse.move(W * 0.7, H * 0.4)
  await p.keyboard.down('KeyD')
  await p.waitForTimeout(900)
  console.log('after D', await st())
  await p.keyboard.up('KeyD')
  await p.keyboard.down('KeyS')
  await p.waitForTimeout(600)
  await p.keyboard.up('KeyS')
  for (let i = 0; i < 4; i++) {
    await p.mouse.move(W * (0.3 + i * 0.15), H * 0.3)
    await p.mouse.down()
    await p.waitForTimeout(60)
    await p.mouse.up()
    await p.waitForTimeout(120)
  }
  console.log('fired', await st())
  await p.keyboard.press('Digit2')
  await p.waitForTimeout(250)
  await p.screenshot({ path: `${out}_2.png` })
  await p.keyboard.press('Space')
  await p.evaluate(() => window.app.session.dev(new URLSearchParams(location.search).get('power') ?? 'teal'))
  await p.waitForTimeout(1500)
  await p.mouse.down()
  await p.waitForTimeout(60)
  await p.mouse.up()
  await p.waitForTimeout(400)
  await p.screenshot({ path: `${out}_3.png` })
  await p.keyboard.down('Tab')
  await p.waitForTimeout(600)
  await p.screenshot({ path: `${out}_tab.png` })
  await p.keyboard.up('Tab')
  console.log('end', await st())
  await p.keyboard.press('KeyV')
  await p.keyboard.down('KeyW')
  await p.waitForTimeout(1200)
  await p.keyboard.up('KeyW')
  await p.screenshot({ path: `${out}_fpv.png` })
  console.log('fpv', await st(), await p.evaluate(() => !!window.app.view.fpv))
  await p.keyboard.press('KeyV')
  await p.keyboard.press('Escape')
  await p.waitForTimeout(400)
  await p.screenshot({ path: `${out}_menu.png` })
  await p.click('.ar-menu .btn:last-child')
  await p.waitForTimeout(1500)
  console.log('left', await p.evaluate(() => [window.app.screen, window.app.session.kind]))
} finally {
  console.log("errors", errors.length, errors.slice(0, 3).map((e) => e.slice(0, 600)))
  await browser.close()
}
