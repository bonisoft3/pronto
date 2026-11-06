# Native CDC and maintained output deltas

This bounded probe runs Feldera 0.367.0 and PostgreSQL 17.6 in disposable,
digest-pinned containers. Run from the repository root:

```sh
mise exec -- deno run -A plugins/pronto/spikes/duckstream/native-cdc/probe.ts
```

[[../results.json]] records observed results; [[../probe.ts]] owns the
assertions and [[../compose.yaml]] pins the dependencies. The probe removes its
containers and volumes even on failure. It requires Docker and the repository's
Deno toolchain.

## Verified behavior

Native `postgres_cdc_input` copies existing rows and streams subsequent
mutations. The qualified source name is `source_table: "public.a"`, with `uri`
and `publication` in the transport config. There is no separate `source_schema`
field. The source tables have primary keys and `REPLICA IDENTITY FULL`.

A PostgreSQL transaction updating two source tables becomes a torn relational
cut when one connector is paused: the join exposes the old left side and new
right side. Both eventually converge. A two-row transaction in one table did
**not** split in this execution, even with connector `max_batch_size: 1`; that
observation is not a transaction-atomicity guarantee.

`pairs EXCEPT ALL observed` and its reverse are materialized, incrementally
maintained views. After the pipeline reports `Paused`, source writes do not
change the queried cut in this probe. Resume the pipeline before submitting HTTP
ingress and awaiting its completion token: an awaited ingress request while
paused can stall. Advancing `observed` with the captured deletes and inserts
empties both pending views. Capture must be durable before advancing this
baseline; the probe checks relational behavior, not crash-safe publication.

Stopping and restarting the OSS pipeline with the same publication loses copied
rows while retaining its source cursor. A new publication identity reconstructs
all current source rows. This is a fresh current-state bootstrap, not historical
replay. Production must restore its durable observed baseline and fence the new
incarnation before publication.

## Boundaries and ownership

The pinned connector discards PostgreSQL `Begin`/`Commit` events and can divide
large input buffers. It does not expose a global transaction frontier across
connectors. A paused engine cut is therefore not necessarily a PostgreSQL
transaction-consistent snapshot. Consumers requiring that stronger contract must
reject this path until it has a separately proved admission boundary.

HTTP egress exposes sequence numbers and snapshot flags, but no
end-of-engine-step marker. The pinned HTTP output implementation ignores
`batch_start`'s step. Consequently its JSON chunks are not sufficient to
atomically assemble arbitrary multi-view output steps. Materialized pending
views plus a paused cut avoid relying on such a marker. This does not establish
atomicity of external writes: publication still needs one PostgreSQL transaction
and an idempotent, version-fenced receipt.

The connector derives its ETL identity as unsigned XXH3-64 of UTF-8 bytes:

```text
host:port/database\0publication\0schema.table
```

The separators are NUL bytes, port defaults to 5432, and credentials/query
parameters are excluded. Store the exact URI host spelling, publication, table,
unsigned pipeline ID and signed 64-bit equivalent in an ownership registry
**before starting** the connector. ETL stores IDs as signed `bigint`; slot names
use the unsigned decimal form. Apply slots are `supabase_etl_apply_<id>` and
table copy slots are `supabase_etl_table_sync_<id>_<table_oid>`. Never infer
ownership by listing all slots before and after startup on a shared source.

For each registered ID and table OID, bootstrap admission can require a current
`etl.replication_state` row with state `sync_done` or `ready`, plus the matching
live input's `barrier = false`. Missing state is not readiness. This is tied to
the pinned ETL internals, not a public stable readiness API; changing the
dependency requires revalidation. A fresh epoch prevents a prior incarnation's
`ready` row from masquerading as a completed new copy. `finished_copy` alone is
insufficient.

```sql
SELECT state, metadata
FROM etl.replication_state
WHERE pipeline_id = $1::bigint
  AND table_id = $2::oid
  AND is_current;
```

Fresh publications leave old ETL state and slots behind. Retire only registered,
stopped incarnations; drop exactly their registered slots after verifying them
inactive, then clean their ETL rows and publication. Neither safe
shared-database cleanup nor a production readiness gate is implemented by this
isolated probe.

## Source audit

The implementation details above come from pinned source:

- [Feldera CDC adapter](https://github.com/feldera/feldera/blob/v0.367.0/crates/adapters/src/integrated/postgres/cdc_input.rs):
  identity, copy barriers, ignored transaction events and input buffering.
- [Feldera HTTP output](https://github.com/feldera/feldera/blob/v0.367.0/crates/adapters/src/transport/http/output.rs):
  egress chunk boundaries.
- [ETL state schema](https://github.com/feldera/etl/blob/cdfb3c7e6581b63d8876c3c1b335b3a99e676c55/crates/etl/migrations/postgres_store/20250827000000_base.up.sql):
  current replication phases.
- [ETL slot identities](https://github.com/feldera/etl/blob/cdfb3c7e6581b63d8876c3c1b335b3a99e676c55/crates/etl-postgres/src/slots.rs):
  exact owned names.

The probe covers integer columns, a two-table join, EXCEPT ALL, pause/resume,
completion tokens and fresh bootstrap. It does not prove all Pronto types, large
single-table transaction atomicity, load throughput, or multi-table sink
publication across a process crash.
