// Render checks for the hi-res / quality work: node tools/hires/shots.mjs <steps.js> [url]
// <steps.js> exports `steps` (array of [kind, arg]): ['wait', ms], ['eval', js-string-or-fn],
// ['shot', path], ['log', js] (prints the result). Env W / H set the viewport, DPR the device
// pixel ratio. One headless browser at a time on the dev box (the launch waits on a lock).
import { chromium } from 'playwright-core'
import { readdirSync } from 'fs'
import { pathToFileURL } from 'url'
import { resolve } from 'path'

const home = process.env.HOME
const dir = readdirSync(`${home}/.cache/ms-playwright`).filter((d) => d.startsWith('chromium-')).sort().pop()
const [stepsFile, url = 'http://localhost:5302/?webgl&mission=8'] = process.argv.slice(2)
const { steps } = await import(pathToFileURL(resolve(stepsFile)).href)
const W = +(process.env.W ?? 1920), H = +(process.env.H ?? 1080), DPR = +(process.env.DPR ?? 1)
const browser = await chromium.launch({
  executablePath: `${home}/.cache/ms-playwright/${dir}/chrome-linux64/chrome`,
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.log(`[${m.type()}]`, m.text().slice(0, 300)))
  await page.goto(url)
  for (const [k, v] of steps) {
    if (k === 'wait') await page.waitForTimeout(v)
    else if (k === 'eval') await page.evaluate(v)
    else if (k === 'log') console.log(JSON.stringify(await page.evaluate(v)))
    else if (k === 'shot') await page.screenshot({ path: v })
  }
} finally {
  await browser.close()
}
