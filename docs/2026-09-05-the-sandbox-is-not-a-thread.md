# The sandbox is not a thread

Design only — nothing here is built. This file has been rewritten twice, and
both rewrites were caused by the same mistake: assuming a property of a
boundary instead of measuring it. The first draft said a compartment was "the
wrong shape" for an engine, which was wrong because purity is satisfiable. The
second said a hatch lets the search leave the main thread, which is wrong
because it does not. The ground: `apps/chess` ir decisions 03 (a move is a
row), 08 (the house is a cast), 09 (the correctness authority is outside this
repository) and 22 (escape hatches: none);
`plugins/omnishell/interpreter/hatch.js`; `plugins/pronto/schema.cue`'s
`vendored` block.

Three claims, all measured. **A sandboxed iframe buys containment and no thread
whatsoever — the two are different boundaries and the hatch provides only the
first.** And **making Stockfish reproducible is configuration, not a patch: no
fork, no source edit.** And **the seat this wants is `worker`, which the schema
already names and the terminal already refuses at mount.**

## Facts not to re-derive

Measured on 2026-09-05, headless Chromium, this machine.

**Threading.** A 1.5 s busy loop, sampling the parent's main thread on a 20 ms
interval and recording the worst gap:

| Where the loop ran | Worst main-thread gap | Interval ticks |
| --- | --- | --- |
| The page itself | 1500 ms | 126 |
| **Sandboxed iframe** (`allow-scripts`, opaque origin, same site) | **1501 ms** | 51 |
| **Web Worker** | **24 ms** | 125 |

The iframe blocks the parent exactly as completely as running inline, and
starves the parent's own timers while doing it. Cross-*site* frames get their
own process under site isolation; a hatch's `src` is resolved against
`appBase`, so it is same-site by construction and shares the renderer.

**The engine.** `stockfish@18.0.8`, `stockfish-18-lite-single.wasm`
(single-threaded, 7,295,411 bytes), driven as a Worker.

- Boot to `uciok`: **142 ms**. **18 imports**, one minified namespace, and the
  list is enumerable via `WebAssembly.Module.imports` — the authority surface
  is auditable mechanically rather than by reading glue.
- **Full strength is reproducible.** Italian position
  (`r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4`) at
  `go nodes 300000`: `d2d3` from a cleared table, from a warm table, and from a
  freshly booted worker. At `go nodes 20000` with `ucinewgame` each time:
  `d2d3`, `d2d3`, `d2d3`.
- **The Elo dial is not.** `UCI_LimitStrength true`, `UCI_Elo 1500`, same
  position, `ucinewgame` before every run, one process: **`d1e2`, `d2d3`,
  `b1c3`, `b1c3`, `d2d3`** — five runs, three moves. `Skill::pick_best` holds a
  `static PRNG rng(now())`: clock-seeded, and static, so it carries state
  between searches too.
- **The transposition table changes the answer.** Kiwipete at `go nodes 60000`,
  then the Italian position at `go nodes 20000` with no `ucinewgame`: `b1c3`,
  where a clean table gives `d2d3`.
- **Timing.** `go nodes 20000` ≈ 38–51 ms; `go nodes 300000` ≈ 1.1 s.
- **`UCI_Elo` is calibrated at 120s+1s anchored to CCRL 40/4** — a claim about
  time-bounded play, in units a reproducible budget cannot use.
- A zero-import WASM export endowed into a `Compartment` is callable inside it
  while `WebAssembly` stays `undefined` there: the compartment gains the
  function, not the ability to make more. The endowment arrives **not** frozen;
  it would want `harden()`, as `jessie.js` already does for the fold role.

## Containment and threading are different boundaries

This is the finding worth carrying out of this document, because it is not what
the sandbox vocabulary suggests. `hatch.js` reasons carefully about *authority*
— `allow-same-origin` refused permanently, an opaque origin, `grants: []` — and
every word of that is right. None of it says anything about *scheduling*, and
the measurement above shows it delivers none.

So the boundaries are orthogonal:

- **iframe** — opaque origin, no storage, no cookies, no reach through
  `window.parent`. Same thread.
- **worker** — its own thread, no DOM. Same origin, so it keeps `fetch`,
  IndexedDB and the cache API.
- **compartment** — no ambient authority at all. Same thread.

Nothing in the platform currently offers both containment and a thread. The two
ways to get both are a Worker created *inside* a sandboxed frame from a `blob:`
URL, which inherits the opaque origin (and needs CORS on the engine assets,
because an opaque origin fetching them is cross-origin), or a worker seat that
the terminal owns.

## Why not a service worker

It is the intuitive next reach and it is worse than either option, on the axis
that matters:

- It is **same-origin and not sandboxed** — more authority than an iframe, not
  less.
- It can **intercept `fetch` for its whole scope**, which is a large grant to
  give several megabytes of unread machine code.
- The browser **kills and restarts it at will**; it is event-driven and not
  meant to hold long-lived state. An engine holding a position and a hash table
  is exactly the workload it is worst at.
- It **outlives the tab**.

Service workers are a caching primitive. Reaching for one here would trade the
only property the iframe actually delivers for a property it never lacked.

## What is settled

Recorded so the next reader does not reopen it:

- **Stockfish, not a hand-maintained engine.** Writing and tuning an engine is
  not this project's work.
- **7.3 MB is acceptable** as a build-time dependency, vendored and pinned. It
  ships as a static, so the app's "no network after its statics load" claim
  survives.
- **The engine is held as impure, and made as pure as it cheaply can be.** Not
  one route or the other: the containment story assumes nothing about the
  engine's behaviour, and the configuration is applied anyway because it costs
  a wrapper.

## Purity is configuration, and we take it anyway

Both sources of irreproducibility are switched off from **outside** the binary:

```
single-threaded build
setoption name Threads value 1
setoption name Hash value 16
never  setoption name UCI_LimitStrength      # the clock-seeded PRNG
ucinewgame          before every search      # the table across searches
go nodes N          never movetime
```

There is no patch and no fork — a wrapper that refuses to send one command and
insists on another. And the feature that would have needed a patch is the one
that does not survive our constraints anyway: `UCI_Elo` is calibrated against a
clock while a reproducible budget must be counted in nodes, so **the dial was
never transferable**. Dropping it costs nothing we could have had.

What the configuration costs, stated: `ucinewgame` every move throws the table
away, which is real playing strength; the node ladder is uncalibrated
(`go nodes 1000` gives `d2d4`, `20000` gives `d2d3`, and nobody knows what Elo
either rung is); and the reproducibility above is evidence from one machine,
one build and one position family, not a proof — WASM's own non-determinism
(NaN payloads, relaxed SIMD, `memory.grow`) is untouched by any setting.

## The four layers that carry safety

Unchanged by the threading result, because they were never about scheduling.
They are the same four for any untrusted oracle:

1. **The boundary is a parser.** `detail` matched against
   `/^[a-h][1-8][a-h][1-8][qrbn]?$/` and dropped otherwise. Never interpreted.
2. **Validated against the trusted side's own answers.** The move is looked up
   in `Legal`, so the engine is trusted for *preference* and never for
   *possibility* — it cannot express an illegal move because no row exists for
   one. Free here; decision-03 does the work.
3. **Epoched.** An async oracle answers late, twice, or about a position that
   has moved on. The answer carries the ply it was asked about and is discarded
   unless that position still stands. This is the one most likely to bite.
4. **Never load-bearing.** No answer, wedged unit, missing asset — the existing
   alpha-beta plays. Availability of an untrusted component must not become a
   correctness dependency.

## Recording is a handler, not a second mechanism

The engine's move reaches the reduce as an **event**, never as a call the
reduce makes — a pure function must not call the impure component; the impure
component must deliver a value to it. The reduce cannot reach the unit, so the
shape is enforced rather than promised.

The useful framing is effect handlers: the referee *performs* "choose a move
here, with this budget", and a handler decides what that means — ask the engine
when live, read the `Move` row when replaying, read a fixture under test. One
program, three handlers. Recording then stops being a rival to reproducibility
and becomes one of them, which is why this document no longer argues between
two routes.

Content-addressed memoisation is the same idea taken one step: key the answer
by `hash(fen, budget, build)`, and a hit *is* a replay while a miss *is* a
call — one table rather than two concepts, which suits a tree where derived
facts are already rows.

## An oracle is a source, not an operator

The reason to keep the engine outside the reduce is not only replay. It is that
`decision-04` recomputes derived tables **absolutely** and writes them
differentially — full recompute, then diff — and the obvious future for that is
the opposite: compute the delta from the input delta and never recompute the
whole. That is incremental view maintenance, and the modern statements of it
(DBSP/Feldera, differential dataflow, and the client-side engines the local-first
world is now shipping) all rest on the same precondition: **an operator must be
a deterministic function of its inputs.** An operator you cannot recompute is
one you cannot maintain incrementally.

Which settles where an impure oracle may sit. It may be a **source** in the
graph — data arriving at the edge, no different from a reader's click — and it
may never be an **operator** inside it. Endowing the engine into the reduce
would make an operator depend on something that is not its input rows, and
would quietly cost the tree the option of ever incrementalising that operator.
Taking the engine's move as an event and recording it as a `Move` row keeps
every operator pure, so the option survives.

For chess this is free: sixty-four squares and thirty-two pieces recompute in
microseconds, and `decision-07` already notes the absolute recompute only bites
at a server tier where a derived set grows without bound. The point is not that
this app needs IVM. It is that the containment decision and the incrementality
decision turn out to be the same decision, and taking the engine as a source
is what keeps both open.

## What it costs to build

- **Worker isolation in the terminal.** The schema declares
  `isolation: "compartment" | "iframe" | "worker"`; omnishell offers
  `["compartment", "iframe"]`; `mountHatch` throws for `worker` rather than
  quietly substituting a boundary. The gap was anticipated and named.
- **A second hatch event name**, which closes the Q4 the mount site records:
  *"one request-shaped return value is not a vocabulary"*. A move is the second
  name, and it forces the two questions `height` never had to answer — who
  receives it, and what it may say.
- **Four deferrals get their first consumer at once**: `vendored`'s ir kind,
  `isolation`, the transports, and the event vocabulary. That argues for
  landing the worker seat and the return path on their own, with tests and no
  consumer, before chess declares anything.
- **decision-22 changes** from *escape hatches: none* to declaring one, with
  its own note. The ir is where that argument lives.

## Still open

- Whether the unit is a plain same-origin worker (a thread, no CORS, the native
  shape for `stockfish.js`) or a worker inside a sandboxed frame (containment
  too, at the cost of CORS and blob plumbing). `hatch.js` justifies its sandbox
  by what an *embed* renders — "a provider's page, arriving over the network at
  read time, unreviewable by anyone" — and a hash-pinned binary vendored at
  build time is a different risk class. Inheriting the embed threat model
  should be a decision, not an inheritance.
- What each node budget is worth in Elo. Owed regardless, and the same bench
  would measure the cast we already have — which is the only evidence that says
  whether the engine is needed at all.

## Rules worth carrying

- **Measure a boundary's properties; do not infer them from its vocabulary.**
  "Sandbox" is about authority and says nothing about scheduling. Two rewrites
  of this file came from assuming otherwise.
- Ask whether an impure component's impurity is *separable* before assuming a
  fork. Both of Stockfish's were switched off from outside the binary, and the
  gap between "configuration" and "fork" is the gap between a wrapper and a
  standing commitment.
- When a component's nondeterministic feature is also its most attractive one,
  check that the feature survives your other constraints before paying for it.
- An impure result becomes pure the moment it is recorded — and recording is
  best understood as one handler among several, not as a fallback.
- Untrusted strength is safe where the trusted side owns the set of legal
  answers. If a unit's output must be *interpreted* rather than *looked up*,
  the boundary is in the wrong place.
