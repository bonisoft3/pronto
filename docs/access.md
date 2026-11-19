---
type: concept
title: Access
description: How an entity's declared access becomes the scope column, the tenancy-floor call and the policies at the cluster and the same rule in the browser, what a grant's role and a group allow, who stamps a row's owner, and how a reader inside an aggregate they cannot see gets an exact count.
---

# Access

Who may see and change a row is declared once per cluster entity, as
`#Access` in [`schema.cue`](../schema.cue), and enforced as row-level
security, never as a filter a screen remembers to write. A `tab` or `device`
entity takes none ([the lattice](lattice.md#the-durability-ladder)).
Pronto compiles the declaration into what mecha's tenancy floor needs, a
`scope_id` per row and one call, and into the permissive policies that decide
who inside the floor may do what. The floor, its audit and its tests are
[mecha's](https://github.com/bonisoft3/mecha/blob/v0.29.0/services/database/rls/README.md); the
author's examples are [the guide's](../GUIDE.md#access).

## The modes

The model is Google Drive's, in its words where it is taken
([[decisions/2026-11-13-drive-roles-and-event-origin#Where this is not Drive|and not all of it is]]). `#policySql` and `#tableSql` in
[`emit.cue`](../emit.cue) write, per mode, into `006_policies.sql` and the
table:

| Mode | `scope_id` | Floor | What `app_user` may do |
|---|---|---|---|
| `private` (`owner`) | `'user:' \|\| owner`, generated | `rls_protect` | select, update and delete rows where `owner = auth_uid()`; insert only with that check |
| `private` with `shared` (`via`, `on`, `user`, `group`, `role`) or `groups` (`group`, `of`, `role`) | the same | exempt: the floor is restrictive, and a grantee holds no scope the owner's row carries | the above, or what [the role](#roles) a grant gives them allows, through a `SECURITY DEFINER` helper so the tables' policies do not recurse |
| `folder` (`parent`, `on`) | the parent's, copied by `mecha.scope_from_parent` | as its parent | everything on a row whose unshared `private` parent they may see; under a shared parent, what their role on the parent allows |
| `public` | `'public:'`, generated | `rls_protect` | select; `write: true` also grants all writes; `write: "update"` permits updates to non-key fields only |
| `internal` | none; `app_user`'s is its own id | exempt | nothing, except `app_user` reading its own row |
| `group` (`group`, `user`) | `'user:' \|\| user`, generated | `rls_protect` | select the rows addressed to them; nothing else, so only `service` writes one |

## Roles

A grant carries one of Drive's roles, and the emitted `<table>_role(row)`
answers the caller's: `owner`, `writer`, `reader`, or none.

| | reads the row and what is under it | changes them | edits its grant table | deletes the row, sets another owner |
|---|---|---|---|---|
| `reader` | yes | | | |
| `writer` | yes | yes | unless `writersCanShare: false` | |
| the owner | yes | yes | yes | yes |

`shared.role` names the grant table's column holding the role, a required
`string` the table checks to be `reader` or `writer`; a grant table without one
grants `writer`. The grant table is the entity's own composition, `{scope:
"folder", parent: <the entity>, on: <shared.on>}`, and no other entity's, or its
rows would be written under another's policies; a shared entity's key is `id`.
What a role refuses is an error and never zero
rows: an update finds the row and fails its check, and a `BEFORE` trigger
refuses a delete, an owner change and a composition moved out from under its
parent, none of which a policy, which sees one version of the row, can.

A writer shares the row, as Drive's editor does: they add, change and remove
its grants, to no role above their own, since a grant holds none. `shared:
{writersCanShare: false}`, Drive's setting by its name, keeps the grant table
to the owner. An owner who sets another is left the row's writer, as Drive
leaves them: the cluster replaces the grants of the two with one `writer`
grant to the previous owner, so the grant table's other fields have defaults.
What is under the row takes the new owner's scope with it, which no lifecycle
guard of a composition judges: the row itself did not change.
An entity shared by `groups` alone has no grant table to write that in, and
its previous owner keeps what a group gives them.

A grant row shares one row, with a user or with a group. `shared.group` names
a second column of the grant table, holding a group's id as the membership
list writes it, and a row fills its user or its group, never both and never
neither: which column it fills is the grantee's type, Drive's `user` or
`group`. They are two columns because the sync path gives a column one edge:
the subject's own grants are the grant table by `user`, and a group's are the
grant table by `group`, reached by whoever reads a membership row for it. Both
columns are `required: false`.

An entity also names the groups every row of it is shared with, which no
grant row has to say:

```cue
Company: access: {scope: "private", owner: "owner_id",
	groups: [{group: "everyone", role: "reader"}, {group: "admins", role: "writer"}]}
Advance: access: {scope: "private", owner: "requester_id",
	shared: {via: "advance_grant", on: "advance_id", user: "user_id", group: "group_id", role: "role"},
	groups: [{group: "finance", of: "company_id", role: "reader"}]}
GroupMember: access: {scope: "group", group: "group_id", user: "user_id"}
```

A declared group is one shape over the table however many rows it holds; a
group granted row by row costs what a user's grants cost, one shape for the
list and one for each row it names. So the declared form is for what a whole
entity owes a group, and the grant row for what its owner decides afterwards.

A declared group is `<value>:<group>`, the value being the row's key, or the
column `of` names: company `c1` is read by the members of `c1:everyone`, and an
advance of company `c1` by the members of `c1:finance`, and an advance with
no company by no group. A group granted row by row that ends as one of these does
is told from it where the key is a `uuid`; over a `string` key it is named so
that it cannot be read as `<key>:<group>`. A membership names no entity, so one group name is
read over one entity's keys: `finance` of a company and `finance` of a project
is refused, as is one entity naming a group twice. The program's one
`scope: "group"` entity is the membership list, written by the service from
wherever the program's people are administered.

A group named by `of` adds a generated column `group_<name>` to the table and
to each composition under it, which is what one shape is keyed on; a row moved
to another group takes its compositions along. `of` is a `ref` to a private
or public entity, and the row is written only by someone who reads the row it
names (its owner, where that entity is unshared), so nobody files a row into a
group they are no part of; only the owner files it under another afterwards.
That row's entity is declared first, since the policy calls its role function.
A group over the row's own key is named by the key's text, so that key is a
`uuid` or a `string`.

Who may take a step that depends on the row's state is not a role: it is a
[[../GUIDE#Validations|lifecycle guard]] reading `event._origin`. The origin is
who sent the write; a write a trigger makes, as a handover's grant, has none.
The `pages` and `cloudflare` targets refuse a shared entity: neither serves
the keyed shapes it syncs through.

`write: "update"` uses column grants as well as an UPDATE policy: a reader
cannot create or delete rows, or rename a primary key to replace a seeded row.
Pronto reserves migration prefix `799` for write permissions, after authored
schema migrations and before the generated schedule and seed steps. The additive
`799_write_permissions.sql` drops the previous public write arm and restricts
grants without changing `006_policies.sql`. Fresh databases and the edge script
ledger apply this step. Subsequent changes to an edge deployment still require
an explicit migration: the immutable script ledger refuses changed applied SQL.

Native releases with `write: "update"` also emit `public_access.sql` into the
existing `migrate` service. After pending pgroll migrations, that runner reapplies
only those update-only restrictions in a transaction, even on a database whose
initdb marker is set. Compose readers wait for it; Kubernetes and GCP execute
its Job before rolling readers. A lock waits at most five seconds and a
statement sixty seconds; failure rolls back the reconciliation and fails the
release. Other public tables and their authored policies and grants are untouched.
Leaving `write: "update"`, changing an access scope or removing a table requires
an authored migration. Reconciliation does not reverse earlier restrictions.

Every table grants `service` everything. An exempt table gets a row in
`mecha.rls_exempt` with its reason in words, the short list a reviewer reads.
A shared entity, its grant table, a child of a shared parent and a table that
names a group by a column each declare a `mecha.shape_key`, so the sync path
can deliver a row the floor does not.
`access` is optional at the cluster rungs, and an entity that omits it gets no
policy, no floor and no `rls_exempt` reason while `002_grants.sql` grants
`app_user` every table, so every signed-in reader may read and write all its
rows; `mecha.rls_unprotected` would name it, and no app check queries that
([pending](../PENDING.md#access)).

**The generator never writes the floor's text.** It emits `CALL
rls_protect('<table>')` and the `scope_id` derivation, so it cannot emit a
subtly wrong floor, and a correction to the floor reaches every app by
migration rather than by regeneration. The floor holds even when the
generator is bypassed.

## Emitted database access model

For a program with a server tier, `#emit.access` exposes the desired database
roles, role settings, authenticator memberships and schema/table grants as
CUE data. `001_roles.sql`, `002_grants.sql` and the grant in
`008_publication.sql` render from this model in [[../emit.cue]]. It is derived
from the program; it is not an operator-supplied access policy.

Generated provisioning (the default) is not a database-state audit or a
complete provisioning contract. The SQL does not enforce every negative
attribute on an existing built-in role, such as `superuser: false`. Membership
options and grant ownership, function/column grants, the tenancy floor and
token-role reconciliation are not fully represented. Inspecting this value
therefore does not establish that an existing database conforms to Pronto's
access requirements; [checked provisioning](#generated-or-checked) does
that for the parts below.

### Generated or checked

`state.provisioning` says who provisions the roles. Absent, or `"generated"`,
it is pronto's migrations, as above. `"checked"` is the instance's owner: the
database arrives with the model's roles, memberships, settings and schema
grants already in place, and every release compares the database with the model
before its migrations, and stops at any difference. It is an app knob, not a
release one, since compose, k8s and gcp share one database image and its initdb
directory. The program needs a server tier. Nothing about the emitted tables,
policies or table grants changes.

`001_roles.sql` holds the check, so a fresh database that was not provisioned is
refused before any table exists, followed by the grants on objects the migrating
login owns (electric's tables and default privileges). The cluster's
`reconcile.roles` holds the same check ahead of the token roles' list, which
mecha's migrate runs before the ledger on every release (`roles.sql`, before
`pgroll init`), so a refused release has written no ledger row. In checked mode
no emitted statement creates a role, sets an attribute or setting, grants
membership, or grants on the schema.

The check is one `DO` block, rendered from the same `#access` value as
generated mode, and reads catalogs any login can read. On a difference it raises
with every statement that fixes it in `DETAIL`, in an order the owner can run
top to bottom, and a `HINT` that says so. Against an empty database, `DETAIL` is
the owner's whole provisioning script, which is also emitted as
`services/database/provision.sql`.

| Phase | Compared | Fix |
|---|---|---|
| role | each model role exists with all seven attributes (`LOGIN`, `INHERIT`, `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `BYPASSRLS`, `REPLICATION`) | `CREATE ROLE` or `ALTER ROLE ... WITH` all seven |
| owner | no model role owns the database | `ALTER DATABASE ... OWNER TO` the migrating login |
| member | each `memberOf` edge exists | `GRANT` |
| extra | a model role belongs to nothing beyond its `memberOf` | `REVOKE ... GRANTED BY` each grantor |
| setting | each role-wide setting has the model's value | `ALTER ROLE ... SET` |
| override | no database-level setting hides one | `ALTER ROLE ... IN DATABASE ... RESET` |
| schema | each schema grant is held, and no model role, nor PUBLIC, holds `CREATE` on it | `GRANT`, `REVOKE CREATE` |
| login | the migrating login has `public` first on its search path, `USAGE` and `CREATE` on it, and bypasses RLS | `ALTER ROLE`, `GRANT` |

The migrating login need not own the roles: `NOSUPERUSER` and
`NOCREATEROLE` suit it. Beyond what the check holds it needs `LOGIN`, `CREATE`
on the database (mecha's tenancy floor, pgroll's own schema, and the schemas
graphile_worker and airlock create), ownership of the app's tables, which it
gets by creating them, and the extensions `000_extensions.sql` names, created
beforehand by the owner: `CREATE EXTENSION IF NOT EXISTS` finds one that exists
without asking for a privilege. It needs `BYPASSRLS` because validation
migrations and machine writers run as it under forced row-level security.

The check refuses any difference, not only a missing one. A setting that is the
same duration spelled differently (`'5000'` for `'5s'`) differs, and is refused.
Membership options (`inherit_option`, `set_option`), roles outside the model
that are members of model roles, passwords (`pg_roles` hides them; they are the
deployment's secrets) and request roles' `search_path` (PostgREST sets it per
request) are not compared. A provider that names an attribute differently, such
as RDS's `rds_replication` for `REPLICATION`, fails the role phase; that
equivalence is a model change argued as a decision, not a loosening of the
check.

On k8s and gcp the "already built" branch of the initdb Job re-runs 005-008
before migrate's check, so a role dropped since the last release fails 006's
policies with PostgreSQL's own error before the check names the fix. The
release still fails.

Named follow-ups, none taken by the program that turns `checked` on:

- *Local stack for a checked app.* mecha's database service runs initdb, whose
  001 refuses an unprovisioned database, so a checked app has no local stack
  until that service runs the owner's script.
- *Role passwords.* mecha's `899_role_passwords.sh` runs `ALTER ROLE ... PASSWORD`
  at initdb, which needs `CREATEROLE`; a checked database needs mecha to skip
  it where the owner provisioned the roles.
- *External `DATABASE_URL`.* A release target that takes the owner's database
  instead of creating one; gcp creates its own Cloud SQL and its
  `ALTER ROLE postgres BYPASSRLS` and token-role grants need `CREATEROLE`, so
  gcp stays generated.
- *A schema other than `public`.* The model fixes `schema: "public"` and mecha's
  ledger names it, so `CREATE` on `public` is a requirement the login phase
  states, not one it removes.
- *Re-running 001 on the already-built branch.* Closing the gap above needs a
  release-schema field naming the re-run list.
- *Function and column grants, `mecha.token_role` rows and extensions.* The
  check holds none of them.

## Declared token roles

A [declared token role](identity.md#token-roles-and-trusted-issuers) is a
Postgres role a token names, in `state.tokenRoles`, and the policies above
stand unchanged for it: each names `app_user`, so none admits it, and it holds
no grant `002_grants.sql` gives the others. Unlike `service` it never
bypasses the floor: a release refuses a declared role holding BYPASSRLS. What
it may do is the app's own SQL, in the order of preference:

- `GRANT EXECUTE` on a function it alone calls, after `REVOKE EXECUTE ... FROM
  PUBLIC`, since Postgres lets PUBLIC execute a new function. A `SECURITY
  DEFINER` function owned by the migration role writes what it writes, past
  the floor, and nothing else;
- a grant on a table with a policy `TO` the role, under the floor: its
  subject is its token's `sub`, so `current_scopes()` is `public:` and
  `user:<sub>`, and the rows it reaches are those, or what the policy adds.

```sql
CREATE FUNCTION advance_residual() RETURNS json LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ ... $$;
REVOKE EXECUTE ON FUNCTION advance_residual() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION advance_residual() TO residual_bot;
```

A token another issuer signed acts as a declared role and nothing else, and
the cluster's own roles act only on a token naming the stack's own issuer: the
floor's `app_pre_request` refuses a declared role to a token naming the stack's
issuer or none, and the cluster's roles to one naming another
([identity](identity.md#token-roles-and-trusted-issuers)).

A role the database already holds is taken for a token role only if it holds
no more than one: the emitted SQL refuses one that logs in, is a superuser,
bypasses row-level security, creates roles or databases, replicates, or owns
the database.

## The browser's mirror

`shell.yaml` carries each table's access, and the store's `visible()`
re-applies it on every local read: a `private` row is the reader's, or granted
through the `via` rows they hold or a group whose membership row they hold, a
`folder` row is visible exactly when its parent is, `internal` is never
visible, and a row the session wrote and the cluster has not confirmed is
always visible. A change to a grant table, the membership list or a parent
re-renders the regions that depend on it, so an unshare revokes the row from
an open screen. The mirror is of reading only: a reader's write is run and
then refused by the cluster
([pending](../PENDING.md#access)).

So policies added in raw SQL may widen access only where the mirror already
allows, and may narrow it freely. `#Access` has no "everyone reads, the owner
writes" mode, because `public` names no owner and its optional write arm applies to everyone:
realworld's `011_owner_writes.sql` hand-writes owner-gated arms for `article`
and `comment` and restates their owners
([pending](../PENDING.md#access)). Declaring such a table `private` and
widening its SELECT in SQL instead would make it mean "mine" to the browser
and "everyone's" to the server.

## Who the owner is

The owner column names a row's subject, and `WITH CHECK (owner =
auth_uid())` refuses a spoofed one. When the client omits it, the apps fill it
with a column default, `default: "auth_uid()"` on the field, so `auth_uid()`,
which mecha's database image defines in its tenancy floor `003_rls.sql`, must
exist before `005_create_tables.sql` creates the table. Moving the stamp to an
emitted trigger beside the policies is
[owner stamping](decisions/2026-08-31-owner-stamping.md), which is not built.

## A count the reader is inside of

Ask first whether the reader can see the rows the aggregate is over. If they
can, count them in a live query and the optimistic overlay is exact in both
directions. If they cannot — a favourite count over private favourites — the
number to show is

    shown = others + intent

where `intent` is whether this reader wants their own contribution counted,
a local fact, and `others = total − mine_counted`. `mine_counted` is not
whether the reader has a row: it is **whether the read that produced this
total counted them**, a property of that read. Nothing local can recover it,
because a bounded row cannot carry unbounded history. So the pipeline that did
the read states it, per reader, in a private pair table: `counted`, `total`
and `asOf` in one row
([the fold that writes it](pipelines-and-schedules.md#the-shapes)). A count
discloses nobody, only the acting reader's row is written, and `total` rides
in the same row because Electric streams per shape: two tables never arrive
together, even from one transaction.

The store evaluates three cases from synced collections, so the value is
there at boot and offline (`othersFor` in omnishell's `data-sync.js`):

1. **The sink's watermark covers the reader's acknowledged row**: the read saw
   that version, so `mine_counted` is its state.
2. **Otherwise the pair's own read**: `total − counted` is older but never
   wrong.
3. **No pair was ever written**: no read counted this reader.

`others` cannot change under the reader's own writes, so nothing is held or
reconciled, and offline is not a special case. The pair is a table because
logical replication publishes tables only; a per-reader view would not sync.
When testing optimistic UI, the converged database is the oracle, not the
frames on screen.

## Rejected

- **A grant that carries the owner's power**: a grantee set the owner to
  themself and deleted the row
  ([[decisions/2026-11-13-drive-roles-and-event-origin|the record]], which
  holds the other alternatives to roles and groups).
- **Visibility as a filter a screen writes** — one forgotten filter is a
  breach, and the policy is the one place a reviewer reads it.
- **Emitting the floor's policy text from the generator** — a guarantee that
  lives in the generator is weaker than one that holds when it is bypassed.
- **Declaring `private` and widening SELECT in SQL** — the browser keeps
  believing the declared mode, so one table means two things.
- **Inferring `mine_counted` locally.** From the sink's `txid`: stamped when
  the sink is written, after the read, so rows committed in between look
  counted. From last-assertion and last-retraction txids: wrong at the third
  unseen change. From parity: two changes look like none, and the guess moves
  with every pending → synced transition. From a client version trace: the
  optimistic overlay hides the server versions a lagging sink reads.
- **Holding the displayed value during a gap** — a symptom of tracking
  `total − mine` instead of `others`.
