// scripted play: node tools/dev/play.mjs <out.png> <url> <script>
// script: comma list of  wait:ms | down:Key | up:Key | press:Key | mouse:x,y (0..1) | click | eval:js
import { chromium } from 'playwright-core'
import { readdirSync } from 'fs'
const home = process.env.HOME
const dir = readdirSync(`${home}/.cache/ms-playwright`).filter((d) => d.startsWith('chromium-')).sort().pop()
const [out, url, script = ''] = process.argv.slice(2)
const W = +(process.env.W ?? 1280), H = +(process.env.H ?? 720)
const browser = await chromium.launch({ executablePath: `${home}/.cache/ms-playwright/${dir}/chrome-linux64/chrome` })
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await page.goto(url)
  await page.waitForTimeout(2500)
  for (const s of script.split(';').filter(Boolean)) {
    const [k, v] = [s.slice(0, s.indexOf(':') < 0 ? s.length : s.indexOf(':')), s.slice(s.indexOf(':') + 1)]
    if (k === 'wait') await page.waitForTimeout(+v)
    else if (k === 'down') await page.keyboard.down(v)
    else if (k === 'up') await page.keyboard.up(v)
    else if (k === 'press') await page.keyboard.press(v)
    else if (k === 'mouse') { const [x, y] = v.split(',').map(Number); await page.mouse.move(x * W, y * H) }
    else if (k === 'click') await page.mouse.click(...(v ? v.split(',').map((n, i) => +n * (i ? H : W)) : [W / 2, H / 2]))
    else if (k === 'eval') console.log(await page.evaluate(v))
    else if (k === 'shot') await page.screenshot({ path: v })
  }
  await page.screenshot({ path: out })
} finally {
  await browser.close()
}
