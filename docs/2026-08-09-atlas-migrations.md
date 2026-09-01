# Schema evolution for pronto, with Atlas

SPEC calls schema evolution unsolved: "initdb SQL only runs on a fresh volume.
The declared direction is migration diffing on a schema emitted
deterministically from `#Field`, on the surface mecha reserves for it (Atlas)."
This is that design, constrained by what Atlas measurably does rather than what
it advertises.

## What it costs today

`database` watches `services/database/migrations` with `action: rebuild`. There
are no volumes anywhere (deliberately), so a rebuild is a fresh container, which
re-runs initdb, which is a new database. Adding one nullable column —
`article.cover_url`, 2026-08-09 — destroyed the data twice and orphaned every
session; the accounts behind those tokens stopped existing, which surfaced to a
reader as "you already favorited this" on an article with no favorites, and as
their own profile reporting "No one here by that name."

For an app that lives one afternoon that is an annoyance. For an app that lives
a year it is the reason nobody changes the schema.

## What Atlas can actually do

Measured on realworld with `atlas v0.37.1`, Postgres 18, the app's own emitted
DDL as desired state:

```
atlas migrate diff baseline --to file://schema.sql \
  --dev-url "docker://postgres/18/dev?search_path=public" --dir file://migrations
```

Exit 0. A baseline and an `atlas.sum` are written. And 66 of our 74 objects are
**silently dropped**:

| object | ours | atlas kept |
|---|---|---|
| tables, columns, constraints, generated | 10 | 10 |
| indexes | 9 | 18 |
| CREATE POLICY | 35 | **0** |
| ENABLE ROW LEVEL SECURITY | 10 | **0** |
| functions | 4 | **0** |
| triggers | 12 | **0** |
| publication | 1 | **0** |
| roles, grants, default privileges | 8 | **0** |

Applying that baseline to an empty database yields the tables with no RLS, no
policies, no grants and no publication: every row world-readable, CDC dead. It
is not even self-consistent — it keeps `DEFAULT auth_uid()` while dropping the
function, so `atlas migrate validate` fails with `function auth_uid() does not
exist`. The failure appears on replay, never at generation.

Cause: RLS policies, functions/triggers, and grants/default-privileges are
Atlas **Pro** features (modelled and diffed there, gated behind `atlas login`);
publications are not modelled in either edition. HCL versus SQL is irrelevant —
`--to` accepts both and the drop happens either way. There is no JSON input
form: `.json`/`.hcl.json` desired state is rejected (measured on v0.37.1 and
v1.3.1), and the JSON representation exists only as `schema inspect` output.
Atlas's documented hook for program-generated schemas — the `external_schema`
data source — takes a program that **emits SQL DDL**, so SQL emission is the
blessed integration shape, not a workaround.

Two scopes matter, and only one of them fails:

- **Live diffing is safe.** Against a running database carrying a policy, RLS
  enable, trigger, function, and publication, `schema apply --dry-run` with a
  desired state that omits them plans exactly the intended `ADD COLUMN` and
  nothing else (measured, v0.37.1). Unmodelled object types are invisible on
  both sides of the diff — never authored, never dropped. "Someone else
  manages these" is the built-in semantics.
- **Authoring from scratch fails.** Community Atlas without login cannot
  *recreate* what it cannot see, so a generated baseline is missing the 66
  objects — harmless on a long-lived database, fatal here, where the
  no-volumes dev model rebuilds the database from generated artifacts on
  every boot.

So **community Atlas without login cannot author pronto's schema**, and in a
fresh-replay world, cannot-author means does-not-exist: the replayed app has
no row-level security. Pro moves policies/functions/triggers/grants into
Atlas's half at the cost of an account dependency in an otherwise hermetic
toolchain; the publication stays out regardless.

## The asymmetry that makes it work anyway

Look at *which* 66 it drops:

- **Data-holding**: tables, columns, indexes, constraints. Changing these needs
  a real migration, because there is state to carry across. Atlas handles
  exactly these, correctly — 10/10 tables, generated-column expressions intact,
  foreign keys and checks preserved.
- **Replaceable**: policies, functions, triggers, grants, publications. These
  hold nothing. `CREATE OR REPLACE FUNCTION`, `DROP POLICY IF EXISTS` then
  `CREATE POLICY`, `DROP PUBLICATION IF EXISTS` then `CREATE` — re-declaring
  them is free and always correct.

Nothing needs to diff an object that can be re-declared. Atlas covers precisely
the set that cannot be.

## The design

```
services/database/
  schema.sql       derived; overwritten by every generate. Tables, columns,
                   indexes, constraints — plus the functions a table DEFAULT
                   references, because the dev database must replay it.
  rules.sql        derived; overwritten by every generate. Policies, RLS
                   enables, triggers, grants, default privileges, publication.
                   Idempotent by construction; re-applied on every boot.
  migrations/      append-only, checked in, immutable once applied.
    0001_baseline.sql
    0002_add_cover_url.sql
    atlas.sum
```

`schema.sql` and `rules.sql` stay pure functions of `program.cue`, so
regeneration keeps its whole contract: the compiler owns them and may rewrite
them at will. `migrations/` is the one directory generate may not touch — it is
history, and history is not derivable from the current program.

**Apply order**, and the trap the experiment found:

1. the functions table DDL depends on (`auth_uid`) — *before* the migrations,
   or the versioned DDL references something that does not exist
2. `atlas migrate apply --dir file://migrations` — versioned, only-pending,
   revisions recorded in `atlas_schema_revisions`
3. `rules.sql` — the declarative re-assert

Step 2 is the only part with history. Steps 1 and 3 are idempotent and run
every boot, which is what keeps policies and the publication in step with a
program that changed without anyone writing a migration for them.

## HMR

The dev loop improves rather than degrades. Today's watch entry is
`action: rebuild` on `database`; the proposed one is `action: sync+restart` on
a small `migrate` service:

| | today | proposed |
|---|---|---|
| edit a migration | rebuild database image | sync files, restart migrate |
| what runs | initdb, from scratch | `atlas migrate apply`, pending only |
| data | **destroyed** | preserved |
| accounts and sessions | **orphaned** | intact |

`atlas migrate apply` is idempotent — a restart with nothing pending is a
no-op — so the restart action is safe to fire on every file change.

## What bayt needs: nothing

The whole runtime half is expressible in bayt as it stands.

- `sync+restart` is already one of the actions bayt's `hmr` classification
  emits (`assets`); `configs`, `code`, `tools` and `docs` are the others.
- A `migrate` service is an ordinary service in the graph: an image, a cmd, a
  healthcheck, and `depends_on: database: service_healthy`. The app services
  gain `depends_on: migrate: service_completed_successfully`, which is the
  ordering bayt already emits for `launch`.
- No volume is involved. The revisions table lives in the database being
  migrated, which is the point of it.

What does change lives elsewhere:

- **mecha** grows the `migrate` service and stops mounting migrations as initdb
  configs.
- **pronto's emitter** splits its DDL into `schema.sql` + `rules.sql` instead of
  the numbered initdb set.
- **pronto's `#Loop`** gains the diff at generate time, beside `buildCmd`: run
  `atlas migrate diff` against a throwaway dev database and write a migration
  only when the desired state moved. That step has side effects and needs a
  container, which is why it belongs to generate and not to a build target.

A verify rule pairs with it: fail when `program.cue` has moved and no migration
was written. That is the same staleness gate generate already carries for every
other emitted artifact, and it is what stops a schema change shipping with no
upgrade path.

## What to prove before building

The experiment above proved the **baseline** path. The increment is the whole
point and is unproven:

1. apply the baseline to a database
2. add a column to `program.cue`, regenerate
3. confirm `atlas migrate diff` emits an `ALTER TABLE` rather than a second
   baseline, and that it leaves the generated columns and the platform `txid`
   column alone
4. confirm `rules.sql` re-asserts cleanly over a database that already has the
   policies

Until step 3 holds, this is a design and not a plan.
