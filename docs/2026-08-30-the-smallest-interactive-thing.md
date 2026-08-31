# The smallest interactive thing

Written from asking one question — *how do you make a button that changes
colour when clicked?* — and following the answer down. `2026-08-02-terminal-doctrine.md`
and `2026-08-27-the-row-that-changed.md` are the ground; `2026-08-29-the-screen-typechecker.md`
is adjacent and partly superseded here (see "What this changes about that doc").

The claim: **omnishell's restrictive layer is fine, and its ceremony is flat.**
Every declaration an app writes costs the same for a button as for a wall, so
the cheapest thing an app can do is priced like the most expensive. That, not
unfamiliarity, is what pushes a compiler toward escape hatches — and the fix
is subtraction plus one event, not a new layer.

## Facts not to re-derive

Read out of this tree on 2026-08-30. Line numbers are `plugins/omnishell/interpreter/`
unless said otherwise.

**The binding vocabulary already covers the case.**

- `screen.js:856` — `bindTree(region, undefined, items)`: `data-on-*` binds on
  the region element itself and on every descendant not inside a nested region.
- `screen.js:823,830` — a fired event carries `id` (the item's row) and `from`
  (the element's DOM id), with a comment on why the id and not the class.
- `screen.js:1148` — a singleton region hands its reduce `[currentRow]`, so a
  reduce over a one-row read can see its row.
- `data-empty-row` supplies the fields a region binds when no row exists yet.
- `{field}` placeholders, `data-live`, `data-filter` (PostgREST fragments) all
  exist and are used across four apps.

**Three write sites, one of which handles refusal.**

- `screen.js:667,672` — a **form** passes `refused` to the store.
- `screen.js:790-791` — a **reduce**'s updates pass nothing.
- `screen.js:734` — a **drag**'s updates pass nothing.

**What a refusal is, exactly.**

- `mecha-client.ts:165` (`libraries/mecha/packages/client/src/`) — a 4xx that
  is not 408/429 becomes `NonRetriableError`; the offline executor rolls the
  optimistic row back. Everything else stays retryable and the IndexedDB
  outbox keeps trying, across reloads, without the app ever hearing.
- `data-crud.js:267-290` — `settle` resolves after `ACCEPT_MS = 2500`. A
  refusal *inside* that window rejects the caller; one *after* it can only
  reach the app through `onRefused`, because the write already reported
  success.
- Consequence today: a reduce's write shows `network-error` for a fast 4xx
  (wrong state — a form would say `validation-error`) and **shows nothing at
  all** for a slow one.

**The tier already decides what is emitted.**

- `schema.cue:136` — `path: "crud" | "live" | "offline" | "tab" | "device"`,
  documented as monotonic in expense.
- `emit.cue:644-645` — `_serverEntities` / `_localEntities`. A `tab` or
  `device` entity emits no table, trigger, publication, policy, migration or
  seed. As of `1f17304c9` an app with none emits no services either.
- `schema.cue:303` — `#Screen.reads` is `{entity, order?, filter?, select?}`,
  which is exactly what `data-live` + `data-order` + `data-filter` +
  `data-select` already say in the markup.
- `schema.cue:427` — `surface.handlers[*].src` is the same path already listed
  in that screen's `files.handlers` and already named by `data-on-*`.

## The problem, stated exactly

A button that changes colour, at the cheapest tier, written with today's
mechanisms and nothing invented:

```html
<button data-live="tint" data-filter="id=eq.the"
        data-empty-row='{"id":"the","hue":"warm"}'
        data-hue="{hue}" data-on-click="tint">Change colour</button>
```
```css
[data-hue="warm"] { background: var(--accent); }
[data-hue="cool"] { background: var(--attention); }
[data-hue="sun"]  { background: var(--danger); }
```
```js
const NEXT = {warm: "cool", cool: "sun", sun: "warm"};
(state, event) => ({updates: [{row: {id: "the", hue: NEXT[state.items[0]?.hue ?? "warm"]}}]});
```

Nine lines, and they work. What surrounds them does not:

| Artifact | Lines | Contents |
|---|---:|---|
| `program.cue` | ~19 | entity `Tint` (table, path, 2 fields × `cel` + `check`), screen `demo` (title, route, `reads`, `forms: []`, `states`, `files.handlers`, `paths`), `surface.handlers.tint` |
| `ir.html` | ~60 | five objects: `Tint` entity, `demo` screen + `data-route`, `demo-loading` and `demo-populated` figures (an SVG each), `tint` handler |
| — | — | re-hash the ir into the program's pin, `write.ts` (25 files), `compose up --build` |

**Nine lines of app, about eighty of paperwork.** Of that paperwork, `reads`
and `files.handlers` are verbatim restatements of the markup, and the entity,
its ir section and its `check:` SQL describe a collection that emits no SQL and
dies with the tab.

## What this proposes

Four changes. Three are removals; one is an event.

### 1. A refusal is an event, not a callback

**What.** When a write is refused, deliver `{type: "refused", entity, id, kind}`
into the region's reduce, through the machinery that already synthesises
events (`screen.js:801`, the `then:` continuation, and `data-on-mutation`'s
`{type: "mutation"}`). `kind` distinguishes the `NonRetriableError` case from
a transport failure.

**Why an event and not a handler, an `Either`, or a Promise.** A `Promise`
settles once; this write settles twice at different times — "accepted
optimistically", which already re-rendered the screen, and "confirmed or
refused", which may arrive after a reload because the outbox is IndexedDB.
`Either` assumes the answer exists at the call site; here the value is already
in the collection and already on screen, and the failure is not *"no value"*
but *"the value you were shown has been withdrawn."*

The systems that solved this converge on the event: Elm (`Cmd Msg` carrying
`Result Error a` back into `update`), redux-offline (`meta.offline:
{effect, commit, rollback}` — the rollback is itself an action), event
sourcing (a rejected command appends `OrderRejected`), Temporal (activity
failure is a state in a durable history). The ones that use a callback —
TanStack Query, Apollo, and mecha today — put it outside the data flow.

**The decisive argument for this tree:** a callback is the only thing in this
terminal that cannot be replayed. Clicks, draws, delays and mutations are all
events the terminal owns, which is what makes `?seed=` and `?clock=manual`
work. A refusal handled by callback is a hole in exactly the recording you
want when someone reports "my share silently didn't take".

**What it retires.** The `onRefused` asymmetry across all three write sites.
The reduce writes the message as a row, and the screen renders it like any
other row — no `.store-error` side channel, no third seam for the drag.

**Compatibility.** A screen with no reduce mounted keeps today's behaviour: the
form's `refused()` becomes one built-in default of the same event.

**At browser tier this is unreachable** — nothing can 4xx — so no `tab` or
`device` app pays for it. It is opt-in by construction rather than by a flag.

### 2. Declaration burden equals durability — for state

- **`tab`** — no entity, no ir entity section, no flow object. The collection
  is a Map keyed by `id`; it emits nothing; the markup already carries the
  collection name, the key and the fields. There is nothing left to declare
  and nothing durable for a reviewer to sign.
- **`device`** — a line, not a section. localStorage survives a code change, so
  a renamed field is a small migration and the name is worth pinning.
- **`crud` / `live` / `offline`** — the full entity and its ir section. DDL,
  RLS, a publication, a policy someone must sign.

**Explicitly not included: code.** A Jessie handler keeps its `surface.handlers`
entry and its ir section at *every* tier. truco's whole engine is `tab`-tier
and earns review. The rule is about state, not logic — an earlier draft of this
argument overstated it.

### 3. `reads` and `files.handlers` are derived, not restated

Both are verbatim restatements of markup (`schema.cue:303`, `:427`). Derive
them from the screen's HTML at emit time rather than asking an author to write
them twice. `shell.yaml`'s `tables:` follows from the same source.

The review argument for `reads` survives only where the read reaches a server:
what an app reads from the cluster is worth signing, what it reads from a Map
in the tab is not. So the ir's Reads list stays for `crud`/`live` entities and
falls away with the entity at `tab`.

Implementation refinement (2026-08-30): the declared reads turned out to be a
curated abstraction, not a projection — truco's three per-trick `play` regions
appear in no reads list, and the declared order is not document order. What is
mechanically derivable is the per-screen **table set** (`data-live` +
`data-reads`), which is everything `tables:`/`local:`/`keys:`/`access:` ever
consumed; the `routes[].reads` restatement in shell.yaml had no runtime
consumer at all and is deleted rather than rederived. The derivation
(`derive.ts`, run by `write.ts` before its export) writes each app's
`program_derived.cue`, and its first run caught a real drift: thenote served
`shell/handlers/label-items.js` on a screen whose markup binds it nowhere —
`data-adapter` is read by no interpreter code since row-backed widgets
retired.

### 4. Two small removals

- **`upsert` falls back to the pk** when no `uniques` is declared
  (`data-crud.js:791` requires a declared natural key today, so a single-row
  toggle must restate its own primary key as a unique).
- **`check:` derived from `cel:`, or omitted for browser-tier entities.** It is
  dead text there, written twice by hand, and it is emitted into no SQL.

## Non-goals

State plainly, because each was proposed and rejected during the discussion
that produced this doc:

- **No new markup DSL.** `data-row="tint/the"` was invented and retracted: the
  query language already exists as `data-live` + `data-filter`, and a second
  spelling is worse than the extra characters. A cycle grammar
  (`data-on-click="hue: warm cool"`) was invented and retracted: it covers
  two states and a fixed order, and dies the moment the order is conditional —
  at which point you write the reduce you would have written anyway. **The
  general answer to computed writes is the reduce, and it already exists.**
- **No app-defined statecharts.** Zag's machines are statechart-shaped but not
  data: `props()`, `initialState()` and `context()` are functions, and every
  action and guard in the `states:` block is a *string naming a JS
  implementation*. XState's JSON has the same property. A CUE-declared machine
  is only declarative if the action vocabulary is closed and terminal-owned —
  which is what `terminal.cue:128` already does by publishing kinds and their
  parts. The split to hold: **durable state is rows** (reduces, IVM, replay);
  **transient interaction state is a machine** (open/closed, highlighted index,
  focus trap) and belongs to the widget tier, never to a row. A button has no
  transient state and therefore no machine.
- **Not Phoenix, not Elm.** Both replace the layer that works (the data path,
  the durability ladder, the tab-tier cluster) to fix the layer that does not
  (controls and feedback latency). LiveView additionally has no `device` tier
  at all, and Elm's corpus is smaller than what it would be adopted to fix.

## What this changes about the screen-typechecker doc

`2026-08-29-the-screen-typechecker.md` proposes seven static rules comparing
markup against the program. Change 3 above **deletes rules R1 and R7 rather
than implementing them**: there is nothing to compare once `reads` and
`files.handlers` are derived from the markup instead of restated beside it.

R2, R3, R5 and R6 stand unchanged, and R5 remains the highest-value rule in
either doc. R4 stands, with its finding intact: `terminal.cue:128` advertises
three row-backed widget kinds, and `screen.js:917` silently skips every
`[data-widget]` containing a `[data-live]`, so none of them has ever mounted.
That is a terminal self-check, not an app-side one, and it is unaffected by
anything here.

## Ranked plan

1. **Refusal classification at the three write sites.** Smallest, and it fixes
   a live defect: a reduce's or a drag's 4xx currently reports `network-error`
   or nothing. Even before the event lands, `store.update` from
   `screen.js:734` and `:791` should distinguish `NonRetriableError`.
   *Done when:* a refused reduce write reaches `validation-error`, and a
   refused drag does not vanish silently.
2. **The refusal event.** Deliver `{type: "refused", …}` into the region's
   reduce; keep the form default. *Done when:* an app can render a refusal as
   a row, and a recorded session replays the refusal with the click that
   caused it.
3. **Derive `reads` and `files.handlers`.** *Done when:* the four apps in
   `apps/` regenerate byte-identically with those fields deleted from their
   programs.
4. **Tier-scaled declarations.** `tab` entities and their ir sections become
   optional. *Done when:* the button demo above compiles with six lines of
   `program.cue` and two ir objects.
5. **The two small removals** (`upsert` pk fallback, `check:` derivation).

## Rules worth carrying

- **Ceremony should scale with what is at stake.** A flat cost per declaration
  is what makes the cheapest thing an app can do feel as expensive as the most
  expensive, and it is what makes escaping upward rational.
- **Invented syntax must survive the third case.** Both DSLs proposed here
  looked right on a two-state toggle and died on three colours in a
  non-trivial order. Test any grammar against the case that is one step past
  the demo.
- **A failure that arrives after the call returned is an event, not a return
  value.** Anything else puts it outside the data flow and outside the
  recording.
- **Check against published data, never a copy** — carried from the previous
  doc, and the reason change 3 is a deletion rather than a checker.
