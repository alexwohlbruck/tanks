// Every map theme over many seeds: enough open floor and spawn cells, and every open cell
// reachable. bun tools/arena/themes.ts
import { generateMap } from '../../src/arena/map'
import { MAP_THEMES } from '../../src/arena/rules'

let fails = 0
for (const theme of MAP_THEMES)
  for (const mode of ['ffa', 'teams'] as const) {
    let open = 0
    let minSpawn = 1e9
    let cork = 0
    let holes = 0
    for (let seed = 1; seed <= 40; seed++) {
      const m = generateMap(seed * 7919, mode, theme)
      open += m.open.length
      for (const s of m.spawns) minSpawn = Math.min(minSpawn, s.length)
      for (const row of m.cells) for (const c of row) (c >= 100 && c < 200 ? cork++ : c === 200 ? holes++ : 0)
    }
    const ok = minSpawn >= 40 && open / 40 > 1500
    if (!ok) fails++
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${theme.padEnd(5)} ${mode.padEnd(5)} open ${(open / 40) | 0}  min spawns ${minSpawn}  cork ${(cork / 40) | 0}  holes ${(holes / 40) | 0}`)
  }
process.exit(fails ? 1 : 0)
