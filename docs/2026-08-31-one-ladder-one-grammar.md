# One ladder, one grammar

Written from the design conversation that followed `2026-08-30-machines-not-widgets.md`,
turning the reduce contract's "feels ad-hoc" complaint into the system's actual
shape. The ground: `2026-08-02-incremental-model.md` (the loop),
`2026-08-03-component-tier.md` (the tiers and the IVM operator set),
`2026-08-12-derived-counts-the-reader-is-inside.md` (why private folds of a
stream disagree), `2026-08-29-the-screen-typechecker.md` (R2's one-parse
argument), and `2026-08-30-the-smallest-interactive-thing.md` (the refusal
event this doc leans on).

The claim: **the DOM is the bottom rung of the durability ladder, not the view
layer's counterpart — and once that is said, the whole system is two authored
grammars, one write algebra, and events that are only ever derived.** The
"tension" between treating the DOM as a view of the collections or vice versa
dissolves into direction: downward every rung is a maintained view of the one
above; upward every rung is a fold of the one below's events. The same loop —
state → maintained view → surface; surface → events → fold → state — repeats
at every rung, and each rung holds private tables the rung above cannot see.

## Facts not to re-derive

Read out of this tree on 2026-08-31. Line numbers are current — the machine
work moved them.

- **Every rung has private state, invisible upward, already.** Electric never
  sees tab/device collections (`data-crud.js:330` — and the sync plane is
  unscoped, so the terminal re-applies visibility itself). The collections
  never see the DOM's private facts: `screen.js:398-405` is the dirty-hold —
  an input with unsent text refuses the store's re-bind until submit/reset.
- **The veto pair exists at both arrows.** Upward: a withdrawn write reaches
  the fold as `{type: "refused", entity, id?, kind}` (`screen.js:810`), with
  the no-reduce default at `:818` and the form's routing at `:667`;
  `NonRetriableError` is the executor's rollback contract
  (`mecha-client.ts:159`). Downward: the dirty-hold above. Neither is a merge.
- **One grammar already has three readers.** `parseFilterSpec`
  (`data-crud.js:79`) feeds the snapshot predicates (`:123`), the maintained
  view's clause builder (`:419` via `:402`), and — R2's complaint — the
  checkers would be a third hand-maintained reader.
- **The reduce's world is whole tables.** `data-reads` splits bare names and
  `worldOf` reads each with no filter, order, or view
  (`screen.js:788-791`); the reduce is called with
  `{items: getRows(), rows: await worldOf()}` (`:824`).
- **The write verbs are two, not three.** A reduce's update is `{row}` → `put`
  or `{id, patch}` → `update` (`screen.js:837-840`). There is no delete verb.
- **Structure already tracks rows.** A template's content is exactly one
  element or hydration throws (`screen.js:1040`); nested regions re-resolve
  their parent-row-interpolated filters per item (`:1093-1095`). A slot
  (singleton) with no row binds `data-empty-row` or the machine-synthesized
  fallback (`:1054-1060`) — and a slot whose filter matches two rows silently
  binds `rows[0]` (`:1252`).
- **Machines landed with `@` discrimination reserved as generated grammar**
  (`machine.cue:19`, `:23-27`), and derive vets every hand-authored
  `data-machine` against the published definition (`derive.ts:47`, `:127`).
- **Writers are already declared per entity** — `writers: *"forms" |
  "pipeline"` (`schema.cue:148`); the write topology per screen is the ir's
  flows (`schema.cue:361`, `:444`); the read topology derives from markup
  since PR #1640. Component-bearing screens are CUE-authored via
  `#Screen.markup` (`schema.cue:316`).

## The ladder

Postgres → Electric shape → collection is the loop's top instance; collection
→ region hydration → DOM is the same loop one rung down, with the keyed
reconciler as its view-maintenance engine and the reduce as its fold. The
DOM is the sub-tab tier: its rows are elements, its private tables are focus,
selection, scroll, the dirty text — state that dies even faster than tab
state. That invisibility is the model, not a leak: each rung is "everything
below, plus my own private facts," all the way down. A reduce cannot query
the DOM (the compartment has no `document`); what it gets instead is the
event — the terminal's whitelisted, serializable *lift* of DOM-private fact
(`id`, `from`, `animationName`, `key` next) — a tiny query result with a
closed schema.

## One writer per (fact, rung, moment)

Two machineries hide under "reconciliation," and only one is ever needed
here. **View maintenance** — mechanical, convergent, no policy — runs both
arrows already (Electric/IVM above, the keyed reconciler below); a view is
derived, so it conflicts with nobody. **Conflict resolution** — peer merge —
is needed only between symmetric writers, and the ladder never produces one:
every fact lives at exactly one rung; lower rungs hold derived copies plus
their own private facts. Where writers threaten symmetry, the answer is a
veto, one per arrow, each pointing the other way: the refusal event upward
(the server's no, arriving as data), the dirty-hold downward (the DOM rung
protecting its private fact from an overwrite). Offline is restored to
asymmetry by identity + idempotent replay + the veto — never by merge.

## Two grammars; engines are not languages

Authored languages, exactly two. The **data plane** speaks the PostgREST
fragment grammar — authored in markup and pipelines, executed today by four
engines (Postgres, the snapshot predicates, the IVM builder, PGlite in
mecha's browser tier). The IVM builder is a compile target, not a language;
nobody authors it. The **presentation plane** speaks CSS. Markup is the seam
where both live, one grammar on each side of the `data-live` boundary. The
standing debt is R2's: one exported parser module, imported by the terminal
and the checkers alike, so the grammar has one reader.

**Named reads complete `data-reads`.** Bare table names are the one place the
data-plane grammar degrades to nouns — a read with no filter, no order, no
view, snapshot-read on every event. The completion:

```html
data-read-standing="round?current=eq.yes&order=created_at.desc"
data-read-log="play?round_id=eq.{id}&order=seq.asc"
```

`state.rows` keyed by read name; bare names stay as sugar for `table?`;
`items` is the region's distinguished self-read. An auxiliary read some
region already subscribes is served by that region's maintained view — only
subscriptions open views, so an unshared read stays a per-event snapshot —
and R2 covers reduces for free: same grammar, same parser.

## Writes are keyed row change sets, everywhere

One algebra — `{key, insert|update|delete, value|patch}` — authored three
ways (a form, a reduce's `updates`, a machine transition) and applied three
ways (SQL DML via PostgREST, the store verbs, the keyed reconciler patching
keyed nodes). Electric's deltas, `subscribeChanges` batches, the reconciler's
dirty sets, and a reduce's return are the same shape at four points.

JSON Patch is rejected with reasons, not taste: it is path-addressed and
order-dependent where this tree is key-addressed and commutative-per-key
(what lets the outbox replay and `put` be stated twice), and it creates
*anonymous* structure — nodes with no row identity and no authored shape,
which is the forgery vector the renderer vocabulary refuses `data-*` hardest
for. Two gaps recorded while the algebra is named: the reduce's `updates` has
no delete verb; and `then:` (which collides with Promise vocabulary) and the
machine's future `after:` are two spellings of the terminal's one delay
mechanism. Each waits for its consumer.

**The write-side rule.** Read any relation you are granted, base or derived,
through the one grammar; write only base facts, only as their declared writer
(`writers:`, and RLS grants differ per direction — `public-read` rows are
readable by all and writable by one), at addresses obtained by reading or
minted (a create's client uuid, a `put`'s derived natural key). Views are
never written — the view-update problem answered the database way. An
address is not a capability: every write passes the store chokepoint
(visibility, writer, registration), which is what keeps writes lintable,
refusable, and replayable, where a Qt connection is peer-held authority
nobody can audit. The topology is symmetric and reviewable: reads derive
from markup, writes are declared as ir flows. Per-field writers are deferred
until two screens actually collide on one row's fields.

## Structure is never written, only instantiated

Rows are written; shapes are authored; the reconciler multiplies them. A
row's existence is a subtree's existence — insert conjures a template clone,
delete plays its exit. The tree↔flat isomorphism is already shipped and
authored tree-side: nested regions with FK filters *are* reference lists,
but the author writes nested markup interpolating the parent row, never
adjacency structures. Two shape-vocabulary extensions complete it:

- **Per-kind templates**: several templates per region, each with a
  `data-when` predicate in the fragment grammar. Closed grammar, open
  vocabulary — the app names the column and mints the values; a `cel:` enum
  makes exhaustiveness lintable (every kind has a template or a default,
  every template matches a declarable kind). First match in document order
  wins; a row whose kind changes re-stamps from the new template, losing
  DOM-private state — correct, and stated so nobody is surprised.
- **Named templates**: `data-template` indirection, so a template can
  reference itself — recursive depth, still authored as one tree shape.

The one quarantined exception: collaborative free-form editing is
CRDT-in-a-column — a column *type* whose value merges itself, inside one
fact. Rows keep one writer per moment; merge machinery never leaves the
column.

## Region cardinality

The singleton is demoted from sibling concept to cardinality. One concept —
the region — at three cardinalities: a **form** (0 rows read; pure intent), a
**slot** (≤1; the shape is authored in place and awaits the row; fallback and
`gone` semantics; the machine's home), a **list** (n; rows conjure shapes).
The choice rule: list-of-one when the node should have row semantics
(enter/exit, nested hydration, screen states); slot when the chrome must
precede the fact. Hygiene fix: a slot whose filter matches two rows is a
precondition error — the same pinned-unique-key rule the machine's
synthesized row introduced — never a silent `rows[0]`.

## Events are never published, only derived

Signals/slots and app-authored buses make the event the source of truth and
state everyone's private fold of it — the late slot missed the signal, and N
folds of one stream disagree (`2026-08-12` measured every variant of that
failing). This tree derives streams from tables, never tables from an
authored stream: a late-mounting region just reads the row. A publishable
bus would also be a second event source the terminal does not own — a hole
in the recording, the argument that killed `onRefused`. The derived event
set (`data-on-mutation`, `refused`, the DOM lifts) is closed and recordable;
who-hears-what is the reads in the markup, a set difference a checker takes,
not a connection list discovered by debugging. (TC39/Solid "signals" are
reactive values — our maintained views under another name — not Qt signals;
the answer to both meanings is rows, and views of rows.)

The transient-feeling cases dissolve: a toast is a row with a lifecycle (a
`then:` delay retires it); a flash is CSS on the stamped deltas
(`data-enter`, `data-pending`); focus and scroll are DOM-rung-private
effects the terminal owns. The one future door is a closed, terminal-owned
effect vocabulary in the reduce's *output* — a sibling of `then:` — not
designed until a widget forces it, and never a bus.

## Naming: provenance by rule, lineage in the doc

Native facts keep native names verbatim — if the name is on MDN it means
what MDN says (`animationName` was this rule's first application; `key` is
reserved as the next). Terminal-synthesized facts use names no DOM event has
(`id`, `from`, `seed`, `entity`, `kind`), with the collision rule stated: if
the platform ever mints one of ours, the native meaning wins and ours moves.
No `dom`/`tea` prefixes in code — the rule and the value's grammar are the
namespaces. The lineage table is the documentation's job:

| name | parent tradition |
|---|---|
| `event.type`, `animationName`, `key` | the DOM, verbatim |
| `(state, event) => result` | the reducer idiom (Elm `update`, `useReducer`) |
| `then:` | Elm's `Cmd` — the command as a value |
| `updates:` | the change set (Electric's deltas, CDC) |
| `state.items` | TanStack's own word for a collection's rows |
| filters, orders, selects | PostgREST, verbatim |

## Derived values

Any derived value — a count, a max, "2 of 5 selected" — is a maintained view
another region reads, never an event anyone consumes. Growth path: aggregates
enter the one read grammar in PostgREST v12's spelling, with Postgres and the
IVM engine's `groupBy`/`count` as the two engines of the same sentence.
Event-time windowing is the one stream capability that does not reduce to
IVM-over-tables; it stays server-side (pipelines, Arroyo in mecha's stream
profile), because the clock is an effect and effects are the terminal's, not
a query's. The forcing consumer is the gallery's first derived value.

## Non-goals

- **No JSON Patch**, or any app-facing DOM write language: the DOM is a
  maintained view, and structure is instantiated, not written.
- **No app-published events** — no bus, no signals/slots, no `data-send`
  until a hand-authoring consumer proves the need (`machine.cue`'s `@`
  grammar stays component-generated).
- **No `dom`/`tea` prefixes in code**; the naming rule is the namespace.
- **No system-wide CRDTs**; merge lives inside a column type or nowhere.

## Ranked plan

1. **The shared parser module.** One fragment parser, exported once, imported
   by the terminal and every checker. *Done when:* `parseFilterSpec` has one
   definition and R2 ships against it.
2. **The slot cardinality precondition.** *Done when:* a slot whose filter
   matches two rows errors instead of binding `rows[0]`, and the
   pinned-unique-key lint covers every slot, machine or not.
3. **Named reads.** *Done when:* truco's `data-reads` still works as sugar,
   a named read appears in `state.rows` filtered and ordered, and an
   auxiliary read a region subscribes rides that maintained view.
4. **Per-kind templates.** *Done when:* a mixed-kind list renders per-kind
   shapes and the exhaustiveness lint reports a kind with no template.
5. **Named/recursive templates.** *Done when:* a comment thread of unknown
   depth renders from one authored shape.
6. **Gated on consumers:** the reduce's delete verb; `then:`/`after:`
   reconciliation; the aggregate read grammar; the effect vocabulary.

## Rules worth carrying

- **Direction dissolves duality.** "Is A a view of B or B of A" is answered
  per arrow, never per pair: downward views, upward folds.
- **View maintenance is not conflict resolution.** Build the first freely;
  need the second nowhere, because ownership is per-(fact, rung, moment) and
  every arrow carries one veto, delivered as data or a hold, never a merge.
- **Grammar over engine.** Authors learn sentences; engines are build
  decisions. A new capability enters as grammar (aggregates), not as an API.
- **Addresses come from reads or mints, and an address is not a
  capability** — authority is checked at the chokepoint, which is what makes
  it lintable, refusable, and replayable.
- **Events are never published, only derived** — the write is the message,
  the read is the subscription, and the recording stays whole.
