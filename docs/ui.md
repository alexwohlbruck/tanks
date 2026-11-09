# Tanks! 2D / UI assets

Build: `python3 tools/ui/build_ui.py` (python3 stdlib only, ~5 s). It reads `build/rom/x` and writes
`public/assets/ui/` (gitignored, generated). Options: `--rom DIR`, `--out DIR`.

Preview: serve `public/assets/ui/` over HTTP (`python3 -m http.server -d public/assets/ui 8000`) and open
`preview.html`. Modes:

- `preview.html?layout=tnkUI_00&anims=tnkUI_00_in_00&frame=20` shows one layout with anim checkboxes, a frame slider and play (60 fps). You can toggle the US text bindings, pane bounds and alpha inheritance.
- `preview.html?gallery=tanks` / `?gallery=shared` renders every Tanks layout, or the shared Tanks-flow layouts, at a representative animation frame. `&scale=0.5` shrinks the output.

## Tools (`tools/ui/`)

| file | purpose |
|---|---|
| `build_ui.py` | entry point; archive list, output layout, manifest |
| `png.py` | minimal PNG encoder (zlib, filter 0; gray / GA / RGB / RGBA) |
| `gx.py` | GX texture decoders: I4 I8 IA4 IA8 RGB565 RGB5A3 RGBA8 C4 C8 C14X2 (IA8/RGB565/RGB5A3 palettes) CMPR |
| `tpl.py` | TPL container (multi-image, palettes, wrap/filter/LOD) |
| `brlyt.py` | BRLYT v8 → dict |
| `brlan.py` | BRLAN v8 (pai1) → dict |
| `brfnt.py` | BRFNT (FINF/TGLP/CWDH/CMAP) → atlas + metrics |
| `bmg.py` | BMG (INF1/DAT1/MID1, UTF-16BE, 0x1A tags) → dict |
| `tanks_text.py` | Tanks message list, pane→message text bindings, layout descriptions |
| `preview.html` | canvas renderer, copied into the output |

Sources: `US/RPTnkScene/local/tank` (identical to `US/RPTnkScene/tank`), plus shared archives
`US/PartyStatic/local/{pause,ptPauseText,messageWindow,myRecord,ptVsResult,AButton,cCursorCircle,cPadCursor,leadCursor}`,
`US/RPCommon/local/{backCommon,menuCommon,nunchukCheck,playAdvice,playerSelect,rimoconEntry}`,
`US/RPPartyCommon/local/ptSelectGame`. `RPPartyCommon/menuCommon` is byte-identical to `RPCommon/menuCommon`,
so it is emitted once. The builder converts everything in those archives: 45 layouts, 181 animations and every TPL.
The partial ROM extract has no `.bmg` inside the archives, so only `party_message.bmg` and `common_message.bmg` are used.

## Output (`public/assets/ui/`)

```
index.json                       manifest: canvas, layouts{name:{file,archive,group,anims[],purpose}}, fonts, archives
textures/<archive>/<tpl>.png      one PNG per TPL image (2nd+ images: <tpl>_<i>.png)
textures/index.json               {archive:{"x.tpl":{width,height,format,wrapS,wrapT,minFilter,magFilter,lodBias,minLod,maxLod,palette?,file}}}
layouts/<layout>.json             BRLYT
anims/<anim>.json                 BRLAN
fonts/<font>.png + .json          glyph atlas + metrics
messages/party_message.json       full BMG dumps
messages/common_message.json
messages/tanks.json               curated Tanks message subset {idHex:{text,use,tags?}}
preview.html
```

### Texture PNGs

PNGs are RGBA with **GX channel semantics**. I4/I8 are written as (I,I,I,I), so alpha equals intensity.
IA4/IA8 are written as (I,I,I,A). The PNGs therefore hold the texel values the TEV sees, and a renderer can
apply material colours the same way the Wii does (see Rendering). Wrap modes are `clamp|repeat|mirror`.

### Layout JSON

```jsonc
{
  "version": 8, "name": "tnkUI_00", "archive": "tank", "source": "US/RPTnkScene/local/tank/blyt/tnkUI_00.brlyt",
  "layout": {"drawFromCenter": true, "width": 608, "height": 456},   // canvas, origin at centre, +y up
  "textures": ["msy_balloon_00.tpl", ...], "textureFiles": ["textures/tank/msy_balloon_00.png", ...],
  "fonts": ["pac_nRodEb_32_I4.brfnt", ...],  "fontFiles": ["fonts/pac_nRodEb_32_I4.json", ...],
  "materials": [{
     "name", "tevColors": [C0 "black", C1 "white", C2] (s16 RGBA), "konstColors": [4×RGBA],
     "flags": "0x…",                                   // raw MaterialResourceNum bitfield
     "texMaps": [{"texture": idx, "wrapS", "wrapT", "minFilter", "magFilter"}],
     "texSRT": [{"translate":[s,t], "rotate":deg, "scale":[s,t]}],
     "texCoordGens": [{"type":"mtx2x4", "src", "mtx"}],
     "chanCtrl"?: {"colorSrc","alphaSrc"}, "materialColor": RGBA,
     "tevSwapTable"?, "indTexSRT"?, "indTexStages"?,
     "tevStages"?: [{"texCoord","colorChan","texMap","rasSwap","texSwap",
                     "color":{"a","b","c","d","op","bias","scale","clamp","outReg","konstSel"}, "alpha":{…}, "ind":{…}}],
     "alphaCompare"?: {"comp0","ref0","op","comp1","ref1"},
     "blendMode"?: {"type","src","dst","logicOp"}
  }],
  "root": {                                           // pane tree (pas1/pae1 nesting resolved)
     "type": "pan|pic|txt|wnd|bnd", "name", "userData"?,
     "visible", "influencedAlpha", "locationAdjust",
     "origin": 0-8, "originName": "top-left … bottom-right",   // basePosition: H = origin%3, V = origin/3
     "alpha": 0-255, "translate":[x,y,z], "rotate":[x,y,z] (deg), "scale":[x,y], "size":[w,h],
     // pic1:
     "vertexColors": [TL,TR,BL,BR], "material": idx, "texCoords": [[TL,TR,BL,BR] per texcoord set]  ([s,t] each)
     // txt1:
     "material", "font": idx, "text", "textBufBytes", "textStrBytes",
     "textPosition": 0-8, "textPositionName", "textAlignment",
     "topColor", "bottomColor", "fontSize":[w,h], "charSpace", "lineSpace",
     // wnd1:
     "inflation": {"l","r","t","b"}, "content": {"vertexColors","material","texCoords"},
     "frames": [{"material", "flip": "none|h|v|rot90|rot180|rot270"}],
     "children": [...]
  },
  "groups": {"name": "RootGroup", "panes": [...], "children": [...]},     // grp1 / grs1 / gre1
  "purpose"?: "…", "textBindings"?: {"<pane>": {"msg": "0x000b5d00", "args": [1]} | {"text": "P1"}}
}
```

`textBindings` contain the US strings the game writes into the panes at runtime. The `text` stored in the
BRLYT is only an editor placeholder, often in Italian, Spanish, German or Japanese.

### Animation JSON

```jsonc
{ "version": 8, "name": "tnkfade_inMission_00", "layout": "tnkfade", "frameSize": 16, "loop": false,
  "textures": [...], "textureFiles": [...],          // for RLTP: value indexes this list
  "entries": [{ "name": "N_msg_00", "kind": "pane|material",
     "tags": [{ "type": "RLPA|RLVC|RLMC|RLTS|RLTP|RLVI|RLIM",
        "targets": [{ "index": n, "target": t, "targetName": "scaleX", "curve": "hermite|step",
                      "keys": [[frame, value, slope], ...] /* step: [frame, value] */ }] }] }] }
```

Target names by tag:

- RLPA: transX/Y/Z, rotX/Y/Z, scaleX/Y, sizeW/H.
- RLVC: tlR..brA (corner vertex colours; on txt1, TL/TR map to the top colour and BL/BR to the bottom colour), plus `alpha` (16) for the pane alpha.
- RLMC: matRGBA, c0, c1, c2, k0..k3.
- RLTS: transS/T, rotate, scaleS/T. `index` selects the texSRT.
- RLTP: texture, applied to texMap `index`.
- RLVI: visible.

Evaluation follows nw4r:

- Before the first key, use the first value. After the last key, use the last value.
- Hermite segments use `v = h00·v0 + h10·d·s0 + h01·v1 + h11·d·s1` with `d = f1 − f0`. Two keys on the same frame create a jump.
- Step curves hold each value until the next key.
- Non-looping animations clamp to `frameSize − 1`.

Multiple animations can be bound together, for example `tnkfade_loop_00` with `tnkfade_inMission_00`.

### Font JSON + PNG

```jsonc
{ "name", "version", "fontType", "encoding": "UTF-16",
  "lineFeed", "width", "height", "ascent", "alterCharIndex", "defaultWidth": {left, glyphWidth, charWidth},
  "cellWidth", "cellHeight", "baseline", "maxCharWidth",
  "sheet": {count, format, compressed, cols, rows, width, height, bytes},       // original TGLP layout
  "atlas": {width, height, sheetsPerRow}, "image": "fonts/x.png",
  "cmapBlocks": [{begin, end, method: "direct|table|scan"}],
  "glyphs": {"<codepoint>": {index, sheet, x, y, left, glyphWidth, charWidth}} }
```

Sheets are repacked into a near-square grid. A glyph's cell is `(x, y, glyphWidth, cellHeight)` in the atlas;
in the original sheet each cell is `(cellWidth+1) × (cellHeight+1)`. Text scale is `fontSize / (width, height)`.
The advance is `charWidth·sx + charSpace`, the glyph is drawn at `cursor + left·sx`, and the line height is
`lineFeed·sy + lineSpace`.

| font | format | cell | baseline | ascent | lineFeed | glyphs | used by |
|---|---|---|---|---|---|---|---|
| pac_nRodDb_32_I4 | I4 | 25×30 | 24 | 25 | 32 | 530 (incl. button icons U+E040–E06B, ㌧ U+3327 = Nunchuk stick, kana, Greek) | menus, tnkEx_00, pause, select screens |
| pac_nRodDb_32_IA4 | IA4 | 27×29 | 22 | 26 | 35 | 281 | tnkHit_00 |
| pac_nRodDb_62_IA4 | IA4 | 51×55 | 44 | 52 | 66 | 281 | myRecord, ptVsResult |
| pac_nRodEb_32_I4 | I4 | 25×26 | 21 | 26 | 33 | 281 | tnkUI/tnkResult/tnkMsg_02 small text |
| pac_nRodEb_70_IA4 | IA4 | 53×55 | 43 | 53 | 70 | 281 | all big Tanks banners |

The sheets are alpha masks. In I4 sheets, I = coverage. In IA4 sheets, A = coverage and I = interior shading:
the outline is dark and the fill is light. The material maps the result to colour (see Rendering).

### Message JSON

`messages/<bmg>.json` = `{encoding, entrySize, groupId, midFormat, source, messages:[{index, id, idHex, text, attributes, tags?}]}`.
`attributes` is the raw INF1 entry tail (8 bytes, hex). Byte 5 varies per message (0x28–0x82) and looks
like a default text scale in percent. Bytes 0–3 are 0x3e7 on system dialogs.

Inline tags are UTF-16 `0x001A`, then `u8 size` (whole tag in bytes), `u8 group`, `u16 id` and `size−6` bytes of params.
Each tag is replaced in `text` with a placeholder and kept verbatim in `tags[]` (`pos`, `group`, `id`, `params`, `raw`):

| raw bytes | placeholder | meaning |
|---|---|---|
| `00 1A 06 00 00 00` | `{num}` | number substitution (%d), e.g. "Mission {num}", "Enemy tanks: {num}", "{num} tanks" |
| `00 1A 06 00 00 01` | `{player}` | player / Mii name |
| `00 1A 08 02 00 00 pp pp` | `{win:0:pppp}` | message-window auto-advance delay in frames (inferred) |
| `00 1A 08 02 00 01 pp pp` | `{win:1:pppp}` | Yes/No choice; param = default selection (inferred) |
| `00 1A 08 02 00 02 pp pp` | `{win:2:pppp}` | choice variant (inferred) |
| `00 1A 08 02 00 03 00 00` | `{win:3:0000}` | left-aligned / indented message box text (inferred) |

No colour, size or ruby tags appear in the US Wii Play BMGs. A decoder would emit `{color:n}`, `{size:n}`
or `{ruby:…}` for group 0 ids 3, 2 and 0 with params.
Private-use glyphs in the font: U+E041 = +Control Pad, U+E042 = A Button, U+E043 = B Button, U+E045 = + Button,
U+E047/U+E048 = 1/2 Buttons, and U+3327 (㌧) = Nunchuk Control Stick.

## Rendering (what preview.html implements)

- **Coordinates.** Layout space is centred with +y up. A pane's local matrix is `T(translate) · Rz · S(scale)`, relative to the parent's translate point. rotX and rotY are approximated as cos-scales. The pane rectangle is placed by `origin`: x from `−w·(H/2)`, top at `+h·(V/2)`.
- **Alpha** follows nw4r `Pane::CalculateMtx` (`build/decomp/src/nw4r/lyt/lyt_pane.cpp`). A pane's drawn alpha is `alpha × inherited`. A pane with the `influencedAlpha` flag (res flag bit 1) and alpha != 255 multiplies its own alpha into the value its children inherit. Panes without the flag pass the inherited value through unchanged. The Tanks null panes that fade whole groups (`N_tnk_00`, `N_msg_00`, `N_life_00`, …) all have flag 0x03, so the flag is what makes those fades work. `DrawInfo`'s own influencedAlpha stays false; RPSysLayout never sets it.
- **Material (default TEV, no tevStages, which is the case for every material here).** `out = lerp(C0, C1, tex) × vertexColour × materialColour`, per channel including alpha. An untextured material sees tex = white, so its colour is C1 times the vertex colour. For example, window content uses C1 as the fill and `C1 = (0,0,0,0)` makes it invisible. `tnkfade P_loop_00` has an explicit stage with the same formula.
- **Texture coordinates.** texCoords are bilinear over the quad, then the texSRT matrix is applied about (0.5, 0.5), then the wrap mode.
- **Text.** Each glyph uses the same formula with tex = the font sheet texel, and the vertex colour is a vertical gradient from `topColor` to `bottomColor`. `textPosition` places the text block inside the pane rect, and each line is aligned horizontally by `textPosition % 3`.
- **Windows.** With one frame, the frame texture is the top-left corner and is mirrored for TR (h), BL (v) and BR (both). Edges stretch the corner's inner column or row. Content fills the interior plus `inflation`.
- **Animation binding.** The game seldom binds an animation to the whole layout. It usually calls `RPSysLayout::bindAnmObjToPane(anm, "<pane>", true)`, which animates only that pane's subtree and the materials those panes use. The other entries in the BRLAN are ignored. For example, `tnkfade_inMission_00` contains tracks for N_bonus, N_life and others, but the game binds it to `N_msg_00` only. The preview's `applyAnim(L, A, frame, bindPane)` implements this, and each gallery scene lists its binding. Several animations stay bound at once, each with its own frame counter (60 fps). One-shot animations stop on `frameSize − 1`; loop animations wrap.
- **Runtime state.** Code drives some state that the layouts and animations do not contain:
  - `SetVisible` for the 1P/2P variants (see the per-layout notes).
  - The `pause_00` / `ptGOMenu_00` / `playAdvice_00` `N_center_00` alpha, which is faded by code (`SetAlpha`).
  - Balloon placement.
  - Number text, written with `RPSysStringUtility::GetStringFullSizeNumber`. These are full-width digits U+FF10–FF19, except the result totals, which use half-width digits.

  Empty `N_player*` / `N_remoteP_00` panes are mount points: `RPDrawKokeshiIcon` draws the Mii head there, and RPGameInfoLyt reparents `ptG8RemoteH_00`'s `N_remote_00` under `N_remoteP_00`.
- **Not emulated.** `locationAdjust` (16:9 adjustment), multi-texture blending (backButton only), indirect textures, and blend modes other than normal alpha.

## Tanks layouts

All Tanks layouts are 608×456 and use `N_tnk_00` (bottom-centre) as the root container. Runtime behaviour is taken from
the matching decomp (`build/decomp/src/Pack/RPParty/RPTnkScene/RPTnkLyt*.cpp` and `RPTnkGameManager.cpp`).

`RPTnkLayoutManager` owns one instance of each layout, plus 16 `tnkHit_00` instances in a ring buffer, and the
`party_message.bmg` message set.

- The HUD and fade layouts draw every frame.
- `tnkEx_00` draws only on stage 0.
- The game-manager state gates the message layouts:

  | state | layout drawn |
  |---|---|
  | 4 | Start |
  | 6 / 7 | Clear |
  | 8 | Complete |
  | 9 | Failed |
  | 10–12 | Result |

- Draw order: Ex, HUD, Hit popups, the messages, Result, then Fade on top.

Every `setMessage(msg, id, sub, …)` below refers to MID1 id `(id << 8) | sub`.

### Game flow (`RPTnkGameManager`)

1. **Start.** `Fade.Start(bonus=false, fast=true)`.
   - In 1P, the last stage is 19, or 99 once the Gold medal is saved.
   - In 2P, the last stage is 19, and lives are set to 1.
2. **Fade done** (`StateWaitLifeNo`, `StateNextStage`). Wait 165 frames, then go to `StateStageStart`, which does:
   - `Hud.SetShowBalloons(false)`
   - `StartMsg.Play()` (SE 0x23)
   - `Hud.PlayIn()`
   - `ExGuide.Start()` on stage 0
   - then state 4 (play)
3. **All enemies dead.**
   - On the last stage: `CompleteMsg.Show()` + `Hud.PlayOut()`, the effect `Tnk_all_clear`, and BGM 0x3E (stage 20) or 0x3F. Go to state 8.
   - Otherwise: `ClearMsg.Show()` + `Hud.PlayOut()` and the stage-clear BGM. Go to state 6. When `ClearMsg.IsActive()` becomes true (120 frames after the total is shown), call `Fade.Start(bonus = mission bonus flag, false)`.
4. **Player(s) dead.** Lives −1 (both players in 2P).
   - If that was the last life: `FailedMsg.Show()` + `Hud.PlayOut()`, BGM 0x3D, state 9.
   - Otherwise: BGM 0x40, wait 120 frames, then `Fade.Start(false, false)` and retry the same stage.
5. **Complete / Failed active.** `ExMsg.PlayOutAll()` (failed only) and `ResultLyt.Start()`. When the results finish:
   - 1P: medal result (`ptRankGet_00` / `myRecord_00`).
   - 2P: `ptVsWinner`, during which `ResultLyt.ShowTotals()` runs.
   - Then the result menu `ptGOMenu_00` ("Play again" / "Play a different game").

### `tnkfade` — between-mission screen (`RPTnkFade`)

Panes:

- `N_loop_00/P_loop_00` is the scrolling tank-pattern backdrop.
- `N_msg_00` is the red band with `T_mission_00/01` and `T_enemy_00/01`. The `_01` copies are drop shadows.
- `N_msg_01` is the green "Bonus Tank!" ribbon.
- `N_life_00` is the lives row:
  - `N_lifetnk_00` is the 1P tank icon in a balloon, with `T_lifeX_*` "×" and `N_lifeNo_00/T_lifeNo_*`.
  - `N_lifetnk_01` holds the two 2P balloons.
  - `N_player00_00` (1P) and `N_player00_01`/`N_player01_01` (2P) are Mii-head mounts.

Animations, with the pane each one is bound to:

| idx | anim | bound to | mode |
|---|---|---|---|
| 0 | in_00 | whole layout | once (rate 15 when `fast`) |
| 1 | out_00 | `N_loop_00` | once |
| 2 | inLife_00 | `N_life_00` | once |
| 3 | outLife_00 | `N_tnk_00` | once |
| 4 | inBonus_00 | `N_msg_01` | once |
| 5 | outBonus_00 | `N_msg_01` | once |
| 6 | addLife_00 | `N_life_00` | once |
| 7 | addLife_01 | `N_msg_01` | once |
| 8 | inMission_00 | `N_msg_00` | once |
| 9 | inEnemy_00 | `N_enemy_00` | once |
| 10 | loop_00 | `P_loop_00` | loop |

Sequence after `Start(bonus, fast)`:

- **Setup.**
  - 1P: `N_lifetnk_00` is visible and `N_lifetnk_01` is hidden.
  - 2P: the reverse, and `N_lifeNo_00`, `T_lifeX_00` and `T_lifeX_01` are also hidden.
  - Timer = 150 with a bonus, else 4. `in_00` and `loop_00` start.
- **When `in_00` ends.** `SetStageReady`, which loads the stage behind the fade. `inLife_00` starts on `N_life_00`. With a bonus, `inBonus_00` also starts on `N_msg_01` (SE 0x21).
- **Bonus life.** With a bonus, at timer == 120: lives +1 (both players in 2P), plus `addLife_00` (N_life_00), `addLife_01` (N_msg_01) and SE 0x22.
- **When the timer runs out.**
  - Bonus: `outBonus_00` plays, and the mission text follows once it ends.
  - Otherwise: `T_mission_*` = 0x000b5d00 "Mission {num}" (full-width stage+1), or 0x000b5d01 "Final Mission" on the last stage, and `T_enemy_*` = 0x000b5e00 "Enemy tanks: {num}" (enemies alive). Then `inMission_00` (N_msg_00) + `inEnemy_00` (N_enemy_00), the stage BGM starts, and the timer is set to 140.
- **After 140 frames.** `outLife_00` on `N_tnk_00` (the whole screen fades), `loop_00`, `Hud.SetShowBalloons(true)`.
- **When `outLife_00` ends.** `out_00` on `N_loop_00`, `StartStageBgm`. Done when `out_00` ends.

Text: `T_bonus_*` is set on reset to 0x000b5700 "Bonus Tank!". `T_lifeNo_*` is updated every frame with player 0's full-width life count.

### `tnkUI_00` — in-game HUD (`RPTnkHud`)

Text:

- `T_mission_*`: 0x000b5400 "Mission {num}" with the full-width stage+1, set every frame.
- `T_enemyNo_*`: full-width enemies alive.
- `T_score00_00`/`T_score01_00`: P1 kills. `T_score00_01`/`T_score01_01`: P2 kills, 2P only.
- `T_player_00/01`: 0x000b5f00/01 "P1"/"P2".
- `T_balloon0x_00..03`: 0x000b6000 "P1". `T_balloon0x_04..07`: 0x000b6001 "P2".

Animations:

- `PlayIn()` (at "Start!"): `N_score_00` is visible, `N_score_01` is visible in 2P only, and `in_00` plays bound to `N_tnUIl_00`.
- `PlayOut()`: `out_00` on the whole layout.
- `PlayScoreAnim(p)`: `point1P_00` on `N_score_00` or `point2P_00` on `N_score_01`, when a player destroys a tank.

Balloons: every frame all eight `N_balloon_*` are hidden. If balloons are enabled (between "Start!" and the end of the fade), one balloon per player is shown:

- P1: `N_balloon_00`, `_03`, `_01`, `_02` for angle quadrants 0–3.
- P2: `N_balloon_04`, `_07`, `_05`, `_06`.

The chosen pane's translate is set to the tank's projected screen position, measured 11 units above the tank. The Mii head is drawn at the matching `N_player_0n`.

### `tnkMsg_01` — "Start!" (`RPTnkStartMsg`)

`T_start_00/01/02` = 0x000b5b00 "Start!". `Play()` binds `start_00` (61 frames) to the whole layout and plays SE 0x23.

### `tnkMsg_02` — "Mission cleared!" (`RPTnkClearMsg`)

Text:

- `T_clear_*`: 0x000b5500.
- `T_total00_*`: 0x000b5600 "Destroyed".
- `T_player00_00`: 0x000b6300 "P1" (1P).
- `T_player00_01/02`: 0x000b6200/01 "P1"/"P2" (2P).
- Counts are full-width kill totals:
  - 1P: `T_No00_00`/`T_No01_00`.
  - 2P: `T_No00_01`/`T_No01_01` for P1 and `T_No00_02`/`T_No01_02` for P2.

Sequence:

1. `Show()`: `N_clear_00` becomes visible and both totals are hidden. `inCleare_00` is bound to `N_clear_00`.
2. When it ends: `N_total_00` (1P) or `N_total_01` (2P) becomes visible, with `inTotal_00` bound to it and SE 0x24.
3. 120 frames after that, `IsActive()` → the fade starts.
4. `Hide()` hides everything.

### `tnkMsg_03` — "Mission failed!" (`RPTnkFailedMsg`)

`T_failed_*` = 0x000b5501. `Show()` plays `in_00` on the whole layout. After 120 frames `out_00` plays, and when it ends, `IsActive()` → results.

### `tnkMsg_04` — "Mission complete!" (`RPTnkCompleteMsg`)

`T_complete00_00/01/02` and `T_complete01_00` = 0x000b5800. `in_00` (81 frames). After 180 frames `out_00` plays, then results.

### `tnkResult_00` — results (`RPTnkResultLyt`)

Text:

- Headers: `T_result00_*` = 0x000b6700 (1P), `T_result01_*` = 0x000b6800 (2P), both "Results".
- Player labels: `T_player00_00` = 0x000b6500 (1P list), `T_player01_00/01` = 0x000b6400/01 (2P list), `T_player00_01/02` = 0x000b6600/01 (2P total).
- Kill counts per enemy type `i` (0–8 = tank types 1–9), full-width: `T_No00_0i` (1P), `T_No01_0i` (P1) and `T_No02_0i` (P2).
- Totals, **half-width**: `T_score00_00`/`T_score01_00` (1P), `T_score*_01` (P1) and `T_score*_02` (P2).

Animations:

| idx | anim | mode |
|---|---|---|
| 0 | inList | once |
| 1 | inScore | once |
| 2 | inTotal | once |
| 3 | win1P | loop |
| 4 | win2P | loop |
| 5 | outList | once |
| 6 | outTotal | once |
| 7 | upTotal | once |

Sequence:

1. **`Start()`.** Hide all `N_list_*`, `N_r0*_*` and `N_totalAll_*`. Show `N_list_00` (1P) or `N_list_01` (2P), bind `inList` to it, and play SE 0.
2. **Rows.** 20 frames after each animation ends, the next row appears: `N_r00_<type>` or `N_r01_<type>` for the `GetTypeOrder(row)`-th destroyed type.
   - The row is made visible and its translate.y is set to `N_p00_<row>` / `N_p01_<row>`.
   - `inScore` is force-bound to that row.
   - SE 0x34 − row plays.
   - This repeats until 9 rows or all destroyed types are shown.
3. **Total.** `N_totalAll_00/01` becomes visible with `inTotal` and SE 0x2B.
   - 1P: then `win1P` loops on `N_total_00`.
4. **Close.** The player can press A/B after 20 frames, otherwise the list closes after 300 frames.
   - 1P: `outList` (N_list_00) + `outTotal` (N_totalAll_00).
   - 2P: `outList` (N_list_01) + `upTotal` (N_totalAll_01). Then the winner loop plays: `win1P` on `N_total_01` or `win2P` on `N_total_02`.
5. **2P totals.** `ShowTotals()` (2P, during ptVsWinner) plays `outTotal` and the winner loop.

### `tnkHit_00` — "Hit!" popup (`RPTnkHitPopup`, 2P only)

`T_hit*` = 0x000b5c00. `Start(screenPos, num, type)` does the following:

1. Shows `N_hit_00` (type 0, blue) or `N_hit_01` (type 1, red) and hides the other.
2. Clamps the position to ±0.9 and sets `N_tnk_00.translate` to `pos × (304, 228)`.
3. Binds `hit_00` (49 frames) to the shown `N_hit_0n`.

It is spawned from `RPTnkTank` when a shell hits a tank, but only when `ModeIdx != 0`, which means 2P.

### `tnkEx_00` — tutorial hint banner (`RPTnkExMsg`, mission 1 only)

`Show(n)` sets `T_ex_00` to 0x000b7c0n and plays `in_00` on the whole layout. `RPTnkExGuide` calls it:

| guide step | message |
|---|---|
| 0, 1 | 0x000b7c00 "Move the tank…" |
| 2 | 0x000b7c01 "Aim at the enemy tank." |
| 3 | 0x000b7c02 "Fire with Ⓑ." |

0x000b7c03 is unused. `PlayOut()` plays `out_00` when stage 1 is cleared or a life is lost. `PlayOutAll()` plays `outAll_00` before results.

### Shared layouts in the Tanks flow

- `ptSelectGame_01` is the pre-game "how to play" screen:
  - `T_step_*` = 0x1B5C sub 9, "Stage 9", in first-play mode.
  - `T_gameTitle_00` = 0x1B58 sub 9, "Tanks!".
  - `T_comment_00` = 0x1B59 or 0x1B5A sub 9 (controls text).
  - `T_start_00` = 0x1B5B00, "Ⓐ: Start".
  - `N_remoteP_00` hosts `ptG8RemoteH_00`.

  Animations: `in_00`, `inFrame_00`, `inAlphaFrame_00`, `pushA_00`, `out_00`, `outFrame_00`, and `tpaGameScreen_00`, which is a texture pattern over `te_game_00..08`.
- `ptG8RemoteH_00` is the Tanks controller illustration (Nunchuk + Wii Remote). It uses `sm_remoteH_00/01` and the animation `remote_00`. Tanks is game texture index 8: `te_game_08.png` is the screenshot and `sm_gameIcon_08.png` is the icon. The BMG game index is 9, because slot 6 is an empty message.
- `ptSelectGame_00` is the game-select grid.
- `pause_00` is the pause menu (`RPSysPauseMenu`): 750/751/752 = 0x0002ee00 Continue / 0x0002ef00 Start over / 0x0002f000 Quit (common_message). `in_00` / `out_00` are bound to `N_center_00`; `active_00` / `push_00` are bound to each button pane.
- `ptPauseText_00` is the "⊕ Pause" hint.
- `ptGOMenu_00` is the post-game menu: Play again / Play a different game (`in`, `out`, `active`, `push`).
- `ptVsResult_00` is the 2P tally "P1 n wins … n win P2". `ptVsWinner_00` is a winner anchor with no drawable panes.
- `myRecord_00` is the top-5 "My Record" table:
  - Header: 0x1F40.
  - Scores: `0x2008+game` = 0x2011 "{num} tank(s)".
  - Unit labels: `0x1FA4+game` = 0x1FAD "tank(s)", where sub 1 = plural.
  - Animations: `in`, `newRec`, `outRec`, `outNewRec`, `blink`.
- `ptRankGet_00` is the medal earned popup (`RPMedalResult`):
  - `T_step_00` = 0x1F4B sub game.
  - `T_rankGet_*` = 0x1F4C sub rank: Bronze, Silver, Gold or Platinum Medal Earned.
  - `T_congrats_*` = 0x1F4D00 "Congratulations!".
- `rankComplete_00` is the all-medals-completed popup.
- `playAdvice_00` is the safety advice window. It contains Wii Sports artwork (`te_wiiSportsLogo`); Wii Play reuses the archive.
- `messageWindowB/W_00` and `systemWindow_00` are generic dialogs.
- `playerSelect_0x` and `rimoconEntry_00` are player and remote selection.
- `nunchukCheck_00` is the "connect the Nunchuk" prompt.
- `AButton`, `cCursorCircle_00`, `cPadCursor_00` and `leadCursor_00` are cursors and prompts.

## Tanks messages (`messages/tanks.json`)

IDs are confirmed against the decomp's `setMessage` calls.

| id | text | where |
|---|---|---|
| 0x000b5d00 | `Mission {num}` | tnkfade T_mission (intro banner) |
| 0x000b5d01 | `Final Mission` | tnkfade, mission 100 |
| 0x000b5e00 | `Enemy tanks: {num}` | tnkfade T_enemy |
| 0x000b5400 | `Mission {num}` | tnkUI_00 T_mission (HUD) |
| 0x000b5401 | `Enemy forces:` | unused |
| 0x000b5700 | `Bonus Tank!` | tnkfade T_bonus |
| 0x000b5701 | `Restock tanks` | |
| 0x000b5a00 / 01 | `Mission:` / `Tanks left: ` | unused by the Tanks code |
| 0x000b5b00 | `Start!` | tnkMsg_01 |
| 0x000b5c00 | `Hit!` | tnkHit_00 |
| 0x000b5500 | `Mission cleared!` | tnkMsg_02 |
| 0x000b5501 | `Mission failed!` | tnkMsg_03 |
| 0x000b5800 | `Mission complete!` | tnkMsg_04 |
| 0x000b5600 | `Destroyed` | tnkMsg_02 T_total00_* |
| 0x000b5900 / 01 | `Results` / `Total:` | unused |
| 0x000b6700 / 0x000b6800 | `Results` | tnkResult_00 1P / 2P header |
| 0x000b5f00/01, 0x000b6000/01 | `P1` / `P2` | tnkUI_00 score labels / balloons |
| 0x000b6200/01, 0x000b6300 | `P1` / `P2`, `P1` | tnkMsg_02 2P / 1P |
| 0x000b6400/01, 0x000b6500, 0x000b6600/01 | `P1` / `P2` | tnkResult_00 2P list / 1P list / 2P total |
| 0x000b7c00..03 | `Move the tank with ㌧ or ✚.` / `Aim at the enemy tank.` / `Fire with Ⓑ.` / `Drop mines with Ⓑ.` | tnkEx_00 (the last string uses U+E043 in the ROM) |
| 0x001b5809, 0x001b6209 | `Tanks!` | game title |
| 0x001b5909 (= 0x001b5a09) | `Wii Remote: Aim\n㌧ or ✚: Steer tank\nⒷ: Fire\nⒶ: Drop a mine` | how-to-play T_comment_00 |
| 0x001b5b00 | `Ⓐ: Start` | how-to-play |
| 0x001b5c09 / 0x001f4b09 | `Stage 9` | |
| 0x001b8a09 | `Point to aim` | |
| 0x00238300 | `Pause` | ptPauseText |
| 0x0002ee00 / 0x0002ef00 / 0x0002f000 | `Continue` / `Start over` / `Quit` | pause_00 (common_message) |
| 0x001f5500 / 01 | `Play again` / `Play a different game` | ptGOMenu_00 |
| 0x001f5400 / 01 | `{num} win` / `{num} wins` | ptVsResult_00 |
| 0x001f4000 | `My Record` | myRecord_00 |
| 0x001f4400 / 0x001f4500 | `New record!` / `Personal best!` | |
| 0x001fad00 / 01 | `tank` / `tanks` | record unit |
| 0x00201100 / 01 | `{num} tank` / `{num} tanks` | score |
| 0x00207500 / 01 | `Record: {num} tank(s)` | |
| 0x001f4c00..03 | `Bronze/Silver/Gold/Platinum Medal Earned` | ptRankGet_00 |
| 0x00271200..0x00271500 | `… Medal Earned!` | |
| 0x001f4d00 | `Congratulations!` | |
| 0x002b6500..03 | `{player} has earned\na bronze medal in Tanks!\nYou've been promoted to private,\nfirst class!…` (silver: sergeant, gold: general, platinum: five-star general) | medal messages |
| 0x00038400 | `Make sure there are no people\nor objects around you that you\nmight bump into while playing.` | playAdvice_00 |

In this table, ✚ / Ⓐ / Ⓑ stand for the private-use glyphs U+E041 / U+E042 / U+E043.
