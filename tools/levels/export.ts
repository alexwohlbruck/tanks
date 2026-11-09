// Writes the Tanks+ campaign (authored as ASCII maps in src/levels/packs/tanksplus/world*.ts)
// as LevelPack JSON: src/levels/packs/tanksplus.json (for the level editor / store / server).
//
//   bun tools/levels/export.ts          # write
//   bun tools/levels/export.ts --check  # exit 1 when the JSON is out of date

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { tanksPlus } from '../../src/levels/packs/index'

const out = new URL('../../src/levels/packs/tanksplus.json', import.meta.url).pathname
// one row of cells per line keeps the file diffable
const json = JSON.stringify(tanksPlus, null, 1).replace(/\[\n\s+((?:-?\d+,\n\s+)*-?\d+)\n\s+\]/g, (_, nums: string) => `[${nums.replace(/,\n\s+/g, ',')}]`)
if (process.argv.includes('--check')) {
  const ok = existsSync(out) && readFileSync(out, 'utf8') === json + '\n'
  console.log(ok ? 'tanksplus.json is up to date' : 'tanksplus.json is OUT OF DATE: run bun tools/levels/export.ts')
  process.exit(ok ? 0 : 1)
}
writeFileSync(out, json + '\n')
console.log(`wrote ${tanksPlus.levels.length} levels to ${out}`)
