# PostgreSQL snapshot-to-WAL bootstrap

[[../probe.ts|The executable probe]] establishes a real populated baseline and
hands off to its matching PostgreSQL logical slot. It uses PostgreSQL's exported
snapshot protocol; it does not reconstruct a consistency boundary from table
timestamps or unrelated WAL positions. [[../results.json|Retained results]]
contain the actual slot consistent point, exported snapshot, decoded
transactions, receiver states, receipts and acknowledgment positions.

## Executed contract

Two source tables contain rows before the slot exists. A replication-protocol
connection creates `bootstrap` with `LOGICAL test_decoding EXPORT_SNAPSHOT` and
stays open. One read-only `REPEATABLE READ` transaction imports that snapshot
and copies both tables with `COPY TO STDOUT`.

Between the two copies, another source transaction commits an update, delete and
insert in each table. A transaction opened before slot creation also inserts
into both tables and commits after snapshot export. Both copies still contain
exactly the original rows. This preopened transaction receives its XID only
after export; the test does not claim a transaction already holding a write XID
can bypass slot initialization's wait for older transactions.

The receiver is a separate PostgreSQL database in the same disposable server.
This deliberately small fixture uses native SQL transactions for these checks:

- A partially copied baseline is invisible from another connection. Closing the
  copying connection rolls it back. No complete-cut marker exists, and
  attempting to apply captured WAL is refused while bootstrap is incomplete.
- All baseline rows and the complete-cut marker commit together, using the
  actual exported snapshot and consistent point. The two decoded post-snapshot
  source transactions then apply atomically across both tables.
- After the first receiver commit, its connection closes without acknowledging
  the source slot. Peeking the slot redelivers exactly the same transactions.
  Applying the first again keeps one capture receipt and one effect receipt for
  its six mutations. Conflicting content under that commit identity is refused.
- The final receiver relation equals both the explicitly specified expected
  relation and an independent source query. There are two captured transactions,
  with six and two mutations; baseline rows have no duplicate WAL
  representation.
- Source acknowledgment advances to the final durably applied commit. No
  relevant WAL remains. A rolled-back source insert produces no captured
  transaction.
- Once the exporting connection closes, a new attempt to import its snapshot
  fails. Resuming an interrupted bootstrap requires an explicit new bootstrap
  lifecycle; an expired snapshot token is not a reusable checkpoint.

The interruption is a session close and native transaction rollback, and the
lost-ack interval is deterministic omission of acknowledgment. There is no OS
kill, network partition, or source failover in this test. The effect ledger is a
transactional fixture; external effects remain outside this proof.

## Ownership and remaining adapter

PostgreSQL supplies the snapshot/WAL boundary, MVCC reads, retained slot and
transaction boundaries. Its
[exported-snapshot documentation](https://www.postgresql.org/docs/17/logicaldecoding-explanation.html#LOGICALDECODING-EXPLANATION-EXPORTED-SNAPSHOTS)
explicitly connects the exported state with the following change stream. The
[replication protocol](https://www.postgresql.org/docs/17/protocol-replication.html)
defines the creation command and snapshot lifetime.

A production replication component should own this protocol: hold the export
session, import one snapshot for the required tables, keep staging ineligible
until complete, durably apply complete transactions and their deduplication
receipts, then acknowledge. A normal SQL query of current rows followed by a new
slot cannot substitute for that coupling. PostgreSQL's primitive removes the
need for a new snapshot algorithm, but does not implement a DuckLake adapter or
a complete-cut publication policy for it.

The [[../../replication/docs/index|existing pg_duckpipe experiment]] verifies a
useful table mirror and append transport, while observing separate table
commits. Its audited snapshot implementation is per table. Extending or
selecting an existing replication component to expose shared bootstrap and
transaction-cut metadata is preferable to promoting this fixture parser into a
CDC service. The [[../../publication/docs/index|publication harness]] separately
exercises DuckDB capture receipts and PostgreSQL publication. These probes do
not establish that those adapters are already connected in production.

`test_decoding` is PostgreSQL's diagnostic output plugin. The parser here
accepts only these two fixed integer tables with immutable keys; unexpected
records fail. It is not a `pgoutput` implementation. Production work still
includes schema and DDL handling, retained-version storage, restartable
bootstrap staging, bounded WAL retention, source epochs and slot invalidation,
failover, and an audited commit/ack path in the selected transport. Commit LSN
alone is an identity only inside this single-source fixture, not across
recreated sources.

## Reproduce

From the repository root:

```sh
just sayt -d plugins/pronto/spikes/duckstream/bootstrap doctor
just sayt -d plugins/pronto/spikes/duckstream/bootstrap build
just sayt -d plugins/pronto/spikes/duckstream/bootstrap lint
just sayt -d plugins/pronto/spikes/duckstream/bootstrap test
just sayt -d plugins/pronto/spikes/duckstream/bootstrap integrate
```

The runner checks Deno 2.8.2 and PostgreSQL 17.6. [[../compose.yaml|Compose]]
pins the same PostgreSQL image digest as the sibling runtime; `test_decoding`
and `psql` come from that image. There are no package dependencies or published
host ports. Each run has a unique Compose project and removes its own
containers, network and volumes on success or failure. Results are replaced only
after all assertions and cleanup succeed. `test` and `integrate` each run the
real fixture; no live application stack is used.

All five Sayt gates passed. Independent backend review found no actionable
issues. The simplification pass keeps snapshot ownership in PostgreSQL and the
fixture decoder deliberately narrow; it adds no production ingestion service.
