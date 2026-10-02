---
type: decision
title: "Hybrid machines: omnishell, mecha, duckstream and cortex"
description: Extending unbreakable statecharts to the backend — splitting client UI, relational transactions, streaming IVM / lake compute, and durable Level 4 orchestration into four pure-to-exterior tiers.
status: partially-built
---

# Hybrid machines: omnishell, mecha, duckstream and cortex

The unbreakable machine of [machines.md](../../../omnishell/docs/machines.md) was designed
for the browser: a chart closed over one row whose transitions emit typed effects the
terminal executes and answers. The backend architecture of
[rows-time-and-effects-design.md](../../../../docs/superpowers/specs/2026-09-05-rows-time-and-effects-design.md)
arrived at the same four laws from the cluster side: state is a row, operators are pure
functions of rows, impure things are sources, and every decision carries a version frontier.

This decision unifies them into one XState-JSON machine model partitioned into four tiers:
**omnishell**, **mecha**, **duckstream**, and **cortex**.

## The Four Tiers

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Cortex Machine                                  │
│     Orchestrates sagas, child lifecycles, and Level 4 exterior IO      │
│     (Native DBOS Workflows embedded over PostgreSQL)                   │
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

The division enforces that **only Cortex may emit Level 4 (exterior) effects**. The other
three tiers are mathematically pure, closed over rows, and replayable.

| Machine | Closed Over | Max Effect Level | Determinism & Replay |
|---|---|---|---|
| **Omnishell** | `tab` or `device` row in client memory | **Level 2** (compensable) | Walked by Chinese Postman tour; posed by Storybook battery |
| **Mecha** | `server` entity row in PostgreSQL | **Level 3** (replicated) | ACID transaction; rolled back natively on error |
| **DuckStream** | Pipeline state or lake catalog row | **Level 3** (lake/relational) | `delta ≡ recompute`; Feldera continuous circuits on server, DuckDB-WASM reactive recompute in browser |
| **Cortex** | Instance row in `saga` / DBOS state | **Level 4** (exterior) | DBOS durable execution; atomic PostgreSQL transaction co-location before exterior act |

---

## 1. Omnishell Machines (Client UI)

*Specification: [`machine.cue`](../../../omnishell/machine.cue).*

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
    (`020_schedule.sql`).
- **Outbound Effects**:
  - Closed relational operations:
    - `insert`: Strict append (`INSERT INTO ...`). Fails loudly on unique collision.
    - `ensure`: Idempotent insert (`INSERT ... ON CONFLICT DO NOTHING`). Inserts if absent,
      no-op if existing.
    - `upsert`: State replacement (`INSERT ... ON CONFLICT (key) DO UPDATE SET ... = EXCLUDED...`).
    - `accumulate`: Delta accumulation (`INSERT ... ON CONFLICT (key) DO UPDATE SET col = col + EXCLUDED.col`).
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

## 4. Cortex Machines (Orchestration & Level 4 Exterior Effects)

- **Role**: Top-level coordination of multi-tier sagas and exterior interactions. The
  only tier permitted to emit Level 4 effects.
- **Durable Engine: DBOS (Database-Oriented Operating System)**:
  - Built on Michael Stonebraker and Matei Zaharia's architecture where PostgreSQL is the
    single operating system for workflow state.
  - **No external daemon / broker**: DBOS runs embedded inside the application backend process
    (Deno / Node.js) with zero sidecars (`daprd`) or external orchestrator clusters (Temporal).
  - **Single Transaction Boundary**: A saga step can execute domain mutations in PostgreSQL and
    record its step state/idempotency claim within the **exact same ACID commit**.
  - **Replaces Ad-hoc Runners**: Fully provides battle-tested lease renewal, zombie worker
    detection, exponential backoff with jitter, dead-letter re-entry, and workflow versioning.
- **Saga Representation**:
  - Sagas and saga steps are persisted in the `saga` table (and DBOS system tables):
    ```sql
    CREATE TABLE IF NOT EXISTS "saga" (
      "id"              TEXT PRIMARY KEY,
      "name"            TEXT NOT NULL,
      "idempotency_key" TEXT NOT NULL,
      "payload"         JSONB NOT NULL DEFAULT '{}'::jsonb,
      "status"          TEXT NOT NULL DEFAULT 'pending',
      "outcome"         JSONB,
      "created_at"      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      "settled_at"      TIMESTAMPTZ,
      UNIQUE ("name", "idempotency_key")
    );
    ```
- **Inbound Events**:
  - Child machine completion (`OMNISHELL_SUBMITTED`, `MECHA_MIGRATED`,
    `DUCKSTREAM_CONSOLIDATED`).
  - Peer response (`CALL_SUCCEEDED`, `CALL_FAILED`).
  - Compensation trigger (`SAGA_ABORT`).
- **Outbound Effects** (Level 4 - Exterior):
  - `DISPATCH_EXTERNAL_ACT`: Outbound network calls (payment gateways, emails, webhooks)
    guarded by DBOS step idempotency keys.
  - `SPAWN_CHILD_MACHINE`: Instantiate or resume a Mecha, DuckStream, or Omnishell flow.
  - `COMPENSATE`: Execute compensating rollback steps across child machines.
- **Contract**: Temporal-style durable execution. If a process dies while an act is in
  flight, restart enters `unknown` and queries the peer via its idempotency key; it
  never blindly re-issues the call.

---

## 5. How Hybrid Machines Drive Cortex and DuckStream

Hybrid state machines in Pronto compile transitions that seamlessly trigger across tiers:

```
┌────────────────────────────────────────────────────────┐
│               #MechaMachine Transition                 │
│         (PostgreSQL BEFORE / AFTER Trigger)            │
└───────────┬────────────────────────────────┬───────────┘
            │                                │
     #SagaEffect                      #StreamEffect
            │                                │
            ▼                                ▼
┌────────────────────────┐      ┌────────────────────────┐
│     Cortex / DBOS      │      │       DuckStream       │
│  INSERT INTO "saga"    │      │  pg_notify stream bus  │
│  (Level-4 Exterior IO) │      │  (Feldera IVM circuit) │
└────────────────────────┘      └────────────────────────┘
```

1. **Driving Cortex from a Machine Transition (`#SagaEffect`)**:
   A state transition in PostgreSQL (e.g. an order moving to `confirmed`) can declare:
   ```cue
   actions: [{
       effect: {
           saga: "process_payment"
           idempotencyKey: "NEW.id"
           payload: {amount: NEW.total, customer_id: NEW.customer_id}
       }
   }]
   ```
   The compiler emits an atomic `INSERT INTO "saga" (...) VALUES (...) ON CONFLICT DO NOTHING`
   and sends `PERFORM pg_notify('cortex_saga_queue', ...)` inside the **same database transaction**.
   DBOS picks up the row and executes the external payment gateway call with full Level-4 durability.

2. **Driving DuckStream from a Machine Transition (`#StreamEffect`)**:
   When a machine executes state changes that feed analytical pipelines or require an explicit
   derivation sweep:
   ```cue
   actions: [{
       effect: {
           stream: "recount_ledger"
           signal: "refresh"
       }
   }]
   ```
   The compiler emits a signaling notification `pg_notify('duckstream_recount_ledger', ...)`
   or mutates source rows captured by Feldera's CDC connector.

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
   - *Tiers*: Mecha (atomic escrow lock) + Cortex (Level 4 `charge_card` and `payout` acts via
     `stream_attempt` claims) + Omnishell (payment status ladder).
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
| **[`apps/truco`](../../../../apps/truco)** | Hand-written `challenge_expire_check()` trigger and RLS status checks in `012_lobby.sql`. | **Adopted (`010_machines.sql`)**: Challenge lifecycle (`pending` $\rightarrow$ `accepted` \| `declined` \| `expired`) is compiled from `#MechaMachine` with finite timeout `after: {"60000": "expired"}`. Enforces initial state, valid transitions, immutability of final states, and timeout guards without custom trigger boilerplate. |
| **[`apps/xpense`](../../../../apps/xpense)** | Hand-written PL/pgSQL trigger arithmetic in `011_ledger_writes.sql` (`expense_maintain_stats_ivm`). | **Relational Effects Candidate**: Balance rollups and monthly counts on `month_stat` and `category_month_stat` map directly to Mecha's deterministic `accumulate` and `upsert` relational effects. Recurring expense generation maps to Mecha Ticker schedules. |
| **[`apps/thenote`](../../../../apps/thenote)** | Note sharing (`011_share_trigger.sql`) and card positioning triggers (`013_item_position_trigger.sql`). | **Lock & Concurrency Limits**: Strict PostgreSQL statement timeouts (`SET statement_timeout = '60s'`, role limits `5s`) prevent gateway timeouts and cascading lock starvation during concurrent multi-user board dragging. |
| **[`apps/ponto`](../../../../apps/ponto)** | Manual shift duration checks and punch validations (`012_duration_checks.sql`). | **Open Punch Auto-Expiry**: Active punch sessions run as finite machines; forgotten punch-outs are flagged or closed automatically by Ticker schedules. |
| **[`apps/chess`](../../../../apps/chess)** | In-browser referee state machine and local time controls. | **Authoritative Turn Clocks**: Match state (`playing` $\rightarrow$ `over`) with strict termination reasons (`checkmate`, `resignation`, `flag`) backed by database-level clock expiration checks, preventing client clock manipulation. |

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
