---
type: reference
title: Replayed computation and PostgreSQL publication spike
---

# Replayed computation and PostgreSQL publication

This executable spike connects actual PostgreSQL logical decoding, retained
DuckDB inputs, pure WASM, a stock-compiled Feldera SQL result-selection view,
and transactional PostgreSQL publication. It tests exactly-once observable
replacement effects under a narrow, explicit failure model. It is not the
production Cortex/Airlock integration or a test of Feldera's native runtime
connector.

The [[../probe.ts|Deno probe]] uses the unchanged
[[../../json-plan/translator.ts|plan translator]] to execute
[[../authoritative.sql|Feldera SQL]] in native DuckDB. The generated query is
[[../results/duckdb.sql|retained as evidence]]. Source and sink are a fresh,
digest-pinned PostgreSQL 17.6 container in the isolated
`pronto-duckstream-publication` Compose project. The test removes that container
and its volume.

## Boundaries and identities

The source fixture inserts fifteen rows in one committed transaction after
creating a `test_decoding` logical slot. The probe peeks committed WAL, persists
the transaction identity, payload, applied state and immutable input snapshot in
one DuckDB transaction, then acknowledges the slot. Closing and reopening DuckDB
before acknowledging proves that repeated capture does not duplicate the applied
transaction. Source rollbacks do not enter the input stream.

The retained input identity uses the commit LSN within one fixed source
incarnation. Versions 41, 90 and 91 are monotone applied-snapshot identifiers,
not decoded LSN values. This fixture is deliberately not a production
consistent-snapshot/WAL handoff: the initial load is one ordinary captured
transaction. It handles only the exact integer source schema with immutable
primary keys and refuses unrecognized decoded source records. A real WAL
primary-key mutation is refused before either applying or acknowledging the
transaction. It is not a general replication client.

Admission stores an immutable snapshot and key set under a job identity. Batch A
reads keys 1–10 at snapshot 41; batch B reads keys 6–15 at snapshot 90. Their
inputs overlap. B executes and publishes before A. WASM doubles each integer
outside the database transaction; candidate insertion and job completion then
commit together. A completed job can deliver its retained candidate again
without rerunning WASM. A crash before that commit may repeat the pure
execution.

Canonical candidates are keyed by output key and input version. Same-identity
duplicates do not increase relational multiplicity; different payloads fail. The
SQL view selects the newest candidate for each key. A later deletion is a
versioned tombstone in that view, not the absence of an output row.

## PostgreSQL publication

The [[../sink.sql|publication function]] owns a fixed `double/v1/source-1`
output scope and serializes its publication transactions with an advisory lock.
It accepts a batch receipt identity and exact payload, conditionally replaces
only newer output-key versions, then inserts the receipt in the same
transaction. Repeated receipt identities return their existing outcome without
writes; changed payloads under the same identity fail. Equal output versions
with different values also fail, even under different publication identities.

A receipt means that every row in that delivery was processed under the
replacement policy. It does not mean that every row caused a write: a mixed
batch can apply some keys and skip other, superseded keys. An `AFTER` trigger
records actual accepted output changes transactionally. It models a local
database effect, not an exactly-once external HTTP call.

The version guard remains necessary even though the SQL view already selects
authoritative results: transport can deliver an old view after a new one.
Tombstones retain the accepted version and prevent stale delivery from
resurrecting deleted output. The application-facing view hides tombstones. Two
PostgreSQL sessions also publish competing versions of a separate synthetic key
to test the sink's actual serialization.

The scheduling feedback spike's completion protocol is separate. This spike
distinguishes durable candidate completion from final publication: sink retry
uses completed candidates rather than recomputing the job. Production must carry
that distinction into its scheduling feedback.

## Evidence and limits

[[../results/tests.json|Test results]] record the assertions and exact tool
versions. The main pipeline captures three committed source transactions,
completes three jobs, retains 21 canonical candidates and produces 16 actual
output effects. The additional concurrent sink fixture accepts either one or two
ascending versions, depending on session admission order.

Fault injection covers publication rollback, successful PostgreSQL COMMIT
followed by a lost application acknowledgement, local durable-store reopen, old
publication replay, late overlapping results, duplicate/conflicting identities
and deletion resurrection. The lost-ack injection throws after observing
successful COMMIT; it models the uncertainty boundary but does not cut a network
connection or kill PostgreSQL. There is no HA, OS crash, storage corruption,
long-running throughput or distributed lease test.

Source epoch and program are fixed and writer handover is refused. The
replacement values are independent per key. Multi-table generation activation,
cross-key invariants, deltas, multiple-source coverage vectors, retention/GC,
production bootstrap, and general SQL/type admission remain outside this spike.
The source slot also sees sink WAL, but capture retains only the source table;
output writes do not become new computation inputs.

## Run

Use Deno 2.8.2, Java 19+, Docker and the locked native DuckDB dependency. Supply
`FELDERA_JAR` if the digest-pinned compiler jar is not in the sibling compiler
cache. From the repository root:

```sh
just sayt -d plugins/pronto/spikes/duckstream/publication doctor
just sayt -d plugins/pronto/spikes/duckstream/publication build
just sayt -d plugins/pronto/spikes/duckstream/publication lint
just sayt -d plugins/pronto/spikes/duckstream/publication test
just sayt -d plugins/pronto/spikes/duckstream/publication integrate
```

Tests refuse stale compiler/translator build evidence. No app UI or runtime
changes, visual oracle, production deployment or browser acceptance are part of
this backend spike. `test` and `integrate` run the same live PostgreSQL
failure/replay probe; neither substitutes an in-memory sink.

## Validation and review

Sayt doctor/build/lint/test/integrate exited 0. The live gate exercises nine
grouped assertions, including actual PostgreSQL capture and publication.
Independent Astra/high backend review found the primary-key-mutation parser
hole; the immutable-key refusal and real WAL regression resolve it. Re-review
found no remaining issue. The simplification pass retained a single publication
transaction and ordinary SQL selection rather than adding a separate delivery
workflow. No production application changed.
