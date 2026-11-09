// usage: node tools/dev/shot.mjs <out.png> [url] [keys...]  — screenshot the running dev server
import { chromium } from 'playwright-core'
import { readdirSync } from 'fs'
const home = process.env.HOME
const dir = readdirSync(`${home}/.cache/ms-playwright`).filter((d) => d.startsWith('chromium-')).sort().pop()
const exe = `${home}/.cache/ms-playwright/${dir}/chrome-linux64/chrome`
const [out = '/tmp/claude-1000/shot.png', url = 'http://localhost:5300/', ...steps] = process.argv.slice(2)
const browser = await chromium.launch({ executablePath: exe, args: ['--enable-unsafe-webgpu', '--use-angle=vulkan', '--enable-features=Vulkan'] })
try {
  const page = await browser.newPage({ viewport: { width: +(process.env.W ?? 1280), height: +(process.env.H ?? 720) } })
  const logs = []
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  await page.goto(url)
  await page.waitForTimeout(2500)
  for (const s of steps) {
    if (s.startsWith('wait:')) await page.waitForTimeout(+s.slice(5))
    else if (s.startsWith('eval:')) console.log(await page.evaluate(s.slice(5)))
    else await page.keyboard.press(s)
  }
  await page.screenshot({ path: out })
  console.log(logs.join('\n'))
} finally {
  await browser.close()
}
