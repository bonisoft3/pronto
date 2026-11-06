---
type: reference
title: Atomic multi-table PostgreSQL generations
---

# Atomic multi-table PostgreSQL generations

This spike publishes one complete computation result across two PostgreSQL
tables with exactly-once observable local effects. The whole generation is the
unit of replacement: absent rows disappear, either table may be empty, and an
empty generation deletes both results. Its [[../sink.sql|SQL finalizer]] uses
one ordinary PostgreSQL transaction and a locked scope row. It adds no delivery
worker, staging scheduler, distributed lease, or acknowledgement database.

The [[../native.ts|native integration]] connects stock Feldera `postgres_output`
in materialized mode to one PostgreSQL ingress row. An `AFTER INSERT OR UPDATE`
trigger calls the finalizer in the connector's transaction. The
[[../program.sql|Feldera SQL]] selects the newest **complete envelope** for one
scope, not independently selected per-key maxima. Final tables,
active-generation completion, immutable receipt and local hook become visible
together. The ingress row is a mutable transport cache and can contain an old
delivery after restart; only the final tables and generation head are
authoritative. Ingress CDC must not feed the computation input.

## Trusted producer and receipt

The producer is authorized for the fixed `accounts/v1/source-1` program/source
incarnation. It supplies an increasing positive generation identity, both result
tables and a SHA-256 digest fixed when its complete computation finishes. The
fixture creates these complete results directly; it does not integrate the prior
spike's computation runtime or invent coherence from per-key candidate maxima.

The digest uses UTF-8 bytes of PostgreSQL JSONB's text representation. Object
key ordering is canonicalized by that representation; array ordering remains
part of the immutable payload. This is a pinned PostgreSQL encoding contract,
not a portable cross-database JSON canonicalization standard. A real producer
must retain its exact envelope and digest across retries. The fixture asks
PostgreSQL to compute that digest before delivery.

A digest verifies that delivered content matches the admitted envelope,
including same-count substitutions. It cannot prove that an authorized producer
computed correctly or supplied every source-derived row. A partial result with a
freshly computed digest could pass; semantic completeness is the producer's
contract. The finalizer rejects missing table fields, malformed rows and
mismatched hashes. There is no partial-table staging protocol: the complete
envelope is the smallest activation request, and a partially delivered newer
request has no effect.

Receipts are keyed by generation within the fixed scope and retain the complete
JSONB payload, digest and original outcome. A reused generation with different
payload is an error. A repeated accepted generation returns its original
receipt, which does not mean it is still active. An unseen older generation gets
a `superseded` receipt without changing result tables or firing a hook.
Publisher roles can call the function or write ingress, but cannot directly edit
the head, receipts or results. This trust boundary excludes database owners and
arbitrary writer handover.

## Atomicity and its limits

The [[../probe.ts|real PostgreSQL failure probe]] first commits two independent
table deliveries separately and observes accounts totaling 15 while the summary
still totals 30. Independent table connectors do not share a transaction; their
successful delivery guarantees cannot imply cross-table snapshot coherence.

The finalizer serializes complete generations using `SELECT ... FOR UPDATE`,
then replaces both tables and records completion, receipt and one local hook in
the same transaction. Tests fail between table replacements, replay after a
successful COMMIT whose application acknowledgement was discarded, race two
PostgreSQL sessions, send incomplete envelopes and remove all rows. A single SQL
statement reads head and both tables under one MVCC snapshot and sees a whole
old or new generation. Separate statements at READ COMMITTED can span commits;
use one statement or a repeatable-read transaction when a consumer requires
coherence.

The hook is a transactional database row. External HTTP calls, external CDC
consumers and independently replicated target tables are outside this atomic
boundary. An external CDC reader must preserve transaction boundaries before
claiming the same observation guarantee. Input bootstrap, durable source
capture, computation recovery, source coverage vectors, generation allocation,
retention, large-envelope chunking, throughput and HA remain separate concerns.

Fault injection throws a SQL exception between writes and throws in the client
after successful COMMIT. It does not kill PostgreSQL, interrupt the OS or cut a
network connection. The native runtime is explicitly restarted without retained
candidate state, then receives the older complete generation before the current
one. PostgreSQL's head fence and receipt survive that native replay.

## Run and evidence

Use Deno 2.8.2 and Docker. PostgreSQL 17.6 and Feldera 0.367.0 use digest-pinned
images from [[../compose.yaml|Compose]], in the isolated
`pronto-duckstream-generation` project. The native integration binds only local
port 18092. Each live probe removes its own containers and volumes on exit.

From the repository root:

```sh
just sayt -d plugins/pronto/spikes/duckstream/generation doctor
just sayt -d plugins/pronto/spikes/duckstream/generation build
just sayt -d plugins/pronto/spikes/duckstream/generation lint
just sayt -d plugins/pronto/spikes/duckstream/generation test
just sayt -d plugins/pronto/spikes/duckstream/generation integrate
```

[[../results/build.json|Build evidence]] pins the finalizer source used by
[[../results/tests.json|failure and concurrency assertions]]. The separate
[[../results/native.json|native connector evidence]] records complete-generation
activation, empty output, restart replay fencing and unchanged hook counts. No
application runtime or UI changes belong to this spike.

All five Sayt gates passed. Independent backend review found no actionable
issues. The simplification pass retained one complete envelope and one SQL
finalizer; staging and a separate delivery worker are unnecessary for this
bounded fixture.
