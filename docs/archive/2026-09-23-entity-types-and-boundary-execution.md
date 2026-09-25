# Entity types and boundary execution

> [!NOTE]
> **Superseded**: Consolidated into [`../2026-09-23-pronto-type-system.md`](../2026-09-23-pronto-type-system.md).

Written from the architecture review following the carrier integration:
[[2026-09-21-a-carrier-is-a-canonical-string.md]] defined carriers as canonical
strings, and the carrier table (`carriers.cue`) established that the carrier table
is data owned by the program.

The claim: **a type system is not an engine concern. Neither Mecha nor Omnishell
owns or defines a type system. The entity type system belongs exclusively to
the application and its compiler (Pronto). The engines expose generic
configuration surfaces with arbitrary code execution at data boundaries, and
the database enforces canonical representations natively via SQL migrations.**

---

## 1. The Pronto Language Type System

The Pronto language type system defines **15 primitive types** (referred to in earlier
working notes as "carriers") plus **three identity types**:

### Primitives & Scalars
- `string`: UTF-8 text (no NUL bytes, valid unicode).
- `bool`: Boolean (`true` / `false`).
- `int32`: 32-bit signed integer (`-2,147,483,648` to `2,147,483,647`).
- `int64`: 64-bit signed integer (represented as a string to avoid JS 53-bit float precision loss).
- `double`: 64-bit finite float (rejects `NaN` and `Infinity`).
- `bytes`: Binary data, represented as canonical Base64.
- `uuid`: RFC 4122 / 9562 identifier (canonical lowercase hyphenated string).

### Temporal & Spatial
- `timestamp`: UTC instant with microsecond precision (`YYYY-MM-DDTHH:MM:SS.USZ`).
- `date`: ISO-8601 calendar date (`YYYY-MM-DD`).
- `time`: ISO-8601 wallclock time (`HH:MM:SS.US`).
- `timezone`: IANA time zone identifier (validated against tzdb, e.g. `America/Sao_Paulo`).
- `duration`: ISO-8601 total-seconds duration (`PT[seconds]S`, microsecond precision).

### Numeric & Structural
- `decimal`: Fixed-point number with declared precision and scale (`precision: P, scale: S`, exact string representation).
- `json`: Bounded JSON value (scalar, array, or object with finite numeric bounds).
- `geojson`: RFC 7946 GeoJSON `Geometry` or `Feature` object.

### Identity Metadata
- `type_id`: 32-bit integer stamping the immutable entity type identity across schema evolutions.
- `entity_ref`: Typed reference/foreign key pointing to another entity (`type_id` + `pk`).
- `txid`: 64-bit commit sequence watermark for replication and sync (represented as an `int64` string).

---

## 2. The Type System is Program Data (`carriers.cue`)

What a type IS belongs to the program, as data; what a transport spells it as
belongs to the holder, as code; and the holder is judged by the program's
statement rather than by a rule of its own.

- **Regular Patterns in RE2/JS Intersection**: The canonical spelling is
  defined in `carriers.cue` using regular expressions written in the intersection
  of RE2 and JavaScript (no lookaround, no backreferences). CUE unifies seed rows
  against this; client runtimes compile it.
- **The `beyond` Closed Vocabulary**: What a regex pattern cannot express is
  named from a closed vocabulary (`calendar`, `int64-range`, `duration-range`,
  `tzdb`, `decimal-profile`, `scalar-values`, `finite-numbers`, `ring-closure`).
  A holder that meets a name it does not implement refuses the table rather than
  silently skipping the check.
- **Automated Agreement Proof (`carrier-agreement.test.ts`)**: Proves two invariants:
  1. Whatever the client calls canonical, the program's pattern admits.
  2. Where the program admits what the client refuses, the carrier names a check.
  A carrier with `beyond: []` agrees exactly.

---

## 3. Boundary Execution: No Shared Leaf Substrate

Rather than extracting a shared `@bonisoft/carriers` package that introduces
artificial coupling, engines expose standard boundary execution hooks:

```
[ Pronto (Compiler / Schema Authority) ]
   │
   ├── Emits SQL migrations (000_carriers.sql) → Enforces canonical data at the DB level
   ├── Emits shell.yaml + comparators          → Handed to Omnishell / TanStack DB
   └── Emits cdc-carriers.blobl                → Handed to Conduit
```

### The Four Engine Boundaries
1. **PostgreSQL Migrations** (`plugins/pronto/carrier-sql.ts`):
   PostgreSQL `CREATE DOMAIN`, `CHECK` constraints, and representation functions
   (`_to_json`, `_from_json`) enforce canonical storage on write. Because data is
   already canonical in the database, WAL output, Electric shapes, and PostgREST
   responses are already canonical.
2. **DuckDB / Lakehouse** (`libraries/mecha/packages/lake`):
   DuckDB executes SQL projections (`typedSql`) inside its C++ engine:
   `CAST("sequence" AS VARCHAR)`, `strftime(stamp, '%Y-%m-%dT%H:%M:%S.%fZ')`.
   Arrow record batches yield canonical strings and primitives directly.
3. **TanStack DB & Omnishell** (`plugins/omnishell`):
   TanStack DB collections store rows. For non-lexical carriers (`int64`,
   `decimal`, `duration`), `BTreeIndex` accepts a custom `compareFn`, and
   `parseFilter(filter, compare)` accepts an optional comparator callback.
4. **Conduit / CDC** (`libraries/mecha/packages/conduit-js`):
   Conduit takes pipeline scripts (`cdc-carriers.blobl` or JS processors).
   It executes the registered pipeline over change events without knowing the
   carrier taxonomy.

---

## 4. The Seam Point: TanStack DB is the Seam, Electric is Internal

Electric is a wire replication engine that streams changes from Postgres via
HTTP (`/v1/shape`). It is not an exposed seam for Omnishell:
- Local/device-tier apps (`truco`, `chess`) carry **zero Electric dependencies**.
  Their collections are created directly via TanStack DB (`localOnlyCollectionOptions`,
  `localStorageCollectionOptions`).
- Omnishell's store is purely `Record<string, Collection>`.
- Mecha client is only invoked when `cfg.cluster` is configured for remote sync.
  Electric remains an internal transport detail inside Mecha.

---

## 5. Monorepo vs. Copybara External Repos

Because `omnishell` and `mecha` are independent leaf libraries that know nothing
about Pronto or each other:
1. `bonisoft3/omnishell`: Public UI runtime over `@tanstack/db`. Zero dependencies
   on Mecha or Pronto.
2. `bonisoft3/mecha`: Public sync & lakehouse engine. Zero dependencies on Omnishell
   or Pronto.
3. `bonisoft3/pronto`: The compiler that writes the SQL migrations, CUE configs,
   and boundary scripts to wire them together into complete applications.
