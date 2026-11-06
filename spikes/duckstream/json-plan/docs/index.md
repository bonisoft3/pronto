# Stock Feldera JSON → Deno → DuckDB

The pinned stock compiler exports enough information for this bounded relational
translator when invoked with `-i --alltables -v 1 --noRust --plan … --js …`.
[[../translator.ts|TypeScript]] consumes those two JSON files, produces DuckDB
SQL, and rejects unsupported exported requirements. [[../probe.ts|Deno]] invokes
the stock Java jar only at build time and executes the queries through the
pinned native `@duckdb/node-api@1.4.3-r.3` package. There is no custom Java or
Python.

The implementation now lives in [[../../../duckstream/docs/index|the reusable
compiler module]]; this component owns its stock-export and native-result
probes. Application builds use that module's driver and mandatory final-plan
diagnostic refusal guard. Raw JSON translation alone is insufficient: the stock
export omits aggregate FILTER metadata, including filters introduced from
conditional MIN/MAX expressions. The `filtered_aggregate` and `filtered_case`
probes reproduce the loss and reject both through the auxiliary guard. Missing
or truncated diagnostics also refuse.

This replaces the private Java API dependency for the tested optimized-plan
profile. It does not reproduce the previous [[../../contract/docs/index|source
syntax admission policy]], establish general Feldera compatibility, or change
the runtime/backend architecture.

## Export boundary

| Observation                                                      | Executable evidence                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Default verbosity omits projections, conditions, aggregate calls | `quiet_sum` and `quiet_min` export identical plans and schemas, although native results are 5 and 2          |
| `-v 1` retains those expressions and typed aggregate calls       | All translated fixtures use the verbose export; the quiet aggregate export is rejected                       |
| `--js` retains declared aliases and types                        | Identity projection loses its plan aliases; output names still come from the schema                          |
| LATENESS survives as a field annotation                          | `lateness` and `unused_lateness` are rejected; `--alltables` retains the unused annotated source             |
| append_only and emit_final survive as relation properties        | Both are rejected; emit_final is also checked after removing the independent lateness refusal in a test copy |
| Defaults survive as field metadata                               | `default_value` is rejected                                                                                  |
| Optimized-away source constructs are absent                      | `dead_now` and the unused UDF in `declaration_only` have identical verbose exports to `aliases_identity`     |
| JSON numbers can exceed JavaScript's exact integer range         | `large_literal` is rejected from its original numeric token before any rounded value reaches SQL             |

The compiler still performs its own DBSP compilation stages while exporting. The
`-i` flag is needed here for successful final-output/waterline validation; no
Feldera runtime executes. The stock command documentation describes the plan as
an optimized Calcite plan, not a versioned interchange contract:
[compiler usage](https://github.com/feldera/feldera/blob/main/sql-to-dbsp-compiler/using.md).
The jar hash and export-shape checks bound this experiment to one release.

The additional [[../results/alternatives/dataflow.json|dataflow export]] wraps
the same optimized Calcite plan, a lower-level operator graph and original SQL
text. It does not supply a parsed source declaration contract. The
[[../results/alternatives/jit.json|JIT export]] contains a `DBSPCircuit`, typed
closures, aggregate postprocessing and differential operators. Consuming that
representation would introduce a separate circuit interpreter or compiler; it
does not simplify the bounded relational translation established here.

The translator admits retained declarations and executable optimized operators.
A semantically dead volatile expression has no effect on the admitted relation,
but an export consumer cannot enforce a rule forbidding that expression anywhere
in authored SQL. Unused UDF declarations also disappear; optimized DISTINCT
becomes supported grouped relational operators and passes a duplicate/null
regression. Live NOW remains an unsupported operator and is rejected. No SQL
regex parser attempts to recover discarded syntax. Broader source-level
obligations require evidence that they survive export, or a separate
compiler-supported declaration/AST contract. Absence of an annotation in one
fixture is not proof that every Feldera feature is represented.

## Bounded computation

Scans, projections, filters, typed VALUES, UNION/UNION ALL,
inner/left/right/full joins, COUNT, SUM, MIN and MAX cover the measured
operators. INTEGER, BIGINT, BOOLEAN, VARCHAR, UUID, DATE, DOUBLE, DECIMAL(1..28,
scale 0..precision) and TIMESTAMP(6) have native DuckDB representations. DECIMAL
precision and scale are preserved in generated types and final output checks.
The decimal limit is this translator's explicit profile; wider Pronto decimals
belong in a native stage. Unknown operators, retained aggregate modifiers,
unsupported types, relation properties, defaults and case-insensitive identifier
collisions are refused. Final column names come from the schema by ordinal, and
aggregates/results are cast to Feldera's declared types so integer overflow
fails. Input rows must satisfy the declared schema and keys; this is a query
translator, not an ingestion validator. Nullability remains a declared schema
contract; DuckDB query metadata does not establish a NOT NULL constraint for
every expression.

Local views lower to shared CTEs and selected outputs preserve their declared
names. Nullable timestamp extrema and exact fixed-interval timestamp arithmetic
are covered by `timestamp_math` and `timestamp_corpus`. Elapsed seconds truncate
microsecond differences toward zero, including negative differences and values
straddling a second boundary. Integer `$SUM0` preserves zero for empty count
rewrites. `window_analytic` refuses diagnostic-only LAG/running-SUM exports;
`calendar_interval` refuses calendar arithmetic.

The ordinary expression profile includes `+`, `-`, `*` over
INTEGER/BIGINT/DOUBLE, numeric CAST except DOUBLE narrowing, UUID/DATE/integer
casts to unbounded VARCHAR, CASE, and COALESCE. CAST targets retaining a VARCHAR
width are refused: DuckDB ignores that width, including numeric and text values
longer than the requested width. The two stock `bounded_varchar` fixtures retain
the width and fail admission. Every integer arithmetic expression casts to its
inferred SQL integer width, so intermediate overflow fails. AVG is admitted only
on DOUBLE. DOUBLE uses the native approximate numeric model; the measured
fixtures use finite binary-exact fractions. This does not establish identical
floating point aggregation order across runtimes. DECIMAL projection and MIN/MAX
remain exact, including values beyond JavaScript's integer range. Decimal
arithmetic, SUM/AVG, non-null decimal literals and casts that narrow decimal
scale or integer capacity are refused. Widening decimal casts preserve both
capacities. Integer division and MOD admit only positive integer literal
divisors; division truncates toward zero and MOD takes the divisor's integer
type. VARCHAR POSITION and positive-start, nonnegative-length SUBSTRING preserve
Unicode characters and nulls. Dynamic integer bounds receive a runtime guard;
invalid literal bounds fail compilation. The optimizer's singleton VARCHAR
SEARCH form lowers to IN only with its pinned UTF-8/default-collation descriptor
and unknown-null semantics. Other SEARCH ranges fail. Approximate to integer
conversion and text parsing remain outside the profile.

`dashboard_scalars` checks signed arithmetic, negative epoch day floors, Unicode
string positions/substrings and null propagation. `union_values` checks
duplicate and null preservation across set and bag unions. `string_search`
checks singleton membership and nulls. TIMESTAMP literals at precision 0..3
retain exact exported milliseconds; higher precision is refused because stock
JSON discards fractional microseconds. The refusal fixture records that export
loss. `dynamic_substring` covers Unicode token slices, empty results, null
arguments and refusal of nonpositive starts or negative lengths.

[[../fixtures/ordinary.sql|Ordinary operators]], [[../fixtures/extrema.sql|group
extrema and average]], [[../fixtures/full_join.sql|full joins]],
[[../fixtures/right_join.sql|right joins]],
[[../fixtures/arithmetic.sql|arithmetic]] and
[[../fixtures/decimal_boundary.sql|decimal boundaries]] are actual stock
exports. Their native results are compared against independently specified rows,
including duplicate join matches, absent matches, null groups, leap-day DATE,
UUID and exact decimal extrema. Decimal shape errors, narrowing, arithmetic and
overflow have explicit refusal tests. The old MIN refusal became a positive
regression; the quiet SUM/MIN export collision remains independently rejected.

Fixed TUMBLE/HOP intervals use exact integer microseconds, a Unix epoch origin
and half-open membership. Intervals must export as integer milliseconds in fixed
DAY/HOUR/MINUTE/SECOND types, be positive and at most one day. HOP size must be
a multiple of slide with at most 100 memberships. Offsets, calendar intervals
and nullable/nonfinite timestamps are refused. Signed integer arithmetic handles
negative epochs. These are finite test-profile limits, not complete timestamp or
interval semantics across the two systems.

The JSON parser requires the numeric-token context supported by the tested Deno
2.8.2. It rejects integer tokens outside the exact JS range. Noninteger and
exponent tokens are retained as original text in a dedicated token object; only
typed DOUBLE literals consume them, emitting the original text into SQL.
Consequently JavaScript's rounded parse result never becomes SQL. Large BIGINT
and DECIMAL _input values_ remain exact through native DuckDB and are compared
as decimal strings. General exact literal support remains outside this profile.

## Golaberto stage boundary

The existing chances queries use LEFT JOIN, COUNT, MIN/MAX, CASE/COALESCE, UUID
identifiers and rating DOUBLEs. Those ordinary pieces now have executable
evidence here. Their complete SQL also needs DISTINCT plans, ASOF LEFT JOIN,
ordering, epoch conversion and FLOAT rounding. Ratings additionally uses
calendar year/week subtraction, TIMESTAMPTZ normalization, formatting,
subqueries and an explicit error function. This fixture set does not admit those
complete queries.

Normalize instants and calendar cutoffs in PostgreSQL or a native DuckDB stage,
pass declared native tables through the bounded Feldera stage, and perform ASOF,
final ordering/formatting and binary32 rating conversion in a subsequent DuckDB
stage. Cortex can make those stages and their types explicit. In particular,
all-15-type portable transport does not imply all-15-type Feldera arithmetic.
The existing Golaberto WASM request construction and execution stay unchanged.

## Run

Use Deno 2.8.2, Java 19+ and native DuckDB package support for the host
platform. The committed [[../deno.lock|lock]] pins npm artifacts. From the
repository root:

```sh
export FELDERA_JAR=/absolute/path/to/feldera-0.367.0.jar
just sayt -d plugins/pronto/spikes/duckstream/json-plan doctor
just sayt -d plugins/pronto/spikes/duckstream/json-plan build
just sayt -d plugins/pronto/spikes/duckstream/json-plan lint
just sayt -d plugins/pronto/spikes/duckstream/json-plan test
```

Without `FELDERA_JAR`, the jar path is the earlier compiler spike's local cache.
To obtain it explicitly, run
`deno run -A plugins/pronto/spikes/duckstream/json-plan/probe.ts extract`; Deno
calls the existing [[../../compiler/extract-jar.sh|digest-pinned image
extraction script]], then checks SHA-256
`d08430de8b34ae997b72c44eb9a9274b25955a41af35e7c6997e7e459d3283ab`. Extraction
needs Docker/network access. The checked-in compiler is never edited.

Build writes unmodified stock exports and generated SQL under `results`. Test
checks source hashes, independently computes expected window bags and runs the
native engine. [[../results/build.json|Build evidence]] records compiler/runtime
versions and flags. [[../results/tests.json|Executed results]] records relation
comparisons and refusals. Generated exports are excluded from formatting because
they are retained exactly as the compiler emitted them.

There is no browser, streaming-runtime, CDC, storage, retention or publication
proof in this component. Those belong to the other spike components. No design
oracle is required for this compiler experiment. Mechanical validation uses
Sayt, Deno, stock Java and native DuckDB commands.
