# SQL feedback coordinator

[[../coordinator.sql|Authored SQL]] derives work from retained applied-snapshot
and execution-lifecycle events. A lifecycle completion carries committed
publication coverage, so the result receipt and idle transition have one
revision. The stock Feldera 0.367.0 compiler exports verbose JSON, the existing
[[../../json-plan/translator.ts|translator]] lowers it unchanged, and native
DuckDB executes the generated query.

There is no per-change dirty row, job insertion, debounce timer or TUMBLE. The
retained input relations are the backlog. SQL groups applied snapshots, selects
the latest lifecycle revision, and derives `dirty` and `runnable`. An idle
computation is immediately runnable when its latest applied snapshot exceeds its
published coverage. During execution the target can advance arbitrarily; after
completion the query exposes one latest successor.

## Contract

The identity is `(computation, program, epoch)`. Versions are positive,
cumulative applied snapshots within that identity. Zero means no publication. A
new program or source epoch receives a positive bootstrap snapshot even when the
source has no rows. Without an applied/bootstrap event the query has no
requirement to evaluate that identity.

Applied snapshots denote complete durable application of source transactions,
including deletions. They are not raw source LSNs or partial transaction
notifications. A sparse sequence such as 41 then 90 is valid: snapshot 90
supersedes the whole preceding state. A missing intermediate notification does
not create a coverage gap. Independent partitions or partial snapshots cannot
share this scalar coverage contract.

Each authoritative lifecycle revision contains `busy` and `published_through`.
Claim and failure carry forward previous committed coverage; successful atomic
publication advances it. Delayed feedback leaves the old busy state visible.
Replay selects the highest revision, and duplicate identical rows collapse.
Conflicting payloads at one revision are refused before insertion.

The result columns are identity, target snapshot, covered snapshot, lifecycle
revision, busy, dirty, and runnable. The revision is an admission precondition,
not a second scheduling policy. A dispatcher reconciles the current runnable
relation after restart or a failed admission; consuming only positive deltas
would strand unchanged runnable work.

## Execution boundary

[[../probe.ts|The executable harness]] uses two persistent local DuckDB files.
One retains append-only stream input rows. The other is a transactional stand-in
for Cortex claims and Airlock publication. Source changes never update the
execution ledger. A claim compares the observed revision, idle state and
published coverage; competing claims from stale SQL results cannot both win. The
idempotency token identifies the immutable key, target and claim fence.
Replaying it returns the recorded outcome, including completed or failed, which
the executor must inspect before dispatch.

Publication atomically updates the artifact, committed coverage, attempt
outcome, idempotency receipt and lifecycle outbox. Retrying a publication after
a lost acknowledgement returns its existing receipt. Different output under the
same token fails. A failed attempt advances the lifecycle revision but never
coverage, and its old worker cannot publish. After terminal failure, a
replacement is a new execution token admitted from the current SQL relation.
Retrying transport or an active job preserves the original token and frozen
inputs.

The local publication transaction deliberately combines the execution and
publication boundaries. A production Cortex/Airlock integration must preserve
that durable outcome contract across its actual transaction boundaries. This
spike does not implement either service, prove distributed exactly-once
execution, or prevent repeated computation of the same admitted job. Cortex must
associate retries with the same durable job identity.

One mutable execution row exists per identity that has run. Attempt history,
publication receipts and the outbox grow per execution. Retained input history
grows per event. Bounded scheduling state does not mean bounded storage, and
this experiment defines no compaction frontier or retention policy.

## Evidence

[[../results/build.json|Build evidence]] records the compiler artifact digest,
source and translator digests, export flags and runtime pins.
[[../results/plan.json|Stock plan]], [[../results/schema.json|stock schema]] and
[[../results/duckdb.sql|generated query]] are retained for inspection.
[[../results/tests.json|Executed fixtures]] records independently specified
expected rows and the durable-boundary checks.

The sequence publishes snapshot 41 while snapshots 42 through 90 arrive during
its execution. All 49 arrivals cause zero execution-ledger writes. Completion 41
leaves target 90 dirty, and exactly one successor is admitted. That attempt
fails without covering 90; a new attempt publishes 90. Further cases exercise
publication rollback, lost acknowledgements, stale competing claims, delayed and
reordered feedback, identity isolation, database reopen, double replay of the
retained log in reverse lifecycle order, bootstrap, and reconciliation without a
new input event.

The query is recomputed over native DuckDB tables. These assertions establish
the SQL/result and durable-feedback contracts, not incremental maintenance
performance. The harness supplies trusted adapter events and validates their
declared kind/completeness; it does not replicate a source database, verify
source commit provenance, or authenticate arbitrary external feedback. The
source database is not used as a queue. Snapshot acquisition belongs to
[[../../replication/docs/index|the replication boundary]].

Cross-computation prerequisites, including ratings revisions required by
chances, are excluded. Those two names are independent test identities here.
Also excluded are distributed leases, concurrent native writer conflict
recovery, worker crash expiry, retry backoff, fairness, and pruning history.

## Run

Use Deno 2.8.2, Java 19+, and the locked native `@duckdb/node-api@1.4.3-r.3`
package. From this directory:

```sh
export FELDERA_JAR=/absolute/path/to/feldera-0.367.0.jar
sayt doctor
sayt build
sayt lint
sayt test
```

The default jar path is the sibling compiler cache. The existing
[[../../compiler/extract-jar.sh|extraction script]] obtains the digest-pinned
stock jar when needed. No compiler or translator edits are required. Tests use
temporary persistent database files and remove them after closing. This is a
backend spike with no visual surface or design oracle.

## Validation and review

Sayt doctor/build/lint/test exited 0; the test reports 13 independently
specified relation fixtures plus execution-boundary assertions. Pronto doctor
also exited 0. The configured compiler jar was supplied through `FELDERA_JAR`;
running without that variable requires populating the documented sibling cache
first. An independent Astra/high backend review of the design and spike reported
no actionable findings. The simplification pass kept committed coverage in the
lifecycle outcome, without a separate receipt synchronization protocol. No app
runtime changed, so browser acceptance and production throughput were not
tested.
