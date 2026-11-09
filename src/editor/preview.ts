// Live 3D preview: the level loaded into a standalone World (never ticked) and handed to the
// game's SceneView, so the real renderer shows it exactly as it will play. The game's own
// World is untouched; the next game start gives the view back its world (Game.listener).

import type { AppContext } from '../app/types'
import type { LevelDef } from '../levels/format'
import { paramsFor } from '../sim/stats'
import { World } from '../sim/world'
import { isPlayer } from './catalog'

const known = (t: number) => {
  try {
    paramsFor(t)
    return true
  } catch {
    return false
  }
}

export function previewWorld(level: LevelDef): World {
  const flat = level.cells.flat()
  const players = Math.max(1, ...flat.filter(isPlayer).map((c) => c - 299))
  const w = new World(players, { aspect: '16_9', enemyCap: 12 })
  // random slots show their lowest type; types this build lacks show as Brown
  const slots = level.enemies.map((e) => {
    const t = Array.isArray(e) ? e[0] : e || 0
    return t && !known(t) ? 1 : t
  })
  w.loadStage({ width: level.cells[0].length, height: level.cells.length, facing: level.facing ?? [0, 0], cells: level.cells }, slots, { swap: false, rules: level.rules })
  return w
}

export class Preview {
  private timer = 0
  private lastKey = ''

  constructor(private app: AppContext) {}

  /** rebuild soon (debounced while painting) */
  update(level: LevelDef, now = false) {
    clearTimeout(this.timer)
    const run = () => {
      const key = JSON.stringify([level.cells, level.enemies, level.facing])
      if (key === this.lastKey) return
      this.lastKey = key
      try {
        this.app.view.setWorld(previewWorld(level))
      } catch (e) {
        console.warn('editor preview:', e)
      }
    }
    if (now) run()
    else this.timer = window.setTimeout(run, 60)
  }

  invalidate() {
    this.lastKey = ''
  }

  dispose() {
    clearTimeout(this.timer)
  }
}
