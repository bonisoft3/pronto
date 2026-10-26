---
type: concept
title: Pipelines and schedules
description: How a derived entity is kept from another's changes — a pure transform over an absolute read, delivered at least once into an idempotent sink — the shapes a program declares, when a value earns one, how a database function is called when its tables change, and how periodic work becomes rows.
---

# Pipelines and schedules

A pipeline keeps a derived entity from the changes of another. It hears a
change to one `server` entity, re-reads what it needs from that table, runs a
pure transform and upserts the sink. Delivery is at least once, so the sink
must be idempotent, and it is, because the read is absolute: a redelivered
change recomputes the same rows. Periodic work is a schedule, an occurrence
the cluster's clock turns into a row a pipeline hears. The declarations are
[the guide's](../GUIDE.md#schedules); the bus under the pipelines is mecha's
[change capture](https://github.com/bonisoft3/mecha/blob/v0.17.1/docs/change-capture.md); the clock is
the [ticker's contract](https://github.com/bonisoft3/mecha/blob/v0.17.1/services/ticker/README.md).

## When a value earns a pipeline

A derived value is a live query until it earns materialization by
[`pipeline-designer`](../agents/pipeline-designer.md)'s rule, which also says
what a materialized one is made of. A value over rows the reader cannot see is
the other case, and its answer is a per-reader pair
([access](access.md#a-count-the-reader-is-inside-of)). A sink's derived
`writers` names its pipeline, which nothing enforces
([pending](../PENDING.md#the-lattice)).

## The shapes

Four are `#Pipeline`s, one a `#DuckStreamPipeline`, one a `#Drain` and one a `#Schedule`, all in [`schema.cue`](../schema.cue):

- **A DuckStream pipeline** (`#DuckStreamPipeline`): continuous streaming incremental view maintenance over local or replicated sources.
  - `tempo: *"hot" | "cold"`: `hot` runs sub-second DBSP differential circuits on the server and reactive DuckDB-WASM in the browser for active screens and running counters. `cold` flushes batched partitions into lake storage.
  - **Static loop proof**: CUE statically proves that no screen mutates entity $E$ (`forms`) while reading a cold pipeline whose sources include $E$ (`_hotViolations`), refusing broken UI feedback loops at compile time.
  - **Operator endowments**: advanced relational operators (`tumble`, `hop`, `session`, `distinct`, `cross_join`, `interval_join`) are declared in `operators` and checked against DuckDB's parsed AST at lint time. Windowing operators require `tempo: "cold"`.
- **A CDC pipeline** (`trigger: "cdc"`, the default): `from`, `to`, a consumer
  `group`, and a `transform` whose `aggregate` is the PostgREST query it reads
  and whose bloblang is the mapping. Without `key` it emits one sink row; with
  `key` it groups and emits an array, upserted on the sink's primary key.
- **A fold**: the browser side of a keyed transform written as `empty`,
  `step`, `combine` and `result`. Two laws no type states: `combine` is
  associative with `empty` as identity, and the accumulator is the sink row,
  so an average stores sum and count rather than the quotient. It names the
  sink column the terminal re-projects optimistically (`projects`), the newest
  source txid the sink's read covered (`watermark`), the columns of one
  contribution (`dedupe`), the source column that retracts one (`retracted`)
  and the private `pair` table it writes for the acting reader
  ([access](access.md#a-count-the-reader-is-inside-of)). The container keeps
  its bloblang.
- **A raw stream**: the whole rpk YAML under `pipelines/`, copied verbatim.
  It is a hatch with a required non-empty `note` and unspecified delivery.
  The emitter cannot inspect its writes, so loop prevention is the author's.
- **A scheduled pipeline** (`trigger: "schedule"`): every `interval`, delete
  or patch the sink rows a filter matches, with `{cutoff}` (now minus
  `window`) and `{nowts}` resolved at run time. It is level-triggered, for work whose job is
  to make a predicate false repeatedly — retention, expiry — and needs no
  identity, watermark or lateness.
- **A drain** (`#Drain`, [below](#drains)): a database function called
  when the tables it reads change, for work the database already does in
  SQL — a queue drained in batches, or a projection recomputed whole.
- **A schedule** (`#Schedule`, below): an occurrence with an identity, for
  work owed at an instant.

## What the cluster runs

Each CDC pipeline is emitted as `docker/<app>-<name>.yaml` for Redpanda
Connect. It reads the `cdc-events` stream in its own consumer group
and drops a malformed message before paying for a fetch. It converts the bus
row to canonical form and fetches the absolute aggregate from PostgREST
directly, never through the door, whose `Prefer` injection would clobber the
sink's `resolution=merge-duplicates`. It runs the mapping and posts the result
with `on_conflict` on the sink key. A mapping that throws is logged with the
pipeline's name and the message dropped, because the next change for that key
repairs the sink; the post itself is retried with backoff.

Every stream reads the whole bus and selects its dependencies. The default publication
includes all application entities stored on the server, including pipeline,
computation and schedule outputs: a derived table can be another consumer's
input. Browser durability and writer declarations do not suppress CDC. There
is no general cycle analysis yet; feedback must converge under the consumer's
own guards. Every cluster table is `REPLICA IDENTITY FULL`, so a delete carries
the row a keyed transform needs to recount its group to zero.

An existing database must migrate its publication membership when adopting
this policy; changing the generated initdb file alone does not update a volume.
An assembly app can narrow both the publication and Conduit's table list through
its existing migration and `cluster.meta.conduitTemplate` seams. GolAberto's
`apps/golaberto/cdc.cue` does this for its known dependency graph;
request-time views and final projections are absent from its backend feed.

## Drains

A `#Drain` names the tables that wake it (`on`), the function it calls
(`call`, a PostgREST RPC as the service role) and the JSON `body` of every
call. The emitter writes it as a stream beside the pipelines', which wakes
on two things alone: a bus row from one of its tables, and the stream's start
(rows queued while nothing listened). Whatever arrives within a second of the
first wake is one call. There is no interval, and an idle stack calls nothing.
A function whose answer moves with the date names a [schedule](#schedules)'s
tick entity in `on`, and each tick is a row that wakes it: GolAberto's
midnights are two schedules emitting into one `DayTick`, which three drains
read. The clock is the cluster's one clock, never the drain's.

The function owns the batching. A queue drain deletes the rows it finished,
and those deletes are change events on its own table, so the drain wakes again
while work remains; the call that finds none changes nothing and the stream
sleeps. That makes two obligations no type states: a call must make progress
when there is work (one that returns with rows left and none touched is never
woken for them), and a call with nothing to do must write nothing to its own
`on` tables, or it never sleeps. A function that recomputes a projection
whole names its sources in `on`, and must not name its sink.

Every `on` table must be in the publication. The default publication carries
every `server` entity; a queue table the app creates in its own SQL, or any
table an app's narrowed publication leaves out, is the app's to add. Conduit
keys each event by a single-column primary key and will not start over a
table whose key is composite, so a queue keyed on a pair takes a generated
key beside it.
GolAberto's `apps/golaberto/cdc.cue` adds its drains' tables to
its feed and nowhere else: Electric's publication and the tables' policies
are untouched.

Where no stream runs, at `pages` and `cloudflare`, the cluster calls the
drains itself from the table the emitter writes into `.pronto/cluster.json`:
a trigger on each `on` table, the same one-second batch, every drain called
once as the cluster installs them in place of the stream's start, and a failed call retried after
a backoff rather than redelivered
([mecha's dispatcher](https://github.com/bonisoft3/mecha/blob/v0.17.1/docs/browser.md#drains-and-the-clock)).
No publication is involved, so a table outside it wakes the drain there too.
The two obligations above are what keep that loop finite, as they keep the
stream's. PGlite enforces no `statement_timeout`, so `timeout` bounds a call
on the container tier alone.

## Below the cluster

The browser cluster a page boots serves CRUD and shapes, calls the drains and
sweeps the schedules ([drains](#drains)), and runs no stream: a stream's
mapping is bloblang. A transform's `shim` and a fold's module are emitted into
the app, and nothing in the page executes either: `evaluateFold` in omnishell's `jessie.js` has no
caller. What the terminal does run, at every tier, is the projection of a fold
sink: `others + intent` over the synced sink and pair, where `intent` counts a
row unless it is retracted. It never calls `step`, `combine` or `result`, so it
projects counts and nothing else, and a fold that is not a count projects
wrong. A sink in a page holds its seed rows and no more
([pending](../PENDING.md#pipelines-and-schedules)).

## Schedules

A `#Schedule` names a five-field `cron`, a `timeZone` (UTC unless stated),
`maxLatenessSeconds` (at least 60), `concurrency` (`Allow`, or `Forbid` with a
`done` entity and filter) and what each tick sets on the `emits` entity. The
tick table carries the five columns in `#tickFields`, which the ticker writes
last so no declared value overwrites them. How a tick is keyed, when it is
late, how the ticker wakes the change-capture unit and why a tick needs no
durability are the [ticker's](https://github.com/bonisoft3/mecha/blob/v0.17.1/services/ticker/README.md).

What the emitter holds, at `cue vet`:

- **`emits` is a `server` entity**, because only the publication can carry a
  tick to a pipeline.
- **`done` is a different entity, and `live`**, because the pipeline reading
  the tick table cannot answer into it without feeding itself.
- **What a release target owes a schedule** is
  [release targets'](release-targets.md#what-a-release-is).

The `schedule` table is mecha's: the cluster is handed the schedules' names,
and its database image creates the table as `800_schedule.sql`
([mecha's schema](https://github.com/bonisoft3/mecha/blob/v0.17.1/docs/schema.md#how-a-schema-reaches-the-database)),
with a ticker and a clock beside it. The emitter seeds it in
`801_schedule_seed.sql`, by an upsert on the name, and the table's `CHECK`
refuses a `Forbid` without `done` in the row itself. Both are initdb steps,
so they run only on a volume initdb builds: a schedule declared, changed or
dropped later reaches no existing volume, and the tick entity's table needs
the app's own migration there. A cluster that declares a schedule over a
volume without the `schedule` table fails at migrate rather than never
ticking ([pending](../PENDING.md#pipelines-and-schedules)).

## Computations

A value no pure transform over one change can compute — a season simulated
twenty thousand times, a rating refit over a decade — is a computation
([the numeric stage](archive/2026-09-30-numeric-stage.md)). A `#Computation`
names its module (`src`, `computations/<name>.js` unless stated), the `live`
entities it alone writes (`to`) and the committed Wasm modules its jobs call
(`wasm`). mecha's compute service
runs it; [its header](https://github.com/bonisoft3/mecha/blob/v0.17.1/services/compute/main.ts) is the
contract, from the lake snapshot to the writes. The module is one file that
imports nothing, and exports exactly four names:

- `reads`, the tables whose change reruns it;
- `queries`, `{name: SQL}` over those tables, each answering plain rows;
- `plan(inputs, seed, outputs)`, the Wasm jobs, asked again with the answers
  until it adds none;
- `finish(inputs, outputs)`, `{sink table: rows}`, each the sink's whole
  content.

Optional `onComplete` names a no-argument CRUD RPC called as the service role
after every sink write succeeds. It must match `^[a-z_][a-z0-9_]{0,62}$`.
The RPC must be idempotent: a failed call leaves the run retryable, and retry
can invoke it after the sink rows have already committed. A redelivery can
call it again even when the output rows are unchanged.

The service refuses bootstrap until the source replication slot has reached
its initial consistent point. It then runs every computation once and takes CDC deliveries
through a framework-owned Redpanda Connect stream. Its Redis consumer group
acknowledges only after successful HTTP completion. A stable consumer identity
recovers pending deliveries on restart. Each delivery selects computations
whose `reads` include the changed table, takes fresh inputs and runs them
sequentially. PostgreSQL statistics are not a freshness gate.
Each pure computation retains only its last query inputs and answer. Structurally
equal fresh query results reuse that answer; publication and completion hooks
still run. Changed inputs recompute, and failed reads never use the retained answer.

Only one compute process is supported. Snapshot capture, calculation, sink
writes and completion hooks share a single execution slot. Overlapping HTTP
requests receive a retryable response; pending work stays in Redis. A failure
exits the service and the unacknowledged delivery is replayed after restart.
This is at-least-once recomputation, without LSN fencing or atomic publication
across sink tables. There is no timed accumulation window; each relevant event
can cause a full recomputation. Concurrent writers or replicas require a
stronger publication protocol.

Its language is the header's: ES module text as the service's SES Compartment
admits it, which is narrower than ECMAScript — `while (n --> 0)`, the text
`eval(` in a string, and top-level await are each refused — without the
clock, randomness, time zone and locale. `endowments` grants it what it names
of `Crypto` (WebCrypto's deterministic-by-specification subset),
`TextEncoder`, `TextDecoder`, `URL` and `URLSearchParams`, as a surface module
is granted `Intl`; an undeclared one throws where it is reached.

What pronto holds: write fails on a module or Wasm file that is not there; the
module joins the fact rows as the `computation` role, so `lint` reports a
denied identifier in it as in a handler, its declared endowments excepted (a scan, not a Jessie parser); `lint`
loads each module as the service loads it at startup, so one the service would
refuse fails there, naming its file and SES's rule, rather than taking the
service down; and `test` runs the app's `computations/` tests under the
service's own pins, the module in the same cage and the jobs on the same Wasm.

## Rejected

- **Materializing every derived value** — a live query over rows the reader
  can see is instant and exact, with no sink and no lag.
- **Incremental arithmetic in the sink** — under at-least-once delivery a
  redelivered delta counts twice; an absolute read makes the redelivery
  harmless.
- **Reading the source through the door** — its `Prefer` injection clobbers
  the sink's merge resolution.
- **A shim for a fold** — rows in, one row on `id` out cannot state a keyed
  aggregate.
- **The fold's JavaScript in the container stream** — rpk can run it, but
  nothing lints JavaScript inside a pipeline's YAML, where
  `redpanda-connect lint` catches a broken mapping. Convert a container
  transform only where two expressions of one aggregate could diverge.
- **An interval timer for a drain** — it calls an idle stack forever, and
  its period is the latency of every edit; the change feed already knows when
  there is work.
- **The tick and its outcome in one table** — the tick table is a change
  source, and a pipeline writing it back feeds itself.
- **A scheduled pipeline for work owed at an instant, or a schedule for a
  predicate** — an occurrence can be missed and fires once; a level can be
  re-asserted and has no identity. Each is the other's wrong tool.
