// dev: play Tanks+ level N and sample shells per owner type every 0.5 s
import { tanksPlus } from '../levels/packs'
const w = window as unknown as { app: { playPack(p: unknown, n: number, l: number): void; game: { world: { bullets: { shooterType: number; owner?: { type: number } | null }[]; enemyTanks: { active: boolean; type: number; lives: number; state: number }[] } | null; options: { infiniteLives: boolean } } }; __boss: string[] }
w.__boss = []
w.app.game.options.infiniteLives = true
w.app.playPack(tanksPlus, 1, Number(new URLSearchParams(location.search).get('lvl') ?? 9))
setInterval(() => {
  const wo = w.app.game.world
  if (!wo) return
  const counts: Record<number, number> = {}
  for (const b of wo.bullets) counts[b.owner?.type ?? -1] = (counts[b.owner?.type ?? -1] ?? 0) + 1
  w.__boss.push(JSON.stringify(counts) + ' boss:' + JSON.stringify(wo.enemyTanks.filter((t) => t.active && t.type >= 20).map((t) => [t.lives, t.state])))
}, 500)
export {}
