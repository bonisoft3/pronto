# Refusing a schema change

A database will apply any statement it can parse, and a linter will read any
statement it is shown. Neither knows that a column has an ordinal, that an
entity has an identity older than its name, that the type set is closed, or that
some of this app's rows live in a browser nobody can reach. Pronto knows all of
that, and this doc is what it does with it: which changes it refuses, and what
enforces each refusal.

What an entity's identity *is* — the type id, the ordinals, retirement — is
[[2026-09-21-an-entity-is-what-everything-points-at.md]]. How a change reaches a
running cluster is
[`../../../libraries/mecha/docs/2026-09-24-a-schema-that-moves.md`](../../../libraries/mecha/docs/2026-09-24-a-schema-that-moves.md);
what an already-served page does about it is
[`../../omnishell/docs/2026-09-20-a-screen-older-than-its-database.md`](../../omnishell/docs/2026-09-20-a-screen-older-than-its-database.md).

## What a change is allowed to be is decided by who cannot be migrated

Three kinds of holder carry this app's data, and only the first can be altered.

**Rewritable.** Postgres tables. An `ALTER` reaches every row at once.

**Replaceable.** Policies, functions, triggers, publications, views. Nothing is
stored in them, so they are re-declared rather than migrated, and a correction
reaches them by being restated.

**Out of reach.** A bundle already served to a browser. Rows in `localStorage`
written by whatever program was running last time. An unflushed outbox. A URL
someone bookmarked. None of these can be migrated by anything this repo runs.
Each is brought forward when it is next read, by identity, or it is refused.

That third class is the whole argument. An addition costs it nothing: a holder
that does not know about a new column carries on. A rename, a drop or a type
change costs it everything, because the thing it is holding stops answering to
the name it was written under — and no deploy, no migration and no amount of
care reaches a page that is already open.

## A rename is refused because it can be inferred

Identity makes renames *detectable*: a name that moved under a living ordinal is
a rename, and a name that left with its ordinal is a loss. It would be easy to
read that as licence to emit `ALTER TABLE … RENAME COLUMN` and call the problem
solved.

It is not, and the reason is worth stating plainly: **being able to tell a
rename from a drop-beside-an-add does not make a rename safe.** The emitter
writes `[json_name = "<field>"]` on every field it generates, so what a holder
reads is keyed by name. The rename survives binary decoding and breaks every
reader of the JSON — which is every reader a rollout has not reached yet, and
every page already open. Distinguishing the two cases tells you which message to
print, not which change to permit.

So the vocabulary has one move here, and it is not a rename: a field is
**retired**, `retired: true`, and its ordinal stays spent forever. A new name is
a new ordinal beside the old one. A type change is the same shape — a retirement
beside an addition — for the same reason.

## Four readers, because one cannot see

Four passes guard this, and the division between them was measured rather than
argued. A rename spelled the way an escape hatch would actually spell it —

```sql
DO $$ BEGIN
  EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I', 'article', 'body', 'content');
END $$;
```

— produces the following verdicts:

| pass | verdict |
|---|---|
| squawk (`check-sql.ts`, lint) | `[]` — it reads statements, and a `DO` block's body is a string |
| buf breaking (`check-proto.ts`, lint) | `[]` — the proto is emitted from `program.cue`, which never moved |
| `identity.ts check` | `[]` — same reason |
| the catalog replay (`check-replay.ts`, integrate) | **caught it**, naming the file and the column |

The same three statements written bare produce eight findings from squawk. So
the blindness is not squawk's failing; it is what reading text buys you, and
dynamic SQL is the boundary of it.

Each pass is also the only one that sees something:

**squawk** refuses renames, drops and retypes in plain SQL, and it is the only
pass that reads authored hatch SQL as text — the migrations an LLM writes
outside the vocabulary. It cannot see inside a `DO` block, and it does not
notice a statement that cannot be applied twice.

**buf breaking** compares the emitted proto against the app's own git history
under `WIRE_JSON`. It is the only pass that refuses a rename spelled
*consistently* — changed in `program.cue` and in `ir.html` together. `lost()`
pairs fields by ordinal and never compares the name, so identity reports nothing
about that case; buf reports `FIELD_SAME_NAME` and `FIELD_SAME_JSON_NAME`.

**the replay** applies the migrations one at a time into an empty database and
reads the catalog after each, joining consecutive states on the relation's
identity and the physical column number, which Postgres keeps across a rename
and never reissues after a drop. A catalog state does not care how it was
reached, which is why it sees what the text passes cannot. It is also the only
pass that finds a migration which cannot be applied a second time — the class
squawk reports nothing about.

The oid is carried because attnum means something only within one relation:
`DROP TABLE t; CREATE TABLE t` restarts it at 1, so on name and number alone an
identical recreate reads as no change and a differing one as a column rename. A
relation that ends is reported in its own right.

**pgroll** keeps a ledger, so a migration runs once and running it again is a
no-op. That is not a check; it is what removes the pressure that created the
blindness. Without a ledger every statement wants to be re-appliable, and the
idempotent spellings for DDL that lacks `IF NOT EXISTS` all route through `DO`
blocks — the exact construct squawk cannot read. The emitted type migration
stays bare and simply fails on a second apply, because buying re-appliability
with a blind spot is the wrong trade for the file that defines every type.

## Inspection is default-on; a hatch is a declared exemption

Every `.sql` file and every `.proto` in an app is read. The set is discovered,
not listed, so adding SQL cannot quietly escape the checks.

Withholding one is a declaration: a `sql`- or `proto`-kind hatch naming the
files. Because every hatch carries `ir`, that declaration is *also* an element
in `ir.html` — so an exemption costs a spec element a reviewer meets, rather
than a line in a tool's config that nobody revisits. A hatch naming a file the
app does not have is an error; an exemption that protects nothing reads like
protection.

The distinction that decides where an exemption may live: an authored file can
be withheld, because you cannot fix someone's `SECURITY DEFINER` trigger from
CUE. An emitted file cannot, because the remedy for a finding in derived output
is to fix the emitter.

Two squawk rules are relaxed, differently. `prefer-bigint-over-int` is excluded
everywhere: integer width is the type table's decision, so a column squawk reads
as a future overflow is one the program already bounds.
`ban-create-domain-with-constraint` is forgiven in the emitted type migration
alone, because the `portable_*` domains carry their `CHECK` by design — which is
what makes the domain canonical rather than a naked base type.

## A column is declared in exactly one place at a time

A fresh volume gets its schema from the emitted migrations, which are built from
the entity declarations. A database that already exists gets changes from
pgroll. Those two paths must not both claim the same column.

1. A change to a live schema starts as a pgroll migration. The entity does
   **not** declare it, so a fresh volume lacks it and the migration applies.
2. Once every deployment has run it, the change is folded into the entity
   declaration and **the migration is deleted**.

Declaring both at once fails, loudly and correctly: initdb creates the column
and pgroll then reports `column "subtitle" already exists in table "article"`.
That is the rule being enforced, not a defect.

Nothing automates step 2 and nothing yet reminds anyone to do it. A migration
left declared after its effect has been folded in fails every fresh-volume
replay — the right failure, and still a manual discipline.

## What is not here

The replay grades a built image, so it runs on `integrate`, the verb whose bayt
target brings the stack up. On `test` it would grade whatever image the machine
happened to hold, and a verdict about a schema nobody would deploy reads exactly
like a verdict about this one. Anything needing a built image belongs in that
group for the same reason.

The verb alone does not order it. Rules sort by priority then name, so at the
default `replay` precedes `visual`, whose `up --build` makes the image;
`priority: 1` is what puts it after.

The write path is still open: a handler can put an undeclared key into a device
row, and `normalizeRow` passes unknown columns through untouched. Nothing above
sees it.
