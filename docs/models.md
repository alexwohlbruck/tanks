# 3D assets: models, textures, animations, effects

Everything under `public/assets/models/` and `public/assets/effects/` is generated
from the ROM by one script. Python 3 stdlib only (numpy is not used):

    python3 tools/g3d/build_models.py            # ~20 s
    python3 tools/g3d/build_models.py --debug    # also contact sheets and renders in models/_debug/
    bun tools/g3d/check_glb.ts                   # loads every GLB with three.js GLTFLoader

| Tool | Purpose |
|---|---|
| `tools/g3d/build_models.py` | entry point; writes GLBs, PNGs, animation JSON, `manifest.json`, `scene.json`, effects |
| `tools/g3d/brres.py` | BRRES container; MDL0 v8, TEX0, PLT0, SRT0, CLR0, PAT0, VIS0, CHR0 (header only) |
| `tools/g3d/gxdl.py` | GX display lists (BP/CP/XF register writes, primitives), TEV/PE/texgen/channel decoding |
| `tools/g3d/gxtex.py` | all GX texture formats and a minimal zlib PNG encoder |
| `tools/g3d/convert.py` | MDL0 to glTF 2.0 (GLB) and the choice of glTF material for each TEV setup |
| `tools/g3d/gltf.py` | tiny GLB writer |
| `tools/g3d/scn0.py` | SCN0 (lights, light sets, ambient, fog, cameras), RP `.plight` / `.plmap` |
| `tools/g3d/effects.py` | BTI, REFT (effect textures), REFF (particle emitters) |
| `tools/g3d/contact_sheet.py`, `preview_render.py` | headless checks: texture contact sheets, a pure-Python z-buffer renderer |
| `tools/g3d/check_glb.ts` | loads every GLB through three.js GLTFLoader |

## Output layout

```
public/assets/models/
  <brres>__<mdl0>.glb             one GLB per MDL0, PNG textures embedded
  textures/<brres>/<tex0>.png     every TEX0 (base level; mips would go to mips/, but none exist)
  animations/<brres>__<anim>.<srt0|clr0|pat0>.json
  manifest.json                   models, nodes, meshes, materials (with full TEV), textures, animations, effects
  scene.json                      SCN0 'RPScene', RP light files, Tanks camera/light constants from the decomp
  _debug/                         contact_*.png/.txt and render_*.png (only with --debug)
public/assets/effects/
  basic_tank.json                 all 57 REFF emitters, decoded
  textures/<name>.png             the 20 REFT effect textures
  tread_marks/tnk_mark_*.png      tnk_footmark/*.bti
```

## Axes, units, grid

- G3D is **right-handed, Y-up**. The models keep their native units, so **one map cell is 35 × 35 units**.
  `RPTnkField::Reset` derives the cell size as `770/22 = 560/16 = 595/17 = 35`.
- Map cell `(col,row)` → world `x = 35·(col − (cols−1)/2)`, `z = 35·(row − (rows−1)/2)`, `y = 0`.
  This comes from `RPTnkField::GetCellPos`. Row 0 is the far side (−Z). The camera sits on +Z looking toward −Z.
- Play area: 16:9 is 22×17 cells = 770×595. 4:3 is 16×17 cells = 560×595.
  The floor models (`tnk_field_*`) are one cell bigger on every side: 840×665 and 630×665.
- Models face **+Z**. The tank barrel and the shell's long axis both point along +Z.
- glTF triangles are counter-clockwise. GX is clockwise-front, so the exporter reverses every triangle.
  It also checks the result against the vertex normals: 0 of 13,000+ triangles disagree, except 4 in each player tank.

## Models (what the game uses them for)

The model-to-code mapping below comes from the decompilation in `build/decomp/src/Pack/RPParty/RPTnkScene`.

| GLB | nodes (parent) | meshes / tris | material → glTF base texture | bounds (bind pose) |
|---|---|---|---|---|
| `tnk_tank__tnk_tank_1p.glb` | base, cannon<base | 3 / 494 | tank_mat→tank_blue (+env); tank_shadow_mat→tank_shadow (BLEND) | [-17.5, 0.06, -17.5] .. [17.5, 14.23, 19.69] |
| `tnk_tank__tnk_tank_2p.glb` | base, cannon<base | 3 / 495 | tank_mat→tank_red (+env); shadow | [-17.44, 0.06, -17.44] .. [17.44, 14.18, 19.62] |
| `tnk_tank__tnk_tank_e_1..9.glb` | base, cannon<base | 3 / 94 | tank_mat→ e1 tank_brown, e2 tank_ash, e3 tank_marin, e4 tank_pink, e5 tank_yellow, e6 tank_violet, e7 tank_green, e8 tank_white, e9 tank_black; shadow | [-17.5, 0, -17.5] .. [17.5, 14.12, 19.0] |
| `tnk_block__tnk_block_1.glb` | block_shadow_mdl_a2 | 1 / 2 | hole_mat→block_harf.1 (MASK 128/255) | 32×32 quad at y=0.05 |
| `tnk_block__tnk_block_7.glb` | block_7_mdl | 1 / 522 | block_mat→block.1 (+env) | [-17.5, 0, -17.5] .. [17.5, 122.5, 17.5] |
| `tnk_block__tnk_block_8.glb` | block_8_mdl | 1 / 522 | block_mat→block.1 (+env) | [-17.5, 0, -17.5] .. [17.5, 140, 17.5] |
| `tnk_block_shadow__tnk_block_shadow.glb` | block_shadow_mdl_a1 | 1 / 2 | block_shadow_mat→block_shadow (BLEND) | 70×70 quad at y=0.2 |
| `tnk_field_16_9__tnk_field_16_9.glb` | tnk_field_mdl | 1 / 32 | tnk_field_mat→floor_face (unlit; see TEV) | [-420, 0, -332.5] .. [420, 0, 332.5] |
| `tnk_field_16_9__tnk_field_16_9_out.glb` | nw4r_root | 92 / 6443 | outer floor + border wall (block_other_a/b/c, block_shadow_*) | [-1260, -3.6, -997.5] .. [1260, 87.9, 997.5] |
| `tnk_field_4_3__tnk_field_4_3.glb` | tnk_field_mdl | 1 / 32 | as 16:9 | [-315, 0, -332.5] .. [315, 0, 332.5] |
| `tnk_field_4_3__tnk_field_4_3_out.glb` | nw4r_root | 87 / 5401 | as 16:9 | [-942.9, -3.6, -997.5] .. [947.1, 87.9, 997.5] |
| `tnk_mine__tnk_mine.glb` | group1, block_shadow_mdl_a2<group1 (T 0,0.1,0, S 0.85), pSphere1<group1 | 2 / 92 | mine_mat→(colour only, CLR0) (+env); mine_shadow_mat (BLEND) | [-14.9, 0, -14.9] .. [14.9, 9.03, 14.9] (dome r≈9) |
| `shell__shell.glb` | shell | 1 / 60 | m_shell→shell | [-2.12, -2.12, -4] .. [2.12, 2.12, 4] |
| `tnk_check__tnk_check_{blue,red,white}.glb` | block_shadow_mdl_a3 | 1 / 2 | check_mat→check_* (BLEND) | 32×32 quad at y=0.05 |

`sceneFile.brres` holds no MDL0, only SCN0 data. It is written to `scene.json`.

### Tanks (`RPTnkTank.cpp`)

- Model index: 0 = `tnk_tank_1p`, 1 = `tnk_tank_2p`, 2–10 = `tnk_tank_e_1..9`. Enemy type N uses `e_N`.
- The game draws tanks at **uniform scale 1.6**. Their body height is `11·1.6 = 17.6`.
  After scaling, a tank is about 32 wide and 50 long including the barrel. The hit radius is 16.
- Joints: `base` (root, bind rotation Z=90°, so its local +X is world +Y) and `cannon` (child at base-local (11,0,0) = 11 up).
  Turret and barrel vertices are bound to `cannon`; hull and treads are bound to `base`.
  The GLB splits them into `polygonN__tank_mat__base` and `…__cannon`, children of their joints.
- **Turret rotation:** the game overwrites cannon's world matrix with `T(pos + (0,17.6,0)) · turretYaw · S(1.6) · Rz(90°)`.
  In glTF terms, rotate the `cannon` node about its **local X** axis by the yaw angle.
  That axis is world Y because of the parent's Rz 90°.
  `--node cannon=45,0,0` in `preview_render.py` shows this working.
- Muzzle: effect `Tnk_shot` is spawned with the cannon matrix. Its emitter is translated 20.3 along +Z, which puts it at the barrel tip.
- The shadow quad (35×35, y=0.1) is part of the tank model and draws in the XLU pass.

### Blocks, holes and map codes (`RPTnkStageMap::SpawnBlocks`, `RPTnkBlock.cpp`)

| map code | spawn param | kind | height h (half-cells) | model | PAT0 frame / texture |
|---|---|---|---|---|---|
| 100–107 | `(code−100)<<4` | 0 = **cork, destructible** by mine blasts | code−100+1 | see below | frame 1 → `block.2` (cork) |
| 200–207 | `((code−200)<<4)\|1` | 1 = **wood, indestructible** | code−200+1 | see below | frame 0 → `block.1` (wood) |
| 1, 2, 3 | not spawned by `SpawnBlocks` | – | – | – | (no code reads them) |
| 300/301, 400–407 | player / enemy spawns | | | | |

Model and vertical offset by height (`RPTnkBlock::CalcModelMtx`):

| h | model | y offset (model sunk below the floor) | visible height |
|---|---|---|---|
| 1 | `tnk_block_1` (**hole**) | +0.2 | flat decal (y = 0.25) |
| 2 | `tnk_block_8` | −105 | 35 (one cube) |
| 3 | `tnk_block_8` | −87.5 | 52.5 |
| 4 | `tnk_block_7` | −52.5 | 70 |
| 5 | `tnk_block_8` | −52.5 | 87.5 |
| 6 | `tnk_block_8` | −35 | 105 |
| 7 | `tnk_block_7` | 0 | 122.5 |
| 8 | `tnk_block_8` | 0 | 140 |

- Code **200 is a hole** (`tnk_block_1`, the `block_harf.1` hole texture with alpha test). Shells fly over holes: `CollideObject` ignores h==1 in bullet mode. Tanks still collide with them.
- Code 2xy with y ≥ 1 is a wood stack. Code 1xy is a cork stack.
  A pillar is drawn at full model height and pushed down so only the top h·17.5 shows above the opaque floor.
  The pillars are built from bevelled segments:
  - `block_7`, bottom to top: ½ + 1 + ½ + 1 + ½ cells (heights 0–17.5–52.5–70–105–122.5).
  - `block_8`, bottom to top: 1 + ½ + 1 + ½ + 1 cells (0–35–52.5–87.5–105–140).
  - A one-cube block is the top segment of `block_8`.
- Exact sizes:
  - Footprint 35 × 35 (x, z ∈ ±17.5), with a 1.1-unit bevel (faces inset to ±15.4).
  - Full segment 35 high, half segment 17.5 high.
  - Hole decal 32 × 32.
  - Block scale is `(0.5·cell)/17.5 = 1`.
- Block shadow: `tnk_block_shadow` (70×70 quad, y=0.2) is drawn for h ≠ 1.
  It is rotated toward the free sides, and the **SRT0 frame selects an atlas quadrant**:
  - The UVs cover 0..0.5. Frame k translates them to (0,0), (−0.5,0), (0,0.5) or (0.5,−0.5).
  - Frame 0: no neighbours. Frame 1: two sides. Frame 2: three sides. Frame 3: four sides.
  - See `UpdateShadow`.
- Breaking: cork blocks spawn `Tnk_blockbreak01` once per 35 of height when hit by a mine explosion.

### Other

- **Mine** (`RPTnkMine_2.cpp`): scale 1, y=0. The `tnk_mine` CLR0 animates TEV register C0 (the dome colour) from yellow (219,228,64) to red (231,62,99) over 7 frames, looping.
  The GLB uses frame 0 as `baseColorFactor`. On explosion the game spawns `Tnk_mine_bomb` at scale 1.6.
- **Shell** (`RPTnkShell_2.cpp`): drawn at uniform scale **1.5238** (= 32/21), so it is about 12.2 long. Smoke trails come from effects `Tnk_shellsmoke01/02/03`.
- **Death marks** (`RPTnkCheckMark*.cpp`): `tnk_check_blue` / `_red` / `_white` sit at y=0.2, scale 1. The colour is chosen by spawn param.
- **Field** (`RPTnkField_2.cpp`): the floor model is `tnk_field_16_9` or `_4_3`, chosen by TV mode, and the `_out` model draws everything around it.
  The floor's `caterpillar` texture is **replaced at runtime by an IA8 EFB capture** (`ReplaceTexture("caterpillar", captureTex)`). See *Tread marks* below.

## Formats decoded

**BRRES**: `bres` header, root `ResDic` (patricia index group: u32 size, u32 count, 16-byte entries with name/data offsets relative to the group). Folders found: `3DModels`, `Textures`, `AnmTexPat`, `AnmTexSrt`, `AnmClr`, `AnmScn`. No `Palettes`, `AnmChr` or `AnmVis` folders exist in these files. PLT0, VIS0 and CHR0 parsers exist but have no data to run on. CHR0 is header-only.

**MDL0 v8** (all models). These layouts were checked against the data:
- 11 section groups: defs, bones, positions, normals, colors, uvs, materials, shaders, objects, texture links, palette links.
- Then the name offset and the 0x28-byte info block. v8 has **no min/max in the info block**.
- Info block fields: scaling rule, tex-matrix mode, vertex/face counts, node count, flags, and the matrix→node table (`mtx_to_node`).
- Definition bytecode: 0x02 NodeTree, 0x03 NodeMix (weights), 0x04 Draw (material, shape, visibility node, priority), 0x05 EnvelopeMatrix, 0x06 Duplicate.
  The Tanks models use only NodeTree and Draw. There are no envelopes.
- Bones (0xD0 bytes):
  - flags (identity / visible / has-geometry / SSC …) and billboard mode (all `none`).
  - S, R (degrees, applied X→Y→Z), T; box min/max; tree links.
  - 3×4 world and inverse matrices. The exporter recomposes T·Rz·Ry·Rx·S and checks it against the stored world matrix: max error 0.
- Vertex arrays use fixed point. Components are u8/s8/u16/s16/f32 with a frac-bit divisor (e.g. tank positions s16 / 2^10, block_8 s16 / 2^7, UVs u16 / 2^15).
  Colours are RGBA8 (RGB565, RGB8, RGBX8, RGBA4 and RGBA6 are also handled).
- Shapes (objects):
  - Header fields: single-bind matrix, CP VCD lo/hi, XF spec.
  - The setup display list is at +0x18+off and holds CP VCD/VAT writes. The primitive display list is at +0x24+off.
  - Then array indices and the matrix-id table at +0x60.
  - Primitive streams handle the 0x20 matrix-slot loads, PNMTXIDX (slot = value/3), triangles, strips, fans and quads (the last two are unused here).
    Lines and points are skipped with a warning; none occur.
- Materials:
  - Header: texgen, channel and TEV counts; cull; light set / fog set; shader offset (+0x28); layer count (+0x2C) and offset (+0x30); display list (+0x38).
  - **Texture SRT / effect block at +0x1A4**: u32 enable flags, u32 matrix mode, 8×SRT (20 bytes each), 8×TexMtxEffect (0x34 each: camera/light ref, map mode, effect matrix).
  - Then 2 lighting channels (flags, material RGBA, ambient RGBA, colour ctrl, alpha ctrl).
  - Layers (0x34 each): texture/palette name, texmap id, wrap S/T, min/mag filter, LOD bias, anisotropy.
  - The material display list (pixel engine + TEV colours + indirect + texgen XF) and the shader display list (TREF/KSEL/COLOR_ENV/ALPHA_ENV) are executed as plain BP/XF register streams, with BP mask handling. TEV colour registers and konst colours share BP 0xE0–0xE7, so they are decoded in write order using the type bit.

**TEX0 v1** (data at +0x10 offset, w/h, format, image count, LOD range). Decoders cover I4, I8, IA4, IA8, RGB565, RGB5A3, RGBA8, CI4, CI8, CI14X2 (with PLT0 IA8/RGB565/RGB5A3) and CMPR (2×2 DXT1 sub-blocks, big-endian, 1/3–2/3 interpolation, transparent index when c0≤c1), plus mipmap chains.
- Formats in use: CMPR, RGB565, RGB5A3 and IA8 for models. I8 for the env maps. IA4 for the tread marks.
- No TEX0 has mipmaps or a palette.
- I4/I8 replicate intensity into RGBA, as GX does, so I8 textures get alpha = intensity.

**SRT0 v4**, **CLR0 v3**, **PAT0 v3**:
- Key-list and colour-array offsets are relative to the **field that holds them**.
- SRT0 codes use these bits: 0x2 scale one, 0x4 rot zero, 0x8 trans zero, 0x10 isotropic, 0x20–0x200 per-component "fixed".
- The keys are hermite (frame, value, slope).
- Written as sidecar JSON. glTF cannot animate texture transforms or texture swaps without `KHR_animation_pointer`, which three.js does not load.

| animation | target | meaning |
|---|---|---|
| `tnk_block__tnk_block_7/8.pat0.json` | block_mat slot 0 | frame 0 = `block.1` (wood), frame 1 = `block.2` (cork). Selected per block kind, not played |
| `tnk_block__tnk_block_1.pat0.json` | hole_mat | constant `block_harf.1` |
| `tnk_block_shadow__tnk_shadow_animation.srt0.json` | block_shadow_mat tex0 | 4 frames = atlas quadrant select (translate S,T) |
| `tnk_mine__tnk_mine.clr0.json` | mine_mat `tev_color0` (= C0) | 8 RGBA frames (7-frame loop), alpha keep-mask 0xff |

**SCN0 v4** (`scene.json`):
- Light-set ambient names are relative to the light-set start. Light-name offsets are relative to the name array.
- Light usage flags: bits 0–1 type, 4 colour, 8 alpha, 0x10 enable, 0x20 specular.

Contents:
- Light sets:
  - `Default_Lightset` = ambientLight0 + Main_Light.
  - `Reflect_Lightset` = ambientLight1 + Main_Light + Reflect_Light.
  - `Abatar_Lighset` = ambientLight2 + Abatar_Light.
- All ambient colours are (100,100,100).
- Lights: Main_Light is directional from (4,4,4) toward the origin, white, specular flag on. Reflect_Light comes from (−4,−4,−4).
- One generic perspective camera, `camera0` (fovy 40). It is **not** the Tanks camera.
- The RP `scene_Light.plight` (EGG `LGHT`) and `scene_Lm.plmap` (`LMAP`) of RPCommon, RPPartyCommon and PartyStatic are included.
  Positions, colours and attenuation are decoded. Some LOBJ index/flag bytes stay raw.
  Tanks materials do not use lightmaps.
- `scene.json → tanks_runtime` holds the **actual arena camera and light from the decomp**:
  - Orthographic view.
  - Eye (0, 2000·sin42°, 2000·cos42° − 14) = (0, 1338.26, 1472.29); target (0,0,−14); up (0, cos42°, −sin42°). That is a 42° elevation.
  - Screen scale 1.125. The visible extent is 1.125 × the RP root screen (608 or 832 wide × EFB height).
  - The intro fly-in path.
  - Main_Light moved to (0,10000,0), i.e. **straight down**.

## glTF material mapping and the TEV rules behind it

Every material's full TEV setup is in `manifest.json → models[].materials[].tev`:
- stages with texmap/texcoord, raster channel and konst selectors;
- a readable colour/alpha expression for each stage, plus the raw a/b/c/d/op/bias/scale/clamp/dest;
- the colour registers, konst colours and swap tables;
- the pixel engine (alpha test, z mode, blend), texgens and lighting channels;
- the chosen glTF representation (`gltf`), `env_add`, and `custom_shader_needed`.

Mapping rules (`convert.analyze_material`):
- The first stage of the form `TEXC × X` with a texcoord-mapped layer becomes `baseColorTexture`.
- `KONST` and `Cn` multipliers become `baseColorFactor`. `TEXA × KONST` alpha becomes the factor's alpha.
- `COLOR_0` is emitted only when the channel takes its material colour from vertex colours and the TEV uses the raster colour.
  Otherwise any vertex colours go to `_COLOR_G3D`, which three.js ignores.
- Channel lighting off, or raster unused → `KHR_materials_unlit`.
- Blend enabled → `BLEND`. Alpha compare `≥ ref0` → `MASK` with cutoff ref0/255. Cull none → `doubleSided`.
  Cull front/all would need custom handling, but none occur.
- Node `extras`: `renderOrder` (DrawOpa list order, then DrawXlu by priority), `pass` (`opa`/`xlu`), `shape`, `material`, `visibility_bone`. three.js exposes them as `userData`.

### What needs custom shading in three.js

1. **Additive sphere env map ("shine")**:
   - Used by `tank_mat` on 1p/2p, `block_mat`, `block_other_*_mat` and `mine_mat`.
   - Stage 1 does `PREV = PREV + envTex.rgb × K`. The env layer has map mode `env_camera`: the texgen source is the normal, transformed by the normal matrix (view space) and normalized.
   - So `uv = (0.5·n_view.x + 0.5, 0.5 − 0.5·n_view.y)`. That is the MeshMatcapMaterial lookup, but the result is **added** to the lit colour.
   - K values:

     | material | env texture | K (scale) |
     |---|---|---|
     | 1p tank | `tnk_tank_env` | K0 = (177,165,129)/255 |
     | 2p tank | `tnk_tank_env` | K0 = (146,136,107)/255 |
     | blocks / border | `tnk_tank_env` | K3.a = 40/255 |
     | mine | `mine_env` | K3.a = 60/255 |

   - Enemy tanks have no env stage.
   - The texture is in the GLB (material `extras.env_add[].gltf_texture`) and as a standalone PNG.
   - Implement with `onBeforeCompile`, adding `texture2D(envMap, matcapUV).rgb * K` to `outgoingLight`.
2. **Floor tread-mark blend** (`tnk_field_mat`, unlit):
   - `REG0 = floor_lower`, `REG1 = floor_face`, `out = lerp(floor_lower, floor_face, caterpillar)`. All three use the same 0..1 UV across the floor.
   - At runtime `caterpillar` is an IA8 screen capture: white where untouched and darker where tread marks were stamped. Tread marks therefore show `floor_lower`, the darker, dug-in wood.
   - The GLB uses `floor_face` alone. Reimplement as a render target that the tread-mark sprites draw into, then lerp in the floor shader.
3. **Vertex-colour lighting**:
   - The lit materials use GX lighting: `rasColour = matColour × clamp(ambient + Σ max(0, N·L)·lightColour)`.
   - `matColour` is the vertex colour on tanks and blocks and white elsewhere.
   - Ambient is (100,100,100)/255 from the SCN0 light set, which replaces the material's 255 ambient at runtime. The one light is white and points straight down.
   - Then `out = tex × rasColour`. Top faces saturate to 1.0; vertical faces get about 0.39 × vertex colour.
   - three.js's physically based lights do not reproduce this clamp. A small custom Lambert (or `MeshBasicMaterial` with the light baked into a uniform) matches the original exactly.
4. **Shadows are decals, not lighting**:
   - Tank, mine and block shadows are blended quads: alpha = tex.a × 100/255 (tank/block) or 140/255 (mine). z-write is off and they draw in the xlu pass.
   - Keep them at `renderOrder` ≥ 1 with `depthWrite=false`. GLTFLoader already does this for `BLEND`.
5. **Block-shadow atlas**: drive `texture.offset` from the SRT0 frame (see the table above). The texture wraps with `repeat`.
6. **Mine colour**: animate `material.color` from the CLR0 JSON (8 frames, loops).
7. The death-mark X quads are standard alpha blending, as are the hole decals (alpha test ≥ 128).

## Effects (`public/assets/effects/`)

**Tread marks**: `tnk_footmark/*.bti` are 64×64 IA4 images. The BTI header is 0x20 bytes: format, w, h, wrap, palette, mip flags, data offset.
Each image has two dark dashes on a transparent background. `tnk_mark_e_8` also has extra lines.
The game stamps one every 10 units of travel per tank (`RPTnkTank::IntegrateStep`, `distances[] = 10`).

**REFT** (version 5). The file has a project header, then a name table: u16 len + name, then u32 offset (from the table) and u32 size.
Each texture starts with a 0x20 header: w, h, data size, format, TLUT format, count and size, mip flag, filters.
There are 20 textures (IA8 and I8). Several are **quarter images** (glow and ball textures) meant to be drawn with **mirror** wrap; the particle's `texture_wrap` says which.

**REFF** (version 5) → `basic_tank.json`: 57 emitters. Each one has:
- the emitter: form (`point`/`disc`/`sphere`/`cube`/`line`…) with named form parameters; emitter and particle life (65535 = infinite); emit count, interval and randomness;
- velocity: radiation, Y-axis, random, normal and spec-dir powers, plus diffusion; momentum randomness;
- the emitter S/R/T (e.g. `Tnk_shot` +20.3 Z, `Tnk_bomb01` +15 Y, `Tnk_shellsmoke01` −3 Z);
- draw settings: TEV stages as expressions, blend (`src_alpha`/`inv_src_alpha` or additive `one`), z compare, alpha compare, colour-input routing, particle type;
- particle: two colour layers (primary/secondary), size, scale, rotation, texture names with wrap/SRT;
- animation tracks, decoded per target:
  - colour and alpha (u8);
  - size, scale, texture SRT (f32);
  - rotation (with random ranges);
  - texture flip-books;
  - **child emitters** (named);
  - **fields**: gravity (power, direction, space), speed (velocity multiplier per frame), spin, random, magnet, newton, vortex.

The layout was taken from the nw4r ef headers in the decomp. v5 differs from the decomp's v7:
- `EmitterDesc` is 0xA0 common + 0xA0 draw setting. The particle type, type options and pivot sit at desc+0x8C..0x96, not at the end of the draw setting.
- `ParticleParameterDesc` texture names start at +0x7A.
- Animation keys use an **8-byte prefix**: u16 frame, u16 interp (2 bits per component), u8 random flag at +6, payload at +8.
  Payload sizes: u8 keys pad to 2 bytes; f32 is 4 bytes per component; texture keys are 12 bytes; child keys are 18 bytes, including an 8-byte inherit setting and a u16 name index.
- Track name tables have u32 pointer slots before the names.
- All 57 emitters consume their exact byte size.

Track timing: `frame_length` is in frames. With the `fitting` process flag the curve is stretched over the particle's life: `frame = frame_length · age / life`. `init_only` tracks run only at spawn.
At the end of the draw stage the runtime applies the **colour** op to the alpha stage as well (a nw4r bug); `alpha_op_stored` is kept for reference.

Which effect the game spawns where (decomp):

| event | effect (children) |
|---|---|
| fire (at cannon matrix) | `Tnk_shot` → `_ball`, `_ptcl`, `_spark`, `_smoke` |
| shell trail | `Tnk_shellsmoke01` (normal), `02` (+`_fire`, `_smoke`), `03` (+`_smoke`, stripe trail) — 3 is used for slots 2 and 3 |
| shell hits something | `Tnk_shell_crash` → `_ptcl`, `_ball`, `_spark` |
| shell vs shell / destroyed | `Tnk_shell_bomb` → `_smokefire`(→`_smoke`), `_ptcl`, `_ball`, `_spark` |
| tank destroyed | `Tnk_bomb01` (→`_wave` …) + `Tnk_bomb01_piece` (debris with gravity) |
| mine explodes (scale 1.6) | `Tnk_mine_bomb` → `_particle2`, `_wave`, `_spark`, `_fire` |
| cork block breaks | `Tnk_blockbreak01` → `_s`, `_l` (rock chunks, gravity), once per 35 of height |
| white tank cloaks / uncloaks | `Tnk_stealth_change` (→ `…04b/01b/03b`), `Tnk_stealth_change_back` |
| cursor | `Tnk_cursor_{1p,2p}_{main,tail,line}` |
| stage clear | `Tnk_all_clear` → `Tnk_clr_*` |

## Validation

- `build_models.py` prints vertex/triangle counts and bind-pose bounds for each GLB. They match the MDL0 header face counts: 494/495/94 triangles for the tanks, 522 for the blocks.
- Bone TRS → world matrices match the matrices stored in the MDL0.
- Winding is checked against normals (see above).
- `bun tools/g3d/check_glb.ts`: all 24 GLBs load in three.js GLTFLoader, with the expected node hierarchy, material types (MeshStandard, or MeshBasic for unlit), transparency, alpha test and vertex-colour flags.
- `--debug` renders:
  - `render_units.png`: tanks, mine, shell, death mark.
  - `render_blocks.png`: hole, the two pillars, shadow.
  - `render_fields.png`: the border plus the floor hole.
  - Contact sheets for every texture set, which were reviewed by eye: tank liveries, wood/cork blocks, hole, floor, shadows, effect sprites, tread marks.

## Known gaps

- Interpolation per component in REFF keys is decoded as 2 bits per component, low bits first. The bit order is unverified because almost all keys are linear.
- Random-range tables are dumped as decoded (base, width) pairs.
- The v5 meaning of `raw_97_9f`, particle `raw_79` (probably alpha-flicker or rotate-offset randomness) and the child inherit-setting bytes is not fully known. Raw values are kept.
- EGG `.plight` LOBJ bytes 0x10–0x17 and `.plmap` binding tables are raw.
- CHR0/VIS0 parsers are untested: the Tanks archive contains no CHR0 or VIS0.
- Envelope (weighted) skinning is not implemented. The exporter raises an error if it ever meets it. These models only use rigid single-joint binding.
