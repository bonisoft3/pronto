---
type: decision
title: Owner stamping
description: Moves a row's owner stamp from the apps' `default: "auth_uid()"` column defaults to an emitted per-table BEFORE INSERT trigger beside the policies, and narrows `#Field.default` to what a bare Postgres has, so the data-holding steps need nothing from the rules.
status: unbuilt
---

# Owner stamping

What pronto emits divides in two: the steps that hold data, and the policies,
functions, triggers and publication restated rather than migrated
([schema changes](../schema-change-admission.md#who-cannot-be-migrated)). A
column default is evaluated where the table is created, so `default:
"auth_uid()"` puts a rules-side function into a data-holding step
([access](../access.md#who-the-owner-is)). This record moves the stamp beside
the policies, and none of it is built.

## Where the coupling comes from

The platform keeps `auth_uid()` on the replaceable side: mecha's database image
restates it with the tenancy floor, and every policy calling it is emitted as a
rule. The bridge into data-holding DDL is authored, because `#Field.default`
takes any SQL expression, and seven fields use it to stamp an owner:

| app | field | access |
|---|---|---|
| thenote | `Note.owner_id` | `private`, `owner: "owner_id"` |
| thenote | `Label.owner_id` | `private`, `owner: "owner_id"` |
| realworld | `Favorite.user_id` | `private`, `owner: "user_id"` |
| realworld | `Bookmark.user_id` | `private`, `owner: "user_id"` |
| realworld | `Follow.follower_id` | `private`, `owner: "follower_id"` |
| realworld | `Article.author_id` | `public` |
| realworld | `Comment.author_id` | `public` |

Five are the column their entity's access already names as owner, so the apps
hand-write what the platform has the information to emit. The other two have
nowhere to say it: `public` names no owner, so realworld states the owner
twice, as the default and in `011_owner_writes.sql`. An `owner` on `public`
would give the stamp a column to read for all seven.

The cost: the data-holding steps must follow `auth_uid()` for a database to
replay them, so the floor's `003_rls.sql` must precede `005_create_tables.sql`,
and nothing states that where a check could read it.

## The stamp beside the policies

An entity whose access names an owner gets an emitted per-table stamp,
restated like every other rules object:

```sql
CREATE OR REPLACE FUNCTION note_owner_stamp() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.owner_id := coalesce(NEW.owner_id, auth_uid());
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS note_owner_stamp ON note;
CREATE TRIGGER note_owner_stamp BEFORE INSERT ON note
  FOR EACH ROW EXECUTE FUNCTION note_owner_stamp();
```

`BEFORE INSERT` runs before `NOT NULL` and foreign-key checks, so `required`
and `ref` behave unchanged. The apps delete their defaults, and a client still
omits the owner on insert. Against the column default:

| case | `DEFAULT auth_uid()` | the stamp |
|---|---|---|
| insert omitting the column | stamped | stamped |
| insert with an explicit `NULL` | `NULL`, which the insert policy refuses | stamped; `WITH CHECK (owner = auth_uid())` still gates a spoofed owner |
| insert with a spoofed owner | the policy refuses | `coalesce` keeps it, and the policy refuses |
| `\d` on the table | shows the default | shows none; the stamp is a trigger |
| `ADD COLUMN` over existing rows | stamps one uid onto every row | stamps nothing |

## `#Field.default` narrows to built-ins

A default keeps what a bare Postgres has: literals, `now()`,
`gen_random_uuid()`. A check beside the others rejects a default naming an
identifier outside a built-in allowlist, so a user-defined function cannot
re-enter the data-holding steps, and its message points at `access.owner` for
the one pattern authors reach for.

With both, the data-holding half needs nothing from the rules half: a
throwaway database can be built from a subset of the steps and compared with
what they were meant to produce.

## Not built

No emitter writes the stamp from `access.owner`, the allowlist check does not
exist, `#Field.default` takes any SQL expression, and the seven defaults are
live.

## Rejected

- **A differ that models `auth_uid()`** — a tool's feature set, to buy what
  deleting seven lines buys with nothing.
- **One generic stamp through `TG_ARGV`** — plpgsql cannot assign
  `NEW.<column>` by name without rewriting the row through hstore or jsonb;
  per-table three-liners are cheaper.
