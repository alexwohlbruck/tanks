# Tanks+ content

New enemy tanks, special tiles, power-ups, level rules and the 40-level "Tanks+" campaign.
The original 100-mission campaign is untouched: everything below lives behind `World.plus`,
which only exists for custom levels that use a tile code 500-599, an enemy type 10+ or a
non-empty `rules` object. `bun tools/levels/classic-trace.ts` proves it: it hashes every frame
(events, positions, RNG state) of 38 fixed-seed classic runs (1-4 players, missions 1-100) and
compares them with hashes recorded before any Tanks+ code existed.

## Code map

| file | what |
|---|---|
| `src/sim/stats.ts` | type registry: `registerTankType(id, record42, meta)`, `tankTypes()`, `tankMeta(id)` |
| `src/sim/types/index.ts` | the 13 added types (records + meta), ids in `T` |
| `src/sim/types/behaviours.ts` | behaviours records cannot express (teleport, fans, homing, ...) |
| `src/sim/tiles.ts` | tile registry `tileTypes()` and the tile mechanics (`Tiles`) |
| `src/sim/powerups.ts` | power-up registry `powerUpTypes()`, pickups and player buffs |
| `src/sim/plus.ts` | `Plus`: the per-stage extension a World gets; all hooks go through it |
| `src/levels/ascii.ts` | ASCII map -> `LevelDef` (`asciiLevel`, `levelToAscii`, `LEGEND`) |
| `src/levels/packs/` | `tanksPlus: LevelPack`, `TANKS_PLUS_WORLDS`; sources `tanksplus/world1-4.ts`, export `tanksplus.json` |
| `src/render/tiles.ts` | tiles, pickups, lasers, fog, shields / HP bars / sniper sights, liveries |
| `src/render/registry.ts` | `registerTankVisual(type, { baseModel, livery, accent, scale, emissive })` (minimal) |
| `tools/levels/` | `playtest.ts`, `classic-trace.ts`, `export.ts`, `bot.ts` |

### Hooks into the original code

Every hook is marked `[tanks+]` and is a no-op when `world.plus` / `tank.ext` is null (always,
for the disc missions):

| where | hook |
|---|---|
| `World.loadStage` | creates `Plus` for custom levels that need it; tile blocks after the original blocks |
| `World.physics` | `plus.collide()` after all CollideWithField; `plus.afterCalc()` after all Calculate |
| `World.onBlockBreak` | glass / crate bookkeeping |
| `World.maxActiveEnemyType` | added types count as their `bgmRank` (`bgmRow()` in `bgm.ts`, identity for 1-9) |
| `World.spawnExtraEnemy` | Hive drones (spawn slot 15, so a reload never brings them back) |
| `Tank.spawnPlayer/spawnEnemy` | `tank.ext = plus.attach(tank)` (hit points, timers, buffs) |
| `Tank.resolveHits` | `plus.absorbHit`: shields, hit points, invulnerability frames |
| `Tank.testHitAlt` | `ext.hitBonus` (big boss hulls) |
| `Tank.invisible` | `ext.hidden` (Ghost, fog of war) |
| `Tank.playFireSe` | shot sounds of added types; `plus.onFire` (fans, rocket power-up) |
| `Shell.collideWithField` | `plus.deflectShell` (front shields) |
| `Shell.onHitWall` | tile blocks tag their edges (`EDGE_TAG + tile`); id 0 = original wall |
| `AiAttack.executeActions` | shell look of added types; `plus.interceptFire` (sniper charge) |
| `src/ui/presenter.ts` | the original result layout only lists types 1-9 (added types are still counted) |

Shells keep the original 4-bit shooter-type field: added types fire with the look of an
original type (`meta.shellLook`: 3/7/9 = rockets with their loop sounds, default 2).

## Enemy types

Each is a 42-word record (same meaning per word as the disc's, docs/research.md 4.2) driven by
the unchanged original AI, plus opt-in behaviours (`TankBehaviours` in `stats.ts`).

| id | name | colour | personality | behaviours |
|---|---|---|---|---|
| 10 | Trident | `#e8862a` | slow; three-shell fans | `spread 3 x 14 deg` |
| 11 | Bulwark | `#5a7fa8` | charges, turns slowly; shells from the front ricochet off | `frontShield 60 deg` |
| 12 | Blink | `#c03cc8` | teleports every ~5 s to a cell far from the players; flickers 0.75 s before | `teleport` |
| 13 | Hornet | `#e0482a` | keeps distance; homing rockets that cannot ricochet | `homing 1.5 deg/frame` |
| 14 | Sapper | `#7d8a3a` | lays a trail of mines while it drives (4 at most) | `minePattern trail` |
| 15 | Rammer | `#b0202a` | no gun; charges, stops, blinks 0.6 s and explodes like a mine | `kamikaze` |
| 16 | Sniper | `#3f5a2e` | red laser sight for 0.9 s, then a speed-7.5 shell along it | `sniper` |
| 17 | Medic | `#f0ece4` | stays back; every 6 s gives allies within 160 a one-hit shield bubble | `medic` |
| 18 | Hive | `#6b3fa0` | 3 hits (+1 per extra player); releases up to 3 Drones | `spawner`, `hp` |
| 19 | Drone | `#b8d040` | small, fast, weak slow shell (scale 0.72) | - |
| 20 | Ghost | `#9fb4c0` | invisible whenever it stands still; stops after every shot | `ghost` |
| 21 | Titan (boss) | `#4a4a55` | 10 hits (+3 per extra player); five-rocket fans; drops mines in threes | `hp`, `spread 5`, `minePattern cross` |
| 22 | Overlord (boss) | `#2a1a40` | 10 hits (+3 per extra player); teleports; fans of homing rockets | `hp`, `teleport`, `spread 3`, `homing` |

Boss hits give 0.5 s of invulnerability (a mine blast costs one hit point, not twenty) and a
hit-point bar; shields last until they absorb one hit. Music: each type maps to the BGM row of
an original type (`bgmRank`): Medic 3, Drone 2, Trident 4, Bulwark/Sapper 5, Blink/Rammer 6,
Hornet/Sniper 7, Hive/Ghost 8, bosses 9.

## Tiles (cell codes 500-599)

`tileTypes()` lists them with `code, id, name, group, colour, icon, description, solid`.
The icon is also the default ASCII character.

| code | icon | tile | effect |
|---|---|---|---|
| 500-503 | `T U V W` | teleporter A-D | tanks and shells crossing a pad come out of the next pad with the same letter |
| 510-513 | `^ > v <` | conveyor N/E/S/W | pushes tanks 0.9 units/frame |
| 520 | `*` | ice | the driven velocity follows the commanded one at 6 %/frame: sliding, wide turns |
| 521 | `%` | mud | half speed |
| 530 | `B` | bumper wall | shells bounce off without using a ricochet |
| 531 | `G` | glass | one shell (the shell is spent) or a mine blast breaks it |
| 532 | `C` | crate | like glass; drops a random power-up (70 %, rule `crateDrop`) |
| 540 | `S` | switch | a player driving on, or any shell flying over, toggles every gate |
| 541 / 542 | `D` / `O` | gate closed / open | a wall the switches open; closing waits until the cell is clear |
| 550 | `~` | water | tanks and mines cannot cross; shells fly over (a hole that looks like water) |
| 560-563 | `N L Z J` | laser emitter N/E/S/W | beam to the first block; kills any tank in it while lit (2.5 s lit, 1.75 s dark, 0.75 s flicker) |
| 564-567 | `5 6 7 8` | laser, alternate phase | lit while the others are dark |
| 570 | `@` | gravity well | bends shells within 150 toward its centre (speed kept) |
| 580-585 | `R K Q F M X` | power-up pad | holds that power-up; refills 15 s after it is taken |

Hazard kills (lasers, Rammer blasts) are credited to nobody (hit id 15).

## Power-ups

`powerUpTypes()`; picked up by player tanks (radius 22), from pads and crates.

| # | power-up | effect | lasts |
|---|---|---|---|
| 0 | Rapid fire | 8 shells on the field, no pause after firing | 12 s |
| 1 | Ricochet+ | +1 ricochet | 15 s |
| 2 | Shield | bubble that absorbs one hit | until hit |
| 3 | Speed | 40 % faster | 12 s |
| 4 | Mines+ | 4 mines instead of 2 | 15 s |
| 5 | Rockets | speed-5.5 rocket shells | 12 s |

`buffsOf(tank)` (powerups.ts) gives the active ones for a HUD.

## Level rules (`LevelDef.rules`)

| rule | value | effect |
|---|---|---|
| `fog` | radius or `true` (140) | enemies farther than this from every player are hidden; the floor outside the players' circles is darkened |
| `wind` | `[x, z]` | added to every shell's velocity each frame (speed kept): shells curve |
| `crateDrop` | 0..1 | chance a crate holds a power-up (default 0.7) |

## Campaign

40 levels in 4 worlds of 10. Each world introduces its tank types and tiles one at a time,
then mixes them; every 10th level is a boss, every 5th awards a life (`bonus`). All levels have
spawns for 4 players (`1`-`4`), and boss hit points scale with the player count. 3 lives.

| world | levels | introduces |
|---|---|---|
| 1 Workshop | 1-10 | crates + power-ups, glass, bumpers, mud; Trident, Bulwark, Sapper; boss Titan |
| 2 Frozen Works | 11-20 | ice, teleporters, conveyors, switches + gates; Blink, Hornet, Medic; boss: two Hives |
| 3 Night Ops | 21-30 | water, fog, lasers, gravity wells; Drone, Sniper, Rammer, Ghost; boss: Titan + Medic + Rammers |
| 4 Overdrive | 31-40 | wind, everything combined with Violet / White / Black; final boss Overlord |

| # | level | enemies | rules | life |
|---|---|---|---|---|
| 1 | Fresh Paint | 2 Brown, 1 Ash |  |  |
| 2 | Glasshouse | 3 Ash, 1 Brown |  |  |
| 3 | Three Prongs | 2 Trident, 1 Brown |  |  |
| 4 | Bumper Cars | Pink, Trident, Brown, Ash |  |  |
| 5 | Mud Season | 2 Yellow, Trident, Ash |  | +1 |
| 6 | The Wall | Bulwark, 2 Brown |  |  |
| 7 | Minefield | 2 Sapper, Ash |  |  |
| 8 | Shield Wall | 2 Bulwark, Trident |  |  |
| 9 | Gauntlet | Sapper, Trident, Bulwark, Pink, Brown |  |  |
| 10 | **Titan** | Titan, 2 Brown |  | +1 |
| 11 | Black Ice | 3 Ash, Trident |  |  |
| 12 | Now You See Me | 2 Blink, Ash |  |  |
| 13 | Portals | Marine, 2 Ash |  |  |
| 14 | Hornet's Nest | 2 Hornet, Brown |  |  |
| 15 | Assembly Line | Pink, Sapper, Trident, Ash |  | +1 |
| 16 | Field Medic | Medic, Bulwark, 2 Ash |  |  |
| 17 | Locked In | Hornet, Blink, Ash |  |  |
| 18 | Slippery Slope | Hornet, Medic, Trident |  |  |
| 19 | Switchback | Blink, Bulwark, Hornet, Sapper |  |  |
| 20 | **Hive Queen** | 2 Hive, Medic |  | +1 |
| 21 | Lakeside | 2 Marine, 2 Drone |  |  |
| 22 | Lights Out | 3 Ash, Pink | fog 150 |  |
| 23 | Laser Grid | Trident, 2 Brown, Ash |  |  |
| 24 | Crosshairs | 2 Sniper, Brown |  |  |
| 25 | Kamikaze | 3 Rammer, Ash |  | +1 |
| 26 | Event Horizon | Green, Hornet, Marine |  |  |
| 27 | Ghost Town | 2 Ghost, Ash |  |  |
| 28 | Dark Water | Sniper, 2 Rammer, Ghost | fog 160 |  |
| 29 | Haunted Lab | Ghost, Medic, Sapper |  |  |
| 30 | **Titan Returns** | Titan, Medic, 2 Rammer |  | +1 |
| 31 | Tailwind | Green, Hornet, Marine | wind east |  |
| 32 | Hall of Mirrors | 2 Bulwark, Sniper |  |  |
| 33 | Rush Hour | 2 Rammer, 3 Drone |  |  |
| 34 | Teleport Maze | Blink, Ghost, Violet |  |  |
| 35 | Storm | Hornet, Sniper, Black | wind north, fog 170 | +1 |
| 36 | Fortress | Bulwark, Medic, Violet, Trident |  |  |
| 37 | Hive Mind | Hive, Medic, Ghost, Bulwark |  |  |
| 38 | Ice Palace | White, Blink, Hornet |  |  |
| 39 | Last Stand | Black, Violet, Sniper, Hornet, Blink, Bulwark, Medic, Trident |  |  |
| 40 | **Overlord** | Overlord, Medic, Blink |  | +1 |

### Authoring levels

```ts
import { asciiLevel } from '../../ascii'
asciiLevel({
  name: 'Example',
  enemies: [10, 2],          // slot a = Trident, slot b = Ash
  rules: { fog: 150 },
  map: `
    ......................
    ...  17 more rows of 22 cells ...`,
})
```

Legend (`LEGEND` in ascii.ts; `legend` overrides per level): `.` empty, `#` wood (202),
`=` low wood (201), `H` tall wood (204), `x` cork (102), `-` low cork (101), `o` hole,
`1`-`4` players, `a`-`l` enemy slots 0-11, and every tile icon above. Spaces inside a row are
ignored. After editing, run `bun tools/levels/export.ts` to refresh `tanksplus.json`.

## Tools

```sh
bun tools/levels/playtest.ts [--frames 7200] [--level N] [--players 1,2,4] [--events] [--quiet]
bun tools/levels/classic-trace.ts        # original campaign unchanged (exit 1 on a difference)
bun tools/levels/export.ts [--check]     # tanksplus.json
```

`playtest.ts` checks every level statically (validateLevel, registered types, 4 player spawns,
every enemy reachable by shells or tanks through open cells / teleporters / breakable or gated
walls, no boxed-in spawns) and plays it headless with the aim bot (`tools/levels/bot.ts`:
grid pathing, line-of-sight shots, dodging, shoots glass / crates open, tries switches when
walled off) in 1P and 4P with infinite lives. It fails on exceptions, NaN / out-of-field /
in-block tanks and deaths in the first 1.5 s that a player did not cause, and prints the bot's
time to clear and deaths per level.

In the browser: `import('/src/dev/tanksplus.ts').then(m => m.play(LEVEL, PLAYERS))` starts a
level past its intro; `m.playBot(LEVEL, PLAYERS, FRAMES)` lets the bot play first.

## Known gaps

- The original result layout has rows for types 1-9 only; added types are counted in
  `GameStats` (`killsByType`, `typeOrder`) for the web results screen.
- Players 3 and 4 use the P1 model and check mark (as before).
- Enemy / 3rd-4th-player mines: `Mine.collideWithField` looks the owner up as `slot - 2`,
  which is not the owner since enemy slots start at 4. Left alone for the classic missions
  (bit-for-bit); `Plus.collide` re-checks arming against `mine.owner` in Tanks+ levels.
