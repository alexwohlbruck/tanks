// Dev page: draws Tanks layouts in a given state over the reference screenshot.
// /uitest.html?frames=120&ref=0.5&mode=hud|fade|clear|result|failed|complete|start
import { TnkLayouts, type TnkInfo } from '../ui/tnk'

const q = new URLSearchParams(location.search)
const c = document.getElementById('c') as HTMLCanvasElement
const ctx = c.getContext('2d')!
let state = Number(q.get('state') ?? 4)
const info: TnkInfo = {
  state: () => state,
  stage: () => Number(q.get('stage') ?? 7),
  lastStage: () => 19,
  modeIdx: () => (q.get('p2') ? 1 : 0),
  lives: () => 3,
  addLives: () => {},
  kills: (p) => (p ? 7 : 19),
  killsByType: (_p, i) => [3, 4, 2, 5, 1, 0, 2, 1, 1][i],
  typeOrder: (i) => [0, 1, 2, 3, 4, 6, 7, 8][i],
  typeNum: () => 8,
  winner: () => 0,
  enemyAlive: () => 5,
  setStageReady: () => {},
  startBgm: () => {},
  startStageBgm: () => {},
  se: () => {},
  playerScreen: () => ({ x: -300, y: -150 }),
  playerAngle: () => 0,
}
const ui = new TnkLayouts(info)
await ui.load()
const ref = new Image()
ref.src = '/ref-tanks.png'
await ref.decode()
const mode = q.get('mode') ?? 'hud'
if (mode === 'hud') ui.hud.playIn()
if (mode === 'fade') ui.fade.start(!!q.get('bonus'), false)
if (mode === 'clear') (state = 6), ui.clear.show()
if (mode === 'failed') (state = 9), ui.failed.show()
if (mode === 'complete') (state = 8), ui.complete.show()
if (mode === 'start') ui.start.play()
if (mode === 'result') (state = 10), ui.result.start()
if (mode === 'ex') ui.ex.show(Number(q.get('msg') ?? 0))
if (mode === 'balloon') ui.hud.showBalloons = true
const frames = Number(q.get('frames') ?? 120)
for (let i = 0; i < frames; i++) ui.calc(false)
ctx.globalAlpha = Number(q.get('ref') ?? 0.5)
ctx.drawImage(ref, 0, 0, 1920, 1080)
ctx.globalAlpha = 1
const W = c.width
const H = c.height
ctx.setTransform(W / 832, 0, 0, -H / 456, W / 2, H / 2)
ui.draw(ctx, Number(q.get('wide') ?? 608 / 832))
document.title = 'done'
