// Mission 8 in classic / high / ultra, same moment (game paused), plus draw stats:
// OUT=/tmp/q node tools/hires/shots.mjs tools/hires/checks/qualities.mjs
const out = process.env.OUT ?? '/tmp/claude-hires/q'
const stats = `(() => { const s = app.view.stats; return { q: app.view.getQuality(), calls: s.calls, tris: s.triangles, dpr: app.view.renderer.getPixelRatio() } })()`
const qs = (process.env.QS ?? 'classic,high,ultra').split(',')
export const steps = [
  ['wait', +(process.env.WAIT ?? 11500)],
  ['eval', 'game.paused = true'],
  ...qs.flatMap((q) => [
    ['eval', `app.view.setQuality(${JSON.stringify(q)})`],
    ['wait', 3000],
    ['log', stats],
    ['shot', `${out}_${q}.png`],
  ]),
]
