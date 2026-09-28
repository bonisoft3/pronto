---
type: concept
title: Types and identity
description: "What a field's value is and what an entity is: fifteen portable types, each equal exactly when its canonical strings are, and a minted type id with ordinals, so a name is a label nothing is keyed on."
---

# Types and identity

A field holds one of fifteen **portable types**, and an entity is a **durable
identity**: a type id minted once, with an ordinal per field. Both belong to the
compiler. No engine owns a type system. mecha and omnishell expose hooks at
their boundaries, and pronto fills each one from the same table. The set, each
type's standard and its canonical form are
[SPEC's field types](../SPEC.md#field-types). How an author mints identities
and changes a schema is [the guide](../GUIDE.md#identity).

## Portable types

**A type has a standard and a canonical form, and two values are equal exactly
when their canonical strings are.** String equality is then correct at every
tier, including those with no type system: a parquet file, `localStorage`, an
event on the bus. Cross-tier agreement has one oracle: a value pushed down a
path comes out as the same string (`type-sql.integration.test.ts` drives
Postgres, PostgREST and Electric).

**Canonical form buys equality, not order.** Four engines run `order=`, and
`"10" < "9"` in every one that compares strings. Each entry's `order` says how
two values compare: `text` is a plain `<`, `number` and `boolean` are native,
`integer`, `decimal` and `duration` need a comparator, and `none` (`bytes`,
`timezone`, `json`, `geojson`) is refused wherever a column asks for order.
Text order is not one order: the terminal compares UTF-16 code units, as the
view engine does, and the server's text columns take the cluster's ICU root
collation.

The rules that make a form canonical:

- **`timestamp` carries exactly six fractional digits.** With variable
  precision, `…00.5Z` sorts before `…00Z`.
- **`duration` is total seconds**, so `1h30m` and `90m` are both `PT5400S`. A
  month is refused because it has no fixed length in seconds.
- **`int64` is a JSON string**, because a JavaScript reader holds no integer
  past 2⁵³ and `to_json` of a `bigint` is a bare number it rounds silently. The
  platform's `txid` is the case that matters: `columnOrder` in omnishell's
  `data-sync.js` types it as `int64` on every table.
- **`json` keeps the text it was given** (RFC 8259), so two spellings of one
  value both stand and a `json` column has no order. What is inside it is
  outside the entity model: no ordinals, no per-field CEL.

Money is not a type but what an integer counts: `money: {currency,
minorUnits}` on an integer field. Some fields carry physical labels (`text`,
`int`, `bigint`, `timestamptz`, `tsvector`), which `#typeAlias` maps to their
types; `tsvector` is an index, not a value anyone states
([pending](../PENDING.md#types-and-identity)).

## The type table

`types.cue` states each type once, as data: its PostgreSQL domain, the base
names a transport may report it under, its JSON kind, the canonical `pattern`
(written in the intersection of RE2 and JavaScript: no lookaround, no
backreference), its range, its `order`, and `beyond`, the checks a pattern
cannot express, named from a closed vocabulary (`calendar`, `int64-range`,
`duration-range`, `tzdb`, `decimal-profile`, `scalar-values`,
`finite-numbers`, `ring-closure`).

Every reader judges by that entry:

- **CUE** unifies every seed row with `#TypeConstraint[type].valid` at
  `cue vet`, and `write.ts` then runs the `beyond` checks over the seeds
  (`type-check.ts`).
- **The terminal** reads the table from `shell.yaml` as `carriers`. The client
  canonicalizes each value with its own code and asserts the result against the
  entry. A table naming a type it cannot write, or a check it does not run, is
  refused whole, because the alternative is a check the program states and
  nothing performs. That client is mecha's
  (`libraries/mecha/packages/client/src/types.ts`); pronto's
  `portable-types.ts` is a generated copy that `portable-types.test.ts` holds
  equal to it.
- **`type-agreement.test.ts`** holds the two halves together: whatever the
  client accepts as canonical the pattern admits, and whatever the pattern
  admits and the client refuses is named by a `beyond` check.

## Where each boundary makes a value canonical

| holder | hook | what it does |
|---|---|---|
| PostgreSQL | `type-sql.ts` → `004_types.sql` | a `portable_*` domain with its `CHECK` per type, and the representation functions PostgREST calls as casts at its boundary |
| Electric | the mecha client's `normalizeRow(t.fields, value, "electric")`, in the shape's `write` wrapper | canonicalizes each synced row on arrival, before it can become an optimistic original or reach the outbox |
| a write from the terminal | the mecha client's `normalizeRow` | canonicalizes before the write, and a value it cannot canonicalize throws |
| the bus | `assets/cdc-types.blobl`, prepended to every pipeline | turns Conduit's Postgres text output into canonical form; an unexpected spelling throws, and the pipeline logs and drops the event |
| the lake | `libraries/mecha/packages/lake/src/lake-types.ts` | projects typed columns inside DuckDB, before Arrow builds JavaScript values |
| the emitted `.proto` | `type-proto.ts` | `timestamp` and `duration` as well-known types, `json` and `geojson` as `Value`, the rest as scalars or strings |

The bus transform has a measured spelling for twelve types. A `server` entity,
whose rows the change feed carries, cannot declare `bytes`, `json` or `geojson`:
`_busTypes` in `emit.cue` refuses it at `cue vet`, because at runtime the
column would wedge its table, every change dropped with only a log line.

## Identity

An entity is what everything points at. Prose, invariants, machines, policies
and validations attach to it, and every holder keeps rows that belong to it.
Remove every statement and the entity is still there. Its name is a label over
that identity, free to change, because nothing downstream should be keyed on it.

| | form | borrowed from | answers |
|---|---|---|---|
| **type id** | `0xdbb9ad1f14bf0b36`: 64 random bits, top bit set (`#TypeId`) | Cap'n Proto | is this the same entity? |
| **ordinal** | a positive integer, stable for the field's life | Cap'n Proto | which field of it? |
| **name** | `article_tag` | proto3's identifier grammar | what do we call it today? |

A field's identity is *(type id, ordinal)*, the composition proto and Cap'n
Proto both use, so minting stays one value per entity. A proto field tag is
message-local, and nothing identifies a definition across a rename; that is
what the type id adds. It is not the row's `id`.

**Ordinals are gap-free, and a field is never removed.** An entity's ordinals
are `1..n`. A field no longer wanted is **retired** in place (`retired: true`),
its ordinal and last label kept for the entity's life. A retired field cannot be
required or carry a `cel`; the database keeps its column, the proto `reserve`s
its number and name, and the bundle is told of neither. CUE keeps what it can
see alone, no ordinal above the count and no two alike, so two branches that
each mint ordinal 7 fail to merge on `_ordinals."7"`.

**Identity is append-only, and no model mints it.** A model rewriting the ir
from a changed brief cannot be trusted to copy 64 random bits, and a mistyped
id is an add beside a silent retirement. A hop writes a new entity or field
with no identity, and `identity.ts mint` stamps the program and the ir and is
the only writer of `.pronto/identity.json`. `identity.ts check`, at `lint`,
refuses an identity that disappeared, changed type or came back from
retirement, and an id or ordinal the snapshot never recorded, since one changed
hex digit is otherwise indistinguishable from corruption. CUE keeps the half
that is true of a program alone; the check keeps the half that needs a past,
and the one CUE must not keep, that every field *has* an ordinal, because mint
has to read the program it stamps.

| holder | identity |
|---|---|
| `ir.html` | `data-type-id` on the entity's section, `data-ordinal` on each field row |
| `program.cue` | `id:` on the entity, `ordinal:` on each field |
| PostgreSQL | the physical column number, kept by a rename and never reissued after a drop |
| `.pronto/identity.json` | every identity ever minted |
| the emitted `.proto` | field numbers are the ordinals; the message carries the entity's label |
| the lake | DuckLake's own `field_id`, which a catalog rename leaves alone |

Nothing in PostgreSQL says which entity a table is, so that map lives in the
snapshot, the only copy an app with no database has. In the ir an identifier is
present but never primary: a reviewer learns that an identity moved, not what
it moved to.

What a schema change may do with an identity is [schema changes](schema-change-admission.md).

## What keeps each statement

**A language is either wired or it is prose.** It is wired when something
parses it, an engine keeps what it says, and a reader can see it. A formal
statement is a promise that something checks it; SQL quoted in an ir is prose
that nobody checks. The statements an entity carries today, each more general
than the last and each only a prohibition, which is why they compose. Most are
kept only at the cluster rungs; at `tab` and `device` a write is judged by its
validations alone ([the lattice](lattice.md#the-validation-ladder)):

| statement | forbids | kept by |
|---|---|---|
| `cel` on a field | values a field may not take | a SQL `CHECK` at the cluster rungs and a CUE constraint on seed rows, both rendered from `.pronto/cel.json`; nothing at `tab` or `device` |
| `invariant` on an entity | rows that may not exist | a SQL `CHECK` at the cluster rungs; nothing at `tab` or `device` |
| `unique`, `uniques` | rows that may not coexist | a unique index at the cluster rungs, and `reconcile()` when a browser collection loads |
| a validation | rows inconsistent with those they reference | the store at every rung, and a plv8 trigger at the cluster rungs |
| a machine | transitions a field may not make | the terminal, for a `tab` or `device` row only ([machines](../../omnishell/docs/machines.md#the-chart)) |
| `access` | readers a row may not reach | RLS policies at the cluster rungs ([access](access.md)) |

The reviewer's question with a right answer is *could this have been said one
level up?* CEL is the value and row vocabulary because an ir vocabulary must be
human-readable, parsed rather than interpreted, kept by more than one engine and
legible to a model, and CEL is all four. `cel.ts` parses each expression once
into `.pronto/cel.json`, and every rendering reads that file.

Every field is a column, and `json` is the way out when a value has no fields
worth naming.

What the statements do not yet cover, a keeper for every statement and the
shape fingerprint among them, is [pending](../PENDING.md#types-and-identity).

## Rejected

- **A type system owned by an engine.** omnishell and mecha each publish as a
  repository of their own and know nothing of pronto or of each other; a type
  system in either would make the other, and every app, depend on it.
- **A shared package of type code every engine imports.** It couples the
  engines through a leaf they all pin. Each engine exposes a hook at its
  boundary instead, and the compiler emits into it.
- **The canonical string stored as `TEXT` under a `CHECK`.** Equality would
  hold at every tier with no decoder, and SQL arithmetic, `order=` and `gt.`
  would break, moving every comparator into Postgres. Native columns with a
  canonicalizing hook per path is the choice.
- **CUE's `time.Time` and `time.Duration` as the validators.** `time.Time`
  validates RFC 3339, not the canonical form; `time.Duration` validates Go's
  syntax (`1h30m`), not the RFC's.
- **RFC 8785 for `json`.** Nothing canonicalizes key order: the client keeps the
  order it was handed and the domain's base type keeps its text.
- **Encodings as types** (`sint32`, `fixed64`, `uint32`): the same values with
  different wire bytes. An encoding is a construction, not a statement.
- **`email` and `uri` as types.** They have an RFC syntax and no canonical form
  anyone implements, so they are strings whose CEL states their shape.
- **A content hash as the entity's identity.** It answers *same shape?* and
  changes on every edit.
- **Deleting a field.** A deleted ordinal can be minted again under a new
  meaning, and a holder bringing old rows forward cannot tell a retired field
  (drop it) from one it has never seen (refuse the rows).
- **The model or `build` writing the snapshot.** A program that lost an
  identity would launder the loss by regenerating.
- **Fields as a map keyed by ordinal.** The authoring hop would choose the key,
  which is minting.
- **A whole message in one JSONB column**, as `libraries/pbtables` stores it.
  It buys migration-free change at the price of PostgREST, Electric's shapes,
  RLS and `CHECK`, which all key on columns.
