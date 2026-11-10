# Tanks! — game logic recovered from main.dol

Status: superseded by the matching decompilation (`build/decomp`, see §9). The DOL analysis below
was used to confirm that the decomp matches RHAE01 Rev 0.
Confidence tags: **[C]** confirmed from code, **[I]** inferred (naming/behaviour guess).

## 0. Tooling and conventions

- `tools/re/objdump.sh` — PowerPC objdump (binutils 2.40 from Debian's
  `binutils-powerpc-linux-gnu` .deb, unpacked with `dpkg -x` into `~/.local/opt/ppcbu`).
  Supports `-M broadway` (paired singles).
- `tools/re/disasm.sh [OUT]` — splits the DOL text sections, disassembles them and runs
  `annotate.py`, producing `OUT/annot.txt` (default `/tmp/tanks_re`): one line per
  instruction with resolved `lis/addi`, `r2`/`r13` (SDA2/SDA) references, strings and
  float constants; `funcs.txt` (function starts); `xrefs.pkl` (data xrefs + call graph).
- `tools/re/fn.py ADDR` — print the annotated function containing ADDR plus its callers.
- `tools/re/fmap.py LO HI` — one-line summary per function (size, callers, globals, strings, floats).
- `tools/re/paramrefs.py`, `tools/re/parammap.py FN K0OFF` — find TnkGameParam record copies and
  map record word k → destination struct offset.
- `tools/re/dol.py` — DOL loader.

DOL layout: T0 80004000, T1 800074c0-802cf160; data D0..D8; `.sdata` (r13) at 80477980,
`.sdata2` (r2) at 804798e0. **r2 = 0x804818e0, r13 = 0x8047f980** (set in `__start`, 8000630c).

Tanks code lives at roughly **8023c000-8025c000**; its strings at 802f6f48-802f84e0,
its float constants in `.sdata2` around 8047cf40-8047d340.

Frame-based: all timers are integer frame counts decremented once per update (60 Hz) [I].

### Global singletons (r13-relative pointers, created by the scene)

| r13 offset | address | create fn | role |
|---|---|---|---|
| -25264 | 804796d0 | 8023d944 | camera [I] |
| -25256 | 804796d8 | 8023e844 | field / map [I] |
| -25248 | 804796e0 | 8024415c | tank manager (list of tanks at +40..+44) [C] |
| -25240 | 804796e8 | 80244604 | cursor manager (Tnk_cursor_*) [C] |
| -25232 | 804796f0 | 802483a8 | block manager (list at +12..+16, count +8) [C] |
| -25224 | 804796f8 | 80248c10 | shell (bullet) manager [I] |
| -25216 | 80479700 | 8024a574 | per-tank live counters (+4 → shells array, +8 → mines array, index tank+164, entry at +24+(idx+2)*4) [C] |
| -25208 | 80479708 | 8024bc88 | game state + param: `+52` = TnkGameParam.bin data [C] |
| -25200 | 80479710 | 8024c954 | ? |
| -25192 | 80479718 | 8024d030 | mine manager [I] |
| -25168 | 80479730 | 802543ac | 2D layout / UI manager [I] |
| -25160 | 80479738 | 80254790 | score / kill tally [I] |

### RNG [C]

Global state `s0` @804793f0, `s1` @804793f4 (inlined everywhere, e.g. 80252204):

```
s0 = s0 * 0x41C64E6D + 12345
if (s1 & 1) s1 ^= 0x00011020
s1 >>= 1
r16 = ((s0 ^ s1) >> 4) & 0xFFFF          // 16-bit integer draw
randInt(lo, hi) = lo + r16 % (hi - lo)    // hi exclusive (signed divw)
randFloat01   = ((s0 ^ s1) & 0x7FFFFF) * 2^-23   // 23-bit mantissa draw, [0,1)
```

## 1. TnkGameParam.bin

Big-endian. `data = *(gGame+52)`; word 0 = header; tank record `t` at
`data + 4 + t*168` (42 words, `mulli 168` at 802414cc, 802501a0, 802523f0); mission record `m`
at `data + 1684 + m*88` (22 words, `mulli 88` at 8024af84/8024b7f0/8024bfa8).

The record is copied by value in three places; each copies a subset into a component:

- **802413b4** (tank init, called by 80243844): uses only k0 → `tank+0x101` (stealth flag).
- **80250138** (movement-AI component init; component = `controller+8`, 560 bytes).
- **80252388** (aim/fire-AI component init; component = `controller+4`, 288 bytes).
  `controller` = `tank+408`, built by 8024f1f8.

Field types (from lwz/lfs in the copy) and destinations:

| k | type | → | k | type | → |
|---|---|---|---|---|---|
| 0 | int | tank+0x101 | 21 | int | Move+64 |
| 1 | float | Aim+76 | 22 | float | Move+12 |
| 2 | int | Aim+68 | 23 | float | (unused by these copies) |
| 3 | int | Aim+88 | 24 | float | (unused by these copies) |
| 4 | int | Aim+84 | 25 | float | Move+20 |
| 5 | float | Aim+80 | 26 | float | Move+16 |
| 6 | float | Aim+96 | 27 | int | Move+40 |
| 7 | float | Aim+92 | 28 | float | Aim+28 |
| 8 | int | Aim+64 | 29 | int | Aim+12 |
| 9 | int | Aim+72 | 30 | float | Aim+48 |
| 10 | float | Move+4 | 31 | float | Aim+56 |
| 11 | float | Move+8 | 32 | float | Aim+52 |
| 12 | float | Move+24 | 33 | int | Aim+16 |
| 13 | int | Move+36 | 34 | int | Aim+44 |
| 14 | int | Move+32 | 35 | int | Aim+40 |
| 15 | float | Move+52 | 36 | int | Aim+8 |
| 16 | float | Move+44 | 37 | float | Aim+20 |
| 17 | float | Move+56 | 38 | float | Aim+32 |
| 18 | float | Move+48 | 39 | int | Aim+36 |
| 19 | int | Move+60 | 40 | float | Aim+60 |
| 20 | float | Move+28 | 41 | int | Aim+24 |

(Field meanings: see §1.1 — filled in below as they are recovered.)

## 9. Decomp cross-check summary

Midway through this analysis a matching C++ decompilation of the game was found
(cloned to `build/decomp`, whose git remote has the source; built for Rev 1). The
simulation in `src/sim/` and `src/game.ts` is a direct port of it, with every routine
citing its decomp file and function. The following was checked instruction-by-instruction
against this DOL (RHAE01 Rev 0) and found identical [C]:

- **Tank record fields (42 words).** Full table with decomp names in `src/sim/stats.ts`.
  The decomp's names for k8 / k9 / k41 are misleading: k8 = mine cooldown, k9 = movement
  freeze after laying a mine, k41 = movement freeze after firing. k23 / k24 (0.12 / 0.85)
  are only read by the player controller (stick dead zone / full-speed magnitude).
- **Header word 0** = starting lives (3). **Mission record word 1** = 2P bonus flag (always 0).
- **Map files** = `[W, H, P1 facing, P2 facing, cells…]`, no trailer. Cell 200 is a hole,
  201–207 wood stacks, 101–107 cork stacks (height = low digit + 1 half-cells).
- **RNG:** `X = X*0x41C64E6D + 12345; if (Y&1) Y ^= 0x11020; Y >>= 1; r = X ^ Y`.
  `randInt(lo,hi) = lo + ((r>>4)&0xFFFF) % (hi-lo)`; zero ranges divide by zero on Gekko
  (quotient 0), which the port reproduces.
- **Enemy AI** (`RPTnkAiMove`, `RPTnkAiAttack`): no bank-shot solving and no lead; a shot is
  taken only when the current turret path (with up to k33 reflections) passes a player's
  cone and misses self/allies. At most 2 fire decisions and 1 mine decision per frame.
- **Physics constants:** cell 35, tank radius 16 (14 vs mines, 15 vs shells at +9 z),
  shell radius 6, self-hit from age 4, wall hit at age ≤ 6 destroys the shell, mine arms
  at 104, proximity 84 → 20-frame fuse, idle fuse 480+120, blast 8→80 over 6 frames,
  kills only during the first 20 frames, breaks cork within blast+17.5.
- **Game flow:** start delay 165 frames, miss wait 120, mission 20 cap without the gold
  medal, medal thresholds {11, 32, 84, 125}.
- **Music:** `RPTnkBgmMix` track-mask table at 0x802F73C0 (see `src/sim/bgm.ts`).
- **Camera:** orthographic, 42°, eye (0, 1338.26, 1472.29), target (0, 0, −14),
  half extents 468 × 256.5 (16:9).

The detailed per-subsystem reports that fed the port are summarised in
`docs/research.md`, `docs/models.md`, `docs/ui.md` and `docs/audio.md`.
