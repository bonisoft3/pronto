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
cluster notices one is mecha's [schema](https://github.com/bonisoft3/mecha/blob/v0.20.6/docs/schema.md),
and what an already-served page does is omnishell's
[data](https://github.com/bonisoft3/omnishell/blob/v0.21.7/docs/data.md#skew).

An app can keep applied bootstrap bytes by naming them in `state.rawMigrations`.
An entry named `003_rls.sql` replaces mecha's tenancy floor for both the native
database image and page or edge releases. One named `005_create_tables.sql`
keeps the tables a live database applied, so a column added to a baseline
entity rewrites no applied script and arrives in a forward migration alone.
Entries named as the row machines'
or the reducers' step (`010_machines.sql` and `016_mecha_actors.sql`, or where
`state.steps` places them), or as a declared Cortex source migration, replace
those generated scripts. Each name may be declared once; its source is copied
without regenerating it. Omitted entries keep the current generated or mecha-provided
scripts. Carry changes to an applied baseline in a forward `state.migrations`
pgroll migration; the ledger still refuses a changed digest. A machine added
after `010_machines.sql` was pinned takes its guard from the same generator,
never a copy: `(pronto.#mechaMachineSql & {machine, entities, effects, runtime:
false}).out` as the migration's SQL.

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

**buf breaking**, enabled when `CI` is set to a nonempty value other than
`0` or `false`, compares every proto under the app with the app's own git
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

**The catalog replay** runs the app's own database and migrate images. It
applies initdb once to an empty database, then invokes the migrate image's
entrypoint and command with the same environment as the runtime. Every
declared pgroll migration must be completed in the ledger. Running that
migrator again must leave the public schema, stored rows and ledger unchanged.
Initdb is not replayed against a populated database: retained volumes advance
through the migration ledger, not through their bootstrap scripts.

A fresh bootstrap can create temporary tables before replacing them with
views. Those intermediate objects have no deployed readers. Compatibility is
checked across retained upgrade fixtures, rather than between bootstrap steps.
`tests/replay.json` lists those fixtures:

```json
[
  {
    "name": "feed-view",
    "omitInitdb": ["020_feed_view.sql"],
    "through": "010_previous",
    "seed": "tests/replay/feed-before.sql",
    "verify": "tests/replay/feed-after.sql",
    "replacements": {
      "feed": {"kind": "view", "note": "Computed from retained source rows."}
    }
  }
]
```

Each fixture builds the prior schema by omitting exactly the named initdb
steps, runs the actual migrator through an existing migration, then loads
representative retained data from `seed`. The full migrator must upgrade it
and restart without changes. `verify` must return exactly one PostgreSQL
boolean `true`; SQL errors fail the check. Assertions should cover source-row
preservation, reader behavior and permissions. This is a reproducible prior
schema fixture, not a claim to cover every deployed database version.

The catalog includes tables and views. `replay.sql` compares relation OIDs and
column ordinals across the upgrade, rejecting lost/recreated relations and
removed, renamed or retyped columns. Additions are allowed. A fixture may name
an intentional projection replacement with its resulting `kind` (`table`,
`view` or `absent`) and a rationale. It must exist before the upgrade; surviving
replacements must retain the old reader columns and types. Its data and access
semantics belong in `verify`. Every unnamed relation keeps the strict identity
check: replacing a cache does not exempt its source tables.

The replay runs on `integrate` inside `ci-replay`'s Dockerfile `RUN` layer,
where `process-compose` brings the database up and runs `replay` against it. A
fresh bootstrap/restart check without retained fixtures does not establish
upgrade compatibility.

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
readers start ([mecha's schema](https://github.com/bonisoft3/mecha/blob/v0.20.6/docs/schema.md#carrying-a-live-database-forward)).
pgroll keeps a ledger, so a migration runs once and running it again is a
no-op; that is what lets these be written plainly, with no `IF NOT EXISTS` and
no `DO` block to hide from squawk.

The two paths must not claim the same column:

1. A change to a live schema starts as a pgroll migration, and the entity does
   **not** declare it, so a fresh volume lacks it and the migration applies.
2. Once every deployment has run it, the change moves into the entity and the
   migration is deleted. A live database takes the deletion in its stride: the
   migrate step applies only what its ledger lacks.

The replay runs the shipped migrator on the fresh schema and checks its
completed ledger, so a migration that conflicts with a folded-in column fails.
Retained fixtures exercise the same runner over earlier schemas and data.
Folding a change into initdb remains a deployment discipline
([[../PENDING#schema-changes|pending work]]).

### A new entity on a live database

The baseline scripts, `005_create_tables` through `010_machines`, are each
emitted over every entity, so declaring one rewrites them, and a database that
applied them refuses a changed script: the edge's ledger checks every applied
script's digest before it applies anything. The first path above cannot help,
since an entity a reader syncs, a policy guards and a machine drives has to be
declared.

So an app whose database outlives a release names the entities its baseline
holds, `code.state.baseline.entities`. The baseline scripts are then emitted
over those alone, byte for byte what the database applied, and each later
server entity gets one pgroll migration, `<after>_<table>`, generated with what those scripts
would hold for it: the table, its indexes, its policies, its txid trigger, its
place in both publications, its `anon` grant and its machine. A fresh database
applies it after the baseline; a live one applies it as a migration its ledger
lacks. `baseline.after` must sort past every migration a live database has
run, since a container's migrate step refuses one that sorts before them, and
a migration of the app's that reads the new table sorts after it. The list
never changes once a database has run it: an entity added later stays in its
own migration for good.

That migration is generated from the entity as it stands, and a database that
ran it refuses changed text, as it refuses a changed baseline script. So once a
release has carried it, the app owns its bytes: it declares that same name in
`state.migrations` with the text the release applied, and the emitter generates
nothing under it. A change to the entity or its machine is then carried by a
migration that sorts after it: the new columns, and the machine restated by
`#mechaMachineSql` with `runtime: false`, which a fresh database runs after the
kept one just as a live one does. The emitter refuses a kept migration its
entity has moved past unless a later migration names the table and
`state.baseline.carried` holds the digest of what it would generate today, which
the refusal prints; so each further change is refused again until the app writes
the migration that carries it and acknowledges the new digest. The emitter
cannot tell that a release ran a migration it still generates: keeping the
bytes is the release's step.

A later entity cannot declare validations, which `009_validations` holds for
every entity, and a change to an entity the baseline already holds still
rewrites its script, so it is a pgroll migration as above. What a later entity
cannot drive is below.

### What a live directory carries

An edge release that keeps its data directory, or starts one from an archive
([release targets](release-targets.md#cloudflare)), carries it forward with
every script of the release its ledger lacks: the pgroll set, and the files
too — a framework step the program places (`060_graphile_worker.sql`,
`061_airlock.sql`), the reducer actors (`0NN_mecha_actors.sql`), the database
functions, a raw migration added since. The ledger (pglite-workerd's
[`scripts.ts`](https://github.com/bonisoft3/mecha/blob/v0.20.6/packages/pglite-workerd/scripts.ts))
is established when a directory is built, and for an archive when it is
restored: the files of the release that built its database, as the restore is
told them, and the pgroll migrations the database's own pgroll ledger holds,
by the text each ran. A directory restored without it is refused.

**The order is the fresh one: the release's files, in the order a fresh
directory applies them, then its pgroll set in name order.** Only the scripts
the ledger lacks run, but they run in that sequence, whatever their names
sort as, and a pgroll migration owed that sorts before one the directory
already applied is refused naming both, as mecha's migrate step refuses it,
since a fresh directory would run it first. A fresh directory ran every file before any pgroll migration, so a
pgroll migration may name what a file made (a view over a reducer's `instance`
table, a grant on `graphile_worker`) and a file may not name what a pgroll
migration made; a carry in the same order admits exactly the scripts a fresh
directory admits, and a database built fresh and one carried from an archive
hold the same schema. The cost is on the author of a live database whose
baseline predates something a file needs: a seat table the actors drive, a
type function a table's check calls, has to reach the live directory as a
file step sorting before the step that needs it (`CREATE … IF NOT EXISTS`,
`CREATE OR REPLACE`), not as a pgroll migration; on a fresh directory that
file is a no-op after the baseline.

So a later entity still cannot drive a reducer: its table arrives in a
pgroll migration, after the actors step, on a fresh directory and on a
carried one alike. Lifting that is the emitter's, not the carry's: the actors
over a later entity would have to be compiled into the entity's migration, as
a row machine's SQL is, and `compileMechaReducer` runs where files are
written. A Cortex machine is in the same position.

Rejected orderings:

- **Every lacking script in byte order of its name**, files and pgroll mixed
  (the ledger's first rule). A placed step `060_…` sorted after a pgroll
  migration `052_…` that a fresh directory runs after it, and the actors
  `063_…` before the migrations `20261108_…` that make the tables they
  drive; the sequence depended on how the program numbered its steps and
  dated its migrations, and a migration valid on a fresh directory failed on
  a carried one.
- **The lacking files after every lacking pgroll migration**, so an actors
  step finds a later entity's table. It inverts the fresh order: a pgroll
  migration that names a reducer's or a framework step's objects, valid on
  a fresh directory, fails on the carry, and the two directories admit
  different scripts. It would also leave the fresh directory refusing the
  actors over a later entity that the carry accepts.
- **The lacking files after the later entities' migrations and before the
  rest**, a cut in the pgroll stream at `baseline.after`. The carry would need
  the baseline to find the cut, pgroll migrations that sort before the cut
  would run after ones that sort after it, and a later entity's migration
  that needs a function another migration carries would run before it.
- **Running the pgroll set from the archive's own `pgroll` ledger** and the
  files from `_pronto_migrations`, two ledgers with two rules. The archive's
  pgroll ledger is read once, at restore, into the one ledger a directory
  carries; its text is the authority for what the database ran, and a
  release whose text moved since is refused as any changed script is.

### Retyping a column from a domain to its base type

The domain/base split ([types](types-and-identity.md#a-domain-only-where-the-output-needs-one))
changes the column type of every field of the nine types that lost their
domain. A database built from the regenerated migrations takes the new types
from initdb. No pronto deployment carries a data directory from one image to
the next: `PGDATA` sits on the database container's writable layer
([mecha's schema](https://github.com/bonisoft3/mecha/blob/v0.20.6/docs/schema.md)), and a rebuilt image
recreates the container empty. So no migration is emitted, and the database is
rebuilt with its migrations: a container started again from an image built
before the split keeps its domains, and the first subset a lazily read
collection asks of one is Electric's 400, a ProgramError naming the table.
Comparing the data directory with the initdb steps inside one container cannot
see that, since the container carries the steps that built it. When a pronto
database is deployed, the retype is a pgroll `sql` step, and it is not a one-liner: Postgres
refuses `ALTER COLUMN TYPE` on a column a generated column, a policy or a
column-list trigger reads (golaberto's `season` and `full_name`, realworld's
`slug`, every private owner policy), and
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
- **The replay on `test`.** It grades the built database and migrate images.
