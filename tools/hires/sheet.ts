// Contact sheet for eyeballing textures: bun tools/hires/sheet.ts out.png cellPx file...
// Each image is scaled (nearest) to fit a cellPx square over a checkerboard.
import { img, readPng, writePng } from './png'

const [out, cellArg, ...files] = process.argv.slice(2)
const cell = Number(cellArg)
const cols = Math.min(files.length, Math.max(1, Math.floor(1600 / (cell + 8))))
const rows = Math.ceil(files.length / cols)
const sheet = img(cols * (cell + 8), rows * (cell + 8))
files.forEach((f, n) => {
  const s = readPng(f)
  const k = Math.min(cell / s.w, cell / s.h)
  const ox = (n % cols) * (cell + 8) + 4, oy = Math.floor(n / cols) * (cell + 8) + 4
  for (let y = 0; y < Math.floor(s.h * k); y++)
    for (let x = 0; x < Math.floor(s.w * k); x++) {
      const si = (Math.min(s.h - 1, Math.floor(y / k)) * s.w + Math.min(s.w - 1, Math.floor(x / k))) * 4
      const di = ((oy + y) * sheet.w + ox + x) * 4
      const a = s.d[si + 3]
      const bg = ((x >> 3) + (y >> 3)) & 1 ? 0.55 : 0.75
      for (let c = 0; c < 3; c++) sheet.d[di + c] = s.d[si + c] * a + bg * (1 - a)
      sheet.d[di + 3] = 1
    }
})
writePng(out, sheet)
