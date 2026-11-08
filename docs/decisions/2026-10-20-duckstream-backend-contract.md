---
type: decision
title: Feldera SQL across computation backends
status: proposed
---

# Feldera SQL across computation backends

Applications author Feldera SQL. Pronto compiles it for an execution backend that
holds the admitted computation contract in its deployment environment. Feldera
incrementally maintains relations on servers; DuckDB evaluates retained snapshots
where full recomputation is the appropriate implementation. The environment
chooses its backend. Neither runtime must imitate the other's scheduling,
internal state, intermediate notifications or numerical execution order.

This refines the [[2026-10-19-duckstream-runtime|runtime migration decision]].
The contract backend spike tests
selected obligations; it is not the production compiler or CDC replacement.
The existing [[../pipelines-and-schedules#Computations|Golaberto coordinator]]
continues to run its numerical computations, with opt-in typed query and sink
boundaries. The current runtime loads Feldera artifacts, but still captures full PostgreSQL
snapshots and extracts complete result relations. That implementation does not
satisfy the incremental server execution target below.

## Incremental ingestion and deployment target

This is required scope for the current Duckstream adoption PR, not a follow-up
optimization. Conduit may continue serving its existing consumers. It is not the
new computation path's source of table-wide invalidations.

Use Feldera's PostgreSQL CDC connector directly for native streaming ingestion.
Use pg_duckpipe independently for PostgreSQL-to-DuckLake synchronization and lake
queries through DuckDB. pg_duckpipe does not feed the streaming engine. These
consumers have separate recovery positions; their cursors are not interchangeable.
Streaming jobs take immutable inputs from Feldera's maintained relations rather
than joining those inputs with an independently advancing lake view. Do not
introduce a custom WAL consumer.
Only a platform capability restriction justifies another ingestion route, and
the deployment must declare its different cost and recovery behavior explicitly.
A connector failure must never silently select snapshot polling.

| Deployment profile | Intended execution | Required limits and evidence |
| --- | --- | --- |
| Pages | DuckDB snapshots for small demos; pure WASM remains available. | Snapshot-sized cost and refresh cadence are explicit. No claim of continuous CDC or production streaming capacity. |
| Cloudflare | Full application and publication semantics with bounded concurrency and capacity. Prefer the same native ingestion through supported containers or attached services; select another backend only where capabilities require it. | Declare where PostgreSQL, CDC readers, engine state and durable work run. Prove restart, backlog and retention behavior. This is our capacity profile, not a claim that Cloudflare itself cannot scale users. |
| Kubernetes | Native CDC, maintained relational state, durable storage, bounded worker parallelism and guarded delta publication. | Production admission includes resource sizing, backpressure, recovery drills, monitoring and defined recovery objectives. |
| GCP | The production contract with explicit regional availability, managed services where compatible, capacity testing and disaster recovery. | Select actual services and verify connector privileges, extensions and storage support. GCP branding alone establishes neither higher correctness nor availability. |

PostgreSQL hosting is an independent capability boundary. In particular,
[Cloud SQL permits only supported extensions](https://docs.cloud.google.com/sql/docs/postgres/extensions);
do not assume that choosing GCP permits installing pg_duckpipe on the source.
Choose compatible source/replication infrastructure and test the selected
connector privileges before admitting that deployment. Cloudflare native engine
placement likewise requires a concrete
[container/service configuration](https://developers.cloudflare.com/containers/),
not an assumption that a Worker is a native database process.

The existing pg_duckpipe probe
observed independent per-table commits, a per-table bootstrap and insufficient
transaction metadata for reconstructing a common source cut. This is acceptable
for the eventual lake view and does not block native streaming adoption. A stable
DuckLake snapshot is a consistent lake version, not necessarily a common
PostgreSQL transaction cut. Do not advertise the latter guarantee or use the lake
as a substitute input for a streaming computation requiring it. Selecting a
better existing lake replication engine is justified if a concrete lake consumer
requires stronger consistency. Otherwise retain pg_duckpipe and its explicit
boundary. Independently verify the native Feldera connector's transaction and
bootstrap guarantees before admitting streaming computations that require them.

### Admission and performance gates

After bootstrap, the native path consumes row changes, maintains relations and
consumes result deltas. It must not copy every source table, diff complete input
relations, export whole materialized views or reconcile every sink on each
change. Keyed request relations identify affected computations; running work
retains immutable inputs, pending work coalesces by computation key, and
publication receipts feed back into the maintained coverage relation. Cortex
and Durex execute work without reconstructing relational dependencies through
full scans. Existing SQL remains the computation language.

The WASM algorithm may consume an entire affected partition or globally coupled
fit. Its batch cost is accepted. Tests must distinguish that necessary work from
avoidable transport, planning and publication scans. Adding unrelated source
history must not increase transferred rows or dispatched jobs for an isolated
change. Measure source rows/bytes, result deltas, affected keys, submitted WASM
jobs and sink mutations; wall-clock timing alone cannot establish incrementality.

The correctness gates include populated bootstrap with concurrent writes,
updates/deletes, cross-table transactions, duplicate delivery, source retention
expiry, lost engine state, lost publication acknowledgments and reordered job
completion. OSS loss of relational state requires fenced reconstruction; a
retained source cursor alone does not authorize resume. Full snapshots remain
valid for bootstrap, explicit recovery and the declared Pages profile. They are
not a steady-state implementation of the server contract.

## What compatibility means

Compatibility is with an explicitly versioned subset of Feldera's published SQL
and computation behavior. A backend either implements an admitted requirement or
refuses the program before starting. Valid SQL syntax, successful plan conversion
and a passing happy-path query are not sufficient admission checks.

| Obligation | Required behavior | Allowed implementation difference |
| --- | --- | --- |
| Relations | Preserve the admitted types, null rules, duplicate multiplicities, keys, filters, joins and aggregates. Updates and deletions affect dependent results. | Full scans versus incremental maintenance; indexes, caching and spilling. |
| Windows | Preserve admitted interval, origin and boundary semantics, including overlapping membership. | Recompute all windows versus maintain changed windows. |
| Time | Honor declared event-time, clock and finalization requirements when supported. | Refresh cadence and internal scheduling within the published freshness policy. |
| Publication | An accepted result generation is complete and atomically visible within its declared sink boundary. Retries cannot repeat a committed effect. | Different generation counts, batching and intermediate revisable results. |
| Recovery | Resume or reconstruct without acknowledging uncaptured input or losing an already accepted generation. | Checkpoint restoration versus recomputation from retained input. |
| Progress | Identify the input coverage actually represented; do not invent source completeness from a timestamp or work counter. | Snapshot IDs, connector offsets or other backend-specific provenance. |

The contract does not promise that independent deployments process the same
inputs at the same instant. It does not require matching output traces or
Feldera's internal chunk boundaries. For deterministic relational examples,
comparing results at equivalent source states is useful evidence, but the
published semantics and independent expected outcomes are the test oracle.
Where the specification permits alternatives, tests assert the permitted behavior
rather than whichever answer one implementation happened to produce.

Freshness and capacity are explicit deployment properties. A slow backend may
publish less frequently and coalesce intervening invalidations. It may not claim
that a pending generation is current, drop required history to stay within a
budget, or silently change an unsupported query. Resource exhaustion is a visible
failure/backlog condition, not a different SQL meaning.

## Compilation and admission

Use the actual Feldera frontend at build time to parse and type-check the authored
program. Extract its typed relational representation and lower admitted operators
to DuckDB SQL. Do not maintain a second handwritten application query or perform
textual dialect substitutions. The first probe uses a pinned compiler's
package-private interface; this is an explicit coupling to maintain, not a stable
Feldera interchange API.

Our implementation language is TypeScript on Deno. The intended build boundary
is a pinned stock Feldera compiler exporting JSON, followed by Deno admission
and DuckDB SQL generation. Feldera's JVM remains a third-party build dependency;
custom Java translation and Python orchestration in the first spike are
experimental scaffolding, not the intended production architecture. Export
existence alone does not establish that expressions, declared schemas and
temporal obligations survive serialization.
The stock JSON probe tests this
boundary: the verbosity setting matters because the default diagnostic plan
omits expressions that the translator needs.

The artifact carries the source/program digest, frontend version, backend
compiler version, input/output schemas, admitted capabilities and generated SQL.
Admission checks exported declarations and the typed plan. Checking only the
final optimized plan could miss a declaration that still imposes an input or
runtime obligation. Include unused input declarations in the export. This is
semantic admission, not a source-syntax lint: an expression eliminated by
Feldera's optimizer need not be rejected merely because its spelling would be
unsupported if it remained executable. The JSON probe records a dead `NOW()`
example that cannot be distinguished from its ordinary projection by the
exports. Live unsupported operations and retained declaration obligations still
fail admission. Generated SQL must retain the frontend's result types where
widening would change the published contract.

A capability profile is attached to a deployment, not guessed at runtime. The
first profile is deliberately narrow: ordinary deterministic relational work and
fixed-duration HOP/TUMBLE, with bounded, explicit type/operator support. The spike
reference records the actual admitted subset. Recursion, user-defined functions,
connector metadata, volatile expressions, unsupported types, lateness annotations
and final-only output are refused until individually implemented and tested.
Restrictions on a particular HOP interval ratio are admission restrictions, not
alternative window behavior.

This profile can grow without changing the application language. A new backend
or feature passes the same contract fixtures and declares its capabilities.
Feldera runtime execution remains optional; Feldera compilation is the common
frontend. Real Feldera runs may serve as additional diagnostics in tests, but
exact internal behavior is not the specification.

## Portable values and native stages

Mecha's [compute boundary](https://github.com/bonisoft3/mecha/blob/v0.20.6/docs/compute.md) carries the
fifteen portable types using a consumer-supplied type table. Pronto emits that
table and derives sink fields from entity declarations. It does not require Mecha
to depend on Pronto. Exact native transport and Feldera operator admission are
separate promises: for example, native transport supports decimal precision 38,
while the JSON compiler spike admits a narrower decimal profile and refuses
decimal arithmetic.

Explicit PostgreSQL and DuckDB stages can cover operations outside the admitted
Feldera subset. Source PostgreSQL performs normalization before capture; DuckDB
prepares numerical inputs; sink PostgreSQL applies constraints and completion
hooks. Cortex owns the durable work lifecycle. Each stage must declare its
dependencies and values crossing the boundary. Calling an arbitrary PostgreSQL
function does not make its hidden table reads part of the captured snapshot.
This is an application computation with native stages, not a portable Feldera
program when those stages are required.

Golaberto already fits these boundaries. It needs coalesced invalidations,
retained inputs, numerical computation and atomic publication. Its existing
ASOF, calendar and ordered numerical preparation can remain native DuckDB SQL.
The WASM jobs and numerical modules remain unchanged. HOP/TUMBLE can later express
event-time grouping where needed; they are not prerequisites for scheduling
Golaberto's microbatches. The full numerical fit still runs per accepted batch.

## Retained CDC and DuckLake

Leave existing Conduit consumers in place while native Feldera CDC and
pg_duckpipe take ownership of computation ingestion. The ingestion boundary
receives committed source transactions with a source identity, epoch, replay
identity/position and ordered row changes. A complete transaction spanning tables
must not be mistaken for independent table progress. Verify the connector's
actual guarantees; deployments requiring transaction-consistent reads must buffer
or reject feeds that cannot supply that boundary. A common snapshot frontier is
not promised merely because all tables originate in PostgreSQL.

Prefer an existing replication engine to a new WAL consumer. The
pg_duckpipe probe evaluates both
current-row synchronization and append-mode history. These are separate
capabilities: retaining row changes does not establish a common source
transaction boundary. Independent table flushes can produce lake snapshots
containing only part of one committed source transaction. Such a snapshot is a
valid lake version but is not sufficient input for a program requiring a
transaction-consistent source cut. Such a consumer must obtain its required boundary from an admitted ingestion
path. The eventual lake-view profile does not require that guarantee and does
not feed the native streaming engine.
Programs allowing independently advancing inputs may instead declare per-table
progress and revisable intermediate results. The earlier Feldera connector probe
also observed cross-table skew. A global source cut is therefore an explicit
program requirement, not an assumed property of either execution engine.

Capture must couple durable input advancement with replay-safe progress.
The first contract fixture implements that by atomically applying current-table
changes, appending immutable changes and storing a receipt in DuckLake before
acknowledging the transport. An existing replication engine may use its own
durable metadata and replay filtering; validate those guarantees rather than
adding an independent Duckstream acknowledgment cursor. Lost acknowledgment must
not cause duplicate occurrences or incorrect current rows after recovery.
Restart must preserve the engine's relationship between retained data and
replication progress. The pg_duckpipe probe tests backlog recovery, but does not
inject the exact failure between a target commit and source acknowledgment.

Current-state tables and occurrence history are different relations. An insertion
and deletion in the same source transaction may produce no net current row, but
both records remain in the history. Current-state statistics query the former;
commands or computations owed every occurrence explicitly query the latter. An
aggregate output's net changes cannot reconstruct every underlying occurrence.

DuckLake already supplies retained versions and historical reads. A run pins its
catalog snapshot instead of copying arbitrary mutable inputs again on retry.
The run identity includes program version and its input version; the snapshot's
provenance identifies source coverage without treating its numeric ID as a WAL
LSN. A reopened reader queries that version even after newer ingestion commits.

Production retention must protect active/retryable runs and everything needed to
reconstruct admitted results. Full recomputation can require all historical
input; expiring old input because Feldera would garbage-collect internal state
would be incorrect. The initial spike retains history without pruning. Bounded
retention needs its own proved contract, not an inferred optimization.

## Coordination as a feedback query

The streaming SQL query is the logical coordinator. It joins applied input
changes with execution feedback carrying committed result coverage to derive two
relations per computation scope:

- **Dirty:** required input coverage exceeds durably completed computation coverage.
- **Runnable:** dirty, with no active execution and all declared prerequisites
  satisfied.

The retained event stream is the backlog. Source PostgreSQL does not receive a
dirty marker or job for every captured change. Cortex admits and executes work
selected by the relation; its durable work boundary commits result candidates
and completion receipts. These
execution records are necessary durable authority for effects, rather than a
second copy of the source-event queue. The
feedback spike exercises the
query and a local transactional stand-in for that authority.

### Inputs and coverage

Each input is scoped by computation, program version and source/catalog epoch.
Applied-change notifications refer only to durably retained, complete snapshots.
For a computation requiring a consistent cross-table cut, capture must establish
that cut before emitting a notification. Bootstrap emits an explicit initial
requirement, including for empty input; relevant deletions also emit requirements.
A dependency mapping determines which computations a source change affects.
Reading only surviving current rows cannot recover deleted groups or occurrences.

Within one such ordered snapshot domain, the query folds required coverage with
`MAX` and selects execution feedback by its authoritative monotonic revision.
Each execution event carries the coverage already committed by that authority;
claim and failure preserve it, while durable result completion advances it.
Snapshot numbers are not LSNs;
this reduction is valid only when each later snapshot includes the preceding
required changes. Independent partitions need an explicit coverage vector or a
proven common cut. Never compare unrelated program versions or epochs. Rebootstrap
creates a new identity and initial requirement, not a larger counter pretending
to continue the old history.

A run fixes its input coverage at admission. If run 41 is executing while changes
42 through 90 arrive, completion of 41 leaves 90 dirty. The next admission takes
the latest complete eligible snapshot, coalescing the intervening changes into
one successor. Failure advances no completed coverage. For current-state
statistics this is sufficient; a computation owed every occurrence must retain
and read those occurrences even when execution is coalesced.

### Scheduling and execution boundary

Golaberto's initial policy is immediate admission when idle and one coalesced
successor while busy, serial within a computation scope. It needs neither an
event-time window nor a processing-time timer. A one-second timeout cannot start
a serial successor while its predecessor still runs. HOP/TUMBLE remain useful for
business-time grouping; they do not implement this resource-dependent admission
policy. Applications express additional eligibility conditions as SQL over
explicit feedback inputs, without introducing another policy DSL.

Runnable output is latest-value state keyed by computation, not an imperative
job command. Changes to required coverage may produce many output updates while
one claim is being admitted. Dispatch must re-read/coalesce that state and perform
an idempotent, revision-fenced claim against Cortex's authoritative execution
state. Replayed or stale eligibility must not launch duplicate concurrent work.
When feedback lags, it is safe to delay work; it is unsafe to treat the absence of
an observed claim as proof that no authoritative claim exists. Dispatch also needs
retry/reconciliation on restart and admission failure: an unchanged runnable row
must not require another source change to be considered again.

Execution feedback comes from the execution authority, not a worker's arbitrary
clock or completion message. An admitted job has a stable logical identity derived
from computation, program and immutable retained inputs, including upstream
versions and clock/seed parameters. Attempts carry separate fencing tokens.
Pending requirements coalesce; admitted inputs never change on retry.

Completion carries coverage of durably stored result candidates and the recorded
job outcome. The final PostgreSQL materialization has separate published
coverage. A completed calculation must not be rerun merely because sink delivery
lags: replay its retained result instead. The earlier
feedback spike combines execution
and final publication in one local transaction; when a second streaming query
selects authoritative candidates, those are distinct durable boundaries.
Claim/failure events carry forward completed coverage. Lifecycle revisions prevent
out-of-order feedback from restoring older execution state. A replayable capture
or transactional outbox delivers committed outcomes to the query.

Airlock can supply durable internal execution and result recording. Its job
idempotency does not resolve overlapping results from distinct jobs. The
result-selection query owns that decision, and the PostgreSQL sink enforces its
publication contract. Separate jobs must not independently write final statistics
through Airlock while also allowing the streaming sink to own those rows.

Exclude a computation's own sink changes from its source requirements unless an
explicit, terminating feedback dependency is intended. Downstream computations
consume committed upstream result revisions and must bind the revisions they
read to their claim. General prerequisite joins, cycles, parallel partitions and
retry backoff need separate acceptance cases; the feedback spike covers one
independent serial scope per key, not the full dependency graph.

### Backend and cost

Feldera can incrementally maintain these derived relations. DuckDB can evaluate
the same compiled query over retained inputs whenever input or feedback arrives,
with a durable catch-up scan after restart. Neither backend executes jobs merely
by producing SQL rows: Cortex still supplies admission, retries and fencing, and
the sink supplies transactional publication. The required adapter is a relation-to-executor
bridge, not an incremental streaming engine rebuilt inside Cortex.

One active execution and one latest requirement bound scheduling state per scope,
not retained event volume. A DuckDB full scan of append-only feedback/history grows
with retention; compaction requires a replay-safe baseline with matching coverage
and lifecycle revisions. Until proved, retain the events and measure the cost.
This policy avoids per-change dispatch and redundant queued fits, but does not
make one numerical fit faster or guarantee freshness under saturation. Measure
capture lag, query evaluation, admission delay and numerical execution separately.

The existing Golaberto Cortex coordinator remains the production implementation.
This proposal moves eligibility into compiled SQL; it does not claim that the
current invalidation ingress, dependency orchestration or publication bridge has
already been replaced.

## Evaluation and publication

The feedback query derives eligible work; Cortex admits and executes it. The
DuckDB worker reads a pinned version and evaluates the generated relation in full.
Pure WASM may execute repeatedly after a crash, but its immutable inputs and
canonical result identity make retries logically equivalent. Pure does not by
itself promise bitwise numerical equality across different runtimes; the admitted
numerical contract and implementation version must state that requirement.

### Authoritative results are a relation

External calculations return versioned candidates to a second streaming query.
For independently replaceable elements, that query selects the greatest admitted
input version per output key. A late batch at version 41 can populate keys absent
from version 90 without replacing version-90 values on their overlap. There is no
global publication frontier across partially covered keys. Candidates are
canonical by logical result identity before entering SQL; repeated delivery must
not increase relational multiplicity. Different values under one identity fail.

Feldera incrementally maintains this view. The DuckDB adapter recomputes the same
compiled query. Both resolve overlapping completed work relationally before sink
publication. A deletion is a versioned tombstone in the candidate relation;
filtering it out before selecting the newest version would resurrect older values.
Retain the necessary version fence even when the visible application row is gone.
Program/source epochs require an authorized writer handover, not lexical ordering
of otherwise incomparable versions.

The computation declares its output key and ownership scope, retained input
provenance, replacement semantics and atomicity scope. Per-key replacement is not
appropriate for additive deltas, commands owed once per occurrence, or groups
whose rows must become visible as a consistent generation. A full-generation
computation owns its whole scope, including deletion of rows absent from its new
result. Empty output still has a generation/completion record. Multi-table
statistics need a single publication transaction or an atomically activated
complete generation understood by every reader.

### PostgreSQL as the materialized sink

Prefer Feldera's native PostgreSQL materialized sink when its pinned behavior
meets the computation contract. It writes a uniquely keyed view directly to
PostgreSQL; ordinary statistics materialization does not need a second Airlock
job for every output update. Cortex/Airlock remains responsible for durable
external computation. Internal hooks can run in the PostgreSQL publication
transaction where required. Neither IVM nor idempotent upserts alone establish
that recovery cannot temporarily replay an older value over a newer one.

The sink contract is: within the authorized writer scope, accept a greater
logical version, treat identical versions as duplicates, and reject conflicting
values for the same identity. Older versions are superseded without changing
application rows or running their hooks. Record accepted publication progress and
result effects atomically; a lost acknowledgement can then be retried safely.
Tombstones enforce the same rule for deletes. This can be a PostgreSQL-local
transactional adapter rather than an external-effect reconciliation protocol.
Conditional writes must arbitrate concurrent publishers in PostgreSQL, not rely
on a read/check performed outside the transaction.

DuckLake ingestion, durable candidates and PostgreSQL publication are separate
commits. Replay bridges them; there is no distributed atomic commit. Exclude final
sink tables from the computation's own CDC dependencies unless a terminating
feedback relation is explicitly declared. A completed candidate and an applied
final result are distinct receipts; dependent computations must declare which
representation they actually read.

### Observable effects and replay

The target guarantee is that every required input is eventually represented by a
sufficiently recent result, replay does not duplicate effects, and accepted
coverage never regresses within the declared output scope. This does not promise
one physical execution or a visible output per source write: coalescing is
intentional. It does not promise a single PostgreSQL transaction across the whole
source-to-result pipeline. Deterministic replay uses recorded admission decisions
and frozen inputs; independent live runs may choose different batch boundaries.

The publication spike exercises
source capture, pure WASM, translated authoritative-result SQL and a guarded
PostgreSQL sink. The native sink spike checks the pinned Feldera connector
separately. Their references delimit
executed failure cases from assumptions; neither installs this protocol in
Golaberto or proves arbitrary connector recovery and multi-table publication.

The native probe demonstrates why destination protection matters: with lost
Feldera state, replay regresses an unguarded PostgreSQL version-30 tombstone to a
live version-10 row, and replay of an identical version-30 result repeats an
UPDATE hook. The paired version-guarded target retains the tombstone and records
only the two original accepted changes. This is a tested per-key replay contract,
not a claim that stock connector recovery supplies exactly-once effects.

## Exactly-once boundaries and implementation reuse

Exactly-once here concerns observable logical effects, not physical delivery or
WASM invocation count. Kafka Streams uses atomic commits of consumed offsets,
state changes and output records within Kafka. Kafka's own
[external-sink guidance](https://kafka.apache.org/42/design/design/#message-delivery-semantics)
requires cooperation from the destination; storing progress with output is the
relevant technique for PostgreSQL. Adding Kafka would not itself make an external
PostgreSQL write or WASM invocation part of that transaction.

Our equivalent boundary is a durable logical result identity, immutable complete
payload, authorized writer fence and receipt committed with all owned output
changes. Source capture separately commits retained input and its replay receipt
before acknowledging WAL. Pure execution can repeat before result completion;
canonical candidates and completion commit together. After completion, publication
retries reuse retained results. These are composable local transactions and
replay protocols, not one distributed transaction from the original source write
to the final statistic.

For latest-state computations, superseded generations may be skipped according
to the declared replacement policy. This does not establish exactly-once command
or additive-event processing: those contracts must preserve every required
occurrence. A version guard alone prevents regression but neither proves no input
loss nor records every logical outcome. The capture, completion and publication
receipts have different identities and responsibilities.

### Consistent initial input

PostgreSQL's [exported logical-slot snapshot](https://www.postgresql.org/docs/17/protocol-replication.html)
provides a consistent database snapshot paired with a WAL starting point. The
capture adapter copies all required tables under that snapshot, retains the
complete baseline and provenance atomically, then applies complete source
transactions from the corresponding slot. No computation is eligible on a partial
copy. An interrupted copy without a durable complete marker is abandoned or
restarted; a captured transaction is acknowledged only after durable application.
A restart does not create a new input identity merely because the process changed.

The bootstrap spike tests these
native primitives under concurrent source changes. It does not replace a
production CDC engine. Existing pg_duckpipe evidence still shows independent
table cuts, so readiness of each table alone is insufficient for this stronger
profile. Prefer an existing engine that exposes the matching snapshot, complete
transaction boundaries and durable progress; otherwise its adapter needs work.
The fixture's use of PostgreSQL as a receiver demonstrates the handshake, not a
production DuckLake implementation of it.

### Atomic generations across output tables

Per-key guards cannot make independent table connectors publish atomically.
Whole-generation computations produce one immutable envelope containing every
owned table, including empty tables and deleted/absent keys, along with its
logical input provenance. The sink verifies the required table manifest and
immutable payload identity; semantic completeness remains the trusted producer's
obligation. One PostgreSQL transaction replaces all owned tables,
advances the scope's accepted generation and records its receipt and local hooks.
Old generations are superseded and identical retries add no effect. A generation
number orders only one explicitly authorized program/source domain.

The generation spike tests that
boundary and contrasts it with independently committed table writes. A compact
complete envelope can enter through one PostgreSQL row and a trigger invoking the
same finalizer. The native experiment executes this with Feldera's stock
`postgres_output`: the connector's transaction includes both result tables,
accepted generation, immutable receipt and local hook. Restart replay of an older
envelope leaves the active generation unchanged. This preserves atomicity without
a separate delivery workflow, while retaining a small application-specific SQL
finalizer.
For large outputs, immutable staging plus a verified complete manifest may be
necessary. Counts alone do not prove correct contents, and a marker arriving
before its data must not activate an incomplete generation.

Readers need one database snapshot for a coherent multi-table observation: one
SQL statement, or a suitable transaction. Two separate READ COMMITTED statements
can straddle any legitimate commit. Electric/browser delivery of related tables
also needs its own generation-aware acceptance case; a PostgreSQL transaction
does not by itself make independent client subscriptions update in one render.

### What remains custom

| Boundary | Existing mechanism | Required application integration |
| --- | --- | --- |
| Source bootstrap and WAL | PostgreSQL snapshots, logical slots and a replication engine | Complete-cut readiness and durable target acknowledgement; do not write another generic WAL decoder. |
| Relational computation | Feldera SQL/DBSP or compiled DuckDB evaluation | Admitted schemas, canonical candidate identities and explicit version domains. |
| Pure external work | Cortex/Airlock durable jobs and existing WASM | Freeze inputs and persist results with completion; do not count process execution as the effect. |
| Independent output keys | Native PostgreSQL sink | A PostgreSQL version/tombstone guard; plain upsert is insufficient under replay. |
| Whole-generation output | PostgreSQL transaction, constraints and trigger/function | A complete generation envelope and guarded finalizer for its owned tables. |

Mecha already has multi-table publication under the caller's PostgreSQL
transaction in [compute publication](https://github.com/bonisoft3/mecha/blob/v0.20.6/services/compute/publication.ts),
and its [batch executor](https://github.com/bonisoft3/mecha/blob/v0.20.6/services/compute/batches.ts)
commits that publication with the internal-work outcome. Production integration
should reuse its validation, ownership, hooks and authority contract rather than
create a second competing publisher. The sink-trigger experiment tests an
alternative entry point for a streaming materialization, not a replacement for
those application obligations.

The unavoidable custom logic states computation-specific ownership, completeness
and version semantics. It can be generated from the computation declaration and
implemented as ordinary SQL plus existing machine invocations. No new streaming
engine, queue or policy language is required. The experiments demonstrate these
boundaries separately; a production connector, retained-state implementation and
application wiring must still pass the combined contract before cutover.

Feldera's [input transactions](https://docs.feldera.com/pipelines/transactions/)
can suppress intermediate view results during a coordinated ingest. They are
not a PostgreSQL transaction shared by separate sink connectors, and current
documentation does not list PostgreSQL CDC among connectors with automatic
transaction orchestration. Do not infer either property from the word
“transaction”.

## Time and finalization

A five-minute window describes membership, not a five-minute execution schedule.
A periodic full recomputation can produce revisable results for all windows.
An old correction must affect its old window when the admitted program allows
that correction. A heartbeat may schedule work or supply declared clock progress;
it cannot assert that old source records will never arrive.

Feldera's published temporal constructs impose additional behavior: `LATENESS`
constrains admissible updates, `append_only` constrains mutations, and `emit_final`
restricts publication to final rows. A backend must implement each admitted
obligation or reject it. It need not copy undocumented scheduling decisions.
The initial profile rejects these constructs rather than silently stripping them.
See [Feldera time-series extensions](https://docs.feldera.com/sql/streaming/).

Clock-dependent queries need a declared clock policy and durable evaluation time
for retries. Snapshot time, source commit time, event time and wall clock remain
separate fields. The first profile does not admit `NOW()`; rejecting it is simpler
than treating DuckDB's current wall clock as equivalent streaming behavior.

## Deployment boundaries

| Environment | Intended implementation | Required capability boundary |
| --- | --- | --- |
| Server/cloud with Feldera | Feldera SQL frontend and execution; common result-publication contract. | Connector coverage, durable recovery and required temporal features. |
| Server/cloud without Feldera engine | Same frontend, DuckDB SQL artifact, durable DuckLake catalog/data and Cortex/Airlock work. | Proven ingestion, retained versions and transactionally fenced publication. |
| Static Pages/browser | Build-time compilation, DuckDB-Wasm worker over supplied data/snapshot artifacts. | No assertion of unattended CDC ingestion or durable server publication. Unsupported history access must be rejected or supplied by an explicit service/artifact. |
| Cloudflare | Appropriate compute/storage adapter for the admitted profile; native/container or browser evaluation where supported. | Durable authority and storage must be supplied explicitly; Wasm availability is not proof DuckLake extensions or server lifecycle work there. |
| Tests/local | Deterministic source transactions and clock fixtures; native or browser backend as appropriate. | Same semantic obligations for admitted features, without matching production scheduling. |

One application program may require capabilities unavailable on a smaller target.
Report that at build/deploy time. Do not substitute a weaker time or durability
policy just to make the deployment succeed.

## Spike acceptance and next work

The spike should show authored Feldera SQL compiling to DuckDB, genuine retained
DuckLake versions, replay-safe ingestion, historical evaluation after reopen,
complete result replacement, corrections/deletions and fixed window boundaries.
Tests should exercise distinct refresh schedules that both satisfy the contract,
not assert matching intermediate output counts. Negative tests must demonstrate
capability refusal. Record exact versions, generated artifacts and observations.

The spike's reference separates executed claims from remaining gaps. Production
work then consists of the real connector adapter and bootstrap protocol, broader
operator/type admission, artifact packaging, Cortex/Airlock integration, retention,
resource policy and per-environment conformance. Existing Conduit/Redis retirement
remains a later cutover after these boundaries are proved.

## Storage references

- [DuckLake time travel](https://ducklake.select/docs/stable/duckdb/usage/time_travel): retained catalog versions can be read historically.
- [DuckLake transactions](https://ducklake.select/docs/stable/duckdb/advanced_features/transactions): the lake has its own transactional boundary.
- [Snapshot expiration](https://ducklake.select/docs/stable/duckdb/maintenance/expire_snapshots): retention is explicit; time travel cannot recover expired history.
