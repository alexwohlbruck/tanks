# Tanks! (Wii Play) — web port

A one-to-one port of the *Tanks!* minigame from Wii Play (RHAE01) to the browser:
three.js with the WebGPU renderer (WebGL2 fallback), the original game logic ported
from the Wii Play decompilation, and every asset converted from the game disc.

Nothing from the disc is committed. The build reads your own disc image and
generates `public/assets/` locally.

## Build the assets

Requirements: Python 3 (stdlib only), [`nodtool`](https://github.com/encounter/nod)
on `PATH`, and a static `ffmpeg` for the audio compression step
(`FFMPEG=/path/to/ffmpeg`, default `~/.local/opt/ffmpeg-static/ffmpeg`).

```sh
cp "Wii Play (USA).rvz" rom/
tools/extract_rom.sh                    # disc -> build/rom (Yaz0/U8 unpacked)
python3 tools/build_data.py             # maps + TnkGameParam  -> public/assets/data
python3 tools/g3d/build_models.py       # BRRES/BREFF/BTI      -> public/assets/models, effects
python3 tools/ui/build_ui.py            # BRLYT/BRLAN/TPL/BRFNT/BMG -> public/assets/ui
python3 tools/ui/build_shared_textures.py  # medal / VS winner model textures for the result screens
python3 tools/audio/build_audio.py      # BRSAR (SE, sequenced BGM, stems) -> public/assets/audio
python3 tools/audio/compress.py         # WAV -> FLAC (lossless, sample-exact loops)
```

## Run

```sh
bun install
bun run dev          # http://localhost:5300
```

URL options: `?mission=N` start at mission N, `&p2=1` two players, `&gold=1` unlock
missions 21-100 (normally requires the Tanks gold medal), `?webgl` force WebGL2.

Controls: WASD / arrows / left stick to drive (Nunchuk), mouse or right stick to aim
(Wii Remote pointer), left click / J / RT to fire (B), right click / Space / E / LT to lay a
mine (A), Esc / Start to pause (+). Player 2 uses a gamepad.

## Layout

| path | what |
|---|---|
| `src/sim/` | game logic ported from `build/decomp/src/Pack/RPParty/RPTnkScene` (physics, AI, shells, mines, blocks, RNG, BGM mixing) |
| `src/game.ts` | `RPTnkGameManager` state machine, stats, stage selection |
| `src/render/` | three.js scene: converted models with GX-equivalent TSL materials, tread-mark capture, nw4r particle effects |
| `src/ui/` | NW4R layout runtime and the Tanks layouts (`RPTnkLyt*`), Wii Play shared screens |
| `src/audio/` | WebAudio playback, layered BGM stems with the original track masks |
| `tools/` | asset pipeline (see above) and dev scripts (`tools/dev/`) |
| `docs/` | format notes and specs: `rom-notes.md`, `research.md`, `game-logic.md`, `models.md`, `ui.md`, `audio.md` |

Dev pages: `/uitest.html` (layouts over a reference screenshot), `/effects.html`
(particle effects), `/assets/ui/preview.html` (layout gallery).
Headless checks: `bun tools/dev/simtest.ts` (missions 1-20 in the simulation),
`node tools/dev/play.mjs <out.png> <url> <script>` (scripted browser session).
