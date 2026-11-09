# Architecture

## Client (`src/`)

| area | files | notes |
|---|---|---|
| app shell | `src/app/app.ts`, `router.ts`, `session.ts`, `types.ts` | `App` owns the 60 Hz loop, renderer, audio, input; `AppContext` is what screens get |
| screens | register with `registerScreen(id, factory)` (`src/app/router.ts`) | DOM overlays in `#screens`; `opaque` hides the 3D view, `modal` takes input from the game |
| sessions | `Session.step(pads)` | `LocalSession` (1-4 local players); online play adds a network session |
| game flow | `src/game.ts` | port of `RPTnkGameManager`; `newGame(players 1-4, start, seed, pack)` — `pack` = custom levels |
| simulation | `src/sim/` | port of the decomp; deterministic 60 Hz; players 0-3, enemies `TEAM_ENEMY` (9), weapon owner slots players 0-3 / enemies 4+ |
| levels | `src/levels/format.ts` | `LevelDef` / `LevelPack`; cell codes as the disc maps + 300-303 players, 400-411 enemy slots, 500-599 special tiles |
| level editor / store | `src/editor/`, `src/store/`, `src/levels/check.ts` | screens `editor` and `store`; see `docs/levels.md` |
| render | `src/render/` | three.js WebGPU (WebGL2 fallback), TSL materials, nw4r effects; `quality.ts` presets (`SceneView.setQuality`), `registry.ts` hooks for new tank types / tiles, `hires.ts` + `tools/hires/` hi-res textures |
| original UI | `src/ui/` | NW4R layout runtime + Tanks layouts + Wii Play shared screens (classic UI) |
| web UI | `src/ui/web/` | screens `title`, `menu`, `settings`, `pause`, `results`, `credits`; attract-mode `DemoSession`; settings (`tanks.settings`); vector text + texture upscaling for the layouts |
| audio | `src/audio/` | WebAudio; layered BGM stems with track masks |

### Front ends

- **Modern** (default): the stage fills the window at any aspect (`SceneView.resize(w, h, true)`:
  `ORTHO_FIT` stays in view, layout space scales by the short side so 608x456 always fits);
  the pointer is cast through the camera onto the turret plane; layouts render at device
  resolution with the M+ 1 web font (`public/fonts`, SIL OFL). The game manager's end flow
  opens `results` via `UiPresenter.web`; Esc / P / Start (or the touch pause button) opens
  `pause` in local play. The menu enables Online / Level Editor / Community Levels / Tanks+
  when the screens `lobby` / `editor` / `store` / `tanksplus` are registered.
- **Classic** (Settings > Classic Wii UI, or `?classic`): the 16:9 TV picture with Wii Play's
  pre-game, pause and result screens and bitmap fonts (`src/ui/hud.ts`, `src/ui/shared`).

## Server (`server/`)

Bun: `bun server/index.ts` (dev: `bun run server`, vite proxies `/api` and `/ws`).
Modules (`server/modules/*.ts`, imported from `server/modules/index.ts`) call `register({ name, http, ws })`:
`http` handles `/api/...`, `ws` serves `/ws/<name>`. SQLite via `server/db.ts` (`migrate(name, sql)`).
Modules: `levels` (`/api/levels`, community level store, `docs/levels.md`).
The server can import the simulation (`src/game.ts`, `src/sim`, `src/levels`) — they are DOM-free.

## Deploy

`DEPLOY_HOST=… PROXY_NETWORK=… tools/deploy.sh`: static site (nginx `tanks`) + game server
(`tanks-api`, built from `server/Dockerfile`, SQLite in `<DEPLOY_DIR>/data`). The reverse proxy
routes `/api/*` and `/ws/*` to `tanks-api:3001`, everything else to `tanks:80`.
