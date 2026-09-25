# An entity is what everything points at

An entity is a durable identity. Prose attaches to it, invariants attach to it,
machines and policies and validations attach to it, and every holder in the
system — a table, a topic, a parquet file, a reader's browser — keeps rows that
belong to it. None of those things *is* the entity. Remove every statement and
the entity is still there, which is the test of what defines it and what merely
refers to it.

Its name is a label over that identity: readable, and free to change, because
nothing downstream should be keyed on it. That is the part the tree gets wrong
today, and most of what follows is the consequence of getting it right.

## Three documents, three reviews

[`../CONTRIBUTING.md`](../CONTRIBUTING.md) states the chain:

```
brief.md ── LLM ──▶ ir.html ── LLM (narrow) ──▶ program.cue ── cue export ──▶ everything
 product              engineering                machine
```

`ir.html` is the design doc an engineer signs; `program.cue` is a compiler
intermediate nobody reviews. The same file names the trade the ir makes: it is
**a stage rather than a projection, because a projection can never hold
information the program lacks.** That freedom belongs to the ir's prose. It does
not belong to its formal statements, which is the next rule.

## What the ir holds

The ir is a loose spec with invariants in it. The loose spec is prose; the
invariants are written in wired languages; the entities are there for binding —
they are what both kinds of statement attach to.

> **A language is either wired or it is prose. There is no third state.**

A language is **wired** when something parses it, at least one engine keeps what
it says, and there is a rendering of it for a reader. SQL, or anything else, may
appear in an ir and often should — but then it is prose, carries no obligation,
and nobody checks it. The consequence that matters: **a formal statement is a
promise that something checks it.** A statement nothing can keep is either
demoted to prose, or the thing that would keep it gets built.

Formalisms that are complete by nature are still read as prohibitions at this
rung. A mermaid diagram asserts that some paths exist and claims nothing about
the rest; a state chart *is* complete, which is exactly why the ir carries its
prohibitions ("no transition from `finished` back to `playing`") and the
complete chart lives one rung down, where `check-machines` fires every arrow.

## Identity

Three things, each borrowed, each answering a different question:

| | form | borrowed from | answers |
|---|---|---|---|
| **type id** | `0xdbb9ad1f14bf0b36` — 64 random bits, written in source | Cap'n Proto | is this the same entity? |
| **ordinal** | a positive integer, stable for the field's life | Cap'n Proto | which field of it? |
| **name** | `article_tag` — one casing, snake | proto3's identifier grammar | what do we call it today? |

A field's identity is the pair *(type id, ordinal)*. That is the composition
proto and Cap'n Proto both use, so a field needs no global identifier of its own
and minting stays one value per entity. Kenton Varda gave Cap'n Proto type ids
after writing protobuf v2, for exactly the reason we need them: a proto field
tag is message-local, so nothing in proto identifies a definition across a
rename or across files.

Two things the type id is not. It is not `id` — every row already has one of
those, and joining the two would be a category error. And it is not a content
hash: a hash answers *is this the same shape?* and changes on every edit, while
the type id answers *is this the same entity?* and never changes. Both are
wanted. The content half is the **shape fingerprint**: sha256 over the RFC 8785
form of the entity's identity projection — type id, and per ordinal its type,
`required` and `retired`, with no label in it. A rename therefore leaves the
fingerprint alone, which is the point: rows keyed by ordinal are as readable
after a rename as before. Avro's Parsing Canonical Form is the better-known
answer to "normalise a schema, then hash it" and the wrong one here, because it
keeps names; JCS is owed already for the `json` type, so this borrows nothing
new.

**Casing is rendering.** `ArticleTag` and `article_tag` were never two facts;
they are one label rendered for two tiers. Canonical is snake because the
reverse direction is ambiguous on acronyms. For the same reason there is no
`table`: a table name is the label rendered for Postgres, and carrying it
separately is how one entity acquires two names that drift. In the ten apps the
two already agree everywhere — `table` is `snake(name)` for all 146 entities —
so the collapse renames nothing a holder keeps.

### Ordinals are gap-free, and a field is never removed

Cap'n Proto numbers fields consecutively and never deletes one, and both halves
are borrowed with the ordinal. An entity's ordinals are exactly `1..n`. A field
that is no longer wanted is **retired in place** — `retired: true`, its ordinal
and its last label kept for as long as the entity lives — because three things
need the program to remember it:

- an ordinal that was deleted can be minted again, and a holder that kept rows
  under the old meaning would read them under the new one;
- a reader's browser bringing old rows forward has to tell *retired* (drop the
  field) from *never seen* (refuse the rows), and a program that forgot the
  ordinal cannot;
- the emitted `schema.sql` keeps the column, nullable and unconstrained, so the
  differ relaxes it by itself. A retired column left `NOT NULL` would refuse
  every insert from a program that no longer writes it.

`fields` stays a list, and the ordinal is a field of the field. A map keyed by
ordinal reads better and cannot be authored: the hop that adds a field would have
to choose its key, which is minting, and the rule below is that no model does.
So a new field is written with no ordinal, the tool stamps the next one, and CUE
keeps what CUE can see without it — no ordinal above the count, no two alike,
which together are *gap-free* once every field has one. Two branches that each
add a field both mint ordinal 7, and the merge fails unification on
`_ordinals."7"`. The map is the derived shape: the snapshot, the fingerprint and
every holder key by ordinal. An entity retires the same way, keeping its type id.

### The platform's columns are another type's fields

The cluster puts columns on an app's table that the app never declared: `txid`
on every server entity, `scope_id` where access scopes it, the tick fields on a
scheduled one. They cannot take ordinals in the app's `1..n`, which would stop
being gap-free the day the platform added one, and they do not need to. They are
the fields of types mecha owns — a row's delivery stamp, a tick — whose type ids
are minted once, in mecha, and are the same in every app. A holder names such a
column by *(mecha's type id, ordinal)* like any other, and an app's own ordinals
are its own.

### Identity is append-only, and no model mints it

Renames are *detectable* from the ir downward, which is not the same as
permitted: a name that moved under a living ordinal is one, and
[[2026-09-24-refusing-a-schema-change.md]] says why detecting it is the reason
to refuse it rather than emit it. The rewrite itself happens one hop up, where a
model rewrites `ir.html` from a changed brief and is trusted to copy 64 random
bits. A re-minted or mistyped id is not an error anywhere below: it is
an add beside a silent retirement, which is the failure identity exists to
remove. So two rules, both mechanical:

- **The set of *(type id, ordinal)* only grows.** `.pronto/identity.json` is the
  snapshot: type id to label, ordinal to label and type. Lint compares the
  program against it, and an identity that disappeared, changed type, or came
  back from retirement is an error, never a diff to review.
- **A tool mints, the model never does.** The hop writes a new entity or field
  with no identity; `identity.ts mint` stamps the type id and the next ordinal
  into the program and the ir, and is the only writer of the snapshot, which it
  will grow and not shrink. That is what makes the snapshot history rather than
  a derivation: were `build` to rewrite it, a program that lost an identity
  would launder the loss by regenerating. An id in the program that the snapshot
  does not know is refused, since there is no way to tell it from a corrupted
  one — one changed hex digit reads as an entity gone, an unrecorded one
  arrived, and an ir that disagrees, three findings for one typo.

The rule has two keepers because it has two halves. CUE keeps the half that is
true of any program taken alone: bounded, distinct. The check keeps the half
that needs a past — and the half CUE must not keep, that every field *has* an
ordinal: a schema demanding one refuses the program the moment an author adds a
field, and mint has to read that program to stamp it. A field deleted from the
middle trips CUE's bound before the check runs; one deleted from the end passes
CUE and is caught by the snapshot.

### What the tree has today

Every definition in `schema.cue` that the ir can point at — entities,
validations, pipelines, screens, decisions — is identified by

```cue
name: string
ir:   *name | string
```

**`ir: *name | string` is the entire identity model, and it defaults to the
name.** A field has less: a name and nothing else. The name is replicated into
every holder; the identity is recorded nowhere. That is why the bijection is a
name comparison, why a rename looks like a drop beside an add, and why realworld
declares one identity twice — `uq_favorite_pair` on `Favorite` and the `dedupe`
of the fold that reads it — with nothing checking they agree.

An entity is also named three ways at once: `ArticleTag` in the brief's
wikilinks and the ir's element ids, `article_tag` as its `table`, and whichever
of the two a given reference happens to want — `#Access.parent` takes the
entity, `shared.via` and `ref` take the table.

### Where identity rides

| holder | today | with identity |
|---|---|---|
| ir.html | `<section id="ArticleTag">` | `… data-type-id="0x9f3c…"`, and `data-ordinal` on each field row |
| program.cue | `name:` | `id:` on the entity, `ordinal:` on each field |
| Postgres | the table and column names | the physical column number, which a rename keeps and a drop retires |
| `.pronto/identity.json` | — | the snapshot: every identity ever minted, written by mint alone |
| emitted `.proto` | — | message and field numbers are the ordinals, directly |
| the lake | column names | DuckLake's own `field_id`, which a catalog rename leaves alone |
| a message on the bus | column names | the shape fingerprint it was written under, in its metadata |
| `localStorage` | `mecha:game` | `mecha:0x9f3c…`, and the fingerprint beside the rows |

The database is the holder that matters most, and it carries an identity of its
own without being told one: Postgres keeps a column's physical number across a
rename and never reissues it after a drop. That is enough to say what happened
to a column between two states, which is what the catalog replay reads —
consecutive states joined on that number rather than on the name.

It is not enough to say *which entity* a table is, and nothing in the database
answers that. `.pronto/identity.json` is where that map lives: written by mint
alone, read by every check, and the only copy an app with no database has. A
migration's `--` comment would be prose by the rule above and nothing keeps it;
storing the map in the database instead would make every check need a container
to answer a question about source.

Keying `localStorage` by type id also ends a collision that exists today: two
apps served from one localhost origin both own `mecha:game`.

In the ir the identifiers are **present, never primary**: attributes, not
reviewed content. The reader sees `article_tag`; the machine reads the type id.
A reviewer should learn that a field's identity moved, never what it moved to.

## A field's type

A field's type is a portable type: the outside boundary of values the system
can hold and deliver without changing their meaning. It forbids values outside
its domain and describes nothing narrower — a decimal need not be a valid price
— which is why CEL and the validations below carry the narrower constraints.

The set, the canonical form each type owes, the comparators that order them and
the conversions at every boundary are [[2026-09-23-pronto-type-system.md]].
What belongs here is only the join to identity: a field's *(type id, ordinal)*
says which field it is, and its type says what it may hold. A change to either
is a change to the entity, and neither is inferable from the other.

## What attaches, and at what level

| statement | vocabulary | whose | forbids |
|---|---|---|---|
| `cel` on a field | CEL | pronto | values a field may not take |
| `invariant` on an entity | CEL, `this` bound to the row | pronto | rows that may not exist |
| a validation | Jessie, walking declared edges | pronto | rows inconsistent with the rows they reference |
| `data_tests` | dbt's grammar | dbt | combinations of rows that may not coexist |
| a machine | XState-JSON, closed over its row | omnishell | transitions a field may not make |
| a policy | Rego | the permissions design | destinations a row may not reach |

Each level quantifies over more than the one above it: a value, a row, a row and
its neighbours, all rows, a sequence of states, a subject. Every one of them
only rejects, which is why they compose — and why they are ordered by how much
freedom they leave. The reviewer's question with a right answer is *could this
have been said one level up?*

Prohibitions leave one thing open: what the system writes when the author wrote
nothing. *No orphan comments* is kept equally by refusing to delete the article
and by deleting its comments with it, and a reader sees the difference. So a
second kind of statement attaches, a **production** — a value or a row the
system supplies:

| production | supplies | today |
|---|---|---|
| `default` | a field the write left out | `default:`, a SQL string |
| `stamp` | a field no writer may set — the owner, the `txid` | `DEFAULT auth_uid()`; a trigger |
| `computed` | a field that is a function of its row | `generated:`, a SQL string |
| `on_delete` | `restrict` or `cascade`, on a `relationships` statement | `ref:`, which hard-codes the cascade |

A production is kept per tier exactly as a prohibition is — the store seat
supplies on a device what Postgres supplies on a server — so it is written in
the entity's one expression language and appears in `enforced_by`. A SQL string
in an entity is an enforcement's vocabulary, which the rule in "In the ir"
already refuses.

`default` closes easily: 42 of the tree's 43 are a minted uuid, the clock, the
caller, or a literal, which is a vocabulary of four and no expression language
at all. `computed` does not. Of the 19 `generated:` expressions, three are
full-text vectors and so constructions; eight are xpense rendering money as
text, which is the `money` meaning done by hand and goes away with it; and the
rest — realworld's slug and reading time, xpense's `month` and `bucket`, which
are sink keys — want `lpad`, a regex replace and a word count that CEL without
its string extensions does not have.

`computed` is CEL with the strings extension, and nothing wider. The extension
is a published part of CEL with a conformance suite, so it is a vocabulary a
second engine can keep, which a SQL string under a name never is. That covers
`month`, `bucket`, `day_display`, `month_display` and the two `split_part`s.
What it leaves out are realworld's slug and `reading_minutes`, which are a regex
rewrite and a word count over a whole article — a derivation from a row rather
than a function of it, and the platform has a name for that already: a pipeline.
A computed field is then something every tier can supply, and an app that wants
more says so with a box in the ir.

A third kind rejects nothing and supplies nothing: it says what a value *means*.
`money` — an integer counts minor units of a currency — is the one that exists.
It attaches to the field because every screen that renders the field reads it,
and nothing keeps it because nothing can break it.

Below that line sit statements of a different kind again. An index forbids
nothing; it *requires* a structure. So do a materialisation, a full-text vector,
and the choice of which fields become columns at all. They are constructions,
they belong to the plan, and the plan's rule is that **each one names the demand
it serves**.

### Why CEL, and why dbt for sets

A vocabulary is admissible at the ir when it is human readable, parsed by a
parser rather than interpreted by an engine, kept by more than one engine, and
legible to a model — since the ir-to-program hop is one. CEL has all four, and
`cel.ts` states the contract: `.pronto/cel.json` is what every consumer reads,
*never the module*.

For sets, nothing has all four, and that is a finding rather than a gap. Datalog
has no specification, only mutually incompatible dialects — `google/mangle`, the
healthiest, defers SQL translation to Logica, which is Python with one author.
SQL has a standard whose portability fails in practice: DuckDB rejects
`ON DELETE CASCADE` outright and cannot serialise DDL to JSON. So set invariants
borrow a **vocabulary** instead — dbt's — and use its grammar verbatim:

```cue
uq_article_tag_pair: {"dbt_utils.unique_combination_of_columns": {
	arguments: combination_of_columns: ["article_id", "tag"]
}}
```

What is borrowed is the vocabulary — the test names, their argument names, what
each one means — and not an engine: nothing in the tree runs dbt, and by the
rule above a claim that `dbt test` keeps these would be prose. The keepers are
the ones `enforced_by` names. Two deviations are deliberate: `relationships.to`
holds a type id where dbt writes `ref('name')`, so renaming the other entity
stays free; and `config.where` holds CEL where dbt expects SQL, because the
entity model has one predicate language. A dbt `schema.yml` is then one more
rendering, with the label and SQL substituted back, for the day a lake wants it.

A statement carries a name and no minted identity. Its name is load-bearing —
a violation of `uq_article_tag_pair` is the app's duplicate refusal, and the
constraint name is what reaches the screen — but every holder of that name is
replaceable, so renaming one is an ordinary edit that the screen typechecker
follows. The subset is closed — `unique`, `relationships`,
`dbt_utils.unique_combination_of_columns`, `dbt_utils.mutually_exclusive_ranges`
— and a name enters it together with its renderings. `accepted_values`,
`not_null` and `accepted_range` stay out because CEL owns value predicates.
`pk` dissolves into `unique` and `required` as a prohibition, and what is left
of it is a construction: the key the store upserts against and the client's
`getKey`, which the plan derives from the entity's one required unique.

## References point inward

An entity names none of its attachments. The machine names the field it governs;
the policy names the entity it reaches; the validation names the entity it
judges.

> **The reference goes from the thing that cannot stand alone to the thing that
> can.**

Three consequences, each of which was a defect while the reference went the
other way:

- **No second declaration.** A machine is mounted by a screen, on a region bound
  to a field. That binding exists over there whether or not the entity repeats
  it.
- **No foreign vocabulary in the entity.** Machines are omnishell's, policies are
  the permissions design's. Neither appears in pronto's definition of an entity.
- **Sharing is free.** A reference is an identifier, so one machine can govern
  several fields.

Inside a program a field is still spelled by its label, and in six languages
whose strings nothing rewrites: CEL, the PostgREST fragment grammar, bloblang,
Jessie, SQL assembly, and the markup's `data-live` and `data-text`. Identity is
for the holders a program cannot regenerate; the program itself is regenerated
whole, so there a label resolves to one identity and a rename is an edit to
every string that spells it. The author's surface for that is one command —
`pronto rename <entity>.<old> <new>` rewrites the label and leaves the ordinal —
and what makes it safe is that a label left behind resolves to nothing: the
screen typechecker and `cue vet` refuse it, where today a stale column name in a
filter is a 400 at run time.

## Every statement is kept by something

Whether a statement is kept depends on what else exists, so it is a property of
the program rather than of an entity. The platform carries a table of what each
tier can keep — a value statement is kept by a Postgres `CHECK` on the server and
by the store seat and the normalize pass on a device; a set statement by a unique
index or by `reconcile()` at load; a transition by the chart the terminal runs —
and the program derives, for every statement it holds:

```cue
enforced_by: [#TypeId]: [string]: [_, ...string]
```

The list is declared non-empty, so **a statement nothing can keep does not
unify**. One gap is written as data rather than prose: a machine only ever
writes tab and device tables, so the server's transition keepers are `[]`, and a
machine pointing at a server-owned field fails to build.

`enforced_by` says a keeper exists; it cannot say the keeper works, and the
admissibility rule below invites the failure — one CEL kept by several engines
is several readings of it. `matches()` is RE2 in CEL, a POSIX ARE in a `CHECK`
and ECMAScript in the browser. So **every prohibition carries at least one row
it refuses.** The row is stated, so it meets the definition at unification and
must fail there; and every keeper the table names is handed it at the verb that
can reach that keeper, and must refuse it under the statement's name. It is the
pairs runner's first customer, and in the ir it is the example a reviewer reads
before the predicate.

Two more checks fall out of references pointing inward: an attachment must name
an entity that exists, and an entity's key in the program must agree with the
identity it holds.

## In the ir

Per entity, one table of statements with three columns — the statement, what
enforces it at this entity's durability, and why:

```
statement                          enforced by                    why
--------------------------------   ----------------------------   -------------------------
uq_article_tag_pair                a unique index · the store's   One row per piece per tag;
∄ a,b ∈ article_tag :              upsert conflict target         a repeated pair comes back
  a ≠ b ∧ a.article_id =                                          23505 and the screen reads
  b.article_id ∧ a.tag = b.tag                                    this name.
```

The notation is produced by optional embedded JavaScript with three views —
**text** (Unicode), **rich** (MathML, for the few statements that need layout)
and **source** (the declaration itself). **Source is normative.** It is what the
narrow hop reads and what the bijection compares, so with no JavaScript a reader
sees the declaration, which is the thing that was true anyway.

The enforcement column is why the statement must not be written in an
enforcement's vocabulary. `UNIQUE (current) WHERE current = 'yes'` cannot be said
of chess's `game`, which has no database — yet the invariant is identical and
`reconcile()` keeps it.

## The minimum, in CUE

```cue
#TypeId:  string & =~"^0x[89a-f][0-9a-f]{15}$"
#Name:    string & =~"^[a-z][a-z0-9_]*$"

#Durability: "server" | "live" | "offline" | "tab" | "device"

#Field: {
	name!:    #Name
	type!:    #Type
	ordinal?: int & >0
	required: *true | bool
	retired:  *false | bool
}

#Entity: E={
	id?:         #TypeId
	name!:       #Name
	durability!: #Durability
	retired:     *false | bool

	// 1..n: none above the count, no two alike. That each field has one is the
	// identity check's, not unification's.
	fields!: [...#Field & {ordinal?: <=len(E.fields)}]
	_ordinals: {for f in E.fields if f.ordinal != _|_ {"\(f.ordinal)": f.name}}
}
```

In `schema.cue` as of the first three apps. On the pinned cue v0.16.1 a field
deleted from the middle fails with `invalid value 4 (out of bound <=3)` and a
repeated ordinal with `_ordinals."2": conflicting values "cls" and "label"`.

`required` is protovalidate's — a constraint, sugar for the commonest value
prohibition — and not proto3's, which was a wire-compatibility hazard for
independently deployed readers, a problem this system does not have. There is no
`pk`: it is sugar for `unique` and `required`, and belongs with the set
invariants. `#Durability` is the one concept here with nothing to borrow, and it
earns that because it decides who can keep any statement at all.

## An entity moves

Schema evolution is a statement with a time quantifier: not *what may not be
true* but **what a change may not do**. It has almost no authoring surface,
because identity supplies what would otherwise be declared.

What identity buys is precision, not permission. A label that moved while the
type id and ordinal did not is a rename, and knowing that is what lets a refusal
name the column rather than the file — it does not make the change safe, because
what a holder reads is keyed by name and a page already open never hears about
the new one. So one declaration carries the surface: **retirement**, `retired:
true` on a field that stays where it is, its ordinal spent forever, a new name a
new ordinal beside it.

The reviewer signs none of the SQL. Identity makes the change itself sayable —
*renamed `image_url` to `avatar_url`; retired `bio`; added `subtitle`,
optional* — and that list is a section of the ir: the one place evolution is
reviewed.

What is refused, and what reads the change to refuse it, is
[[2026-09-24-refusing-a-schema-change.md]]; what a running cluster does when the
database moves underneath it is
[`../../../libraries/mecha/docs/2026-09-24-a-schema-that-moves.md`](../../../libraries/mecha/docs/2026-09-24-a-schema-that-moves.md);
what a reader's browser does when its bundle and its database disagree is
[`../../omnishell/docs/2026-09-20-a-screen-older-than-its-database.md`](../../omnishell/docs/2026-09-20-a-screen-older-than-its-database.md).

## What the compiler is told

[`../prelude.md`](../prelude.md) is implicit context for every brief-to-ir
compile and describes what the platform offers *today* — demanding what a
runtime lacks is a compile error — so its text changes in the commit that
changes `schema.cue`, not before. Four edits, and the asymmetry between them is
the point: a sentence in a prompt lowers an error rate, and a check removes the
error, so the prompt says each rule once and a verb enforces it.

- **The prelude's "Entities"** becomes this doc in a paragraph: a durable
  identity under a snake label, types from the closed set, prohibitions in
  CEL, set statements from the closed vocabulary, productions for what the
  system supplies. Then the three moves the first hop has to be told, because
  that hop is where a rename is a judgment: *write a new entity or field with no
  identity, and the mint step stamps it; when the brief renames something, keep
  its identity attributes and change only the label; when the brief drops
  something, mark it retired and never delete it.*
- **A short "Evolution" section** in the prelude: recompiling an app that exists
  is an edit, so the previous ir is read first; the derived list of what changed
  is part of what the team signs; under `stage: production` a change that raises
  the floor is a Decisions entry.
- **The backend seat's gate** (`teams/studio/backend.md`, `teams/squad/eng.md`)
  gains four blocking questions: does every prohibition carry a row it refuses;
  could this statement have been said one level up; is there a SQL string in an
  entity; did an identity vanish. Its note that raw migrations are where an app
  keeps its risk narrows to the raw *rule that contradicts a declared `access`*,
  which is the form that risk takes once a raw migration declares its kind.
- **The narrow hop gets checks and no prose.** `commands/turn.md` already rules
  that a model never adjudicates what a verb can, and identity is that case: the
  append-only lint, the mint tool's refusal of an id it did not write, and the
  refused-row check all run under the `sayt lint` its step 2 already calls. Its
  instruction to re-pin the ir's sha256 goes — nothing reads that pin, six of
  the ten are stale, and the chain that is enforced is the artifact hashes in
  `.pronto/facts.json`.

## Measured, 2026-09-21

- realworld's ir quotes SQL 44 times and paraphrases the same facts about 32
  times ("DDL UNIQUE", "in assembly SQL", "primary key"), all inside a free-text
  notes column where nothing can find them.
- All five partial uniques in the tree write their predicate in PostgREST filter
  grammar, and all five are on browser-tier entities where PostgREST never runs.
- `ref:` means two things and says one. It emits `REFERENCES … ON DELETE
  CASCADE` and it is the edge a validation walks, so chess's `Move.game_id`
  states no relation, primer states one at `tab` where no DDL exists, and
  realworld omits one on purpose to avoid the cascade.
- Today's types are `text` 721, `int` 152, `uuid` 40, `timestamptz` 26,
  `bigint` 12, `bool` 10 and `tsvector` 3, across ten apps, about 129 entities
  and 960 fields. `default:` appears 47 times and `generated:` 19, both as SQL.
- Minting five apps stamped 76 entities and 544 fields. The stamp is textual —
  it reads `{name: "…"` literals inside an entity's `fields: [` list and refuses
  any other shape — and primer refused it once: `Reader` declares nine matrix
  cells three to a line. Two things followed. The stamp now reads several
  literals to a line and only inside the fields list, since a seed row may open
  with `name:` too; and mint computes every stamp before it writes one, because
  that refusal arrived after three entities had been stamped and left a program
  part minted beside a snapshot that was not.
- The check that the ir agrees with the program failed the first time it ran on
  shadcnui, and what it had found was one dropped `</section>`: to a parser,
  126 design objects sat inside `MenuOptionDemo`. Every reader of the ir scans
  attributes with patterns and none sees an ancestor, and nesting is valid HTML,
  so nothing had said so. `ir_nest` in the fact store and one rule in
  `invariants.sql` now do.
- Zero `EXCLUDE` constraints exist anywhere in the tree.
- Postgres emits the RFC types non-canonically even with the session pinned to
  UTC, and differently on each path out of it; the measurement is
  [`../../../libraries/mecha/docs/2026-09-24-a-schema-that-moves.md`](../../../libraries/mecha/docs/2026-09-24-a-schema-that-moves.md),
  "Canonical output". Canonicalisation is a per-path obligation, not a footnote.
- CUE's `time.Time` accepts `+01:00`; `time.Duration` accepts Go syntax;
  `json.Compact` strips whitespace but does not sort keys; and **`uuid.Valid`
  segfaults the pinned cue v0.16.1** — three lines reproduce it — so `uuid` is a
  regex until the pin moves.

## Open

- **Is CEL's type checker reachable?** `cel.ts` calls `parse` only. Walking
  `ParsedExpr` to resolve every identifier against the entity's fields is cheap
  and certain; a real checker would also catch comparing a string to an int.
- **A server row's transitions are unsayable.** A browser-owned row has a
  transition vocabulary and a server-owned one does not. Either machines gain a
  server tier, or CEL gains a binding for the previous row.
- **The partial-unique migration** is five expressions, from PostgREST grammar to
  CEL inside dbt's `config.where`, and it takes the predicate count from three
  languages to one.
- **JCS is ours to implement or vendor**, since nothing in the toolchain sorts
  keys, and it now carries the fingerprint as well as the `json` type.
- **Durability is a dial, and turning it is a migration between holders.**
  [`2026-08-27-what-must-be-reviewed.md`](2026-08-27-what-must-be-reviewed.md)
  makes promoting truco's `Match` from `tab` to `device` the ladder's acceptance
  test. `device` to `offline` is the hard one: the rows are in readers' browsers
  and have to be offered to a server that has never seen them. Rows keyed by
  type id are at least addressable for it; nothing here says who uploads them.
- **What an enum's value rename costs** is stated above and built nowhere: no
  declaration exists for *this value was once called that*.
- **A construction some screen names.** All three full-text vectors are filtered
  by markup as `search=plfts(simple).…`. Once `tsvector` is an index rather
  than a field, the screen typechecker has to admit a filter on a name no field
  carries, and the construction has to keep that name.
- **`app_user` is one table with four shapes.** Four apps declare it, the auth
  service writes `(id, handle)` into it by name, and the emitter special-cases
  the label. Whether it is mecha's entity that an app extends, or an app's entity
  that mecha is told the shape of, decides who mints its type id.

Promotion is decided: every field is a column, and `json` is the way out.
PostgREST, Electric's shapes, row-level security and a CEL rendered as a `CHECK`
all key on columns, and `libraries/pbtables` — a whole message in one JSONB
column beside two promoted ones — bought migration-free additive change at the
price of every one of them. Identity is what makes the column cheap enough to
keep.
