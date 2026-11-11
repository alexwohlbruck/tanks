# Development

How the game is built and run: the asset pipeline, local development, releases, render quality and the code layout. For what the game is, see the [README](../README.md).

The game logic is a one-to-one port from the decompilation (RHAE01), rendered with three.js (WebGPU, with a WebGL2 fallback). Every asset is converted from the game disc at build time. Nothing from the disc is committed: the build reads your own disc image and generates `public/assets/` locally.

## Build the assets

Requirements: Python 3 (stdlib only), [`nodtool`](https://github.com/encounter/nod)
on `PATH`, and a static `ffmpeg` for the audio compression step
(`FFMPEG=/path/to/ffmpeg`, default `~/.local/opt/ffmpeg-static/ffmpeg`).

```sh
cp /path/to/your-disc.rvz rom/
tools/extract_rom.sh                    # disc -> build/rom (Yaz0/U8 unpacked)
python3 tools/build_data.py             # maps + TnkGameParam  -> public/assets/data
python3 tools/g3d/build_models.py       # BRRES/BREFF/BTI      -> public/assets/models, effects
python3 tools/ui/build_ui.py            # BRLYT/BRLAN/TPL/BRFNT/BMG -> public/assets/ui
python3 tools/ui/build_shared_textures.py  # medal / VS winner model textures for the result screens
python3 tools/audio/build_audio.py      # BRSAR (SE, sequenced BGM, stems) -> public/assets/audio
python3 tools/audio/compress.py         # WAV -> FLAC (lossless, sample-exact loops)
bun tools/hires/build.ts                # hi-res textures for the high/ultra quality -> public/assets/hires (~1 min)
```

The hi-res step is optional: without `public/assets/hires/` (or for any texture missing from
it) the game uses the disc textures at every quality.

## Run

```sh
bun install
bun run dev          # http://localhost:5300
```

URL options: `?mission=N` start at mission N, `&p2=1` two players, `&gold=1` unlock
missions 21-100 (normally requires the Tanks gold medal), `?webgl` force WebGL2, `?classic` the
original game's screens in a 16:9 picture (also Settings > Classic UI),
`?quality=classic|high|ultra` render quality (see below).

## Releases and deploys

Every push to `main` is checked, given the next version and deployed by GitHub Actions
(`.github/workflows/deploy.yml`, on a self-hosted runner that has the built assets). Versions are
git tags `vMAJOR.MINOR.PATCH` (`tools/release.sh`): a push bumps the patch number; put `[minor]` or
`[major]` in a commit message to bump those, or run the workflow by hand and pick the bump. The
version is built into the client (`src/version.ts`, shown on the title screen) and the server
(`/api/health`, `/api/online`); a title screen left open across a deploy offers a reload.
Pull requests run the same checks without deploying. `tools/deploy.sh` still deploys a checkout by
hand.

## Render quality

`app.view.setQuality('classic' | 'high' | 'ultra', overrides?)` (`src/render/quality.ts`):

| quality | what |
|---|---|
| `classic` | the GX-faithful port: disc textures, GX lighting equation, decal shadows, MSAA, DPR <= 2 |
| `high` | + hi-res textures (mipmapped, anisotropic), PN-smoothed curved models (turrets, mine, shell, border logs), hi-res effect sprites and tread stamps; same lighting and cost class (phone target) |
| `ultra` | + enhanced lighting (hemisphere + key light, soft specular), real-time PCF shadow maps instead of the decals, supersampled DPR (1.5x, <= 3) |

`overrides` adjusts single options (`{ shadows: false }`, `{ maxPixelRatio: 1 }`, ...). Nothing is
persisted by the renderer. New tank types (ids >= 10) and special floor tiles (codes 500-599)
hook into the renderer through `src/render/registry.ts` (`registerTankVisual`,
`registerTileRenderer`, documented at the top of the file).

Controls: WASD / arrows / left stick to drive (Nunchuk), mouse or right stick to aim
(remote pointer), left click / J / RT to fire (B), right click / Space / E / LT to lay a
mine (A), Esc / Start to pause (+). Player 2 uses a gamepad.

## Layout

| path | what |
|---|---|
| `src/sim/` | game logic ported from `build/decomp/src/Pack/RPParty/RPTnkScene` (physics, AI, shells, mines, blocks, RNG, BGM mixing) |
| `src/game.ts` | `RPTnkGameManager` state machine, stats, stage selection |
| `src/render/` | three.js scene: converted models with GX-equivalent TSL materials, tread-mark capture, nw4r particle effects |
| `src/ui/` | NW4R layout runtime and the Tanks layouts (`RPTnkLyt*`), the original's shared screens |
| `src/audio/` | WebAudio playback, layered BGM stems with the original track masks |
| `tools/` | asset pipeline (see above) and dev scripts (`tools/dev/`) |
| `docs/` | format notes and specs: `rom-notes.md`, `research.md`, `game-logic.md`, `models.md`, `ui.md`, `audio.md` |

Dev pages: `/uitest.html` (layouts over a reference screenshot), `/effects.html`
(particle effects), `/assets/ui/preview.html` (layout gallery).
Headless checks: `bun tools/dev/simtest.ts` (missions 1-20 in the simulation),
`node tools/dev/play.mjs <out.png> <url> <script>` (scripted browser session),
`node tools/hires/shots.mjs tools/hires/checks/<qualities|zoom|players|perf>.mjs` (render
quality screenshots, 4 players + registry hooks, per-quality draw calls / frame time).
