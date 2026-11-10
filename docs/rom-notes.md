# RHAE01 — Tanks! data notes

Extract with `tools/extract_rom.sh` → `build/rom/x/...` (all `.carc` are Yaz0-compressed U8).

## Files

| Path (under `build/rom/x`) | Contents |
|---|---|
| `Common/RPTnkScene/common/G3D/*.brres` | 3D models: `tnk_tank`, `tnk_block`, `tnk_block_shadow`, `tnk_field_16_9`, `tnk_field_4_3`, `tnk_mine`, `shell`, `tnk_check`, `sceneFile` |
| `Common/RPTnkScene/common/basic_tank.breff/.breft` | particle effects (explosions, smoke) and their textures |
| `Common/RPTnkScene/common/tnk_footmark/*.bti` | tread mark textures (1p, 2p, enemy 1-9) |
| `Common/RPTnkScene/common/MapData/TnkMapData_P{1,2}_{00..29}_{0,1}.bin` | 30 maps per player count; `_0` = 4:3 (16×17), `_1` = 16:9 (22×17) |
| `Common/RPTnkScene/common/param/TnkGameParam.bin` | tank parameters + 100-mission table |
| `Common/RPTnkScene/rp_Tnk_sound.brsar` | all Tanks sound (SE + sequenced BGM) |
| `US/RPTnkScene/local/tank/{blyt,anim,timg}` | 2D layouts (BRLYT), animations (BRLAN), textures (TPL) for HUD / mission banners / results |
| `US/PartyStatic/local/*.brfnt` | fonts; `party_message.bmg`, `common_message.bmg` text |
| `Common/PartyStatic/common/G3D/medal_model.brres` | medals |

## Map format

Big-endian u32: `width, height, P1 facing, P2 facing` (0/1/2/3 = 0°/180°/90°/270°), then `width*height` cells row-major.
Cell values:

- `0` empty
- `100-107` block kind 0 (cork, destructible by mines), `200-207` block kind 1 (wood); low digit = spawn param bits 4-6 (RPTnkStageMap)
- `300` player 1 spawn, `301` player 2 spawn (2P maps)
- `400`-`407` enemy spawn slots 0-7 (tank type per slot comes from the mission table)

## TnkGameParam.bin

Big-endian, 4-byte words (int or float). Word 0 = 3 (version/count?).

### Tank parameter records — words 1..420, 10 records × 42 words

Record index = tank type id used in the mission table:

| id | tank | evidence |
|---|---|---|
| 0 | player | 5 bullets, 2 mines, speed 1.8 |
| 1 | brown | stationary, 1 bullet, cooldown 300 |
| 2 | ash/grey | speed 1.2, 1 bullet |
| 3 | marine/teal | fast bullet (6), 0 ricochet |
| 4 | pink/red | 3 bullets, cooldown 30 |
| 5 | yellow | 4 mines |
| 6 | purple/violet | 5 bullets, 2 mines |
| 7 | green | stationary, fast bullet, 2 ricochets, 2 bullets |
| 8 | white | invisible flag (k0=1), 5 bullets, 2 mines |
| 9 | black | speed 2.4, fast bullet, 0 ricochet, 3 bullets |

Known field offsets (k = index within record):
k0 invisible, k2 max mines, k22 move speed, k29 max bullets, k33 ricochets, k36 fire cooldown (frames), k37 bullet speed, k38 turret turn speed(?). Remaining fields TBD.

### Mission table — words 421.., 100 records × 22 words

`[bonusFlag, 0, slot1P[8], slot2P[8], map1PMin, map1PMax, map2PMin, map2PMax]`

- bonusFlag = 1 on missions 5, 10, 15, … (every 5th; extra life)
- slot value 0 = no tank; 1-9 = tank id; two-digit `ab` (≥10) = random tank id in `[a, b]`
- map index range is inclusive; picks `TnkMapData_P{n}_{idx}`

## Sound names (rp_Tnk_sound.brsar)

SE: `RP_TNK_SE_SHOOT_1P/2P/ENEMY1..9`, `HIT`, `REFLECT`, `REFLECT_SUPER`, `BROKEN`, `TNK_DISAPPEAR`,
`JIRAI_SET/TIMER/EXP/EXP_MAE` (mine), `CATERPILLAR_*` (treads), `ENGINE`, `IDLING`, `MISSION_BONUS`, `TNK1UP`,
`GAMESTART`, `GET_TNKNUM`, `GET_HIT*`, `RESULT_*`, `INTRO_CATERPILLAR_00..05`.
BGM (sequence `Tank_bgm_play2`): `RP_TNK_BGM_LOOP2`, `FILL2`, `RESULT2`, `COMP20`, `COMP100`, `MISS`, `PANPAKAPAN`.
