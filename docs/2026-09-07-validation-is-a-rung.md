# Validation is a rung

Built on this branch; the sequence at the end is its commit order. The
ground: `plugins/omnishell/docs/2026-08-30-machines-not-widgets.md` (value positions hold a Jessie
reference; refusal is the machine's error event),
`2026-08-31-one-ladder-one-grammar.md` (a withdrawn write reaches the fold as
`refused`; one writer per fact), `plugins/omnishell/docs/2026-08-27-events-and-the-clock.md` (a
compartment with nothing endowed), and `apps/chess`'s `referee.js`, whose
header says the thing this doc generalizes: legality is data, and the rules
are a reduce.

The claim: **validation is a ladder the program already climbs four rungs of,
each declared in CUE beside the entity and each running at every tier, and
the fifth rung — a Jessie predicate over the row and its references, run
before the write is accepted — is declared the way a `cel` is, named the way
a unique is, and has two seats: the store, at every tier, before the
optimistic write; and Postgres, at the server tiers, before commit.** Both
seats run the same file. Neither seat is a fallback for the other, and no
tier has a third.

## Facts not to re-derive

Read out of this tree on 2026-09-07, or measured against the network the same
day.

- **Four rungs exist.** Column types (`emit.cue:41`). A field's `cel` becomes
  a column CHECK (`cel-emit.ts`, the value convention). An entity's
  `invariant` becomes a row CHECK (`schema.cue:176`, the row convention).
  Uniques, partial uniques and `ref` are set membership (`schema.cue:98-99`,
  `:194`). CEL got the two CHECK rungs because it is expression-only and
  compiles to SQL; Jessie has closures and higher-order functions, so it
  needs a runtime, not an emitter.
- **A unique carries a name because the name is the refusal.**
  `schema.cue:184-186`: "a violation IS the app's duplicate refusal and the
  constraint name is what reaches the screen."
- **`ref` is the declared relation.** `schema.cue:98`: a field's `ref` names
  the referenced table and emits `REFERENCES <ref>(id)`. realworld declares
  `favorite.article_id ref article` and `article.author_id ref app_user`
  (`program.cue:216`, `:141`).
- **The refusal contract is closed at 4xx.** `mecha-client.ts:176-188`: a 4xx
  is `NonRetriableError`, the executor rolls the optimistic row back, and
  anything else stays in the outbox and retries. `screen.js:1494-1523` turns
  that into `{type: "refused", entity, id?, kind, validation?}` for the
  mounted reduce or machine, `kind` being `"refused"` for the server's no and
  `"failed"` for transport. A form without a reduce gets `validation-error`.
- **PostgREST maps a plv8 exception to 500.** Its error table sends `XX*`
  (internal error, which is what a bare `throw` inside plv8 raises) to 500,
  `P0001` to 400, and every unlisted code — `23514` check_violation among
  them — to 400. A predicate that throws from JavaScript would therefore be
  retried by the outbox forever. The refusal must be raised by a PL/pgSQL
  wrapper with an explicit ERRCODE.
- **The same-file-two-engines pattern has a precedent and a retreat.**
  `jessie.js` ROLES has `fold`: a pipeline transform authored as an ES module
  "because the same file is inlined into the rpk stream at container tier".
  `schema.cue:286-289` records why the container kept bloblang: rpk can run
  the module in goja, "but nothing lints a JavaScript string inside a
  pipeline YAML" while `redpanda-connect lint` does catch a broken mapping,
  so sharing "bought less than the lost build-time check cost". The lint
  this doc relies on runs on the source file, before emission, for every
  seat.
- **`jessie.ts` is a scanner, not a parser.** One walk over the source blanks
  comments and string bodies, emitting either nothing (the denylist's copy) or
  a space per character (the split's copy, where an index is a source offset);
  one scan then finds the last segment at bracket depth 0. It tokenizes
  neither regex literals nor template substitutions, so a regex holding a
  quote or an unbalanced bracket mis-splits, and a `${...}` holding a quote is
  read as still inside the template.
- **The reduce is called `(state, event)`.** `screen.js` builds
  `state = {items: getRows(), rows: await worldOf()}` and machine-v2 fixes
  every value position — guard, assign, delay — to the same two arguments.
- **The store's write surface is five functions.** `data-crud.js:924-1047`:
  `write`, `add`, `patch`, `upsertBy`, `drop`, each taking `onRefused`, each
  calling the client after `ensurePrepared` — `drop` is the one exception,
  since a delete carries no schema to prepare. `upsertBy` already answers "does my
  row exist" from the local collection before choosing insert or update —
  the store consults its own copy before the wire.
- **Migrations are compose configs, and the image is plain Postgres.**
  `cluster.cue:80-83` mounts the emitted migrations by name into
  `/docker-entrypoint-initdb.d/`; `services/database/Dockerfile` is
  `postgres:18-trixie` plus `postgresql-18-wal2json` from PGDG apt. The
  emitted `000_extensions.sql` reads "no extensions required".
- **PGDG apt does not carry plv8.** The trixie and bookworm indexes for amd64
  and arm64 hold zero `postgresql-*-plv8` packages while holding wal2json.
  Pigsty packages `postgresql-18-plv8` 3.2.4 for Debian 12/13 and Ubuntu
  22–26; Neon, Cloud SQL, RDS and Aurora list plv8. PGlite's catalog has no
  JavaScript language and cannot have one: V8 does not compile into a wasm
  Postgres. PL/pgSQL is core and PGlite runs it; the browser tier's CDC
  already rides PL/pgSQL triggers.
- **plv8 is a trusted language.** A function's world is SQL through the
  `plv8` object, logging, and nothing else — no filesystem, network or
  timers. `jessie.ts` DENIED already refuses `Date`, `Math.random`, `fetch`,
  `globalThis`, `eval` and `Function`.
- **A trigger's SELECT sees what its role sees.** RLS applies inside a
  trigger body run as the invoker; a SECURITY DEFINER function owned by the
  migration role bypasses it (`reference_pg_set_role_security_definer`: the
  caller switches role, the definer does not).

## The rung

Validation is what refuses a write. The rungs in this tree, from cheapest to
most expressive, each running at every tier:

1. **Type.** Postgres's own; the store's schema-vet is the same fact.
2. **Field CEL.** `this` bound to the value.
3. **Row CEL.** `this` bound to the row.
4. **Set membership.** Unique, partial unique, reference. "Legality is data"
   is this rung: a fold writes the set ahead of time, a constraint checks it.
5. **Validation.** Jessie over the row and its references.

Rung 4 is uniform but ahead-of-time: the set must exist before the write, so
it costs a race and, for a set of thirty rows per ply, a write amplification.
Rung 5 checks at the write, with nothing precomputed, and pays for it with
two engines. Both stay. An app picks by whether the set is worth
materializing.

## The grammar

CEL's shape, kept: one statement of the rule, declared beside the entity,
bound to the row, its artifacts derived and never written beside it. A
unique's shape, kept: named, because the name is what reaches the screen.
`ref`'s shape, kept: the neighborhood a rule may see is the relations the
schema already declares.

```cue
#Entity: {
    validations: [Name=string]: #Validation & {name: Name}
}

#Validation: {
    name: string
    ir:   *name | string
    src:  #Jessie
    // Reference edges the predicate may follow from the row. A field of this
    // entity that carries `ref` walks forward to the one referenced row; an
    // "<Entity>.<field>" whose field refs this entity walks backward to every
    // row pointing here. No other neighborhood exists. Both directions join
    // on `id`: the DDL emits `REFERENCES <ref>(id)` (emit.cue:54), so the
    // entity on the referenced side must declare an `id` field, and derive
    // refuses one that does not. derive also refuses a validation whose
    // edges walk to the same table twice — state.rows holds one row set per
    // table.
    via:  *[] | [...string]
    note: string
}
```

```cue
Favorite: validations: "own-article": {
    src: "shell/validations/own-article.js"
    via: ["article_id"]
    note: "a reader cannot favorite what they wrote"
}
```

The module is the handler shape, completion a predicate with the reduce's
signature:

```js
(state, event) => state.rows.article.every((a) => a.author_id !== event.row.user_id);
```

- `event` is the write: `{type: "insert" | "update", row}`, `row` being the
  row as it will stand. The terminal synthesizes it the way it synthesizes
  `refused`; an app never names it.
- `state` is what stands, in the reduce's shape. `items` is the row as it is
  now: `[]` on insert, `[previous]` on update. `rows` holds one array per
  `via` edge, keyed by the target table, exactly as a reduce's declared
  reads are keyed. A forward edge is a list of one, or empty where the
  referenced row is not there — the store seat has not synced it, or it does
  not exist and the FK is about to say so — and a backward edge is every row
  pointing here, in no promised order. A predicate reads an edge as a list
  and may not assume it holds a row.
- The return is a boolean. A refusal names the validation, never a string
  the code made up: `refused.validation` is the name, and the server's
  message is `validation <table>.<name>`.
- No `now`, no draw, no reads beyond `via`. A predicate is pure; time enters
  this platform as a row.

Same signature as a reduce and as a machine's guard position, so the three
are one grammar: a reduce answers with updates, a guard with a value, a
validation with a verdict, and a module written for one position can be
called from another.

### Alternatives considered

Three shapes for the neighborhood were on the table.

1. **Edges over declared references** (chosen, above). Type-safe by
   construction, one WHERE clause per edge, lintable as "is a `ref`", and it
   re-states nothing: the relation is already in the schema. Its limit is
   its point — a rule may only see what the schema says is related.
2. **Key equality:** `reads: [{entity, key, from}]`, rows of `entity` whose
   `key` equals the row's `from`. More general, since it joins on any column
   pair, and for that reason it lets a rule invent a relation the schema
   does not declare. Every join a consumer has needed is a `ref`.
3. **Inline expression:** `validation: "row.ply === rows.move.length"`, a
   Jessie expression string in CUE beside `src:` for modules. It reads most
   like `cel:`, and it is CEL's job: a rule that fits one expression fits
   `invariant`. Two spellings of the small case buy nothing.

Two shapes for the verdict were on the table: a boolean under a declared
name, or `true | string` with the code naming the kind. The named boolean is
the unique's precedent, keeps the refusal vocabulary in CUE where the
bijection can see it, and makes several small validations on one entity
natural, each with one name.

## The two seats

**The store, every tier.** `write`, `add` and `patch` evaluate every
validation of the table before calling the client — `upsertBy` reaches them
through whichever of the two its lookup chose: `state.rows` from the
local collections along the declared edges, filtered by the reader's
visibility, `state.items` from the collection's current row, `event` from
the write. An edge comes back `[]` not only where the reference dangles but
where the referenced row has not yet synced to this reader's collection, or
where `visible` excludes it: the predicate judges what the reader can see,
not what exists, and the write goes out for the server to judge in turn. The
owner column of an owned entity is filled from the session when the form
omits it, the rule `upsertBy` already applies, because the server defaults
it and a predicate over an absent owner would judge nothing. Every other
server default stays absent at this seat: the store judges what the reader
can see, and a rule over a defaulted column is judged at the server. A
refusal throws before anything enters the outbox — no optimistic row, no
rollback — and rides the existing `onRefused` path as a non-retriable error
carrying `validation`; the terminal stamps `refused.validation` on the
mounted reduce's event only when `kind` is `"refused"`, since a program
error that merely names a validation in its message is not a validation
that said no. This is the only seat a `tab` or `device` entity has, and it
is the whole seat: their store is their truth.

**Seeds and deletes.** A browser seed bypasses the store seat, as it bypasses
every store write: the program stating the initial world is not a reader's
gesture. A server seed does not get the same exemption — `900_seed.sql` runs
after `008_validations.sql`, so the trigger is already on and judges it — and
a seed the predicates refuse fails the cluster's boot, which is where a
program contradicting its own rules should fail. A delete is judged at
neither seat: the trigger is INSERT OR UPDATE, and `drop` calls the client
without consulting a predicate.

**Postgres, the server tiers.** For every `server`, `live` or `offline`
entity with validations, the emitter writes:

- `CREATE EXTENSION plv8` into `000_extensions.sql`.
- A `DO` block at the head of `008_validations.sql` that refuses to install
  unless `current_user` is a superuser or holds BYPASSRLS. Under FORCE ROW
  LEVEL SECURITY a SECURITY DEFINER read is still scoped by the caller's
  `app.scopes` unless the definer itself bypasses RLS, so a migration role
  that does neither would give every predicate a silently narrowed world.
  The precondition is checked where it is required rather than documented.
- One plv8 function per validation, `<table>_validation_<name>(state jsonb,
  event jsonb) RETURNS text` (the name's `-` becomes `_`), `IMMUTABLE`,
  whose body is the module's statements followed by the completion applied to
  its arguments, answering `"true"`, `"false"`, or `"answered <typeof>"`. It
  reads no SQL: `plv8` joins DENIED, and the wrapper hands it its world. Each
  is followed by `REVOKE EXECUTE ... FROM PUBLIC`, because PostgREST publishes
  every function `anon` may execute as an `/rpc/` endpoint; the definer
  trigger's owner still executes it.
- One PL/pgSQL trigger function per table, `<table>_validate()`,
  `SECURITY DEFINER`, that builds `state` with one query per edge and
  `items` from `OLD`, builds `event` from `TG_OP` and `NEW`, and calls each
  validation in declaration order. `"false"` raises with
  `ERRCODE = 'check_violation'` and `MESSAGE = 'validation <table>.<name>'`.
  Anything else — a non-boolean, or no answer at all — raises with
  `ERRCODE = 'raise_exception'` and `MESSAGE = 'predicate <table>.<name>
  <what it answered>'`: the app's program error, not a rule saying no, and a
  400 either way so the outbox rolls the write back instead of retrying
  forever a write no retry can fix. Both ERRCODEs are pinned by the mecha
  integrate case.
- `AFTER INSERT OR UPDATE ... FOR EACH ROW` on the table. AFTER, so the
  predicate runs only for a write the caller's own policies already admitted:
  a caller who cannot write the row cannot use the definer's read as an
  oracle over rows RLS hides from them. It also means `event.row` is the row
  as it will stand — stored generated columns such as `scope_id` computed,
  `txid` already restamped — rather than the half-built row a `BEFORE`
  trigger sees.

The trigger fires for every writer — forms, pipelines, seeds — so a
validation is the table's, not the form's. SECURITY DEFINER is deliberate:
the server seat judges against the truth and the store seat against what the
reader can see.

**The write-time contract.** The server seat judges a READ COMMITTED snapshot
at the moment of the write. It takes no lock on the rows an edge reads, and
there are no reverse triggers on the referenced tables: a referenced row that
changes concurrently, or later, is never re-judged, so a validation states
what was true when the write landed and not an invariant the table goes on
holding. A rule that must survive a later change of its neighborhood belongs
at rung 4, where the set is materialized and a constraint keeps it.

The seats differ in three ways an author can feel. The compartment evaluates a
module once and calls its closure per row; the plv8 function re-runs the
module's statements on every call, so a module with setup cost pays it per row
at the server. Their sandboxes are not the same thing: the compartment endows
nothing, while at the plv8 seat the denylist is a determinism and portability
rule — `constructor` walks still reach the global object there — and the
boundary is Postgres's own, no filesystem, network or timers, plus whatever
SQL the definer can reach. And they judge different worlds: the store judges
the reader's visible, possibly unsynced copy, so an edge set can be empty, or
hold rows the server has not confirmed, where the server's would differ. Which
way that cuts is the predicate's to say — `every` over an empty set passes
where `some` refuses — so a disagreement is not one-directional and only the
predicate's polarity decides which seat is the stricter one.

A backward edge materializes every row pointing at the written row, at both
seats, on every write. The cost is the edge's fan-in, not the predicate's: an
entity a thousand rows point at reads a thousand rows to judge one write. A
batch pays it once rather than once per row — the store seat buckets each
edge table by its join column and shares that index across the batch, and the
server seat's per-edge query is one index scan per row.

**The browser tier of a server entity** runs the store seat only. PGlite has
no plv8 and will not; the browser tier substitutes the compartment for the
trigger the way it substitutes PGlite for Postgres. The client that would
have hit the trigger is the one that already ran the predicate.

### Why not the stream

Jessie in goja inside the rpk transform would be a third engine for the same
file, and the fold precedent already retired it once. With Postgres hosting
Jessie, the synchronous seat has one engine per tier and needs none in the
stream. The stream keeps what only it can do — asynchrony, effects through
declared endpoints, and writes to other stores — and none of that is
validation. One engine per seat: the compartment for the store, plv8 for the
table, bloblang for the stream.

## Refusals at compile time

`derive.ts` refuses, at `cue vet` time:

- A validation whose source references a DENIED name, `plv8` among them,
  or whose completion is not an arrow.
- A `via` entry that is not a `ref` field of this entity, nor
  `<Entity>.<field>` where that field refs this entity.
- A server-truth entity whose validation walks to a `tab` or `device`
  entity: the server seat could not build that world. A tab or device
  entity may walk to a server-truth entity: the store holds both.
- A validation name that is also a unique name on the same entity: the two
  share the refusal vocabulary.
- A validation whose function name would exceed Postgres's 63-byte identifier
  limit. Postgres truncates rather than refusing, which would quietly collapse
  two predicates onto one function.

`#Jessie` itself is a relative path of lowercase segments ending in `.js`: no
scheme, no `..`. Both seats resolve it against the app directory, and the
server seat embeds what it reads into a migration.

`jessie.ts`'s offset-preserving strip makes the completion's start a source
offset, and `derive.ts` writes each validation's resolved edges and
its `{statements, completion}` into a generated `program_validations.cue`,
the way `program_cel.cue` carries the CHECK bodies, for `emit.cue` to embed
under a dollar-quote tag the source is checked not to contain. A validation
is a reviewed thing: it is an ir kind, `validation`, and the bijection pairs
each declaration with its ir element as it does a handler's.

## The image

One route, and it is pinned: the database Dockerfile fetches Pigsty's
`postgresql-18-plv8` `.deb` for the image's Debian release by its exact URL
(`ADD`, keyed on `TARGETARCH`), checks it against a per-architecture sha256
sum, and installs it with `dpkg -i`. No repository is added, no key is
trusted at build time, and a changed artifact fails the checksum rather than
installing something else. Cloud tier: Neon and Cloud SQL ship plv8, and the
emitted `CREATE EXTENSION` is the whole change. Memory is one V8 isolate per
backend on first use, bounded by the PostgREST pool rather than
`max_connections`.

There is no second route. An image that cannot fetch the artifact does not
build, and a cluster whose database lacks plv8 fails at `000_extensions.sql`
rather than at the first write.

## The consumer

One server-tier rule CEL cannot state and a unique cannot encode, live in
`apps/realworld`: a reader may not favorite their own article. `Favorite`
gets the `own-article` validation above, walking `article_id`. It exercises
both seats — the store refuses instantly and offline, and the trigger refuses
a forged POST that skips the store — and it is small enough that the test is
the specification.

The chess referee is the rung's reason and its next consumer, after the
multiplayer redesign moves `Move` to a server tier. It is not in this scope.

## Testing

- **Scanner.** `jessie.ts` self-test cases for the offset-preserving split:
  comments, a block comment holding a semicolon and a brace, strings with
  braces and semicolons, a string with an escaped quote, a trailing arrow with
  and without a semicolon, a trailing comment after the semicolon.
- **Lint.** `validations.ts` self-test cases for each compile-time refusal
  above, run from `derive.ts --self-test`.
- **Emission.** The realworld generate is checked in; the diff of
  `008_validations.sql`, `000_extensions.sql` and `shell.yaml` is the review.
- **Store seat.** `plugins/omnishell/interpreter/validation-smoke.js`, over
  the real store with two `tab` tables. A validated insert is refused before
  the client is called, the error is non-retriable and names the validation,
  and the collection is unchanged; an accepted insert lands; a refused patch
  leaves the row standing. The owner column is filled from the session when
  the form omits it, and an update is judged by the owner the standing row
  already has, never by what the write states. A predicate answering a
  non-boolean is a thrown program error, not a refusal, as is an update of a
  row the store does not hold. A module whose fetch failed is not held against
  the table: the next write loads it and is judged. A batch is judged whole —
  one refusal keeps every row of it off the wire, and a batch that all passes
  lands whole.
- **The refused event.** `plugins/omnishell/interpreter/machine-smoke.js`: a
  refused write reaches a mounted machine's transition carrying
  `event.validation`, both when the error carries the name as a property and
  when the only place it appears is the mecha client's own message; a program
  error that merely names a validation in its message stays `kind: "failed"`
  with no `validation` field, pinning the gate `refused.validation` depends
  on.
- **Postgres seat.** `libraries/mecha/tests/validation-smoke.sql` and
  `tests/entrypoint.sh`: a mecha integrate case where the database image
  with plv8 boots a fixture migration in the emitted shape. A violating
  insert through PostgREST returns 400 with the validation's message, judged
  on a row the caller cannot read; an accepted insert returns 201; a
  predicate answering a non-boolean returns 400 naming the predicate and what
  it answered; an update onto a target the caller owns returns 400 while an
  update onto one they do not returns 204, so the AFTER trigger is pinned to
  judge `NEW`; and a bare plv8 `throw` returns 500, so the wrapper's ERRCODEs
  are pinned by a test rather than a comment.
- **Consumer.** `apps/realworld/shell/validations/own-article.js` vets,
  derives, lints, and lands in the generated tree. Its end-to-end refusal is
  the store smoke's code path over its own module and the integrate case's
  SQL shape; a realworld API battery does not exist yet and is not built
  here.

## Non-goals

- A delete validation, `now` in the call, or any endowment. Gated on a
  consumer.
- A neighborhood beyond declared references.
- Running the predicate inside PGlite, or Jessie compiled to PL/pgSQL.
- Jessie in the stream.
- Replacing `invariant`: CEL keeps the expression rungs; a validation is for
  what needs a program.
- Unifying with a machine's transition guards. Same signature family, a
  different position; a machine may call the same module.
- The multiplayer chess redesign, and the ticker's schema and cluster steps.

## Sequence

1. Grammar, lint, and the scanner split. *Done when* `cue vet` refuses each
   case above and accepts the realworld validation.
2. The store seat. *Done when* the store smoke passes.
3. Emission and the image. *Done when* the mecha integrate case passes
   against the built image.
4. The consumer landed in realworld's generated tree.

## Rules worth carrying

- **Validation is a ladder, and a rung is added as grammar.** Authors learn
  one more sentence; which engine runs it is the tier's business.
- **The store seat is a courtesy; the trigger is the authority.** Their
  disagreement is the ordinary refusal, never a merge.
- **A refusal is a 4xx or it is a retry.** Every seat that says no must say
  it in the code the outbox understands.
- **One engine per seat, and no seat is a fallback for another.** An install
  that cannot be pinned does not happen; a tier that lacks an engine lacks
  the seat, and says so at boot.
- **Share a file across engines only when the lint runs on the file.** The
  fold retreated for want of it; the validation has it.
