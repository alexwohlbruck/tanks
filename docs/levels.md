# Level editor and level store

Custom levels use the format in `src/levels/format.ts` (`LevelDef` / `LevelPack`). The
editor makes packs, and the store publishes them.

| piece | files |
|---|---|
| editor screen `editor` | `src/editor/` (`editor.ts` UI, `model.ts` edit operations + undo, `draw.ts` 2D grid / thumbnails, `preview.ts` 3D preview, `classic.ts` disc maps, `storage.ts` drafts, `catalog.ts` tank types / tiles, `ui.ts` + `ui.css` shared DOM kit) |
| store screen `store` | `src/store/` (`store.ts`, `api.ts` client + author identity) |
| shared checks | `src/levels/check.ts` (`checkLevel`, `checkPack`, `normalizePack`, `LIMITS`), used by the editor and the server |
| server | `server/modules/levels.ts` (routes), `server/levels/store.ts` (SQLite), `server/levels/seed.ts` (example packs), `server/levels/ratelimit.ts` |

Both screens are registered in `src/main.ts`. Open them with `app.show('editor')` and
`app.show('store')`. `app.show('editor', { pack })` starts a new draft from a pack.
`app.show('store', { id })` opens a pack's page.

## Editor

- The 2D grid is the editing surface (22 x 17). The real renderer is the live preview: the level is
  loaded into a separate `World` that never ticks, and handed to `app.view.setWorld`. The game's own
  world is not touched, and the next game start takes the view back. While the editor is open, the
  `#stage` element is moved into the preview box, and it is restored on unmount. `V` swaps the preview
  into the large area.
- Tools: brush, line, box (filled or outline), flood fill, eraser and select. Copy, cut and paste
  (with flips) work on the selection. There is mirror symmetry (left-right, top-bottom or both),
  flipping of the whole level or the selection, per-level undo/redo (200 steps), a grid toggle and
  an Alt-click eyedropper. Right-click erases. `?` lists the shortcuts.
- Palette:
  - wood and cork stacks of height 2-8 (codes 101-107 and 201-207), holes (200) and empty floor
  - P1-P4 spawns (300-303). Each one is unique, so placing it again moves it.
  - enemy spawns (400-411). Placing one picks the next free slot, with the selected tank type or a
    random range.
  - special tiles (500-599), shown only when a tile registry exists
- Each enemy slot has a type picker in the right panel. A random range is stored as `[lo, hi]`.
- Tank types and tiles are found with `import.meta.glob` over `src/sim/{stats,tanks,types,tanktypes,tiles}.ts`.
  Any of these exports is read when present:
  - tank types: `tankTypes()`, `TANK_TYPES`, `tankTypeList`, `EXTRA_TANKS` or `extraTankTypes`, with `{ id, name, color }`
  - tiles: `tiles()`, `TILES`, `tileTypes()`, `TILE_TYPES`, `tileList` or `TILE_REGISTRY`, with `{ code | id, name, color, description }`

  Without them, the editor shows the original 9 types and hides the tiles section.
- Packs: add, duplicate, reorder and delete levels; set the pack name, description and starting
  lives. Each level has a name, a description, a bonus-life flag and the P1/P2 start facing.
- Disc maps: any of `P1_00_16_9` to `P1_29_16_9` can replace the current level or be added as a new
  one. It takes the enemies of a chosen mission that uses that map, from the params.json mission table.
  Spawns without a tank in that mission are dropped.
- Checks: `checkLevel` and `checkPack` run live. Errors block test play and publishing; warnings,
  such as a missing P2 spawn, do not.
- Test play: `app.playPack` with 1-4 players, either this level alone or the pack from this level
  on. `playAndReturn` (`src/editor/ui.ts`) watches for the game to return to its idle state (pause
  menu Quit, or Quit after the results), then shows the editor again. The store uses the same
  mechanism.
- Drafts autosave to localStorage, under `tanks.editor.draft.<id>` plus the `tanks.editor.drafts`
  index. Packs can be exported and imported as `.tanks.json`, which is the `LevelPack` JSON. A
  single `LevelDef` can be imported too.

## Store

- Lists packs sorted by new, top rated (Bayesian mean, prior 2 votes of 3 stars) or most played. It
  can search by name or author and page through results. "My packs" lists the packs published from
  this browser.
- A pack's page shows a large top-down view of the selected level, its tank types, every level's
  thumbnail, play for 1-4 players (from level 1 or the selected level), 1-5 star rating, report, and
  "Remix in editor". For your own packs it offers Edit (reopens your draft) and Delete.
- Thumbnails are drawn on the client from the cells (`draw.ts`): the list returns the first level's
  cells as `cover`, and the pack page has every level.

### Identity

There are no accounts. The first time it is needed, the client makes a random 32-byte secret
(`localStorage['tanks.author.token']`) and sends it as `X-Author-Token`. The server stores only
`sha256('tanks-levels:' + token)`. That hash owns published packs, so only this browser can update
or delete them, and it is the voter id for ratings and reports. Without a token, the voter id is the
hashed IP. The display name is required to publish (1-32 characters) and is kept in
`tanks.author.name`.

## API (`/api/levels`)

| method | path | body | notes |
|---|---|---|---|
| GET | `/api/levels?sort=new\|top\|plays&q=&page=0&limit=24[&mine=1]` | | `{ items: PackSummary[], total, page, limit }`; `limit` ≤ 60 |
| GET | `/api/levels/:id` | | `PackSummary + { pack, myRating }` |
| POST | `/api/levels` | `{ pack, author }` | needs a token; 201 `{ id }` |
| PUT | `/api/levels/:id` | `{ pack, author }` | owner only |
| DELETE | `/api/levels/:id` | | owner only |
| POST | `/api/levels/:id/rate` | `{ stars: 1-5 }` | one vote per voter, can be changed; not on your own pack |
| POST | `/api/levels/:id/play` | | counted once per IP and pack per 10 minutes |
| POST | `/api/levels/:id/report` | `{ reason }` | one per voter; 5 reports hide a community pack |

`PackSummary`: `{ id, name, author, description, levels, cover, plays, rating, ratings, created,
updated, official, mine }`.

Errors are `{ error, details? }`:

- 400 bad input
- 401 no token
- 403 not the owner
- 404 not found
- 413 too large
- 422 invalid pack, with `details` listing the `checkPack` messages
- 429 rate limited

Validation runs `checkPack` from `src/levels/check.ts`. It applies `validateLevel`, plus:

- known cell codes only
- unique spawns
- tank types 1-99 or valid ranges
- facing 0-3
- name ≤ 48 and description ≤ 400 characters
- 1-100 levels
- lives 1-99
- at most 512 KB

Packs are stored after `normalizePack`, which keeps only the known fields.

Limits per IP (in memory):

- 120 requests burst, then 240 per minute
- writes: 6 burst, then 6 per minute
- publishes: 5 burst, then 1 every 5 minutes
- votes, plays and reports: 30 per minute

Each identity can own at most 200 packs.

## Data model (SQLite, migration `levels-1`)

- `level_packs(id, name, author, description, owner_hash, data, level_count, cover, plays, rating_sum, rating_count, reports, hidden, seed, created_at, updated_at)`.
  `data` is the normalized pack JSON, and `cover` is the first level's cells.
- `level_ratings(pack_id, voter_hash, stars, at)`, with primary key (pack, voter).
- `level_reports(pack_id, voter_hash, reason, at)`, with primary key (pack, voter).

To moderate, set `hidden = 1` (or `0`) by hand. Reports are in `level_reports`.

## Seeds

At startup, `seedStore()` inserts packs that are missing, keyed by fixed ids:

- `toy-box`: four hand-made levels, committed in `server/levels/seed.ts`
- `classic-highlights`, `classic-gauntlet`, `classic-mazes`: built from the disc's `maps.json` and
  `params.json`. They are read from `public/assets/data`, or from `GAME_DATA_DIR`, and are skipped
  when that data is absent, so no disc data is committed. The server Docker image already copies
  `public/assets/data`.
