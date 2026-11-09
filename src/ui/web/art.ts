// Vector art for the web screens: the Tanks! logo, toy tank icons in the game's tank colours,
// and the party medals.

import { svg } from './dom'

/** enemy types 1-9 (RPTnkTank colours: tank_brown, _ash, _marin, _yellow, _pink, _green, _purple, _white, _black) */
export const TANK_TYPES: { name: string; body: string; dark: string }[] = [
  { name: 'Player', body: '#3d7fe0', dark: '#1d4c97' },
  { name: 'Brown', body: '#9a6a3c', dark: '#5e3c1c' },
  { name: 'Grey', body: '#8f9399', dark: '#55595f' },
  { name: 'Teal', body: '#2fa5a0', dark: '#196560' },
  { name: 'Yellow', body: '#e8c33a', dark: '#9b7d14' },
  { name: 'Red', body: '#e2575f', dark: '#932a31' },
  { name: 'Green', body: '#5bb046', dark: '#2f6b22' },
  { name: 'Purple', body: '#9a5ac9', dark: '#5c2f82' },
  { name: 'White', body: '#f3f1ea', dark: '#9d9a90' },
  { name: 'Black', body: '#3a3a3e', dark: '#141416' },
]

export const PLAYER_COLORS = [
  { body: '#3d7fe0', dark: '#1d4c97' },
  { body: '#e2464e', dark: '#8e1f25' },
  { body: '#4caf50', dark: '#25672a' },
  { body: '#f0b52f', dark: '#99700d' },
]

export function tankStyle(type: number) {
  return TANK_TYPES[type] ?? { name: `Type ${type}`, body: '#b9b3a6', dark: '#6b665c' }
}

/** a side-view toy tank (like the result list's msy_tankCmn icon) */
export function tankIcon(body: string, dark: string, cls = 'tank-icon') {
  return svg(`<svg class="${cls}" viewBox="0 0 64 40" aria-hidden="true">
    <path d="M30 9h16a3 3 0 0 1 3 3v1H30z" fill="${dark}"/>
    <rect x="45" y="10.5" width="17" height="4.5" rx="2" fill="${dark}"/>
    <path d="M16 13a5 5 0 0 1 5-5h12a5 5 0 0 1 5 5v5H16z" fill="${body}" stroke="${dark}" stroke-width="2.2"/>
    <path d="M6 19h52l-4 7H10z" fill="${body}" stroke="${dark}" stroke-width="2.2" stroke-linejoin="round"/>
    <rect x="4" y="25" width="56" height="11" rx="5.5" fill="${dark}"/>
    <g fill="${body}" opacity=".9"><circle cx="11" cy="30.5" r="3"/><circle cx="20.5" cy="30.5" r="3"/><circle cx="30" cy="30.5" r="3"/><circle cx="39.5" cy="30.5" r="3"/><circle cx="49" cy="30.5" r="3"/><circle cx="56" cy="30.5" r="2.2"/></g>
    <path d="M18 13.5a3 3 0 0 1 3-3h7" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="2" stroke-linecap="round"/>
  </svg>`)
}

export const MEDALS = [
  { name: 'Bronze', a: '#f0b98a', b: '#a5612e', c: '#6e3a15' },
  { name: 'Silver', a: '#f6f8fb', b: '#a7b0bb', c: '#5d6670' },
  { name: 'Gold', a: '#fff3a6', b: '#e1a823', c: '#8d5f06' },
  { name: 'Platinum', a: '#ffffff', b: '#bfe3ec', c: '#5d8a98' },
]

let medalId = 0
/** medal 1-4 (bronze, silver, gold, platinum); 0 draws an empty slot */
export function medalIcon(m: number, cls = 'medal-icon') {
  if (!m) return svg(`<svg class="${cls} none" viewBox="0 0 64 80" aria-hidden="true"><circle cx="32" cy="48" r="24" fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="6 5" opacity=".45"/></svg>`)
  const c = MEDALS[m - 1]
  const id = `md${medalId++}`
  return svg(`<svg class="${cls}" viewBox="0 0 64 80" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.a}"/><stop offset=".55" stop-color="${c.b}"/><stop offset="1" stop-color="${c.c}"/></linearGradient></defs>
    <path d="M16 0h12l8 26H24z" fill="#d23038"/><path d="M48 0H36l-8 26h12z" fill="#2f6fd0"/>
    <circle cx="32" cy="50" r="25" fill="url(#${id})" stroke="${c.c}" stroke-width="2.5"/>
    <circle cx="32" cy="50" r="18" fill="none" stroke="${c.a}" stroke-opacity=".8" stroke-width="2"/>
    <path d="M32 37.5l3.9 7.9 8.7 1.3-6.3 6.1 1.5 8.7-7.8-4.1-7.8 4.1 1.5-8.7-6.3-6.1 8.7-1.3z" fill="${c.a}" stroke="${c.c}" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`)
}

/** the Tanks! wordmark on a red mission band */
export function logo() {
  return svg(`<svg class="logo" viewBox="0 0 520 190" role="img" aria-label="Tanks!">
    <defs>
      <pattern id="lg-diamonds" width="22" height="22" patternUnits="userSpaceOnUse"><path d="M11 0l11 11-11 11L0 11z" fill="#000" fill-opacity=".09"/></pattern>
      <linearGradient id="lg-band" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#df3a40"/><stop offset="1" stop-color="#b51d25"/></linearGradient>
      <linearGradient id="lg-text" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fffdf5"/><stop offset="1" stop-color="#ffe7b0"/></linearGradient>
    </defs>
    <g transform="rotate(-3 260 100)">
      <rect x="8" y="58" width="504" height="96" rx="10" fill="#7b1016" transform="translate(4 7)" opacity=".35"/>
      <rect x="8" y="58" width="504" height="96" rx="10" fill="url(#lg-band)"/>
      <rect x="8" y="58" width="504" height="96" rx="10" fill="url(#lg-diamonds)"/>
      <rect x="15" y="64" width="490" height="84" rx="6" fill="none" stroke="#ffd9c0" stroke-opacity=".55" stroke-width="2.5"/>
      <text x="260" y="134" text-anchor="middle" font-family="'Tanks Sans', sans-serif" font-weight="900" font-size="104" letter-spacing="2"
        fill="url(#lg-text)" stroke="#5a1408" stroke-width="13" stroke-linejoin="round" paint-order="stroke">Tanks!</text>
    </g>
  </svg>`)
}

/** small icons for buttons */
export const ICONS: Record<string, string> = {
  campaign: '<path d="M5 21V4m0 0h11l-2 4 2 4H5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  online: '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M3.5 12h17M12 3.5c3 3 3 14 0 17M12 3.5c-3 3-3 14 0 17" fill="none" stroke="currentColor" stroke-width="2"/>',
  editor: '<path d="M4 20l1-5L15.5 4.5a2.1 2.1 0 0 1 3 0l1 1a2.1 2.1 0 0 1 0 3L9 19z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M13.5 6.5l4 4" stroke="currentColor" stroke-width="2.2"/>',
  store: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2.2"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2.2"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2.2"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" fill="currentColor"/>',
  settings: '<path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  credits: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 11v6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="7.5" r="1.5" fill="currentColor"/>',
  back: '<path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
  play: '<path d="M7 4.5v15l13-7.5z" fill="currentColor"/>',
  restart: '<path d="M5 12a7 7 0 1 0 2.1-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M6 2.5V7.5h5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  home: '<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" fill="none" stroke="currentColor" stroke-width="2.2"/>',
}

export function icon(name: keyof typeof ICONS | string) {
  return svg(`<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ''}</svg>`)
}
