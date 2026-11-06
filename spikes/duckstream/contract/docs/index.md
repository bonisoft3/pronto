# Feldera SQL contract backend spike

This experiment implements the narrow backend direction in the
[[../../../../docs/decisions/2026-10-20-duckstream-backend-contract|design decision]].
It uses Feldera's actual frontend at build time and DuckDB for evaluation. No
Feldera runtime engine runs. The acceptance oracle is the admitted computation
contract, with independently specified expected relations and window arithmetic;
it is not Feldera's internal schedule or a matching sequence of intermediate
outputs.

The [[../../compiler/docs/index|earlier compiler probe]] demonstrated that stock
Calcite conversion leaves HOP/TUMBLE unsupported. This spike adds explicit typed
lowering for a bounded subset. It does not change that earlier experiment or
install a new executor in Golaberto.

## Components

- [[../planner/ContractPlanner.java|Planner]] reads Feldera's parsed declarations
  and typed relational operators, rejects unsupported capabilities and emits
  DuckDB SQL. It does not rewrite authored SQL text. Its compiler version and
  artifact hash are pinned by [[../planner/generate.py|generation]].
- [[../planner/test_planner.py|Native contract tests]] assert independent window
  arithmetic, result schemas, relational cases, overflow behavior and refusal of
  unsupported source constructs.
- [[../history/probe.py|History probe]] starts a disposable PostgreSQL logical
  decoding source, commits CDC changes and replay receipts into genuine DuckLake,
  and evaluates generated SQL against retained versions. It tests publication
  in a DuckLake transactional test sink, not the production PostgreSQL Airlock
  path.
- [[../browser.mjs|Browser probe]] executes the generated SQL in Chromium's
  DuckDB-Wasm worker over explicit fixture snapshots. This proves evaluation
  portability for the admitted examples, not DuckLake storage or CDC in a browser.

## Admission boundary

This is a closed experimental profile, not general Feldera SQL support. The
[[../planner/admission.json|admission manifest]] states its capabilities; typed
plans and generated SQL live under `planner/results`.
The compiler inspects source declarations before optimization and the typed plan
before emission. Unrecognized requirements fail rather than lose their meaning.

The profile covers selected scans, projections, filters, inner joins and grouped
aggregates over admitted integer, string, boolean and timestamp values. Fixed
HOP/TUMBLE use positive whole-number day/hour/minute/second intervals of at most
one day; HOP requires size divisible by slide and caps overlap at 100. Offset,
calendar and compound/fractional intervals are refused. Window timestamps are
finite and non-null. Integer-microsecond bucket arithmetic handles negative
Unix timestamps without floating-point rounding. The result emitter casts
aggregates to the Feldera-declared output type; overflow is an error.
Declared result aliases survive frontend optimization. Case-insensitive name
collisions are rejected because DuckDB cannot represent those distinct names.

Lateness annotations, final-output properties, volatile time, UDFs, recursion,
unsupported types/functions and unsupported plan operators are not admitted.
The implementation and its negative tests are the authority for this finite
profile. A production capability manifest needs broader type/function coverage,
input validation and a maintained frontend interface.

## Retained input and publication boundary

The source is a real PostgreSQL 18 logical slot using `test_decoding`, with a
strict decoder for this fixture's two tables. The test creates the slot before
its fixture writes; it does not prove bootstrap over a populated source or
existing Conduit transport compatibility. It decodes complete transaction
boundaries and retains each row occurrence, including a transient insert/delete
that leaves no row in the final state.

One DuckLake transaction writes current rows, immutable changes and source replay
receipt/cursor. The transport cursor advances after commit. Failure before
commit leaves all three unchanged. Replaying after lost acknowledgment is
idempotent, and conflicting payloads under a reused source identity fail.
A pinned old snapshot can be reopened and evaluated after later source commits.

The sink test replaces complete results and stores signed bag differences with
publication receipts atomically. Rollback leaves neither sink nor receipt; a
lost publication acknowledgment does not duplicate the committed application.
One schedule publishes after each source transaction and another coalesces them.
Both independently meet the expected final relation while their publication
counts differ. The test intentionally does not require matching intermediate
traces.

Storage is local DuckLake with real Parquet files, a local DuckDB metadata catalog
and a hash-pinned extension. The runner records their actual versions. It retains
all snapshots for the experiment and removes its temporary data and container at
exit. This is a single-writer protocol fixture, not a multi-writer production
service or a durable storage benchmark. The production design still uses Cortex
and Airlock; this harness does not duplicate their implementation.

## Reproduce

From the repository root:

```sh
just sayt -d plugins/pronto doctor
just sayt -d plugins/pronto/spikes/duckstream/contract doctor
just sayt -d plugins/pronto/spikes/duckstream/contract setup
just sayt -d plugins/pronto/spikes/duckstream/contract build
just sayt -d plugins/pronto/spikes/duckstream/contract lint
just sayt -d plugins/pronto/spikes/duckstream/contract test
```

Setup needs Python 3.9+, Java 19+, Node/npm, Docker and network access. It installs
pinned Python/browser packages locally and extracts the hash-checked Feldera jar
from the pinned compiler image if absent. Test runs the native planner suite,
real PostgreSQL/DuckLake history probe, and actual Chromium worker in sequence.
No production data or the running Golaberto stack is used. The PostgreSQL
container uses a unique name and no host ports. Supported DuckLake extension
artifacts are pinned for macOS ARM64 and Linux AMD64/ARM64; other platforms fail.

The evidence files are outputs, not a substitute for the runner's exit status.
Re-running generation without all tests does not refresh all evidence. Run the
combined test gate to associate native, history and browser observations with
the generated query hashes.

## Executed evidence

The combined gate passed with Feldera frontend 0.367.0, native DuckDB 1.4.3,
PostgreSQL 18 and the pinned DuckLake extension. Chromium 147.0.7727.15 ran
DuckDB-Wasm 1.33.1-dev57.0, reporting engine v1.5.4.

- [[../planner/results/tests.json|Native results]]: 20 independent relation/window
  comparisons, two declared-schema regressions, 23 rejected unsupported programs,
  and required overflow/nonfinite-timestamp failures.
- [[../history/results.json|History results]]: two complete source transactions,
  ten retained changes, rollback/replay checks, historical reads after reopen,
  and eager versus coalesced publication with independent expected results.
- [[../results/browser.json|Browser results]]: 20 query/snapshot comparisons,
  including updates, deletions, duplicate values, negative timestamps and exact
  integers beyond JavaScript's safe range.

Sayt doctor, setup, build, lint and the combined test gate passed, as did the
Pronto documentation-link checks. Backend review found alias preservation and
identifier collision bugs; both received regressions. The finite-timestamp guard
also gained a COUNT-only regression to prevent optimizer pruning. The second
review found no remaining substantive issues within the stated spike scope.

## Remaining work

The spike does not establish arbitrary SQL compatibility, Feldera temporal
policies, complete numeric/error equivalence, production CDC bootstrap, the
Conduit adapter, source failover epochs, retention/garbage collection, concurrent
publication fencing, DuckLake-to-Airlock transactions, Pages history access,
Cloudflare/GCP deployment or production freshness/capacity limits. Those are
separate capability and integration gates. The successful direction is full
relational recomputation from retained input, not an incremental engine hidden
inside the adapter.
