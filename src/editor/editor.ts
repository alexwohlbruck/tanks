// Level editor screen ('editor'): a 2D grid editor with the real 3D renderer as live preview,
// multi-level packs, drafts in localStorage, JSON import/export, disc map import, test play and
// publishing to the store.
//
// Params: { draft?: string } open a draft, { pack?: LevelPack } start a new draft from a pack.

import type { AppContext, Screen } from '../app/types'
import { checkLevel, checkPack, normalizePack } from '../levels/check'
import { emptyLevel, LEVEL_H, LEVEL_W, MAX_ENEMY_SLOTS, type EnemySlot, type LevelDef, type LevelPack } from '../levels/format'
import { ApiError, authorName, setAuthorName, StoreApi } from '../store/api'
import { blockCode, blockHeight, describeCell, isCork, isEnemy, isHole, isPlayer, isTile, isWood, tankType, tankTypes, tileTypes, type Material } from './catalog'
import { discLevel, discMaps } from './classic'
import { drawCell, drawLevel, drawTank, thumbnail } from './draw'
import * as M from './model'
import { Preview } from './preview'
import { currentDraft, deleteDraft, listDrafts, loadDraft, newDraft, saveDraft, setCurrentDraft, type Draft } from './storage'
import { clear, download, fileName, h, isolateKeys, isTyping, modal, pickFile, playAndReturn, relTime, toast } from './ui'

type Tool = 'brush' | 'line' | 'rect' | 'fill' | 'erase' | 'select'

const TOOLS: { id: Tool; label: string; key: string; icon: string; hint: string }[] = [
  { id: 'brush', label: 'Brush', key: 'B', icon: '✎', hint: 'Paint cells. Right-click erases, Alt-click picks a cell.' },
  { id: 'line', label: 'Line', key: 'L', icon: '╱', hint: 'Drag a straight line of blocks.' },
  { id: 'rect', label: 'Box', key: 'R', icon: '▭', hint: 'Drag a filled box (or an outline).' },
  { id: 'fill', label: 'Fill', key: 'F', icon: '◍', hint: 'Fill the connected area of the same cell.' },
  { id: 'erase', label: 'Eraser', key: 'E', icon: '⌫', hint: 'Clear cells, spawns included.' },
  { id: 'select', label: 'Select', key: 'S', icon: '⬚', hint: 'Drag to select. Ctrl+C / Ctrl+X / Del, Ctrl+V to paste.' },
]

const FACINGS = ['0°', '180°', '90°', '270°']

const slotType = (e: EnemySlot | undefined) => (Array.isArray(e) ? e[0] : e || 0)

class Editor implements Screen {
  readonly modal = true
  readonly opaque = false

  private app!: AppContext
  private root!: HTMLElement
  private api!: StoreApi
  private draft!: Draft
  private li = 0
  private tool: Tool = 'brush'
  private paint: M.Paint = { kind: 'block', material: 'wood', height: 2 }
  private height = 2
  private enemyType: EnemySlot = 1
  private mirrorX = false
  private mirrorY = false
  private grid = true
  private outline = false
  private bigPreview = false
  private sel: M.Rect | null = null
  private clip: M.Clip | null = null
  private pasting = false
  private hover: M.Pt | null = null
  private hiSlot = -1
  private drag: { before: string; anchor: M.Pt; last: M.Pt; base: M.Rect | null; baseLevel: LevelDef | null; paint: M.Paint; tool: Tool | 'none' } | null = null

  private canvas!: HTMLCanvasElement
  private center!: HTMLElement
  private slot!: HTMLElement
  private left!: HTMLElement
  private right!: HTMLElement
  private strip!: HTMLElement
  private status!: HTMLElement
  private undoBtn!: HTMLButtonElement
  private redoBtn!: HTMLButtonElement
  private packName!: HTMLInputElement
  private preview!: Preview
  private cs = 32
  private ox = 0
  private oy = 0
  private ro: ResizeObserver | null = null
  private saveTimer = 0
  private stripTimer = 0
  private saved = { stage: '', body: '', ui: '' }
  private keyHandler = (e: KeyboardEvent) => this.onKey(e)

  get level(): LevelDef {
    return this.draft.pack.levels[this.li]
  }
  get pack(): LevelPack {
    return this.draft.pack
  }

  mount(root: HTMLElement, app: AppContext, params?: Record<string, unknown>) {
    this.app = app
    this.root = root
    this.api = new StoreApi(app)
    this.preview = new Preview(app)
    root.classList.add('tk-root', 'ed-root')
    isolateKeys(root)

    // which pack
    const p = params ?? {}
    let d: Draft | null = null
    if (typeof p.draft === 'string') d = loadDraft(p.draft)
    // from the store: your own pack reopens its draft; anything else becomes a new draft
    if (!d && typeof p.storeId === 'string') d = listDrafts().find((x) => x.storeId === p.storeId) ?? null
    if (!d && p.pack) {
      d = newDraft(JSON.parse(JSON.stringify(p.pack)) as LevelPack)
      if (typeof p.storeId === 'string') d.storeId = p.storeId
      else d.pack.name = `${d.pack.name} (remix)`.slice(0, 48)
      delete d.pack.id
      delete d.pack.author
    }
    if (!d) {
      const cur = currentDraft()
      d = (cur && loadDraft(cur)) || listDrafts()[0] || newDraft()
    }
    this.draft = d
    this.li = Math.max(0, Math.min(d.pack.levels.length - 1, Number(p.level ?? 0) | 0))
    saveDraft(d)
    setCurrentDraft(d.id)

    this.build()
    this.takeStage()
    addEventListener('keydown', this.keyHandler)
    this.selectLevel(this.li)
  }

  unmount() {
    removeEventListener('keydown', this.keyHandler)
    this.ro?.disconnect()
    this.preview.dispose()
    this.flushSave()
    this.releaseStage()
  }

  // ---- 3D stage placement ------------------------------------------------------------

  private takeStage() {
    const stage = document.getElementById('stage')!
    const ui = document.getElementById('ui')
    this.saved = { stage: stage.getAttribute('style') ?? '', body: document.body.style.background, ui: ui?.style.visibility ?? '' }
    document.body.style.background = 'radial-gradient(rgba(95, 55, 20, 0.22) 1px, transparent 1.6px) 0 0 / 7px 7px, radial-gradient(rgba(255, 230, 190, 0.25) 1px, transparent 1.6px) 3px 4px / 11px 11px, #bf8a52'
    if (ui) ui.style.visibility = 'hidden'
    this.ro = new ResizeObserver(() => this.layout())
    this.ro.observe(this.slot)
    this.ro.observe(this.center)
  }

  private releaseStage() {
    const stage = document.getElementById('stage')!
    stage.setAttribute('style', this.saved.stage)
    document.body.style.background = this.saved.body
    const ui = document.getElementById('ui')
    if (ui) ui.style.visibility = this.saved.ui
    dispatchEvent(new Event('resize'))
  }

  private layout() {
    const stage = document.getElementById('stage')!
    const host = this.bigPreview ? this.center : this.slot
    const r = host.getBoundingClientRect()
    let w = r.width
    let hgt = (w * 9) / 16
    if (hgt > r.height) {
      hgt = r.height
      w = (hgt * 16) / 9
    }
    const x = r.left + (r.width - w) / 2
    const y = r.top + (r.height - hgt) / 2
    Object.assign(stage.style, { inset: 'auto', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hgt}px`, margin: '0', maxWidth: 'none', maxHeight: 'none', aspectRatio: 'auto' })
    dispatchEvent(new Event('resize'))
    this.canvas.style.visibility = this.bigPreview ? 'hidden' : ''
    this.sizeCanvas()
  }

  // ---- DOM ---------------------------------------------------------------------------

  private build() {
    this.packName = h('input', {
      type: 'text',
      class: 'ed-packname',
      value: this.pack.name,
      maxLength: 48,
      title: 'Pack name',
      on: { input: () => ((this.pack.name = this.packName.value), this.changed(false)) },
    })
    this.undoBtn = h('button', { class: 'tk-btn', title: 'Undo (Ctrl+Z)', on: { click: () => this.doUndo() } }, '↶')
    this.redoBtn = h('button', { class: 'tk-btn', title: 'Redo (Ctrl+Shift+Z)', on: { click: () => this.doRedo() } }, '↷')
    const top = h(
      'header',
      { class: 'ed-top tk-band' },
      h('button', { class: 'tk-btn tk-small ed-back', title: 'Back to the menu', on: { click: () => this.back() } }, '‹ Menu'),
      h('div', { class: 'ed-brand' }, h('span', { class: 'ed-brand-t' }, 'Level Editor')),
      this.packName,
      h('div', { class: 'ed-spacer' }),
      this.undoBtn,
      this.redoBtn,
      h('button', { class: 'tk-btn', title: 'Your drafts, new pack, import a file', on: { click: () => this.packsDialog() } }, 'Packs'),
      h('button', { class: 'tk-btn', title: 'Start from an original Wii Play map', on: { click: () => this.discDialog() } }, 'Disc maps'),
      h('button', { class: 'tk-btn', title: 'Download the pack as a .json file', on: { click: () => this.exportPack() } }, 'Export'),
      h('button', { class: 'tk-btn', title: 'Browse community packs', on: { click: () => this.app.show('store') } }, 'Store'),
      h('button', { class: 'tk-btn ed-play', title: 'Play this level (T)', on: { click: () => this.testDialog() } }, '▶ Test play'),
      h('button', { class: 'tk-btn tk-primary', on: { click: () => this.publishDialog() } }, 'Publish'),
    )
    this.left = h('aside', { class: 'ed-left' })
    this.canvas = h('canvas', { class: 'ed-canvas' })
    this.status = h('div', { class: 'ed-status' })
    this.center = h('main', { class: 'ed-center' }, this.canvas, this.status)
    this.slot = h('div', { class: 'ed-preview-slot', title: 'Live 3D preview' })
    this.right = h('aside', { class: 'ed-right' })
    const previewBox = h(
      'div',
      { class: 'ed-preview' },
      this.slot,
      h('button', { class: 'tk-btn tk-small ed-preview-toggle', title: 'Swap the 3D preview and the grid (V)', on: { click: () => this.toggleBig() } }, '⤢'),
    )
    this.strip = h('footer', { class: 'ed-strip' })
    clear(this.root, top, this.left, this.center, h('div', { class: 'ed-side' }, previewBox, this.right), this.strip)

    const c = this.canvas
    c.addEventListener('pointerdown', (e) => this.onDown(e))
    c.addEventListener('pointermove', (e) => this.onMove(e))
    c.addEventListener('pointerup', (e) => this.onUp(e))
    c.addEventListener('pointercancel', (e) => this.onUp(e))
    c.addEventListener('pointerleave', () => {
      if (!this.drag) {
        this.hover = null
        this.draw()
      }
    })
    c.addEventListener('contextmenu', (e) => e.preventDefault())
    this.renderLeft()
  }

  private renderLeft() {
    const tb = (t: (typeof TOOLS)[number]) =>
      h(
        'button',
        { class: `tk-btn ed-tool ${this.tool === t.id ? 'tk-on' : ''}`, title: `${t.label} (${t.key}) — ${t.hint}`, on: { click: () => this.setTool(t.id) } },
        h('span', { class: 'ed-ico' }, t.icon),
        h('span', null, t.label),
      )
    const toggle = (label: string, on: boolean, title: string, f: () => void) => h('button', { class: `tk-btn tk-small ${on ? 'tk-on' : ''}`, title, on: { click: f } }, label)
    const pk = this.paint
    const isPaint = (p: M.Paint) => JSON.stringify(p) === JSON.stringify(pk)
    const swatch = (p: M.Paint, title: string, draw: (c: CanvasRenderingContext2D, s: number) => void, label?: string) => {
      const cv = h('canvas', { width: 64, height: 64, style: 'width:100%;max-width:40px;height:auto;aspect-ratio:1' })
      draw(cv.getContext('2d')!, 64)
      return h('button', { class: `ed-sw ${isPaint(p) ? 'ed-sw-on' : ''}`, title, on: { click: () => this.setPaint(p) } }, cv, label ? h('span', null, label) : null)
    }
    const cellSwatch = (p: M.Paint, code: number, title: string, label?: string) => swatch(p, title, (c, s) => (c.fillStyle = '#e9d3a4', c.fillRect(0, 0, s, s), drawCell(c, code, 6, 6, s - 12, [this.enemyType])), label)
    const m = (material: Material) => ({ kind: 'block', material, height: this.height }) as M.Paint
    const tiles = tileTypes()
    const showClip = this.clip && (this.pasting || this.tool === 'select')

    clear(
      this.left,
      h('section', null, h('h3', null, 'Tools'), h('div', { class: 'ed-tools' }, TOOLS.map(tb))),
      h(
        'section',
        null,
        h('h3', null, 'Options'),
        h(
          'div',
          { class: 'ed-row ed-wrap' },
          toggle('Mirror ↔', this.mirrorX, 'Mirror left/right (M)', () => ((this.mirrorX = !this.mirrorX), this.renderLeft(), this.draw())),
          toggle('Mirror ↕', this.mirrorY, 'Mirror top/bottom (N)', () => ((this.mirrorY = !this.mirrorY), this.renderLeft(), this.draw())),
          toggle('Grid', this.grid, 'Grid lines (G)', () => ((this.grid = !this.grid), this.renderLeft(), this.draw())),
          toggle('Flip ↔', false, 'Mirror the level (or the selection) left-right', () => this.flipLevel(true)),
          toggle('Flip ↕', false, 'Mirror the level (or the selection) top-bottom', () => this.flipLevel(false)),
          this.tool === 'rect' ? toggle('Outline', this.outline, 'Box outline only (O)', () => ((this.outline = !this.outline), this.renderLeft())) : null,
        ),
      ),
      showClip
        ? h(
            'section',
            { class: 'ed-clip' },
            h('h3', null, this.pasting ? 'Pasting' : 'Clipboard'),
            h('div', { class: 'ed-row ed-wrap' },
              h('button', { class: `tk-btn tk-small ${this.pasting ? 'tk-on' : ''}`, title: 'Ctrl+V', on: { click: () => this.startPaste() } }, 'Paste'),
              h('button', { class: 'tk-btn tk-small', on: { click: () => this.flipClip(true) } }, 'Flip ↔'),
              h('button', { class: 'tk-btn tk-small', on: { click: () => this.flipClip(false) } }, 'Flip ↕'),
              this.pasting ? h('button', { class: 'tk-btn tk-small', on: { click: () => this.stopPaste() } }, 'Done') : null,
            ),
          )
        : null,
      h(
        'section',
        null,
        h('h3', null, 'Blocks'),
        h('div', { class: 'ed-swatches' },
          cellSwatch(m('wood'), blockCode('wood', this.height), 'Wood block: indestructible', 'Wood'),
          cellSwatch(m('cork'), blockCode('cork', this.height), 'Cork block: mines destroy it', 'Cork'),
          cellSwatch({ kind: 'hole' }, 200, 'Hole: tanks cannot cross, shells fly over', 'Hole'),
          swatch({ kind: 'erase' }, 'Empty floor', (c, s) => ((c.fillStyle = '#e9d3a4'), c.fillRect(0, 0, s, s), (c.strokeStyle = '#c8282e'), (c.lineWidth = 4), c.beginPath(), c.moveTo(14, 14), c.lineTo(s - 14, s - 14), c.moveTo(s - 14, 14), c.lineTo(14, s - 14), c.stroke()), 'Empty'),
        ),
        h('div', { class: 'ed-heights', title: 'Stack height (keys 2-8)' },
          h('span', null, 'Height'),
          [2, 3, 4, 5, 6, 7, 8].map((n) => h('button', { class: `tk-btn tk-small ${this.height === n ? 'tk-on' : ''}`, on: { click: () => this.setHeight(n) } }, String(n))),
        ),
      ),
      h(
        'section',
        null,
        h('h3', null, 'Spawns'),
        h('div', { class: 'ed-swatches ed-swatches-4' }, [0, 1, 2, 3].map((i) => cellSwatch({ kind: 'player', index: i }, 300 + i, `Player ${i + 1} start`, `P${i + 1}`))),
        h('div', { class: 'ed-sub' }, 'Enemy tank'),
        h(
          'div',
          { class: 'ed-tanks' },
          tankTypes().map((t) =>
            h(
              'button',
              {
                class: `ed-tank ${pk.kind === 'enemy' && slotType(this.enemyType) === t.id && !Array.isArray(this.enemyType) ? 'ed-sw-on' : ''}`,
                title: `${t.name} tank${t.extra ? ' (added type)' : ''}`,
                on: { click: () => ((this.enemyType = t.id), this.setPaint({ kind: 'enemy', type: t.id })) },
              },
              (() => {
                const cv = h('canvas', { width: 48, height: 48, style: 'width:100%;max-width:32px;height:auto;aspect-ratio:1' })
                drawTank(cv.getContext('2d')!, 24, 24, 40, t.color, undefined, Math.PI)
                return cv
              })(),
              h('span', null, t.name),
            ),
          ),
          h(
            'button',
            {
              class: `ed-tank ${pk.kind === 'enemy' && Array.isArray(this.enemyType) ? 'ed-sw-on' : ''}`,
              title: 'Random tank: a type picked at random in a range each time the level loads (set the range in the Enemies list)',
              on: { click: () => ((this.enemyType = [1, 3]), this.setPaint({ kind: 'enemy', type: [1, 3] })) },
            },
            h('span', { class: 'ed-rand' }, '?'),
            h('span', null, 'Random'),
          ),
        ),
      ),
      tiles.length
        ? h(
            'section',
            null,
            h('h3', null, 'Special tiles'),
            h('div', { class: 'ed-swatches' }, tiles.map((t) => cellSwatch({ kind: 'tile', code: t.code }, t.code, `${t.name}${t.description ? ': ' + t.description : ''} (${t.code})`, t.name))),
          )
        : null,
    )
  }

  private renderRight() {
    const l = this.level
    const used = new Map<number, M.Pt>()
    l.cells.forEach((r, y) => r.forEach((c, x) => isEnemy(c) && used.set(c - 400, { x, y })))
    const typeSelect = (value: number, onChange: (v: number) => void) =>
      h(
        'select',
        { on: { change: (e: Event) => onChange(Number((e.target as HTMLSelectElement).value)) } },
        tankTypes().map((t) => h('option', { value: String(t.id), selected: t.id === value }, `${t.id} · ${t.name}`)),
      )
    const slots: HTMLElement[] = []
    for (let i = 0; i < MAX_ENEMY_SLOTS; i++) {
      const e = l.enemies[i]
      const pos = used.get(i)
      if (!pos && !e) continue
      const lo = slotType(e) || 1
      const rand = Array.isArray(e)
      const set = (v: EnemySlot) => {
        const before = JSON.stringify(l)
        while (l.enemies.length <= i) l.enemies.push(0)
        l.enemies[i] = v
        if (M.commit(l, before)) this.changed()
      }
      const dot = h('span', { class: 'ed-dot', style: `background:${tankType(lo).color}` })
      slots.push(
        h(
          'div',
          {
            class: `ed-slot ${this.hiSlot === i ? 'ed-slot-hi' : ''} ${!pos ? 'ed-slot-bad' : ''}`,
            on: {
              pointerenter: () => ((this.hiSlot = i), this.draw()),
              pointerleave: () => ((this.hiSlot = -1), this.draw()),
            },
          },
          dot,
          h('b', null, `#${i + 1}`),
          typeSelect(lo, (v) => set(rand ? [Math.min(v, (e as [number, number])[1]), Math.max(v, (e as [number, number])[1])] : v)),
          rand ? h('span', { class: 'ed-to' }, 'to') : null,
          rand ? typeSelect((e as [number, number])[1], (v) => set([Math.min(lo, v), Math.max(lo, v)])) : null,
          h('label', { class: 'tk-check ed-randck', title: 'Pick the type at random from a range' }, h('input', { type: 'checkbox', checked: rand, on: { change: () => set(rand ? lo : [lo, Math.min(9, lo + 2)]) } }), '?'),
          !pos ? h('span', { class: 'ed-slot-note', title: 'This slot has a type but no spawn on the map' }, 'not placed') : null,
          h(
            'button',
            {
              class: 'tk-btn tk-small tk-ghost',
              title: 'Remove this enemy',
              on: {
                click: () => {
                  const before = JSON.stringify(l)
                  if (pos) l.cells[pos.y][pos.x] = 0
                  l.enemies[i] = 0
                  M.trimEnemies(l)
                  this.hiSlot = -1
                  if (M.commit(l, before)) this.changed()
                },
              },
            },
            '✕',
          ),
        ),
      )
    }

    const levelErrs = checkLevel(l)
    const pc = checkPack(this.pack)
    const otherErrs = pc.errors.filter((m) => !m.startsWith(`Level ${this.li + 1}: `))
    const msgs = [
      ...levelErrs.errors.map((m) => h('li', { class: 'tk-err' }, m)),
      ...otherErrs.map((m) => h('li', { class: 'tk-err' }, m)),
      ...levelErrs.warnings.map((m) => h('li', { class: 'tk-warn' }, m)),
    ]
    if (!levelErrs.errors.length && !otherErrs.length) msgs.unshift(h('li', { class: 'tk-good' }, this.pack.levels.length > 1 ? `All ${this.pack.levels.length} levels are ready to play and publish` : 'Ready to play and publish'))

    const field = (label: string, el: HTMLElement) => h('label', { class: 'tk-field' }, label, el)
    const text = (v: string, max: number, f: (s: string) => void, area = false) =>
      area
        ? h('textarea', { maxLength: max, rows: 2, value: v, on: { input: (e: Event) => (f((e.target as HTMLTextAreaElement).value), this.changed(false)) } })
        : h('input', { type: 'text', maxLength: max, value: v, on: { input: (e: Event) => (f((e.target as HTMLInputElement).value), this.changed(false)) } })
    const facing = (i: 0 | 1) =>
      h(
        'select',
        {
          on: {
            change: (e: Event) => {
              const before = JSON.stringify(l)
              const f: [number, number] = [...(l.facing ?? [0, 0])] as [number, number]
              f[i] = Number((e.target as HTMLSelectElement).value)
              l.facing = f
              if (M.commit(l, before)) this.changed()
            },
          },
        },
        FACINGS.map((n, k) => h('option', { value: String(k), selected: (l.facing ?? [0, 0])[i] === k }, n)),
      )

    clear(
      this.right,
      h(
        'section',
        null,
        h('h3', null, `Level ${this.li + 1} of ${this.pack.levels.length}`),
        field('Name', text(l.name, 48, (s) => (l.name = s))),
        field('Description', text(l.description ?? '', 400, (s) => (l.description = s || undefined), true)),
        h(
          'div',
          { class: 'ed-row' },
          h('label', { class: 'tk-check', title: 'Clearing this level awards an extra life' }, h('input', { type: 'checkbox', checked: !!l.bonus, on: { change: (e: Event) => ((l.bonus = (e.target as HTMLInputElement).checked || undefined), this.changed()) } }), 'Bonus life'),
          h('div', { class: 'ed-spacer' }),
          h('span', { class: 'ed-mini', title: 'Start balloon facing of P1 / P2' }, 'Facing'),
          facing(0),
          facing(1),
        ),
      ),
      h(
        'section',
        null,
        h('h3', null, `Enemies `, h('span', { class: 'ed-count' }, `${used.size} / ${MAX_ENEMY_SLOTS}`)),
        slots.length ? h('div', { class: 'ed-slots' }, slots) : h('p', { class: 'ed-empty' }, 'Pick a tank under Spawns and click the grid to place enemies.'),
      ),
      h('section', null, h('h3', null, 'Checks'), h('ul', { class: 'tk-msgs' }, msgs)),
      h(
        'section',
        null,
        h('h3', null, 'Pack'),
        h(
          'div',
          { class: 'ed-row' },
          h('span', { class: 'ed-mini' }, 'Starting lives'),
          h('input', {
            type: 'number',
            min: 1,
            max: 99,
            value: String(this.pack.lives ?? 3),
            style: 'width:80px',
            on: { input: (e: Event) => ((this.pack.lives = Math.max(1, Math.min(99, Number((e.target as HTMLInputElement).value) | 0 || 3))), this.changed(false)) },
          }),
        ),
        field('Pack description', text(this.pack.description ?? '', 400, (s) => (this.pack.description = s || undefined), true)),
        this.draft.storeId ? h('p', { class: 'ed-mini' }, 'Published — ', h('a', { href: '#', on: { click: (e: Event) => (e.preventDefault(), this.app.show('store', { id: this.draft.storeId })) } }, 'view in the store')) : null,
      ),
    )
  }

  private renderStrip() {
    const n = this.pack.levels.length
    const move = (d: number) => {
      const j = this.li + d
      if (j < 0 || j >= n) return
      const ls = this.pack.levels
      ;[ls[this.li], ls[j]] = [ls[j], ls[this.li]]
      this.li = j
      this.changed()
    }
    clear(
      this.strip,
      h(
        'div',
        { class: 'ed-cards' },
        this.pack.levels.map((l, i) =>
          h(
            'div',
            { class: `ed-card ${i === this.li ? 'ed-card-on' : ''} ${checkLevel(l).errors.length ? 'ed-card-bad' : ''}`, title: l.name, on: { click: () => i !== this.li && this.selectLevel(i) } },
            h('img', { src: thumbnail(l.cells, l.enemies, 5), alt: '', draggable: false }),
            h('div', { class: 'ed-card-t' }, h('b', null, String(i + 1)), h('span', null, l.name || 'Untitled'), l.bonus ? h('span', { class: 'ed-bonus', title: 'Bonus life' }, '+1') : null),
          ),
        ),
        h(
          'div',
          { class: 'ed-card ed-card-add' },
          h('button', { class: 'tk-btn tk-small', on: { click: () => this.addLevel(emptyLevel(`Level ${n + 1}`)) } }, '+ New level'),
          h('button', { class: 'tk-btn tk-small', on: { click: () => this.discDialog() } }, '+ Disc map'),
        ),
      ),
      h(
        'div',
        { class: 'ed-strip-tools' },
        h('button', { class: 'tk-btn tk-small', title: 'Move earlier', disabled: this.li === 0, on: { click: () => move(-1) } }, '◀'),
        h('button', { class: 'tk-btn tk-small', title: 'Move later', disabled: this.li === n - 1, on: { click: () => move(1) } }, '▶'),
        h('button', { class: 'tk-btn tk-small', title: 'Duplicate this level', on: { click: () => this.addLevel({ ...M.cloneLevel(this.level), name: `${this.level.name} copy` }) } }, 'Duplicate'),
        h(
          'button',
          {
            class: 'tk-btn tk-small tk-danger',
            disabled: n <= 1,
            on: {
              click: () =>
                modal(this.root, 'Delete level?', `“${this.level.name}” will be removed from the pack.`, [
                  { label: 'Cancel', kind: 'ghost' },
                  {
                    label: 'Delete',
                    kind: 'danger',
                    onClick: () => {
                      this.pack.levels.splice(this.li, 1)
                      this.selectLevel(Math.min(this.li, this.pack.levels.length - 1))
                      this.changed(false)
                    },
                  },
                ]),
            },
          },
          'Delete',
        ),
      ),
    )
    this.strip.querySelector('.ed-card-on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  // ---- state changes ---------------------------------------------------------------------

  private selectLevel(i: number) {
    this.li = i
    this.sel = null
    this.hiSlot = -1
    this.renderRight()
    this.renderStrip()
    this.preview.update(this.level, true)
    this.draw()
    this.updateUndo()
  }

  private addLevel(l: LevelDef) {
    if (this.pack.levels.length >= 100) return toast(this.root, 'A pack holds at most 100 levels', 'error')
    this.pack.levels.splice(this.li + 1, 0, l)
    this.selectLevel(this.li + 1)
    this.changed(false)
  }

  /** after any edit: redraw, preview, panels, autosave */
  private changed(full = true) {
    if (full) {
      this.draw()
      this.preview.update(this.level)
      this.renderRight()
      this.updateUndo()
    }
    clearTimeout(this.stripTimer)
    this.stripTimer = window.setTimeout(() => this.renderStrip(), full ? 250 : 400)
    clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => this.flushSave(), 500)
  }

  private flushSave() {
    clearTimeout(this.saveTimer)
    if (!saveDraft(this.draft)) toast(this.root, 'Could not save the draft: browser storage is full', 'error')
  }

  private updateUndo() {
    this.undoBtn.disabled = !M.canUndo(this.level)
    this.redoBtn.disabled = !M.canRedo(this.level)
  }

  private doUndo() {
    if (M.undo(this.level)) this.changed()
  }
  private doRedo() {
    if (M.redo(this.level)) this.changed()
  }

  private setTool(t: Tool) {
    this.tool = t
    if (t !== 'select') this.sel = null
    this.pasting = false
    if ((t === 'line' || t === 'rect' || t === 'fill') && !M.isAreaPaint(this.paint)) this.paint = { kind: 'block', material: 'wood', height: this.height }
    this.renderLeft()
    this.draw()
  }

  private setPaint(p: M.Paint) {
    this.paint = p
    if (this.tool === 'erase' || this.tool === 'select' || (!M.isAreaPaint(p) && this.tool !== 'brush')) this.tool = 'brush'
    this.pasting = false
    this.renderLeft()
    this.draw()
  }

  private setHeight(n: number) {
    this.height = n
    if (this.paint.kind === 'block') this.paint = { ...this.paint, height: n }
    this.renderLeft()
  }

  private toggleBig() {
    this.bigPreview = !this.bigPreview
    this.root.classList.toggle('ed-big', this.bigPreview)
    this.layout()
  }

  private back() {
    this.flushSave()
    try {
      this.app.toMenu()
    } catch {
      this.app.show(null)
    }
  }

  // ---- canvas ----------------------------------------------------------------------------

  private sizeCanvas() {
    const r = this.center.getBoundingClientRect()
    const pad = 16
    const cs = Math.max(8, Math.floor(Math.min((r.width - pad * 2) / LEVEL_W, (r.height - pad * 2 - 28) / LEVEL_H)))
    const dpr = Math.min(2, devicePixelRatio || 1)
    const w = cs * LEVEL_W + 12
    const hh = cs * LEVEL_H + 12
    this.canvas.width = Math.round(w * dpr)
    this.canvas.height = Math.round(hh * dpr)
    this.canvas.style.width = `${w}px`
    this.canvas.style.height = `${hh}px`
    this.cs = cs
    this.ox = 6
    this.oy = 6
    this.draw()
  }

  private cellAt(e: PointerEvent): M.Pt {
    const r = this.canvas.getBoundingClientRect()
    return { x: Math.floor((e.clientX - r.left - this.ox) / this.cs), y: Math.floor((e.clientY - r.top - this.oy) / this.cs) }
  }

  private draw() {
    const cv = this.canvas
    if (!cv || !this.draft) return
    const c = cv.getContext('2d')!
    const dpr = cv.width / parseFloat(cv.style.width || '1')
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    const l = this.level
    const s = this.cs
    const W = LEVEL_W * s
    const H = LEVEL_H * s
    c.clearRect(0, 0, cv.width, cv.height)
    // toy-box frame
    c.fillStyle = '#7b5330'
    c.beginPath()
    c.roundRect(0, 0, W + 12, H + 12, 8)
    c.fill()
    drawLevel(c, l.cells, l.enemies, this.ox, this.oy, s, { labels: true, grid: this.grid, hiSlot: this.hiSlot })
    c.save()
    c.translate(this.ox, this.oy)
    // symmetry axes
    c.strokeStyle = 'rgba(61, 121, 201, 0.75)'
    c.setLineDash([6, 5])
    c.lineWidth = 2
    c.beginPath()
    if (this.mirrorX) (c.moveTo(W / 2, 0), c.lineTo(W / 2, H))
    if (this.mirrorY) (c.moveTo(0, H / 2), c.lineTo(W, H / 2))
    c.stroke()
    c.setLineDash([])
    // selection
    if (this.sel) {
      const r = this.sel
      c.fillStyle = 'rgba(61, 121, 201, 0.15)'
      c.fillRect(r.x0 * s, r.y0 * s, (r.x1 - r.x0 + 1) * s, (r.y1 - r.y0 + 1) * s)
      c.strokeStyle = '#3d79c9'
      c.setLineDash([5, 4])
      c.lineWidth = 2
      c.strokeRect(r.x0 * s + 1, r.y0 * s + 1, (r.x1 - r.x0 + 1) * s - 2, (r.y1 - r.y0 + 1) * s - 2)
      c.setLineDash([])
    }
    const hv = this.hover
    if (hv && M.inside(hv.x, hv.y) && !this.bigPreview) {
      if (this.pasting && this.clip) {
        const at = this.pasteAt(hv)
        c.globalAlpha = 0.7
        for (let y = 0; y < this.clip.h; y++)
          for (let x = 0; x < this.clip.w; x++) {
            const px = at.x + x
            const py = at.y + y
            if (!M.inside(px, py)) continue
            c.fillStyle = '#e9d3a4'
            c.fillRect(px * s, py * s, s, s)
            const code = this.clip.cells[y][x]
            const en: EnemySlot[] = []
            if (isEnemy(code)) en[code - 400] = this.clip.types[y][x]
            if (code) drawCell(c, code, px * s, py * s, s, en, { labels: false })
          }
        c.globalAlpha = 1
        c.strokeStyle = '#3d79c9'
        c.lineWidth = 2
        c.strokeRect(at.x * s, at.y * s, this.clip.w * s, this.clip.h * s)
      } else {
        const pts = this.tool === 'select' || this.drag ? [hv] : this.paint.kind === 'player' ? [hv] : M.mirrorPoints(hv, this.mirrorX, this.mirrorY)
        for (const p of pts) {
          c.strokeStyle = this.tool === 'erase' || this.paint.kind === 'erase' ? '#c8282e' : '#3d79c9'
          c.lineWidth = 3
          c.strokeRect(p.x * s + 1.5, p.y * s + 1.5, s - 3, s - 3)
        }
      }
    }
    c.restore()
    // status line
    if (this.status) {
      const code = hv && M.inside(hv.x, hv.y) ? l.cells[hv.y][hv.x] : null
      const t = TOOLS.find((x) => x.id === this.tool)!
      let info = this.pasting ? 'Click to stamp the clipboard · Esc to stop' : t.hint
      if (code != null) {
        let d = describeCell(code)
        if (isEnemy(code)) {
          const e = l.enemies[code - 400]
          d += Array.isArray(e) ? ` · random ${tankType(e[0]).name}–${tankType(e[1]).name}` : e ? ` · ${tankType(e).name}` : ' · no type'
        }
        info = `(${hv!.x + 1}, ${hv!.y + 1}) ${d}   ·   ${info}`
      }
      this.status.textContent = info
    }
  }

  private pasteAt(p: M.Pt): M.Pt {
    const c = this.clip!
    return { x: p.x - Math.floor((c.w - 1) / 2), y: p.y - Math.floor((c.h - 1) / 2) }
  }

  private onDown(e: PointerEvent) {
    if (this.bigPreview) return
    const p = this.cellAt(e)
    if (!M.inside(p.x, p.y)) return
    try {
      this.canvas.setPointerCapture(e.pointerId)
    } catch {
      /* synthetic events */
    }
    this.hover = p
    const l = this.level
    const before = JSON.stringify(l)
    if (this.pasting && this.clip) {
      if (e.button === 2) return this.stopPaste()
      const dropped = M.pasteClip(l, this.clip, this.pasteAt(p))
      if (dropped) toast(this.root, `${dropped} enemy spawn(s) skipped: all ${MAX_ENEMY_SLOTS} slots are used`, 'error')
      if (M.commit(l, before)) this.changed()
      return
    }
    if (e.altKey || e.button === 1) return this.pick(p)
    let tool = this.tool
    let paint = this.paint
    if (e.button === 2 || tool === 'erase') {
      paint = { kind: 'erase' }
      if (tool !== 'rect' && tool !== 'line') tool = 'brush'
    }
    this.drag = { before, anchor: p, last: p, base: null, baseLevel: null, paint, tool }
    switch (tool) {
      case 'select':
        this.sel = M.normRect(p, p)
        this.renderLeft()
        break
      case 'fill':
        if (!M.isAreaPaint(paint)) {
          toast(this.root, 'Fill works with blocks, holes and tiles')
          break
        }
        M.paintPoints(l, M.floodPoints(l, p), paint, this.mirrorX, this.mirrorY)
        break
      case 'line':
      case 'rect':
        this.drag.baseLevel = M.cloneLevel(l)
        this.shape(p)
        break
      default:
        if (!M.paintAt(l, p, paint, this.mirrorX, this.mirrorY)) toast(this.root, `All ${MAX_ENEMY_SLOTS} enemy slots are used`, 'error')
        // a spawn is placed once per click, then the drag only moves the hover
        if (!M.isAreaPaint(paint)) this.drag.tool = 'none'
    }
    this.draw()
    this.preview.update(l)
  }

  private shape(p: M.Pt) {
    const d = this.drag!
    const l = this.level
    const b = d.baseLevel!
    l.cells = b.cells.map((r) => [...r])
    l.enemies = [...b.enemies]
    const pts = d.tool === 'line' ? M.linePoints(d.anchor, p) : M.rectPoints(d.anchor, p, this.outline)
    M.paintPoints(l, pts, d.paint, this.mirrorX, this.mirrorY)
  }

  private onMove(e: PointerEvent) {
    const p = this.cellAt(e)
    const d = this.drag
    if (!d) {
      if (!this.hover || p.x !== this.hover.x || p.y !== this.hover.y) {
        this.hover = p
        this.draw()
      }
      return
    }
    if (p.x === d.last.x && p.y === d.last.y) return
    this.hover = p
    const q = { x: Math.max(0, Math.min(LEVEL_W - 1, p.x)), y: Math.max(0, Math.min(LEVEL_H - 1, p.y)) }
    switch (d.tool) {
      case 'select':
        this.sel = M.normRect(d.anchor, q)
        break
      case 'line':
      case 'rect':
        this.shape(q)
        this.preview.update(this.level)
        break
      case 'brush':
        if (M.isAreaPaint(d.paint)) {
          M.paintPoints(this.level, M.linePoints(d.last, q), d.paint, this.mirrorX, this.mirrorY)
          this.preview.update(this.level)
        }
        break
    }
    d.last = q
    this.draw()
  }

  private onUp(_e: PointerEvent) {
    const d = this.drag
    if (!d) return
    this.drag = null
    const l = this.level
    M.trimEnemies(l)
    if (M.commit(l, d.before)) this.changed()
    else this.draw()
  }

  private pick(p: M.Pt) {
    const c = this.level.cells[p.y][p.x]
    if (isWood(c) || isCork(c)) {
      this.height = blockHeight(c)
      this.setPaint({ kind: 'block', material: isWood(c) ? 'wood' : 'cork', height: this.height })
    } else if (isHole(c)) this.setPaint({ kind: 'hole' })
    else if (isPlayer(c)) this.setPaint({ kind: 'player', index: c - 300 })
    else if (isEnemy(c)) {
      this.enemyType = this.level.enemies[c - 400] || 1
      this.setPaint({ kind: 'enemy', type: this.enemyType })
    } else if (isTile(c)) this.setPaint({ kind: 'tile', code: c })
    else this.setPaint({ kind: 'erase' })
  }

  // ---- clipboard -------------------------------------------------------------------------

  private copy(cut: boolean) {
    if (!this.sel) return toast(this.root, 'Select an area first (S)')
    this.clip = M.copyRect(this.level, this.sel)
    if (cut) {
      const before = JSON.stringify(this.level)
      M.clearRect(this.level, this.sel)
      M.trimEnemies(this.level)
      if (M.commit(this.level, before)) this.changed()
    }
    toast(this.root, `${cut ? 'Cut' : 'Copied'} ${this.clip.w} × ${this.clip.h} — Ctrl+V to paste`)
    this.renderLeft()
  }

  private startPaste() {
    if (!this.clip) return toast(this.root, 'Nothing copied yet')
    this.pasting = true
    this.sel = null
    this.renderLeft()
    this.draw()
  }

  private stopPaste() {
    this.pasting = false
    this.renderLeft()
    this.draw()
  }

  private flipClip(horizontal: boolean) {
    if (this.clip) this.clip = M.flipClip(this.clip, horizontal)
    this.draw()
  }

  private deleteSel() {
    if (!this.sel) return
    const before = JSON.stringify(this.level)
    M.clearRect(this.level, this.sel)
    M.trimEnemies(this.level)
    if (M.commit(this.level, before)) this.changed()
  }

  /** mirror the whole level (or the selection) */
  private flipLevel(horizontal: boolean) {
    const l = this.level
    const before = JSON.stringify(l)
    const r = this.sel ?? { x0: 0, y0: 0, x1: LEVEL_W - 1, y1: LEVEL_H - 1 }
    const clip = M.flipClip(M.copyRect(l, r), horizontal)
    // keep spawn slots: write the codes back directly
    for (let y = 0; y < clip.h; y++) for (let x = 0; x < clip.w; x++) l.cells[r.y0 + y][r.x0 + x] = clip.cells[y][x]
    if (M.commit(l, before)) this.changed()
  }

  // ---- keyboard --------------------------------------------------------------------------

  private onKey(e: KeyboardEvent) {
    if (isTyping(e) || this.root.querySelector('.tk-modal-wrap')) return
    const k = e.key.toLowerCase()
    const mod = e.ctrlKey || e.metaKey
    if (mod) {
      if (k === 'z' && !e.shiftKey) this.doUndo()
      else if ((k === 'z' && e.shiftKey) || k === 'y') this.doRedo()
      else if (k === 'c') this.copy(false)
      else if (k === 'x') this.copy(true)
      else if (k === 'v') this.startPaste()
      else if (k === 's') this.flushSave(), toast(this.root, 'Draft saved', 'ok')
      else if (k === 'a') (this.setTool('select'), (this.sel = { x0: 0, y0: 0, x1: LEVEL_W - 1, y1: LEVEL_H - 1 }), this.draw())
      else return
      e.preventDefault()
      return
    }
    const t = TOOLS.find((x) => x.key.toLowerCase() === k)
    if (t) this.setTool(t.id)
    else if (k >= '2' && k <= '8') this.setHeight(Number(k))
    else if (k === 'w') this.setPaint({ kind: 'block', material: 'wood', height: this.height })
    else if (k === 'c') this.setPaint({ kind: 'block', material: 'cork', height: this.height })
    else if (k === 'h') this.setPaint({ kind: 'hole' })
    else if (k === 'm') ((this.mirrorX = !this.mirrorX), this.renderLeft(), this.draw())
    else if (k === 'n') ((this.mirrorY = !this.mirrorY), this.renderLeft(), this.draw())
    else if (k === 'g') ((this.grid = !this.grid), this.renderLeft(), this.draw())
    else if (k === 'o') ((this.outline = !this.outline), this.renderLeft())
    else if (k === 'v') this.toggleBig()
    else if (k === 't') this.testDialog()
    else if (k === 'delete' || k === 'backspace') this.deleteSel()
    else if (k === 'escape') {
      if (this.pasting) this.stopPaste()
      else if (this.sel) ((this.sel = null), this.draw())
    } else if (k === '[') this.li > 0 && this.selectLevel(this.li - 1)
    else if (k === ']') this.li < this.pack.levels.length - 1 && this.selectLevel(this.li + 1)
    else if (k === '?') this.helpDialog()
    else return
    e.preventDefault()
  }

  // ---- dialogs ---------------------------------------------------------------------------

  private testDialog() {
    const errs = checkLevel(this.level).errors
    if (errs.length) return modal(this.root, 'This level is not playable yet', h('ul', { class: 'tk-msgs' }, errs.map((m) => h('li', { class: 'tk-err' }, m))))
    let players = Number(localStorage.getItem('tanks.editor.players') ?? 1) || 1
    const pick = h('div', { class: 'ed-players' })
    const renderPick = () =>
      clear(pick, [1, 2, 3, 4].map((n) => h('button', { class: `tk-btn ${players === n ? 'tk-on' : ''}`, on: { click: () => ((players = n), renderPick()) } }, `${n} player${n > 1 ? 's' : ''}`)))
    renderPick()
    const go = (whole: boolean) => {
      localStorage.setItem('tanks.editor.players', String(players))
      this.flushSave()
      const pack: LevelPack = whole ? normalizePack(this.pack) : { ...normalizePack({ ...this.pack, levels: [this.level] }) }
      if (whole && checkPack(pack).errors.length) {
        toast(this.root, 'Some levels have problems; fix them or test this level only', 'error')
        return false
      }
      playAndReturn(this.app, pack, players, whole ? this.li : 0, 'editor', { draft: this.draft.id, level: this.li })
    }
    modal(
      this.root,
      'Test play',
      h('div', null, h('p', null, 'Pause (Esc) → Quit comes back to the editor. Players 2–4 use gamepads.'), pick),
      [
        { label: 'Cancel', kind: 'ghost' },
        ...(this.pack.levels.length > 1 ? [{ label: `Pack from level ${this.li + 1}`, onClick: () => go(true) }] : []),
        { label: '▶ Play this level', kind: 'primary' as const, onClick: () => go(false) },
      ],
    )
  }

  private helpDialog() {
    const rows = [
      ['B L R F E S', 'Brush, line, box, fill, eraser, select'],
      ['W / C / H', 'Wood, cork, hole'],
      ['2 – 8', 'Stack height'],
      ['Right-click', 'Erase'],
      ['Alt-click', 'Pick the cell under the cursor'],
      ['M / N', 'Mirror left-right / top-bottom'],
      ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
      ['Ctrl+C / X / V, Del', 'Copy, cut, paste, delete the selection'],
      ['[ / ]', 'Previous / next level'],
      ['V', 'Swap the 3D preview and the grid'],
      ['T', 'Test play'],
    ]
    modal(this.root, 'Keyboard shortcuts', h('table', { class: 'ed-keys' }, rows.map(([k, v]) => h('tr', null, h('td', null, h('kbd', null, k)), h('td', null, v)))))
  }

  private exportPack() {
    this.flushSave()
    download(fileName(this.pack.name), JSON.stringify(this.pack, null, 1))
  }

  private async importFile() {
    const text = await pickFile()
    if (!text) return
    let v: unknown
    try {
      v = JSON.parse(text)
    } catch {
      return toast(this.root, 'That file is not valid JSON', 'error')
    }
    const o = v as Partial<LevelPack & LevelDef>
    let pack: LevelPack
    if (Array.isArray(o?.levels)) pack = o as LevelPack
    else if (Array.isArray(o?.cells)) pack = { v: 1, name: o.name ?? 'Imported level', levels: [o as LevelDef] }
    else return toast(this.root, 'No levels found in that file', 'error')
    const bad = pack.levels.findIndex((l) => !Array.isArray(l?.cells) || l.cells.length !== LEVEL_H || l.cells.some((r) => !Array.isArray(r) || r.length !== LEVEL_W))
    if (bad >= 0) return toast(this.root, `Level ${bad + 1} is not a ${LEVEL_W} × ${LEVEL_H} grid`, 'error')
    pack.v = 1
    for (const l of pack.levels) {
      l.v = 1
      l.enemies ??= []
      l.name ||= 'Untitled'
    }
    pack.name ||= 'Imported pack'
    this.openDraft(newDraft(JSON.parse(JSON.stringify(pack))))
    const c = checkPack(this.pack)
    toast(this.root, c.errors.length ? `Imported with ${c.errors.length} problem(s) to fix` : `Imported “${this.pack.name}”`, c.errors.length ? 'error' : 'ok')
  }

  private openDraft(d: Draft) {
    this.flushSave()
    this.draft = d
    saveDraft(d)
    setCurrentDraft(d.id)
    this.packName.value = d.pack.name
    this.selectLevel(0)
  }

  private packsDialog() {
    this.flushSave()
    const list = h('div', { class: 'ed-drafts' })
    let close = () => {}
    const render = () =>
      clear(
        list,
        listDrafts().map((d) =>
          h(
            'div',
            { class: `ed-draft ${d.id === this.draft.id ? 'ed-draft-on' : ''}` },
            h('img', { src: thumbnail(d.pack.levels[0].cells, d.pack.levels[0].enemies, 4), alt: '' }),
            h('div', { class: 'ed-draft-t' }, h('b', null, d.pack.name || 'Untitled'), h('span', null, `${d.pack.levels.length} level${d.pack.levels.length > 1 ? 's' : ''} · edited ${relTime(d.updated)}${d.storeId ? ' · published' : ''}`)),
            d.id === this.draft.id ? h('span', { class: 'ed-mini' }, 'open') : h('button', { class: 'tk-btn tk-small', on: { click: () => (this.openDraft(d), close()) } }, 'Open'),
            h(
              'button',
              {
                class: 'tk-btn tk-small tk-danger',
                title: 'Delete this draft',
                on: {
                  click: () => {
                    if (!confirm(`Delete the draft “${d.pack.name}”? This cannot be undone.`)) return
                    deleteDraft(d.id)
                    if (d.id === this.draft.id) this.openDraft(listDrafts()[0] ?? newDraft())
                    render()
                  },
                },
              },
              '✕',
            ),
          ),
        ),
      )
    render()
    close = modal(this.root, 'Your packs', h('div', null, h('p', { class: 'ed-mini' }, 'Drafts are saved in this browser automatically.'), list), [
      { label: 'Import file…', onClick: () => void this.importFile() },
      { label: '+ New pack', kind: 'primary', onClick: () => this.openDraft(newDraft()) },
    ])
  }

  private discDialog() {
    const data = this.app.game.data
    if (!data?.maps) return toast(this.root, 'Game data is not loaded', 'error')
    let close = () => {}
    const cards = discMaps(data).map((m) => {
      let mission = m.missions[0] ?? 0
      const img = h('img', { alt: '' })
      const upd = () => {
        const l = discLevel(data, m.variant, mission)
        img.src = thumbnail(l.cells, l.enemies, 6)
      }
      upd()
      const sel = h(
        'select',
        { title: 'Which mission’s enemies to use', on: { change: (e: Event) => ((mission = Number((e.target as HTMLSelectElement).value)), upd()) } },
        m.missions.map((n) => h('option', { value: String(n) }, `Mission ${n}`)),
        h('option', { value: '0' }, 'All spawns (Brown)'),
      )
      const use = (replace: boolean) => {
        const l = discLevel(data, m.variant, mission)
        if (replace) {
          const before = JSON.stringify(this.level)
          const cur = this.level
          Object.assign(cur, { cells: l.cells, enemies: l.enemies, facing: l.facing, bonus: l.bonus })
          if (!cur.name || /^(Level \d+|Mission \d+|Disc map \d+)$/.test(cur.name)) cur.name = l.name
          if (M.commit(cur, before)) this.changed()
          this.renderRight()
        } else this.addLevel(l)
        close()
      }
      return h(
        'div',
        { class: 'ed-disc' },
        img,
        h('div', { class: 'ed-disc-t' }, h('b', null, `Map ${m.variant + 1}`), sel),
        h('div', { class: 'ed-row' }, h('button', { class: 'tk-btn tk-small', on: { click: () => use(true) } }, 'Replace level'), h('button', { class: 'tk-btn tk-small tk-primary', on: { click: () => use(false) } }, 'Add level')),
      )
    })
    close = modal(this.root, 'Original Wii Play maps', h('div', { class: 'ed-discs' }, cards), [{ label: 'Close' }], 'tk-wide')
  }

  private publishDialog() {
    this.flushSave()
    const pack = normalizePack(this.pack)
    const c = checkPack(pack)
    const name = h('input', { type: 'text', maxLength: 32, value: authorName(), placeholder: 'Shown as the author' })
    const pname = h('input', { type: 'text', maxLength: 48, value: this.pack.name })
    const desc = h('textarea', { maxLength: 400, rows: 3, value: this.pack.description ?? '', placeholder: 'What makes these levels fun?' })
    const err = h('ul', { class: 'tk-msgs' }, c.errors.map((m) => h('li', { class: 'tk-err' }, m)))
    const submit = async (asNew: boolean) => {
      const author = name.value.trim()
      if (!author) {
        name.focus()
        clear(err, h('li', { class: 'tk-err' }, 'Enter a display name'))
        return false
      }
      this.pack.name = pname.value.trim() || this.pack.name
      this.pack.description = desc.value.trim() || undefined
      this.packName.value = this.pack.name
      setAuthorName(author)
      const p = normalizePack(this.pack)
      try {
        const r = !asNew && this.draft.storeId ? await this.api.update(this.draft.storeId, p, author) : await this.api.publish(p, author)
        this.draft.storeId = r.id
        this.flushSave()
        this.renderRight()
        toast(this.root, asNew ? 'Published to the store' : 'Published pack updated', 'ok', { label: 'View in store', run: () => this.app.show('store', { id: r.id }) })
      } catch (e) {
        const ae = e as ApiError
        if (!asNew && (ae.status === 403 || ae.status === 404)) {
          clear(err, h('li', { class: 'tk-err' }, 'The published copy belongs to another identity or was deleted. Publish it as a new pack instead.'))
          this.draft.storeId = undefined
        } else clear(err, h('li', { class: 'tk-err' }, ae.message), ...(ae.details ?? []).map((m) => h('li', { class: 'tk-err' }, m)))
        return false
      }
    }
    const body = h(
      'div',
      { class: 'ed-publish' },
      h('div', { class: 'ed-pub-head' }, h('img', { src: thumbnail(pack.levels[0].cells, pack.levels[0].enemies, 7), alt: '' }), h('div', null, h('b', null, `${pack.levels.length} level${pack.levels.length > 1 ? 's' : ''}`), h('p', { class: 'ed-mini' }, 'Anyone can play, rate and report published packs. Only this browser can update or delete it (it holds your author key).'))),
      h('label', { class: 'tk-field' }, 'Display name', name),
      h('label', { class: 'tk-field' }, 'Pack name', pname),
      h('label', { class: 'tk-field' }, 'Description', desc),
      err,
    )
    const buttons: { label: string; kind?: 'primary' | 'ghost'; onClick?: () => Promise<boolean | void> | void }[] = [{ label: 'Cancel', kind: 'ghost' }]
    if (c.errors.length) buttons.push({ label: 'Fix the problems first', kind: 'ghost', onClick: () => {} })
    else if (this.draft.storeId) {
      buttons.push({ label: 'Publish as new', onClick: () => submit(true) })
      buttons.push({ label: 'Update published pack', kind: 'primary', onClick: () => submit(false) })
    } else buttons.push({ label: 'Publish', kind: 'primary', onClick: () => submit(true) })
    modal(this.root, 'Publish to the store', body, buttons)
  }
}

export function createEditor(): Screen {
  return new Editor()
}

