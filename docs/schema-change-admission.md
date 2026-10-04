---
type: concept
title: Schema changes
description: What pronto admits when an entity changes — additions and retirements, never a rename, drop or retype — and the four readers that refuse the rest, each seeing what the others cannot.
---

# Schema changes

Pronto admits two kinds of schema change: an addition, and the retirement of a
field. It refuses a rename, a drop and a retype, because some of an app's data
lives where nothing can migrate it. Four checks enforce that, and each sees
something the other three cannot. What an identity is (the type id, the
ordinals, retirement) is [types and identity](types-and-identity.md). How an
author declares a change is [the guide](../GUIDE.md#identity). How a running
cluster notices one is mecha's [schema](../../../libraries/mecha/docs/schema.md),
and what an already-served page does is omnishell's
[data](../../omnishell/docs/data.md#skew).

## Who cannot be migrated

Three kinds of holder carry an app's data, and only the first can be altered.

- **Rewritable**: PostgreSQL tables. An `ALTER` reaches every row at once.
- **Replaceable**: policies, functions, triggers, publications, views. They
  store nothing, so the emitter restates them (`DROP POLICY IF EXISTS` before
  `CREATE POLICY`, `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS`), and
  a correction reaches them by being restated.
- **Out of reach**: a bundle already served to a browser, rows in
  `localStorage` written by whatever program ran last, an unflushed outbox, a
  bookmarked URL. Nothing this repository runs can migrate them. Each is brought
  forward when it is next read, by identity, or refused.

The third class decides what a change may be. An addition costs it nothing: a
holder that does not know a new column carries on. A rename, a drop or a retype
costs it everything, because what it holds stops answering to the name it was
written under, and no deploy reaches a page that is already open.

## What pronto admits

- **An addition**: a new entity, or a new field with a new ordinal.
- **A retirement**: `retired: true` on a field
  ([what it keeps](types-and-identity.md#identity)).
- **A retype**, spelled as a retirement beside an addition.
- **A rename**, spelled the same way: a new field under a new ordinal beside the
  retired one.

**A rename is refused because it can be detected, not in spite of it.**
Identity tells a rename (a name that moved under a living ordinal) from a loss
(a name that left with its ordinal), and it would be easy to take that as licence
to emit `ALTER TABLE … RENAME COLUMN`. It is not one. The emitter writes
`[json_name = "<field>"]` on every field, so every holder reads JSON keyed by
name: a rename survives binary decoding and breaks every reader a rollout has
not reached, including every open page. Telling the two cases apart decides
which message to print, not which change to permit.

## Four readers

A rename spelled the way an escape hatch would spell it:

```sql
DO $$ BEGIN
  EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I', 'article', 'body', 'content');
END $$;
```

| reader | verb | verdict |
|---|---|---|
| squawk (`check-sql.ts`) | `lint` | nothing: a `DO` block's body is a string |
| buf breaking (`check-proto.ts`) | `lint` | nothing: the proto is emitted from `program.cue`, which did not move |
| `identity.ts check` | `lint` | nothing, for the same reason |
| the catalog replay (`check-replay.ts`) | `integrate` | the file and the column |

The same statements written bare give squawk eight findings, so the blindness is
what reading text buys, not squawk's failing, and dynamic SQL is its boundary.

**squawk** reads every `*.sql` under the app that a hatch does not withhold, and
runs wherever the app has a server entity. It refuses renames, drops and
retypes in plain SQL, and it is the only reader of authored hatch SQL as text:
the migrations a model writes outside the vocabulary. It cannot see inside a
`DO` block. Two rules are relaxed. `prefer-bigint-over-int` is excluded
everywhere, because integer width is the type table's decision.
`ban-create-domain-with-constraint` is forgiven in `004_types.sql` alone,
because the `portable_*` domains carry their `CHECK` by design.

**buf breaking** compares every proto under the app with the app's own git
history on `main` (a second argument names another branch), under `WIRE_JSON`
rather than `WIRE`, because holders read the JSON. It is the only reader that
refuses a rename made consistently in `program.cue` and `ir.html` together:
`identity.ts` pairs fields by ordinal and never compares names, while buf
reports `FIELD_SAME_NAME` and `FIELD_SAME_JSON_NAME`. A repository with no
commits has nothing to compare and passes; a repository with history but no
such branch is an error, since a gate comparing nothing would read green.

**`identity.ts check`** refuses an identity that disappeared, changed type or
came back from retirement, whatever the SQL or the proto says
([identity](types-and-identity.md)).

**The catalog replay** runs the app's own database image, applies the
migrations one at a time into an empty database, and reads the catalog after
each. DuckDB (`replay.sql`) joins consecutive states on the relation's oid and
the column's `attnum`, which PostgreSQL keeps across a rename and never reissues
after a drop, and reports a relation that ended (a drop-and-recreate named as
such), a column gone, renamed or retyped. Additions are not findings. The oid is
carried because `attnum` means something only within one relation: `DROP TABLE
t; CREATE TABLE t` restarts it at 1, so on name and number alone an identical
recreate reads as no change. A catalog state does not care how it was reached,
which is why it sees what the text readers cannot.

The replay is a service of the app's build graph, `replay`, whose exit code is
the verdict. It drives the host's daemon through its socket, since only that
daemon holds the images the runtime was built into, and runs under a compose
project of its own, `<app>-replay`, so its `--remove-orphans` cannot take the
running cluster down.

The replay then applies the whole set a second time, onto a copy, with each
statement isolated. A step that cannot be applied twice is a finding, since a
correction below it never reaches a database that already exists; the only
failures forgiven are `004_types.sql`'s domains and casts, which have no `IF NOT
EXISTS` spelling that squawk could still read.

It runs on `integrate` because it grades a built image, and at `priority: 1`
because rules sort by priority and then by name, which would otherwise put
`replay` before the `visual` rule whose `up --build` makes the image.

## Inspection and hatches

Every `.sql` and `.proto` in an app is read. The set is discovered, not listed,
so adding a file cannot quietly escape the readers. Withholding one takes a
`sql`- or `proto`-kind hatch naming its files, and because every hatch carries
`ir`, the exemption is an element of `ir.html` that a reviewer meets, not a
line in a tool's configuration nobody revisits. A `sql` hatch naming a file the
app does not have is an error: an exemption that protects nothing reads like
protection.

An authored file can be withheld, because nobody can fix someone's `SECURITY
DEFINER` trigger from CUE. An emitted one should not be: the remedy for a
finding in derived output is to fix the emitter
([pending](../PENDING.md#schema-changes)).

## pgroll migrations

A fresh volume gets its schema from the emitted migrations, which initdb
applies. A database that already holds a schema is changed by pgroll
migrations, declared in `code.state.migrations` in the grammar mecha's cluster
takes them in, which is pgroll's own, so an operation pgroll lacks fails
`cue vet`. A migration's key is its name: lowercase letters, digits and `_`,
opening with a letter or digit, never the baseline's `00_initdb`, and never
stated again as a `name` field inside it, which the pinned pgroll refuses.
They are not emitted as files: `#DefaultCluster` hands them to the cluster,
whose migrate step applies each one the database's ledger lacks, before the
readers start ([mecha's schema](../../../libraries/mecha/docs/schema.md#carrying-a-live-database-forward)).
pgroll keeps a ledger, so a migration runs once and running it again is a
no-op; that is what lets these be written plainly, with no `IF NOT EXISTS` and
no `DO` block to hide from squawk.

The two paths must not claim the same column:

1. A change to a live schema starts as a pgroll migration, and the entity does
   **not** declare it, so a fresh volume lacks it and the migration applies.
2. Once every deployment has run it, the change moves into the entity and the
   migration is deleted. A live database takes the deletion in its stride: the
   migrate step applies only what its ledger lacks.

The replay checks this. After its two passes it reads the migrations out of the
app's migrate image, runs that image's `pgroll init`, baselines the initdb
schema under the name the cluster publishes, and starts each migration in name
order, reading the catalog after each exactly as for the initdb steps. A
migration that does not apply, such as one adding a column the entity already
declares, is an error at `code.state.migrations.<name>`, and so is one pgroll's
ledger shows it skipped. Step 2 is a manual discipline
([pending](../PENDING.md#schema-changes)).

### Retyping a column from a domain to its base type

The domain/base split ([types](types-and-identity.md#a-domain-only-where-the-output-needs-one))
changes the column type of every field of the nine types that lost their
domain. A database built from the regenerated migrations takes the new types
from initdb. No pronto deployment carries a data directory from one image to
the next: `PGDATA` sits on the database container's writable layer
([mecha's schema](../../../libraries/mecha/docs/schema.md)), and a rebuilt image
recreates the container empty. So no migration is emitted, and the database is
rebuilt with its migrations: a container started again from an image built
before the split keeps its domains, and the first subset an on-demand
collection asks of one is Electric's 400, a ProgramError naming the table.
Comparing the data directory with the initdb steps inside one container cannot
see that, since the container carries the steps that built it. When a pronto
database is deployed, the retype is a pgroll `sql` step, and it is not a one-liner: Postgres
refuses `ALTER COLUMN TYPE` on a column a generated column, a policy or a
column-list trigger reads (golaberto's `season` and `full_name`, ponto's `day`
and `competencia`, realworld's `slug`, every private owner policy), and
re-creating a generated column issues it a new `attnum`, which the replay
reports as a column gone ([pending](../PENDING.md#the-lattice)).

## Rejected

- **Emitting `RENAME COLUMN` once identity detects a rename.** Holders read
  JSON keyed by name, so the rename breaks every reader a rollout has not
  reached.
- **One reader.** squawk is blind inside a `DO` block, buf and identity never
  see hatch SQL, and identity pairs by ordinal and cannot see a consistent
  rename; each of the four is the only one that catches something.
- **Re-appliable DDL through `DO` blocks.** Without a ledger every statement
  wants to survive a second run, and the idempotent spelling for DDL lacking
  `IF NOT EXISTS` hides the statement from squawk. The file that defines every
  type stays bare and fails on a second apply instead.
- **An exemption in a tool's configuration.** Nobody reviews it; a hatch is an
  ir element with a note.
- **`WIRE` for buf breaking.** A rename survives binary decoding and breaks the
  JSON every holder reads.
- **The replay on `test`.** It would grade whatever image the machine held, and
  a verdict about a schema nobody would deploy reads exactly like one about this
  tree.
- **Ordering the replay by its name.** The alphabet is not a contract;
  `priority` says it runs after the images exist.
