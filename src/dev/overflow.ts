// dev: open each web screen and report panels that leave the viewport. Content inside a
// scrolling box only counts when it sticks out sideways of a box that does not scroll that way
// (it can be scrolled to otherwise); the scrolling box itself is checked like any element.
//   import('/src/dev/overflow.ts') in the console, then read window.__of
const app = (window as unknown as { app: { show(id: string, p?: Record<string, unknown>): void } }).app
const out: string[] = []
const screens: [string, Record<string, unknown>?][] = [['menu'], ['menu', { page: 'campaign' }], ['settings'], ['credits'], ['tanksplus'], ['store'], ['lobby'], ['editor'], ['arena']]

/** the nearest ancestor that scrolls along x / y, if any */
function scroller(el: HTMLElement, axis: 'x' | 'y') {
  for (let p = el.parentElement; p && p.id !== 'screens'; p = p.parentElement) {
    const s = getComputedStyle(p)
    const o = axis === 'x' ? s.overflowX : s.overflowY
    if (o === 'auto' || o === 'scroll') return p
  }
  return null
}

for (const [id, p] of screens) {
  app.show(id, p)
  await new Promise((r) => setTimeout(r, 900))
  const bad: string[] = []
  for (const el of document.querySelectorAll<HTMLElement>('#screens .panel, #screens button, #screens input, #screens .tp-levels, #screens header, #screens aside, #screens .card')) {
    const r = el.getBoundingClientRect()
    if (!r.width || el.closest('[hidden]')) continue
    const sx = scroller(el, 'x')
    const sy = scroller(el, 'y')
    const outX = r.right > innerWidth + 1 || r.left < -1
    const outY = r.bottom > innerHeight + 1 || r.top < -1
    // inside a scroller along that axis: reachable; but it must fit across the other axis
    const fitsX = sx ? true : r.right <= (sy?.getBoundingClientRect().right ?? innerWidth) + 1 && !outX
    const fitsY = sy ? true : !outY
    if (!fitsX || !fitsY) bad.push(`${el.className.split(' ')[0] || el.tagName.toLowerCase()}:${Math.round(r.right)}x${Math.round(r.bottom)}`)
  }
  out.push(`${id}${p ? '/' + JSON.stringify(p) : ''}: ${bad.length ? bad.slice(0, 5).join(' ') + (bad.length > 5 ? ` +${bad.length - 5}` : '') : 'ok'}`)
}
;(window as unknown as { __of: string }).__of = out.join(' | ')
export {}
