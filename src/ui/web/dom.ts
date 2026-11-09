// Tiny DOM builder for the web screens.

type Child = Node | string | number | null | undefined | false
type Props = Record<string, unknown> & { class?: string; style?: string }

/** h('button.btn.primary', { onclick }, 'Play') */
export function h<K extends keyof HTMLElementTagNameMap>(sel: K | `${K}.${string}` | `${K}#${string}`, props: Props | null = null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const [tagId, ...classes] = sel.split('.')
  const [tag, id] = tagId.split('#')
  const el = document.createElement(tag as K)
  if (id) el.id = id
  if (classes.length) el.className = classes.join(' ')
  if (props)
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue
      if (k === 'class') el.className = (el.className ? el.className + ' ' : '') + v
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener)
      else if (k === 'style') el.setAttribute('style', String(v))
      else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v
      else el.setAttribute(k, v === true ? '' : String(v))
    }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c))
  return el
}

/** an SVG fragment from markup */
export function svg(markup: string): SVGSVGElement {
  const t = document.createElement('template')
  t.innerHTML = markup.trim()
  return t.content.firstElementChild as SVGSVGElement
}

/** a touch-first device (no hover, coarse pointer) */
export const touch = () => matchMedia('(hover: none) and (pointer: coarse)').matches
