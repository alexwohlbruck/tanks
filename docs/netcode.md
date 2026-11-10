# Online multiplayer

Realtime online play for 1-4 players: co-op on the original missions, co-op on a custom
level pack, and a versus free-for-all. The server runs the game; the browsers send input and
draw what the server sends.

| where | what |
|---|---|
| `src/net/protocol.ts` | wire format shared by both sides: JSON control messages, binary input and snapshots, room types |
| `src/net/arenas.ts` | versus arenas (22 x 17, cell codes as the level format) |
| `server/modules/rooms.ts` | `/ws/rooms` and `/api/rooms`: connections, rate limits, room list, matchmaking, the 60 Hz loop |
| `server/net/room.ts` | a room: members, host, settings, input queues, snapshots per client |
| `server/net/runners.ts` | `CoopRunner` (src/game.ts flow) and `VersusRunner` (World + rounds) |
| `server/net/presenter.ts` | `ServerPresenter`: HeadlessPresenter timings + recording of every layout call |
| `server/net/snapshot.ts` | SimEvent -> NetEvent, per-client delta baselines |
| `src/net/client.ts` | the browser's WebSocket: hello / token, reconnect, ping |
| `src/net/session.ts` | `NetSession` (a `Session`): timeline, interpolation, prediction, mirror into Game/World |
| `src/net/lobby.ts`, `hud.ts`, `net.css` | the `lobby` and `net-hud` screens |
| `src/net/index.ts` | glue: starts / ends the NetSession on room messages, `handleJoinParam(app)` |

## Model

**Server-authoritative.** Each room owns a runner that steps the real simulation (`src/game.ts`
+ `src/sim`) at 60 Hz, exactly like local play. Clients only send input. Everything the client
shows comes from the server, except its own tank, which it predicts.

**The client mirrors the server into the app's own `Game` / `World`.** The renderer, the
original Tanks layouts (`UiPresenter`), the HUD and audio read `game.world`, `game.state`,
`game.stats`... and `NetSession` writes those from snapshots, so none of that code knows it is
online:

- stage loads arrive as a `stage` message (cell codes, facing, players, rules); the client
  builds a fresh `World` with `loadStage` (blocks, grid) and calls `listener.onWorld`
- tanks, shells, mines and check marks are written into the World each frame (interpolated)
- simulation events are rebuilt as `SimEvent`s and passed to `listener.onEvents` (effects,
  tread marks, block breaks); sounds and music go straight to `game.audio`
- layout calls are replayed on the client's presenter (see below), and `presenter.tick(game)`
  runs every frame like `Game.tick` would
- game state for the HUD (`state`, `stage`, `lastStage`, `players`, lives, kills, kills by type,
  type order, enemies alive, freeze) arrives as `Meta` whenever it changes

**Layouts.** The game flow waits on its layouts (fade curtain, clear / failed / complete
messages). On the server `ServerPresenter` answers those waits with `HeadlessPresenter`'s
timings (the BRLAN frame counts) and records every call (`fadeStart`, `hudIn`, `hitPopup`,
`clearMsgShow`, `resultStart`, `winnerStart`, ...) as an `['u', method, ...args]` event; clients
call the same method on their real `UiPresenter`, at the same tick, so the curtain, messages and
result list play in sync. Layout sounds are played by the client layouts themselves, so the
server's timing model is muted. The result screens are interactive on the console (skip with A/B),
so the server waits for the host's client to report each one finished (`gate`: `result`,
`totals`, `winner`, `medal`; 20 s timeout). After the last screen the room is `ended` and the
host picks *Play again* or *Back to room* in the overlay (the console's result menu is not used).

## Timing

- simulation: 60 Hz per room (`TICK_HZ`), driven by one 4 ms server interval that runs the ticks
  that are due (at most 5 at once; a stalled process skips ahead instead of fast-forwarding)
- snapshots: every 2nd tick = 30 Hz (`SNAPSHOT_EVERY`)
- client input: one 12-byte frame per client frame (60 Hz), sequence numbered

### Input on the server

Each member has an input queue; every tick takes exactly one input (so the server replays the
client's frames 1:1 and the client can replay the same frames for prediction):
- empty queue: the last stick is held (a late packet), fire / mine are never repeated; after
  8 empty ticks the tank stops (background tab, dropped connection)
- the queue is capped at 6, and when it never drops below 2 for half a second one input is
  dropped (adaptive jitter buffer: inputs that wait are latency)
- a dropped input's fire / mine presses are merged into the next one: edges are never lost
- the snapshot tells the client the last applied sequence number (`ack`)

### Interpolation and the clock

The client keeps `offset = serverTick - localTick`, smoothed (5 % per snapshot, snaps if more
than 30 ticks off) and tracks jitter. The playhead is `now + offset - delay` with
`delay = clamp(SNAPSHOT_EVERY + 3 + 2.5 * jitter, 4, 15)` ticks (about 80 ms on a good line,
up to 250 ms on a bad one). Snapshots are queued in arrival order; when the playhead passes an
item its discrete content is applied (stage loads, `Meta`, events, sounds, layout calls, tread
marks), and positions are interpolated between the last applied snapshot and the next one
(tanks, turret / body angles the short way round, shells by id; no interpolation across a stage
load or over a jump > 40 units). After a long stall (background tab) the backlog is applied
without its sounds and effects.

### Prediction and reconciliation

The client's own tank runs ahead of the server: every frame its input is applied at once to a
private copy of the tank (`ghost`) with the ported controller: `applyVelocity`, separation
from the other tanks, `collideActor` against the walls and blocks of the mirrored World,
`integrateStep`, then `StatePlayerControl` (aim, the fire / mine timers and the movement
freeze, `calcMoveVelocity`). Inputs are quantized exactly as the server decodes them.

Each snapshot carries the exact state of the receiving player's tank (`you`: position, body
forward, speed / direction, freeze and weapon timers, shells / mines out, `ack`). On arrival
the ghost is reset to it and every input after `ack` is replayed; the difference between the
old and the new prediction becomes a display offset that decays by 15 % per frame (or snaps
when > 48 units). The turret always follows the local cursor. Own shot and mine sounds play
at once and the server's copies are skipped. Prediction runs only while the server says the
tank is alive and in player control; when it ends (destroyed) the last predicted pose is held
until the playhead reaches the explosion.

Measured: the prediction error of a driving tank against the server is ~0 (1e-9 units mean
in the browser test, also with 120 ms simulated round trip): the client replays the same code
on the same inputs. Errors come only from tanks pushing each other (other tanks are drawn
~100 ms in the past) and from shots the client predicted but the server refused.

Other players' tanks, all shells (also our own) and enemies are seen ~100 ms + half the round
trip in the past, as usual for this model.

## Wire format

One WebSocket per client at `/ws/rooms` (Caddy routes `/ws/*` to the server). Text frames are
JSON (`C2S` / `S2C` in protocol.ts), binary frames are input and snapshots.

**Control (JSON).** `hello {v, name, token?}` -> `welcome {token}`; `list` -> `rooms`;
`create {public, maxPlayers}`, `join {code}`, `quick`, `leave` -> `room {room}` (to every
member on every change); host: `settings {settings, pack?}`, `start`, `end {choice}`; anyone:
`gate {g}`, `ping {c, rtt}` -> `pong {c}`. Game: `game {mode}` (a game started or the client
attached), `stage {tick, gen, players, enemyCap, cells, facing, rules}`, `error {msg}`.

**Input (binary, 12 bytes).** `u8 2 | u32 seq | i8 moveX*127 | i8 moveY*127 |
u8 flags (analog, fire, mine, hasAim) | i16 aimX*8 | i16 aimZ*8`.

**Snapshot (binary).** `u8 1 | u32 tick | u8 gen | u8 flags | tanks | shells | [mines] |
[marks] | [aims] | [you] | treads | tread sounds | [u32 len + JSON]`
- tanks (11 B): slot (players 0-3, enemies 4+), flags (active, alive, stealth, state), enemy
  type, x / z (i16, 1/16 unit), body / turret (u16 angles). **Delta:** only tanks whose
  quantized record changed since the last snapshot sent to that client; keyframes (`key`
  flag: after a stage load, a (re)join or a new game) carry all
- shells (8 B): id, x, z, heading (u8), smoke type. Always complete (they all move)
- mines (7 B: id, x, z, fuse lit), check marks (7 B: id, x, z, colour), aims (4 B per player:
  the other players' cursors): only when they changed
- you (31 B): the exact own-tank state for prediction
- tread marks (6 B: slot, x, z, direction) and tread sounds (2 B: slot, sound): the frequent
  events, kept binary
- JSON: `m` Meta (when changed), `e` NetEvents, `h` looped sounds (rocket shells, mine fuses:
  `[key, name, x, z]`, refreshed every frame by the client)

NetEvents: `['s', name, x, z, slot]` SE, `['b' | 'bs' | 'bm', ...]` BGM start / stop / track
mask, `['sh', slot, fired]` shot effect, `['r', x, y, z]` ricochet, `['bd', x, y, z, reason]`
shell death, `['td', slot, x, z]` tank destroyed, `['me', x, y, z]` mine explosion,
`['bb', col, row, height]` block destroyed (the client also removes it from its grid and block
pool, so prediction collides correctly), `['st', slot]` stealth, `['u', method, ...args]`
layout call.

WebSocket is ordered and reliable, so a delta against "the last snapshot sent to this client"
needs no acknowledgements. A client whose socket backs up (> 256 KB buffered) skips snapshots;
its baseline only advances on snapshots actually sent, and its events wait for the next one.
Before a stage load the old world's pending events go out as an events-only snapshot, so they
never land on the new stage.

### Bandwidth and latency (measured)

`bun tools/dev/netbot.ts` (4 bot clients driving, firing, laying mines; localhost):

| mode | down per client | snapshots | up per client | input queueing |
|---|---|---|---|---|
| co-op mission 1 | 3.0-3.6 KB/s | 30.0 /s | ~0.7 KB/s payload (60 x 12 B) + WS framing | ~1.2 frames |
| co-op level pack | 3.9-4.1 KB/s | 30.0 /s | same | ~1.2 frames |
| versus, 2 AI | 4.0-4.5 KB/s | 30.0 /s | same | ~1 frame |
| co-op, 120 ms RTT simulated | 3.0-3.6 KB/s | 30.0 /s | same | ~1.5 frames beyond the RTT |

`tools/dev/netroom.ts`: mission 10 with 4 idle players averages 74 B per snapshot (2.2 KB/s);
the largest snapshots (keyframes with JSON meta) are ~320 B.

Input to own tank on screen: immediate (prediction). Input to the server applying it: half the
round trip + ~1 frame of queue. Remote things on screen: ~80-120 ms behind the server + half
the round trip.

## Rooms

- codes: 5 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`; link `https://<host>/?join=CODE`
- public rooms are listed (`list`, `GET /api/rooms`); `quick` joins the fullest public room
  with space (lobby first), or creates a public one
- 1-4 players (`maxPlayers` chosen at creation); slot = colour (P1 blue, P2 red, P3 green,
  P4 yellow); in the lobby slots are compacted to 0..n-1
- the room is server-owned. The host (first member, then the next connected one when the host
  leaves or drops) picks the mode and settings and starts; anyone can leave
- **join in progress:** a player joining a running game takes the lowest free slot. If that
  slot's tank is already in the game (its player left), they drive it at once; otherwise they
  spectate (the whole game, no own tank) and are added at the next mission (co-op: at the
  'next' fade, before the stage loads; lives = P1's) or the next round (versus)
- **disconnect / rejoin:** a dropped member keeps its slot for 60 s (`REJOIN_MS`); its tank
  stands still meanwhile. The client reconnects with backoff and its token (sessionStorage:
  a reload of the tab rejoins, another tab is another player) and gets `game` + `stage` + a
  keyframe. A player who leaves for good frees the slot; the tank stays in that game, idle
- rooms disappear when the last member is gone; lobbies idle for an hour are closed
- limits: 200 rooms (`ROOMS_MAX`), 16 sockets per IP, 10 room creations per IP per minute,
  control messages 20/s (burst 60), input frames 130/s (burst 260); sustained abuse closes the
  socket; text messages up to 512 KB (inline level packs). Names are cleaned (16 chars, no
  markup), every number is clamped, packs are validated with `validateLevel` (<= 100 levels)

## Modes

**Co-op (classic).** `Game.newGame(players, mission)`: the original missions on the 2P maps and
rules for 2-4 players (one life each, bonus lives every 5 missions, game over when everybody
is down with no lives), the 1P rules alone. Start mission 1-20, or 1-100 with "all missions".
After the result screens the host chooses.

**Co-op (level pack).** `Game.newGame(players, 0, seed, pack)`. A pack is either sent inline
(`settings.pack`, the lobby's file upload) or resolved by store id on the server: it fetches
`$LEVELS_URL/packs/<id>` then `$LEVELS_URL/<id>` (default `http://127.0.0.1:$PORT/api/levels`)
and accepts a `LevelPack`, `{ pack }`, or a single `LevelDef`.

**Versus.** Free-for-all on the built-in arenas. Every round is a fresh `World` with the
players at the arena's 4 corner spawns and 0-4 AI tanks (Brown / Ash / Marine / Pink / Green,
random). 150 frames with the tanks shown, "Start!", then fight; when at most one player is
left (alone: when you die or the AI is gone) there is a 90-frame grace period for shells and
mines already on their way, then the last tank standing wins the round. First to N round wins
(1-9) wins the match. Every player shell already destroys any tank (friendly fire is the
original rule); frags count player kills by hit id (`tankDie.by - 1`, not suicides) plus AI
kills. The overlay shows the scoreboard, round and winner banners.

## Client screens and app hooks

- `lobby` (opaque, modal): name, quick play, create (public / private, 2-4 players), join by
  code, public room list; in a room: code + copy invite link, players with ping, host settings
  (mode, mission, pack id / upload, arena, rounds, AI), Start, Leave
- `net-hud` (not modal, pointer-events only on its panels): ping and KB/s, players (host star,
  away, "next" for spectators), versus scoreboard and banners, spectator note, Esc menu
  (Resume / Leave game; the game does not pause), end-of-game panel
- `src/app/app.ts` hooks, marked `[net]`: `import { handleJoinParam } from '../net'` (also
  registers the screens), `handleJoinParam(this)` at the end of `start()`, and in `step()`
  sessions with `hudInput` replace `hud.input` (no pause menu / pre-game online) and provide
  their own `cursors`. `src/app/types.ts`: optional `Session.hudInput` and `Session.cursors`
- a main menu opens online play with `app.show('lobby')`; `?online` opens it on load,
  `?join=CODE` opens it and joins

## Running and testing

```sh
PORT=3003 DATA_DIR=/tmp/tanks-net-data bun --watch server/index.ts     # game server
TANKS_SERVER=http://localhost:3003 npx vite --port 5303                # client, proxy -> server
# open http://localhost:5303/?online in two browsers (or two profiles)

bun tools/dev/netbot.ts ws://localhost:3003/ws/rooms 12 coop      # 4 bots: rates, KB/s, rejoin (also: versus, pack)
bun tools/dev/netroom.ts                                          # room flow without sockets
node tools/dev/netplay.mjs http://localhost:5303 /tmp/netplay     # 2 real browsers, one co-op game (also: versus)

# simulated network (dev only): 50 ms each way + up to 20 ms jitter, order preserved
NET_SIM_LAG_MS=50 NET_SIM_JITTER_MS=20 PORT=3013 bun server/index.ts
```

The browser test runs two software-rendered pages on one machine (~5 fps each), so the RTT it
reports is mostly main-thread delay; the bot test gives the network numbers.

## Deploy

Nothing new beyond the existing `tanks-api` container: the module registers itself in
`server/modules/index.ts`, the server reads `public/assets/data` (already copied by the
Dockerfile), and Caddy already routes `/ws/*` and `/api/*` to `tanks-api:3001` (WebSocket
upgrades pass through `reverse_proxy`). The server reads `X-Forwarded-For` for the per-IP
limits. Optional env: `ROOMS_MAX`, `LEVELS_URL`. Rooms live in memory: a server restart ends
running games (clients fall back to the lobby).

## Limitations / next steps

- shells (also our own) are interpolated, not predicted: a shot appears after about the round
  trip + the interpolation delay; the shot sound plays at once
- no lag compensation: hits are decided on the server's present
- a player who left keeps an idle tank in that co-op game until it ends
- the console's result menu (Try again / Quit) is replaced by the overlay's host choice
- 3-4 player result screens use the existing layouts (which were made for 2)
