# Streaming SQL compilation for DuckDB

[[../compiler.ts|compileProgram]] runs the pinned DuckDB CLI (`1.5.6`) in
`:memory:` at build time, parses input `CREATE TABLE` declarations, introspects
the authored views into `schema.json`, and writes one DuckDB query per selected
output. The application
executes generated SQL against a supplied snapshot on Pages and Cloudflare, while
`release@docker` maintains the same authored materialized views incrementally in
RisingWave through [Mecha compute](https://github.com/bonisoft3/mecha/blob/v0.35.1/docs/compute.md).

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

The output directory contains `schema.json`, `<view>.sql` files, and
`manifest.json` (`format: 2`). Provenance hashes the authored source,
`schema.json`, every emitted `<view>.sql`, [[../translator.ts|the SQL lowerer]],
and [[../compiler.ts|the compiler driver]]. `checkCompiledProgram` needs no
subprocess: it validates `schema.json`, repeats lowering, and rejects stale
hashes or edited SQL. `compileSql` and `checkCompiledSql` select one `view`,
defaulting to `result`.

## Lowering and physical staging

[[../translator.ts|translate]] parses `CREATE TABLE`, `CREATE [LOCAL] VIEW`, and
`CREATE MATERIALIZED VIEW` declarations, rejects forward or recursive view
dependencies, collects only the transitive ancestor views of the requested
output as CTEs, and casts every output column to its declared portable SQL type.

`translatePhysical` lowers the same view DAG into named relational stages under a
required `__duckstream_` prefix followed by a final typed `SELECT`. Persisting
and checkpointing stages in order bounds intermediate DuckDB memory during
bounded snapshot execution without introducing a second query language.

## Portable SQL dialect

Authored Duckstream SQL shares one portable subset across RisingWave and DuckDB:

- `TIMESTAMP(6)` denotes timezone-free microsecond UTC instants; `TIMESTAMPDIFF`
  and AD epoch subtraction guard `isfinite(...)` before `epoch_us(...)` and
  truncate toward zero with integer `//` division.
- Unquoted `/` lowers to truncating integer division `//` in DuckDB to match
  PostgreSQL and RisingWave integer division.
- `FLOOR(x TO <unit>)` lowers to `date_trunc('<unit>', x)` for `YEAR`, `MONTH`,
  `DAY`, `HOUR`, `MINUTE`, and `SECOND`.
- `"POSITION"(needle, haystack)` lowers to `strpos(haystack, needle)`.
- `LEFT ASOF JOIN r alias MATCH_CONDITION(cond) ON eq` lowers to DuckDB's native
  `ASOF LEFT JOIN r alias ON (eq) AND (cond)`.
- Window clauses (`OVER`, `WINDOW`), aggregate `FILTER`, `DISTINCT ON`,
  `LIMIT`/`OFFSET`/`FETCH`, regex/pattern operators (`~`, `LIKE`, `ILIKE`),
  `LATERAL`, `QUALIFY`, `PIVOT`/`UNPIVOT`, sampling, and nondeterministic clock
  or random functions are rejected so RisingWave and DuckDB stay aligned.
