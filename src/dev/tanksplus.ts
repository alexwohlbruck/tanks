// Dev helper for Tanks+ screenshots / manual tests:
//   eval:import('/src/dev/tanksplus.ts').then(m => m.play(LEVEL, PLAYERS))
// starts the Tanks+ campaign at level LEVEL (1-based) and fast-forwards the intro.

import type { App } from '../app/app'
import { tanksPlus } from '../levels/packs/index'

export function play(level = 1, players = 1, skip = 240) {
  const app = (window as unknown as { app: App }).app
  app.playPack(tanksPlus, players, level - 1)
  const g = app.game
  // run the intro / start delay headless so the tanks are live when the screenshot is taken
  for (let i = 0; i < skip; i++) g.tick(() => {})
  return `${tanksPlus.levels[level - 1].name}: ${g.phase}`
}

/** advances the game n frames with idle players */
export function run(n = 60) {
  const g = (window as unknown as { app: App }).app.game
  for (let i = 0; i < n; i++) g.tick(() => {})
  return g.phase
}

/** starts a level and lets the playtest bot drive for `frames` frames (screenshots with action) */
export async function playBot(level = 1, players = 1, frames = 600) {
  const { aimBot } = await import('../../tools/levels/bot')
  play(level, players, 240)
  const g = (window as unknown as { app: App }).app.game
  const bot = aimBot(level * 7 + players)
  for (let i = 0; i < frames && g.missionIndex === level - 1; i++) g.tick(bot)
  return `${g.phase} frame ${g.world?.frame}`
}
