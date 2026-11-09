# Audio pipeline (Tanks!)

Generated assets live in `public/assets/audio/` (gitignored). Rebuild everything with:

    python3 tools/audio/build_audio.py            # ~4-5 min on 4 cores, stdlib only
    python3 tools/audio/build_audio.py --only RP_TNK_BGM_LOOP2   # rebuild a subset (merges)
    python3 tools/audio/crosscheck_vgmstream.py /path/to/vgmstream-cli   # optional QC

## Tools (`tools/audio/`)

| file | purpose |
|---|---|
| `nw4r.py` | parsers: RSAR (SYMB/INFO/FILE), RWSD, RBNK, RSEQ, RSTM, WaveInfo, DSP-ADPCM/PCM decode |
| `mml.py` | RSEQ bytecode decoder + recursive disassembler |
| `synth.py` | offline nw4r sequence player + bank sampler (port of `SeqPlayer`/`SeqTrack`/`MmlParser`/`Channel`/`EnvGenerator`/`Lfo`/`Bank`) |
| `wavio.py` | 16-bit WAV writer (with RIFF `smpl` loop chunk) / reader |
| `qc.py` | peak/RMS/DC/zero-crossing, waveform summary, loop seam stats |
| `build_audio.py` | the entry point: renders every sound, writes `manifest.json` + `build_details.json` |
| `crosscheck_vgmstream.py` | compares our decoders against vgmstream sample-by-sample |

Reference used for formats and playback semantics: the nw4r snd library in the Wii Play decompilation
(`build/decomp/src/nw4r/snd/`); it is line-for-line identical to the Wii Sports (ogws) version for
`MmlParser`, `SeqTrack`, `EnvGenerator`, `Channel`, `Lfo`, `Bank*`, `Wsd*`, `WaveFile`, `Util`.

## Source formats

* **RSAR 1.1** (`rp_Tnk_sound.brsar`, `rp_Common_Party.brsar`). SYMB string table; INFO holds
  `Util::DataRef` tables (offsets relative to INFO+8) of sounds (`SoundCommonInfo`: string id,
  file id, player id, 3D param ref, volume u8, player priority, type 1=SEQ/2=STRM/3=WAVE, remote
  filter, type-specific info ref, user params, pan mode/curve, actor player), banks, players,
  files and groups. A file's bytes are found via its file-pos table -> group item
  (`group.offset + item.offset`, wave data at `group.waveDataOffset + item.waveDataOffset`).
* **RBNK 1.1**: DATA block = table of instrument refs (dataType 1 = InstParam, 2 = range table
  of upper-bound keys, 3 = index table), resolved by key then by velocity
  (`BankFileReader::ReadInstInfo`). InstParam: wave index, ADSR, original key, volume, pan, tune.
  WAVE block = table of WaveInfo refs; sample data in the group wave area.
* **WaveInfo**: format (0 PCM8, 1 PCM16, 2 DSP-ADPCM), loop flag, channels, rate (24-bit),
  loop start/end as DSP *nibble* addresses (`sample = nib%16 + nib/16*14 - 2`, end +1),
  per-channel info -> data offset + ADPCM coefs/history.
* **RWSD 1.x**: per sound: WsdInfo (pitch, pan, sends), tracks/note events, note table (wave
  index, ADSR, ...). `WsdPlayer` plays note 0 only; note volume/pitch are ignored by this
  nw4r version.
* **RSEQ**: DATA (bytecode) + LABL. Commands per `MmlParser` (notes 0x00-0x7F + velocity +
  VLQ length, 0x80 wait, 0x81 prg, 0x88 opentrack, 0x89 jump, 0x8A call, 0xA0 random /
  0xA1 variable / 0xA2 if prefixes, 0xB0-0xDF u8 params, 0xE0-0xEF s16 params incl. tempo,
  0xF0 extended variable arithmetic & compares, 0xFC/0xD4 loops, 0xFD ret, 0xFE alloctrack,
  0xFF fin). All implemented.
* **RSTM**: HEAD/ADPC/DATA, block-interleaved DSP-ADPCM.

All DSP-ADPCM decoding is bit-exact against vgmstream r2168 (RSTM both channels, 2.9 M samples;
16 sampled bank waves) - see `crosscheck_vgmstream.py`.

## Renderer behaviour (synth.py)

Faithful port of the nw4r semantics: 48 ppqn default timebase, tempo in BPM
(`ticks/ms = timebase*tempo/60000`), notes with `notewait`, note length countdown -> release,
`length 0` = play until the sample ends, track/player volume squared
(`(vol/127)^2 * (vol2/127)^2 * (mainvol/127)^2`), velocity squared times instrument volume,
pitch `2^((key - origKey + bend/128*bendRange + sweep + lfo)/12) * tune`, portamento/sweep,
LFO (pitch/volume/pan; depth/speed/range/delay), ADSR in 0.1 dB units with the nw4r attack table
and decay/release rates updated every 3 ms, sqrt pan law (centre = -3 dB per side, stereo samples
at ±1), LPF one-pole, mute modes, call stack depth 3, loop counters, sequence variables
(local/global/track) and conditional execution, `Util::CalcRandom` LCG.
Deliberate differences: ticks run at exact sample positions (hardware batches them per 3 ms
frame), 4-point Catmull-Rom resampling (AX: 4-tap polyphase; ratio 1.0 is bit-exact), no AUX
effects (reverb sends are ignored - the dry mix only).

Output rates: sequenced BGM at **32000 Hz** (the AX mixer rate; 1 tick at 120 BPM = 333.33
samples, 768 ticks = exactly 256000 samples). SEs at the highest native rate of the samples they
use (32000 or 44100), so single-sample SEs at their root key are bit-identical to the source.
STRM and WAVE sounds at their native rate.

Random parameters (`rand` prefix) are rendered at the centre of their range for
pitch/transpose/volume/wait, so the game can apply its own randomisation; ranges are listed per
sound in `build_details.json` (`render.random`). Random program choice (`rand prg`, used by the
tread clicks) uses the nw4r LCG and additionally every choice is exported as a variant file.

Levels: every file is rendered at unity sound volume. Files whose render would exceed -0.1 dBFS
were scaled down by `renderGain` (BGM mixes and stems of a sound share one gain); the manifest
`volume` already compensates (`volume = INFO volume / 127 / renderGain`, linear).

## Manifest (`public/assets/audio/manifest.json`, schemaVersion 2)

```
{
  schemaVersion, generator, notes[],
  sounds:       { <brsar label>: Sound }       // rp_Tnk_sound.brsar, all 116 sounds
  bgm:          { <label>: Bgm }               // the *_BGM_* sounds of the Tanks archive
  commonSounds: { <label>: Sound }             // rp_Common_Party.brsar, all 69 sounds
  commonBgm:    { <label>: Bgm },
  tnkBgmLayers: { sound, source, lookup, apply, masks[9][4], enemy_types[9],
                  tracks{ "<n>": {layer, role} }, configs[ {strongest_enemy_type, enemy,
                  enemies_left, mask, mask_hex, tracks[], layers[]} ] }
}
Sound = {
  id,                     // numeric sound id in the archive (== enum in rp_Tnk_sound.h)
  file,                   // path relative to public/assets/audio (null if empty)
  volume,                 // linear playback gain 0..1 (see Levels)
  loop, loopStart?, loopEnd?,   // samples; start inclusive, end exclusive
  sampleRate, channels (2), samples, duration,
  type: "SEQ"|"WAVE"|"STRM", category: "se"|"bgm",
  empty?, runtimeVolume?,       // runtimeVolume: INFO volume is 0
  variants?: [{file, prg, samples, duration}],
  meta: { archive, volumeRaw, player, player_id, player_priority, player_max_sounds,
          actor_player_id, pan_mode, pan_curve, remote_filter, user_param, param3d,
          seq?{file_id, offset, labels, bank, bank_id, alloc_track, channel_priority,
               release_priority_fix} | wave?{...} | strm?{...},
          sequence?{...}, qc{peak, peak_dbfs, rms_dbfs, dc_offset, zero_cross_rate,
          clipped_samples, silent, waveform, loop_seam_jump?, loop_local_max_step?,
          loop_periodicity_error?}, render{renderer, render_gain, playback_gain, random,
          tracks_used, voices, notes, infinite, loop_kind, ...} }
}
Bgm = { id, file, volume, volumeRaw, renderGain, loop, loopStart?, loopEnd?, sampleRate,
        channels, samples, duration, type,
        sequence{tempo, timebase, ticks_per_second, loop_start_tick, loop_end_tick,
                 loop_period_ticks, first_pass_vs_steady_loop_max_diff, tracks_allocated,
                 variables_or_conditionals[]},
        tracks[{track, programs, instruments, layer?, role?, intro{...}, loop{notes, programs,
                key_min, key_max, key_range, velocity_min, velocity_max}}],
        stems?[{track, file, layer, samples, silentInIntro, silentInLoop}], stemsNote? }
```

`build_details.json` holds the same data un-flattened (all QC numbers, random ranges, render
timings, per-stem QC).

`loop_periodicity_error` is the max difference between the rendered audio right after the
loop end and right after the loop start in a continuous render (0.0 = the loop is exactly
periodic). `loop_seam_jump` / `loop_local_max_step` compare the wrap-around step with normal
sample-to-sample movement near the end of the loop.

## How loops are cut

* **Sequence loops** (all looping BGM, JIRAI_TIMER): a dry run of the sequencer finds each
  track's backward jump period; loop = LCM of periods, loop start = latest track loop start.
  Each file is `render[0 : S(loopStart)] + render[S(loopStart+P) : S(loopStart+2P)]`, i.e.
  intro followed by the *second* pass of the loop, so tails of notes from the end of the loop
  ringing into its beginning are present and the loop is sample-exact seamless. Cost: on the
  very first pass, the beginning of the loop contains those tails although the previous pass
  never happened (`first_pass_vs_steady_loop_max_diff`, ~-22 dBFS peak for LOOP2, only within
  the first second).
* **Sample loops** (ENGINE, IDLING): a held note on a looping wave; loop length =
  source loop length / pitch ratio, which is integral (IDLING ratio 1.0: loop 3241-39130 is
  the wave's own loop; ENGINE is played an octave below its root -> loop 87532-259040).
* **STRM** (`RP_COMMON_BGM_PARTY_01`, PartyPackTitle_2Mix.44.brstm): header loop 458752-2912554 @ 44100 Hz.

## BGM layering (RP_TNK_BGM_LOOP2, sound 0x3B)

From the game code (`RPTnkBgmMix`, decomp `src/Pack/RPParty/RPTnkScene/RPTnkBgmMix.cpp`;
table at DOL 0x802F73C0, found independently in `main.dol` before the decomp was available):

    mask = sTrackMasks[clamp(strongestEnemyType,1,9) - 1][min(clamp(enemiesLeft,1,8), 4) - 1]
    handle.SetTrackMute(0xFFFF, MUTE_NO_STOP);
    handle.SetTrackMute(mask,   MUTE_OFF);

The sequence itself has **no sequence variables, conditionals or mute commands** - layering is
entirely game-driven. `MUTE_NO_STOP` means a muted track stops *starting* notes but notes
already sounding ring out; an unmuted track is heard from its next note-on. With pre-rendered
stems, approximate this with a short fade-out (~0.2-0.5 s) on mute and a fast fade-in on unmute
(or schedule the unmute at the stem's next onset). `RPTnkBgmMix::StartStageBgm` starts LOOP2 and
applies the mask immediately; `Stop()` / `PlayStageClearBgm()` use a 10-frame fade (`stopBgm(10)`).
Other BGMs (FILL2 0x3C stage clear, RESULT2 0x3D game over, COMP20 0x3E after mission 20,
COMP100 0x3F, MISS 0x40) start unmuted: play the full mix. PANPAKAPAN (0x41) is started with
`startSystemSe`.

Tracks of LOOP2 (tempo 120, timebase 48, all tracks wait 384 ticks = 4 s, then loop 768 ticks =
8 s; loopStart 128000, loopEnd 384000 samples @ 32 kHz). Bit n of a mask = track n = `track_NN.wav`.

| track | layer | bank program | notes in loop / range | role |
|---|---|---|---|---|
| 0 | piccolo | 0 piccolo (5 key splits) | 72, B3-G6 | melody, two voices - in every mask |
| 1 | timpani_a | 2 percussion | 8, G1-C2 | short timpani phrase |
| 2 | tubular_bells | 6 tubular bells (stereo 44.1k) | 12, E3-C4 | green (and black) |
| 3 | timpani_b | 2 percussion | 14, F#1-E2 | extended timpani phrase; pink |
| 4 | snare | 1 snare (2 velocity layers) | 55, D1 | brown; in most masks |
| 5 | bass_drum | 2 percussion (C1 region) | 10, C1 | yellow |
| 6 | cymbals | 2 percussion (G2 region) | 10, G2 | marine (teal) |
| 7 | metronome | 3 metronome (tick/tock) | 16, A0-A#0 | ash (grey) |
| 8 | tuba | 4 tuba | 17, B0-A1 | violet (purple) |
| 9 | synth | 5 synthesizer | 57, B1-G3 | white (and black) |
| 10 | intro_snare | 1 snare | intro only | mission-intro snare roll, silent in the loop (bit 10 is set in every mask) |

Instrument *names* are inferred (the bank has no names): from the samples' key splits, the
note material, and the in-game layer behaviour documented on nintendo.fandom.com/wiki/Tanks!,
whose observed table matches `sTrackMasks` bit-for-bit under this mapping.

Track masks (`sTrackMasks`, columns = enemies left 1, 2, 3, 4+):

| strongest enemy | 1 | 2 | 3 | 4+ |
|---|---|---|---|---|
| 1 brown  | 0x411 | 0x411 | 0x411 | 0x411 |
| 2 ash    | 0x491 | 0x491 | 0x493 | 0x493 |
| 3 marine | 0x4C3 | 0x4D3 | 0x4D3 | 0x4D9 |
| 4 pink   | 0x419 | 0x459 | 0x4D9 | 0x4D9 |
| 5 yellow | 0x4E3 | 0x4F3 | 0x4F9 | 0x4F9 |
| 6 violet | 0x543 | 0x573 | 0x5F9 | 0x5F9 |
| 7 green  | 0x547 | 0x567 | 0x5F7 | 0x5FD |
| 8 white  | 0x713 | 0x7B9 | 0x7F9 | 0x7F9 |
| 9 black  | 0x7ED | 0x7ED | 0x7ED | 0x7ED |

(e.g. 0x4D9 = tracks 0,3,4,6,7,10 = piccolo, timpani B, snare, cymbals, metronome.)

Other multi-track BGMs (mix only): RESULT2 (11 tracks, loop 192+768 ticks), COMP20 (tracks
0,1,4-8,10; loop 408+768), COMP100 (0,1,4-7,10; loop 330+768). FILL2, MISS, PANPAKAPAN are
one-shots. PANPAKAPAN is a single 383-tick note of a stereo 44.1 kHz fanfare sample (bank
PANPAKAAN).

## SE notes for the game port

* SEs are mostly sequences triggering bank samples, rendered as one stereo file each.
* `*_CSPK` = Wii Remote speaker variant, `*_TVSP` / `*_CTSP` = TV / controller variants of
  party UI sounds. user_param often encodes remote-speaker settings.
* Sounds with INFO volume 0 (`runtimeVolume`): ENGINE, IDLING, GAMESTART, INTRO_CATERPILLAR_00-05,
  RP_COM_GAME_SE_PAUSE_01, RP_COMMON_SE_KEY_A_04, RP_COMMON_SE_KEY_BACK_01 (and several common
  ones). GAMESTART is started by `RPTnkLyt_6` via `startSystemSe(0x23)`; at INFO volume 0 it is
  effectively silent on the TV unless the game raises it - pick a level by ear. ENGINE/IDLING and
  INTRO_CATERPILLAR are not referenced from the Tanks code in the decomp.
* Tread clicks: `RPTnkTankSound::UpdateTread` retriggers CATERPILLAR sounds (ids
  `{0x18,0x19,0x1A,0x1A,0x1A,0x1B,0x1B,0x1C,0x1C,0x1D,0x1D,0x1A}` indexed by tank) every
  `clamp(25 - 30*speed, 4, 25)` frames; each click picks prg 6-9 at random -> use the 4
  variant files, plus rand pitchbend ±30 (bendrange 2 -> ±0.47 semitone).
* SHOOT_ENEMY3/7/9_LV are held (`holdSound`) while the rocket flies: a looping sample with a
  48-semitone portamento over 1000 ticks; the file is the full held render (stop + ~release when
  the bullet dies).
* Shot sounds use rand pitchbend ±100 (±1.56 semitones) - randomise playbackRate in the game.
* JIRAI_TIMER loops (sequence loop of 38 ticks); JIRAI_EXP_MAE is the pre-explosion beeping.
* Empty sequences (no file): RP_COMMON_SE_MESS_FLASH_01, RP_COMMON_SE_CON_Change_02,
  RP_COMMON_SE_Party_DOLL_SLEEP_01.

## QC summary

* No render clips: 0 clipped samples everywhere; rendered files peak <= -0.18 dBFS after renderGain (the STRM is copied bit-exact and itself reaches 0 dBFS).
* All loops: `loop_periodicity_error` = 0.0 (exactly periodic); seam jumps are well below the
  local sample-to-sample movement.
* vgmstream cross-check: bit-exact.
* Per-file peak/RMS/waveform summaries are in the manifest (`meta.qc`).

## Every sound
### Tanks archive (`sounds`, `bgm`)

| id | name | type | rate | dur (s) | loop (samples) | vol | notes |
|---|---|---|---|---|---|---|---|
| 0 | RP_TNK_SE_RESULT_OPEN | WAVE | 32000 | 0.026781 |  | 96 |  |
| 1 | RP_TNK_SE_SHOOT_1P | SEQ | 32000 | 0.292312 |  | 90 | rand pitchbend -100..100 |
| 2 | RP_TNK_SE_SHOOT_2P | SEQ | 32000 | 0.259062 |  | 90 | rand pitchbend -100..100 |
| 3 | RP_TNK_SE_SHOOT_ENEMY1 | SEQ | 32000 | 0.345344 |  | 80 | rand pitchbend -100..100 |
| 4 | RP_TNK_SE_SHOOT_ENEMY2 | SEQ | 32000 | 0.345344 |  | 80 | rand pitchbend -100..100 |
| 5 | RP_TNK_SE_SHOOT_ENEMY3_LV | SEQ | 32000 | 11.972094 |  | 90 | held (holdSound) rocket; 1000-tick sweep |
| 6 | RP_TNK_SE_SHOOT_ENEMY4 | SEQ | 32000 | 0.387656 |  | 80 | rand pitchbend -100..100 |
| 7 | RP_TNK_SE_SHOOT_ENEMY5 | SEQ | 32000 | 0.387656 |  | 80 | rand pitchbend -100..100 |
| 8 | RP_TNK_SE_SHOOT_ENEMY6 | SEQ | 32000 | 0.435125 |  | 80 | rand pitchbend -100..100 |
| 9 | RP_TNK_SE_SHOOT_ENEMY7_LV | SEQ | 32000 | 11.830094 |  | 90 | held (holdSound) rocket; 1000-tick sweep |
| 10 | RP_TNK_SE_SHOOT_ENEMY8 | SEQ | 32000 | 0.435125 |  | 80 | rand pitchbend -100..100 |
| 11 | RP_TNK_SE_SHOOT_ENEMY9_LV | SEQ | 32000 | 11.958219 |  | 90 | held (holdSound) rocket; 1000-tick sweep |
| 12 | RP_TNK_SE_SHOOT | SEQ | 32000 | 0.292312 |  | 85 | rand pitchbend -100..100 |
| 13 | RP_TNK_SE_HIT_CSPK | SEQ | 32000 | 1.403719 |  | 85 | rand pitchbend -100..100 |
| 14 | RP_TNK_SE_HIT | SEQ | 32000 | 1.403719 |  | 90 | rand pitchbend -100..100 |
| 15 | RP_TNK_SE_REFLECT_SUPER | SEQ | 32000 | 0.465531 |  | 110 | rand transpose -2..2 |
| 16 | RP_TNK_SE_REFLECT | SEQ | 32000 | 0.135719 |  | 80 | rand transpose -2..2 |
| 17 | RP_TNK_SE_BROKEN | SEQ | 32000 | 0.358656 |  | 100 | rand transpose 0..3, pitchbend -120..120 |
| 18 | RP_TNK_SE_TNK_DISAPPEAR | SEQ | 44100 | 2.847528 |  | 84 | rand wait 0..5, transpose -1..2 |
| 19 | RP_TNK_SE_JIRAI_SET_CSPK | SEQ | 32000 | 0.464344 |  | 84 |  |
| 20 | RP_TNK_SE_JIRAI_SET | SEQ | 32000 | 0.220219 |  | 84 |  |
| 21 | RP_TNK_SE_JIRAI_TIMER | SEQ | 32000 | 0.395844 | 0-12667 | 84 | rand pitchbend -20..20, volume 110..127; sequence loop |
| 22 | RP_TNK_SE_JIRAI_EXP | SEQ | 32000 | 2.464938 |  | 84 | rand pitchbend -100..100, transpose -12..-7 |
| 23 | RP_TNK_SE_JIRAI_EXP_MAE | SEQ | 32000 | 2.171438 |  | 84 |  |
| 24 | RP_TNK_SE_CATERPILLAR_1P | SEQ | 32000 | 0.070406 |  | 30 | 4 prg variants; rand pitchbend -30..30 |
| 25 | RP_TNK_SE_CATERPILLAR_2P | SEQ | 32000 | 0.070406 |  | 30 | 4 prg variants; rand pitchbend -30..30 |
| 26 | RP_TNK_SE_CATERPILLAR_SLOW | SEQ | 32000 | 0.059219 |  | 20 | 4 prg variants; rand pitchbend -30..30 |
| 27 | RP_TNK_SE_CATERPILLAR_MID | SEQ | 32000 | 0.066469 |  | 20 | 4 prg variants; rand pitchbend -30..30 |
| 28 | RP_TNK_SE_CATERPILLAR_SAME | SEQ | 32000 | 0.079031 |  | 25 | 4 prg variants; rand pitchbend -30..30 |
| 29 | RP_TNK_SE_CATERPILLAR_FAST | SEQ | 32000 | 0.088719 |  | 25 | 4 prg variants; rand pitchbend -30..30 |
| 30 | RP_TNK_SE_CATERPILLAR | SEQ | 32000 | 0.070406 |  | 40 | 4 prg variants; rand pitchbend -30..30 |
| 31 | RP_TNK_SE_ENGINE | SEQ | 32000 | 8.095 | 87532-259040 | 0 | INFO vol 0; wave loop |
| 32 | RP_TNK_SE_IDLING | SEQ | 32000 | 1.222813 | 3241-39130 | 0 | INFO vol 0; wave loop |
| 33 | RP_TNK_SE_MISSION_BONUS | SEQ | 32000 | 1.202531 |  | 70 | renderGain 0.872 |
| 34 | RP_TNK_SE_TNK1UP | SEQ | 32000 | 0.734281 |  | 84 |  |
| 35 | RP_TNK_SE_GAMESTART | SEQ | 32000 | 1.169969 |  | 0 | INFO vol 0; renderGain 0.954 |
| 36 | RP_TNK_SE_GET_TNKNUM | SEQ | 32000 | 0.245469 |  | 65 |  |
| 37 | RP_TNK_SE_GET_HIT | SEQ | 32000 | 0.773031 |  | 50 |  |
| 38 | RP_TNK_SE_GET_HIT_01 | SEQ | 32000 | 0.775 |  | 50 |  |
| 39 | RP_TNK_SE_GET_HIT_02 | SEQ | 32000 | 0.775 |  | 50 |  |
| 40 | RP_TNK_SE_GET_HIT_CSPK | SEQ | 32000 | 0.921281 |  | 100 |  |
| 41 | RP_TNK_SE_GET_HIT_01_CSPK | SEQ | 32000 | 0.921281 |  | 100 |  |
| 42 | RP_TNK_SE_GET_HIT_02_CSPK | SEQ | 32000 | 0.921281 |  | 100 |  |
| 43 | RP_TNK_SE_RESULT_TNK_TOTAL | SEQ | 32000 | 0.855125 |  | 80 |  |
| 44 | RP_TNK_SE_RESULT_TNK_LINE09 | SEQ | 32000 | 0.615437 |  | 65 |  |
| 45 | RP_TNK_SE_RESULT_TNK_LINE08 | SEQ | 32000 | 0.298656 |  | 65 |  |
| 46 | RP_TNK_SE_RESULT_TNK_LINE07 | SEQ | 32000 | 0.297375 |  | 65 |  |
| 47 | RP_TNK_SE_RESULT_TNK_LINE06 | SEQ | 32000 | 0.615437 |  | 65 |  |
| 48 | RP_TNK_SE_RESULT_TNK_LINE05 | SEQ | 32000 | 0.298656 |  | 65 |  |
| 49 | RP_TNK_SE_RESULT_TNK_LINE04 | SEQ | 32000 | 0.297375 |  | 65 |  |
| 50 | RP_TNK_SE_RESULT_TNK_LINE03 | SEQ | 32000 | 0.615437 |  | 65 |  |
| 51 | RP_TNK_SE_RESULT_TNK_LINE02 | SEQ | 32000 | 0.297375 |  | 65 |  |
| 52 | RP_TNK_SE_RESULT_TNK_LINE01 | SEQ | 32000 | 0.298656 |  | 65 |  |
| 53 | RP_TNK_SE_INTRO_CATERPILLAR_00 | SEQ | 32000 | 1.111312 |  | 0 | INFO vol 0; rand pitchbend -30..30 |
| 54 | RP_TNK_SE_INTRO_CATERPILLAR_01 | SEQ | 32000 | 1.687906 |  | 0 | INFO vol 0; rand randvar 0..6, wait 1..9, pitchbend -30..30 |
| 55 | RP_TNK_SE_INTRO_CATERPILLAR_02 | SEQ | 32000 | 1.747719 |  | 0 | INFO vol 0; rand randvar 0..6, wait 1..9, pitchbend -30..30 |
| 56 | RP_TNK_SE_INTRO_CATERPILLAR_03 | SEQ | 32000 | 1.906937 |  | 0 | INFO vol 0; rand randvar 0..6, wait 1..9, pitchbend -30..30 |
| 57 | RP_TNK_SE_INTRO_CATERPILLAR_04 | SEQ | 32000 | 2.010969 |  | 0 | INFO vol 0; rand randvar 0..6, wait 1..9, pitchbend -30..30 |
| 58 | RP_TNK_SE_INTRO_CATERPILLAR_05 | SEQ | 32000 | 1.739844 |  | 0 | INFO vol 0; rand randvar 0..6, wait 1..9, pitchbend -30..30, transpose 1..4 |
| 59 | RP_TNK_BGM_LOOP2 | SEQ | 32000 | 12.0 | 128000-384000 | 75 | renderGain 0.676 |
| 60 | RP_TNK_BGM_FILL2 | SEQ | 32000 | 1.907844 |  | 65 |  |
| 61 | RP_TNK_BGM_RESULT2 | SEQ | 32000 | 10.0 | 64000-320000 | 70 |  |
| 62 | RP_TNK_BGM_COMP20 | SEQ | 32000 | 12.25 | 136000-392000 | 70 | renderGain 0.725 |
| 63 | RP_TNK_BGM_COMP100 | SEQ | 32000 | 11.4375 | 110000-366000 | 70 | renderGain 0.615 |
| 64 | RP_TNK_BGM_MISS | SEQ | 32000 | 2.875125 |  | 70 |  |
| 65 | RP_TNK_BGM_PANPAKAPAN | SEQ | 32000 | 2.310156 |  | 64 | renderGain 0.983 |
| 66 | RP_COM_GAME_SE_PAUSE_01_CTSP | SEQ | 32000 | 0.581812 |  | 80 |  |
| 67 | RP_COM_GAME_SE_PAUSE_01_TVSP | SEQ | 32000 | 0.810969 |  | 55 | renderGain 0.824 |
| 68 | RP_COM_GAME_SE_PAUSE_01 | SEQ | 32000 | 0.810969 |  | 0 | INFO vol 0; renderGain 0.824 |
| 69 | RP_COM_GAME_PARTY_SE_A_01_CTSP | SEQ | 32000 | 0.947375 |  | 100 |  |
| 70 | RP_COM_GAME_PARTY_SE_A_01_TVSP | SEQ | 32000 | 1.305375 |  | 100 |  |
| 71 | RP_COM_GAME_PARTY_SE_A_01 | SEQ | 32000 | 1.305375 |  | 100 |  |
| 72 | RP_COM_GAME_PARTY_SE_Cursor_01 | SEQ | 32000 | 0.011875 |  | 40 |  |
| 73 | RP_COM_GAME_PARTY_SE_LANK_01 | SEQ | 32000 | 1.313063 |  | 30 |  |
| 74 | RP_COM_GAME_PARTY_SE_Win_Open_01 | SEQ | 32000 | 0.589656 |  | 60 |  |
| 75 | RP_COM_GAME_PARTY_SE_Win_Close_01 | SEQ | 32000 | 0.563906 |  | 80 |  |
| 76 | RP_COM_GAME_PARTY_SE_COUNT_TIME_01 | SEQ | 22050 | 0.078231 |  | 20 |  |
| 77 | RP_COM_GAME_PARTY_SE_COUNT_TIME_02 | SEQ | 22050 | 0.078231 |  | 30 |  |
| 78 | RP_COM_GAME_PARTY_SE_COUNT_TIME_03 | SEQ | 22050 | 0.078231 |  | 50 |  |
| 79 | RP_COM_GAME_PARTY_SE_COUNT_TIME_x_01 | SEQ | 32000 | 0.271688 |  | 50 |  |
| 80 | RP_COM_GAME_PARTY_SE_COUNT_01 | SEQ | 32000 | 0.453188 |  | 50 |  |
| 81 | RP_COM_GAME_PARTY_SE_COUNT_02 | SEQ | 32000 | 1.231406 |  | 50 |  |
| 82 | RP_COM_GAME_PARTY_SE_RESULT_KEY_A_01_CTSP | SEQ | 32000 | 0.947375 |  | 80 |  |
| 83 | RP_COM_GAME_PARTY_SE_RESULT_KEY_A_01_TVSP | SEQ | 32000 | 1.305375 |  | 80 |  |
| 84 | RP_COM_GAME_PARTY_SE_RESULT_KEY_A_01 | SEQ | 32000 | 1.305375 |  | 80 |  |
| 85 | RP_COM_GAME_PARTY_SE_RESULT_KEY_A_02_CTSP | SEQ | 32000 | 0.947375 |  | 50 |  |
| 86 | RP_COM_GAME_PARTY_SE_RESULT_KEY_A_02_TVSP | SEQ | 32000 | 0.971281 |  | 50 |  |
| 87 | RP_COM_GAME_PARTY_SE_RESULT_KEY_A_02 | SEQ | 32000 | 0.971281 |  | 50 |  |
| 88 | RP_COM_GAME_PARTY_SE_BUTTON_03 | SEQ | 32000 | 0.700469 |  | 70 |  |
| 89 | RP_COM_GAME_PARTY_SE_BUTTON_05 | SEQ | 22050 | 0.153288 |  | 70 |  |
| 90 | RP_COM_GAME_SE_PAUSE_KEY_A_01_CTSP | SEQ | 32000 | 0.324688 |  | 50 |  |
| 91 | RP_COM_GAME_SE_PAUSE_KEY_A_01_TVSP | SEQ | 32000 | 0.324688 |  | 50 |  |
| 92 | RP_COM_GAME_SE_PAUSE_KEY_A_01 | SEQ | 32000 | 0.324688 |  | 50 |  |
| 93 | RP_COM_GAME_SE_PAUSE_KEY_A_02_CTSP | SEQ | 32000 | 0.947375 |  | 80 |  |
| 94 | RP_COM_GAME_SE_PAUSE_KEY_A_02_TVSP | SEQ | 32000 | 2.844219 |  | 80 |  |
| 95 | RP_COM_GAME_SE_PAUSE_KEY_A_02 | SEQ | 32000 | 2.844219 |  | 80 |  |
| 96 | RP_COM_GAME_SE_PAUSE_KEY_A_03_CTSP | SEQ | 32000 | 0.947375 |  | 60 |  |
| 97 | RP_COM_GAME_SE_PAUSE_KEY_A_03_TVSP | SEQ | 32000 | 0.971281 |  | 60 |  |
| 98 | RP_COM_GAME_SE_PAUSE_KEY_A_03 | SEQ | 32000 | 0.971281 |  | 60 |  |
| 99 | RP_COM_GAME_SE_PAUSE_Cursor_01 | SEQ | 32000 | 0.011375 |  | 45 |  |
| 100 | RP_COM_GAME_SE_2P_WIN_LOSE_01 | SEQ | 32000 | 2.647375 |  | 65 |  |
| 101 | RP_COM_BGM_GET_COPPER | SEQ | 32000 | 7.144281 |  | 80 |  |
| 102 | RP_COM_BGM_GET_SILVER | SEQ | 32000 | 7.559969 |  | 70 | renderGain 0.988 |
| 103 | RP_COM_BGM_GET_GOLD | SEQ | 32000 | 7.251437 |  | 60 | renderGain 0.641 |
| 104 | RP_COM_BGM_GET_PLATINA | SEQ | 32000 | 7.587594 |  | 60 | renderGain 0.737 |
| 105 | RP_COM_BGM_RENEW_RECORD2 | SEQ | 32000 | 2.584125 |  | 40 | renderGain 0.793 |
| 106 | RP_COM_BGM_RENEW_RECORD | SEQ | 32000 | 3.407281 |  | 45 | renderGain 0.729 |
| 107 | RP_COMMON_SE_MESS_10 | SEQ | 44100 | 1.44127 |  | 100 |  |
| 108 | RP_COMMON_SE_MESS_20 | SEQ | 32000 | 1.032812 |  | 90 |  |
| 109 | RP_COMMON_SE_KEY_A_04_CTSP | SEQ | 32000 | 1.127656 |  | 45 |  |
| 110 | RP_COMMON_SE_KEY_A_04_TVSP | SEQ | 32000 | 1.107906 |  | 70 |  |
| 111 | RP_COMMON_SE_KEY_A_04 | SEQ | 32000 | 1.107906 |  | 0 | INFO vol 0 |
| 112 | RP_COMMON_SE_KEY_BACK_01_CTSP | SEQ | 32000 | 1.692125 |  | 40 |  |
| 113 | RP_COMMON_SE_KEY_BACK_01_TVSP | SEQ | 32000 | 1.545 |  | 60 |  |
| 114 | RP_COMMON_SE_KEY_BACK_01 | SEQ | 32000 | 1.545 |  | 0 | INFO vol 0 |
| 115 | RP_COMMON_SE_KEY_CURSOR_01 | SEQ | 32000 | 0.011875 |  | 35 |  |

### Party-common archive (`commonSounds`, `commonBgm`)

| id | name | type | rate | dur (s) | loop (samples) | vol | notes |
|---|---|---|---|---|---|---|---|
| 0 | RP_COMMON_SE_LOGO_01 | SEQ | 32000 | 0.044187 |  | 0 | INFO vol 0 |
| 1 | RP_COMMON_SE_WIN_OPEN_01 | SEQ | 32000 | 0.485656 |  | 65 |  |
| 2 | RP_COMMON_SE_WIN_CLOSE_01 | SEQ | 32000 | 0.480812 |  | 85 |  |
| 3 | RP_COMMON_SE_MESS_OK_01_CTSP | SEQ | 32000 | 1.400406 |  | 60 |  |
| 4 | RP_COMMON_SE_MESS_OK_01_TVSP | SEQ | 32000 | 1.730844 |  | 70 |  |
| 5 | RP_COMMON_SE_MESS_OK_02_CTSP | SEQ | 32000 | 1.400406 |  | 60 |  |
| 6 | RP_COMMON_SE_MESS_OK_02_TVSP | SEQ | 32000 | 1.400438 |  | 60 |  |
| 7 | RP_COMMON_SE_SEARCH_01 | SEQ | 32000 | 3.923469 |  | 60 |  |
| 8 | RP_COMMON_SE_CON_ADD_01 | SEQ | 32000 | 2.370062 |  | 80 |  |
| 9 | RP_COMMON_SE_MESS_FLASH_01 | SEQ |  |  |  | 0 | empty sequence (no file); INFO vol 0 |
| 10 | RP_COMMON_SE_MESS_10 | SEQ | 44100 | 1.44127 |  | 100 |  |
| 11 | RP_COMMON_SE_MESS_20 | SEQ | 32000 | 1.032812 |  | 90 |  |
| 12 | RP_COMMON_BGM_PARTY_01 | STRM | 44100 | 66.044308 | 458752-2912554 | 90 |  |
| 13 | RP_COMMON_BGM_RANK_COMPLETE | WAVE | 44100 | 6.397075 |  | 80 |  |
| 14 | RP_COMMON_BGM_PARTY_MENU | SEQ | 32000 | 34.594594 | 0-1107027 | 50 |  |
| 15 | RP_COMMON_BGM_PARTY_MENU_SLEEP | SEQ | 32000 | 52.287531 | 536054-1673201 | 50 |  |
| 16 | RP_COMMON_SE_KEY_AB_pri_A_01_CTSP | SEQ | 32000 | 0.011437 |  | 0 | INFO vol 0 |
| 17 | RP_COMMON_SE_KEY_AB_pri_A_01_TVSP | SEQ | 32000 | 0.796375 |  | 0 | INFO vol 0 |
| 18 | RP_COMMON_SE_KEY_AB_pri_A_01 | SEQ | 32000 | 0.796375 |  | 28 |  |
| 19 | RP_COMMON_SE_KEY_AB_pri_B_01_CTSP | SEQ | 32000 | 0.02 |  | 0 | INFO vol 0 |
| 20 | RP_COMMON_SE_KEY_AB_pri_B_01_TVSP | SEQ | 32000 | 0.204687 |  | 0 | INFO vol 0 |
| 21 | RP_COMMON_SE_KEY_AB_pri_B_01 | SEQ | 32000 | 0.204687 |  | 33 |  |
| 22 | RP_COMMON_SE_KEY_AB_01_CTSP | SEQ | 32000 | 1.513781 |  | 120 |  |
| 23 | RP_COMMON_SE_KEY_AB_01_TVSP | SEQ | 32000 | 2.079625 |  | 0 | INFO vol 0 |
| 24 | RP_COMMON_SE_KEY_AB_01 | SEQ | 32000 | 2.079625 |  | 80 |  |
| 25 | RP_COMMON_SE_KEY_A_01_CTSP | SEQ | 32000 | 1.513781 |  | 125 |  |
| 26 | RP_COMMON_SE_KEY_A_01_TVSP | SEQ | 32000 | 1.715563 |  | 80 |  |
| 27 | RP_COMMON_SE_KEY_A_01 | SEQ | 32000 | 1.715563 |  | 0 | INFO vol 0 |
| 28 | RP_COMMON_SE_KEY_A_02_CTSP | SEQ | 32000 | 0.942813 |  | 100 |  |
| 29 | RP_COMMON_SE_KEY_A_02_TVSP | SEQ | 32000 | 1.575969 |  | 100 |  |
| 30 | RP_COMMON_SE_KEY_A_02 | SEQ | 32000 | 1.575969 |  | 0 | INFO vol 0 |
| 31 | RP_COMMON_SE_KEY_A_03_CTSP | SEQ | 32000 | 0.913344 |  | 65 |  |
| 32 | RP_COMMON_SE_KEY_A_03_TVSP | SEQ | 32000 | 1.294563 |  | 55 |  |
| 33 | RP_COMMON_SE_KEY_A_03 | SEQ | 32000 | 1.294563 |  | 0 | INFO vol 0 |
| 34 | RP_COMMON_SE_KEY_NG_01_CTSP | SEQ | 22050 | 0.549524 |  | 80 |  |
| 35 | RP_COMMON_SE_KEY_NG_01_TVSP | SEQ | 22050 | 0.549524 |  | 50 |  |
| 36 | RP_COMMON_SE_KEY_NG_01 | SEQ | 22050 | 0.549524 |  | 50 |  |
| 37 | RP_COMMON_SE_KEY_CURSOR_02 | SEQ | 32000 | 0.014937 |  | 45 |  |
| 38 | RP_COMMON_SE_KEY_CURSOR_03 | SEQ | 32000 | 0.676844 |  | 65 |  |
| 39 | RP_COMMON_SE_KEY_CURSOR_04 | SEQ | 32000 | 0.708156 |  | 65 |  |
| 40 | RP_COMMON_SE_KEY_CURSOR_05 | SEQ | 32000 | 0.062344 |  | 35 |  |
| 41 | RP_COMMON_SE_CON_Change_01_CTSP | SEQ | 32000 | 1.9355 |  | 0 | INFO vol 0 |
| 42 | RP_COMMON_SE_CON_Change_01_TVSP | SEQ | 32000 | 2.0605 |  | 30 |  |
| 43 | RP_COMMON_SE_CON_Change_01 | SEQ | 32000 | 1.9355 |  | 125 |  |
| 44 | RP_COMMON_SE_CON_Change_02 | SEQ |  |  |  | 0 | empty sequence (no file); INFO vol 0 |
| 45 | RP_COMMON_SE_Balloon_OPEN_01 | SEQ | 32000 | 0.485938 |  | 30 |  |
| 46 | RP_COMMON_SE_Balloon_CLOSE_01 | SEQ | 32000 | 0.742656 |  | 30 |  |
| 47 | RP_COMMON_SE_Party_DOLL_CLICK_01_CTSP | SEQ | 32000 | 0.200875 |  | 30 | rand pitchbend 0..40 |
| 48 | RP_COMMON_SE_Party_DOLL_CLICK_01_TVSP | SEQ | 32000 | 0.579219 |  | 30 | rand pitchbend 110..120, wait 20..30, cmd_2F 5..10, cmd_2D 5..10 |
| 49 | RP_COMMON_SE_Party_DOLL_CLICK_02_CTSP | SEQ | 32000 | 0.646563 |  | 15 | rand pitchbend -20..20 |
| 50 | RP_COMMON_SE_Party_DOLL_CLICK_02_TVSP | SEQ | 32000 | 0.811813 |  | 30 | rand pitchbend -120..120, wait 20..30, cmd_43 5..15 |
| 51 | RP_COMMON_SE_Party_DOLL_CLICK_HL_CTSP | SEQ | 32000 | 0.646563 |  | 15 | rand pitchbend -20..20 |
| 52 | RP_COMMON_SE_Party_DOLL_CLICK_HL_TVSP | SEQ | 32000 | 0.811813 |  | 30 | rand pitchbend -120..120, wait 20..30, cmd_43 5..15 |
| 53 | RP_COMMON_SE_Party_DOLL_CLICK_HR_CTSP | SEQ | 32000 | 0.646563 |  | 15 | rand pitchbend -20..20 |
| 54 | RP_COMMON_SE_Party_DOLL_CLICK_HR_TVSP | SEQ | 32000 | 0.811813 |  | 30 | rand pitchbend -120..120, wait 20..30, cmd_43 5..15 |
| 55 | RP_COMMON_SE_Party_DOLL_CLICK_FL_CTSP | SEQ | 32000 | 0.646563 |  | 15 | rand pitchbend -20..20 |
| 56 | RP_COMMON_SE_Party_DOLL_CLICK_FL_TVSP | SEQ | 32000 | 0.811813 |  | 30 | rand pitchbend -120..120, wait 20..30, cmd_43 5..15 |
| 57 | RP_COMMON_SE_Party_DOLL_CLICK_FR_CTSP | SEQ | 32000 | 0.646563 |  | 15 | rand pitchbend -20..20 |
| 58 | RP_COMMON_SE_Party_DOLL_CLICK_FR_TVSP | SEQ | 32000 | 0.811813 |  | 30 | rand pitchbend -120..120, wait 20..30, cmd_43 5..15 |
| 59 | RP_COMMON_SE_Party_DOLL_WakUp_01 | SEQ | 32000 | 0.247719 |  | 35 | rand pitchbend -60..60 |
| 60 | RP_COMMON_SE_Party_DOLL_TALK_01 | SEQ | 32000 | 12.950406 |  | 0 | INFO vol 0; rand volume 90..120, pitchbend -120..120, transpose 0..12, cmd_25 10..40 |
| 61 | RP_COMMON_SE_Party_DOLL_SLEEP_01 | SEQ |  |  |  | 0 | empty sequence (no file); INFO vol 0 |
| 62 | RP_COMMON_SE_KEY_A_04_CTSP | SEQ | 32000 | 1.127656 |  | 45 |  |
| 63 | RP_COMMON_SE_KEY_A_04_TVSP | SEQ | 32000 | 1.107906 |  | 70 |  |
| 64 | RP_COMMON_SE_KEY_A_04 | SEQ | 32000 | 1.107906 |  | 0 | INFO vol 0 |
| 65 | RP_COMMON_SE_KEY_BACK_01_CTSP | SEQ | 32000 | 1.692125 |  | 40 |  |
| 66 | RP_COMMON_SE_KEY_BACK_01_TVSP | SEQ | 32000 | 1.545 |  | 60 |  |
| 67 | RP_COMMON_SE_KEY_BACK_01 | SEQ | 32000 | 1.545 |  | 0 | INFO vol 0 |
| 68 | RP_COMMON_SE_KEY_CURSOR_01 | SEQ | 32000 | 0.011875 |  | 35 |  |
