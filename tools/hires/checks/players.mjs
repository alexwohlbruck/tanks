// 4 players + registry hooks (type 10 tank, tile 500) + P1-P4 / enemy X marks + P3/P4 cursors:
// Q=high OUT=/tmp/p node tools/hires/shots.mjs tools/hires/checks/players.mjs
const out = process.env.OUT ?? '/tmp/claude-hires/p'
const q = process.env.Q ?? 'classic'
export const steps = [
  ['wait', 4000],
  [
    'eval',
    `(async () => {
      const THREE = await import('/node_modules/.vite/deps/three_webgpu.js')
      const reg = await import('/src/render/registry.ts')
      reg.registerTankVisual(10, { baseModel: 'e_3', livery: 0xff7a00, accent: 0x3a3a3a, scale: 1.15, emissive: 0xff3300, tread: 'e_8' })
      reg.registerTileRenderer([500, 509], (ctx) => {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(14, 14, 1, 24), new THREE.MeshBasicNodeMaterial({ color: 0x22aaff, transparent: true, opacity: 0.8 }))
        m.position.y = 0.6
        return { object: m, update: (f) => m.scale.setScalar(1 + 0.1 * Math.sin(f / 10)) }
      })
      app.playClassic(4, 0)
    })()`,
  ],
  ['wait', 9000],
  ['eval', `app.view.setQuality(${JSON.stringify(q)})`],
  ['wait', 2500],
  [
    'eval',
    `(() => {
      game.paused = true
      const w = game.world
      const e = w.tanks.find((t) => t.isEnemy)
      if (e) e.enemyType = 10
      // a few special tiles and X marks of every colour
      const free = []
      for (let r = 2; r < w.height - 2 && free.length < 12; r++) for (let c = 2; c < w.width - 2 && free.length < 12; c++) if (!w.grid[r][c].code) free.push([c, r])
      for (const [c, r] of free.slice(0, 3)) w.grid[r][c].code = 500
      app.view.rebuildBlocks()
      free.slice(3, 8).forEach(([c, r], i) => w.marks.spawn(w.cellCenter(c, r), [0, 1, 2, 3, 9][i]))
      w.checkMarks = w.marks.items.filter((m) => m.active)
      ;[0, 1, 2, 3].forEach((p) => app.view.updateCursor(p, { x: -300 + p * 180, y: -150, mode: 1, visible: true }, null))
      for (let i = 0; i < 30; i++) app.view.stepCursorFx()
    })()`,
  ],
  ['wait', 600],
  ['log', `game.world.tanks.map((t) => [t.isEnemy ? 'E' + t.type : 'P' + t.team, Math.round(t.pos.x), Math.round(t.pos.z)])`],
  ['shot', `${out}_${q}.png`],
]
