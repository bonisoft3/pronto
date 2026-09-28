---
type: concept
title: Access
description: How an entity's declared access becomes the scope column, the tenancy-floor call and the policies at the cluster and the same rule in the browser, who stamps a row's owner, and how a reader inside an aggregate they cannot see gets an exact count.
---

# Access

Who may see and change a row is declared once per cluster entity, as
`#Access` in [`schema.cue`](../schema.cue), and enforced as row-level
security, never as a filter a screen remembers to write. A `tab` or `device`
entity takes none ([the lattice](lattice.md#the-durability-ladder)).
Pronto compiles the declaration into what mecha's tenancy floor needs, a
`scope_id` per row and one call, and into the permissive policies that decide
who inside the floor may do what. The floor, its audit and its tests are
[mecha's](../../../libraries/mecha/services/database/rls/README.md); the
author's examples are [the guide's](../GUIDE.md#access).

## The four modes

The model is Google Drive's. `#policySql` and `#tableSql` in
[`emit.cue`](../emit.cue) write, per mode, into `006_policies.sql` and the
table:

| Mode | `scope_id` | Floor | What `app_user` may do |
|---|---|---|---|
| `private` (`owner`) | `'user:' \|\| owner`, generated | `rls_protect` | select, update and delete rows where `owner = auth_uid()`; insert only with that check |
| `private` with `shared` (`via`, `on`, `user`) | the same | exempt: the floor is restrictive, and a sharee holds no scope the owner's row carries | the above, or a row the `via` table grants them, through a `SECURITY DEFINER` helper so the two tables' policies do not recurse |
| `folder` (`parent`, `on`) | the parent's, copied by `mecha.scope_from_parent` | as its parent | everything on a row whose `private` parent they may see |
| `public` | `'public:'`, generated | `rls_protect` | select; no write arm |
| `internal` | none; `app_user`'s is its own id | exempt | nothing, except `app_user` reading its own row |

Every table grants `service` everything. An exempt table gets a row in
`mecha.rls_exempt` with its reason in words, the short list a reviewer reads.
A shared entity, its grant table and a child of a shared parent each declare a
`mecha.shape_key`, so the sync path can deliver a row the floor does not.
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

## The browser's mirror

`shell.yaml` carries each table's access, and the store's `visible()`
re-applies it on every local read: a `private` row is the reader's or granted
through the `via` rows they hold, a `folder` row is visible exactly when its
parent is, `internal` is never visible, and a row the session wrote and the
cluster has not confirmed is always visible. A change to a grant table or a
parent re-renders the regions that depend on it, so an unshare revokes the row
from an open screen.

So policies added in raw SQL may widen access only where the mirror already
allows, and may narrow it freely. `#Access` has no "everyone reads, the owner
writes" mode, because `public` names no owner and emits a SELECT arm alone:
realworld's `011_owner_writes.sql` hand-writes owner-gated arms for `article`
and `comment` and restates their owners, and xpense's `011_ledger_writes.sql`
opens `category` and `expense` to every signed-in writer
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
