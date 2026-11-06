# Native PostgreSQL sink

This spike executes authored SQL on native Feldera 0.367.0 and writes through
its stock `postgres_output` connector to PostgreSQL 17.6. Both Docker images are
pinned by digest in [[../compose.yaml]]. It isolates sink behavior from the
DuckDB compiler and browser runtime: HTTP supplies already-computed candidates
representing overlapping result versions. It does not exercise PostgreSQL CDC
input, calculate event-time windows, or provide a production recovery protocol.

[[../program.sql]] stores each `(id, version)` candidate, selects the maximum
version per key, and joins back to its payload. The indexed materialized view
contains one authoritative row per key. Deletes remain explicit versioned
tombstones; physically removing them would discard the version barrier.

## Observed contract

[[../results/integration.json]] retains real native-runtime observations and the
PostgreSQL trigger audit. The integration gate asserts both successful behavior
and the counterexamples; a green gate does **not** certify exactly-once
delivery.

| Scenario                                                | Committed PostgreSQL behavior                                |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| Version 20, then late version 10                        | Keeps version 20                                             |
| Replay the same version 20 while running                | No additional trigger invocation                             |
| Version 30 tombstone, then late live version 25         | Keeps the tombstone                                          |
| Stop/start without checkpoint                           | PostgreSQL retains its row; Feldera candidate table is empty |
| Replay version 10 against retained version 30 tombstone | Regresses to version 10 and resurrects the payload           |
| Restore version 30, stop/start, replay version 30       | Row value is unchanged; an additional UPDATE trigger fires   |
| Request checkpoint                                      | HTTP 501 `EnterpriseFeature`                                 |

The first live interval commits exactly two writes: INSERT version 20, UPDATE 20
→ 30. The full audit then contains UPDATE 30 → 10, UPDATE 10 → 30, and UPDATE 30
→ 30. Thus the last replay adds one durable side effect even though its final
logical row is identical. The probe waits for Feldera's
`total_completed_records` counter after each ingress request, covering output
connector completion before inspecting negative cases.

The max-version relation protects a running pipeline whose candidate history is
present. It cannot protect a preexisting PostgreSQL row after that history is
lost. Unconditional target writes can regress visible rows during rebuild,
resurrect tombstones, and repeat trigger side effects. This rules out claiming
exactly-once PostgreSQL effects from this stock sink plus an in-memory version
relation. A destination version/idempotency fence with durable recovery
coordination is a separate design, explored in
[[../../publication/docs/index.md]]. This test does not determine enterprise
checkpoint behavior or simulate a lost commit acknowledgement.

## Paired PostgreSQL guard

The same native view also writes to `guarded`, which adds the `guard_version`
trigger in [[../target.sql]]. INSERT checks an existing row; UPDATE checks its
locked `OLD` row, including the UPDATE reached through an insert conflict. Lower
versions and equal identical payloads produce no row change. Equal versions with
different payloads, key mutation, and physical DELETE raise an error. The latter
two are outside the append-only candidate protocol.

Across the same restart/replay sequence, the guarded row remains the version 30
tombstone. Its AFTER trigger audit contains only INSERT version 20 and UPDATE 20
→ 30, while the bare target commits five effects. This demonstrates that the
native connector can use a minimal PostgreSQL guard for these per-key replay
cases. The guard is additional destination logic; the connector itself does not
acquire version semantics. This gate does not cover competing writers,
equal-version conflicts, trigger rejection recovery, or a transaction that
coordinates input position with multiple published keys.

## Pinned implementation

The inspected
[v0.367.0 connector statements](https://github.com/feldera/feldera/blob/v0.367.0/crates/adapters/src/integrated/postgres/prepared_statements.rs)
implement INSERT with unconditional `ON CONFLICT ... DO UPDATE`, UPDATE matched
by key, and DELETE matched by key. None compares candidate version against the
target version. The
[v0.367.0 connector contract](https://github.com/feldera/feldera/blob/v0.367.0/docs.feldera.com/docs/connectors/sinks/postgresql.md)
requires an indexed unique key. Its `on_conflict_do_nothing` option changes
INSERT conflicts only; it does not fence UPDATE, so it cannot supply the missing
version contract. The
[v0.367.0 completion metrics](https://github.com/feldera/feldera/blob/v0.367.0/crates/adapters/src/controller/stats.rs)
define completed records to include processing by output connectors.

## Run

From this directory, run `sayt doctor`, `sayt build`, `sayt lint`,
`sayt integrate`, then `sayt test`. `test` checks retained execution evidence;
`integrate` reruns the real containers and refreshes that evidence. Deno
orchestrates the API and PostgreSQL client without additional dependencies. The
observed tool versions are Deno 2.8.2 and Docker Engine 29.2.1.

The stack uses Compose project `pronto-duckstream-postgres-sink` and binds only
`127.0.0.1:18091` for Feldera. PostgreSQL is reachable inside that stack only.
The integration command removes its containers and volumes in `finally`.

## Validation and review

Sayt doctor/build/lint/integrate/test exited 0, and the isolated Compose project
was removed. Independent Astra/high backend review found no actionable issue
within the documented replay scope. The simplification pass retained one SQL
view feeding both targets, so their destination guard is the only publication
policy difference. There is no app UI change or browser acceptance claim.
