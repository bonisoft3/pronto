# Duckstream runtime spikes

These experiments inform the proposed [[../../../docs/decisions/2026-10-19-duckstream-runtime|Pronto
runtime design]]. They do not install a Duckstream executor in Pronto or modify
Golaberto. The fixtures use synthetic accounts/events and a generic batch
consumer so the engine contract is independent of its first application.

| Experiment | Executed evidence | Interpretation |
| --- | --- | --- |
| [[../workerd/docs/index|DuckDB in a Durable Object]] | Local workerd restart and deployed Cloudflare queries with static WASM imports | DuckDB, JSON and ICU work without a Container; full app memory, isolation and free-tier capacity remain unproved. |
| [[../bootstrap/docs/index|Consistent bootstrap]] | Exported PostgreSQL snapshot paired with logical WAL | Tests initial input readiness and replay boundaries under concurrent changes. |
| [[../generation/docs/index|Atomic output generations]] | PostgreSQL multi-table replacement and receipt in one transaction | Tests complete generation publication, retries and visibility; contrasts independent table delivery. |
| [[../publication/docs/index|Replay-safe publication]] | PostgreSQL capture, pure WASM and translated authoritative-result SQL with a transactional sink | Tests overlapping replacement batches and failure recovery; see exact evidence and exclusions. |
| [[../postgres-sink/docs/index|Native PostgreSQL sink]] | Pinned Feldera view materialization and replay behavior | Separates stock connector behavior from the stronger guarded sink contract. |
| [[../feedback/docs/index|SQL feedback coordination]] | Compiled eligibility query and local transactional execution authority | Dirty/runnable work comes from retained input and feedback; see the spike for executed cases and integration limits. |
| [[../json-plan/docs/index|Stock JSON frontend]] | Verbose stock Feldera exports translated by Deno; 24 native comparisons and 14 refusal cases | No custom Java/Python for the tested profile. Default verbosity is lossy; executable requirements and retained declarations define admission. |
| [[../replication/docs/index|Existing replication engine]] | Pinned pg_duckpipe populated bootstrap, mutations, append history and SIGKILL recovery | Useful eventual mirror and occurrence transport. Per-table flushes expose partial source transactions; deletes omit non-key values. |
| [[../contract/docs/index|Contract backend]] | Typed window lowering, retained logical CDC/DuckLake versions and native/browser contract tests | A bounded Feldera SQL backend without reproducing engine internals; see its exact admission and evidence. |
| [[../compiler/docs/index|Compiler bridge]] | Feldera 0.367.0 typed plans through stock Calcite DuckDB dialect; native and real Chromium execution | Ordinary join/filter/aggregate values agree; types differ. TUMBLE/HOP SQL is rejected by both DuckDB engines. |
| [[../runtime/results.json|CDC and temporal delivery]] | Pinned Feldera OSS and PostgreSQL containers, exact-row assertions | Bootstrap, retractions, window membership, connector skew, finalization and lifecycle behavior. Expected limitations are asserted, not treated as supported features. |
| [[../machine/docs/index|Batch coordinator]] | Seven tests using Mecha's actual compiler and bounded reducer executor | Immutable claims, pending invalidations, fenced attempts and publication acknowledgment; no durable adapter or database crash proof. |

## Reproduce

The [[../compiler/docs/index|compiler experiment]] has its own pinned Java,
Python and browser instructions. From the repository root, the machine gates are:

```sh
just sayt -d plugins/pronto doctor
just sayt -d plugins/pronto/spikes/duckstream build
just sayt -d plugins/pronto/spikes/duckstream lint
just sayt -d plugins/pronto/spikes/duckstream test
just sayt -d plugins/pronto/spikes/duckstream integrate
```

`integrate` runs [[../runtime/run.sh]], which recreates **only** the
`pronto-duckstream-spike` Compose project and its disposable source data, builds
the SQL pipeline, and executes [[../runtime/probe.py]]. It needs Docker, Python
3.9+, network access for initial image pulls, and localhost port 18089. The
Feldera image contains its compiler dependencies; the optimized profile uses
that cache. First startup and circuit compilation take minutes. Both images are
pinned by digest in [[../runtime/compose.yaml]]. These are local development
credentials for the isolated test database.

The stack remains available for inspecting results or debugging a failed gate.
Remove it afterward with:

```sh
docker compose -f plugins/pronto/spikes/duckstream/runtime/compose.yaml down --volumes
```

Do not run `probe.py verify` twice on a mutated source. `integrate` deliberately
creates a fresh fixture. A failed assertion exits nonzero and does not replace
the last successful `results.json`; rerun output, not an old evidence file,
determines whether a gate passed.

## Runtime observations

The CDC fixture uses actual `postgres_cdc_input` connectors. PostgreSQL writes
are observed through incrementally maintained Feldera materialized views.
Feldera's ad-hoc SQL endpoint reads those results for assertions; it is not a
DuckDB translation test.

- Snapshot bootstrap yields totals 30 and 30. An older event adds 7, a correction
  changes it to 12, and a delete retracts it. Editable source timestamps have no
  lateness bound.
- Five-second tumble boundaries are half-open: the event exactly at `00:00:05`
  belongs to the next window. A ten-second hop sliding by five seconds assigns
  overlapping windows, including one starting on the previous date. Assertions
  include the actual start/end timestamps.
- Pausing the account connector and committing one transaction changing both
  account and event revisions exposes account revision 0 joined to event revision
  1. Resuming it converges to 1/1. This is a controlled skew counterexample to
  treating independent table consumption as a transaction frontier, not a claim
  about how often the skew occurs without intervention.
- A separate append-only test input declares two-second lateness. A final
  five-second window remains absent after six seconds of idle wall time; a later
  timestamp advances progress and releases it. This input's contract must not be
  applied to mutable historical business records.
- The OSS checkpoint API responds with HTTP 501 and `EnterpriseFeature` for
  `checkpoint`. Verification asserts that exact class of refusal; unrelated
  server errors fail the gate. No Enterprise recovery test is claimed.
- Pause/resume preserves the existing totals and consumes changes made while
  paused. A forced stop/start with storage disabled loses the old circuit rows
  while retaining the CDC cursor. After a new account/event commits, the circuit
  contains only its total of 50; PostgreSQL still has all three totals, 31, 30
  and 50. This is an asserted counterexample, not a successful recovery test.

The first exploratory startup used parallel connector initialization and failed
with `duplicate key value violates unique constraint "pg_namespace_nspname_index"`
while creating the shared `etl` schema. The reproducible fixture sets
`max_parallel_connector_init: 1`. Deployment bootstrap must serialize these
migrations or provision them explicitly; this one-host setting is not a lock
across multiple pipeline managers. Production runtime grants and administrator
bootstrap remain a separate acceptance case.

## Review and limits

Backend review found two missing runtime assertions: exact window boundaries and
the expected checkpoint refusal. Both were added. The compiler and pure machine
reviews found no further actionable issue. Review ran on Astra/high; the lead
retained its current model. No UI design oracle is needed for this infrastructure
spike. Chromium executes the generated query directly; no app screenshots or
product journal are claimed.

Observed gates: Pronto doctor, spike build/lint/test, and the fresh-stack spike
integration all exited 0. The compiler's native and Chromium runners exited 0,
asserting ordinary results and expected window rejection. The runtime report is
the output of the final fresh-stack integration, including pause/resume and the
non-checkpointed restart counterexample. Documentation wikilinks resolve.

Cloudflare and GCP deployment choices are researched design in the linked
decision, not cloud deployments performed by these tests. The separate contract spike adds bounded window lowering. No Substrait execution,
arbitrary SQL compatibility, durable Mecha job dispatch in these probes,
multi-replica publication, or production freshness bound has been proved.
