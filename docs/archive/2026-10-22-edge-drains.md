---
type: decision
title: "Drains where no stream runs: the cluster calls the function the change names"
description: The page's and the edge's clusters call an app's drains and sweep its schedules themselves — a trigger per named table, a one-second settle, the service role, a call after every boot in place of replay — resting on the drain contract's idempotence, with bloblang streams and computations left to the release's snapshot.
status: built
---

# Drains where no stream runs

The contract is in [pipelines and schedules](../pipelines-and-schedules.md#drains),
[release targets](../release-targets.md#pages) and mecha's
[drains and the clock](https://github.com/bonisoft3/mecha/blob/v0.17.1/docs/browser.md#drains-and-the-clock).
This record keeps why it is shaped so.

## The problem

The case was a downstream app with eight drains, three schedules and one
hatch, and nothing else that derives. On the container tier each drain is a
stream over the bus that POSTs `/rpc/<call>`. The page and the edge object run
no stream, so such an app was live there with its desk's requests never
applied, its boards never projected, and a midnight tick (the edge's alarm
wrote it since 0.17.0) read by nothing. The page also skipped the schedules
outright.

## The decision

Both clusters run the drains from what they already have: a `drain_notify`
trigger on each table a drain names, a listener that owes every drain naming
the changed table, one call per drain per one-second settle, as the service
role through the cluster's one serialized connection, and every drain called
after every boot. The page gains the clock the edge has, the ticker's sweep on a timer;
both share one module for it. The emitter writes the drain table into
`.pronto/cluster.json`, which the bundler and `edge.ts` read, so a release
evaluates no CUE for it.

It is sound because `#Drain` already demands it of every function: the call is
the whole job, an idempotent batch over an absolute read. A redelivery is
harmless, a lost notification is a delay until the next change, tick or boot,
and a failed call leaves its queue for the next one. The two obligations no
type states (progress when there is work, no write to one's own wake tables
when there is none) keep the loop finite, as they keep the stream's.

Bloblang is the limitation left: a stream's mapping, raw or derived, runs on
the container tier alone, and its rows reach the page and the edge as
`derived.ts` found them at release. So do a computation's, whose queries are
DuckDB's.

## Where the build departed from the proposal

- **The page too.** The proposal was the edge's. The page's cluster is the
  same PGlite behind the same kind of chain, so the dispatcher lives in
  mecha-browser and both import it.
- **The hatch is not logged.** The proposal turned the app's `notify` stream
  into a `console.log` of each reminder. Its mapping is bloblang, and writing
  the row in its place would be a second description of the same stream, so
  it stays a container-tier stream like any other.
- **No `statement_timeout`.** PGlite does not enforce one (0.5.8, measured:
  a 3 s sleep under 500 ms ran 3 s), so the drain's `timeout` is not set where
  nothing would honour it. The host bounds a call.
- **The table rides in `.pronto/cluster.json`, not `drains.json`**, the file
  that already carries what tools outside CUE read of the cluster.
- **The edge installs its drains on first use, not at boot.** A publish
  deploys the release's Worker before it migrates a kept directory, and a boot
  that installed the triggers refused `/import/migrate` over a table only that
  migration creates. A failed drain's retry runs inside the alarm that wakes
  for it, and a host that stops a cluster waits out a call or sweep under way.
- **A body key is an argument's name**, refused at `cue vet`: the calls spell
  it bare.
- **The schedule seed lost its fence.** It was fenced container-tier only
  because the page ran no clock. A seed is outside the ledger's digest check,
  so a kept edge directory is not refused for it.
- **croner 10.** The page's SES lockdown tames `toLocaleString`, through which
  croner 9 converted time zones, so every zoned schedule failed in a page with
  "Invalid time value". croner 10 reads `Intl.DateTimeFormat`. Its grammar
  is taken whole: `n/step`, which croner 9 read as n to the end of the field,
  is refused, by the ticker's own parser too.

## Alternatives

- **The outbox and Queue** as designed: replay of every change across
  evictions, the guarantee the contract makes unnecessary for a drain, at the
  price of a Queue per app. It stays the design for streams.
- **Wiring `packages/pipeline`** with its bloblang runtime: one description of
  a drain for every tier, at the cost of a bloblang runtime in the page and
  the Worker for a mapping that only restates `on`.
- **A Cron Trigger calling every drain each minute**: the interval timer the
  pipelines doc rejects, and five triggers per account on the Free plan.
- **Polling the shape log**: a second consumer of a log that retains 1,000
  changes, coupling the drains to Electric's retention.
- **DuckDB-wasm for computations**: 8 MB gzipped, measured, against a Worker's
  10 MB with PGlite beside it; feasible in a page alone, and not built.

## Verified

On the downstream app, generated by this tree, with `pages` added for the
page's checks:

- The container stack's own derivation of a fresh database (`derived.ts`) and
  the edge's boot over the same directory agree on all 17 derived tables,
  transaction ids aside.
- The built Worker under `wrangler dev`: a guest's desk request answered by
  `apply_ops` a settle after the write, no drain failing.
- The edge cluster over the built directory: a guest's enrollment placed in
  the seeded cohort, a reminder tick queueing its reminder.
- The bundled page in Chrome: a guest enrolled through the app's own screen
  and shown the seeded cohort and its next meeting; no console error once
  croner 10 replaced 9.

- Deployed to a test Worker on workers.dev, a fresh data directory: the publish's poke swept the three schedules without an error,
  a guest's desk request was answered within 2.5 s of the write, a guest's
  enrollment was placed and the cohort's indicator counted it, and 118
  invocations under `wrangler tail` ended `ok` with nothing logged.

Not verified: the Free plan's CPU limit against a drain over a real cohort;
the account is on Workers Paid.

Related: [[../pipelines-and-schedules]], [[../release-targets]],
[[../decisions/2026-10-03-external-effects]].
