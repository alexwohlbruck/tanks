// Phone screenshots: emulates a touch phone (portrait 390x844 and/or landscape 844x390) and runs
// steps, saving a screenshot after each `shot:` step.
//   node tools/dev/mobile.mjs <url> <out-prefix> [steps...]
// steps: wait:<ms> | eval:<js> | shot:<name> | tap:<x>,<y> | drag:<x0>,<y0>,<x1>,<y1>[,<ms>]
//        | touch:<id>,<x>,<y>,<down|move|up>  (raw multi-touch via CDP) | key:<code>
// env: ORIENT=portrait|landscape|both (both), DSF (2)
import { chromium } from 'playwright-core'
import { readdirSync } from 'fs'

const [url = 'http://localhost:5311/?webgl', out = '/tmp/mobile', ...steps] = process.argv.slice(2)
const home = process.env.HOME
const dir = readdirSync(`${home}/.cache/ms-playwright`).filter((d) => d.startsWith('chromium-')).sort().pop()
const orient = process.env.ORIENT ?? 'both'
const sizes = { portrait: { width: 390, height: 844 }, landscape: { width: 844, height: 390 } }
const browser = await chromium.launch({ executablePath: `${home}/.cache/ms-playwright/${dir}/chrome-linux64/chrome`, args: ['--autoplay-policy=no-user-gesture-required'] })
try {
  for (const o of orient === 'both' ? ['portrait', 'landscape'] : [orient]) {
    const ctx = await browser.newContext({ viewport: sizes[o], isMobile: true, hasTouch: true, deviceScaleFactor: +(process.env.DSF ?? 2) })
    const p = await ctx.newPage()
    p.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`))
    p.on('console', (m) => m.type() === 'error' && !/favicon|AudioContext|Failed to load/.test(m.text()) && console.log(`[console] ${m.text()}`))
    const cdp = await ctx.newCDPSession(p)
    const touches = new Map()
    await p.goto(url)
    await p.waitForFunction(() => window.app && window.app.screen !== undefined, null, { timeout: 60000 })
    await p.waitForTimeout(1500)
    for (const s of steps) {
      const [k, ...rest] = s.split(':')
      const a = rest.join(':')
      if (k === 'wait') await p.waitForTimeout(+a)
      else if (k === 'eval') console.log(o, a.slice(0, 40), '->', JSON.stringify(await p.evaluate(a)))
      else if (k === 'shot') await p.screenshot({ path: `${out}_${o}_${a}.png` })
      else if (k === 'tap') {
        const [x, y] = a.split(',').map(Number)
        await p.touchscreen.tap(x, y)
      } else if (k === 'key') await p.keyboard.press(a)
      else if (k === 'touch') {
        const [id, x, y, ph] = a.split(',')
        if (ph === 'up') touches.delete(id)
        else touches.set(id, { x: +x, y: +y, id: +id })
        const type = ph === 'down' ? 'touchStart' : ph === 'up' ? 'touchEnd' : 'touchMove'
        await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [...touches.values()] })
      } else if (k === 'drag') {
        const [x0, y0, x1, y1, ms = 300] = a.split(',').map(Number)
        const pts = (x, y) => [{ x, y, id: 9 }]
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(x0, y0) })
        for (let i = 1; i <= 10; i++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10) })
          await p.waitForTimeout(ms / 10)
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      }
    }
    await ctx.close()
  }
} finally {
  await browser.close()
}
