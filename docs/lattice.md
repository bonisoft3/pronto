---
type: concept
title: The lattice
description: The durability ladder and the dimensions declared beside it — visibility, effect level, validation, fuel — how one writer per fact keeps the ladder free of merges, and which combinations the code refuses today.
---

# The lattice

A program states each cross-cutting concern once, as a value on the thing it
governs: an entity's durability, access and validations, a chart effect's
level, a test's fuel. Nothing coordinates them as steps in order. CUE
unification meets the declarations, so the order they are written in cannot
matter, and where a rule joins two of them a contradiction produces no
program. That holds only for the joins the code states:
[the table below](#which-joins-the-code-enforces) lists them.

## The durability ladder

An entity takes one durability, the cheapest that still holds: `tab`,
`device`, `server`, `live`, `offline`, monotonic in expense
([what each promises](../prelude.md#durability)). `#Entity` in
[`schema.cue`](../schema.cue) reads it as two questions, where the truth lives
and what the client keeps of it; an enum names the five points that exist,
where two fields would also name a sixth that cannot.

The emitter derives everything from the word. `tab` and `device` emit no
table, trigger, publication entry, policy or seed SQL, take no `access`, and
reach the terminal as `local` collections
([omnishell's side](../../omnishell/docs/data.md#declaration-follows-durability)).
The cluster rungs each get a table with `txid`, the policies its access
declares, an Electric shape and the outbox. `server` alone is a
change-capture source: `008_publication.sql` carries `server` tables and no
other, which keeps a pipeline's sink from feeding the pipelines. Nothing else
in the emission tells the three cluster rungs apart, so `live` and `offline`
cost at the client what `server` costs, and the ladder is not yet monotonic in
expense there ([pending](../PENDING.md#the-lattice)).

## Views, folds and the DOM

Downward, every rung is a maintained view of the one above: Postgres, an
Electric shape, a collection, a region, the DOM, with the keyed reconciler as
the last view-maintenance engine. Upward, every rung is a fold of the events
of the one below, and the reduce is that fold. Whether A is a view of B is
answered per arrow, never per pair.

The DOM's private tables are focus, selection, scroll and unsent text. A
reduce cannot query them, since its compartment has no `document`; what
reaches it is the event, a whitelisted, serializable lift of DOM facts with a
closed schema. A native fact keeps its DOM name (`animationName`, `key`); a
fact the terminal synthesizes takes a name no DOM event has (`id`, `from`,
`seed`).

## Conflict resolution

View maintenance is mechanical and convergent. Conflict resolution is needed
only between symmetric writers, and the ladder never produces one: every fact
lives at one rung, and lower rungs hold derived copies beside their own
private facts. Where a writer threatens symmetry, each arrow carries a veto
instead of a merge: upward, the server's no arriving as a `refused` event
([omnishell](../../omnishell/docs/data.md#a-refused-write-is-an-event));
downward, an input holding unsent text refusing the store's re-bind until
submit or reset. Offline stays asymmetric by identity, idempotent replay and
the veto. The one exception admitted is collaborative free-form text, a column
whose value merges itself, and no type provides one.

## Grammars and writes

Authors write two languages. The data plane speaks PostgREST's fragment
grammar, executed by Postgres, the snapshot predicates, the incremental view
builder and PGlite; it has one reader, omnishell's `fragment.js`, which every
checker imports. The presentation plane speaks CSS. A named read
(`data-read-<name>="table?fragment"`) is the same grammar.

A write is a keyed row change, `{key, insert | update | delete, value |
patch}`, authored as a form, a reduce's `updates` or a machine effect, and
applied as SQL through PostgREST, the store's verbs, or the reconciler
patching keyed nodes. Keyed and commutative per key is what lets the outbox
replay and a `put` be stated twice.

- **Read any relation; write only base facts.** Views are never written, and a
  write goes to an address read or minted. The declared writer is `writers:`,
  which nothing reads yet ([pending](../PENDING.md#the-lattice)).
- **An address is not a capability.** Every write passes the store, which
  refuses a table it does not hold and runs the entity's validations, and at
  the cluster rungs the policies ([access](access.md)).
- **Structure is instantiated, never written.** An insert clones a template,
  a delete plays its exit. A per-kind template's `data-when` is checked
  against the closed value set the column's `cel:` derives. A region reads no
  row (a form), at most one (a slot) or many (a list), and a slot matching two
  rows is a program error, never a silent `rows[0]`.
- **Events are derived, never published.** The derived set
  (`data-on-mutation`, `refused`, the DOM lifts) is closed and recordable, and
  who hears what is the reads in the markup. A toast is a row; a count is a
  view another region reads. Event-time windowing stays server-side, because
  the clock is an effect and effects are the terminal's.

## Which joins the code enforces

| Join | Where | Enforced |
|---|---|---|
| durability × access | `#Entity`: `access` on `tab` or `device` is `_\|_`; a cluster rung takes `#Access` | yes, `cue vet` |
| durability × seed, partial unique | `#Entity`: `device` refuses `seed`; a unique's `where` only below the cluster | yes, `cue vet` |
| durability × validation edge | `validations.ts`: a cluster entity's edge to a `tab` or `device` one | yes, when `derive.ts` runs |
| durability × schedule | `_scheduleShape`: `emits` is `server`, `done` is another, `live` entity | yes, `cue vet` |
| target × program | `_pagesBundle` ([release targets](release-targets.md)) | yes, `cue vet` |
| effect level × `refused` arrow | `machineLint`, for an effect stating level 2; one naming no level escapes | partly, at lint ([machines](../../omnishell/docs/machines.md#effects)) |
| durability × effect level | `#DurabilityEffectLevel`, in `schema.cue` and omnishell's `machine.cue` | no ([pending](../PENDING.md#the-lattice)) |
| posing × effect | omnishell's posing (`test/storybook-battery.ts`, run over every app by `test/universal-storybook.test.ts`) mounts each chart state with handlers off over a store that refuses every write ([machine harnesses](../../omnishell/docs/machines.md#machine-harnesses)) | yes, in omnishell's own tests |
| effect level × fuel | `FuelMeter.spendEffect` ([fuel](../../omnishell/docs/automated-tests-battery.md#fuel)) | where a harness calls it |
| effect level × test layer | nothing picks where an arrow is proven from its level | no |

The levels are [omnishell's table](../../omnishell/REFERENCE.md#effects); the
access modes are [access](access.md).

## The validation ladder

What refuses a write is a ladder: **type**; **field CEL**, a column `CHECK`;
**row CEL**, the entity's `invariant`; **set membership**, a unique or a
reference over a set a fold wrote ahead of time; and **validation**, a Jessie
predicate over the row and the rows its declared references reach
([the author's contract](../GUIDE.md#validations)). Postgres holds the first
four at the cluster rungs. Below it, `writeLint` checks only the spelling of
what a machine region writes, at compile time, and a reduce's or a form's
write reaches the store unjudged; the store reconciles uniques when a
collection loads; and a `cel:` is enforced nowhere
([pending](../PENDING.md#the-lattice)). The fifth runs at every rung.

CEL has the `CHECK` rungs because it is expression-only and compiles to SQL;
Jessie has closures and needs a runtime. Set membership is ahead of time, so
it costs a race and write amplification; a validation checks at the write
with nothing precomputed and pays with two engines. An app picks by whether
the set is worth materializing. A validation is declared like a `cel:`, beside
its entity, and named like a unique, because the name is the refusal that
reaches the screen; its neighbourhood is the references the schema declares
(`via`). Its signature is the reduce's, `(state, event)`, so a reduce, a guard
and a validation are one grammar in three positions.

**The store is a courtesy; the trigger is the authority.** Both run the same
file: the store over the reader's visible, possibly unsynced copy before the
optimistic write, Postgres over the truth through a `SECURITY DEFINER` read in
plv8 before commit. A disagreement is an ordinary refusal, and which seat is
stricter is the predicate's polarity: `every` over an empty edge passes where
`some` refuses.

- **A refusal is a 4xx, or it is retried forever.** PostgREST maps a bare plv8
  exception to 500, so the predicate answers `"true"`, `"false"` or
  `"answered <typeof>"` as text, and a PL/pgSQL wrapper raises
  `check_violation` for a no and `raise_exception` for a program error, both
  400.
- **AFTER, not BEFORE.** The trigger runs only for a write the caller's own
  policies admitted, so the definer's read is no oracle over rows RLS hides,
  and `event.row` has its generated columns and restamped `txid`. The
  migration refuses a definer that does not bypass RLS, which would judge one
  caller's slice.
- **It states what was true when the write landed.** It judges a READ
  COMMITTED snapshot, locks nothing an edge reads, and never re-judges when a
  referenced row changes; a rule that must survive that is a set constraint.
- **A backward edge costs its fan-in** on every write; a batch pays it once.
- **One engine per seat.** The database image pins plv8 by URL and sha256, so
  a cluster lacking it fails at `000_extensions.sql`. PGlite cannot host V8,
  so the browser tier runs the store seat alone and `pages` refuses a
  validation.

## Rejected

- **Coordinating concerns procedurally** — middleware, decorators,
  multi-pass generation. The order inverts or halts under offline replay, each
  layer re-declares the concern, and no check sees them together.
- **Peer merge between writers** — machinery for symmetric writers, which the
  ladder never produces.
- **JSON Patch as the write algebra** — path-addressed and order-dependent,
  and it creates anonymous structure with no row identity, the forgery the
  renderer refuses.
- **An authored event bus, signals and slots, or `data-send`** — a late
  subscriber misses the event, N folds disagree, and the bus is an event
  source the terminal does not own, a hole in the recording.
- **A validation's neighbourhood by key equality** — it lets a rule invent a
  relation the schema does not declare, and every join a consumer has needed
  is a `ref`.
- **A validation as an inline expression, or a `true | string` verdict** — the
  first is `invariant`'s job; the second takes the refusal vocabulary out of
  CUE, where the bijection sees it.
- **A BEFORE trigger** — the definer's read would answer for rows the caller's
  policies refuse.
- **Jessie in the stream** — a third engine for one file, and nothing lints
  JavaScript inside a pipeline's YAML.
- **Endowing a validation** with a clock, a draw, a delete hook or reads
  beyond `via` — each waits on a consumer that needs it.
