// Close-ups of a player tank, an enemy, the border and a block cluster (Mission 8):
// OUT=/tmp/x Q=high node tools/hires/shots.mjs tools/hires/checks/zoom.mjs
const zoom = `window.__zoom = (x, z, k) => { const c = app.view.camera; c.zoom = k; c.position.set(x, 1338.26, 1472.29 + z); c.updateProjectionMatrix() }`
const out = process.env.OUT ?? '/tmp/claude-hires/z'
const q = process.env.Q
export const steps = [
  ['wait', 7000],
  ...(q ? [['eval', `app.view.setQuality(${JSON.stringify(q)})`], ['wait', 2500]] : []),
  ['eval', zoom],
  ['eval', 'game.paused = true'],
  ['eval', `(() => { const t = game.world.tanks.find((t) => !t.isEnemy); __zoom(t.pos.x + 20, t.pos.z, 6) })()`],
  ['wait', 400],
  ['shot', out + '_tank.png'],
  ['eval', `(() => { const t = game.world.tanks.find((t) => t.isEnemy && t.alive); __zoom(t.pos.x, t.pos.z, 6) })()`],
  ['wait', 400],
  ['shot', out + '_enemy.png'],
  ['eval', '__zoom(-500, -40, 3)'],
  ['wait', 400],
  ['shot', out + '_border.png'],
  ['eval', '__zoom(-150, -150, 3)'],
  ['wait', 400],
  ['shot', out + '_blocks.png'],
]
