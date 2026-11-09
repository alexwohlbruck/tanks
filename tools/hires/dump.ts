// ASCII alpha dump of small PNGs (layout checks): bun tools/hires/dump.ts file.png...
import { readPng } from './png'

for (const f of process.argv.slice(2)) {
  const im = readPng(f)
  console.log(f, im.w, im.h)
  for (let y = 0; y < im.h; y += 2) {
    let row = ''
    for (let x = 0; x < im.w; x++) {
      const a = im.d[(y * im.w + x) * 4 + 3]
      row += a > 0.75 ? '#' : a > 0.4 ? '+' : a > 0.1 ? '.' : ' '
    }
    if (row.trim()) console.log(String(y).padStart(3), row)
  }
  let r = 0, g = 0, b = 0, a = 0, n = 0
  for (let i = 0; i < im.w * im.h; i++)
    if (im.d[i * 4 + 3] > 0.5) (r += im.d[i * 4]), (g += im.d[i * 4 + 1]), (b += im.d[i * 4 + 2]), (a += im.d[i * 4 + 3]), n++
  console.log('mean rgba of opaque', [r, g, b, a].map((v) => Math.round((v / n) * 255)))
}
