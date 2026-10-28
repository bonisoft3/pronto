---
type: decision
title: "Hybrid machines: omnishell, mecha, duckstream and cortex"
description: Extending unbreakable statecharts to the backend — splitting client UI, relational transactions, streaming IVM / lake compute, and durable Level 4 orchestration into four pure-to-external tiers.
status: partially-built
---

# Hybrid machines: omnishell, mecha, duckstream and cortex

The unbreakable machine of [machines.md](https://github.com/bonisoft3/omnishell/blob/v0.19.1/docs/machines.md) was designed
for the browser: a chart closed over one row whose transitions emit typed effects the
terminal executes and answers. A backend architecture designed from the cluster
side arrived at the same four laws: state is a row, operators are pure
functions of rows, impure things are sources, and every decision carries a version frontier.

This decision unifies them into one XState-JSON machine model partitioned into four tiers:
**omnishell**, **mecha**, **duckstream**, and **cortex**.

## The Four Tiers

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Cortex Machine                                  │
│     Coordinates every tier; the only tier performing Level 4 effects   │
│     (Graphile Worker over PostgreSQL; ledger owned by pronto)          │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
         ┌─────────────────────────┼──────────────────────────┐
         ▼                         ▼                          ▼
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────────┐
│ Omnishell        │     │ Mecha            │     │ DuckStream           │
│ Browser UI, DOM  │     │ Relational core  │     │ Server: Feldera DBSP │
│ Max: Level 2     │     │ Max: Level 3     │     │ Lake: Parquet/Arrow  │
│ (Compensable)    │     │ (Replicated)     │     │ Browser: DuckDB-WASM │
└──────────────────┘     └──────────────────┘     └──────────────────────┘
```

The division enforces that **only Cortex may perform Level 4 (external) effects**. The other
three tiers are mathematically pure, closed over rows, and replayable.

| Machine | Closed Over | Max Effect Level | Determinism & Replay |
|---|---|---|---|
| **Omnishell** | `tab` or `device` row in client memory | **Level 2** (compensable) | Walked by Chinese Postman tour; posed by Storybook battery |
| **Mecha** | `server` entity row in PostgreSQL | **Level 3** (replicated) | ACID transaction; rolled back natively on error |
| **DuckStream** | Pipeline state or lake catalog row | **Level 3** (lake/relational) | `delta ≡ recompute`; Feldera continuous circuits on server, DuckDB-WASM reactive recompute in browser |
| **Cortex** | The coordination's states; for an external effect, its row in `external_effect_ledger` | **Level 4** (external) | Performed through mecha's airlock; the ledger claims in the transition's commit, before any call |

---

## 1. Omnishell Machines (Client UI)

*Specification: [`machine.cue`](https://github.com/bonisoft3/omnishell/blob/v0.19.1/machine.cue).*

- **Role**: Drives interactive DOM regions, form submissions, optimistic screen state,
  and keyboard/focus navigation.
- **Inbound Events**: DOM gestures (`click`, `submit`, `drag`, `<type>@<dom-id>`),
  terminal timers (`after`), and synthetic store answers (`sync_ack`, `refused`).
- **Outbound Effects**: Ephemeral assigns and optimistic mutations (`create`, `update`,
  `delete`, `upsert`) on `tab` or `device` entities. Level ≤ 2.
- **Contract**: Closed over `{items: [row]}`. No ambient IO. A store refusal drops the
  optimistic row and returns through `refused`.

---

## 2. Mecha Machines (Relational Core & Transactions)

- **Role**: Statecharts executed inside PostgreSQL — transactions, trigger reducers,
  timed turn deadlines, and ticker-driven schedules.
- **Inbound Events**:
  - `mutation`: Relational write (`INSERT`, `UPDATE`, `DELETE`) on a floored table.
  - `after`: Relative timer deadline on an active state (`after: 15s`), evaluated
    against row timestamp bounds under PostgreSQL role timeouts.
  - `schedule`: Scheduled calendar/interval wake emitted by Mecha's ticker
    (`020_schedule.sql`; the same table opens `012_airlock.sql` where an effect is
    declared, so the airlock's wake is a one-shot row of it).
- **Outbound Effects**:
  - Closed relational operations (`#RelationalOp`, the terminal's `#Machine.#MutationOp`
    narrowed to what the trigger performs):
    - `create`: Strict append (`INSERT INTO ...`). Fails loudly on unique collision.
    - `ensure`: Idempotent insert (`INSERT ... ON CONFLICT DO NOTHING`). Inserts if absent,
      no-op if existing.
    - `upsert`: State replacement (`INSERT ... ON CONFLICT (key) DO UPDATE SET ... = EXCLUDED...`).
    - `accumulate`: Delta accumulation (`INSERT ... ON CONFLICT (key) DO UPDATE SET col = col + EXCLUDED.col`).
    - `update`: Absolute update (`UPDATE ... SET ... WHERE ...`), the rows `where`/`rawWhere`
      name, else the row the values' key names, else every row.
    - `delete`: Row deletion (`DELETE FROM ... WHERE ...`).
  - Domain functions:
    - `call`: Parameterized execution of declared, schema-vetted PL/pgSQL functions.
  - Cluster notifications:
    - `notify`: Transactional `pg_notify` to wake local daemons (PostgREST reload, ticker).
- **Contract**: Strictly Level 3. Single database transaction boundary. Zero external
  network calls. All statements bounded by role-level PostgreSQL timeouts
  (`statement_timeout = '5s'`).

---

## 3. DuckStream Machines (Streaming IVM & Lake Compute)

- **Role**: High-throughput streaming joins and window aggregations via **Feldera (DBSP)**
  on the server paired with **DuckLake / DuckDB** for batch matrix derivations, and emulated
  reactively in the browser via **DuckDB-WASM**.
- **Server Tier (Feldera DBSP in Docker)**:
  - Consumes PostgreSQL logical replication / WAL (via Debezium, Conduit, or direct PG CDC).
  - Feldera's Calcite compiler compiles SQL continuous queries into native Rust DBSP circuits
    inside containerized environments. No local Rust toolchain or native Windows binaries needed.
  - Provably satisfies $\text{Delta} \equiv \text{Recompute}$ across full CDC changelogs
    (inserts, updates with before-images, retractions).
  - Emits maintained operational views back to PostgreSQL and flushes columnar Parquet
    partitions into DuckLake.
- **Client Tier Emulation (DuckDB-WASM)**:
  - Feldera circuits cannot run natively in single-threaded browser JS.
  - The client emulates streaming IVM by exploiting the identity $\text{Delta} \equiv \text{Recompute}$
    over bounded client datasets (<50,000 rows):
    Whenever the local sync engine (Electric/pg-sync) pulls change sets into local Arrow tables,
    **DuckDB-WASM** reactively re-evaluates the view query in 1–5ms inside a WebWorker.
  - Zero need for homebrewed polyglot JavaScript SQL engines or `d2ts` compilers: DuckDB-WASM
    executes standard SQL directly over local Apache Arrow memory.
- **Inbound Events**:
  - `DIFF_BATCH`: Inbound changes from Postgres WAL (`insert`, `update` with before-image,
    `delete`).
  - `WATERMARK_ADVANCED`: Monotone watermark reached a window boundary (LSN / commit timestamp).
  - `WINDOW_CLOSED`: Interval or tumbling window ready for consolidation.
  - `LAKE_PARTITION_READY`: New Parquet files flushed to DuckLake.
  - `JAX_BATCH_DONE` / `JAX_BATCH_FAILED`: Python subprocess completed tensor computation.
- **Outbound Effects**:
  - `DBSP_STEP`: Differential circuit step emitting incremental changelog deltas.
  - `SYNC_TO_POSTGRES`: Flush maintained view rows back to PostgreSQL.
  - `PUBLISH_PARQUET`: Append partition to DuckLake directory.
  - `ATTACH_DUCKLAKE`: Mount Parquet dataset in DuckDB.
  - `DISPATCH_JAX_SUBPROCESS`: Execute deterministic matrix kernel (e.g. TF-IDF) over Arrow IPC.
- **State Eviction & Watermarks**:
  - Unbounded stream-stream joins are forbidden; joins must be **interval joins**
    (`c.time BETWEEN i.time AND i.time + INTERVAL '10' MINUTE`) or **temporal joins**
    (`FOR SYSTEM_TIME AS OF`).
  - Watermarks are driven strictly by the **database commit timestamp / LSN**, never wall
    clock. Consumer lag delays output but preserves 100% calculation correctness.

---

## 4. Cortex (Coordination and Level 4 External Effects)

Cortex coordinates across every tier, on both the pure and the impure side: frontend
handlers and their effects, mecha transitions, DuckStream pipelines and the compute nodes
attached to them, and the external effects only it may perform. A state invokes another
tier's actor and answers to its outcome. A saga is such a coordination, with states that
invoke effects and states that invoke their compensations.

External effects are the first part built: a mecha state *invokes* one, the interpreter claims
a ledger row in the transition's commit, mecha's airlock performs it against one declared
sink through that sink's Dapr binding, and the outcome returns through the interpreter.
[External effects](2026-10-03-external-effects.md) holds the grammar, the ledger and
the measurements that rejected DBOS as the runtime.

### Composition: one machine per domain, Cortex across them

Each runtime's machine is expressed in its own vocabulary, in its own package,
and expresses everything that runtime does: `omnishell.#Machine` (the terminal's,
in `plugins/omnishell`), `mecha.#Machine` (in `libraries/mecha`, re-exported by
Pronto as `clusters:mecha` already re-exports the cluster), and
`#CortexMachine`, Pronto's, the only one that spans tiers. A tier-specific
vocabulary never learns about the other tier; a chart that crosses is Cortex's,
and the compiler projects it into each tier's machine and the protocol between
them. Dependencies point from Pronto to Omnishell and Mecha, never back: Cortex's
browser runtime is Pronto's, emitted into the app, and a tier knows nothing of
Cortex.

Cortex uses XState's invocation semantics rather than another orchestration
language: `invoke.src`, explicit `input`, child output, `onDone` and `onError`;
children start on state entry and stop on exit (upstream
[invocation](https://stately.ai/docs/invoke) and
[output](https://stately.ai/docs/output)). Stopping a browser child stops
observation, polling and local presentation and discards late results, as
[promise actor cancellation](https://stately.ai/docs/promise-actors#stopping-promise-actors)
does. Neither rolls back a committed remote transition: leaving a Truco table
detaches while the authoritative match continues, and resignation is a domain
command. Cortex composes existing Mecha ports, transactional actions and
Airlock effects; it introduces no other lock, transaction, saga or delivery
implementation.

Today's reducer machine (`#MechaReducerMachine`, alias `#HybridMachine`) glues
both sides. Its tier-tagged events, typed state and per-viewer views, its
initializer and the choice of running it in PostgreSQL or the browser are
Cortex's; its locks, ports, `requires.sql`, relational actions and fuel are
Mecha's. Mecha also has the row machine (`#MechaMachine`: a column's value,
trigger dispatch, timers, Airlock invokes), a second dispatch model. And
Omnishell's `#Machine` cannot yet express Cortex's browser side: the session
and sync drivers are handwritten protocol code, `invoke` is refused, and
it has no typed document state or per-viewer projection for local placement.

Alternatives not taken:

- **Separate composition kinds** (a session, a command and a local form beside
  the parent). Each was an invoke in disguise, with its own lifetime rule; one
  `invoke` with `via` keeps the hierarchy in one chart and derives the lifetime.
- **`#MechaMachine` as a union of row and reducer forms.** One name over two
  dispatch models hides the difference the Truco adoption record calls
  decisive: dispatch by event, not by the destination value.
- **Naming the reducer a Mecha actor and keeping both.** Keeps the cross-tier
  half of the reducer in Mecha's vocabulary, which is the coupling this rule
  removes.

### A Mecha machine's surface is rows

A Cortex child that reaches Mecha talks to it through the store, never through
a driver. Every input the browser gives a Mecha machine is a row the terminal
writes, and everything it reads back is a row the terminal reads, so the
terminal's replay covers the online game as it covers the local one. The
session and command drivers, their polling, their `sessionStorage` and their
`crypto.randomUUID()` were the protocol the store already implements: keyed,
idempotent writes with an outbox; a 4xx as a `refused` event; live reads.

For a machine `m`, the compiler derives its surface as entities:

| Entity | Durability, access | Written by | Replaces |
| --- | --- | --- | --- |
| `m_seat` | `live`, private to `actor` | dispatch, after every accepted step | the `view` table and the `_view`/`_sync` RPCs |
| `m_command` | `live`, private to `actor`, insert-only | the browser; an `AFTER INSERT` trigger dispatches it and stamps the receipt on the row | the `_command` RPC and the receipt table |
| `m_open` | `live`, private to `actor`, insert-only | the browser; its trigger runs the admission or join | the admission and join RPCs |
| `m_public` | `live`, public | dispatch, from the rules' public projection | the session port's composed `select` |

A command's id is derived from what it says (`instance/revision/kind`), as the
arena's intents are, so the same gesture twice is one row and a gesture on a
stale view is a stale-revision receipt, not a second effect. A domain refusal
is a receipt on the row; a protocol violation is a 4xx and arrives as
`refused`. Deadlines leave the client: a step that sets a machine's deadline
arms the ticker's `machine_timer_tick` row, so a timeout and a lapsed presence
lease fire on the server whether anyone polls or not.

A Cortex state is hosted by a screen: navigating to it mounts the child's
regions and leaving unmounts them, which is Cortex's lifetime rule, so the
parent's state is the terminal's navigation, which it already records and
replays. The child is a fold Pronto composes over the machine's declaration
([[../cortex|Cortex machines]]). A session's lease is renewed by a fold on the
terminal's clock, on a seat of its own, and lapses on the ticker when the
screen is gone.

Alternatives not taken:

- **Driver charts the terminal interprets, over the RPC ports.** Would keep a
  second protocol beside the store's, with its own retry, outbox and refusal
  path, and keep the browser polling.
- **Client-armed timeouts** (a fold writing a `wake` command at the deadline).
  A table nobody watches would never time out; the ticker already owns time
  for Mecha machines.
- **The parent as an `omnishell.#Machine` on a `tab` row**, its children under
  `data-when` on its phase. A terminal machine answers DOM events and reads
  fixed fields of them; a child's outcome and a gesture carrying a room are
  neither, and the screen a state lives on already says when it is entered.

Sequence, one transformation per change:

1. **Built.** `#CortexMachine` is the only Cortex form: a state invokes a Mecha
   machine `via` its session or sync ports or locally. Contract:
   [[../cortex|Cortex machines]].
2. **Built.** Local placement: Pronto emits a local child as a terminal
   handler, the app's Jessie module over the machine's own reducer, so its
   state is rows, its pauses the terminal's clock and its entropy a recorded
   draw. Truco's arena runs on it.
3. **Built.** A Mecha machine's surface is rows (above), on today's reducer:
   the surface entities, deadlines on the ticker, and Truco's bar and online
   table as markup over them. The drivers, the RPC ports and the `online` and
   `lobby` hatches are gone.
4. **One `mecha.#Machine` in Mecha's package, dispatching by event.** The
   schema moves to `libraries/mecha`, re-exported by `clusters:mecha`; the
   compilers stay in Pronto, as `#MachineTimersSql`'s consumers do. The row
   machine's lifecycle changes, timers and effect outcomes become events of
   one dispatch model; realworld's guard machine and the fixtures migrate.
5. **The domain chart moves into `#CortexMachine`** with tier-owned states; the
   compiler projects the Mecha part into `mecha.#Machine` and the same chart,
   projected for the terminal, is the arena's handler. `#MechaReducerMachine`
   and `#HybridMachine` go.

---

## 5. How Hybrid Machines Drive Cortex and DuckStream

Hybrid state machines in Pronto compile transitions that seamlessly trigger across tiers:

```
┌────────────────────────────────────────────────────────┐
│               #MechaMachine Transition                 │
│         (PostgreSQL BEFORE / AFTER Trigger)            │
└───────────┬────────────────────────────────┬───────────┘
            │                                │
     invoke                           #StreamEffect
            │                                │
            ▼                                ▼
┌────────────────────────┐      ┌────────────────────────┐
│     Cortex / Graphile  │      │       DuckStream       │
│  ledger claim + job    │      │  pg_notify stream bus  │
│  (Level-4 External)    │      │  (Feldera IVM circuit) │
└────────────────────────┘      └────────────────────────┘
```

1. **Driving Cortex from a machine state (`invoke`)**:
   A state invokes a declared external effect, and only its outcome leaves it:
   ```cue
   charging: invoke: {src: "charge", onDone: "settled", onError: "failed"}
   ```
   The interpreter claims a ledger row and enqueues a Graphile job in the transition's own
   commit; [external effects](2026-10-03-external-effects.md) has the rest.

2. **Driving DuckStream from a Machine Transition (`#StreamRaise`)**:
   When a machine executes state changes that feed analytical pipelines or require an explicit
   derivation sweep:
   ```cue
   actions: [{
       raise: {
           stream: "recount_ledger"
           signal: "refresh"
       }
   }]
   ```
   The compiler emits a signaling notification `pg_notify('duckstream_recount_ledger', ...)`
   or mutates source rows captured by Feldera's CDC connector.

---

## 6. As built, and what moves between tiers

One model holds across every tier: state is a row, operators are pure functions of rows,
every impure thing is a declared source or sink with a record, and the client reads live
queries and writes forms. What differs per tier is only how far from pure it may stray.

| Executor | Closed over | Level | Runs as | Status |
|---|---|---|---|---|
| Omnishell machine | a `tab`/`device` row in the client | 2 | the terminal: SES-caged Jessie, XState JSON | built |
| Mecha machine | a `server` row in Postgres | 3 | plpgsql interpreter or bounded SES reducer in PLV8, inside the transaction | built |
| Compute, whole-table | a snapshot of the tables it `reads` | 3 | Jessie planning WASI jobs over a DuckDB lake; woken by CDC invalidations through the change feed, batched and retried | built |
| Compute, per key | one changed row and its declared edges | 3 | the same cage, warm; Conduit → compute's own daprd over gRPC, no bus; a direct write | not built |
| Airlock | one ledger row per effect instance | 4 | Graphile Worker listening on `jobs:insert`, woken from zero by the ticker's one-shot row; one declared Dapr binding per effect; bridges for what is not HTTP | built ([external effects](2026-10-03-external-effects.md)) |
| DuckStream | a pipeline or lake row, with history | 3 | Feldera on the feed, DuckDB-WASM in the page | grammar and static checks only; no executor |
| Cortex | a composition of tier-owned actors and browser interaction state | up to 4 | screens whose folds reach Mecha machines through their surface rows; external effects through Airlock | screen-hosted session, sync and local children built; tier-owned states, nested hierarchy and parallel regions unbuilt |

**Effects and hatches.** Levels 1–3 stay inside time travel: an assign, a relational effect
and a compute output all replay from rows. Level 4 is the airlock, and the airlock is a
hatch: one of the places where perfect time travel stops, beside the compiler's `sql`,
`proto` and `container` hatches, each with its own declaration and its own record. The
airlock's record is the ledger, so a replay answers the invoke from it instead of
re-running the world; `reentry: "repeat"` is a hatch inside the hatch, its `note` the why. Saga-style
resilience comes from the statechart and the ledger, not from a durable function: a
state invokes one effect, the interpreter claims and enqueues in the transition's commit, the
sink declares idempotency or its re-entry, the outcome returns as the next event, and a
compensation is another invoking state. Only an effect handler holds a sink; every other
module has the language plus declared endowments, lint-checked per role across omnishell
and mecha.

**Data transport is IVM-centric.** Down: Postgres → Electric shapes → the terminal's live
queries, recomputed absolutely and written differentially. Up: forms → crud → Postgres,
where machines and validations run in the write. Across: WAL → Conduit → Dapr → Redis
Streams → pipelines and compute, at-least-once. Compute comes in three kinds by the shape
of its input: whole-table (built, above), per key for user-facing latency (tens of
milliseconds; not built), and analytical over the stream with history, where durability
is the point because history is the input (DuckStream). Feldera's place is the third
kind, not a trigger for the first two. A client-side differential engine (`d2ts`) is
named in the seams below and is not in the tree. Truco's online path writes
command and admission rows and reads its private seats live; it does not
require DuckStream.

**What forces the unbuilt parts.** golaberto needs the analytical kind: odds are recomputed
in micro-batches of simulation draws (odds-rust replaces 50,000-draw batches
incrementally), which a per-row path delivers without batching semantics and a
whole-table recompute delivers too slowly. Truco validates a different boundary:
browser drafts and pending intents must agree with authoritative Mecha matches,
presence and challenges. Hands are private server projections; browser optimism
must not become a second writer of canonical game state. The bounded Cortex
machine exercises this boundary before general hierarchy or DuckStream.

### Truco delivery priority

The implemented slice includes authoritative 1×1, 2×2 and 2×2×2 matches with the supported regional variants,
presence leases, challenges, generated Mecha admission and coordination, and
a Cortex machine whose screens are the arena, the bar and the online table.
Every request is a row keyed by what it says and every answer a row the machine
writes, so the store's outbox owns retries and the terminal's replay covers the
online game. No hatch remains on the online path; read-only SQL projections and
relational preconditions remain in Mecha declarations.

The stable contracts live in [[../cortex|Cortex machines]] and
[Mecha machines](https://github.com/bonisoft3/mecha/blob/v0.17.1/docs/machines.md). The
execution proof in `apps/truco/docs/hybrid-machine-proof.md` also checks
shared local/PostgreSQL reductions and private projections. The pinned PLV8
build's native timeout verification gap remains advisory; adoption assumes the
timeout contract and retains deterministic fuel.

Verification includes real PostgreSQL races and rollback, complete matches for
two-, four- and six-seat tables, the ticker's timeouts and lease lapses, and two
readers completing a match through PostgREST with every row resent once. This
is not full-shell browser acceptance
or a proof that the application is bug-free. Current behavior and limitations
belong in Truco's online reference, `apps/truco/docs/online-hybrid.md`.

The immediate priority is delivering that multiplayer slice with the primitives
already built: validate the real two-browser journey, fix concrete usability
and recovery defects, complete the replay/rematch experience, and make rollout
and stale-client handling explicit. Add framework capability only when a
reproducible delivery blocker requires it. A top-level Cortex root, general
hierarchical invocation, offline-arena migration, more variants/seats,
DuckStream, Rust emission and a new solver are not prerequisites.

Other framework work remains independent: per-key compute and analytical
DuckStream with golaberto as an oracle, replay contracts for hatches, and the
external-effects record's open work on sink certificates, non-HTTP bridges and
wake placement. That work does not precede Truco multiplayer delivery.

---

## Workload Suitability

### Where this architecture excels

1. **Transactional Full-Stack Applications (SaaS / FinTech / Marketplaces)**:
   Replaces the fragmented stack (REST/GraphQL controllers, ORMs, Redis caches, Celery
   workers, and Redux stores) with declarative, verified machines and live query sync.
2. **Streaming Views & Continuous Accounting**:
   Financial ledgers, tumbling billing meters, inventory allocation, and session tracking
   where delta updates must provably match fresh recomputations (`delta ≡ recompute`).
3. **Data Lake Analytics & Feature Preparation**:
   TF-IDF, search indexing, document vectorization, and cohort rollups via DuckLake,
   DuckDB, and JAX with zero-copy Arrow memory transport.
4. **Resilient Long-Running Workflows**:
   Order processing, payment lifecycles, and multi-step approvals requiring provable
   reconciliation and zero duplicate actions.

### Where this architecture is weak or mismatched

1. **High-Frequency Observability & Telemetry (100k–10M events/sec)**:
   Loss-tolerant log ingestion, APM traces, and raw sensor pings. Feeding these into
   Postgres WAL or row-level statecharts produces catastrophic write bloat and MVCC
   vacuum choke.
2. **Sub-16ms Real-Time Multiplayer & Physics (GGPO, Action Games, Doom)**:
   WAL-driven IVM has a commit latency floor (~10ms–100ms). Frame-rate tick loops
   (60–144Hz) cannot wait on database transactions or JSON serialization.
3. **Massive Distributed LLM Training**:
   Multi-node distributed backpropagation across thousands of GPUs requires microsecond
   interconnects (RoCE/InfiniBand) and NCCL AllReduce collectives, which cannot route
   through relational storage.
4. **3D Spatial Systems & Scene Graphs**:
   Continuous bounding volume hierarchies (BVH), spatial KD-trees, and GPU vertex pipelines
   require contiguous cache-friendly arrays of structures (ECS), not relational rows with
   JSONB payloads.

---

## Bridging the Frontier: The Macro-IVM / Micro-Kernel Hierarchy

An inner loop does not need to store rows in PostgreSQL to belong to this architecture. As
long as the inner loop's boundary protocol speaks **differential dataflow (inserts,
retractions, associative merges)**, its control plane is governed by **XState statecharts**,
and its operations are **pure MapReduce (Jessie/JAX/WASM)**, the unbreakable properties
are preserved even on extreme workloads:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        XState Orchestration                            │
│     Lifecycles, phase transitions, degradation, health & recovery      │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
              IVM Boundary Protocol (Deltas, Monoids, Retractions)
                                   │
┌──────────────────────────────────▼─────────────────────────────────────┐
│                 Inner Micro-Kernel (Hardware Optimized)                │
│   • Ring buffers (Telemetry)            • Contiguous ECS (Physics)     │
│   • Speculative frame rollback (GGPO)   • GPU AllReduce (Training)     │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                        Pure MapReduce Derivations
                    (Jessie / JAX / WebAssembly / Arrow)
```

1. **Observability via In-Memory Monoid Sketches**:
   - *Inner Loop*: Raw pings hit a lockless in-memory ring buffer.
   - *IVM Transfer*: An in-process `d2ts` consolidator aggregates events into algebraic
     monoids (HyperLogLog for unique visitors, t-digest for latencies, counts/sums).
     Monoid merges are associative and commutative ($A \cup B = B \cup A$).
   - *Pure Compute*: Micro-batches flush as columnar Parquet directly into DuckLake. JAX
     runs vectorized anomaly detection across Arrow memory. Postgres only stores partition
     manifests and derived alert states.
2. **Real-Time Gaming via Speculative In-Memory IVM (GGPO)**:
   - *Inner Loop*: WebAssembly tick loop running at 60–144Hz over contiguous memory.
   - *IVM Transfer*: Speculative execution with differential rollback is literally
     Differential Dataflow with retractions ($\text{Frame}(t) = \text{Frame}(t-1) + \Delta \text{Input}(t)$).
     When inputs mispredict, the engine retracts speculative deltas and reapplies confirmed
     deltas forward.
   - *XState Orchestration*: Match synchronization, jitter buffering, and combat state
     machines (`startup` → `active` → `recovery` → `hitstun`) are pure XState data.
     Authoritative match tokens, Elo ratings, and final checksums flush to Mecha.
3. **Model Training via Gradient Accumulation & Checkpoint Statecharts**:
   - *Inner Loop*: JAX compiled XLA kernels with `jax.pmap` communicating over NCCL.
   - *IVM Transfer*: Neural training is differential accumulation
     ($\mathbf{W}_{t+1} = \mathbf{W}_t - \eta \nabla \mathcal{L}$). Gradient aggregation
     across nodes is an associative monoid fold ($\sum \nabla \mathcal{L}$). Data loading
     streams pre-tokenized Arrow batches from DuckLake with deterministic epoch offsets.
   - *XState Orchestration*: Cortex manages the multi-node training lifecycle
     (`warmup` → `train_step` → `checkpoint` → `eval`). A loss spike (`NaN`) or node failure
     triggers an automated rollback to the last valid DuckLake checkpoint and resumes from
     the epoch watermark.
4. **3D Spatial Systems via In-Memory Relational ECS**:
   - *Inner Loop*: Entity Component System (ECS) is relational theory optimized for the
     CPU cache: Entities are primary keys, Components are dense columnar arrays, and
     Systems are continuous relational queries.
   - *IVM Transfer*: Spatial partitioning (Octrees/BVH) uses differential updates: moving an
     entity is an IVM retraction from voxel $A$ and insertion into voxel $B$.
   - *XState Orchestration*: AI behavior trees, doors/triggers, and quest progression are
     XState statecharts. The frame tick reads the entity's state column to select the active
     animation and hitbox parameters.

---

## Flagship Proof-of-Concept Applications

Eight targeted reference clones to verify effectiveness across both native and frontier
domains:

### Native Strongholds

1. **Linear (Collaborative Issue Tracker with Local-First Sync)**:
   - *Tiers*: Omnishell (optimistic keyboard UI, local `tab`/`device` stores) + Mecha
     (PostgreSQL team tables, LSN tracking) + Cortex (Slack/GitHub webhook acts).
   - *Invariant*: Zero optimistic drift; offline edits on an airplane merge deterministically
     on reconnect without corrupted board state.
2. **PostHog / Mixpanel (Streaming Funnel & Session Engine)**:
   - *Tiers*: DuckStream (`d2ts` streaming interval joins: `Page View` $\xrightarrow{\le 15\text{m}}$
     `Cart` $\xrightarrow{\le 1\text{h}}$ `Checkout`) + Mecha (live PostgreSQL views) +
     Omnishell (live dashboard charts without polling).
   - *Invariant*: $\text{Delta} \equiv \text{Recompute}$ — streaming views match fresh batch
     scans over raw events byte-for-byte.
3. **Algolia / Pinecone (Semantic Search over arXiv)**:
   - *Tiers*: DuckLake (100,000 paper abstracts in Parquet) + DuckStream / JAX (zero-copy
     Arrow scan, TF-IDF + dense embedding projection) + Mecha (hybrid lexical/vector ranking).
   - *Invariant*: Sub-second full-corpus re-indexing and scoring entirely in-memory without
     an external search cluster.
4. **Stripe / Airbnb (Escrow & Reservation Sagas)**:
   - *Tiers*: Mecha (atomic escrow lock) + Cortex (Level 4 `charge_card` and `payout` external effects, claimed in
     the ledger) + Omnishell (payment status ladder).
   - *Invariant*: Worker process crash mid-HTTP call to the payment gateway never
     double-charges; restart safely queries the peer via the idempotency key.

### Frontier Proofs

5. **Datadog / Prometheus Vector Agent (Observability Firehose)**:
   - *Proof Scope*: Ingesting 50,000 synthetic metrics and logs/sec.
   - *Tiers*: Lockless ring buffers + DuckStream (monoid sketches every 1s) + DuckLake
     (Parquet partition flush) + JAX (matrix Z-score anomaly scans) + Mecha (alert states only).
   - *Invariant*: 50k events/sec processed at $<5\%$ CPU with zero write bloat in PostgreSQL WAL.
6. **Street Fighter II / Smash 2D Fighter (GGPO Arena)**:
   - *Proof Scope*: 2-player browser fighter running at 60 FPS over WebRTC DataChannels.
   - *Tiers*: WebAssembly inner loop (speculative input IVM with frame retraction) +
     Omnishell (character combat statecharts: `startup` → `active` → `recovery` → `hitstun`) +
     Mecha (match tokens and signed outcome receipts).
   - *Invariant*: Bit-exact state recovery over 100ms simulated network latency with zero
     input lag.
7. **nanoGPT Pre-Trainer on Common Crawl (FineWeb-Edu Shards)**:
   - *Proof Scope*: Pre-training a 124M parameter transformer on 10 shards of FineWeb-Edu Parquet.
   - *Tiers*: DuckLake (streamed Arrow batches) + JAX (`pmap`/`jit` model, gradient
     accumulation as associative fold) + Cortex (training lifecycle and checkpoint recovery).
   - *Invariant*: Synthetic loss spike or GPU drop triggers automatic Cortex rollback to the
     previous DuckLake checkpoint, resuming at the exact epoch offset.
8. **Doom (1993) WebGL / ECS Engine**:
   - *Proof Scope*: E1M1 rendered in WebGL with demons, hitboxes, and projectile physics.
   - *Tiers*: In-memory ECS with differential BVH updates + Omnishell (monster AI
     statecharts: `idle` → `alert` → `attack` → `pain` → `dead`) + Mecha (save states).
   - *Invariant*: Monster AI and game progression remain 100% formal, verifiable XState data
     charts while rendering and physics run at an uncapped 144 FPS.

---

## Adoption across Repository Flagship Applications (`./apps`)

Every existing application in `./apps` with a PostgreSQL backend (migrations, publications, and RLS policies) derives tangible architectural guarantees from Hybrid Machines, finite statement timeouts, and level-3 relational effects:

| Application | Existing Mechanism | Hybrid Machine Adoption & Guarantees |
|---|---|---|
| **`apps/truco`** | `state.hybrids` owns online games in all supported variant/seating combinations, lobby presence and challenges; the local arena plays the same `truco_match` in the terminal. | **Adopted**: surface rows with generated transactional commands, private views and receipts, under a Cortex root that hosts the arena, the bar and the online table. Its online reference, `apps/truco/docs/online-hybrid.md`, records evidence and limits; general Cortex hierarchy remains unbuilt. |
| **`apps/chess`** | In-browser referee state machine and local time controls. | **Authoritative Turn Clocks**: Match state (`playing` $\rightarrow$ `over`) with strict termination reasons (`checkmate`, `resignation`, `flag`) backed by database-level clock expiration checks, preventing client clock manipulation. |

---

## Theoretical Ancestry and the LLM Inflection Point

This architecture sits at the convergence of four historical efforts:

1. **Out of the Tar Pit (Moseley & Marks, 2006)**:
   Diagnosed mutable state and uncontrolled control flow as the root causes of the software
   crisis. Proposed *Functional Relational Programming (FRP)*: state is purely relational
   ("essential state"), all logic is pure derived queries (IVM), and side effects are
   isolated as "accidental state." In 2006, no production differential engine or generative
   compiler existed to realize it.
2. **Timely and Differential Dataflow (Frank McSherry / Materialize)**:
   Proved that general relational algebra (including joins, aggregates, and recursive graph
   fixpoints) can be incrementally maintained over arbitrary inserts, updates, and
   retractions (`(data, time, diff)` tuples). Materialize stopped at the database layer,
   leaving frontend optimism, UI statecharts, and client reconciliation unaddressed.
3. **Statecharts (David Harel, 1987 / XState, David Khourshid)**:
   Invented to prevent exponential state explosion in avionics through hierarchy, parallel
   regions, and explicit effect descriptors. The web community largely relegated statecharts
   to UI widgets (modals, wizards), leaving backend architectures imperative.
4. **Meteor & DDP (2012)**:
   The first popular attempt at "the same database on client and server." Failed because it
   lacked formal foundations: no differential dataflow, no effect levels, ad-hoc callbacks,
   and unbounded memory usage.

### The LLM Catalyst
Writing complete, exhaustive XState JSON matrices—where every failure, refusal, timeout,
and compensating transition is drawn—is mentally exhausting for humans, who naturally
gravitate toward sloppy imperative shortcuts (`async/await`, try-catch, ad-hoc Redis caching).

LLMs invert this dynamic: **LLMs struggle with hidden imperative state, but excel at producing
declarative ASTs, CUE schemas, and complete state/event transition tables**. The mechanical
gates—`cue vet`, Chinese Postman walks (`omnishell check machines`), and SMT solvers—act as
a formal immune system, verifying that the generated program has no dead arrows or type
contradictions.

---

## Critical Engineering Seams

Five structural invariants required to make the architecture production-proof:

1. **The Migration Asymmetry (Views vs. Machines)**:
   - *Views*: Have no migration problem. Updating a SQL query in DuckStream or `d2ts` permits
     dropping the arrangement and recomputing from base.
   - *Machines*: Have Temporal's versioning problem. An instance paused in `awaiting_ack`
     cannot recompute from base if that state is removed. Long-lived machines must be
     decomposed into short-lived instances (per-transaction or per-occurrence). If an
     instance must outlive a deployment, the compiler must enforce an explicit migration
     transition function (`old_state → new_state`).
2. **Arrangement GC and Watermark Compaction in `d2ts`**:
   Differential dataflow keeps indexed collections of historical deltas. If watermarks stall,
   memory leaks monotonically. The engine must enforce monotone watermark advancement; once
   watermark $T$ passes, all deltas $\le T$ must be compacted into a single snapshot
   representation.
3. **Strict Confinement (SES / Jessie)**:
   The law $\text{Delta} \equiv \text{Recompute}$ requires absolute mathematical purity.
   Transform functions and JAX kernels run under Hardened JavaScript (SES) compartments:
   ambient IO, `Date.now()`, `Math.random()`, and unseeded GUIDs are forbidden. Time and
   entropy enter strictly as event payloads delivered by the runtime.
4. **Cold-Start and Hydration Boundaries**:
   A booting `d2ts` node cannot replay years of WAL. Cold-start must follow a two-phase
   hydration protocol:
   1. Attach the latest DuckLake/Postgres snapshot.
   2. Read the snapshot's committed LSN watermark.
   3. Stream WAL events starting strictly from that watermark offset.
5. **Causal Provenance and Time-Travel Replay**:
   Declarative IVM networks produce no imperative stack traces. Because state is a row and
   transitions are triggered by events, debugging is solved by recording the event sequence.
   Any disputed state can be replayed deterministically in an isolated test harness, stepping
   through every transition and differential delta.
