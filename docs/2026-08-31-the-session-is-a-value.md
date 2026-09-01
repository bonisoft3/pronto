# The session is a value

Written after one afternoon of live inspection produced four bugs whose
fixes averaged five lines and whose diagnoses averaged an agent-hour each.
The ground: `2026-08-27-events-and-the-clock.md` (the terminal owns every
effect), `2026-08-31-one-ladder-one-grammar.md` (state is rows; events are
derived), and `2026-08-30-machines-not-widgets.md` (commands are values).
Those docs spent their arguments making the session deterministic; this doc
collects the payment.

The claim: **a session is initial rows plus boundary-crossing inputs plus a
seed — a value the terminal can record, name, export, and replay — and a
bug report is a screenshot whose URL carries the recording's name.** Every
design fight that kept promises, callbacks, and ambient clocks out of the
reduce contract was won so this value exists; what is missing is only the
recorder, the name, and the loader.

## Facts not to re-derive

Read out of this tree and this day, 2026-08-31.

- **All four of today's bugs were state the debugger could not reach.** The
  fold-seat double-mint, the number-vs-text wedge, the ghost-log ladder
  climb, and the inert won-match table each reproduced only under rows
  accumulated in one browser profile's device tier. Each hunt began by
  guessing that state; the fixes were 4–6 lines each.
- **The deterministic core is already closed.** The terminal owns delays
  (`rest()`, `?tempo=`, `?clock=manual`), draws (`?seed=`, `draw()`), and
  event synthesis (`step()`, `raise`, `refused`); a reduce returning a
  promise is a thrown error; machine leaves see a row-closed world. What
  crosses the boundary inward is enumerable: user gestures, form values,
  draw results, and — at server tiers — the server's answers.
- **State is serializable where it lies.** Local collections persist as
  JSON in the device tier already (`localStorage["mecha:<table>"]`); the
  synced collections are arrays in memory; `__mechaClient` exposes both.
- **The hash is the router.** `#/article/:slug` is navigation; anything
  else the URL carries must share the grammar without firing it.
  `history.replaceState` rewrites the hash without a `hashchange` event and
  without a history entry.
- **A screenshot carries ~60 legible URL characters.** A compressed trace
  does not survive pixels; a short id does. Clipboard writes require a user
  gesture; a keyboard chord or a button is one.
- **Fixture-mode boot exists** — the storybook tier already mounts screens
  from fixture rows with handlers off; the loader below is that door,
  opened for live handlers and a fed event stream.
- **A trace is only valid against its emission.** The program pins the ir's
  sha256 already; Factorio and Elm both learned that unpinned replays
  desync silently.

## Prior art, and what it prices

The composite is old; the substrate makes it cheap here. Mozilla `rr`
records at the nondeterminism boundary and re-executes — its hard part is
*creating* determinism with ptrace, which this terminal has by doctrine.
Deterministic game replays (Doom demos, Factorio) ship hours of play as
kilobytes of inputs plus a seed, version-pinned. Elm's debugger and Redux
DevTools export the action log as JSON and jump-to-N — the direct ancestors
of this reduce contract. Java Flight Recorder is the always-on bounded ring
dumped on demand; iOS sysdiagnose is the button chord that packages the
bundle; Sentry attaches the replay to the error screen; Godbolt taught the
URL-when-small-else-artifact tier. Nothing below is invented; only the
price is new.

## The recorder

Always on, bounded, resident in the device tier. It journals the
**boundary-crossing inputs only**: DOM-sourced events as the terminal
already shapes them (`{type, from?, id?}`, form submissions with their
values), each draw's dealt value, and — at server tiers — the server's
answers (refusals, sync deltas). Everything else re-derives: mutation
wakes, raised events, and timer firings are consequences, and the manual
clock replays the delays deterministically. Alongside the input ring rides
a **rolling snapshot** — the local collections' rows, re-taken when the
ring wraps, so history stays bounded (JFR's ring, Redux's commit, TTD's
checkpoint: one idea, three names).

The recorder writes a reserved local table outside every app's read space:
recording must never wake a fold. Overhead is a JSON append per gesture —
tens of bytes; a full sitting of truco is hundreds of events.

## The name, and the two URLs

Under `?debug=true` the terminal stamps each recording with a short id and
keeps the hash current via `replaceState`:

    https://localhost:8449/shell/?debug=true#/~t=8f3a2c

Six characters survive any screenshot. The id names the recording where it
lies — the payload never rides the URL, because the router owns the hash
and pixels cannot carry kilobytes.

Dereferencing is two-tier:

- **`?trace=8f3a2c`, same browser** — the terminal serves the export
  surface instead of the app: the full trace (snapshot + inputs + pins)
  pulled from the device tier, shown, copied to the clipboard, offered as
  a download. This is the human hop, for when the report leaves the
  machine.
- **The dev trace sink, no human at all** — in debug mode the terminal
  also streams the recording to the cluster: `POST /traces/<id>`, served
  back by `GET /traces/<id>`. The sink is a dev-profile-only route — never
  emitted into a production compose — so on the machine where development
  happens, a screenshot's `~t=8f3a2c` is a complete bug report: the agent
  reads the id off the pixels and curls the trace. The reporter operates
  nothing.

The export surfaces are the loud path's siblings: every terminal-rendered
error screen carries the same *copy this session* affordance (Sentry's
replay-on-the-error, done locally), and a chord (⌥ + triple-click the nav
strip, spelling adjustable) packages the current recording from any screen
— the silent stall's answer, and today's bugs were all silent.

## The trace

    {
      pins:     { app, irSha256, seed?, clock? },
      snapshot: { <table>: [rows...] , ... },
      inputs:   [ {at, type, from?, id?, values?, draw?, answer?} ... ]
    }

`pins.irSha256` makes replaying against a different emission a loud error,
never a quiet desync. gzip + base64url; a truco sitting compresses to a
few hundred bytes, a heavy session to tens of kilobytes — device-tier
scale, never megabytes, because inputs are cause and the DOM is derived.

## The loader, and replay-to-N

A boot mode (`?replay=<id|url>` or a file) seeds the store from `snapshot`
— fixture-mode: no Electric, no local factories, collections stand as the
trace says — then feeds `inputs` through the same dispatch paths under the
manual clock. `replay=...&to=N` stops after N inputs. The same loader runs
in the linkedom harness, which is where it earns its keep: an agent
replays a wedged session in milliseconds, dumps rows at any step, and
bisects the input list to the wedging event. Wedge detection is an
analysis over the trace — consecutive write sets compared across a replay
— in the tooling that reads traces, never a runtime ledger.

Time travel's interface can wait; replay-to-N in the harness is its core,
and a scrubber over N is an afternoon if it ever earns itself.

## The lifecycle is a machine too

The terminal's own mount → loading → empty/populated/gone progression is
already statechart-shaped — every screen declares its `states:` and styles
them per `data-state` — but it lives informally in `screen.js`, and its
contract went unverified until a probe raced the hydration window and found
truco's scoreboard ungated during loading. Formalizing it as a `#Machine`
the walker can cover is this doc's natural sibling, because the two compose:
**a replay drives the lifecycle machine through every arrow with the trace's
own inputs**, and per-state invariants become assertions the replay checks
at each step — nothing binds observably before `populated`; everything that
binds is covered by `loading`'s treatment; `gone` releases what `populated`
held. The walker, the differential, and the trace analyses then apply to
the terminal's own chart exactly as they apply to an app's — the machinery
verifying itself with the tools it gave the apps.

## Non-goals

- **No payload in the URL.** The hash carries a name; Godbolt's lesson
  stands, and the router owns the grammar.
- **No history entries per input** — `replaceState` only; the back button
  navigates the app, never the recording.
- **No production sink.** The `/traces` route exists only in the dev
  profile; a trace leaves the machine by a human's explicit act.
- **No output recording.** rrweb-style DOM capture records consequences at
  megabyte scale; this terminal re-derives consequences from cause.
- **No recording-driven wakes.** The recorder's table is invisible to app
  reads by construction.

## Ranked plan

1. **The recorder and the reserved table.** Inputs journaled at the
   dispatch seams, rolling snapshot on ring wrap. *Done when:* a truco
   sitting's full input history survives a reload in the device tier.
2. **Export surfaces.** `?trace=<id>` page, the error-screen affordance,
   the chord. *Done when:* a wedged screen hands over its own repro
   without devtools.
3. **The dev sink.** Debug-mode streaming, `GET /traces/<id>`, dev profile
   only. *Done when:* a screenshot's `~t=` id is curl-able on the dev
   machine with no human steps.
4. **The loader and replay-to-N**, in the terminal and the linkedom
   harness alike. *Done when:* one of this week's four traces (recreated)
   replays to its wedge in the harness and the wedging input is named by
   bisection.
5. **Trace analyses in tooling**: the settled-vs-wedged fold report, and
   conservation assertions (score delta = banner = stake; a fresh hand
   owns its log) runnable over any trace.
6. **The lifecycle machine**, formalized and walked (section above) —
   after the loader exists, since replay is what drives its arrows.
   *Done when:* the loading-coverage invariant is asserted per replayed
   step, and the ungated-scoreboard class is a finding, not a probe
   curiosity.

## Rules worth carrying

- **Determinism is an asset with dividends** — every fight for
  command-as-value was secretly buying this doc; collect on such
  investments deliberately.
- **Record cause, re-derive consequence.** The boundary rule prices the
  whole system: inputs are bytes, outputs are megabytes.
- **A name travels where a payload cannot** — through a URL bar, a
  screenshot, a human's short-term memory. Ship the pointer; keep the
  payload where it already lies.
- **Pin the emission or desync silently.** A replay without its ir sha is
  a different program wearing the same inputs.
