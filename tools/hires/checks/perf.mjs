// Per-quality render cost on Mission 8 (headless = SwiftShader software GL: compare the
// qualities with each other, not with a phone): node tools/hires/shots.mjs tools/hires/checks/perf.mjs
// cpuMs = sync() + render() submission time; frameMs = real rAF interval of the running game
// (CPU + software rasterisation); calls / triangles = one frame (scene + cursor overlay).
const measure = (q) => `(async () => {
  await app.view.setQuality(${JSON.stringify(q)})
  const v = app.view, info = v.renderer.info
  await new Promise((r) => setTimeout(r, 2500))
  info.autoReset = false
  info.reset(); v.sync(); v.render()
  const calls = info.render.drawCalls, triangles = info.render.triangles
  info.autoReset = true
  let t0 = performance.now()
  for (let i = 0; i < 60; i++) { v.sync(); v.render() }
  const cpuMs = (performance.now() - t0) / 60
  const frames = []
  let last = performance.now()
  await new Promise((done) => { const f = (now) => { frames.push(now - last); last = now; frames.length < 90 ? requestAnimationFrame(f) : done() }; requestAnimationFrame(f) })
  frames.sort((a, b) => a - b)
  return { q: ${JSON.stringify(q)}, calls, triangles, cpuMs: +cpuMs.toFixed(2), frameMsMedian: +frames[45].toFixed(1), dpr: v.renderer.getPixelRatio(), textures: info.memory.textures }
})()`
export const steps = [['wait', 11500], ['log', measure('classic')], ['log', measure('high')], ['log', measure('ultra')]]
