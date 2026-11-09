// dev: log music calls with frame numbers
const w = window as unknown as { game: { audio: Record<string, (...a: unknown[]) => void>; stepCount: number; state: number }; __log: string[] }
w.__log = []
const a = w.game.audio
for (const k of ['bgm', 'bgmStop', 'bgmTrackMask']) {
  const f = a[k]
  a[k] = (...args: unknown[]) => {
    w.__log.push(`${Math.round(performance.now() / 100) / 10}s st${w.game.state} ${k}:${typeof args[0] === 'number' ? (args[0] as number).toString(16) : args[0]}`)
    f(...args)
  }
}
export {}
