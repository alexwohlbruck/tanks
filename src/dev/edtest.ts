// dev: editor test-play round trip (clear, rebuild a tiny level, test play, win, back to editor)
const w = window as unknown as { app: { show(id: string): void; screen: string | null; game: { state: number; debugKillAll(): void } }; __ed: string[] }
w.__ed = []
const log = (s: string) => w.__ed.push(`${Math.round(performance.now())} ${s}`)
const click = (sel: string, text?: string) => {
  const els = [...document.querySelectorAll<HTMLElement>(sel)].filter((e) => !text || e.textContent?.includes(text))
  els[0]?.click()
  return !!els[0]
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
;(async () => {
  w.app.show('editor')
  await sleep(1500)
  log('clear ' + click('button', 'Clear'))
  await sleep(300)
  log('cells after clear: ' + document.querySelectorAll('.ed-count').length)
  click('button', 'Undo') || click('button[title^="Undo"]')
  await sleep(300)
  log('test ' + click('button', 'Test play'))
  await sleep(500)
  const btns = [...document.querySelectorAll<HTMLElement>('button')].map((b) => b.textContent?.trim()).filter(Boolean)
  log('buttons: ' + btns.slice(-8).join('|'))
  log('this level ' + (click('button', 'This level') || click('button', 'Play this level') || click('button', 'level')))
  await sleep(6000)
  log('screen=' + w.app.screen + ' state=' + w.app.game.state)
  w.app.game.debugKillAll()
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    if (w.app.screen === 'editor') break
  }
  log('after win: screen=' + w.app.screen + ' state=' + w.app.game.state)
})()
export {}
