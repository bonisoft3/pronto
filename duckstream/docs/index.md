# Feldera SQL compilation for DuckDB

[[../compiler.ts|compileProgram]] runs the unmodified Feldera 0.367.0 compiler
at build time, admits its exported computation, and writes one DuckDB query per
selected output. The application executes generated SQL against a supplied
snapshot. The same authored materialized views can run in the native Feldera
engine through [Mecha compute](https://github.com/bonisoft3/mecha/blob/v0.22.0/docs/compute.md);
Pages keeps the snapshot adapter. Materialization of an output does not change
its generated snapshot query.

```ts
import { checkCompiledProgram, compileProgram } from "./compiler.ts";

const options = {
  sourcePath: "program.sql",
  outputDirectory: "compiled",
  views: ["result_session", "result_corpus"],
};
await compileProgram(options);
await checkCompiledProgram(options);
```

Compilation defaults to Java inside the digest-pinned Feldera container recorded
in `compiler.image`; Docker acquires that image when absent. It mounts the
source read-only and a writable output directory, runs with the host UID/GID and
the pinned compiler's supplementary group 1000, disables the container network,
and removes the compilation container. Linux and macOS are the tested host
profiles. An explicit `jarPath` uses a host Java 19+ process after checking the
exact compiler SHA-256; this is a development option, not an implicit
replacement for Docker.

The output contains stock `plan.json` and `schema.json`, retained final-plan
`diagnostics.json`, `<view>.sql` files, and `manifest.json`. Provenance hashes
the authored source, all artifacts, translator, compiler driver and diagnostic
guard. `checkCompiledProgram` needs neither Docker nor Java: it checks
diagnostic coverage, repeats admission and translation, and rejects stale hashes
or SQL. `currentCompilerHashes` lets a build adapter identify compiler-code
changes; unchanged hashes do not replace the full artifact check. Paths are not
embedded in provenance. `compileSql` and `checkCompiledSql` select one `view`,
defaulting to `result`.

## Admission and the export boundary

The implementation is tied to one compiler artifact and export profile, not a
general Calcite interchange format. `-v 1` preserves typed expressions and
aggregate calls. [[../translator.ts|The lowerer]] uses those JSON structures for
computation, resolves declared local views once into shared CTEs, rejects
recursive dependencies, and preserves declared output names and numeric widths.
It is a lower-level operation; application builds use the compiler driver so
admission cannot omit auxiliary evidence.

`translatePhysical` lowers the same admitted plan into named relational stages
and a final SELECT. Joins, ASOF joins, aggregates and local-view results become
separate tables, so their working buffers need not coexist. The caller supplies
a unique `__duckstream_` namespace, persists each stage in order, checkpoints
between stages, and drops the intermediates after persisting the output. Stage
rows are unordered; numerical consumers must restore their declared input order.
The ordinary `translate` output remains unchanged. This physical policy does not
rewrite authored SQL or introduce another query language.

Stock JSON omits aggregate `filterArg`. Both explicit `SUM(x) FILTER (WHERE p)`
and optimizer-created filters such as `MIN(CASE WHEN p THEN x END)` can
otherwise look like unconditional aggregates. Lower optimization level does not
remove this risk. [[../diagnostics.ts|The refusal guard]] therefore requests
stock `SqlToRelCompiler=2` diagnostics. Every exported non-internal view must
have a named declaration, before/after optimizer anchors, and a complete final
tree whose operator sequence, indentation and count match the JSON tree.
Missing, truncated, changed-format or filtered plans fail admission. The guard
only refuses computation; it never reconstructs SQL from diagnostic strings. Its
textual format is pinned by the same compiler hash, and artifact checks repeat
the guard. Express conditional aggregates using filtered relations and joins
when their optimized export passes this boundary.

Analytic `LogicalWindow` nodes are refused: partition/order/call/frame
information is exported as diagnostic strings rather than typed structured
calls. Author equivalent relational queries where practical; this module does
not parse those strings to implement LAG or running SUM. Ordered list
aggregation remains outside the profile.

## Timestamp and aggregate profile

TIMESTAMP means timezone-free microsecond `TIMESTAMP(6)`, including nullable
expressions and MIN/MAX results. Fixed integer-millisecond interval literals can
be added to timestamps with exact microsecond arithmetic. Timestamp subtraction
typed as `INTERVAL_SECOND` and cast to INTEGER/BIGINT divides elapsed
microseconds with truncation toward zero. Thus `.900000` to the next second's
`.100000` is zero elapsed whole seconds. Calendar intervals, sub-millisecond
interval literals, unsupported units, nonfinite arithmetic and overflow refuse.
The existing TUMBLE/HOP profile still requires non-null timestamps.

TIMESTAMP literals are admitted only with exported precision 0..3 and exact
integer milliseconds. Stock JSON truncates the fractional microseconds of
precision 4..6 literals, so those fail rather than silently changing the instant.
Literal milliseconds convert to microseconds using exact integer arithmetic.

Integer division and MOD require a positive integer literal divisor. Division
truncates toward zero; MOD has the dividend's sign and the divisor's integer
type. A normalized modulo expression can therefore implement floor division
before the Unix epoch. Dynamic, zero and negative divisors remain outside the
profile. POSITION accepts two VARCHAR operands; SUBSTRING accepts integer
bounds with a positive start and optional nonnegative length. Invalid literal
bounds fail compilation; dynamic bounds fail execution outside this domain.
Null arguments propagate before the bound check. These operate on Unicode
characters. Optimizer SEARCH is admitted only for singleton
VARCHAR ranges with unknown-null semantics and the pinned default UTF-8 string
descriptor. Other ranges, collations and null policies fail.

Typed literal VALUES rows and UNION/UNION ALL retain bag/set behavior and require
matching column types. They permit bounded calendar grids without a new source
table or JavaScript aggregation.

LEFT ASOF JOIN admits cross-input equality keys and a single left timestamp
`>=` right timestamp match. DuckDB executes a native ASOF join and preserves
unmatched left rows with nullable right columns. Inputs must supply unique
right-side key/timestamp pairs when the application needs deterministic tie
selection; neither translation nor source transport invents a tie breaker.
Other match directions, strict inequalities and inner ASOF joins are refused.
The executable probe covers exact microsecond boundaries, missing and null keys,
null timestamps, duplicate left rows, and malformed exported match conditions.

Integer `$SUM0` lowers to checked `COALESCE(SUM(...), 0)`, preserving the empty
COUNT/DISTINCT rewrite. VARCHAR concatenation retains SQL null propagation; CHAR
literals are exact string constants, while general CHAR input/cast semantics
remain unsupported. The module does not validate source row constraints or
define timezone normalization, snapshot consistency, publication, or transport.

Plausible compares generated results with its independent DuckDB oracle.
