// Community level store ('store'): browse, search, play, rate and report published packs.
// Params: { id?: string } opens a pack's page directly.

import type { AppContext, Screen } from '../app/types'
import type { LevelPack } from '../levels/format'
import { tankType } from '../editor/catalog'
import { thumbnail } from '../editor/draw'
import { clear, h, isolateKeys, isTyping, modal, playAndReturn, relTime, toast } from '../editor/ui'
import { ApiError, StoreApi, type PackDetail, type PackSummary, type Sort } from './api'
import { unlock } from '../ui/shared/achievements'

const SORTS: { id: Sort; label: string }[] = [
  { id: 'new', label: 'New' },
  { id: 'top', label: 'Top rated' },
  { id: 'plays', label: 'Most played' },
]
const PAGE = 24

function stars(rating: number, count: number) {
  const full = Math.round(rating)
  return h('span', { class: 'st-rating', title: count ? `${rating.toFixed(1)} from ${count} rating${count > 1 ? 's' : ''}` : 'Not rated yet' }, h('span', { class: 'st-stars' }, '★'.repeat(full), h('span', { class: 'st-dim' }, '★'.repeat(5 - full))), h('span', { class: 'st-n' }, count ? rating.toFixed(1) : '—'))
}

class Store implements Screen {
  readonly modal = true
  readonly opaque = true

  private app!: AppContext
  private api!: StoreApi
  private root!: HTMLElement
  private main!: HTMLElement
  private sort: Sort = (sessionStorage.getItem('tanks.store.sort') as Sort) || 'new'
  private q = ''
  private mine = false
  private items: PackSummary[] = []
  private total = 0
  private page = 0
  private loading = false
  private searchTimer = 0
  private detail: PackDetail | null = null
  private levelIdx = 0
  private players = Number(localStorage.getItem('tanks.store.players') ?? 1) || 1
  private keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !isTyping(e) && !this.root.querySelector('.tk-modal-wrap')) {
      if (this.detail) this.showList()
      else this.back()
    }
  }

  mount(root: HTMLElement, app: AppContext, params?: Record<string, unknown>) {
    this.app = app
    this.api = new StoreApi(app)
    this.root = root
    root.classList.add('tk-root', 'st-root')
    isolateKeys(root)
    addEventListener('keydown', this.keyHandler)
    this.main = h('main', { class: 'st-main' })
    clear(root, this.header(), this.main)
    if (typeof params?.id === 'string') void this.openPack(params.id)
    else void this.load(true)
  }

  unmount() {
    removeEventListener('keydown', this.keyHandler)
    clearTimeout(this.searchTimer)
  }

  private back() {
    try {
      this.app.toMenu()
    } catch {
      this.app.show(null)
    }
  }

  private header() {
    const search = h('input', {
      type: 'search',
      placeholder: 'Search packs or authors…',
      value: this.q,
      class: 'st-search',
      on: {
        input: (e: Event) => {
          this.q = (e.target as HTMLInputElement).value
          clearTimeout(this.searchTimer)
          this.searchTimer = window.setTimeout(() => void this.load(true), 250)
        },
      },
    })
    return h(
      'header',
      { class: 'st-top tk-band' },
      h('button', { class: 'tk-btn tk-small st-back', on: { click: () => this.back() } }, '‹ Menu'),
      h('h1', { class: 'st-title' }, 'Level Store'),
      search,
      h('div', { class: 'ed-spacer' }),
      h('button', { class: 'tk-btn', title: 'Make your own levels', on: { click: () => this.app.show('editor') } }, '✎ Level editor'),
    )
  }

  // ---- list ------------------------------------------------------------------------------

  private showList() {
    this.detail = null
    this.renderList()
    if (!this.items.length) void this.load(true)
  }

  private async load(reset: boolean) {
    if (this.loading) return
    this.loading = true
    if (reset) {
      this.page = 0
      this.items = []
      this.detail = null
      this.renderList(true)
    }
    try {
      const r = await this.api.list({ sort: this.sort, q: this.q.trim(), page: this.page, limit: PAGE, mine: this.mine })
      this.items = reset ? r.items : [...this.items, ...r.items]
      this.total = r.total
      this.page++
      this.loading = false
      if (!this.detail) this.renderList()
    } catch (e) {
      this.loading = false
      this.renderError((e as Error).message, () => void this.load(true))
    }
  }

  private renderError(msg: string, retry: () => void) {
    clear(this.main, h('div', { class: 'st-empty' }, h('div', { class: 'st-empty-ico' }, '⚠'), h('h2', null, 'The level store is unavailable'), h('p', null, msg), h('button', { class: 'tk-btn tk-primary', on: { click: retry } }, 'Try again')))
  }

  private renderList(loading = false) {
    const tabs = h(
      'div',
      { class: 'st-tabs' },
      SORTS.map((s) =>
        h(
          'button',
          {
            class: `st-tab ${!this.mine && this.sort === s.id ? 'st-tab-on' : ''}`,
            on: {
              click: () => {
                this.sort = s.id
                this.mine = false
                sessionStorage.setItem('tanks.store.sort', s.id)
                void this.load(true)
              },
            },
          },
          s.label,
        ),
      ),
      h('button', { class: `st-tab ${this.mine ? 'st-tab-on' : ''}`, title: 'Packs published from this browser', on: { click: () => ((this.mine = true), void this.load(true)) } }, 'My packs'),
      h('div', { class: 'ed-spacer' }),
      h('span', { class: 'st-count' }, loading ? 'Loading…' : `${this.total} pack${this.total === 1 ? '' : 's'}${this.q.trim() ? ` matching “${this.q.trim()}”` : ''}`),
    )
    const grid = h(
      'div',
      { class: 'st-grid' },
      this.items.map((p) => this.card(p)),
    )
    const more =
      this.items.length < this.total
        ? h('div', { class: 'st-more' }, h('button', { class: 'tk-btn', on: { click: () => void this.load(false) } }, 'Load more'))
        : null
    const empty =
      !loading && !this.items.length
        ? h(
            'div',
            { class: 'st-empty' },
            h('div', { class: 'st-empty-ico' }, '📦'),
            h('h2', null, this.mine ? 'You have not published anything yet' : 'No packs found'),
            h('p', null, this.mine ? 'Build a level pack in the editor and press Publish.' : 'Try another search, or be the first to publish one.'),
            h('button', { class: 'tk-btn tk-primary', on: { click: () => this.app.show('editor') } }, 'Open the level editor'),
          )
        : null
    clear(this.main, tabs, empty ?? grid, more)
  }

  private card(p: PackSummary) {
    return h(
      'button',
      { class: 'st-card', on: { click: () => void this.openPack(p.id, p) } },
      h('div', { class: 'st-thumb' }, h('img', { src: thumbnail(p.cover, [], 9), alt: '', loading: 'lazy', draggable: false }), h('span', { class: 'st-levels' }, `${p.levels} level${p.levels > 1 ? 's' : ''}`), p.official ? h('span', { class: 'st-badge' }, 'Official') : null, p.mine ? h('span', { class: 'st-badge st-badge-mine' }, 'Yours') : null),
      h('div', { class: 'st-card-b' }, h('h3', null, p.name), h('div', { class: 'st-by' }, `by ${p.author}`), h('div', { class: 'st-meta' }, stars(p.rating, p.ratings), h('span', { class: 'st-plays', title: 'Times played' }, `▶ ${p.plays}`))),
    )
  }

  // ---- detail ----------------------------------------------------------------------------

  private async openPack(id: string, summary?: PackSummary) {
    if (summary) clear(this.main, h('div', { class: 'st-empty' }, h('p', null, `Loading ${summary.name}…`)))
    try {
      this.detail = await this.api.get(id)
      this.levelIdx = 0
      this.renderDetail()
    } catch (e) {
      const ae = e as ApiError
      if (ae.status === 404) {
        toast(this.root, 'That pack is no longer available', 'error')
        this.detail = null
        void this.load(true)
      } else this.renderError(ae.message, () => void this.openPack(id))
    }
  }

  private renderDetail() {
    const d = this.detail!
    const pack = d.pack
    const lv = pack.levels[this.levelIdx]
    const types = [...new Set(lv.enemies.flatMap((e) => (Array.isArray(e) ? [e[0], e[1]] : e ? [e] : [])))].sort((a, b) => a - b)
    const enemyCount = lv.cells.flat().filter((c) => c >= 400 && c < 412).length
    const picks = h('div', { class: 'st-players' })
    const renderPicks = () =>
      clear(
        picks,
        [1, 2, 3, 4].map((n) =>
          h(
            'button',
            { class: `tk-btn tk-small ${this.players === n ? 'tk-on' : ''}`, title: n > 1 ? `${n} players (players 2-${n} use gamepads)` : '1 player', on: { click: () => ((this.players = n), localStorage.setItem('tanks.store.players', String(n)), renderPicks()) } },
            `${n}P`,
          ),
        ),
      )
    renderPicks()

    const rate = h('div', { class: 'tk-stars', title: d.mine ? 'You cannot rate your own pack' : 'Rate this pack' })
    const renderRate = (mineStars: number) =>
      clear(
        rate,
        [1, 2, 3, 4, 5].map((n) =>
          h(
            'button',
            {
              class: n <= mineStars ? 'tk-lit' : '',
              disabled: d.mine,
              title: `${n} star${n > 1 ? 's' : ''}`,
              on: {
                click: async () => {
                  try {
                    const r = await this.api.rate(d.id, n)
                    d.myRating = n
                    d.rating = r.rating
                    d.ratings = r.ratings
                    renderRate(n)
                    clear(ratingBox, stars(d.rating, d.ratings))
                    toast(this.root, 'Thanks for rating!', 'ok')
                  } catch (e) {
                    toast(this.root, (e as Error).message, 'error')
                  }
                },
              },
            },
            '★',
          ),
        ),
      )
    renderRate(d.myRating)
    const ratingBox = h('span', null, stars(d.rating, d.ratings))

    const play = (from: number) => {
      void this.api.play(d.id).catch(() => {})
      unlock('store-play')
      const p: LevelPack = { ...pack, id: d.id }
      playAndReturn(this.app, p, this.players, from, 'store', { id: d.id })
    }

    clear(
      this.main,
      h(
        'div',
        { class: 'st-detail' },
        h(
          'div',
          { class: 'st-d-left' },
          h('button', { class: 'tk-btn tk-small st-d-back', on: { click: () => this.showList() } }, '‹ All packs'),
          h('div', { class: 'st-d-hero' }, h('img', { src: thumbnail(lv.cells, lv.enemies, 26), alt: '' })),
          h(
            'div',
            { class: 'st-d-level' },
            h('b', null, `Level ${this.levelIdx + 1}: ${lv.name}`),
            lv.bonus ? h('span', { class: 'st-chip st-chip-green' }, '+1 life') : null,
            h('span', { class: 'st-chip' }, `${enemyCount} enem${enemyCount === 1 ? 'y' : 'ies'}`),
            types.map((t) => h('span', { class: 'st-chip', style: `--c:${tankType(t).color}` }, h('i', { class: 'st-sw' }), tankType(t).name)),
            lv.description ? h('p', null, lv.description) : null,
          ),
          h(
            'div',
            { class: 'st-d-levels' },
            pack.levels.map((l, i) =>
              h(
                'button',
                { class: `st-lv ${i === this.levelIdx ? 'st-lv-on' : ''}`, title: l.name, on: { click: () => ((this.levelIdx = i), this.renderDetail()) } },
                h('img', { src: thumbnail(l.cells, l.enemies, 5), alt: '', loading: 'lazy' }),
                h('span', null, `${i + 1}. ${l.name}`),
              ),
            ),
          ),
        ),
        h(
          'aside',
          { class: 'st-d-right' },
          h('h2', null, pack.name),
          h('div', { class: 'st-by' }, `by ${d.author}`, d.official ? h('span', { class: 'st-badge st-badge-inline' }, 'Official') : null),
          h('div', { class: 'st-meta' }, ratingBox, h('span', { class: 'st-plays' }, `▶ ${d.plays} play${d.plays === 1 ? '' : 's'}`), h('span', { class: 'st-date', title: new Date(d.updated).toLocaleString() }, relTime(d.created))),
          pack.description ? h('p', { class: 'st-desc' }, pack.description) : null,
          h('div', { class: 'st-facts' }, h('span', null, h('b', null, String(pack.levels.length)), ' levels'), h('span', null, h('b', null, String(pack.lives ?? 3)), ' lives')),
          h('div', { class: 'st-box' }, h('div', { class: 'st-box-t' }, 'Players'), picks),
          h('button', { class: 'tk-btn tk-primary st-play', on: { click: () => play(0) } }, '▶ Play'),
          this.levelIdx > 0 ? h('button', { class: 'tk-btn', on: { click: () => play(this.levelIdx) } }, `Play from level ${this.levelIdx + 1}`) : null,
          h('div', { class: 'st-box' }, h('div', { class: 'st-box-t' }, d.myRating ? 'Your rating' : 'Rate it'), rate),
          h(
            'div',
            { class: 'st-actions' },
            h('button', { class: 'tk-btn tk-small', title: 'Copy this pack into the level editor', on: { click: () => this.app.show('editor', { pack, storeId: d.mine ? d.id : undefined }) } }, d.mine ? '✎ Edit' : '✎ Remix in editor'),
            d.mine ? h('button', { class: 'tk-btn tk-small tk-danger', on: { click: () => this.confirmDelete(d) } }, 'Delete') : h('button', { class: 'tk-btn tk-small tk-ghost st-report', on: { click: () => this.reportDialog(d) } }, '⚑ Report'),
          ),
        ),
      ),
    )
  }

  private confirmDelete(d: PackDetail) {
    modal(this.root, 'Delete this pack?', `“${d.name}” will be removed from the store for everyone. Your local draft stays in the editor.`, [
      { label: 'Cancel', kind: 'ghost' },
      {
        label: 'Delete',
        kind: 'danger',
        onClick: async () => {
          try {
            await this.api.remove(d.id)
            toast(this.root, 'Pack deleted', 'ok')
            void this.load(true)
          } catch (e) {
            toast(this.root, (e as Error).message, 'error')
          }
        },
      },
    ])
  }

  private reportDialog(d: PackDetail) {
    const reasons = ['Offensive name or content', 'Broken or unplayable', 'Spam or copy of another pack', 'Other']
    let reason = reasons[0]
    const note = h('textarea', { maxLength: 150, rows: 2, placeholder: 'Anything else? (optional)' })
    modal(
      this.root,
      'Report this pack',
      h(
        'div',
        { class: 'st-report-b' },
        reasons.map((r, i) => h('label', { class: 'tk-check' }, h('input', { type: 'radio', name: 'reason', checked: i === 0, on: { change: () => (reason = r) } }), r)),
        note,
      ),
      [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Send report',
          kind: 'primary',
          onClick: async () => {
            try {
              await this.api.report(d.id, note.value.trim() ? `${reason}: ${note.value.trim()}` : reason)
              toast(this.root, 'Thanks — the pack has been reported', 'ok')
            } catch (e) {
              toast(this.root, (e as Error).message, 'error')
            }
          },
        },
      ],
    )
  }
}

export function createStore(): Screen {
  return new Store()
}
