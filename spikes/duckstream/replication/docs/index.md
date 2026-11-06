# Existing replication engine probe

[[../probe.ts|Deno runner]] exercises the published pg_duckpipe service with real
PostgreSQL and DuckLake. It delegates snapshotting, WAL consumption, flushing and
recovery to that engine. It contains no custom CDC worker. The experiment compares
an eventual current-table mirror and an append occurrence feed with the stronger
transaction-consistent input-cut requirement in the
[[../../contract/docs/index|earlier contract fixture]]. Independent intermediate
refreshes remain useful when the program permits them.

## Executed observations

[[../results.json|Machine-readable results]] records the pinned image and source
identity, actual versions, rows, retained snapshots and replication metadata.
The acceptance gate asserts the following positive and negative observations:

- Bootstrap starts after source rows exist. Two upsert targets contain the
  independently specified initial relations. The append target receives its
  initial row with operation `I` and LSN zero. This baseline does not recover
  occurrences that happened before bootstrap.
- A source transaction updates an event, deletes another and changes an account.
  The current-table targets eventually equal the expected relations.
- The same transaction updates an append-mode row, then inserts and deletes a
  transient row. The append target retains both transient operations, with
  distinct nonzero record WAL positions. This tests occurrence retention, which
  the current-table profile does not require.
- Even with `REPLICA IDENTITY FULL`, the delete record contains only the primary
  key; its non-key amount is null. The update record has the new value, without
  a separate old-image row. This output is not a complete before/after journal.
- The source transaction produces separate DuckLake commits. Reading both tables
  at every retained snapshot finds a cut where only one table reflects the
  transaction. The final cut converges. This disproves atomic visibility across
  these tables; it does not disqualify eventual statistics.
- After the worker stops, a new source transaction commits into the backlog.
  The container receives `SIGKILL`, then restarts using its existing disposable
  storage; the runner explicitly starts the worker. Both tables converge, the
  append backlog arrives, prior occurrences
  remain unduplicated, and the old DuckLake snapshot remains readable.
- The source slot acknowledgment equals the minimum table applied LSN after
  convergence and advances after recovery. This checks progress against the
  engine's reported frontier; it does not inject the commit-to-ack crash window.

The initial rows and expected changes are independently specified in the test.
Waiting for row counts is followed by exact content comparisons. Source and target
run inside one disposable container, with a unique name and no published host
ports. Cleanup removes that container and its anonymous volume, including on
assertion failure. The test does not access the live stack.

## Source audit

Setup verifies OCI build provenance against pg_duckpipe commit
`86d5c248d80370fb2e10ddc1abd780fd94c3a52b`; both published CPU variants report it.
The image index is pinned by digest in the runner, and the provenance identifies
pg_ducklake commit `20d799e673639fb0c36a3b31db413e45057a10ed`. These are observations
of the publisher's provenance, not an independent reproducible-build attestation.

The audited implementation explains the observed boundary:

- [WAL ingestion](https://github.com/relytcloud/pg_duckpipe/blob/86d5c248d80370fb2e10ddc1abd780fd94c3a52b/duckpipe-core/src/service.rs#L330)
  dispatches individual changes to table queues. It parses but discards the
  transaction ID and commit LSN. The append metadata therefore has a record
  WAL position and operation, without a transaction boundary or ordinal. The
  delete branch extracts primary-key values even when the WAL old tuple is full.
- [Flush implementation](https://github.com/relytcloud/pg_duckpipe/blob/86d5c248d80370fb2e10ddc1abd780fd94c3a52b/duckpipe-core/src/duckdb_flush.rs#L615)
  appends operations in append mode; upsert mode compacts by key and retains the
  latest operation. Each target flush has its own DuckLake transaction.
  Append recovery filters against the target's greatest recorded LSN. This
  is source-level evidence of replay handling, not this probe's proof of the
  precise lost-acknowledgment window.
- [Snapshot implementation](https://github.com/relytcloud/pg_duckpipe/blob/86d5c248d80370fb2e10ddc1abd780fd94c3a52b/duckpipe-core/src/snapshot.rs#L90)
  establishes a repeatable-read copy per table and inserts append baseline rows
  with LSN zero. A concurrent global bootstrap cut is not established here.
- [Coordinator](https://github.com/relytcloud/pg_duckpipe/blob/86d5c248d80370fb2e10ddc1abd780fd94c3a52b/duckpipe-core/src/flush_coordinator.rs#L1358)
  updates PostgreSQL metadata after committing a target flush.
  [Heartbeat processing](https://github.com/relytcloud/pg_duckpipe/blob/86d5c248d80370fb2e10ddc1abd780fd94c3a52b/duckpipe-core/src/service.rs#L840)
  acknowledges the minimum applied position. That replication progress value
  does not turn previously committed per-table versions into one atomic source
  transaction snapshot.

The evidence supports using pg_duckpipe for the tested mirror and occurrence
transport profiles. A stronger adapter needs transaction membership and a
published complete-cut protocol, or a deliberately narrower contract. An
occurrence program needing deleted non-key values needs reconstruction or a
transport that retains those values. Neither addition is hidden in this probe.

## Reproduce

From the repository root:

```sh
just sayt -d plugins/pronto/spikes/duckstream/replication doctor
just sayt -d plugins/pronto/spikes/duckstream/replication setup
just sayt -d plugins/pronto/spikes/duckstream/replication build
just sayt -d plugins/pronto/spikes/duckstream/replication lint
just sayt -d plugins/pronto/spikes/duckstream/replication test
```

The runner pins Deno 2.8.2 and the OCI image digest. Docker must be running;
setup requires Docker Buildx and network access to inspect image provenance.
There are no package dependencies. Setup stores verified identity in ignored
`.cache/identity.json`; test consumes it and replaces `results.json` only after
all assertions and cleanup succeed. The recorded result cannot substitute for
the command's exit status.

Unproved capabilities include the exact crash interval between target commit
and PostgreSQL acknowledgment, forced WAL redelivery, concurrent global
bootstrap, source failover epochs, broad data types, production throughput,
retention expiry and concurrent publication. Restart success alone is not an
exactly-once guarantee. The test gate passes when all its stated observations,
including the negative capability checks, hold.
