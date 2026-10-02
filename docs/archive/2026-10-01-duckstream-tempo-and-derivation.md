---
type: decision
title: DuckStream tempo and derivation invariants
description: Replaces physical pipeline flags with application-level tempo (hot vs cold) and operator endowments, proving screen-mutation feedback loops statically in CUE and verifying SQL algebra via DuckDB AST serialization.
status: built
---

# DuckStream tempo and derivation invariants

This decision defines the application-level contract for derived streaming data in Pronto. It formalises how pipelines declare their latency and algebraic operators, how CUE statically proves that active screen mutation loops remain sub-second (`hot`), and how Calcite/DuckDB relational ASTs enforce windowing invariants without parsing SQL in CUE.

## The problem: physical flags leak implementation details

In Pronto, storage mechanisms are abstracted behind user guarantees:
- An entity declares `durability: "offline"`, never `"postgres_with_electric_and_sqlite"`.
- A screen declares `reads: [{entity: "MonthStat"}]`, never `"indexeddb_cursor"`.

Previously, `#DuckStreamPipeline` exposed physical target flags (`format: "postgres" | "parquet"`). This was an inversion of control:
- An application does not inherently want "Parquet" or "Postgres tuples".
- An application wants a **temporal guarantee**: either an **instant operational reaction** inside the user's perceptual loop, or **settled historical intervals** for analytical reporting.
- A physical flag failed to prevent contradictions, such as attaching an interactive screen to a pipeline that batches for 10 seconds, or attempting in-memory incremental view maintenance over an unbounded sliding join.

## 1. The semantic dimension: `tempo`

A derived pipeline declares its application tempo rather than its storage sink:

```cue
#DuckStreamPipeline: {
	name:       string
	ir:         *name | string
	sql:        string
	sources:    [...string]
	sink:       string
	tempo:      *"hot" | "cold"
	operators?: [...("tumble" | "hop" | "session" | "distinct" | "interval_join" | "cross_join")]
}
```

- **`tempo: "hot"` (the default)**: Sub-second ($5\text{–}15\text{ms}$) operational view maintenance. Serves active screens, live counters, and budget headroom.
  - Server tier: Feldera DBSP differential circuit directly over PostgreSQL logical replication (`wal_level=logical`) to PostgreSQL table sink.
  - Browser tier: Optimistic reactive recomputation in DuckDB-WASM over local Arrow memory buffers.
- **`tempo: "cold"`**: Batched, windowed, or historical partitions ($1\text{s}\text{–}60\text{s}$). Serves closed periods, deep scans, and analytical cubes.
  - Server tier: `pg_duckpipe` flushes columnar Parquet partitions into DuckLake (`/lake/**.parquet`).
  - Browser tier: Mounted on-demand via `@mecha/lake` (`attachPublishedLake` with HTTP Range requests).

## 2. Static proof of the mutation loop in CUE

In Pronto, imperative component mutations are banned ([`no-fetch-in-components`](../../../../plugins/omnishell/src/lint/eslint/rules/no-fetch-in-components.ts)). Every TanStack DB mutation—whether a multi-field form, an inline checkbox, a drag-and-drop target, or a delete button—is structurally declared as a `#Form` on the screen.

Therefore, for any screen $S$:
$$\text{Mutated Entities } E(S) = \bigcup_{f \in S.\text{forms}} f.\text{entity}$$
$$\text{Observed Entities } D(S) = \bigcup_{r \in S.\text{reads}} r.\text{entity}$$

If a pipeline $P$ derives $P.\text{sink} \in D(S)$ from sources $P.\text{sources} \cap E(S) \neq \emptyset$, then $P.\text{sink}$ is **provably the derived mutation feedback loop $D(E)$ of screen $S$**.

A screen that mutates $E$ cannot wait for cold lake batching to see $D(E)$ change without the UI feeling broken. CUE proves this statically at compile time:

```cue
// Statically enforced in Pronto schema:
_hotViolations: [
	for plName, pl in state.duckstreams if pl.tempo == "cold"
	for sName, s in surface.screens
	if list.Contains([for r in s.reads { r.entity }], pl.sink)
	if len([for f in s.forms if list.Contains(pl.sources, f.entity) { f }]) > 0
	{
		pipeline: plName
		screen:   sName
		sink:     pl.sink
	}
]

if len(_hotViolations) > 0 {
	_hotRefusal: _|_ // Refusal: cold pipeline cannot feed an active screen mutation loop
}
```

## 3. Operator endowments and lint-time AST verification

CUE does not parse SQL. Following the model of Jessie `endowments: ["Intl"]`, advanced streaming operators are declared as pipeline endowments:

1. **Windowing Operators (`tumble`, `hop`, `session`)**:
   - A tumbling window (`TUMBLE(ts, INTERVAL '1' HOUR)`) cannot emit a final output until its watermark closes the window.
   - The query algebra is inherently window-batched; it cannot run `tempo: "hot"`.
2. **AST Verification**:
   - During `just lint`, Pronto invokes DuckDB's native parser:
     `SELECT json_serialize_sql(sql)`
   - The validator walks the relational AST. If `TUMBLE` or `HOP` appears:
     - It verifies `operators: ["tumble"]` was declared (undeclared operator $\implies$ lint error).
     - It verifies `tempo: "cold"` (declaring `tempo: "hot"` with tumbling windows $\implies$ lint error).

## 4. Cold computation on interactive screens

A screen is not monolithic; it displays both hot live needles and cold settled history:
- **Hot regions** display active state and running counters (live pulse / optimistic badge).
- **Cold regions** display finalized historical intervals (`DailyRollup`, `MonthlyArchive`). They update when watermarks close windows and display an "as of" timestamp.
Both read from standard collections (`reads: [...]`); the pipeline's declared `tempo` dictates whether the updates flow via live CDC or lake flushes.
