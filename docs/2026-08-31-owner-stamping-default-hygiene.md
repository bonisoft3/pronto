# Owner stamping and default hygiene

What pronto emits divides in two: the steps that hold data — tables, columns,
indexes, constraints — and the ones restated rather than migrated (policies,
RLS, triggers, functions, grants, the publication). The division is in the
numbering, low steps and high ones, not in two files.

`#Field.default` is the one place an app can put a function call into a
data-holding step, and a `DEFAULT` is evaluated where the table is created — so
the function has to exist by then. This is a design against that, unbuilt. What
the numbering means to the database is
[`../../../libraries/mecha/docs/2026-09-24-a-schema-that-moves.md`](../../../libraries/mecha/docs/2026-09-24-a-schema-that-moves.md).

## Where the coupling actually comes from

The platform keeps `auth_uid()` strictly on the replaceable side — the
`CREATE OR REPLACE FUNCTION` and every policy that calls it are emitted into
rules (emit.cue). The bridge into data-holding DDL is app-authored:
`#Field.default` is a free-form SQL expression, and apps use it to stamp
owner columns:

```
thenote    Note.owner_id       access: owned, owner: "owner_id"
thenote    Label.owner_id      access: owned, owner: "owner_id"
realworld  Favorite.user_id    access: owned, owner: "user_id"
realworld  Bookmark.user_id    access: owned, owner: "user_id"
realworld  Follow.follower_id  access: owned, owner: "follower_id"
realworld  Article.author_id   access: public-read
realworld  Comment.author_id   access: public-read
```

Seven lines, one pattern: "when the client omits the owner, use the caller."
Five of these columns are the identity column their entity's `access` block
already names, and there the apps are hand-writing a behavior the platform has
enough information to provide.

The other two are the same pattern with nowhere to say it. An article is read by
everyone and written by its author, and `public-read` names no owner — so
realworld states the owner twice by hand, once as the `DEFAULT` and once as
`011_owner_writes`, a raw migration that replaces the emitted write policies.
The missing thing is an `owner:` on `public-read`. With it both hand-written
halves go, and the stamp below has a column to read for all seven.

## What the coupling costs

- The structural steps are not purely structural: they must be preceded by
  `auth_uid()` (a rules-side object) for a bare database to replay them. The
  ownership split leaks downward into the numbering.
- The structural steps stop being reorderable among themselves: `auth_uid()`
  must be numbered below every table defaulting to it (`000_extensions.sql`
  below `004_create_tables.sql`), and nothing states that constraint where a
  check could read it.

## Design

Two changes, both platform-side.

### 1. Owner stamping moves to the access layer

An entity with `access: {mode: "owned", owner: "owner_id"}` gets a
platform-emitted stamp in rules, next to the policies it pairs with:

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

Per-table functions (plpgsql cannot assign `NEW.<dynamic>` without hstore
contortions), emitted, idempotent, replaceable — the same contract as every
other rules object. BEFORE INSERT runs before NOT NULL and FK checks, so
`required: true` and `ref: "app_user"` behave unchanged. Apps delete their
`default: "auth_uid()"` lines; clients keep the ergonomics (omit the owner on
insert).

Semantic deltas versus the column DEFAULT, all acceptable:

| case | DEFAULT auth_uid() | stamp trigger |
|---|---|---|
| insert omitting the column | stamped | stamped |
| insert with explicit NULL | NULL → insert policy rejects | stamped — more forgiving, same authority (`WITH CHECK owner = auth_uid()` still gates spoofing) |
| insert with a spoofed owner | policy rejects | policy rejects (trigger coalesce keeps the value; the policy rejects it) |
| `\d` shows the default | yes | no — the stamp is visible as a trigger instead |
| ALTER TABLE ADD COLUMN backfill | would stamp one uid onto existing rows (never wanted) | no backfill (correct) |

### 2. `#Field.default` narrows to built-ins

The escape hatch stays for what it is actually used for — literals and
built-ins that exist on a bare Postgres (`now()`, `gen_random_uuid()`,
constants). A check (house style: sibling of check-bijection/check-handlers)
rejects any default whose identifiers are not in the built-in allowlist, so a
user-defined function can never re-enter the data-holding DDL. The error
message points at `access.owner` for the one pattern people will reach for.

## What this buys

The structural steps become replayable on an empty database with zero user
objects, in any order among themselves: the data-holding half needs nothing from
the replaceable half, so a throwaway database can be built from a subset of the
files and compared against what they were meant to produce.

## Not built

`owner_stamp` is in no emitter, the allowlist check is unwritten, and the seven
lines are live. Building it is: emit the trigger from `access.owner`, add the
check, delete the lines, regenerate.

## Rejected

- **A differ that models the function** — buys with a tool's feature set what
  seven deleted lines buy with nothing.
- **A dev image with the functions pre-baked** — moves the leak into an image
  nobody would remember exists.
- **One generic stamp function via TG_ARGV** — dynamic `NEW.<col>` assignment
  in plpgsql needs hstore/jsonb rewriting; per-table three-liners are cheaper
  than the cleverness.
