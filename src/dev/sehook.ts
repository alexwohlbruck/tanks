// dev: count sound/music calls (import from the console or play.mjs: eval:import('/src/dev/sehook.ts'))
const w = window as unknown as { game: { audio: Record<string, (...a: unknown[]) => void> }; __se: Record<string, number> }
w.__se = {}
const a = w.game.audio
for (const k of ['se', 'seHold', 'bgm', 'bgmStop', 'bgmTrackMask']) {
  const f = a[k]
  a[k] = (...args: unknown[]) => {
    const key = k === 'bgmTrackMask' ? `mask:${(args[0] as number).toString(16)}` : `${k}:${args[0]}`
    w.__se[key] = (w.__se[key] ?? 0) + 1
    f(...args)
  }
}
export {}
