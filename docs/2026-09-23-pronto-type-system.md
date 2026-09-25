# The Pronto Language Type System

An entity's fields are typed, and what an entity is — the identity those types
hang from — is [[2026-09-21-an-entity-is-what-everything-points-at.md]].

The core principle: **a type system is an application and language concern, not
an engine concern. Neither Mecha nor Omnishell owns or defines a type system.
The entity type system belongs exclusively to the application and its compiler
(Pronto). The engines expose generic configuration surfaces with arbitrary code
execution at data boundaries, and the database enforces canonical
representations natively via SQL migrations.**

This document defines the complete Pronto type system: its taxonomy, the
canonical value representation each type owes, the comparators that order them,
its declaration as program data, its compilation to engine boundary execution
hooks, and how screens bind and serialize values across UI controls.

---

## 1. The Type Taxonomy

A field's type is drawn from two borrowed sets — proto3 scalars and RFC/ISO
standards — kept explicit so the origin and standard of every definition is
visible in the schema:

```cue
#ProtoType: "string" | "bool" | "int32" | "int64" | "double" | "bytes"
#RfcType:   "uuid" | "timestamp" | "date" | "time" | "timezone" | "duration" | "decimal" | "json" | "geojson"
#Type:      #ProtoType | #RfcType
```

Beside the 15 field types, Pronto provides **three identity metadata types**
governing entity lifecycle and replication: `type_id`, `entity_ref`, and `txid`.

### The Core Invariant: Canonical Equality

Membership is governed by one rule:

> **Every type has a standard and a canonical representation, such that two
> values are equal if and only if their canonical strings are.**

This makes string equality the correct equality test across every tier,
including tiers with no type system at all — Parquet files in an object store,
rows in `localStorage`, or change events on an event bus. Cross-tier
disagreement stops needing pairwise conversion matrices and gets one oracle: a
suite of golden vectors per type pushed down every path the cluster executes at
`integrate`.

| Type | Standard | Canonical Value Form | PostgreSQL Domain / Type | String Order is Value Order |
|---|---|---|---|---|
| `string` | Unicode | UTF-8 scalar values, no U+0000, no normalisation | `TEXT` (deterministic collation) | Yes, by code point |
| `bool` | proto3 | `true`, `false` | `BOOLEAN` | — |
| `int32` | proto3 | Decimal digits, no leading zeros, no `-0` (`-2147483648`..`2147483647`) | `INTEGER` | No (numeric comparator) |
| `int64` | proto3 | Same decimal digits, formatted as a JSON string per proto3 | `BIGINT` | No (integer comparator) |
| `double` | IEEE 754 | RFC 8785 canonical JSON number; `NaN` and `±Infinity` refused | `DOUBLE PRECISION` | No (numeric comparator) |
| `bytes` | RFC 4648 | Canonical Base64 string | `BYTEA` | No |
| `uuid` | RFC 9562 | Lowercase, hyphenated 36-char string (`00000000-0000-0000-0000-000000000000`) | `UUID` | Yes |
| `timestamp` | RFC 3339 | UTC marked by `Z`, fixed 6 fractional digits (`YYYY-MM-DDTHH:MM:SS.USZ`) | `portable_timestamp` (`TIMESTAMPTZ`) | Yes |
| `date` | RFC 3339 | Calendar date: `YYYY-MM-DD` | `portable_date` (`DATE`) | Yes |
| `time` | RFC 3339 | Wallclock time: `HH:MM:SS.US` (microsecond precision) | `portable_time` (`TIME`) | Yes |
| `timezone` | IANA TZDB | Canonical identifier from tzdb (e.g. `America/Sao_Paulo`, `UTC`) | `portable_timezone` (`TEXT`) | No |
| `duration` | RFC 3339 App. A | Total seconds: `PT5400S`, microsecond precision; no month/day component | `portable_duration` (`INTERVAL`) | No (duration comparator) |
| `decimal` | XSD 1.1 `decimal` | Exact fixed-point string, no leading zeros, no exponent | `portable_decimal_P_S` (`NUMERIC(P, S)`) | No (decimal comparator) |
| `json` | RFC 8259 | Bounded JSON value; preserves text representation; unindexed | `JSONB` / `JSON` | — |
| `geojson` | RFC 7946 | Valid GeoJSON Geometry or Feature object | `JSONB` | — |
| `type_id` | Identity | 64 random bits with the high bit set, written in source as `0x` and 16 hex digits — not a field an entity declares, but the entity's own id ([[2026-09-21-an-entity-is-what-everything-points-at.md]]) | — | — |
| `entity_ref` | Identity | Foreign reference combining target `type_id` and primary key | `TEXT` / Composite | Yes |
| `txid` | Identity | 64-bit replication watermark, represented as an `int64` string | `BIGINT` | No (integer comparator) |

### Canonical Form Buys Equality, Not Order

Four engines execute `order=`, and `"10" < "9"` in every engine comparing
strings. Therefore, each type specifies whether lexical string order matches
value order. Where it does not (`int32`, `int64`, `double`, `duration`,
`decimal`), Pronto emits an explicit comparator for query and index engines.

Fixed microsecond timestamp precision is what earns `timestamp` its *yes*: with
variable precision, `...00.5Z` sorts before `...00Z`. Duration as total seconds
makes `1h30m` and `90m` identically `PT5400S`. Months and years are refused: an
interval holding months has no fixed duration in seconds.

---

## 2. Types are Program Data (`types.cue`)

What a type IS belongs to the program as data; how an engine encodes or
transports it belongs to the boundary as code.

```cue
#TypeEntry: {
	sql?:    string
	base:    [...string]
	json:    "string" | "number" | "boolean" | "value"
	pattern?: string
	refuse?: string
	min?:    int
	max?:    int
	order:   "text" | "number" | "boolean" | "integer" | "decimal" | "duration" | "none"
	beyond:  [...#TypeCheck]
	valid?:  _
}
```

- **Regular Patterns in RE2/JS Intersection**: The canonical format is defined
  using regexes in the intersection of RE2 and JavaScript (no lookahead, no
  lookbehind, no backreferences). CUE validates program seed rows and fixtures
  against these patterns at compile time; client runtimes compile the exact same
  regexes.
- **The `beyond` Closed Vocabulary**: What regular expressions cannot express is
  named from an explicit closed vocabulary:
  `["calendar", "int64-range", "duration-range", "tzdb", "decimal-profile", "scalar-values", "finite-numbers", "ring-closure"]`.
  An engine or boundary handler meeting an unrecognized check refuses the table
  loudly rather than silently skipping validation.
- **Automated Agreement Proof**: Proved by `type-agreement.test.ts`:
  1. Whatever runtime parsers accept as canonical, the CUE schema admits.
  2. Where the CUE pattern admits strings that the runtime refuses, the type
     names an explicit `beyond` check.

---

## 3. Boundary Execution: No Shared Leaf Substrate

Engines remain generic and decoupled. Pronto compiles its type definitions into
the execution hooks each boundary natively provides:

```
[ Pronto Compiler (Schema & Type Authority) ]
   │
   ├── Emits SQL migrations (003_types.sql)    → PostgreSQL domains & CHECK constraints
   ├── Emits shell.yaml + comparators          → TanStack DB / Omnishell collections
   ├── Emits typedSql projections              → DuckDB / Lakehouse Arrow conversions
   └── Emits cdc transform scripts             → Conduit event processor
```

### The Four Engine Boundaries

1. **PostgreSQL Migrations** (`type-sql.ts`):
   PostgreSQL enforces canonical representations on write via `CREATE DOMAIN`
   and `CHECK` constraints (e.g., rejecting month/day intervals or negative
   durations). Because data is guaranteed canonical inside Postgres, downstream
   read paths (PostgREST, WAL streams, Electric replication shapes) emit
   canonical values natively with zero translation overhead.

2. **DuckDB / Lakehouse** (`libraries/mecha/packages/lake`):
   DuckDB runs projections using `typedSql` within its C++ engine:
   `CAST("sequence" AS VARCHAR)`, `strftime(stamp, '%Y-%m-%dT%H:%M:%S.%fZ')`.
   Arrow record batches produce canonical strings and primitives directly.

3. **TanStack DB & Omnishell** (`plugins/omnishell`):
   Omnishell stores entity collections in TanStack DB. For types whose lexical
   order diverges from value order (`int64`, `decimal`, `duration`), Pronto
   supplies custom `compareFn` functions to TanStack DB's `BTreeIndex` and
   `parseFilter()`. TanStack DB operates purely on generic records without
   coupling to Pronto's type system.

4. **Conduit / CDC** (`libraries/mecha/packages/conduit-js`):
   Conduit executes pipeline scripts (`cdc-types.blobl` or JS processors) over change
   streams. It applies transformations at the stream boundary without needing
   any hardcoded knowledge of the type taxonomy.

---

## 4. UI Value Adapters at Screen Boundaries

A UI form control is the outermost boundary. A browser control (such as
`<input type="datetime-local">`) operates on local wall time without timezone
offsets (`2026-09-22T10:00`), whereas the entity column stores an absolute
UTC instant (`timestamp`).

As established in
[`../../omnishell/docs/2026-09-22-a-control-value-is-not-a-canonical-type.md`](../../omnishell/docs/2026-09-22-a-control-value-is-not-a-canonical-type.md):
- The conversion is a pure bidirectional function:
  - **Bind**: `format(value, { zone })` maps the canonical column value to the
    control.
  - **Serialize**: `parse(text, { zone })` maps the user input back to the
    canonical column value.
- **Explicit Parameterization**: The user's time zone is passed explicitly as
  data (`ctx.timeZone`), never read from ambient machine state.
- **Endowed `Intl`**: Inside the SES sandbox cage, adapters are endowed with the
  full `Intl` namespace with mandatory options (no silent host defaults).
- **String Interpolation**: Because canonical values are strings, `{field}`
  binding interpolation, `data-when` attributes, and form submissions align
  naturally without intermediate formatting layers.

---

## 5. Architectural Seams: TanStack DB is the Seam, Electric is Internal

- **Local-first apps** (`chess`, `truco`) run entirely within the browser using
  TanStack DB collections backed by `localStorage` or memory, with zero
  Electric or PostgreSQL dependencies.
- **Electric** is strictly an internal replication protocol between PostgreSQL
  and Mecha client. Omnishell interacts solely with TanStack DB collections.
- **Repository Isolation**:
  - `bonisoft3/omnishell`: Generic UI runtime over `@tanstack/db`. Zero Mecha or
    Pronto dependencies.
  - `bonisoft3/mecha`: Generic sync, replication, and lakehouse engine. Zero
    Omnishell or Pronto dependencies.
  - `bonisoft3/pronto`: The compiler that unifies schemas, emits migrations,
    generates bindings, and configures the engines.

---

## 6. Empirical Verification Across Applications

- **Chess (`apps/chess`)**:
  - Clocks transitioned from ad-hoc millisecond integers to `duration` (`PT180S`).
  - Strict string/number synchronization in referee state derivation ensures
    clean boundaries without infinite mutation wakes.
  - Passes 100% of unit tests (40/40), perft tests (6/6), and Playwright browser
    integration suites.
- **Ponto (`apps/ponto`)**:
  - Proved timesheet and payroll calculations using `duration`, `decimal`, and
    `date` with PostgreSQL domain checks preventing invalid intervals.
- **Realworld (`apps/realworld`)**:
  - Demonstrates `timestamp` cursor pagination (`created_at=lt.{created_at}`)
    and `int64` txid watermark reconciliation.
- **Truco (`apps/truco`)**:
  - Verifies multi-seat live game sync and state machines over canonical
    records.
