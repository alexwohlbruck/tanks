// Versus arenas (22 x 17, the custom level grid). Shared by the server (which loads them) and
// the lobby (which lists them).
//   .  empty         #  wood stack (202)     w  low wood (201)    c  cork (101, mines break it)
//   o  hole (200)    1-4  player spawns     e  AI tank spawn slots, in reading order

export type Arena = { name: string; rows: string[] }

export const ARENAS: Arena[] = [
  {
    name: 'Crossroads',
    rows: [
      '......................',
      '.1..................2.',
      '......................',
      '...##............##...',
      '...#..............#...',
      '..........cc..........',
      '......#........#......',
      '......#...ee...#......',
      '....cc....##....cc....',
      '......#...ee...#......',
      '......#........#......',
      '..........cc..........',
      '...#..............#...',
      '...##............##...',
      '......................',
      '.3..................4.',
      '......................',
    ],
  },
  {
    name: 'Pillars',
    rows: [
      '......................',
      '.1..................2.',
      '......................',
      '...#...#......#...#...',
      '......................',
      '......................',
      '...#...#..e...#...#...',
      '......................',
      '..oo....e....e....oo..',
      '......................',
      '...#...#...e..#...#...',
      '......................',
      '......................',
      '...#...#......#...#...',
      '......................',
      '.3..................4.',
      '......................',
    ],
  },
  {
    name: 'Cork Maze',
    rows: [
      '......................',
      '.1.......cc.........2.',
      '.........cc...........',
      '..cccc..........cccc..',
      '......................',
      '.....ww...e....ww.....',
      '.....w..........w.....',
      '..c.......cc.......c..',
      'cccc....e.##.e....cccc',
      '..c.......cc.......c..',
      '.....w..........w.....',
      '.....ww....e...ww.....',
      '......................',
      '..cccc..........cccc..',
      '...........cc.........',
      '.3.........cc.......4.',
      '......................',
    ],
  },
]

const CODES: Record<string, number> = { '.': 0, '#': 202, w: 201, c: 101, o: 200, '1': 300, '2': 301, '3': 302, '4': 303 }

/** cell codes of an arena; `ai` = how many of its AI spawn slots to keep (400 + k) */
export function arenaCells(index: number, ai: number): { cells: number[][]; slots: number } {
  const a = ARENAS[((index % ARENAS.length) + ARENAS.length) % ARENAS.length]
  let k = 0
  const cells = a.rows.map((row) =>
    [...row].map((ch) => {
      if (ch !== 'e') return CODES[ch] ?? 0
      const slot = k++
      return slot < ai ? 400 + slot : 0
    }),
  )
  return { cells, slots: Math.min(ai, k) }
}
