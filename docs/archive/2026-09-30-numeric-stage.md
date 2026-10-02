---
type: decision
title: A numeric stage
description: A pronto rung for computation bloblang and Jessie cannot carry — a compute service fed by the lake, writing back through CRUD; proposed on JAX, revised to Jessie planning Wasm jobs on Deno.
status: built
---

# A numeric stage

## The gap

Pronto has two places a computation can run, and neither carries a numeric
workload. A pipeline's transform is bloblang inside Redpanda Connect: total and
lintable, but interpreted, with no seeded randomness and no arrays. A Jessie
module runs in the reader's tab (a handler) or inside a write (a validation):
fast enough, but in the wrong place for a number every reader must agree on.

golaberto measured the gap with upstream's own workloads:

| Workload | Upstream | Size | Jessie (SES) |
|---|---|---|---|
| A group's chances | Go `calculate_odds` | 20,000 Monte Carlo seasons × ~100 remaining games, re-sorted by the tie-break ladder | 0.75 s per group, bit-identical to V8 |
| Rare positions | Go `rare_position*.go`, ~22k lines | stratified and importance sampling for probabilities near 1e-14 | — |
| Team ratings | Go `spi()` | 100,000 fit iterations over a ~90k-game archive | hours |
| Player ratings | Rust `stats/` | a regression over every player-minute interval | hours |

Speed decides the second half of the table; placement decides the first. A
group's chances fit in a Jessie budget, but nothing server-side runs Jessie,
and computing them in every reader's tab would give every reader different
draws.

## The stage

A **compute service** in mecha, beside `transform` and `arroyo`: Python,
JAX on XLA, and DuckDB. A program names a JAX function and the lake tables it reads; the
emitter wires the rest, as it does for a pipeline.

- **Input, one kind: the lake.** A computation reads DuckDB, which answers in
  Arrow, and Arrow reaches JAX through numpy or DLPack with little or no copying.
  It runs when the lake commits a change to a table it reads (or on a ticker
  schedule, where the work is periodic), so its freshness is the lake's flush
  cadence: seconds to a minute. Nothing server-side needs better. A group's
  chances move only when a result is recorded, and upstream already treats them
  as a background job ("Atualizando chances…", a group's `odds_progress`);
  ratings are batch by nature.
- **The one sub-second number stays in the tab.** A game's chances as it is
  played ("Chances ao Vivo", ticking with the minute) are a pure function of the
  score, the minute and two scoring rates. That is a Jessie module over the
  game's row and the terminal's clock, not a server computation.
- **The lake.** Postgres to DuckLake through pg_duckpipe, the path mecha's
  spike proved (`@mecha/lake`'s provenance), published as catalog and Parquet.
  The browser already consumes it.
- **Output, one kind.** Every result is reverse-ETL'd through CRUD with an
  `on_conflict` upsert into a live, pipeline-written sink, so it keeps the
  policy path, the idempotence argument and the loop breaker every pipeline
  has. Nothing writes the store from the side.
- **Determinism.** Randomness arrives as an injected `PRNGKey`, as time and
  randomness arrive in Jessie, so a replay is the same draw.
- **Hosting.** A dedicated container. Postgres (plpython3u) would hold a
  backend for minutes and put XLA in the database's process; Conduit runs Go
  and WASM processors, not Python. Dapr is the wiring, not the host: it already
  carries the bus, and the service subscribes the way `transform` does.

## The browser tier

There is no JAX for WASM, and Pyodide cannot build jaxlib. The program's
artifact is therefore its **StableHLO export**, not its Python: XLA runs it in
the cluster, and IREE compiles the same StableHLO to WASM or WebGPU for the
tab. One program, one numeric semantics, every tier — the property pronto's
WASM rung already asks of an escape. The reviewable source stays the JAX
function; the export is emitted, like `program_cel.cue`.

## Alternatives

- **jax-js** (a JavaScript reimplementation of JAX's API over WASM/WebGPU):
  quicker to adopt in the tab, but a second implementation whose numbers can
  drift from XLA's, which the checks would then have to arbitrate.
- **Server-side Jessie** (a compartment in a pipeline worker): it would place
  the chances correctly and leaves ratings out of reach.
- **A second input from the bus**, reading rows over CRUD for freshness: no
  server-side number needs less than the lake's lag, and two inputs are two
  consistency models for one computation.
- **The computation in bloblang**: no seeded randomness, no arrays, and an
  interpreter two orders of magnitude slower than XLA.
- **A pre-compiled WASM escape per app**: pronto's existing rung. It works,
  but every app would bring its own numeric runtime, and the user's rule for
  golaberto is no escapes.

## Revision 2026-10-02: Jessie and Wasm on Deno

golaberto needs only upstream's own odds-rust, and that crate compiles to a
WASI module; the JAX port was a second implementation held to it
statistically. So the compute service is Deno: a computation is a Jessie
module whose queries read the lake through DuckDB, whose `plan` turns the
rows into Wasm jobs and whose `finish` turns the answers into sink rows, the
Jessie in a worker with no permissions and the jobs one at a time, as
upstream odds-rust calculates. DuckDB stays the one input, CRUD the one output.
JAX leaves the cluster, and with it the browser tier above: Wasm already runs
in a tab. The contract is stated in
[Pipelines and schedules](../pipelines-and-schedules.md#computations).

Argued and deferred, each until a program needs what it buys:

- **Python and JAX in the same service**, through FFI into libpython or a
  child process per job: the rung a numeric program with no Rust or C
  upstream would need, at the price of a second runtime in the image and a
  second determinism argument.
- **The lake as the bus**: computations reading and publishing through
  DuckLake alone, readers included. It would skip CRUD's write path, which is
  what keeps a sink on the policy path every pipeline takes.
- **Hermetic cached runs**: a run keyed by its module, its Wasm and its
  inputs' hash, its output reused across restarts and replicas. Today the
  fingerprint skips an unchanged run and a run is seconds.
- **Airport** (DuckDB over Arrow Flight): the lake served to and from other
  processes. Nothing outside the service reads it yet.

## Open

- The lake's publication cadence and the supervisor pg_duckpipe's workers need
  after a Postgres restart.
