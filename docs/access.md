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
[mecha's](https://github.com/bonisoft3/mecha/blob/v0.36.0/services/database/rls/README.md); the
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

## Field behaviour

A role decides who may write a row; a field's behaviour decides which of its
fields any client may write, the same for every caller. The words are Google
[AIP-203](https://google.aip.dev/203)'s, and the model is Drive's, whose API
marks a file's `modifiedTime`, `version` and `lastModifyingUser` "Output only".
No role reaches a column.

- `outputOnly: true`: the server sets it. A value a client sends is cleared
  and never refused, as AIP-203 asks: a client's insert takes the column's
  default (the machine's initial for its state field, NULL where none is
  stated), and its update keeps the column's value.
- `immutable: true`: set when the row is created and never changed. A client's
  update stating the value the row holds passes, and one changing it raises
  SQLSTATE 22023 `invalid_parameter_value`, which PostgREST answers 400. A
  `json` or `geojson` value is compared as the value it states, as `jsonb`
  compares it, so an object restated with its keys in another order passes.

A client is a role a token names, the one a write through PostgREST runs as:
any role `authenticator` may switch to (`001_roles.sql` grants it `anon`,
`app_user`, `service` and each declared token role), but `service`, whose
token is the server's own. The trigger asks the membership rather than a
list, so a token role declared after it was emitted is held too. Each entity
stating either word gets one BEFORE INSERT OR UPDATE trigger,
`0_<table>_field_behavior`, whose function is not SECURITY DEFINER, so it
reads `current_user` as the statement's own role. A write a machine or
lifecycle trigger makes runs as that trigger's owner, since those are
SECURITY DEFINER, and no token names the owner; the service, a computation's
sink, a seed and a migration are no client either: all of them write both
fields. A database with no `authenticator` takes no write through PostgREST,
and holds nobody. A table's
triggers fire in the order of their names, and a digit sorts before every
name the program gives one, so a machine's interpreter reads NEW after the
client's values are cleared or refused, and its own assigns stand.

The triggers are `799_field_behavior.sql`, a step of their own beside
`799_write_permissions.sql`, so no applied step changes; a later entity's
migration carries its own. Native releases reapply them as
`field_behavior.sql` in the `migrate` service, as `public_access.sql` is,
so a database whose initdb ran before a field stated its behaviour holds it.
Reconciliation also drops the trigger of every server table that states no
behaviour, so a database that held one agrees with a fresh one; the drop
locks a table only where its trigger stands. It rides a reconcile the release
runs anyway, as the token roles' prune does, and starts none of its own: a
program whose last behaviour goes, with nothing else to reconcile, takes the
trigger off in an authored migration.

The rest of the app is held to the same words before anything reaches the
database: `cue vet` refuses either word on a key, a generated or a retired
field, or a row machine's state field (a client moves the machine by writing
it, and the interpreter reads the value written as the target, so either word
would make every move a silent no-op or a refusal; a Cortex machine, whose
events arrive as command rows, is exempt), both on one field, a form naming an output-only field and an update
form naming an immutable one; the terminal's markup check refuses a chart
whose assigns, transitions, empty row or effects write an output-only field
or change an immutable one, and a form control naming one; the battery
refuses a handler's update doing the same; and the store drops an output-only
value and refuses an immutable change before its optimistic row stands,
which for a `tab` or `device` entity is the whole of the enforcement. A
server row machine's own `assign` runs in the database as its owner, and is
no client's.

## Emitted database access model

For a program with a server tier, `#emit.access` exposes the desired database
roles, role settings, authenticator memberships and schema/table grants as
CUE data. `001_roles.sql`, `002_grants.sql` and the grant in
`008_publication.sql` render from this model in [[../emit.cue]]. It is derived
from the program; it is not an operator-supplied access policy.

### Generated or checked

With `state.provisioning` omitted or set to `"generated"`, Pronto creates
and grants the roles. Existing roles can retain attributes that differ from
the model. For example, generated provisioning leaves an existing role's
`SUPERUSER` attribute alone.

Set `state.provisioning: "checked"` on a server program to generate a check
for an owner-provisioned PostgreSQL database. The owner runs the emitted
`services/database/provision.sql` once on a cluster with none of the runtime
roles. Use a dedicated cluster for each checked app because roles and their
memberships are cluster-wide.

Run the check as the login that will migrate the database. Fresh initdb runs
it at the start of `001_roles.sql`. Mecha's migration runner runs the same
check in `reconcile.roles` before opening its ledger or reconciling token
roles. On a difference, PostgreSQL reports repair statements in `DETAIL`.
A database administrator reviews and applies the statements, then the migration
login reruns the check. If a runtime role owns the database, the suggested
repair transfers ownership to the migration login. If a runtime role owns
`public`, the repair restores `pg_database_owner` as the schema owner.
Migrations continue to manage tables, policies, table grants and default privileges.

| What the check reads | What must hold |
|---|---|
| Role attributes and ownership | Each runtime role has the model's login, inheritance, superuser, role creation, database creation, RLS bypass and replication attributes. Database and application schema ownership stay separate from runtime roles. |
| Memberships | Each declared membership permits `SET`, has the expected inheritance and lacks `ADMIN`. Runtime roles have only their declared memberships. Grants of `authenticator`, RLS-bypassing roles and replication roles are restricted to declared members. PostgreSQL's admin-only grants to a delegated database owner can remain when issued by a superuser. |
| Role settings | Timeout values match the model's spelling and have no override for this database. |
| Schema privileges | Roles hold the declared privileges on `public`. Neither runtime roles nor `PUBLIC` have a grant of `CREATE` there. |
| Migration login | A separate login can bypass RLS, has `CREATE` on the database and has `USAGE` and `CREATE` on `public`, the first schema in its effective search path. |

**Requirements.** Membership options require PostgreSQL 16 or later. The
migration login needs ownership of the app's tables for subsequent migrations.
Provisioning requires an administrator with permission to create roles with
`BYPASSRLS` and `REPLICATION`. The owner supplies credentials and installs
extensions that require elevated privileges. The check covers the catalog
state listed above. Passwords, other settings, database-level grants,
table and function ownership, object grants, and installed extensions require
separate validation.

**Release support.** Current release targets provision their own database.
On a fresh cluster their initdb reaches the check before the owner can apply
the provisioning script, and Mecha's password initialization still uses
`ALTER ROLE`. Checked mode currently supports generating and running the SQL
against a separately prepared database. On retained Kubernetes and GCP
databases, the schema job replays policies before the migration runner, so a
missing role can surface as a PostgreSQL policy error first.

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
