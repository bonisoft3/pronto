# A carrier is a canonical string

> [!NOTE]
> **Superseded**: Consolidated into [`../2026-09-23-pronto-type-system.md`](../2026-09-23-pronto-type-system.md).

An entity's fields are typed by carriers, and what an entity is — the identity
the carriers hang from — is
[`2026-09-21-an-entity-is-what-everything-points-at.md`](../2026-09-21-an-entity-is-what-everything-points-at.md).
This doc is the carrier set: the one rule that admits a member, the canonical
form and the comparator each one owes, and the oracle that proves every path in
the cluster delivers them. It is a build unit of its own, with no dependency on
identity.

## The set

A field's type is one of two borrowed sets, kept apart so the source of every
definition is visible in the schema:

```cue
#ProtoType: "string" | "bool" | "int32" | "int64" | "double" | "bytes"
#RfcType:   "uuid" | "timestamp" | "date" | "time" | "timezone" | "duration" | "decimal" | "json" | "geojson"
#Type:      #ProtoType | #RfcType
```

Membership is decided by one test:

> **A carrier has a standard and a canonical form, such that two values are
> equal exactly when their canonical strings are.**

That makes string equality the right equality at every tier, including the ones
with no type system at all — parquet in the lake, a row in `localStorage`, a
message on the bus. Cross-tier disagreement stops needing a test per pair of
tiers and gets one oracle instead: a row of golden vectors per carrier, pushed
down every path the cluster has at `integrate`, arriving as the canonical string
or failing.

| carrier | standard | canonical form | string order is value order |
|---|---|---|---|
| `string` | Unicode | scalar values, no U+0000, no normalisation | yes, by code point |
| `bool` | proto3 | `true`, `false` | — |
| `int32` | proto3 | decimal digits, no leading zeros, no `-0` | no |
| `int64` | proto3 | the same, in a JSON *string*, per proto3 | no |
| `double` | IEEE 754 binary64 | RFC 8785's number form; NaN and the infinities are not values | no |
| `bytes` | RFC 4648 | base64, proto3's JSON mapping | no |
| `uuid` | RFC 9562 | lowercase, hyphenated | yes |
| `timestamp` | RFC 3339 | UTC as `Z`, exactly six fractional digits | yes |
| `date` | RFC 3339 `full-date` | `2026-09-21` | yes |
| `time` | RFC 3339 `time` | `HH:MM:SS.US` (microsecond precision) | yes |
| `timezone` | IANA TZDB | canonical identifier from tzdb | no |
| `duration` | RFC 3339 App. A | total seconds: `PT5400S`; no month or day component | no |
| `decimal` | XSD 1.1 `decimal` | no leading zeros, no trailing fractional zeros, no `-0`, no exponent | no |
| `json` | RFC 8259 | a JSON value; the domain's base type is `json` and keeps the text it was given, so two spellings of one value both stand and a json column has no order | — |
| `geojson` | RFC 7946 | GeoJSON Geometry or Feature object | — |

See [[2026-09-23-entity-types-and-boundary-execution.md]] for the complete
taxonomy of the 15 carriers plus 3 identity types and their boundary execution hooks.

PostgreSQL stores `uuid` as its native `uuid`, so Electric can resolve equality
on a keyed shape. The seed codec and every output path still require and emit
the lowercase, hyphenated canonical string; PostgreSQL may accept another valid
input spelling and normalizes it at storage.

**The canonical form buys equality and not order.** Four engines execute
`order=`, and `"10" < "9"` in every one that compares strings. So a carrier
owes a comparator beside its canonical form, and the last column says which
carriers may skip it. Fixed timestamp precision is what earns `timestamp` its
*yes*: with variable precision `…00.5Z` sorts before `…00Z`. Duration as total
seconds makes 1h30m and 90m one string, and it is also why a month is refused —
an interval holding one has no length in seconds, and `extract(epoch …)` answers
with thirty days rather than saying so.

Three consequences for the tiers that hold strings:

- **A canonical string is opaque in the browser.** `timestamp` has microseconds
  and `Date` has milliseconds, so a value parsed and printed again is a
  different string for an equal instant.
- **`string` equality is code-point equality, so a server entity's text columns
  take a deterministic collation.** Under a nondeterministic ICU collation
  Postgres's `=` stops being byte equality, and a unique index then refuses a
  row that `reconcile()` admits.
- **An enum's values are data, not labels.** `this in ['playing', 'finished']`
  is kept in rows at every holder, so renaming a value is a data change with the
  same reach as any other — a rewrite where rows can be rewritten, an alias the
  reader resolves where they cannot — and never free the way renaming a field
  is. The same holds for a chart's state names.

proto3's JSON mapping already fixes `Timestamp` and `Duration` (`"5400s"`), so
the two sets are closer than they look. The RFC spelling wins for the values a
person reads in a row; the emitted `.proto` renders them as the well-known
types.

What the test excludes, without special pleading: `sint32`, `fixed64`, `uint32`
and their kin are the same values with different wire bytes — an encoding is a
construction, not a statement. `email` and `uri` have an RFC syntax and no
canonical form anyone implements, so they are strings whose CEL says their
shape. `tsvector` is not a value anyone states; it is an index. `jsonl` holds
many values, and how a holder ships many is the plan's business.

`json` is the one carrier whose contents are outside the entity model — no
ordinals, no per-field CEL, nothing to rename. By the wired-or-prose rule, what
is inside a json field is prose. `libraries/pbtables`, which stores a whole
proto message in one `pbjson` JSONB column, is that trade taken to its end.

## A carrier is data, and unification applies it

Each carrier carries its source, its standard and a `valid` constraint:

```cue
timestamp: {
	source: "rfc", spec: "RFC 3339"
	valid:  time.Time & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6}Z$"
}
```

CUE draws no line between a declaration and a value, so any row the program
states — a seed, a fixture, an example — meets the same definition at
unification, with no second code path. A stated row holding
`2026-09-21T11:00:00+01:00` is refused: a valid RFC 3339 timestamp, and not the
canonical one.

`time.Time` validates the RFC and not the canonical form, which is why the regex
is ours. `time.Duration` is not used at all: it validates Go syntax (`1h30m`),
which is not the RFC.


## A carrier nobody can bind goes unused

The apps need more of this set than their field types say, and the evidence is
what they encode around. chess keeps six clocks as `int` milliseconds under a
`clock` text format; primer keeps a colour matrix as nine integers "at
millionths", because "a float column would put a rounding argument between the
two routes that are supposed to agree exactly"; plausible keeps ten instants as
`bigint` epoch seconds; xpense renders money through eight SQL-generated display
columns while `money` has no user. A narrow set does not remove a need, it moves
it into `int`, `text` and a formatter, where no statement can reach it.

The sharpest case is a carrier that exists. **93 fields across six apps are a
boolean spelled as `text`** with `this in ['true', 'false']` or yes and no, and
`bool` has been in `#Field.type` all along. It loses because of what reads the
value: markup binds an attribute as text (`aria-checked="{checked}"`), and a
filter compares text (`current=eq.yes`). So a carrier owes a third thing beside
its canonical form and its comparator — **its rendering into the binding
vocabulary**: what `{field}` interpolates to, what a `data-when` and a filter
compare against, what a form control submits. For every carrier here that is the
canonical string, which is the argument for choosing one; it has to be built
into the terminal's binder, or `duration` will land and chess will go on writing
`int`.

## The first carrier an app took: chess's clocks

`duration`, `decimal` and `date` are in `carriers.cue` as `#carriers` — each
with its standard, its SQL domain, the pattern a stated row meets at
unification, the order two of its values compare by, and the checks no pattern
can express ([`2026-09-23-entity-types-and-boundary-execution.md`](2026-09-23-entity-types-and-boundary-execution.md)).
The SQL type map, the battery's value generator and the terminal's own client
read that table rather than restating it. chess was the first taker: six clocks that were `int`
milliseconds are `duration` now. What the conversion was made of:

- **Identity refused it, as designed.** A carrier change is a retirement beside
  an addition, so the six `*_ms` fields are tombstones and six `*_clock` fields
  carry new ordinals. It was retirement's first use and the emitter did not know
  the word: a retired field still reached `shell.yaml` as a live one. It is now
  left out of the bundle, and a retired field cannot be required or carry a
  `cel`.
- **The store already held strings.** A browser tier keeps every value as text —
  the referee wrote `txt(ms)` into an `int` — so the type was nominal and the
  canonical string fits where the digits were. Nothing about the store moved.
- **Arithmetic still wants a number, and the seam is two functions.** `dur(ms)`
  and `msIn(d)` in the referee are the only places milliseconds and `PT299.8S`
  meet; the renderer took one line; the markup took a rename. A comparator was
  not needed, because nothing orders or filters by a clock.
- **A prohibition disappeared into the carrier.** All six fields said
  `this >= 0`. A duration has no sign, so there is nothing to forbid.
- The tests read better for it — `white_clock: "PT180S"` where `"180000"` was —
  and pass unchanged in what they assert.

Unbuilt, and chess did not need it: a CEL constraint *over* a duration, its
comparator, and a form control that submits one.

## The first server-tier user: ponto

[`apps/ponto`](../../../apps/ponto) is a timesheet and payroll close, written to
need what the other apps encode around: a shift's break and worked time are
`duration`, a rate and a bracket are `decimal`, a holiday and a pay period are
`date`. Its ladder is green and its ledger,
[`DEMANDS.md`](../../../../apps/ponto/DEMANDS.md), is what a carrier costs where
there is a database. What it measured, and what that changes here:

- **The wire form of a native column is the database's, per path, and the paths
  disagree.** A break written `PT3600S` comes back `"01:00:00"` from PostgREST
  and `"PT1H"` from Electric; a rate comes back as a bare JSON number from one
  and a string from the other, and keeps whatever scale it was written with —
  `37.10` stays `37.10`, `1e2` is accepted. Of 23 deliveries eight were
  canonical, and every one of those was a `date`, the one carrier whose native
  wire form *is* its canonical form. So the seats are on **read**, where
  [`the cluster's doc`](../../../../libraries/mecha/docs/2026-09-24-a-schema-that-moves.md)
  puts them — a decoder per carrier in the mecha client for the CRUD and sync
  paths, and in the pipeline's prelude for CDC — and until they exist string
  equality holds only above that seam. ponto binds no carrier to a screen; ten
  SQL-generated display columns do that job, which is xpense's workaround
  reached again from the other side. The alternative is to store the canonical
  string as `TEXT` under a `CHECK`: equality then holds at every tier, and SQL
  arithmetic, `order=` and `gt.` all break, which moves the comparator into
  Postgres. Native columns and decoders is the choice; it is a choice.
- **The column has to keep the carrier's form, and `#Carrier.sql` is not
  enough.** `INTERVAL` stored `P1M` — the month this carrier exists to refuse —
  and a negative interval; `NUMERIC` stored `1e2`. `valid` reaches a stated row
  and nothing else: not a `default:`, not a test's `given`, not a write. A
  carrier owes a `CHECK` beside its column type — no month, no day, no sign for
  a duration — emitted with it.
- **CEL is rendered without the field's type.** `this > 0` on a decimal refuses
  the program, because the CUE rendering compares a string seed with a number;
  the spelling that compiles, `this > '0'`, is right in SQL, where Postgres
  coerces, and lexical in CUE, where fifteen minutes is more than an hour. The
  comparator each carrier owes is owed to `cel-emit.ts` first. CEL's own
  `duration()` and subtraction have no rendering either, so *a break fits inside
  its shift* could not be said — and left unsaid, one such row made `worked`
  negative, the close's `CHECK` refused the recount's whole batch, and every
  person's close stopped moving. A prohibition nobody could state became an
  outage one tier down.
- **No control submits one.** A break is a `<select>` of six canonical strings; a
  rate is a text box whose `pattern` is the carrier's, and so refuses `37,125`,
  which is how a Brazilian writes it; the `date` control submits
  `2026-12-25T00:00:00Z`, written for `timestamptz`. The binding vocabulary a
  carrier owes runs both ways: what a reader types, in their locale, into the
  canonical string.
- **A transform language has no decimal.** The close is computed in bloblang over
  float64 and rounded once per figure; it agrees with the exact reference on
  every figure tested, which says little about a month of real punches. `money`
  does not meet `decimal` either — it demands an integer.
- **A duration has no sign, and hours owed do.** `worked − ordinary` is clamped
  at zero here. A bank of hours is the next app's whole model, and the carrier
  as specified cannot hold it.

## What `int64` costs, and who pays

`int64` is a string because a JavaScript reader holds no integer past 2^53, and
`to_json` of a `bigint` is a bare number that reader silently rounds. Measured in
the tree, the cost lands in two places.

**The apps barely need it.** Twelve fields were `bigint`. Ten were plausible's
epoch seconds, whose largest seeded value is 1,792,890,000 — a `timestamp`
spelled as a count; retyped as one they stopped being integers at all, and its
handlers now read the carrier into whole seconds for their clock arithmetic and
write back the instant they read. The other two, realworld's `as_of_txid` and
`counted_txid`, are copies of the platform's column and are the only `int64`
fields in any app: its pipelines sort txids as integers and emit the string, and
its `favorites` integrate check reads both back through the cluster.

**The platform does.** `txid` is a `bigint` on every server table, and the
terminal compares it as a number: `data-sync.js` decide the
optimistic fold's watermark with `>=` and `<`, `mecha-client.ts:281` parses
`int8` with `Number`, `:467` awaits `Number(txid)`, realworld's fold takes
`Math.max` of two of them, and its bloblang `.sort()`s them. On strings every one
of those is wrong without failing — `"9" >= "10"`. And strings are what arrive:
the client keeps an Electric `int8` as its transport string, so a synced `txid`
was already one, and the fold's two comparisons were string comparisons.

`compareCarrier(field, a, b)` in the mecha client is the value order for every
ordered carrier, and it refuses `bytes`, `timezone`, `json` and `geojson`,
which have none. The terminal reaches it through `columnOrder`, which types a
table's columns from `shell.schema` and types `txid` as `int64` on every table:
a range filter, a snapshot sort and the fold's watermark compare through it,
and a column the schema does not type keeps `<`. The engine's maintained views
order by JS value, so a view ordered by an `int64`, `duration` or `decimal`
column is left to the snapshot path, which sorts by carrier.

## Where a value is made canonical

Three seats write values no cluster path touches, and each is non-canonical
today:

- the terminal's `{now}`, which is `toISOString()` and so three fractional digits
  (`interpreter/screen.js:143`) — realworld pages on `created_at=lt.{created_at}`,
  and a cursor compared across `+00:00`, `.000Z` and `.000000Z` mis-pages;
- a handler that writes a literal (truco's `table.js` writes
  `"2026-09-09T12:00:15Z"`; plausible's `stitch.js` writes numbers into `int64`
  fields);
- a stated row — a seed, a test's `given` — which unification refuses, so these
  are found at `cue vet` rather than in a browser. About 45 literals in hand
  tests and 11 in programs are in a non-canonical form today, and xpense's seed
  uuids carry a version nibble of 0, which a shape regex passes and RFC 9562
  does not.

The store seat canonicalises the first two on every write; a value it cannot
canonicalise is a refusal under the carrier's name, never a best effort.
