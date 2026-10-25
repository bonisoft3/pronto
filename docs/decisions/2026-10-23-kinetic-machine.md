---
type: decision
title: "The kinetic machine: two planes, a Cortex child that hosts the race, milestones lifted into rows"
description: Accepted, built through its eighth slice, the ninth stopped — the DOM plane (IVM, HTML/CSS, one to many) composes the kinetic plane (GGPO, canvas, few to few) through a `via kinetic` Cortex child; the kinetic plane reaches rows only by lifting app milestones at confirmed frames, with the inputs since the last one, so a row is never rolled back and time travel crosses the planes; the HUD splits by refresh rate between screen regions and presenter canvas, audio is a Jessie sound role on an endowed AudioContext, the run's phases and initials are a run machine's rows, and 1v1 racing is a duel in the engine raced over GGRS on a data channel the duel machine signals through its rows, which joins both racers' milestones into the result.
status: accepted, built through slice 8; slice 9 stopped
---

# The kinetic machine

Apex Run is one player against a clock. A second person on the road, a HUD
that changes sixty times a second, a score a table can trust: each puts a
moving race beside rows that settle at the speed of a transaction. This
record places them in two planes and says how they meet.

## Two planes

| | DOM plane | Kinetic plane |
| --- | --- | --- |
| Moves state by | IVM: rows the store, Electric and the pipelines maintain incrementally | GGPO: rollback with prediction over a deterministic engine |
| Presents with | HTML and CSS, screen regions over rows | canvas, the presenter's worker |
| Fans out | one to many: every reader of a shape | few to few: the peers of one session |
| Pays | a round trip per change | nothing locally; a late input is a rollback |
| Authority | the row | the confirmed frame, until a row says otherwise |

The trade-off is fan-out against latency, and neither plane can buy the
other's: a shape every reader shares cannot answer in a frame, and a
rollback session cannot carry a thousand spectators. So they form a
hierarchy. Cortex, in the DOM plane, composes a kinetic child; the child's
results rise into rows only as milestones a machine consumes, and from
there IVM fans them out. A spectator, a board or a replay list is
one-to-many and so reads the lifted rows, delayed and confirmed, never the
session. The contract is the reference's
([[../component-contracts#Dual planes and the kinetic contract|dual planes]],
[kinetic host](https://github.com/bonisoft3/omnishell/blob/v0.19.1/docs/kinetic.md)); this record decides the
pieces.

## Milestones: how the kinetic plane reaches rows

The engine names its milestones: the events an app gives meaning to, seconds
to minutes apart — a checkpoint passed, a fork taken, a stage ended, time
over, a duel finished. The kinetic child lifts each one into a row, under
two rules:

- **Only at a confirmed frame.** A frame is confirmed when every seat's
  input for it has arrived: at once in a solo race, at GGRS's confirmed
  frame in a session. A milestone reached at a predicted frame waits, and
  lifts when its frame confirms; a rollback that undoes it before then
  takes it back unlifted. So a lifted row is never rolled back, and
  rollback never crosses one. Confirmation is the condition, the milestone
  the trigger: nothing is lifted per frame or per confirmation.
- **With the inputs since the last one.** A milestone row is `{frame, kind,
  checksum, inputs}`, where `inputs` is every seat's command bytes since the
  previous milestone: one byte a seat a frame, about 3.6 KB a player a
  minute (a solo frame is two bytes, its menu keys and gear beside the
  seat's). The run's seed and its milestones' inputs replay the race to any
  milestone; a milestone kind the app declares may also carry a `saveState`
  snapshot, so loading it does not replay. Between milestones history lives
  only in the kinetic ring: a closed tab replays from its last milestone,
  which is what this level promises. There are no periodic keyframes unless
  the app declares a milestone kind for them.

**Authority is one way.** A row can overrule the kinetic plane — the machine
refuses a milestone, a replay check fails, a peer's silence is the machine's
to time out — and the kinetic plane never overrules a row. **Time travel
crosses the planes**: scrubbing the DOM plane's history to a milestone row
loads the kinetic host at its frame, from its snapshot or by replaying the
inputs, and holds the result to the row's checksum; between milestones, the
kinetic ring travels frame by frame.

**Effect levels.** A solo run's milestones are `tab` rows (level 1, the log
replays). A duel's result and a high score are `server` rows (level 3): both
peers lift the same milestone under the same key `(duel, frame, kind)`, so
the machine joins two writes of one fact; two checksums that disagree are an
authoritative desync, which the machine refuses and records. Score trust is
the replay of the lifted inputs (below).

## The `kinetic` Cortex child

A Cortex actor today is a fold over a Mecha machine (`via: session | sync |
local`). `via: "kinetic"` is a child that hosts the kinetic host on its
screen:

- **Declared, not scripted.** The actor names the engine (`surface.engines`),
  the presenter (`capabilities.vendored`, a presenter unit), its input
  bindings, its sound role, and its handler: a Jessie fold over the lifted
  milestones, as a reduce answers any event. The screen carries one
  `data-kinetic` mount; the terminal starts the host there, so no app script
  starts a race.
- **Input from the machine.** The state that invokes it hands the child its
  seed, stage and mode, and for a duel its seat and peer, from the region's
  row. A new seed on that row is a new race.
- **Out only as milestones.** Everything else the engine computes stays in
  the kinetic plane and reaches the screen as pixels and sound.
- **Lifetime is the screen's.** Leaving the screen stops the host and drops
  its ring; the last lifted milestone is what remains.

The run's phases follow: the title, the race, the result, the initials and
the save are the run row's state, written by the child's fold from
milestones, not the engine's `stageState` read by a script.

## The HUD splits by refresh rate

- **Slow, in the DOM plane.** What changes at milestones or a few times a
  stage is a screen region over the run's rows: the stage name and card,
  the fork labels and route matrix, the stage-clear card, the title, pause,
  results and duel end cards, the rival card's text, the board. CSS keeps
  its look — the slanted badges, the panels' blur over the road.
- **Fast, in the kinetic plane.** Speed, the tachometer, the timer, the
  score, the route progress, the nitro gauge, the radar, the rival gap, the
  equalizer: drawn by the presenter, which already has every frame. The
  screen marks a `<canvas data-layer>` where each sits inside its panel;
  the seat transfers those layers with the scene's canvas, and the worker
  draws the digits and bars into them with the HUD's own fonts, read
  through the seat like the art. The panel stays DOM; only what moves is
  canvas.

**Rejected: a kinetic overlay in the DOM**, a Jessie `hud(state)` whose
values the platform writes into marked elements each frame. It is a
binding at 60 Hz in the plane whose cost is per change, for values no row
holds and no second reader wants; it buys nothing the presenter does not
already have, and it puts a per-frame write path into the DOM plane that
every other screen would then be tempted to use.

## Audio is kinetic output, level 0

Sound is a view of the race, like pixels. A Jessie **sound role**,
`sound(state, prev, ctx)`, runs on the main thread beside the host and is
endowed with one whole `AudioContext`. What reaches outside through it is
removed for the realm before any app code runs: `AudioWorklet` /
`Worklet.prototype.addModule` (code and network) and `setSinkId` (another
device). Probe tests hold that the remaining graph reaches no document,
network or storage. The radio's buttons and volume are DOM-plane
affordances whose choice is a `device` row the role reads.

## Initials are the run machine's, read from the kinetic input

Three letters and a cursor are a `tab` row the run machine owns. Their input
is omnishell's kinetic input mapper (`createKineticInput`), the one that
drives the car and already merges the keyboard and a gamepad's axes and
buttons: once the race has ended, its up, down, left, right and confirm
become events the run machine consumes into the initials row, and a DOM
overlay renders the row. There is no frame and no rollback, and nothing the
mapper reads after the race reaches the car.

**Rejected: a keydown reduce** (`data-on-keydown`, the key handed to a reduce
as a machine's keydown has it). It leaves the gamepad to a platform mapping
nobody has built, and right after a race it makes the DOM plane a second
reader of the keys the kinetic input already reads, competing for the same
press.

## The duel and its netcode

A duel is one stage, chosen by the challenger, raced by two cars on one
road with its traffic and no scripted rival; the first under the arch wins,
and at time over the one farther along. Forks are not taken: two players on
two stages share no frame. A seat's input is one byte — throttle, brake,
left, right, nitro — which is also what crosses the network.

| | Prediction and rollback | Latency felt | Reaches outside |
| --- | --- | --- | --- |
| **GGRS in Wasm** (chosen) | GGPO's, maintained, tested | none locally | the data channel the host opens |
| Rollback written here | ours to write and prove | same | same |
| Delay-based lockstep | none | the round trip, every frame | same |
| The Durable Object as authority | the server's | the round trip, every steer | the object's socket |

GGRS ([gschup/ggrs](https://github.com/gschup/ggrs), 0.13.0) is GGPO's
design in Rust; its session asks the host to save, load and advance — the
engine's contract — and its socket is two queues the host fills. The data
channel is unordered and never retransmitted, the datagram GGRS expects.
matchbox ([johanhelsing/matchbox](https://github.com/johanhelsing/matchbox))
does the same with a signalling server outside the stack; here the duel
machine signals through its own rows: each side's description, sent once
ICE gathering completes, is a keyed command row.

**Past a NAT** a peer needs STUN, and a symmetric NAT a TURN relay
([RFC 8445](https://www.rfc-editor.org/rfc/rfc8445),
[RFC 8656](https://www.rfc-editor.org/rfc/rfc8656)). The STUN server is
the release target's, not the duel's: the terminal config carries it, and a
dev or CI stack carries none ([ICE servers](../release-targets.md#ice-servers)).
TURN is deferred, in "Where it stops".

## Trust: the replay is the score

A finished run is its seed and its milestones' inputs. The machine holds a
result to the replay: mecha's cage runs the Jessie engine over the lifted
inputs and accepts the result only where the replay ends with the row's
checksum. The same check turns the single-player high score from a claim
the table bounds into a fact it recomputes.

## Slices

| Slice | Builds | Gate |
| --- | --- | --- |
| 1 | The duel in the engine | engine and sync tests over a recorded two-bot duel |
| 2 | The duel on screen, one keyboard | boot gate in duel mode; a hot-seat duel to its end |
| 3 | GGRS in Wasm over a data channel | GGRS's sync test; two contexts racing, checksums equal |
| 4 | The sound role | role and taming tests, the probes; the radio and engine voice play |
| 5 | Milestone lifting in the host | lift-at-confirmed tests under rollback; seek to a milestone equals the forward run |
| 6 | Presenter layers and the fast HUD on them | seat tests; before/after shots of the HUD; frame gate |
| 7 | `via: "kinetic"`, the run row, the slow HUD and initials as screen regions | schema, emit, mount tests; the arena plays with no custom boot, no bridge, no showcase |
| 8 | Lobby, challenge and the duel machine, signalling through its rows | two contexts challenge, connect and race to a result row |
| 9 | The replay check | a forged result refused, a played one accepted |

Each slice that turns convoluted stops with its evidence here.

## What is built

- **Slice 1.** `initState(seed, {duel: true, stageId})` seats two cars
  (`simulation.js` `duelState`), each read from its own input; `endDuel`
  ends it in one `duel-end` event; `viewForSeat` gives each seat its own car
  as the player's. A recorded two-bot duel is in the sync test through the
  cage.
- **Slice 2.** `showcase.html?duel=hotseat` races both seats on one
  keyboard; the boot gate runs a duel to its end from each seat.
- **Slice 3.** GGRS 0.13.0 builds byte-identically under
  `omnishell/tools/ggrs-wasm` into `interpreter/vendor/ggrs` (214 KiB of
  Wasm). Two peers over a channel that delays every message five ticks and
  loses one in seven roll back and agree on every confirmed frame
  (`omnishell/test/kinetic_session.test.ts`); two browser windows race over
  a real data channel in Chromium and Firefox. WebKit's host candidates are
  mDNS names a second context does not resolve, the NAT stop reached
  without a NAT.
- **Slice 4.** `surface.engines.<name>.role: "sound"` declares a sound
  graph, linked and caged like an engine; its entry exports `createSound`,
  which omnishell's `kinetic-sound.js` hands an AudioContext factory once it
  has removed `Worklet.prototype.addModule`, `audioWorklet` and `setSinkId`
  from the realm. Apex Run's mix is `shell/engine/sound.js`, its noise bed
  drawn from a fixed seed. A browser probe (`playwright-tests/sound.pw.ts`)
  walks every value the tamed context and its factories' nodes expose and
  reaches no document, network or storage, and the caged module reaches no
  Function, worklet or other device through it.
- **Slice 5.** `kinetic-milestones.js` lifts, `createKineticHost` and
  `createRollbackHost` take `milestones`, and GGRS's wrapper exposes
  `confirmed_frame` (rebuilt byte-identically). Apex Run's recorded runs lift
  their start, checkpoints, time over and finish, never per frame, and every
  milestone loads back to the forward run's checksum, replayed from the rows
  alone; two peers over a lossy, late channel lift the same rows; a branch
  behind a lifted milestone throws.
- **Slice 6.** A presenter's seat transfers every `<canvas data-layer>` of
  its screen with the scene's canvas, each with its box, the text style CSS
  gave it and the scale a CSS `zoom` above it puts on that style
  (`hatch-presenter.js`); `env.layers` hands them to the unit. Apex Run's
  fast HUD — speed, revs, tachometer, gear, nitro, timer, score, route
  progress, fork distance, radar, g-force, slipstream, draft meter,
  equalizer, the rival's gap and split — is `shell/engine/hud.js` in the
  presenter, redrawing a layer only when its value changes; the panels stay
  the screen's DOM. Shot at one fixed tick before and after, the HUD reads
  the same; the route matrix's card is a few pixels taller, its fork line's
  box now a line box. The equalizer's levels ride the frame from the sound
  seat, cosmetic like the frame itself. The frame gate is not settled: with
  WebGPU on (`--enable-unsafe-webgpu`, 20 s of stage 1, `evidence/endowed-babylon/frame-cost/measure-presenter.ts`)
  the build before ran 52–54 fps, p95 interval 23.2–23.3 ms, and this one
  42–50 fps, p95 24.3–27.2 ms, but on a machine whose load average stood at
  12 to 18, where five runs of one build spread wider than the difference.

- **Slice 7.** `via: "kinetic"` is a Cortex actor (`cortex.cue`
  `#KineticActor`): its engine, sound role, presenter and bindings, which
  `#App` holds to what the app declares and to a `data-kinetic` on its
  screen, and which shell.json carries to the terminal. The terminal mounts
  the child on that element (omnishell's `kinetic-mount.js`, loaded off the
  first paint's path): the slot's row is its input — a new `seed` a new race,
  `input` the car's or the menu's, `clock` play or hold — and it raises each
  lifted milestone and each menu press as an event on the mount, which the
  region hands its reduce. Apex Run's run machine (`shell/handlers/run.js`)
  puts those as `run_milestone` and `run_input` rows and folds them on one
  seat into the `run` row: title, race, paused, ended, result, initials,
  saved. The slow HUD — stage badge and name, fork labels, route matrix,
  rival card text, the title, pause and results cards, the duel's card, the
  initials and the board — is the arena's markup over that row; the stage it
  names changes at the checkpoint milestone, before the haze. The engine
  lifts one more milestone kind, `grid`, the first frame of every run, so the
  page names the first stage too. The countdown, GO!, GOAL! and TIME OVER, the
  stage card's swoop, the stage-clear card, the close-pass and rival banners
  and the haze are `shell/engine/effects.js` in the presenter, on an `effects`
  layer over the panels and a `haze` layer under them. Pause is a gesture on
  the row that holds the host, and the engine's own pause is gone; a held
  race keeps its sound role hearing its last frame, so the radio plays on and
  the car falls silent. Initials are three columns and a cursor on the run
  row, edited by the mapper's `menu` presses (arrows, a typed letter,
  Backspace, Enter, a gamepad's stick and pad) and saved by the fold as a
  `high_score` create. `tests/run.test.ts` drives the child as the terminal
  wires it, with the caged engine and the declared bindings: a key and a
  gamepad axis both edit the letters, and no frame after the race's end
  reads the car's held key. The pit-lane rewind is the host's own
  `mountControls`, on a `data-kinetic-controls` in the pit-lane panel.
  `shell/boot.js` is the default terminal's, and `bridge.js`, `initials.js`,
  `showcase.js` and `showcase.html` are gone; `check-facts` names no served
  script of Apex Run's. Shot at the same moments before and after
  (title, swoop, countdown, GO!, racing, pause, a banner, the arch, the
  haze, the next stage, time over, the results and board, a duel's end),
  the cards and banners read as they did; the frame measure, now driving the
  arena (`measure-presenter.ts`), ran 37.6 and 48.2 fps, p95 interval 28.9
  and 25.9 ms, at a load average of 20, inside slice 6's spread.

- **Slice 8.** Apex Run's lobby is Truco's model as its own Mecha
  machines (`apps/apexrun/machines/`): `apexrun_presence` (a visibility and
  a lease per tab, the ticker dropping a lapsed one), `apexrun_challenge`
  (the challenger's stage and drawn seed, answered by its target within
  30 s) and `apexrun_duel`, which an accepted challenge spawns with the
  challenger in seat `a`. The duel's rows carry the offer, then the answer,
  each sent once ICE gathering completes; then each
  racer's lifted milestones, which it joins under `(frame, kind)`: two rows
  agreeing on checksum, inputs and result are one fact, two that differ are
  the `disputed` phase with the frame and kind recorded, and the finish both
  lifted is the result. The ticker abandons a duel whose racer fell silent
  (no description in 30 s, no finish in 150 s, one finish unmatched for
  15 s), naming the silent seat. The arena's Cortex root invokes the lobby
  as a session child (`machines/lobby.js`), which sends the race's
  description and milestones to the duel at the revision the seat holds,
  again at the next when the peer's step made it stale. The kinetic child's
  `mode: online` (omnishell's `kinetic-mount.js`) races the row's seat as
  GGRS's peer over `rtc-channel.js`, raising its description as a
  `describe` event and taking the peer's as a prop, and lifts at GGRS's
  confirmed frame; the run machine starts the race from the duel seat and
  reads its result onto the end card. Evidence: the machines through their
  rules (`tests/online-machine.test.ts`) and through the stack's Postgres
  as guests reach them (`tests/online-access.ts`: admissions, an
  accept/cancel race, concurrent lifts made stale and resent, the desync
  dispute, the result, the ticker's timeouts); the folds over their rows
  (`tests/lobby.test.ts`, `tests/run.test.ts`); two mounts racing GGRS over
  an in-memory channel to the same lifted rows (omnishell's
  `test/kinetic_mount.test.ts`); and `tests/duel.ts`, two guests from the
  lobby through a challenge to both end cards over a real data channel,
  both races lifting the same milestones and checksums, green in Chromium
  (headless in the stack, and headed with WebGPU) and Firefox (headed).
  WebKit is skipped, as in slice 3.

- **After slice 8, the replay.** Time travel across the planes is built
  for one reader: Apex Run's road trip. A milestone kind the engine names
  in `milestoneSnapshots` carries its frame's state, and the kinetic child
  takes a `replay` prop, windows of its race each loaded at such a row,
  held to its checksum, and played on the commands the next row lifted, on
  a host of its own, so the race's head stands. The presenter is handed
  each frame with its `cut`; the child raises `replayed` at the end. Every
  replayed frame matches the forward run's checksum (`tests/run.test.ts`,
  `tests/milestones.test.ts`, omnishell's `test/kinetic_mount.test.ts`).

## Where it stops

Found building slice 9:

- **The replay does not fit a Mecha step.** The engine is Jessie, so the
  cage could run it, but a machine's step is bounded at 1,000,000 fuel
  (`mecha.#MachineSetup.fuel`) and the replay costs about 700 a frame
  (the engine bundled and instrumented as Mecha's rules are): the recorded
  duel, 3,905 frames, spends 2,604,079; the castle ending, 4,159 frames,
  2,951,293; a time over at stage 2, 7,561 frames, 5,436,125. A full
  255-second run would be about 11,000,000. Plain, the same replays take
  140 to 290 ms, inside the 5 s statement timeout, so it is the fuel bound
  and not time. Fitting it means either raising the bound by an order of
  magnitude for one machine, or checking a run in steps of about 1,400
  frames that each carry the engine's state (about 6 KB) across the
  machine's context, with the engine's module graph inlined into the
  rules, which take no imports. Either is a decision about Mecha's budget,
  not this slice's, so the duel's result stands on its two racers' joined
  checksums and the high score on its table's bounds.

Found building slice 8:

- **Internet play has STUN and not TURN.** STUN is derived from the
  release target and never declared by an app
  ([ICE servers](../release-targets.md#ice-servers)): Cloudflare's at the
  edge, Google's in the docker, gcp and k8s images, and none in a dev or CI stack, where
  host candidates join two tabs on one machine or two machines on one network,
  so no test depends on a server outside the stack. A pair behind a
  symmetric NAT still fails. A TURN relay carries it, and is deferred: Cloudflare
  Realtime's TURN needs an account and short-lived credentials minted by a
  server-side key, a credential service the stack does not run. The list holds
  `RTCIceServer` entries, so a relay with its credentials fits it. No test
  stands up a NAT.
- **A reload leaves the duel.** The run row is a `tab` row, so a racer who
  reloads mid-duel starts the race again with a fresh session while the
  machine already holds both descriptions; the duel then times out as
  abandoned rather than reconnecting.

Found building slice 7:

- **The rival card shows through the hand-over.** Its text is the row's, but
  it hid while the car rode the arch's autopilot and nothing lifts the moment
  the wheel returns. It now shows from the start milestone to the run's end.
  A milestone at the return would hide it again; none is added for a card.
- **A query parameter cannot seed a row.** `?duel=hotseat` was showcase's; a
  slot's `data-empty-row` resolves `{param.duel}` only where the address
  carries it, and an absent one throws. The hot-seat duel is the title card's
  DUEL button (or `2`), a gesture the run machine applies to the row's
  `mode`; `?seat=` went with it, so a hot-seat duel is seen from the first
  seat.
- **The radio is a `tab` row, not a `device` one.** Its station, mute and
  volume ride the run row, which the sound role reads as props; they last
  the tab, as they did. Keeping them across a reload is a `device` entity of
  their own.
- **A typed letter is a binding per letter.** The mapper reads actions, not
  text, so the actor's `menu` binds `letter_a` to `letter_z` (`KeyA`…`KeyZ`)
  beside the arrows; P is also pause, which the initials ignore.
