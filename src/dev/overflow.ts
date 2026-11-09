// dev: open each web screen and report panels that leave the viewport
const app = (window as unknown as { app: { show(id: string, p?: Record<string, unknown>): void } }).app
const out: string[] = []
const screens: [string, Record<string, unknown>?][] = [['menu'], ['menu', { page: 'campaign' }], ['settings'], ['credits'], ['tanksplus'], ['store'], ['lobby'], ['editor']]
for (const [id, p] of screens) {
  app.show(id, p)
  await new Promise((r) => setTimeout(r, 900))
  const bad: string[] = []
  for (const el of document.querySelectorAll<HTMLElement>('#screens .panel, #screens button, #screens .tp-levels, #screens header')) {
    const r = el.getBoundingClientRect()
    if (r.width && (r.right > innerWidth + 1 || r.left < -1 || r.bottom > innerHeight + 1)) bad.push(`${el.className.split(' ')[0]}:${Math.round(r.right)}x${Math.round(r.bottom)}`)
  }
  out.push(`${id}${p ? '/' + JSON.stringify(p) : ''}: ${bad.length ? bad.slice(0, 4).join(' ') : 'ok'}`)
}
;(window as unknown as { __of: string }).__of = out.join(' | ')
export {}
