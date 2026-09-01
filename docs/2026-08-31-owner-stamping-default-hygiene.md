# Owner stamping and default hygiene: a purely structural schema.sql

The [Atlas migrations design](2026-08-09-atlas-migrations.md) split the schema
into data-holding objects (Atlas's half: tables, columns, indexes,
constraints) and replaceable objects (rules.sql: policies, RLS, triggers,
functions, grants, the publication). One clause spoils the split: schema.sql
must also carry "the functions a table DEFAULT references, because the dev
database must replay it." This doc removes that clause.

## Where the coupling actually comes from

The platform keeps `auth_uid()` strictly on the replaceable side — the
`CREATE OR REPLACE FUNCTION` and every policy that calls it are emitted into
rules (emit.cue). The bridge into data-holding DDL is app-authored:
`#Field.default` is a free-form SQL expression, and apps use it to stamp
owner columns:

```
apps/thenote/program.cue:113    {name: "owner_id",  ... default: "auth_uid()"}
apps/thenote/program.cue:145    {name: "owner_id",  ... default: "auth_uid()"}
apps/realworld/program.cue:140  {name: "author_id", ... default: "auth_uid()"}
apps/realworld/program.cue:197  {name: "author_id", ... default: "auth_uid()"}
apps/realworld/program.cue:214  {name: "user_id",   ... default: "auth_uid()"}
apps/realworld/program.cue:237  {name: "user_id",   ... default: "auth_uid()"}
```

Six lines, one pattern: "when the client omits the owner, use the caller."
Every one of these columns is the identity column its entity's `access` block
already names. The apps are hand-writing a behavior the platform has enough
information to provide.

## What the coupling costs

- schema.sql is not purely structural: it must smuggle `auth_uid()` (a
  rules-side object) so that a bare database can replay it. The ownership
  split leaks.
- Community Atlas cannot fully author the data-holding half: the function is
  invisible to it, so a generated baseline keeps `DEFAULT auth_uid()` while
  dropping its function, and `migrate validate` fails on replay. This is the
  measured failure in the Atlas doc — and the only part of it that community
  Atlas cannot fix, since tables are otherwise covered 10/10.
- Any future desired-state format (CUE → JSON → HCL printer, or upstream
  `.hcl.json` ingestion) inherits the same wall: community Atlas HCL has no
  function blocks, so a function-referencing DEFAULT cannot survive the
  dev-database replay. Pro login would model the function — an account
  dependency in an otherwise hermetic toolchain, adopted to work around six
  lines of app code.

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

schema.sql becomes replayable on an empty database with zero user objects.
Consequences, in order of importance:

- The Atlas doc's ownership split becomes exact: Atlas's half needs nothing
  from rules' half, ever. The "plus the functions a table DEFAULT references"
  clause and the functions-before-migrations step of the apply order are
  deleted.
- Community Atlas — no login, no Pro — authors and validates the data-holding
  half completely. The account dependency question disappears rather than
  being answered.
- The CUE → JSON → HCL-printer path (desired state in Atlas's model, emitted
  structurally from program.cue via a small domain printer — no general
  JSON→HCL tool exists because HCL's JSON syntax is schema-ambiguous) is
  unblocked with the free tier. Upstream `.hcl.json` ingestion becomes a
  nicety, not a dependency.

## Migration

1. Emit the stamp trigger from `access.owner` (and audit that every current
   `default: "auth_uid()"` column is in fact its entity's access-designated
   identity column — expected for all six).
2. Add the default-allowlist check to the battery.
3. Delete the six app lines; regenerate; run each app's ladder.
4. Amend the Atlas doc: drop the functions clause from schema.sql's
   definition and step 1 of the apply order.

## Rejected

- **Atlas Pro login** — models the function, but buys with an account what
  six deleted lines buy with nothing.
- **Custom dev-url image with functions pre-baked** — moves the leak into an
  image nobody would remember exists.
- **One generic stamp function via TG_ARGV** — dynamic `NEW.<col>` assignment
  in plpgsql needs hstore/jsonb rewriting; per-table three-liners are cheaper
  than the cleverness.
