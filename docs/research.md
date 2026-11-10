# "Tanks!" — gameplay specification for a 1:1 recreation

Research compiled 2026-11-09. Target: the USA release, game ID RHAE01.

This document is the reference spec. Every fact carries a source tag and a confidence level. Where sources disagree, all versions are listed and the reason for preferring one is given.

---

## 0. Sources and confidence

### 0.1 Source tags

| Tag | Source | Notes |
|---|---|---|
| **[DISC]** | The game's own data files, extracted from the disc image in this repo (`rom/*.rvz`, RHAE01 **Rev 0**). Files: `files/Common/RPTnkScene/common.carc` → `param/TnkGameParam.bin` (all tank stats + the 100-mission table), `MapData/TnkMapData_P{1,2}_{00..29}_{0,1}.bin` (all 30 arena layouts, 1P/2P, 4:3/16:9), `G3D/*.brres` (models), `tnk_footmark/*.bti` (tread textures); `files/US/PartyStatic/local.carc` → `party_message.bmg` (every on-screen string); `files/US/RPTnkScene/local.carc` → `tank.arc` (HUD layouts). | The data was read with throwaway scripts in `/tmp`. Nothing was added to the repo. This is the authoritative source: these are the exact numbers the game runs on. |
| **[DECOMP]** | Matching decompilation of the game (USA **Rev 1**), cloned to `build/decomp` (its git remote has the source). Code under `src/Pack/RPParty/RPTnkScene/` and `src/Pack/RPParty/RPPartyCommon/` (RPTnkMapData, RPMedalResult_2). Field names and comments come from the decomp authors, who mark their confidence as [H]/[M]/[L]. | Explains how [DISC] values are used, and holds constants compiled into the code (mine fuse, blast radius, cell size, timers, music masks). Rev 1 code vs Rev 0 data: no differences in Tanks! are known. |
| **[TR]** | TanksRebirth (RighteousRyan1), a faithful PC remake: https://github.com/RighteousRyan1/TanksRebirth. Files `GameContent/Tanks/AI/AIManager.cs`, `GameContent/Tanks/PlayerTank.cs`, `GameContent/Tanks/TankProperties.cs`, `GameContent/Tanks/AI/AIParameters.cs`, `GameContent/Systems/Coordinates/MapGrid.cs`, `GameContent/Block.cs`, `GameContent/Mine.cs`. Its campaign file: https://github.com/RighteousRyan1/tanks_rebirth_motds/blob/master/Vanilla.campaign | Its tank parameters are labelled "Word 1..42" of the original struct ("values from the source. thanks 8fv"). They match [DISC] almost exactly; the exceptions are listed in §4.4. Its missions 1–20 match [DISC]. **Its missions 21–100 are fan-made** (the original randomises them), so do not use them. |
| **[NF]** | A fan wiki's Tanks! page (wikitext fetched through the MediaWiki API) | The most complete fan page. Its stats table, music table and post-20 mission rules are mostly confirmed by [DISC]/[DECOMP]. |
| **[WS]** | A second fan wiki's Tanks! page | Has several errors; see §11. |
| **[BS]** | brightsoo Tanks mission list: https://brightsoo.com/tanks/missions/ | Screenshots of missions 1–20 and the milestone missions; text on the randomisation rules. |
| — | StrategyWiki and TCRF | Behind Cloudflare challenges, so they could not be read. Not used. GameFAQs was not needed because [DISC] holds the full mission table. |

### 0.2 Confidence levels

- **H (high)**: read directly from [DISC] data, or from [DECOMP] code whose meaning is unambiguous, ideally confirmed by a second source.
- **M (medium)**: [DECOMP] code whose field name was inferred by the decomp authors, or a single fan source that does not contradict the data.
- **L (low)**: inference or an unverified fan claim.

### 0.3 Units used in this document

- **Time** is in frames. The game runs at 60 frames/s. Check: the mine fuse is 600 frames in code, and fans report it as 10 seconds.
- **Distance** is in world units. One map cell is **35 × 35 units** (`RPTnkField::sCellWidth/sCellDepth = 35`) [DECOMP H].
- **Speeds** are units per frame. Example: player speed 1.8 u/f = 108 u/s ≈ 3.1 cells/s.
- **Map coordinates** are `(x, y)` with x = column 0–21 (left → right) and y = row 0–16 (top/far → bottom/near). The world position of a cell centre is `x·35 − 367.5`, `z = y·35 − 280` (grid centred on the origin; −z is the far/top side of the screen) [DECOMP `RPTnkField::GetCellPos` H].

---

## 1. Overview, modes and rules

### 1.1 Where it sits in the original collection
- Tanks! is the ninth and last game in its collection. It is unlocked by playing Charge! [WS M].
- Title string: "Tanks!". Instruction card text: "Remote: Aim / [Nunchuk stick] or [+Control Pad]: Steer tank / [B]: Fire / [A]: Drop a mine" [DISC bmg #312 H].
- There is no "Training" mode for Tanks!. The modes are 1 player (campaign) and 2 players (semi-co-op) [DECOMP `RPTnkGameManager` modes 0/1 H].

### 1.2 One-player campaign
- **Number of missions: 100.** `STAGE_NUM = 100` [DECOMP H]; the mission table in TnkGameParam.bin has 100 records [DISC H].
  - On a save **without a Tanks! gold medal**, a session ends after **Mission 20**: `mLastStage = 19` unless the saved medal is ≥ 3 (gold) [DECOMP `SetupFirstStage` H]. Clearing Mission 20 plays the "complete 20" fanfare (BGM `RP_TNK_BGM_COMP20`) and goes to results.
  - Once gold is saved, later sessions run to **Mission 100** (`mLastStage = 99`). Clearing 100 plays `RP_TNK_BGM_COMP100` [DECOMP H]. [NF] describes the same thing ("discreetly unlocking an additional 80 missions").
  - The last mission of the session is announced as **"Final Mission"** instead of "Mission N" (Mission 20 on a locked save, Mission 100 on an unlocked one) [DECOMP `RPTnkFade::Calculate` + DISC bmg #265 H].
- **Lives:** start with **3** (`TnkGameParam.bin` word 0 = 3) [DISC H]. Lives are clamped to 0–99 [DECOMP `AddLives` H].
- **Extra life:** +1 on clearing missions **5, 10, 15, …, 95** (19 bonuses in all; Mission 100 has none). This is the per-mission `bonus[0]` flag [DISC H]. The bonus is shown on the next mission's intro screen as **"Bonus Tank!"** with the 1-UP sound [DECOMP `RPTnkFade` + DISC bmg #255 H]. [NF]/[WS] say "every five missions" (agrees).
- **On death (1P):** the round freezes, "miss" jingle (`RP_TNK_BGM_MISS`), wait **120 frames**, fade out, then **the same mission restarts on the same map**. Only the enemies still alive respawn, each at its original spawn slot. Destroyed enemies stay dead [DECOMP `StatePlay`/`StateMissWait`/`ReloadStage` H; NF agrees]. The player respawns at the start position. Tread marks and X marks are cleared (see §6).
- **Game over:** losing your last life shows **"Mission failed!"**, plays `RP_TNK_BGM_RESULT2`, then the results screen [DECOMP H; DISC bmg #253].
- **Mission clear:** when the enemy count reaches 0: freeze, **"Mission cleared!"** with the destroyed-tank total, `RP_TNK_BGM_FILL2`, fade out, next mission [DECOMP `CheckStageClear` H].
- **Score = number of enemy tanks destroyed.** Enemies destroyed by other enemies (or by their own shells and mines) also count for P1 in 1P [DECOMP `RPTnkTank::Explode`: hit id 3 = enemy-caused, credited to P1 only in mode 0 H; NF agrees].
- Total score for a full 100-mission run: **540** [DISC sum H; NF agrees].

### 1.3 Two-player mode
- P1 blue tank, P2 red tank [NF; DISC models `tnk_tank_1p`/`tnk_tank_2p` H].
- **20 missions only**: `mLastStage = 19` always [DECOMP H]. Same arenas as 1P missions 1–20, with separate 2P spawn layouts. Enemy assignments sometimes differ; see the 2P column in §5 [DISC H].
- Each player has **1 life** (`SetAllLives(1)`). The game ends only when **both** players are destroyed in the same mission. A player destroyed alone sits out the rest of that mission and respawns at the next one [DECOMP H; NF agrees]. No bonus lives in 2P (`bonus[1]` is 0 for every mission) [DISC H].
- At the start of a session the two player start positions are randomly swapped, 50% chance [DECOMP `LoadStage` `mSwapPlayers` H].
- Score: each player's own kills. Enemy-caused kills score for nobody in 2P [DECOMP H; NF agrees]. Winner = more kills; a tie is possible (`GetWinner` returns −1) [DECOMP H].
- Friendly fire is on: shells and mines hit the other player [NF; DECOMP shells hit any tank H].
- A "Hit!" popup appears at a destroyed tank (ring of 16 popups) [DECOMP `RPTnkHitPopup` M].
- Known quirk: enemy AI checks "is this a player's shell/mine?" with `owner slot == 0` only. So P2's shells and mines get the **CPU-shell** detection ranges, and enemies dodge P2's shots from further away than P1's [DECOMP `RPTnkShellPool`/`AddTankAvoidance` H; NF describes the same "developer oversight"].

### 1.4 Medals (1P, based on tanks destroyed)
Table `{11, 32, 84, 125}` in `RPMedalResult_2.cpp` [DECOMP H]:

| Medal | Tanks destroyed | = clearing mission |
|---|---|---|
| Bronze | 11 | 5 |
| Silver | 32 | 10 |
| Gold | 84 | 20 (also unlocks missions 21–100 for future sessions) |
| Platinum | 125 | 30 |

Kill totals are fixed, since every enemy must die to advance. Cumulative totals from [DISC]: M5 = 11, M10 = 32, M20 = 84, M30 = 125, M100 = 540 [H; NF/WS agree]. Medal popup texts (bmg #577–580) include promotions: private first class, sergeant, general, five-star general ("You might have what it takes to clear Mission 100, sir!") [DISC H].

### 1.5 After results
- Results list (§6.6) → medal screen (1P) or winner screen (2P) → menu with "Try again" / "Quit" (choice 0 = retry, 1 = quit) [DECOMP `StateEndMenu` H].
- Record line format: "Record: N tanks" [DISC bmg #465/466 H].

---

## 2. Controls

| Input | Action | Source |
|---|---|---|
| Remote pointer (held vertically, aimed at the screen) | Moves the on-screen reticle. The turret always points at the reticle's projected floor position (instant, no turn rate) | [DECOMP `AimAtCursor` H] |
| Nunchuk Control Stick | Drive (analog) | [DECOMP `GetMoveInput` H] |
| +Control Pad (D-pad), when no Nunchuk is attached | Drive (8-way, normalised) | [DECOMP H]; [NF] "Nunchuk optional" |
| **B** (trigger) | Fire a shell (on press; holding does not auto-fire) | [DECOMP `HandleFireInput` uses `getTrigger` H] |
| **A** | Lay a mine. If A and B arrive in the same frame, A wins | [DECOMP H] |
| + | Pause | [NF M] |

Details [DECOMP `RPTnkPlayerController` H]:
- **Stick dead zone 0.12, full speed at 0.85.** Between those, target speed scales linearly (0.12 → 0, 0.85 → max) [DISC words 0x5C/0x60].
- The tank has **tank steering**. It turns its hull toward the input direction at the turn rate. It only **accelerates** when its facing is within **10°** (Nunchuk) or **46°** (D-pad) of the input direction. Outside that angle it brakes (speed × 0.6 per frame) while it pivots. If the input direction is closer to the tank's rear, the tank **reverses** instead of turning around.
- **Rumble:** fire = rumble for 6 frames; mine = 16 frames [DECOMP M (`startSimpleRumble(…, 6/16, 32)`)].
- Some hit and mine sounds also play from the **remote speaker** (`*_CSPK` sound IDs) [DECOMP/DISC H].
- Mission 1 shows control hints in sequence: "Move the tank with [stick] or [D-pad]." → "Aim at the enemy tank." → "Fire with [B]." → "Drop mines with [A]." [DISC bmg #285–288 H]. They advance once the player drives right of centre (x ≥ 10 units) and the cursor nears the enemy [DECOMP `RPTnkExGuide` M]. This is why Mission 1's map has a sealed-off strip at the bottom (row 12 wall): the hint panel covers that area (inference, M).

---

## 3. Player tank

All values [DISC H] (record 0 of TnkGameParam.bin), interpreted with [DECOMP H]:

| Property | Value |
|---|---|
| Colour | Blue (P1); P2 red. X-marks and destruction colour per player |
| Max speed | **1.8 u/frame** (108 u/s ≈ 3.09 cells/s) |
| Acceleration | +0.3 u/frame per frame (full speed in 6 frames) |
| Braking/turn friction | speed × **0.6** each frame without input or while pivoting |
| Hull turn rate | 0.08 side-step per frame ≈ atan(0.08) = **4.6°/frame** (~275°/s) |
| Max shells on screen | **5** |
| Shell ricochets | **1** (dies on the 2nd wall contact) |
| Shell speed | **3 u/frame** (180 u/s ≈ 5.1 cells/s) |
| Fire cooldown | **6 frames** |
| Movement freeze after firing | **5 frames**. This is the "movement is briefly halted while firing" [NF] |
| Max mines | **2** |
| Mine cooldown | 6 frames |
| Movement freeze after laying a mine | 1 frame |
| Lives | 3 |

Physical sizes [DECOMP H]:
- Model scale 1.6. Hull hit radius vs shells/mines **15**. Collision radius vs walls/blocks **16** (tank diameter ≈ 32 u ≈ 0.9 cell).
- Muzzle **25.6 u** ahead of the tank centre, at turret height 11 × 1.6 = 17.6.
- Shells are not created if the muzzle point is inside a block or outside the field [`FireShell` H]. This stops point-blank shots through walls.
- Tread marks are stamped 10 u to each side of the centreline [`TnkTreadCoord` H].

Combat rules [DECOMP H unless noted]:
- **Everything has 1 hit point.** Shells or mine blasts destroy any tank, including your own.
- **Own shells can kill you** once the shell is **≥ 4 frames old** (`mAge >= 4 || owner != hitTank`).
- **Point-blank wall rule:** a shell that touches a wall within its first **6 frames** is destroyed instead of ricocheting.
- **Shell vs shell:** both are destroyed (`CollideShellWithShells`), whoever owns them [NF agrees].
- **Shell vs mine:** the mine detonates immediately and the shell is destroyed. Exception: a shell passes through a mine laid by its own tank during the shell's first 16 frames (`age >= 16 || owners differ`).
- **Explosion vs shells:** shells do not check explosions in the decomp. A blast only catches a shell that hits the mine itself. [NF] claims mines "destroy … bullets within the blast radius". **Conflict, decomp favoured (M).**
- Pools: at most **32 shells** and **16 mines** in the whole field at once.

---

## 4. Enemy tanks

### 4.1 Summary table

Type IDs 1–9 are the game's own IDs (`mEnemyType`). They also set the "rank" used by the music (§7). Colours are the wiki swatches [WS M]. Nicknames are fan names (Ash = grey, Marine = teal, Violet = purple) [NF/TR].

| ID | Name (alt names) | Swatch [WS] | First mission [DISC] | Moves? speed (u/f) | Shell | Speed | Ricochets | Max shells | Fire cooldown | Mines | Special |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **Brown** | `#a17a3a` | 1 | **Stationary** (0) | normal | 3 | 1 | 1 | 300 f (5 s) | 0 | Turret wanders: aim error ±170°, very slow turret |
| 2 | **Ash** (grey, dark grey) | `#767064` | 2 | Slow 1.2 | normal | 3 | 1 | 1 | 180 f | 0 | Defensive; dodges |
| 3 | **Marine** (teal) | `#407c71` | 5 | Slow 1.0 (turns fast 0.2) | **fast rocket** (smoke trail) | **6** | **0** | 1 | 180 f | 0 | **Perfect aim (±0°)**; keeps distance (aggression −0.1) |
| 4 | **Pink** (red) | `#ca5f69` | 10 | Slow 1.2 | normal | 3 | 1 | **3** | **30 f** | 0 | Offensive (aggression 0.2); can shoot while evading |
| 5 | **Yellow** | `#d8c130` | 8 | Normal 1.8 | normal | 3 | 1 | 1 | 180 f | **4** | Mine layer: 50% chance per mine check |
| 6 | **Violet** (purple) | `#815c80` | 15 | Normal 1.8 | normal | 3 | 1 | **5** | 30 f | 2 | Offensive |
| 7 | **Green** (light green) | `#52874a` | 12 | **Stationary** (0) | **fast rocket** (green-trail variant) | **6** | **2** | 2 | 60 f | 0 | Bank-shot specialist, ±80° aim scan |
| 8 | **White** | `#e7dbae` | 20 | Slow 1.2 | normal | 3 | 1 | 5 | 30 f | 2 | **Turns invisible when the mission starts**; tracks stay visible |
| 9 | **Black** | `#383630` | 50 | **Very fast 2.4** | **fast rocket** | **6** | **0** | 3 | 60 f | 2 | Aim ±5°; ignores the player's mines |

The player's tank (§3) uses the same struct: speed 1.8, 5 shells, 1 ricochet, 2 mines.

### 4.2 Full raw parameter table

This is the 42-word (0xA8-byte) record per tank type from `param/TnkGameParam.bin`, starting at offset 4: record 0 = player, records 1–9 = enemy IDs 1–9 [DISC H].

Field meanings come from [DECOMP]: `RPTnkAiMove::Params`, `RPTnkAiAttack::Params`, `RPTnkPlayerParams`, `TnkEnemyParamsData`. TanksRebirth's "Word N" numbering is offset/4 + 1, and its names agree [TR]. Most meanings are H. Rows marked "AI:" are M (decomp-assigned names). Float values are shown rounded.

| Off | Meaning | Player | Brown | Ash | Marine | Pink | Yellow | Violet | Green | White | Black |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0x00 | stealth: turns invisible when the mission starts (1 = yes) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| 0x04 | mine: clear-direction distance checked before laying (units) | 100 | 100 | 100 | 100 | 100 | 100 | 200 | 100 | 200 | 200 |
| 0x08 | max mines on the field at once | 2 | 0 | 0 | 0 | 0 | 4 | 2 | 0 | 2 | 2 |
| 0x0C | mine-check interval max (frames) | 60 | 0 | 0 | 0 | 0 | 60 | 60 | 0 | 60 | 60 |
| 0x10 | mine-check interval min (frames) | 40 | 0 | 0 | 0 | 0 | 40 | 40 | 0 | 40 | 40 |
| 0x14 | no mine if another (allied) tank is within this distance (units) | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 100 |
| 0x18 | chance % to lay a mine when a breakable block is near | 100 | 0 | 0 | 0 | 0 | 50 | 5 | 0 | 5 | 5 |
| 0x1C | chance % to lay a mine otherwise | 10 | 0 | 0 | 0 | 0 | 50 | 3 | 0 | 3 | 3 |
| 0x20 | mine cooldown (frames between mines) | 6 | 6 | 6 | 6 | 6 | 6 | 6 | 6 | 6 | 6 |
| 0x24 | stun after laying a mine (frames immobile) | 1 | 3 | 3 | 3 | 3 | 1 | 1 | 3 | 1 | 1 |
| 0x28 | acceleration (speed gained per frame) | 0.3 | 0 | 0.3 | 0.3 | 0.3 | 0.3 | 0.3 | 0 | 0.3 | 0.3 |
| 0x2C | deceleration factor per frame (speed *= x while turning / no input) | 0.6 | 0 | 0.6 | 0.6 | 0.6 | 0.6 | 0.6 | 0 | 0.6 | 0.6 |
| 0x30 | AI: max random deviation of wander direction (deg) | 30 | 0 | 30 | 30 | 30 | 30 | 30 | 0 | 30 | 30 |
| 0x34 | AI: movement re-decision timer max (frames) | 10 | 0 | 15 | 10 | 10 | 15 | 10 | 0 | 10 | 10 |
| 0x38 | AI: movement re-decision timer min (frames) | 5 | 0 | 10 | 5 | 5 | 10 | 5 | 0 | 5 | 5 |
| 0x3C | AI: avoid radius for mines laid by CPU tanks (units) | 120 | 0 | 120 | 120 | 120 | 130 | 120 | 0 | 120 | 120 |
| 0x40 | AI: detection range for shells fired by CPU tanks (units) | 120 | 0 | 120 | 120 | 120 | 120 | 120 | 0 | 120 | 120 |
| 0x44 | AI: avoid radius for mines laid by player 1 (units; 0 = ignores them) | 120 | 0 | 0 | 0 | 0 | 160 | 160 | 0 | 160 | 0 |
| 0x48 | AI: detection range for shells fired by player 1 (units) | 60 | 0 | 40 | 40 | 40 | 40 | 60 | 0 | 40 | 100 |
| 0x4C | AI: cannot shoot while evading (1 = yes) | 1 | 0 | 1 | 1 | 0 | 1 | 1 | 0 | 1 | 0 |
| 0x50 | AI: pull toward the player ("aggressiveness"; negative = keeps away) | 0.1 | 0 | 0.03 | -0.1 | 0.2 | 0 | 0.1 | 0 | 0.1 | 0.2 |
| 0x54 | AI: direction-history length averaged | 4 | 4 | 4 | 4 | 4 | 4 | 4 | 4 | 4 | 4 |
| 0x58 | max speed (units/frame; 0 = stationary) | 1.8 | 0 | 1.2 | 1 | 1.2 | 1.8 | 1.8 | 0 | 1.2 | 2.4 |
| 0x5C | player only: stick dead-zone (no movement below this deflection) | 0.12 | 0.12 | 0.12 | 0.12 | 0.12 | 0.12 | 0.12 | 0.12 | 0.12 | 0.12 |
| 0x60 | player only: stick deflection for full speed | 0.85 | 0.85 | 0.85 | 0.85 | 0.85 | 0.85 | 0.85 | 0.85 | 0.85 | 0.85 |
| 0x64 | turn rate (side component per frame; atan(x) = degrees/frame) | 0.08 | 0.08 | 0.08 | 0.2 | 0.08 | 0.08 | 0.08 | 0.08 | 0.08 | 0.06 |
| 0x68 | only accelerate when facing within this angle of desired direction (deg); player: Nunchuk value, D-pad uses 46 | 10 | 10 | 10 | 10 | 10 | 10 | 10 | 10 | 10 | 5 |
| 0x6C | AI: obstacle look-ahead (probe steps/frames) | 50 | 30 | 30 | 30 | 50 | 30 | 50 | 50 | 50 | 50 |
| 0x70 | AI: aim inaccuracy (+- deg random offset from the player) | 40 | 170 | 40 | 0 | 40 | 40 | 40 | 80 | 40 | 5 |
| 0x74 | max own shells on the field at once | 5 | 1 | 1 | 1 | 3 | 1 | 5 | 2 | 5 | 3 |
| 0x78 | AI: do not fire if predicted path passes within this cone of itself (deg) | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| 0x7C | AI: do not fire if path passes within this cone of an ally (deg) | 20 | 20 | 20 | 20 | 20 | 20 | 20 | 20 | 20 | 20 |
| 0x80 | AI: fire only if path passes within this cone of the player (deg) | 20 | 20 | 20 | 20 | 20 | 20 | 20 | 20 | 20 | 20 |
| 0x84 | shell ricochets (wall bounces before the shell is destroyed) | 1 | 1 | 1 | 0 | 1 | 1 | 1 | 2 | 1 | 0 |
| 0x88 | AI: fire-decision interval max (frames) | 45 | 45 | 45 | 10 | 10 | 45 | 10 | 10 | 10 | 10 |
| 0x8C | AI: fire-decision interval min (frames) | 30 | 30 | 30 | 5 | 5 | 30 | 5 | 5 | 5 | 5 |
| 0x90 | fire cooldown (frames between shots) | 6 | 300 | 180 | 180 | 30 | 180 | 30 | 60 | 30 | 60 |
| 0x94 | shell speed (units/frame) | 3 | 3 | 3 | 6 | 3 | 3 | 3 | 6 | 3 | 6 |
| 0x98 | AI: turret turn rate (side component per frame) | 0.05 | 0.01 | 0.01 | 0.05 | 0.02 | 0.02 | 0.03 | 0.02 | 0.03 | 0.03 |
| 0x9C | AI: frames between aim re-targeting | 4 | 60 | 45 | 8 | 20 | 30 | 20 | 30 | 30 | 20 |
| 0xA0 | AI: ally distance used by the ally-cone check (units) | 70 | 70 | 70 | 70 | 70 | 70 | 70 | 70 | 70 | 70 |
| 0xA4 | stun after firing (frames immobile) | 5 | 60 | 10 | 20 | 5 | 10 | 5 | 5 | 5 | 10 |

Notes on the table:
- 0x24 / 0xA4 naming: the player controller uses 0x24 as "freeze after mine" and 0xA4 as "freeze after shot" [DECOMP H for the player]. The AI loader's [L] labels are swapped. TanksRebirth uses the player-controller meaning (MineStun = word 10 = 0x24, ShootStun = word 42 = 0xA4). This spec follows that. So Brown freezes 60 f after firing (irrelevant, since Brown doesn't move) and Marine 20 f.
- 0x5C/0x60 are read only by the player controller. Enemies carry the same values unused.
- Mine-related fields for tanks with 0 max mines are unused.
- "CPU" vs "player 1" in 0x3C–0x48: see §1.3 for the P2 quirk.

### 4.3 Shared enemy AI behaviour [DECOMP]

Movement (`RPTnkAiMove`, M; the structure is clear but the exact maths needs the code):
- Three states: **Approach** (wander toward or away from the player), **Evade** (flee incoming shells/mines), **KeepDirection** (used just after laying a mine to drive away from it).
- Every `random(min..max)` frames (0x38..0x34) the tank picks a new heading. It is the averaged direction history (4 entries) plus a random deviation up to ±0x30 degrees, plus a pull toward the player of weight 0x50. Negative weight (Marine) means it keeps away.
- An obstacle probe sweeps ahead for 0x6C steps (radius 16, every 2nd step) to steer around blocks and holes.
- Threat tracking: up to 4 incoming shells and 4 mines. Shells are noticed within 0x40 (CPU-fired) or 0x48 (P1-fired) units and only if heading toward the tank. Mines are avoided within 0x3C (CPU-laid) or 0x44 (P1-laid).
  - **0 means the tank ignores that threat.** Ash, Marine and Pink ignore the player's mines; Black does too. Brown and Green never move at all. This matches [NF] ("tanks which do not deploy mines … will not detect those of the player") and the silver-medal tip "some drive right over mines" [DISC bmg #578].
- If 0x4C = 1, the tank cannot fire while evading [NF: "When an enemy tank is 'fleeing' from a mine, they will not attempt to shoot"]. Pink, Green, Brown and Black have 0.
- Hull motion is the same model as the player: accelerate +0x28/frame only while facing within 0x68° of the desired heading, otherwise speed × 0x2C; reversing allowed.
- Enemies push each other around (tank-tank collision) [NF M].

Aiming and firing (`RPTnkAiAttack`, H):
- **Aim target** = nearest living player's position, rotated by a random angle in **±0x70 degrees**, re-picked every **0x9C** frames. **There is no lead or velocity prediction** in `PickAimTarget`. The turret turns toward the target at side-step 0x98 per frame.
- Every `random(0x8C..0x88)` frames the tank considers firing. It fires only if all of these hold:
  - fewer than 0x74 of its shells are live;
  - the fire cooldown 0x90 has elapsed;
  - it is not evading with 0x4C = 1.
- It then simulates the shot along the current turret direction, with up to `ricochets` bounces, max 250 steps, shell radius 6. It fires only if:
  - the first leg is longer than 6 steps;
  - the path does not pass within the 0x78 (5°) cone of itself;
  - the path does not pass within the 0x7C (20°) cone of an ally within 0xA0 units;
  - the path does pass within the 0x80 (20°) cone of a player.
- So Brown (±170°, slow turret, 5 s cooldown) fires only when its wandering turret happens to line up. **Green**, with ±80° scanning and a 2-bounce path check, finds bank shots, which [NF] describes as "calculated predictive aiming". The decomp shows no predictive lead, so treat Green's skill as coming from the bounce search (conflict noted, decomp favoured, M).
- Enemies will not fire through an ally. [NF] tip: brown tanks can "shield" you.

Mine laying (H):
- Every `random(0x10..0x0C)` frames, if fewer than 0x08 of its mines are live and no allied tank is within 0x14 units:
  - roll a chance: 0x18 % if a breakable (cork) block is within 80 u, else 0x1C %;
  - then look for a clear escape direction of 0x04 units;
  - lay the mine and set KeepDirection so the tank drives off.
- Yellow: 50% / 50% → frequent mines ("rapidly deploys mines" [NF]). Violet, White, Black: 5% / 3%.

White (stealth) [DECOMP H]:
- Visible during the intro. When the mission starts (activation) it plays effect `Tnk_stealth_change` and its model is hidden while it is alive (`mState == 2 && mStealth`).
- Its tread marks stay visible [NF H]. [NF] says White's tracks are thicker and darker and that the true position is just ahead of the newest marks. Each enemy type has its own tread texture `tnk_footmark/tnk_mark_e_1..9.bti` [DISC H].
- [TR] gives White a "thick" track type.

### 4.4 Where TanksRebirth deviates from the disc data (do not copy these)
- `CantShootWhileFleeing`: TR Pink = true, White = false, Black = true. [DISC] has Pink 0, White 1, Black 0.
- Player turn speed: TR 0.1, disc 0.08.
- Player mine stun: TR 1 (comment says 8), disc 1.
- TR missions 21–100 are custom levels (§5.2).

---

## 5. Missions

### 5.1 How a mission is defined [DISC + DECOMP H]

Each of the 100 mission records (88 bytes, from offset 0x694 in TnkGameParam.bin) holds:
- `bonus[1P, 2P]`: extra life awarded when this mission is cleared;
- `enemyTypes[1P][8]` and `enemyTypes[2P][8]`: one entry per **spawn slot 0–7** of the map;
- `variants[1P][first,last]` and `variants[2P][first,last]`: which map file (stage 00–29) to use.

Enemy entry encoding (`ChooseEnemyType`):
- `0` = slot unused;
- `1`–`9` = that tank type;
- **two-digit `ab`** = random type uniformly in **a..b inclusive**, rolled when the mission is first loaded. Example: `38` = Marine..White.
- The types rolled are kept for restarts after a death (`ReloadStage` respawns the same types).

Map choice (`PickStageVariant`): if first == last, that map; otherwise random in [first, last], re-rolled until it differs from the previous mission's map.

### 5.2 Structure of the campaign (confirms [NF] and [BS])
- Missions **1–20** and every tenth mission **30, 40, …, 100** are fully fixed: map + tank types.
- Other missions use a random map from a pool and random tank types per slot. **Only the tank count is fixed.**
- Tank counts: M21–33: 4; M34–39: 5 (slot 4 is a fixed Brown); M41–49: 5; M51–59: 5; M61–69: 6; M71–79: 6; M81–89: 7; M91–99: 8.
  - [NF] says "4 tanks from 21, 5 from 34, 6 from 61, 7 from 81, 8 from 91" (agrees).
  - [NF] says "the tank in the top-left in mission 35 is always brown". The data shows missions **34–39** all have a fixed Brown in slot 4; its position depends on the map rolled (partial conflict, data favoured).
- New maps enter on M25 (stage 16), M35 (17), M45 (18), M55 (19), M65 (20). On those missions the map is fixed but tanks are random.
- Map pools:

| Missions | Pool |
|---|---|
| 21–29, 31–39 | stages 0–8 |
| 41–49 | 9–17 |
| 51–59 | 9–18 |
| 61–69 | 0–19 |
| 71–79, 81–89 | 0–20 |
| 75 | 21–24 (milestone maps of 30/40/60/70) |
| 85 | 21–25 |
| 91–99 | 0–25 |

  The maps of missions 1, 4, 5 and 20 (stages 29, 27, 26, 28) are never in a random pool [NF agrees].
- Fixed milestone maps reuse earlier arenas:
  - **M50 = Mission 5's map** (stage 26);
  - **M90 = Mission 4's all-hole map** (stage 27, 8 Ash);
  - **M100 = Mission 1's map** (stage 29).

### 5.3 Full mission table [DISC H]

Type key: 1 Brown, 2 Ash, 3 Marine, 4 Pink, 5 Yellow, 6 Violet, 7 Green, 8 White, 9 Black.

The "Enemy slots" columns give the value for spawn slot e0…e7 of the map. Spawn positions are in §5.4.

| Mission | Extra life on clear (1P) | Enemies (1P) | Count | Enemy slots 0-7 (1P) | Map stage file(s) | Enemy slots 0-7 (2P) |
|---|---|---|---|---|---|---|
| 1 |  | 1x Brown | 1 | `1 0 0 0 0 0 0 0` | 29 | `1 0 0 0 0 0 0 0` |
| 2 |  | 1x Ash | 1 | `2 0 0 0 0 0 0 0` | 0 | `2 0 0 0 0 0 0 0` |
| 3 |  | 1x Brown, 2x Ash | 3 | `1 0 2 2 0 0 0 0` | 1 | `1 0 2 2 0 0 0 0` |
| 4 |  | 2x Ash, 2x Brown | 4 | `2 0 0 1 2 1 0 0` | 27 | `0 1 1 0 0 2 2 0` |
| 5 | yes | 2x Marine | 2 | `0 3 3 0 0 0 0 0` | 26 | `3 0 0 3 0 0 0 0` |
| 6 |  | 2x Marine, 2x Ash | 4 | `3 0 2 0 0 3 2 0` | 9 | `3 0 2 0 0 3 2 0` |
| 7 |  | 4x Marine | 4 | `3 0 3 0 3 3 0 0` | 2 | `0 3 3 0 3 3 0 0` |
| 8 |  | 3x Yellow, 2x Marine | 5 | `5 3 3 0 0 5 5 0` | 10 | `5 3 3 0 0 5 5 0` |
| 9 |  | 4x Ash, 2x Yellow | 6 | `2 5 5 2 2 2 0 0` | 3 | `2 5 5 2 2 2 0 0` |
| 10 | yes | 2x Pink | 2 | `4 0 4 0 0 0 0 0` | 11 | `0 0 0 4 4 0 0 0` |
| 11 |  | 2x Marine, 2x Ash, 2x Pink | 6 | `3 2 4 0 0 3 4 2` | 4 | `3 2 4 0 0 3 4 2` |
| 12 |  | 2x Green, 2x Pink | 4 | `0 7 7 4 4 0 0 0` | 12 | `0 7 7 4 4 0 0 0` |
| 13 |  | 3x Marine, 3x Yellow | 6 | `3 0 3 0 3 5 5 5` | 5 | `3 0 3 0 3 5 5 5` |
| 14 |  | 3x Green, 3x Pink | 6 | `7 4 7 4 4 0 7 0` | 13 | `4 7 7 7 0 4 4 0` |
| 15 | yes | 3x Violet | 3 | `6 0 6 0 0 6 0 0` | 6 | `6 0 0 0 0 6 0 6` |
| 16 |  | 2x Green, 3x Violet | 5 | `7 6 6 6 0 0 0 7` | 7 | `6 6 6 7 7 0 0 0` |
| 17 |  | 6x Green | 6 | `7 7 7 0 7 7 7 0` | 14 | `0 7 7 7 7 7 7 0` |
| 18 |  | 2x Marine, 2x Violet, 1x Pink, 1x Green | 6 | `0 3 3 6 6 4 7 0` | 15 | `4 3 3 0 0 6 6 7` |
| 19 |  | 8x Violet | 8 | `6 6 6 6 6 6 6 6` | 8 | `6 6 6 6 6 6 6 6` |
| 20 | yes | 2x White | 2 | `8 0 0 8 0 0 0 0` | 28 | `0 0 0 0 0 0 8 8` |
| 21 |  | rand Marine..White (3-8); rand Marine..Violet (3-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 4 | `38 36 15 15 0 0 0 0` | random 0-8 (no immediate repeat) | `38 36 15 15 0 0 0 0` |
| 22 |  | rand Marine..White (3-8); rand Marine..Violet (3-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 4 | `38 36 15 15 0 0 0 0` | random 0-8 (no immediate repeat) | `38 36 15 15 0 0 0 0` |
| 23 |  | rand Marine..White (3-8); rand Marine..Violet (3-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 4 | `38 36 15 15 0 0 0 0` | random 0-8 (no immediate repeat) | `38 36 15 15 0 0 0 0` |
| 24 |  | rand Marine..White (3-8); rand Marine..Violet (3-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 4 | `38 36 15 15 0 0 0 0` | random 0-8 (no immediate repeat) | `38 36 15 15 0 0 0 0` |
| 25 | yes | rand Marine..White (3-8); rand Marine..Violet (3-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 4 | `38 36 15 15 0 0 0 0` | 16 | `38 36 15 15 0 0 0 0` |
| 26 |  | rand Marine..White (3-8); rand Marine..Violet (3-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 4 | `38 36 15 15 0 0 0 0` | random 0-8 (no immediate repeat) | `38 36 15 15 0 0 0 0` |
| 27 |  | rand Marine..White (3-8); rand Marine..Violet (3-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 4 | `38 36 15 15 0 0 0 0` | random 0-8 (no immediate repeat) | `38 36 15 15 0 0 0 0` |
| 28 |  | rand Marine..White (3-8); rand Marine..Violet (3-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 4 | `38 36 15 15 0 0 0 0` | random 0-8 (no immediate repeat) | `38 36 15 15 0 0 0 0` |
| 29 |  | rand Marine..White (3-8); rand Marine..Violet (3-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 4 | `38 36 15 15 0 0 0 0` | random 0-8 (no immediate repeat) | `38 36 15 15 0 0 0 0` |
| 30 | yes | 1x Green, 2x Violet, 2x White | 5 | `7 0 6 8 0 6 8 0` | 21 | `7 0 6 8 0 8 0 6` |
| 31 |  | rand Pink..White (4-8); rand Marine..Green (3-7); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 4 | `48 37 15 15 0 0 0 0` | random 0-8 (no immediate repeat) | `48 37 15 15 0 0 0 0` |
| 32 |  | rand Pink..White (4-8); rand Marine..Green (3-7); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 4 | `48 37 15 15 0 0 0 0` | random 0-8 (no immediate repeat) | `48 37 15 15 0 0 0 0` |
| 33 |  | rand Pink..White (4-8); rand Marine..Green (3-7); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 4 | `48 37 15 15 0 0 0 0` | random 0-8 (no immediate repeat) | `48 37 15 15 0 0 0 0` |
| 34 |  | rand Pink..White (4-8); rand Marine..Green (3-7); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5); Brown | 5 | `48 37 15 15 1 0 0 0` | random 0-8 (no immediate repeat) | `48 37 15 15 1 0 0 0` |
| 35 | yes | rand Pink..White (4-8); rand Marine..Green (3-7); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5); Brown | 5 | `48 37 15 15 1 0 0 0` | 17 | `48 37 15 15 1 0 0 0` |
| 36 |  | rand Pink..White (4-8); rand Marine..Green (3-7); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5); Brown | 5 | `48 37 15 15 1 0 0 0` | random 0-8 (no immediate repeat) | `48 37 15 15 1 0 0 0` |
| 37 |  | rand Pink..White (4-8); rand Marine..Green (3-7); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5); Brown | 5 | `48 37 15 15 1 0 0 0` | random 0-8 (no immediate repeat) | `48 37 15 15 1 0 0 0` |
| 38 |  | rand Pink..White (4-8); rand Marine..Green (3-7); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5); Brown | 5 | `48 37 15 15 1 0 0 0` | random 0-8 (no immediate repeat) | `48 37 15 15 1 0 0 0` |
| 39 |  | rand Pink..White (4-8); rand Marine..Green (3-7); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5); Brown | 5 | `48 37 15 15 1 0 0 0` | random 0-8 (no immediate repeat) | `48 37 15 15 1 0 0 0` |
| 40 | yes | 1x Violet, 2x White, 1x Green, 2x Yellow | 6 | `6 8 8 7 0 5 5 0` | 22 | `0 8 8 7 0 5 5 6` |
| 41 |  | rand Pink..White (4-8); rand Pink..White (4-8); rand Marine..Green (3-7); rand Ash..Green (2-7); rand Brown..Yellow (1-5) | 5 | `48 48 37 27 15 0 0 0` | random 9-17 (no immediate repeat) | `48 48 37 27 15 0 0 0` |
| 42 |  | rand Pink..White (4-8); rand Pink..White (4-8); rand Marine..Green (3-7); rand Ash..Green (2-7); rand Brown..Yellow (1-5) | 5 | `48 48 37 27 15 0 0 0` | random 9-17 (no immediate repeat) | `48 48 37 27 15 0 0 0` |
| 43 |  | rand Pink..White (4-8); rand Pink..White (4-8); rand Marine..Green (3-7); rand Ash..Green (2-7); rand Brown..Yellow (1-5) | 5 | `48 48 37 27 15 0 0 0` | random 9-17 (no immediate repeat) | `48 48 37 27 15 0 0 0` |
| 44 |  | rand Pink..White (4-8); rand Pink..White (4-8); rand Marine..Green (3-7); rand Ash..Green (2-7); rand Brown..Yellow (1-5) | 5 | `48 48 37 27 15 0 0 0` | random 9-17 (no immediate repeat) | `48 48 37 27 15 0 0 0` |
| 45 | yes | rand Pink..White (4-8); rand Pink..White (4-8); rand Marine..Green (3-7); rand Ash..Green (2-7); rand Brown..Yellow (1-5) | 5 | `48 48 37 27 15 0 0 0` | 18 | `48 48 37 27 15 0 0 0` |
| 46 |  | rand Pink..White (4-8); rand Pink..White (4-8); rand Marine..Green (3-7); rand Ash..Green (2-7); rand Brown..Yellow (1-5) | 5 | `48 48 37 27 15 0 0 0` | random 9-17 (no immediate repeat) | `48 48 37 27 15 0 0 0` |
| 47 |  | rand Pink..White (4-8); rand Pink..White (4-8); rand Marine..Green (3-7); rand Ash..Green (2-7); rand Brown..Yellow (1-5) | 5 | `48 48 37 27 15 0 0 0` | random 9-17 (no immediate repeat) | `48 48 37 27 15 0 0 0` |
| 48 |  | rand Pink..White (4-8); rand Pink..White (4-8); rand Marine..Green (3-7); rand Ash..Green (2-7); rand Brown..Yellow (1-5) | 5 | `48 48 37 27 15 0 0 0` | random 9-17 (no immediate repeat) | `48 48 37 27 15 0 0 0` |
| 49 |  | rand Pink..White (4-8); rand Pink..White (4-8); rand Marine..Green (3-7); rand Ash..Green (2-7); rand Brown..Yellow (1-5) | 5 | `48 48 37 27 15 0 0 0` | random 9-17 (no immediate repeat) | `48 48 37 27 15 0 0 0` |
| 50 | yes | 2x Black | 2 | `9 9 0 0 0 0 0 0` | 26 | `9 9 0 0 0 0 0 0` |
| 51 |  | rand Violet..Black (6-9); rand Pink..White (4-8); rand Marine..Green (3-7); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 5 | `69 48 37 15 15 0 0 0` | random 9-18 (no immediate repeat) | `69 48 37 15 15 0 0 0` |
| 52 |  | rand Violet..Black (6-9); rand Pink..White (4-8); rand Marine..Green (3-7); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 5 | `69 48 37 15 15 0 0 0` | random 9-18 (no immediate repeat) | `69 48 37 15 15 0 0 0` |
| 53 |  | rand Violet..Black (6-9); rand Pink..White (4-8); rand Marine..Green (3-7); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 5 | `69 48 37 15 15 0 0 0` | random 9-18 (no immediate repeat) | `69 48 37 15 15 0 0 0` |
| 54 |  | rand Violet..Black (6-9); rand Pink..White (4-8); rand Marine..Green (3-7); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 5 | `69 48 37 15 15 0 0 0` | random 9-18 (no immediate repeat) | `69 48 37 15 15 0 0 0` |
| 55 | yes | rand Violet..Black (6-9); rand Pink..White (4-8); rand Marine..Green (3-7); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 5 | `69 48 37 15 15 0 0 0` | 19 | `69 48 37 15 15 0 0 0` |
| 56 |  | rand Violet..Black (6-9); rand Pink..White (4-8); rand Marine..Green (3-7); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 5 | `69 48 37 15 15 0 0 0` | random 9-18 (no immediate repeat) | `69 48 37 15 15 0 0 0` |
| 57 |  | rand Violet..Black (6-9); rand Pink..White (4-8); rand Marine..Green (3-7); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 5 | `69 48 37 15 15 0 0 0` | random 9-18 (no immediate repeat) | `69 48 37 15 15 0 0 0` |
| 58 |  | rand Violet..Black (6-9); rand Pink..White (4-8); rand Marine..Green (3-7); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 5 | `69 48 37 15 15 0 0 0` | random 9-18 (no immediate repeat) | `69 48 37 15 15 0 0 0` |
| 59 |  | rand Violet..Black (6-9); rand Pink..White (4-8); rand Marine..Green (3-7); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 5 | `69 48 37 15 15 0 0 0` | random 9-18 (no immediate repeat) | `69 48 37 15 15 0 0 0` |
| 60 | yes | 1x White, 2x Black, 1x Green | 4 | `8 9 9 0 0 0 7 0` | 23 | `8 9 9 0 0 7 0 0` |
| 61 |  | rand Violet..Black (6-9); rand Violet..Black (6-9); rand Pink..Violet (4-6); rand Marine..Violet (3-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 6 | `69 69 46 36 15 15 0 0` | random 0-19 (no immediate repeat) | `69 69 46 36 15 15 0 0` |
| 62 |  | rand Violet..Black (6-9); rand Violet..Black (6-9); rand Pink..Violet (4-6); rand Marine..Violet (3-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 6 | `69 69 46 36 15 15 0 0` | random 0-19 (no immediate repeat) | `69 69 46 36 15 15 0 0` |
| 63 |  | rand Violet..Black (6-9); rand Violet..Black (6-9); rand Pink..Violet (4-6); rand Marine..Violet (3-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 6 | `69 69 46 36 15 15 0 0` | random 0-19 (no immediate repeat) | `69 69 46 36 15 15 0 0` |
| 64 |  | rand Violet..Black (6-9); rand Violet..Black (6-9); rand Pink..Violet (4-6); rand Marine..Violet (3-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 6 | `69 69 46 36 15 15 0 0` | random 0-19 (no immediate repeat) | `69 69 46 36 15 15 0 0` |
| 65 | yes | rand Violet..Black (6-9); rand Violet..Black (6-9); rand Pink..Violet (4-6); rand Marine..Violet (3-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 6 | `69 69 46 36 15 15 0 0` | 20 | `69 69 46 36 15 15 0 0` |
| 66 |  | rand Violet..Black (6-9); rand Violet..Black (6-9); rand Pink..Violet (4-6); rand Marine..Violet (3-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 6 | `69 69 46 36 15 15 0 0` | random 0-19 (no immediate repeat) | `69 69 46 36 15 15 0 0` |
| 67 |  | rand Violet..Black (6-9); rand Violet..Black (6-9); rand Pink..Violet (4-6); rand Marine..Violet (3-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 6 | `69 69 46 36 15 15 0 0` | random 0-19 (no immediate repeat) | `69 69 46 36 15 15 0 0` |
| 68 |  | rand Violet..Black (6-9); rand Violet..Black (6-9); rand Pink..Violet (4-6); rand Marine..Violet (3-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 6 | `69 69 46 36 15 15 0 0` | random 0-19 (no immediate repeat) | `69 69 46 36 15 15 0 0` |
| 69 |  | rand Violet..Black (6-9); rand Violet..Black (6-9); rand Pink..Violet (4-6); rand Marine..Violet (3-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 6 | `69 69 46 36 15 15 0 0` | random 0-19 (no immediate repeat) | `69 69 46 36 15 15 0 0` |
| 70 | yes | 1x Green, 2x White, 3x Black | 6 | `7 8 8 0 9 9 9 0` | 24 | `7 8 8 0 9 9 9 0` |
| 71 |  | rand Green..Black (7-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Brown..Violet (1-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 6 | `79 69 47 16 15 15 0 0` | random 0-20 (no immediate repeat) | `79 69 47 16 15 15 0 0` |
| 72 |  | rand Green..Black (7-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Brown..Violet (1-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 6 | `79 69 47 16 15 15 0 0` | random 0-20 (no immediate repeat) | `79 69 47 16 15 15 0 0` |
| 73 |  | rand Green..Black (7-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Brown..Violet (1-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 6 | `79 69 47 16 15 15 0 0` | random 0-20 (no immediate repeat) | `79 69 47 16 15 15 0 0` |
| 74 |  | rand Green..Black (7-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Brown..Violet (1-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 6 | `79 69 47 16 15 15 0 0` | random 0-20 (no immediate repeat) | `79 69 47 16 15 15 0 0` |
| 75 | yes | rand Green..Black (7-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Brown..Violet (1-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 6 | `79 69 47 16 15 15 0 0` | random 21-24 (no immediate repeat) | `79 69 47 16 15 15 0 0` |
| 76 |  | rand Green..Black (7-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Brown..Violet (1-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 6 | `79 69 47 16 15 15 0 0` | random 0-20 (no immediate repeat) | `79 69 47 16 15 15 0 0` |
| 77 |  | rand Green..Black (7-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Brown..Violet (1-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 6 | `79 69 47 16 15 15 0 0` | random 0-20 (no immediate repeat) | `79 69 47 16 15 15 0 0` |
| 78 |  | rand Green..Black (7-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Brown..Violet (1-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 6 | `79 69 47 16 15 15 0 0` | random 0-20 (no immediate repeat) | `79 69 47 16 15 15 0 0` |
| 79 |  | rand Green..Black (7-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Brown..Violet (1-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 6 | `79 69 47 16 15 15 0 0` | random 0-20 (no immediate repeat) | `79 69 47 16 15 15 0 0` |
| 80 | yes | 2x Black, 2x White, 2x Yellow | 6 | `9 8 8 9 0 5 5 0` | 25 | `9 9 8 5 8 5 0 0` |
| 81 |  | rand White..Black (8-9); rand Green..Black (7-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Ash..Violet (2-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 7 | `89 79 69 47 26 15 15 0` | random 0-20 (no immediate repeat) | `89 79 69 47 26 15 15 0` |
| 82 |  | rand White..Black (8-9); rand Green..Black (7-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Ash..Violet (2-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 7 | `89 79 69 47 26 15 15 0` | random 0-20 (no immediate repeat) | `89 79 69 47 26 15 15 0` |
| 83 |  | rand White..Black (8-9); rand Green..Black (7-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Ash..Violet (2-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 7 | `89 79 69 47 26 15 15 0` | random 0-20 (no immediate repeat) | `89 79 69 47 26 15 15 0` |
| 84 |  | rand White..Black (8-9); rand Green..Black (7-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Ash..Violet (2-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 7 | `89 79 69 47 26 15 15 0` | random 0-20 (no immediate repeat) | `89 79 69 47 26 15 15 0` |
| 85 | yes | rand White..Black (8-9); rand Green..Black (7-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Ash..Violet (2-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 7 | `89 79 69 47 26 15 15 0` | random 21-25 (no immediate repeat) | `89 79 69 47 26 15 15 0` |
| 86 |  | rand White..Black (8-9); rand Green..Black (7-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Ash..Violet (2-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 7 | `89 79 69 47 26 15 15 0` | random 0-20 (no immediate repeat) | `89 79 69 47 26 15 15 0` |
| 87 |  | rand White..Black (8-9); rand Green..Black (7-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Ash..Violet (2-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 7 | `89 79 69 47 26 15 15 0` | random 0-20 (no immediate repeat) | `89 79 69 47 26 15 15 0` |
| 88 |  | rand White..Black (8-9); rand Green..Black (7-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Ash..Violet (2-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 7 | `89 79 69 47 26 15 15 0` | random 0-20 (no immediate repeat) | `89 79 69 47 26 15 15 0` |
| 89 |  | rand White..Black (8-9); rand Green..Black (7-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Ash..Violet (2-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 7 | `89 79 69 47 26 15 15 0` | random 0-20 (no immediate repeat) | `89 79 69 47 26 15 15 0` |
| 90 | yes | 8x Ash | 8 | `2 2 2 2 2 2 2 2` | 27 | `2 2 2 2 2 2 2 2` |
| 91 |  | rand White..Black (8-9); rand White..Black (8-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Ash..Violet (2-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 8 | `89 89 69 47 26 15 15 15` | random 0-25 (no immediate repeat) | `89 89 69 47 26 15 15 15` |
| 92 |  | rand White..Black (8-9); rand White..Black (8-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Ash..Violet (2-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 8 | `89 89 69 47 26 15 15 15` | random 0-25 (no immediate repeat) | `89 89 69 47 26 15 15 15` |
| 93 |  | rand White..Black (8-9); rand White..Black (8-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Ash..Violet (2-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 8 | `89 89 69 47 26 15 15 15` | random 0-25 (no immediate repeat) | `89 89 69 47 26 15 15 15` |
| 94 |  | rand White..Black (8-9); rand White..Black (8-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Ash..Violet (2-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 8 | `89 89 69 47 26 15 15 15` | random 0-25 (no immediate repeat) | `89 89 69 47 26 15 15 15` |
| 95 | yes | rand White..Black (8-9); rand White..Black (8-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Ash..Violet (2-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 8 | `89 89 69 47 26 15 15 15` | random 0-25 (no immediate repeat) | `89 89 69 47 26 15 15 15` |
| 96 |  | rand White..Black (8-9); rand White..Black (8-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Ash..Violet (2-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 8 | `89 89 69 47 26 15 15 15` | random 0-25 (no immediate repeat) | `89 89 69 47 26 15 15 15` |
| 97 |  | rand White..Black (8-9); rand White..Black (8-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Ash..Violet (2-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 8 | `89 89 69 47 26 15 15 15` | random 0-25 (no immediate repeat) | `89 89 69 47 26 15 15 15` |
| 98 |  | rand White..Black (8-9); rand White..Black (8-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Ash..Violet (2-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 8 | `89 89 69 47 26 15 15 15` | random 0-25 (no immediate repeat) | `89 89 69 47 26 15 15 15` |
| 99 |  | rand White..Black (8-9); rand White..Black (8-9); rand Violet..Black (6-9); rand Pink..Green (4-7); rand Ash..Violet (2-6); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5); rand Brown..Yellow (1-5) | 8 | `89 89 69 47 26 15 15 15` | random 0-25 (no immediate repeat) | `89 89 69 47 26 15 15 15` |
| 100 |  | 1x Green, 4x Black, 1x White, 2x Brown | 8 | `7 9 9 8 1 9 9 1` | 29 | `7 9 9 8 1 9 9 1` |

Cross-check: TanksRebirth's hand-built missions 1–20 have the same tank types and counts as this table [TR H].

### 5.4 Arena geometry and all 30 maps [DISC + DECOMP H]

**Field** [DECOMP `RPTnkField` H; TR `MapGrid` agrees]:
- 16:9: **22 columns × 17 rows**, 770 × 595 units.
- 4:3: **16 × 17**, 560 × 595.
- The 4:3 game uses separate, narrower map files (`*_0.bin`). This is why speedrunners play in 4:3 [NF].
- The field is enclosed by 4 border walls, which shells ricochet off.

**Map file format:** big-endian int32s `width, height(=17), p1BalloonDir, p2BalloonDir`, then `width × 17` cell codes, row-major from the top-left.
- Header words 2–3 orient the "P1/P2" start balloons: 0 = 0°, 1 = 180°, 2 = 90°, 3 = 270°.
- Cell codes:

| Code | Meaning |
|---|---|
| `0` | Empty floor |
| `100+h`, h = 1..7 | **Cork block**: breakable; only mine explosions destroy it; shells ricochet off it. Shown as `Ch` below |
| `200+h`, h = 1..7 | **Solid block**: indestructible. Shown as `Wh` |
| `200` | **Hole** (pit): a flat floor decal (model `tnk_block_1`, 4 vertices). It blocks tanks but bullets fly over it [NF]. Shown as `()` |
| `300` / `301` | Player 1 / Player 2 start |
| `400`–`407` | Enemy spawn slot 0–7 |

**Block heights** (h = 1..7) are **1, 1.5, 2, 2.5, 3, 3.5, 4 cells** (35, 52.5, 70, 87.5, 105, 122.5, 140 u).
- Derived from the decomp's draw code (model index `{0,2,2,1,2,2,1,2}` and sink offsets `{−0.2, 105, 87.5, 52.5, 52.5, 35, 0, 0}` for `mHeight = h + 1`).
- It also matches TanksRebirth's independent `GetHeightFromGround`: 1, 1.52, 2.04, 2.52, 3.04, 3.56, 4.04 blocks [DECOMP M + TR → H].
- Tall blocks can hide tanks, mines and shells behind them [NF].

Cork blocks are destroyed when inside a mine blast (blast radius + 17.5) [DECOMP H]. A destroyed cork block plays effect `Tnk_blockbreak01` and the `RP_TNK_SE_BROKEN` sound (shared with the shell-burst sound, M).

In the maps below, `P1` and `eN` show the **1P** layout. The 2P layout uses the same blocks with different spawn cells, listed under each map. `()` = hole, `.` = floor.

#### Stage file 00 (used by mission(s): 2)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  1   .  .  .  . e6  .  .  .  .  .  .  .  .  . e2  .  .  .  .  .  .  .
  2   .  .  .  .  .  .  .  .  . e4  .  .  .  .  .  .  .  .  .  .  .  .
  3   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e0  .  .
  4   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  5   .  .  .  . W1 W1 W1 W2 W3 W4 W4 W3 C2 C1 C1 C1  .  .  .  .  .  .
  6   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  7   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  8   .  .  .  .  . e7  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  9   .  .  .  .  .  .  .  .  .  .  . e3  .  .  .  .  .  .  .  . e1  .
 10   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 11   .  .  .  .  .  . C1 C1 C1 C2 W3 W4 W4 W3 W2 W1 W1 W1  .  .  .  .
 12   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 13   .  . P1  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 14   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 15   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e5  .
 16   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (2, 13), P2 (19, 3), enemy slots e0(10, 8), e1(19, 14), e2(1, 1), e3(9, 1), e4(11, 15), e5(20, 9), e6(11, 9), e7(1, 7).  Header balloon codes 1P=0, 2P=(0,1).

#### Stage file 01 (used by mission(s): 3)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  1   .  .  .  .  . e3  .  .  .  .  .  .  .  . e1  .  .  .  .  .  .  .
  2   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  3   .  .  . W1 W2 C1 C2 C1 C2 C1 C2 W2  .  .  .  .  .  .  .  .  .  .
  4   .  .  .  .  .  .  .  .  .  .  . W2  .  .  .  .  .  .  .  .  .  .
  5   .  .  .  .  .  .  .  .  .  .  . W2  .  .  .  .  .  .  .  .  .  .
  6   .  .  .  .  .  .  .  .  .  .  . W2  .  .  .  .  .  .  .  .  .  .
  7   .  .  .  .  .  .  .  .  .  .  . W2  .  . e4  .  .  .  .  .  .  .
  8   .  . P1  .  .  .  .  .  .  . W2 W2  .  .  .  .  .  .  . e0  .  .
  9   .  .  .  .  .  .  .  .  .  . W2  .  .  .  .  .  .  .  .  .  .  .
 10   .  .  .  .  .  .  .  .  .  . W2  .  .  .  .  .  .  .  .  .  .  .
 11   .  .  .  .  .  .  .  . e6  . W2  .  .  .  .  .  .  .  .  .  .  .
 12   .  .  .  .  .  .  .  .  .  . W2  .  .  .  .  .  .  .  .  .  .  .
 13   .  .  .  .  .  .  .  .  .  . W2 C2 C1 C2 C1 C2 C1 W2 W1  .  .  .
 14   .  .  . e7  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 15   .  .  .  .  .  .  .  .  .  .  .  . e5  .  .  .  .  . e2  .  .  .
 16   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (1, 5), P2 (8, 15), enemy slots e0(19, 8), e1(14, 1), e2(18, 15), e3(5, 1), e4(13, 8), e5(18, 3), e6(7, 7), e7(1, 13).  Header balloon codes 1P=0, 2P=(0,0).

#### Stage file 02 (used by mission(s): 7)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  1   . e5  .  .  .  .  .  .  .  .  .  .  .  . e3  .  .  .  .  .  .  .
  2   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e0  .  .
  3   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  4  W3 W2 W3 C2 W3 W2 W3 W2 W3  .  .  .  .  .  .  .  .  .  .  .  .  .
  5   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  6   .  .  .  .  .  .  .  .  .  .  .  .  . W3 W2 W3 W2 W3 C2 W3 W2 W3
  7   .  . e4  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  8   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  9   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e1  .
 10  W3 W2 W3 C2 W3 W2 W3 W2 W3  .  .  .  .  .  .  .  .  .  .  .  .  .
 11   .  .  .  .  .  .  .  .  . e7  .  .  .  .  .  .  .  .  .  .  .  .
 12   .  .  .  .  .  .  .  .  .  .  .  .  . W3 W2 W3 W2 W3 C2 W3 W2 W3
 13   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 14   .  . P1  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 15   .  .  .  .  .  .  .  .  .  .  .  .  . e6  .  .  .  .  . e2  .  .
 16   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (2, 14), P2 (19, 2), enemy slots e0(11, 8), e1(20, 9), e2(2, 7), e3(9, 9), e4(19, 15), e5(1, 1), e6(13, 15), e7(9, 1).  Header balloon codes 1P=0, 2P=(3,2).

#### Stage file 03 (used by mission(s): 9)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  1   .  .  .  .  .  .  . e5  .  .  .  . e6  .  .  .  .  .  .  .  .  .
  2   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  3   .  .  . e2  .  .  .  .  .  . W4 W4  .  .  .  .  .  .  . e0  .  .
  4   .  .  .  .  .  .  .  .  .  . C4  .  .  .  .  .  .  .  .  .  .  .
  5   .  .  .  .  .  .  .  .  .  . C4  .  . e3  .  .  .  .  .  .  .  .
  6   .  .  .  .  .  .  .  .  .  . C4  .  .  .  .  .  .  .  .  .  .  .
  7   .  .  .  .  .  .  .  .  .  . C4  .  .  .  .  .  .  .  .  .  .  .
  8  W1 W2 W3 W4 W5 W6 W7  .  .  . C4 C4  .  .  . W7 W6 W5 W4 W3 W2 W1
  9   .  .  .  .  .  .  .  .  .  .  . C4  .  .  .  .  .  .  .  .  .  .
 10   .  .  .  .  .  .  .  .  .  .  . C4  .  .  .  .  .  .  .  .  .  .
 11   .  .  .  .  .  .  .  .  .  .  . C4  .  .  .  .  .  .  .  .  .  .
 12   .  .  .  .  .  .  .  .  .  .  . C4  .  .  .  .  .  .  .  .  .  .
 13   .  . P1  .  .  .  .  .  .  . W4 W4  .  .  .  .  .  .  . e1  .  .
 14   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 15   .  .  .  .  .  .  . e7  .  .  .  .  .  . e4  .  .  .  .  .  .  .
 16   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (2, 12), P2 (19, 3), enemy slots e0(8, 7), e1(19, 13), e2(3, 3), e3(13, 5), e4(14, 15), e5(7, 1), e6(12, 1), e7(7, 15).  Header balloon codes 1P=0, 2P=(0,1).

#### Stage file 04 (used by mission(s): 11)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  . C2 e5  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  1   .  .  .  .  .  . C2  .  .  .  .  .  .  . e1  .  .  .  .  .  .  .
  2   .  . P1  .  .  . W2  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  3   .  .  .  .  .  . W2  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  4   .  .  .  .  .  . W2  .  .  .  .  .  . W5 W4 C3 C2  .  . e2  .  .
  5   .  .  .  .  .  . W2  .  .  .  .  .  .  .  .  . C2  .  .  .  .  .
  6   .  .  .  .  . W2 W2  .  .  .  .  .  .  .  .  . W2  .  .  .  .  .
  7   .  .  .  .  . W2  .  .  .  .  .  .  .  .  .  . W2  .  .  .  .  .
  8   .  .  .  .  . W2  .  .  .  . e6  .  .  .  .  . W2  .  .  .  .  .
  9   .  .  .  .  . W2  .  .  .  .  .  .  .  .  .  . W2  . e4  .  .  .
 10   .  .  .  .  . W2  .  .  .  .  .  .  .  .  . W2 W2  .  .  .  .  .
 11   .  .  .  .  . C2  .  .  .  .  .  .  .  .  . W2  .  .  .  .  .  .
 12   .  .  .  .  . C2 C3 W4 W5  .  .  .  .  .  . W2  .  .  .  .  .  .
 13   .  .  . e7  .  .  .  .  .  .  .  .  .  .  . W2  .  .  .  .  .  .
 14   .  .  .  .  .  .  .  .  .  .  .  .  .  .  . W2  .  .  . e0  .  .
 15   .  .  .  .  .  .  . e3  .  .  .  .  .  .  . C2  .  .  .  .  .  .
 16   .  .  .  .  .  .  .  .  .  .  .  .  .  .  . C2  .  .  .  .  .  .
```
2P file (same blocks): P1 (0, 3), P2 (5, 2), enemy slots e0(19, 14), e1(14, 1), e2(19, 4), e3(7, 15), e4(18, 9), e5(7, 0), e6(10, 8), e7(3, 13).  Header balloon codes 1P=1, 2P=(1,1).

#### Stage file 05 (used by mission(s): 13)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  1   .  .  .  .  .  .  .  . e5  .  .  .  .  .  .  .  .  .  .  . e2  .
  2   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  3   .  .  . W1 W1 C2 C2 W1 W1 C2 C2 W1 W1 C2 C2 W1 W1 C2 C2  .  .  .
  4   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e3  .
  5   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  6   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  7   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  8  P1  .  . C2 C2 W1 W1 C2 C2 W1 W1 C2 C2 W1 W1 C2 C2 W1 W1  .  . e0
  9   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 10   .  .  .  .  .  .  .  .  .  .  .  . e6  .  .  .  .  .  .  .  .  .
 11   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 12   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e1  .  .
 13   .  .  . W1 W1 C2 C2 W1 W1 C2 C2 W1 W1 C2 C2 W1 W1 C2 C2  .  .  .
 14   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 15   .  .  .  .  . e7  .  .  .  .  .  .  .  .  .  .  .  .  .  . e4  .
 16   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (1, 5), P2 (0, 11), enemy slots e0(21, 8), e1(19, 12), e2(20, 1), e3(20, 4), e4(20, 15), e5(8, 1), e6(12, 10), e7(5, 15).  Header balloon codes 1P=0, 2P=(3,3).

#### Stage file 06 (used by mission(s): 15)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  1   .  .  .  .  . e6  .  .  .  .  .  . e4  .  .  .  .  .  .  .  .  .
  2   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e0  .  .
  3   .  .  .  . W4 C3 W4 C3 W4  .  .  .  . W4  .  .  .  .  .  .  .  .
  4   .  .  .  . W4  .  .  .  .  .  .  .  . W4  .  .  .  .  .  .  .  .
  5   .  .  .  . W4  . e2  .  .  .  .  .  . W4  .  .  .  .  .  . e3  .
  6   .  .  .  . W4  .  .  .  .  .  .  .  . W4 C3 W4 C3 W4  .  .  .  .
  7   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  8   .  .  .  .  .  .  .  .  .  . e7  .  .  .  .  .  .  .  .  .  .  .
  9   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 10   .  .  .  . W4 C3 W4 C3 W4  .  .  .  .  .  .  .  . W4  .  .  .  .
 11   .  .  .  .  .  .  .  . W4  .  .  .  .  . e1  .  . W4  .  .  .  .
 12   .  .  .  .  .  .  .  . W4  .  .  .  .  .  .  .  . W4  .  .  .  .
 13   .  .  .  .  .  .  .  . W4  .  .  .  . W4 C3 W4 C3 W4  .  .  .  .
 14   .  . P1  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 15   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e5  .  .
 16   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (2, 14), P2 (19, 2), enemy slots e0(10, 8), e1(14, 11), e2(6, 5), e3(11, 15), e4(11, 1), e5(20, 12), e6(5, 1), e7(1, 5).  Header balloon codes 1P=0, 2P=(0,1).

#### Stage file 07 (used by mission(s): 16)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  1   .  .  .  . e5  .  .  .  . e2  .  .  .  .  .  .  .  .  .  . e0  .
  2   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  3   .  .  . W2  .  .  . C1 W2 C1 W2 C1 W2 C1 W2 W2  .  .  .  .  .  .
  4   .  .  . W2  .  .  .  .  .  .  .  .  .  .  . W2  .  .  .  .  .  .
  5   .  .  . W2  .  .  .  .  .  .  .  .  .  .  . W2  .  .  .  .  .  .
  6   .  .  . W2  .  .  . e4  .  .  .  .  .  .  . W2 W2 C1 W2  .  .  .
  7   .  .  . W2  .  .  .  .  .  .  .  .  .  .  .  .  .  . W2  .  .  .
  8   .  .  . W2  .  .  .  .  .  .  .  .  . e3  .  .  .  . W2  .  .  .
  9   .  .  . W2  .  .  .  .  .  .  .  .  .  .  .  .  .  . W2  .  .  .
 10   .  .  . W2 C1 W2 W2  .  .  .  .  .  .  .  .  .  .  . W2  .  .  .
 11   .  .  .  .  .  . W2  . e7  .  .  .  .  .  .  .  .  . W2  . e1  .
 12   .  .  .  .  .  . W2  .  .  .  .  .  .  .  .  .  .  . W2  .  .  .
 13   .  .  .  .  .  . W2 W2 C1 W2 C1 W2 C1 W2 C1  .  .  . W2  .  .  .
 14   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 15   . P1  .  .  .  .  .  .  .  .  .  .  .  .  .  . e6  .  .  .  .  .
 16   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (1, 15), P2 (20, 1), enemy slots e0(10, 8), e1(20, 11), e2(1, 5), e3(14, 8), e4(7, 6), e5(9, 1), e6(11, 15), e7(8, 11).  Header balloon codes 1P=0, 2P=(0,1).

#### Stage file 08 (used by mission(s): 19)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  1   . e0  .  .  .  .  .  . e3  .  .  .  .  .  .  .  . e6  .  .  .  .
  2   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  3  W1 C2 C2 W1 W1 C2 C2 W1 W1 C2 C2 W1 W1 C2 C2 W1 W1 C2 C2  .  .  .
  4   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  5   .  .  .  .  .  .  .  .  . e5  .  .  .  .  .  .  .  .  .  .  .  .
  6   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e1  .  .
  7   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  8   . e2  . C2 C2 W1 W1 C2 C2 W1 W1 C2 C2 W1 W1 C2 C2 W1 W1 C2 C2 W1
  9   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 10   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 11   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e4  .
 12   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 13  W1 C2 C2 W1 W1 C2 C2 W1 W1 C2 C2 W1 W1 C2 C2 W1 W1 C2 C2  .  .  .
 14   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 15   . P1  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e7  .  .  .  .
 16   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (1, 15), P2 (1, 1), enemy slots e0(1, 9), e1(19, 6), e2(19, 11), e3(2, 6), e4(8, 11), e5(9, 5), e6(17, 1), e7(17, 15).  Header balloon codes 1P=0, 2P=(3,3).

#### Stage file 09 (used by mission(s): 6)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  1   .  .  .  .  .  .  . e4  .  .  .  .  .  .  . e1  .  .  .  .  .  .
  2   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  3   .  .  .  . W3 C2 W3 C2 W3 C2 W3 W2 W3 W2 W3 W2 W3 W2  .  .  .  .
  4   .  .  .  .  .  .  .  .  .  . ()  .  .  .  .  .  . e6  .  .  .  .
  5   .  .  .  .  .  .  .  .  .  . ()  .  .  .  .  .  .  .  .  .  .  .
  6   .  .  .  .  .  .  .  .  .  . ()  .  .  .  .  .  .  .  .  .  .  .
  7   .  .  .  .  .  .  .  .  .  . ()  .  .  .  .  .  .  .  .  .  .  .
  8   .  . P1  .  .  .  .  .  .  . () ()  .  .  .  .  .  .  . e0  .  .
  9   .  .  .  .  .  .  .  .  .  .  . ()  .  .  .  .  .  .  .  .  .  .
 10   .  .  .  .  .  .  .  .  .  .  . ()  .  .  .  .  .  .  .  .  .  .
 11   .  .  .  .  .  .  .  .  .  .  . ()  .  . e3  .  .  .  .  .  .  .
 12   .  .  .  .  .  .  .  .  .  .  . ()  .  .  .  .  .  .  .  .  .  .
 13   .  .  .  . W2 W3 W2 W3 W2 W3 W2 W3 C2 W3 C2 W3 C2 W3  .  . e5  .
 14   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 15   .  .  .  . e7  .  .  .  .  .  .  .  .  .  .  .  . e2  .  .  .  .
 16   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (1, 5), P2 (0, 11), enemy slots e0(19, 8), e1(15, 1), e2(17, 15), e3(14, 11), e4(7, 1), e5(20, 13), e6(17, 4), e7(6, 15).  Header balloon codes 1P=0, 2P=(3,3).

#### Stage file 10 (used by mission(s): 8)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  . e7  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  1   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  2   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e2
  3   .  .  . C2  .  .  .  . C2 C2 W2 W2 C2 C2  .  .  .  . C2  .  .  .
  4   .  .  . C2  .  .  .  .  .  .  .  .  .  .  . e6  .  . C2  .  .  .
  5   .  .  . C2 C2  .  .  .  .  .  .  .  .  .  .  .  . C2 C2  .  .  .
  6   .  .  .  . C2  . e3  .  .  .  .  .  .  .  .  .  . C2  .  .  .  .
  7   .  .  .  . W2  .  .  .  .  .  .  .  .  .  .  .  . W2  .  .  .  .
  8   . P1  .  . W2  .  .  .  .  .  .  .  .  .  .  .  . W2  .  . e0  .
  9   .  .  .  . W2  .  .  .  .  .  .  .  .  .  .  .  . W2  .  .  .  .
 10   .  .  .  . C2  .  .  .  .  .  .  .  .  .  .  .  . C2  .  .  .  .
 11   .  .  . C2 C2  . e4  .  .  .  .  .  .  .  .  .  . C2 C2  .  .  .
 12   .  .  . C2  .  .  .  .  .  .  .  .  .  . e5  .  .  . C2  .  .  .
 13   .  .  . C2  .  .  .  . C2 C2 W2 W2 C2 C2  .  .  .  . C2  .  .  .
 14   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e1
 15   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 16   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (1, 4), P2 (1, 12), enemy slots e0(20, 8), e1(21, 14), e2(21, 2), e3(6, 6), e4(6, 11), e5(14, 12), e6(15, 4), e7(2, 8).  Header balloon codes 1P=0, 2P=(3,3).

#### Stage file 11 (used by mission(s): 10)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  1   .  .  .  .  .  .  .  .  .  .  . e2  .  .  .  .  .  .  .  .  .  .
  2   .  . W2 W2 W2 W2  .  .  .  .  .  .  .  .  .  . W2 W2 W2 W2  .  .
  3   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  4   .  .  .  . e4  .  .  .  .  .  .  .  .  .  . e6  .  .  .  . e0  .
  5   .  .  .  .  .  .  .  . W5 W5 C5 W5 W5 W5  .  .  .  .  .  .  .  .
  6   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  7   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  8   .  . C5 C5 C5 C5  .  .  .  . e7  .  .  .  .  . C5 C5 C5 C5  .  .
  9   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 10   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 11   .  .  .  .  .  .  .  . W5 W5 W5 C5 W5 W5  .  .  .  .  . e1  .  .
 12   . P1  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 13   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 14   .  . W2 W2 W2 W2  .  .  .  .  .  . e3  .  .  . W2 W2 W2 W2  .  .
 15   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 16   .  .  .  . e5  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (1, 12), P2 (20, 4), enemy slots e0(10, 8), e1(19, 11), e2(4, 4), e3(12, 14), e4(9, 1), e5(4, 16), e6(15, 1), e7(1, 1).  Header balloon codes 1P=0, 2P=(0,0).

#### Stage file 12 (used by mission(s): 12)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  . e6  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  1   .  .  .  .  .  .  .  .  .  .  .  . e4  .  .  .  .  .  .  .  .  .
  2   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  3   .  .  .  .  .  . () ()  .  .  .  .  .  .  . W3  .  .  .  .  .  .
  4   .  .  .  .  .  . () ()  .  .  .  .  .  . W3 W3  .  .  . e2  .  .
  5   .  .  .  .  .  .  .  .  .  .  .  .  . W3 W3  .  .  .  .  .  .  .
  6   .  .  .  .  .  .  .  .  .  .  .  . W3 W3  .  .  .  .  .  .  .  .
  7   .  . P1  .  .  .  .  .  .  .  . C3 W3  .  .  .  .  .  .  .  .  .
  8   .  .  .  .  .  .  .  .  .  . C3 C3  .  .  .  .  .  .  .  .  .  .
  9   .  .  .  .  .  .  .  .  . W3 C3  .  .  .  .  .  .  .  . e0  .  .
 10   .  .  .  .  .  .  .  . W3 W3  .  .  .  .  .  .  .  .  .  .  .  .
 11   .  .  .  .  .  .  . W3 W3  .  .  .  . e5  .  .  .  .  .  .  .  .
 12   .  .  .  .  .  . W3 W3  .  .  .  .  .  . () ()  .  .  .  .  .  .
 13   .  .  .  .  .  . W3  .  .  .  .  .  .  . () ()  .  .  .  .  .  .
 14   .  .  .  .  .  .  .  .  .  . e3  .  .  .  .  .  .  .  .  .  .  .
 15  e7  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e1  .  .  .  .
 16   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (1, 4), P2 (6, 7), enemy slots e0(19, 9), e1(17, 15), e2(19, 4), e3(10, 14), e4(12, 1), e5(13, 11), e6(7, 0), e7(0, 15).  Header balloon codes 1P=0, 2P=(0,0).

#### Stage file 13 (used by mission(s): 14)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  1   .  .  . e5  .  .  .  .  .  .  .  .  .  .  . e3  .  .  .  . e0  .
  2   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  3   .  .  . W3 W2 W3 W2 W3 W2 W3 W2 W3 () W3 () W3 () W3 C2 W3 C2 W3
  4   .  .  . W3  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  5   .  .  . W3  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  6   .  .  . W3  .  . e2  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  7   . e1  . W3  .  .  .  .  .  .  .  .  .  . W3 W2 W3 W2 W3  .  .  .
  8   .  .  . W3  .  .  .  .  .  .  .  .  .  .  .  .  .  . W3  .  .  .
  9   .  .  . W3 W2 W3 W2 W3  .  .  .  .  .  .  .  .  .  . W3  .  .  .
 10   .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e6  .  . W3  . e4  .
 11   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . W3  .  .  .
 12   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . W3  .  .  .
 13  W3 C2 W3 C2 W3 () W3 () W3 () W3 W2 W3 W2 W3 W2 W3 W2 W3  .  .  .
 14   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 15   . P1  .  .  .  .  .  .  .  .  .  . e7  .  .  .  .  .  .  .  .  .
 16   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (1, 15), P2 (20, 1), enemy slots e0(10, 8), e1(15, 10), e2(6, 6), e3(1, 11), e4(20, 10), e5(1, 3), e6(12, 15), e7(7, 1).  Header balloon codes 1P=0, 2P=(3,2).

#### Stage file 14 (used by mission(s): 17)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  .  . W4  .  .  .  .  .  .  .  .  .  .  .  .  .
  1   .  .  .  .  .  .  .  . W4  .  . e3  .  .  .  .  .  .  .  .  .  .
  2   .  .  . e1  .  .  .  . W4  .  .  .  .  .  .  .  .  .  .  .  .  .
  3   .  .  .  .  .  .  .  . W4  .  .  .  . W4  .  .  .  .  .  . e0  .
  4   .  .  .  .  .  .  .  . W4  .  .  .  . W4  .  .  .  .  .  .  .  .
  5   .  .  .  .  .  .  .  . C4  .  .  .  . C4  .  .  .  .  .  .  .  .
  6   .  .  .  . W1 W1 W2 C3 C4  .  .  .  . C4 C3 W2 W1 W1 W1 W1 W1 W1
  7   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  8   . e5  .  .  .  .  .  .  .  . e4  .  .  .  .  .  .  .  .  .  .  .
  9   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e6  .
 10  W1 W1 W1 W1 W1 W1 W2 C3 C4  .  .  .  . C4 C3 W2 W1 W1  .  .  .  .
 11   .  .  .  .  .  .  .  . C4  .  .  .  . C4  .  .  .  .  .  .  .  .
 12   .  .  .  .  .  .  .  . W4  .  .  .  . W4  .  .  .  .  .  .  .  .
 13   . P1  .  .  .  .  .  . W4  .  .  .  . W4  .  .  .  .  .  .  .  .
 14   .  .  .  .  .  .  .  .  .  .  .  .  . W4  .  .  .  .  . e2  .  .
 15   .  .  .  .  .  .  .  .  .  . e7  .  . W4  .  .  .  .  .  .  .  .
 16   .  .  .  .  .  .  .  .  .  .  .  .  . W4  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (1, 14), P2 (20, 2), enemy slots e0(10, 8), e1(3, 2), e2(19, 14), e3(11, 1), e4(10, 15), e5(1, 8), e6(20, 9), e7(11, 9).  Header balloon codes 1P=0, 2P=(0,1).

#### Stage file 15 (used by mission(s): 18)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  .  .  .  . W1  .  .  .  .  .  .  .  .  .  .  .
  1   .  .  .  .  .  .  .  .  .  . W1  .  .  .  .  .  .  .  .  .  .  .
  2   .  .  .  . e1  .  .  .  .  . W1 W1  .  . e3  .  .  .  .  .  .  .
  3   .  .  .  .  .  .  .  .  .  .  . W1  .  .  .  .  .  .  . e0  .  .
  4   .  .  .  .  .  .  . e5  .  .  . W1  .  .  .  .  .  .  .  .  .  .
  5   .  .  .  .  .  .  .  .  .  .  . W1  .  .  .  .  .  .  .  .  .  .
  6   .  .  .  . W2 W3 W2 W3 W2 C3 C2 C3 C2 W3 W2 W3 W2 W3  .  .  .  .
  7   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  8   .  .  .  .  .  .  .  .  .  .  . e6  .  .  .  .  .  .  .  .  .  .
  9   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 10   .  .  .  . W3 W2 W3 W2 W3 C2 C3 C2 C3 W2 W3 W2 W3 W2  .  .  .  .
 11   .  .  .  .  .  .  .  .  .  . W1  .  .  .  .  .  .  .  .  .  .  .
 12   .  .  .  .  .  .  .  .  .  . W1  .  .  .  .  .  .  .  .  .  .  .
 13   .  . P1  .  .  .  .  .  .  . W1  .  .  .  .  .  .  .  .  .  .  .
 14   .  .  .  .  .  .  .  .  .  . W1 W1  .  .  .  .  .  .  . e2  .  .
 15   .  .  .  .  .  .  .  . e7  .  . W1  .  . e4  .  .  .  .  .  .  .
 16   .  .  .  .  .  .  .  .  .  .  . W1  .  .  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (2, 13), P2 (19, 3), enemy slots e0(10, 7), e1(4, 2), e2(19, 14), e3(13, 1), e4(8, 15), e5(7, 4), e6(14, 15), e7(11, 8).  Header balloon codes 1P=0, 2P=(0,1).

#### Stage file 16 (used by mission(s): 25)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  1   .  .  .  .  .  .  .  . e4  .  .  .  .  .  .  .  .  .  .  .  .  .
  2   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e1  .  .
  3   .  .  .  .  . W2 W2 C1 W2 C1 W2 C1 W2 C1 W2 C1 W2  .  .  .  .  .
  4   .  .  .  .  . W2  .  .  .  .  .  .  .  .  .  . W2  .  .  .  .  .
  5   .  .  .  .  . W2  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  6   .  .  .  .  . W2  .  .  .  .  .  .  .  . e5  .  .  .  .  .  .  .
  7   .  .  .  .  . W2  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  8   .  . P1  .  . W2  .  . e0  .  .  .  .  .  .  .  .  .  . e6  .  .
  9   .  .  .  .  . W2  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 10   .  .  .  .  . W2  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 11   .  .  .  .  . W2  .  .  .  .  . e3  .  .  .  .  .  .  .  .  .  .
 12   .  .  .  .  . W2  .  .  .  .  .  .  .  .  .  . W2  .  .  .  .  .
 13   .  .  .  .  . W2 W2 C1 W2 C1 W2 C1 W2 C1 W2 C1 W2  .  .  .  .  .
 14   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 15   .  .  .  .  .  . e7  .  .  .  .  .  .  .  .  .  .  . e2  .  .  .
 16   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (1, 4), P2 (1, 12), enemy slots e0(8, 8), e1(19, 2), e2(18, 15), e3(11, 11), e4(9, 1), e5(14, 6), e6(19, 8), e7(7, 15).  Header balloon codes 1P=0, 2P=(0,0).

#### Stage file 17 (used by mission(s): 35)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  1   .  .  . e4  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  2   .  .  .  .  .  .  .  .  .  .  . e1  .  .  .  .  .  .  .  .  .  .
  3   .  .  .  . W1  .  .  .  .  .  .  .  .  .  .  .  . W1  .  . e6  .
  4   .  .  .  . W1  .  .  .  .  .  .  .  .  .  .  .  . W1  .  .  .  .
  5   .  .  .  . W1 W1 W1 W1 W1 W1 () () () W1 W1 W1 W1 W1  .  .  .  .
  6   .  .  .  . W1  .  .  .  .  .  .  .  .  .  .  .  . W1  .  .  .  .
  7   .  .  .  . ()  .  .  .  .  .  .  .  .  .  .  .  . ()  .  .  .  .
  8   .  .  .  . ()  .  .  . e3  .  .  . e0  .  .  .  . ()  .  .  .  .
  9   .  .  .  . ()  .  .  .  .  .  .  .  .  .  .  .  . ()  .  .  .  .
 10   .  .  .  . W1  .  .  .  .  .  .  .  .  .  .  .  . W1  .  .  .  .
 11   .  .  .  . W1 W1 W1 W1 W1 () () () W1 W1 W1 W1 W1 W1  .  .  .  .
 12   .  .  .  . W1  .  .  .  .  .  .  .  .  .  .  .  . W1  . e5  .  .
 13   . P1  .  . W1  .  .  .  .  .  .  .  . e2  .  .  . W1  .  .  .  .
 14   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 15   .  .  .  .  .  .  . e7  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 16   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (1, 13), P2 (20, 3), enemy slots e0(12, 8), e1(9, 1), e2(13, 13), e3(8, 8), e4(3, 1), e5(19, 12), e6(14, 2), e7(7, 15).  Header balloon codes 1P=0, 2P=(0,1).

#### Stage file 18 (used by mission(s): 45)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  1   .  . e1  .  .  .  .  .  .  .  . e0  .  .  .  .  .  .  . e2  .  .
  2   .  .  .  .  .  .  . e3  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  3   .  . () ()  .  . () ()  .  . () ()  .  . () ()  .  . () ()  .  .
  4   .  . () ()  .  . () ()  .  . () ()  .  . () ()  .  . () ()  .  .
  5   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  6   .  .  .  .  .  .  .  . e6  .  .  .  .  .  .  .  . e5  .  .  .  .
  7   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  8   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  9   .  .  .  . e4  .  .  .  .  .  .  .  . e7  .  .  .  .  .  .  .  .
 10   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 11   .  . W2 W2  .  . W2 W2  .  . W2 W2  .  . W2 W2  .  . W2 W2  .  .
 12   .  . W2 W2  .  . W2 W2  .  . W2 W2  .  . W2 W2  .  . W2 W2  .  .
 13   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 14   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 15   .  .  .  .  .  .  .  .  .  . P1  .  .  .  .  .  .  .  .  .  .  .
 16   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (6, 15), P2 (15, 15), enemy slots e0(11, 1), e1(2, 1), e2(19, 1), e3(7, 2), e4(4, 9), e5(17, 6), e6(8, 6), e7(13, 9).  Header balloon codes 1P=0, 2P=(0,0).

#### Stage file 19 (used by mission(s): 55)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  .  .  .  .  .  .  .  .  . () () ()  .  .  .  .
  1   .  .  .  .  .  .  .  . e5  .  .  .  .  .  . () () ()  .  .  .  .
  2   .  .  .  .  .  .  .  .  .  .  .  .  .  .  . () () ()  .  .  .  .
  3   .  . e0  .  .  .  .  .  .  .  . C2  .  .  .  .  .  .  .  . e1  .
  4   .  .  .  .  .  .  .  .  .  .  . C2  .  .  .  .  .  .  .  .  .  .
  5   .  .  .  .  .  .  . e3  .  .  .  .  .  .  . () () ()  .  .  .  .
  6   .  .  .  .  .  .  .  .  .  .  .  .  .  .  . () () ()  .  .  .  .
  7   .  .  .  .  .  .  .  .  .  .  .  .  .  .  . () () ()  .  .  .  .
  8  W2 W2 W1 W1 W2 W2 W1 W1 W2 W2 W1 W1 W2 W2 W1 W1 W2 W2  .  .  .  .
  9   .  .  .  .  .  .  .  .  .  .  .  .  .  .  . () () ()  .  . e6  .
 10   .  .  .  .  .  .  .  .  .  .  .  . e7  .  . () () ()  .  .  .  .
 11   .  .  .  .  .  .  .  .  .  .  .  .  .  .  . () () ()  .  .  .  .
 12   .  .  .  .  .  .  .  .  .  .  . C2  .  .  .  .  . e4  .  .  .  .
 13   .  . P1  .  .  .  .  .  .  .  . C2  .  .  .  .  .  .  .  .  .  .
 14   .  .  .  .  .  .  .  .  .  .  .  .  .  .  . () () ()  . e2  .  .
 15   .  .  .  .  .  .  .  .  .  .  .  .  .  .  . () () ()  .  .  .  .
 16   .  .  .  .  .  .  .  .  .  .  .  .  .  .  . () () ()  .  .  .  .
```
2P file (same blocks): P1 (2, 10), P2 (2, 15), enemy slots e0(2, 3), e1(20, 3), e2(19, 14), e3(7, 5), e4(17, 12), e5(8, 1), e6(20, 9), e7(13, 12).  Header balloon codes 1P=0, 2P=(3,3).

#### Stage file 20 (used by mission(s): 65)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  .  .  .  .  .  . ()  .  .  .  .  .  .  .  .  .
  1   .  .  .  .  .  .  .  . e1  .  .  . ()  .  .  .  .  .  .  .  .  .
  2   .  .  .  .  .  .  .  .  .  .  .  . ()  .  . e3  .  .  .  .  .  .
  3   .  .  . e5  .  .  .  .  .  .  .  . W2  .  .  .  .  . e0  .  .  .
  4   .  .  .  .  .  .  .  .  .  .  .  . W2  .  .  .  .  .  .  .  .  .
  5   .  .  .  .  .  .  .  .  .  .  .  . W2  .  .  .  .  .  .  .  .  .
  6   .  .  .  .  .  .  .  .  .  .  .  . W2  .  .  .  .  .  .  .  .  .
  7   .  .  .  .  . e6  .  .  .  .  .  . W2 C1 W2 C1 W2 C1 W2 () () ()
  8   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  9  () () () W2 C1 W2 C1 W2 C1 W2  .  .  .  .  .  .  .  .  .  .  .  .
 10   .  .  .  .  .  .  .  .  . W2  .  .  .  .  .  .  .  .  .  .  .  .
 11   .  .  .  .  .  .  .  .  . W2  .  .  .  .  .  .  .  . e2  .  .  .
 12   .  .  .  .  .  .  .  .  . W2  .  .  .  .  .  .  .  .  .  .  .  .
 13   .  .  . P1  .  .  .  .  . W2  .  .  .  .  .  .  .  .  .  .  .  .
 14   .  .  .  .  .  .  .  .  . ()  .  .  .  .  .  .  .  .  .  .  .  .
 15   .  .  .  .  .  .  .  .  . () e7  .  .  .  . e4  .  .  .  .  .  .
 16   .  .  .  .  .  .  .  .  . ()  .  .  .  .  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (1, 11), P2 (7, 14), enemy slots e0(18, 3), e1(8, 1), e2(20, 11), e3(15, 2), e4(17, 15), e5(3, 3), e6(5, 7), e7(12, 15).  Header balloon codes 1P=0, 2P=(0,0).

#### Stage file 21 (used by mission(s): 30)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  1   .  . e1  .  .  .  .  .  . e6  .  .  .  .  .  .  .  .  .  .  .  .
  2   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e0  .
  3   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  4   .  .  .  .  . e5  . W2 W2  .  .  .  . W2 W2  .  . e3  .  .  .  .
  5   .  .  .  .  .  .  .  . W2  .  .  .  . W2  .  .  .  .  .  .  .  .
  6  C1 C1  .  .  .  .  .  . W2  .  .  .  . W2  .  .  . C1 C1  .  .  .
  7  () () () () () () () () W2  .  .  .  . W2 () () () () () () () ()
  8  () () () () () () () () W2  .  . e4  . W2 () () () () () () () ()
  9  () () () () () () () () W2  .  .  .  . W2 () () () () () () () ()
 10   .  .  . C1 C1  .  .  . W2  .  .  .  . W2  .  .  .  .  .  . C1 C1
 11   .  .  .  .  .  .  .  . W2  .  .  .  . W2  .  .  .  .  .  .  .  .
 12   .  .  .  .  .  .  . W2 W2  .  .  .  . W2 W2  .  .  .  .  .  .  .
 13   . P1  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 14   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e2  .  .
 15   .  .  .  .  .  .  .  .  .  . e7  .  .  .  .  .  .  .  .  .  .  .
 16   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (1, 13), P2 (19, 14), enemy slots e0(20, 2), e1(2, 1), e2(12, 2), e3(17, 4), e4(11, 8), e5(4, 4), e6(9, 1), e7(10, 15).  Header balloon codes 1P=0, 2P=(0,0).

#### Stage file 22 (used by mission(s): 40)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  1   .  .  .  .  .  .  .  .  .  .  . e7  .  .  .  .  .  .  .  . e1  .
  2   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  3   .  .  . W3 W3 W3 W3 W3 W3 W3  .  . W3 W3 W3 W3 W3 W3 W3  .  .  .
  4   . e5  . W3  .  .  .  .  .  .  .  .  .  .  .  .  .  . W3  .  .  .
  5   .  .  . W3  .  .  .  .  .  .  .  .  .  .  .  .  .  . W3  .  .  .
  6   .  .  . C3  .  .  .  .  .  .  .  .  .  .  .  .  .  . C3  .  .  .
  7   .  .  . C3  .  .  .  .  .  .  .  .  .  .  .  .  .  . C3  .  .  .
  8   .  .  . C3  . P1  .  .  . C1 C1 C1 C1  .  .  . e0  . C3  .  .  .
  9   .  .  . C3  .  .  .  .  .  .  .  .  .  .  .  .  .  . C3  . e3  .
 10   .  .  . C3  .  .  .  .  .  .  .  .  .  .  .  .  .  . C3  .  .  .
 11   .  .  . W3  .  .  .  .  .  .  .  .  .  .  .  .  .  . W3  .  .  .
 12   . e6  . W3  .  .  .  .  .  .  .  .  .  .  .  .  .  . W3  .  .  .
 13   .  .  . W3 W3 W3 W3 W3 W3 W3  .  . W3 W3 W3 W3 W3 W3 W3  .  .  .
 14   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 15   .  .  .  .  .  .  .  . e4  .  .  .  .  .  .  .  .  .  . e2  .  .
 16   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (5, 8), P2 (16, 8), enemy slots e0(1, 8), e1(20, 1), e2(19, 15), e3(20, 9), e4(8, 15), e5(0, 3), e6(1, 14), e7(11, 1).  Header balloon codes 1P=0, 2P=(0,0).

#### Stage file 23 (used by mission(s): 60)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  1   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e0  .
  2   . e1  .  .  .  .  .  .  .  .  .  .  .  .  . e3  .  .  .  .  .  .
  3   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  4   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  5   .  .  . W6 W6 W6 W6 () W6 W6 W6 W6 () W6 W6 W6 W6 W6 W6  .  .  .
  6   .  .  . W6  .  .  .  .  .  .  .  .  .  .  .  .  .  . W6  .  .  .
  7   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  8   .  .  .  .  . e7  .  .  .  .  .  .  .  .  .  .  . e5  .  .  .  .
  9   .  .  .  .  .  .  .  .  .  .  . e6  .  .  .  .  .  .  .  .  .  .
 10   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 11   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 12   .  .  . W6  .  .  .  .  .  .  .  .  .  .  .  .  .  . W6  .  .  .
 13   .  .  . W6 W6 W6 W6 W6 W6 () W6 W6 W6 W6 () W6 W6 W6 W6  .  .  .
 14   .  .  .  .  .  .  .  .  . e4  .  .  .  .  .  .  .  .  .  .  .  .
 15   . P1  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e2  .  .
 16   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (1, 15), P2 (20, 15), enemy slots e0(9, 1), e1(1, 2), e2(20, 1), e3(15, 2), e4(9, 14), e5(11, 9), e6(17, 8), e7(5, 8).  Header balloon codes 1P=0, 2P=(0,0).

#### Stage file 24 (used by mission(s): 70)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  1   .  . ()  .  .  .  .  . e4  .  .  .  .  .  . e1  .  .  . ()  .  .
  2   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  3   . e7  .  .  . W1 W1 W1 W1 W1 W1 W1 W1 W1 W1 W1 W1  .  .  .  .  .
  4   .  .  .  .  . W1  .  .  .  .  .  .  .  .  .  . W1  .  .  .  .  .
  5   .  .  .  .  . W1  .  .  .  .  . e3  .  .  .  . W1  .  . e6  .  .
  6   .  .  .  .  . W1  .  .  .  .  .  .  .  .  .  . W1  .  .  .  .  .
  7   .  .  .  .  . W1  .  .  .  . W3 W4  .  .  .  . W1  .  .  .  .  .
  8   .  .  .  .  . W1  .  .  .  . W2 W3  .  .  .  . W1  .  .  .  .  .
  9   .  .  .  .  . W1  .  .  .  . W1 W2  .  .  .  . W1  .  .  .  .  .
 10   .  .  .  .  . W1  . e5  .  . W1  .  .  .  .  . W1  .  .  .  .  .
 11   .  .  .  .  . W1  .  .  .  . W1  .  . e0  .  . W1  .  .  .  .  .
 12   .  .  .  .  . W1  .  .  .  . W1  .  .  .  .  . W1  .  .  .  .  .
 13   .  .  .  .  . W1  .  .  .  . W1 W1 W1 W1 W1 W1 W1  .  .  .  .  .
 14   .  . P1  .  . W1  .  .  .  .  .  .  .  .  .  .  .  .  . e2  .  .
 15   .  . ()  .  . W1  .  .  .  .  .  .  .  .  .  .  .  .  . ()  .  .
 16   .  .  .  .  . W1  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (1, 14), P2 (4, 13), enemy slots e0(13, 11), e1(15, 1), e2(19, 14), e3(11, 5), e4(8, 1), e5(7, 10), e6(19, 5), e7(1, 3).  Header balloon codes 1P=0, 2P=(0,0).

#### Stage file 25 (used by mission(s): 80)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  .  .  .  . C1 C1  .  .  .  .  .  .  .  .  .  .
  1   .  .  .  .  .  .  .  .  .  . C1 C1  .  .  .  .  .  .  .  .  .  .
  2   .  .  .  . e2  .  .  .  .  . C1 C1  .  .  .  .  .  .  .  .  .  .
  3   .  .  .  .  .  .  .  .  .  . () ()  .  .  .  .  .  .  . e0  .  .
  4   .  .  .  .  .  .  .  .  . e5 () ()  .  .  .  .  .  .  .  .  .  .
  5   . e4  .  .  .  .  .  .  .  . () ()  .  . e3  .  .  .  .  .  .  .
  6   .  .  .  .  .  .  .  .  .  . () ()  .  .  .  .  .  .  .  .  .  .
  7   .  .  . C7  .  .  .  .  .  . () ()  .  .  .  .  .  . C7  .  .  .
  8   .  . C7 C7 C6 C5 C4 C3 C2 C1 () () C1 C2 C3 C4 C5 C6 C7 C7  .  .
  9   .  .  . C7  .  .  .  .  .  . () ()  .  .  .  .  .  . C7  .  .  .
 10   .  .  .  .  .  .  .  .  .  . () ()  .  .  .  .  .  .  .  .  .  .
 11   .  .  .  .  .  .  .  .  .  . () ()  .  .  .  .  .  .  .  .  .  .
 12   .  .  .  .  .  .  .  .  .  . () ()  .  . e6  .  .  .  .  .  .  .
 13   .  . P1  .  .  .  .  .  .  . () ()  .  .  .  .  .  .  .  .  .  .
 14   .  .  .  .  .  .  .  .  .  . C1 C1  .  .  .  .  .  .  . e1  .  .
 15   .  .  .  .  .  .  .  .  . e7 C1 C1  .  .  .  .  .  .  .  .  .  .
 16   .  .  .  .  .  .  .  .  .  . C1 C1  .  .  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (2, 13), P2 (19, 3), enemy slots e0(16, 14), e1(6, 1), e2(2, 3), e3(13, 11), e4(19, 15), e5(8, 5), e6(12, 1), e7(9, 15).  Header balloon codes 1P=0, 2P=(0,1).

#### Stage file 26 (used by mission(s): 5, 50)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  1   .  .  .  . e6  .  .  .  .  .  .  .  .  . e2  .  .  .  .  .  .  .
  2   .  .  .  .  .  .  .  .  . e4  .  .  .  .  .  .  .  .  .  .  .  .
  3   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  4   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . C6  . e0  .
  5   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . W6 C6  .  .
  6   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  7   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  8   .  .  .  .  . e7  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  9   .  .  .  .  .  .  .  .  .  .  .  . e3  .  .  .  .  .  .  . e1  .
 10   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 11   .  . C6 W6  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 12   .  .  . C6  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 13   .  . P1  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 14   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 15   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e5  .
 16   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (1, 12), P2 (20, 4), enemy slots e0(10, 8), e1(16, 14), e2(5, 2), e3(12, 9), e4(7, 14), e5(13, 1), e6(0, 4), e7(20, 10).  Header balloon codes 1P=0, 2P=(0,0).

#### Stage file 27 (used by mission(s): 4, 90)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  . ()  .  .  .  .  .  . ()  .  .  .  .  .  .  .
  1   .  .  .  .  .  .  . ()  .  .  .  .  .  . ()  .  .  .  .  .  .  .
  2   .  .  . e1  .  .  . ()  .  .  . e5  .  . ()  .  .  . e0  .  .  .
  3   .  .  .  .  .  .  . ()  .  .  .  .  .  . ()  .  .  .  .  .  .  .
  4   .  .  .  .  .  .  . ()  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  5  () () () () () ()  . ()  . () () () () () () () () () () () () ()
  6   .  .  .  .  .  .  . ()  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  7   .  .  .  .  .  .  . ()  .  .  .  .  .  . ()  .  .  .  .  .  .  .
  8   .  .  . e6  .  .  . ()  .  . e4  .  .  . ()  .  .  . e3  .  .  .
  9   .  .  .  .  .  .  . ()  .  .  .  .  .  . ()  .  .  .  .  .  .  .
 10   .  .  .  .  .  .  .  .  .  .  .  .  .  . ()  .  .  .  .  .  .  .
 11  () () () () () () () () () () () () ()  . ()  . () () () () () ()
 12   .  .  .  .  .  .  .  .  .  .  .  .  .  . ()  .  .  .  .  .  .  .
 13   .  .  .  .  .  .  . ()  .  .  .  .  .  . ()  .  .  .  .  .  .  .
 14   .  .  . P1  .  .  . ()  .  .  . e7  .  . ()  .  .  . e2  .  .  .
 15   .  .  .  .  .  .  . ()  .  .  .  .  .  . ()  .  .  .  .  .  .  .
 16   .  .  .  .  .  .  . ()  .  .  .  .  .  . ()  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (2, 14), P2 (19, 2), enemy slots e0(11, 8), e1(3, 2), e2(18, 14), e3(18, 8), e4(3, 8), e5(11, 14), e6(11, 2), e7(10, 9).  Header balloon codes 1P=0, 2P=(0,1).

#### Stage file 28 (used by mission(s): 20)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  1   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e5  .  .
  2   .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e1  .  .  .  .  .  .
  3   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  4   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  5   .  .  .  .  .  .  .  .  .  .  .  . e6  .  .  .  .  .  .  .  .  .
  6   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e3  .  .  .  .
  7   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  8   .  . P1  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e0  .  .
  9   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 10   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 11   .  .  .  .  .  .  .  .  .  .  .  .  .  . e4  .  .  .  .  .  .  .
 12   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 13   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 14   .  .  .  .  .  .  .  .  .  . e7  .  .  .  .  .  .  .  .  .  .  .
 15   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  . e2  .  .  .
 16   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (2, 14), P2 (19, 2), enemy slots e0(10, 8), e1(19, 14), e2(2, 2), e3(8, 7), e4(4, 6), e5(16, 8), e6(10, 4), e7(11, 11).  Header balloon codes 1P=0, 2P=(0,1).

#### Stage file 29 (used by mission(s): 1, 100)

```
      0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21
  0   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
  1   .  .  .  .  .  .  .  .  .  .  .  .  .  . e5  .  .  .  .  .  .  .
  2   .  .  .  .  .  .  .  .  . e4  .  .  .  .  .  .  .  . e1  .  .  .
  3   .  .  .  .  . W1  .  .  .  .  . W1  .  .  .  .  .  .  .  .  .  .
  4   .  .  .  .  . W1  .  .  .  .  . W1  .  .  .  .  .  .  .  .  .  .
  5   .  .  .  .  .  .  .  .  .  .  . C1  .  .  .  .  .  .  .  .  .  .
  6   .  . P1  .  .  .  .  .  .  .  . C1  .  .  .  .  .  .  . e0  .  .
  7   .  .  .  .  . W1  .  .  .  .  . W1  .  .  .  . e3  .  .  .  .  .
  8   .  .  .  .  . W1  .  .  .  .  . W1  .  .  .  .  .  .  .  .  .  .
  9   .  .  .  .  .  .  .  . e7  .  .  .  .  .  .  .  .  .  .  .  .  .
 10   .  .  .  .  .  .  .  .  .  .  .  .  . e6  .  .  . e2  .  .  .  .
 11   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 12  W1 W1 W1 W1 W1 W1 W1 W1 W1 W1 W1 W1 W1 W1 W1 W1 W1 W1 W1 W1 W1 W1
 13   .  .  .  .  .  .  .  . W1  .  .  .  . W1  .  .  .  .  .  .  .  .
 14   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 15   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
 16   .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
```
2P file (same blocks): P1 (2, 7), P2 (2, 4), enemy slots e0(19, 6), e1(18, 2), e2(17, 10), e3(16, 7), e4(9, 2), e5(14, 1), e6(13, 10), e7(8, 9).  Header balloon codes 1P=0, 2P=(1,0).

---

## 6. Presentation

### 6.1 Look of the arena
- The diorama is toy-like: wooden/plastic toy tanks on a light floor, inside an outer border model (`tnk_field_16_9` + `tnk_field_16_9_out`) [DISC H].
- Solid blocks look like wood; cork blocks have a cork texture. Both use the same block meshes `tnk_block_7`/`tnk_block_8`, with a texture-pattern frame switch (kind 0 = frame 1 cork, kind 1 = frame 0 wood) [DECOMP H]. Blocks cast a `tnk_block_shadow`.
- [TR]'s campaign colours: mission strip `rgb(186,62,47)`, background `rgb(229,227,171)` (TR's choice, L for the original).
- **Tread marks:** tanks stamp tread textures into a floor capture texture (`tnk_mark_1p`, `tnk_mark_2p`, `tnk_mark_e_1..9`, one per type) [DISC/DECOMP H].
  - The fade rate is 0, so tracks **persist** for the whole attempt.
  - They are **cleared when a mission starts or restarts** (`RPTnkStepTimer::Start(0)` sets the clear flag) [DECOMP H].
- **X marks:** a destroyed tank leaves an "X" model (`tnk_check.brres`) in one of 3 colours: P1, P2, enemy [DECOMP H]. At most 16. **Cleared on mission (re)start** (`DeactivateAll` → `KillAll`) [DECOMP H].
- Effects (`basic_tank.breff`) [DECOMP H]:
  - `Tnk_shellsmoke01/02/03`: shell smoke trails. 01 = normal shells; 02 = Marine and Black rockets; 03 = Green's rockets.
  - `Tnk_shell_crash`: ricochet spark.
  - `Tnk_shell_bomb`: shell destroyed.
  - `Tnk_mine_bomb`: mine explosion, scale 1.6.
  - `Tnk_blockbreak01`: block destroyed.
  - `Tnk_stealth_change`: White vanishing.
  - `Tnk_all_clear`: final completion.
- The mine model `tnk_mine` has a colour animation that runs only once the fuse is lit (it blinks) [DECOMP H].

### 6.2 Camera
- Gameplay camera [DECOMP `RPTnkCamera::SetMode(1)` + `RPTnkScene` H]:
  - **orthographic** projection;
  - looks at (0, 0, −14) from distance 2000, **42° above the floor plane**, from the near (+z) side;
  - the up vector is tilted with it, so it is a fixed, tilted, top-down view that shows block fronts;
  - world scale 0.742857, so one 35-unit cell = 26 screen units;
  - 3D viewport 624 × 494 (16:9) or 468 × 494 (4:3), field screen scale 1.125.
- An intro fly-in mode also exists [DECOMP H; where it is used: L]: a 5-point curve from (0, 5, 120) near the floor up to (0, 2000, 0), 1/150 of the path per frame, slowing to 0.94× per frame after 90%.

### 6.3 Mission intro sequence [DECOMP `RPTnkFade`, `RPTnkGameManager` H; strings DISC]
1. Fade-in card (`tnkfade`): the player's Mii icon with a tank icon and **"× N"** lives (both players' icons in 2P).
2. If the previous mission gave a bonus: the card runs 150 frames and the life is added 30 frames in. Banner **"Bonus Tank!"** plus the 1-UP sound.
3. Mission banner: **"Mission N"** (or **"Final Mission"**) and **"Enemy tanks: N"**, held **140 frames**. The jingle `RP_TNK_BGM_PANPAKAPAN` plays.
4. The fade clears. After **165 frames** (`StateStageStart` timer) the tanks are activated (they can move and fire), **"Start!"** shows (`tnkMsg_01`), and the HUD slides in. On Mission 1 the control hints start.
5. Before activation, balloons mark the players' start positions (P1/P2, oriented by the map header) [DECOMP M].

### 6.4 HUD (`tnkUI_00`) [DISC layout panes + DECOMP M]
- A mission badge with the mission number, and an enemy counter **"× N"** (tanks remaining) with a badge icon.
- In 2P, a score box per player ("P1"/"P2" with kill counts), which pulses when that player scores.
- HUD strings: "Mission:", "Tanks left:" [DISC bmg #260/261].

### 6.5 Messages (exact US strings) [DISC bmg H]
"Mission N" · "Final Mission" · "Enemy tanks: N" · "Enemy forces:" · "Start!" · "Hit!" · "Mission cleared!" · "Destroyed" · "Mission failed!" · "Mission complete!" · "Bonus Tank!" · "Restock tanks" · "Results" · "Total:" · "Completed all stages!" · "P1"/"P2".

### 6.6 Clear and results screens
- **Mission cleared** (`tnkMsg_02`): "Mission cleared!" plus a "Destroyed" total (per player in 2P) [DISC/DECOMP M].
- **Results** (`tnkResult_00`):
  - one row per enemy type (9 rows, each with a tank icon and count). Rows appear one at a time, each with its own sound `RP_TNK_SE_RESULT_TNK_LINE09…01`;
  - then the total (`RP_TNK_SE_RESULT_TNK_TOTAL`);
  - 2P has two columns and a winner animation (`win1P`/`win2P`).
  - The game records the order in which each type was first destroyed (`AddKilledType`). That suggests the rows list the types you actually met, in kill order [DECOMP M; exact row order L].
- Then the medal screen (1P: Bronze/Silver/Gold/Platinum by kills, with fanfares) or the 2P winner screen, then Try again / Quit.

---

## 7. Music and sound

### 7.1 Layered stage music [DECOMP `RPTnkBgmMix` H; instruments NF]
- One looping sequence (`RP_TNK_BGM_LOOP2`) with 11 tracks; tracks are muted or unmuted live.
- Each frame the game takes:
  - **E** = number of enemies alive, clamped to 1..4;
  - **T** = the highest enemy type ID alive (1 Brown … 9 Black; this is the "rank").
- It applies mask `sTrackMasks[T−1][E−1]`; the mask is updated whenever E or T changes.
- Note: [NF] describes the count column as "tanks of the same or lower rank". In the code it is simply all enemies alive, which always includes the top-ranked tank, so in practice the two are the same.

Track bit → instrument. The mapping was derived by matching the code masks to [NF]'s instrument table; all 27 combinations match exactly (H):

| Bit | Instrument |
|---|---|
| 0, 10 | Two piccolos (melody), always on |
| 1 | Timpani A |
| 2 | Tubular bells |
| 3 | Timpani B |
| 4 | Snare drum |
| 5 | Bass drum |
| 6 | Cymbals |
| 7 | Metronome |
| 8 | Tuba |
| 9 | Synthesizer |

Masks (hex) and the extra instruments on top of the piccolos:

| Highest type alive | 1 enemy | 2 enemies | 3 enemies | 4+ enemies |
|---|---|---|---|---|
| 1 Brown | 411: snare | 411 | 411 | 411 |
| 2 Ash | 491: snare, metronome | 491 | 493: + timpani A | 493 |
| 3 Marine | 4C3: timpA, cymbals, metronome | 4D3: + snare | 4D3 | 4D9: snare, metronome, cymbals, timpB |
| 4 Pink | 419: snare, timpB | 459: + cymbals | 4D9: + metronome | 4D9 |
| 5 Yellow | 4E3: timpA, bass, cymbals, metronome | 4F3: + snare | 4F9: snare, timpB, bass, cymbals, metronome | 4F9 |
| 6 Violet | 543: timpA, cymbals, tuba | 573: + snare, bass | 5F9: timpB, snare, bass, cymbals, metronome, tuba | 5F9 |
| 7 Green | 547: timpA, bells, cymbals, tuba | 567: + bass | 5F7: timpA, bells, snare, bass, cymbals, metronome, tuba | 5FD: timpB, bells, snare, bass, cymbals, metronome, tuba |
| 8 White | 713: timpA, snare, tuba, synth | 7B9: timpB, snare, bass, metronome, tuba, synth | 7F9: + cymbals | 7F9 |
| 9 Black | 7ED: bells, timpB, bass, cymbals, metronome, tuba, synth (no snare) | 7ED | 7ED | 7ED |

[NF]'s reading of the design: each tank "owns" an instrument:

| Instrument | Owner |
|---|---|
| Snare | Brown |
| Metronome | Ash |
| Cymbals | Marine |
| Timpani B | Pink |
| Bass drum | Yellow |
| Tuba | Violet |
| Tubular bells | Green |
| Synth | White |
| Bells + synth | Black |

Other music cues [DECOMP H; instruments NF M]:

| Event | Sound ID | Instruments |
|---|---|---|
| Mission announcement jingle | `PANPAKAPAN` | two trumpets |
| Mission intro | — | snare drum |
| Stage clear | `FILL2` | two piccolos |
| Life lost | `MISS` | piccolos + tubular bell |
| Game over → results | `RESULT2` | piccolos, tuba, snare, metronome |
| Mission 20 complete | `COMP20` | piccolos, tuba, cymbals, bass drum, snare |
| Mission 100 complete | `COMP100` | piccolos, tuba, cymbals, bass drum, snare |
| Medals | common `GET_COPPER/SILVER/GOLD/PLATINA`, `RENEW_RECORD` | — |

### 7.2 Sound effects (IDs from `rp_Tnk_sound.brsar`) [DECOMP `rp_Tnk_sound.h` H]

**Shooting**
- `SHOOT_1P`, `SHOOT_2P`.
- One per enemy type: `SHOOT_ENEMY1..9`. ENEMY3, ENEMY7 and ENEMY9 are looping `_LV` versions, held while the Marine/Green/Black rocket flies. Generic `SHOOT`.

**Impacts**
- `HIT` (+ `_CSPK` Remote-speaker version): shell hits a tank.
- `REFLECT`: ricochet. `REFLECT_SUPER` is used for Green's shells.
- `BROKEN`: shell or block burst.
- `TNK_DISAPPEAR`: White fading out.

**Mines** (jirai = mine; `MAE` = "before", probably the warning before the blast, M)
- `JIRAI_SET` (+ `_CSPK`): mine laid.
- `JIRAI_TIMER`: fuse beeping, looped while the fuse is lit.
- `JIRAI_EXP`: explosion.
- `JIRAI_EXP_MAE`.

**Movement**
- `CATERPILLAR_1P/2P/SLOW/MID/SAME/FAST`, `CATERPILLAR`: treads; enemies by speed class.
- `ENGINE`, `IDLING`.

**Scoring**
- `GET_HIT` (1P kill), `GET_HIT_01/02` (P1/P2 kill in 2P), and `_CSPK` versions.
- `TNK1UP`: extra life.
- `MISSION_BONUS`, `GAMESTART`, `GET_TNKNUM`.

**Results**
- `RESULT_OPEN`, `RESULT_TNK_LINE01..09`, `RESULT_TNK_TOTAL`.

**Intro**
- `INTRO_CATERPILLAR_00..05`: tread sounds for the intro.

[TR]'s tread-pitch constants are "values from the source": high 1/4, med-high 1/12, med-low −1/6, low −1/3 [TR M].

---

## 8. Timing and constants

### 8.1 Mines [DECOMP `RPTnkMine` H]

**Laying and arming**
- Laid at the tank's position. Speed 0; there is a slide-to-target state, but no tank uses it.
- **Arming:** while the owner is still within 90 u, the mine ignores tanks. Once the owner has left that 90-u zone, it watches for any tank within 70 u.

**Fuse**
- **Timed fuse: 480 frames armed + 120 frames lit = 600 frames (10 s).** The last 2 s: beeping and flashing.
- **Proximity fuse:** a tank in range (after arming) lights a **20-frame** fuse.
- **Instant detonation:** hit by a shell (mine radius 12), or caught in another mine's blast (chain reaction).

**Blast**
- Radius grows 8 → **80 u** over 6 frames, then holds.
- Kills tanks within (blast radius + their radius) during the **first 20 frames**.
- The explosion object lasts 40 frames.
- 80 u ≈ 2.3 cells. [NF] calls it "moderate"; [TR] uses its own scale.
- Destroys cork blocks within blast + 17.5 u, and detonates other mines in its blast. The blast is not blocked by walls: it reaches through to the other side of solid blocks [NF; DECOMP distance test H].

**Collision**
- Mine collision radius vs walls: 17.1 u. Trigger-range helper: 80 u (`Tnk_getMineProximityRadius`).

### 8.2 Shells [DECOMP `RPTnkShell` H]
- Radius 6.
- Bounce rule: `bouncesLeft` starts at the ricochet count; each wall hit decrements it, and the shell dies when it falls below 0.
- Reflection is a mirror reflection (the velocity's normal component is reversed).
- Age gates: 4 frames (can hit its own tank), 6 frames (early wall hit kills the shell), 16 frames (passes its own tank's mines).

### 8.3 Flow timers [DECOMP `RPTnkGameManager`, `RPTnkFade` H]

| Event | Frames |
|---|---|
| Bonus life card | 150 (life added at 30) |
| Mission/enemy banner | 140 |
| Delay before tanks activate | 165 |
| Wait after death before fade | 120 |
| Camera intro curve | ≥ 150 |

### 8.4 Other limits
- Block pool 256, shell pool 32, mine pool 16, X-mark pool 16, hit popups 16 [DECOMP H].
- Random number generator (for porting behaviour exactly): `x = x·0x41C64E6D + 12345`; `y` is an LFSR (`if (y&1) y ^= 0x11020; y >>= 1`); output `x ^ y`. Seeded from the system tick at scene reset [DECOMP H].

---

## 9. Colours and assets

- Tank colours (wiki swatches, approximate; the true textures are in `tnk_tank.brres`, not decoded) [WS M]:

| Tank | Swatch |
|---|---|
| Brown | `#a17a3a` |
| Ash | `#767064` |
| Marine | `#407c71` |
| Yellow | `#d8c130` |
| Pink/Red | `#ca5f69` |
| Green | `#52874a` |
| Violet | `#815c80` |
| White | `#e7dbae` |
| Black | `#383630` |
| Player 1 | blue |
| Player 2 | red |

- [TR] destruction-particle colours: Brown (152, 96, 26), Ash grey, Marine teal, Yellow, Pink hot-pink, Green lime, Violet purple, White, Black (L for the original).
- On-disc asset names, useful when matching shapes: `tnk_tank_1p`, `tnk_tank_2p`, `tnk_tank_e_1..9`, `shell`, `tnk_mine`, `tnk_block_1/_7/_8`, `tnk_block_shadow`, `tnk_check`, `tnk_field_16_9(_out)`, `tnk_field_4_3` [DISC H].

---

## 10. Open questions

1. **Exact tank and block colours/textures.** The textures are on the disc (`tnk_tank.brres`, `tnk_block.brres`, `tnk_footmark/*.bti`) but were not decoded. Decoding them would replace the wiki swatches.
2. **Exact AI movement maths** (StateApproach/Evade weighting, probe steering). The parameters are exact; the formulas need a closer read of `RPTnkAi_2.cpp` / `RPTnkAi_3.cpp` in [DECOMP].
3. **Whether mine blasts destroy shells in flight.** [NF] says yes; the decomp's shell collision does not check explosions (M).
4. **Results screen row order and exact HUD positions.** Pane positions in the `.brlyt` files were not decoded.
5. **The 0x24/0xA4 "stun" field naming**: decomp AI labels vs player-controller usage (see §4.2). This spec follows the player-controller usage.
6. **When the camera intro fly-in plays**, if it is ever used.
7. **Sound audio and the BGM itself** would have to be extracted from `rp_Tnk_sound.brsar` to reproduce them; the per-track structure is documented above.
8. The 2P map files are fully dumped above. The 4:3 (`*_0.bin`) layouts were not rendered here; they are narrower versions of the same 30 maps.

## 11. Known errors in fan sources
- [WS]:
  - "Bullets can be used three times on screen": the player has **5**.
  - "maps … procedurally generated after 50 Missions": wrong. From Mission 21 on, maps are drawn from fixed pools and only tank types are random.
  - Red/Pink "move quickly": speed is **1.2**, the same as Ash.
  - White "move quickly": **1.2**.
  - Black "fire up to two bullets": **3** ([NF] has 3).
- [NF]:
  - Green "predictive aiming": no lead in the code; it is a bounce-path search.
  - "Mission 35 top-left brown": the fixed Brown applies to missions 34–39, in slot 4.
- [TR]: see §4.4.
