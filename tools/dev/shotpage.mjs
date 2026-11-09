// usage: node tools/dev/shotpage.mjs <out.png> <url> [w] [h]
import { chromium } from 'playwright-core'
import { readdirSync } from 'fs'
const home = process.env.HOME
const dir = readdirSync(`${home}/.cache/ms-playwright`).filter((d) => d.startsWith('chromium-')).sort().pop()
const [out, url, w = 1920, h = 1080] = process.argv.slice(2)
const browser = await chromium.launch({ executablePath: `${home}/.cache/ms-playwright/${dir}/chrome-linux64/chrome` })
try {
  const page = await browser.newPage({ viewport: { width: +w, height: +h } })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  page.on('console', (m) => m.type() === 'error' && console.log('[console]', m.text()))
  await page.goto(url)
  await page.waitForFunction(() => document.title === 'done', null, { timeout: 60000 }).catch(() => console.log('timeout'))
  await page.screenshot({ path: out })
} finally {
  await browser.close()
}
