# ARIA is columns

A component's state belongs to the rows it describes. Where it cannot live
there it is stored as N columns of one row, and everything downstream pays:
the item set freezes at compile time, the ARIA columns take invented prefixes
because N of them share a row, and the chart grows an arrow per ordered pair.
This says what the feature is, what it refuses, and — from the worked example
at the end — what it does not reach.

The catalog is the evidence for all three. Its programme carries twenty-one
sentences deferring some part of a keyboard or state contract, and they are not
a capability gap: they are what a single row costs.

## The wall is the comparison, not the value

The obvious shape is to project an ordinal and let the markup compare it. That
does not work here, and the reason is worth stating first because it rules out
the cheap version.

The binding grammar interpolates; it does not evaluate. `data-text="{index}"`
puts a number on screen and cannot ask whether that number equals another one.
The one conditional in the vocabulary is `data-when`, and it is literals-only
by design: a placeholder inside it is refused at hydration, deliberately, so
that which template a row picks stays decidable by reading the markup.

So a row carrying `index: 4` and a machine holding `active: 4` have nowhere in
the markup to meet. Exposing both as columns and hoping the template joins them
is a design that cannot be written down in this vocabulary.

**The projection has to do the comparison and emit the answer.** Not `index`
and `active` for the markup to relate, but `active: true`, and
`aria-posinset: 5`. After that everything downstream is what already works:
`data-when` picks an arm, and each arm's ARIA values are literals a reader can
see in the file — which is where a `tabindex="0"` comes from, since the answer
a comparison emits is a boolean and the arm turns it into the pattern's own
spelling.

That is the whole mechanism. The rest of this doc is about keeping it from
becoming something else.

## Why the item sets are frozen

The catalog's ARIA-stateful components all carry a compile-time item list —
`tabs.tabs`, `accordion.items`, `radio-group.items`, `menu.menus`,
`pagination.pages`, `carousel.slides`, `checkbox.items`. That is not the shape
anyone chose. `machine.cue` closes a machine's state set at compile time
(`initial: or([for k, _ in M.states {k}])`, and `target` drawn from the same
set), and `#OneOf` — the shared chart behind tabs, the segmented control and
the radio group — puts one state per option. A tab strip over a synced
collection therefore cannot use it at all.

So the frozen list is the workaround for the missing comparison, and four
things follow from the same cause: the item set cannot be data; the ARIA
columns need invented prefixes (`sel_`, `chk_`, `exp_`, `inc_`, `cur_`),
because N of them share one row and none of them can be called
`aria-selected`; the chart carries N(N−1) arrows each writing N literal
assigns; and the keyboard is deferred. Move the state onto the rows and all
four go away — including the naming rule below, which is unfollowable in the
one-row shape and free in the row-backed one.

The comparison itself is not new here. A radio group already binds this way:
N controls share a `name`, each carries `data-value="{col}"`, and the binder
checks the one whose `value` matches the column, reading that same member back
at submit (`interpreter/screen.js`, and `test/radio-bind.test.ts` guards both
directions with the comment "a radio group is one column seen from several
controls"). The projection is that, generalised past the one element the
platform hard-coded it for.

## APG names the columns

The projection's vocabulary is not ours to invent. APG enumerates, per pattern,
exactly which states a widget has — `aria-activedescendant`, `aria-posinset` and
`aria-setsize`, `aria-expanded`, `aria-checked` including `mixed` — and that
enumeration is the column list. A pattern's columns are read off the spec, not
designed.

Two things follow. A column is named for the ARIA state it answers, not for the
app's idea of it, so `active` on a listbox row means the row
`aria-activedescendant` points at and nothing else. And an ID reference is a
column's neighbour, not its content: `aria-controls`, `aria-labelledby` and
`aria-activedescendant` all name an element, so every id a component emits has
to carry its instance or the reference resolves to whichever duplicate the
document hits first.

The payoff is that one vocabulary serves three readers. A screen reader gets the
state; a test runner gets a role-and-name query that survives a class rename,
which a CSS selector does not; and the spec gets to be the arbiter of what a
pattern must expose, instead of a design conversation being reopened per
component. A test asserting `aria-checked` also cannot pass against markup that
never bound, because the attribute holds an unresolved placeholder — a rendered
string can be byte-identical to its bound result and prove nothing.

## Do not invent a query language

The read tier already has one, in the boot graph of every app:
`createLiveQueryCollection`, `eq`, `gt`, `gte`, `lt`, `lte`, `and`, `or`,
`not`, `inArray`, `isNull`, and the index types, vendored through
`interpreter/vendor/entry.ts` from mecha's client. Incremental view
maintenance is what computes a derived column exactly and instantly for rows
the browser already holds.

A derived projection is therefore a live query stated in a vocabulary that
exists, over collections that exist. Nothing here should grow a second dialect.
The platform has one dialect for reads (PostgREST fragments, parsed by
`fragment.js`) and one for incremental views; a third would be the drift this
doc exists to prevent.

In the event the engine is not needed at all, and the reason is worth keeping:
the refusals below confine every answer to rows the region already holds in
hand at refresh. `index` and `count` are positions in the array the region
just maintained, and `eq` is a comparison against one interpolated value. All
three are computed in the pass the region already runs. Incremental view
maintenance would earn its keep only for a projection spanning rows the region
does *not* hold — which is exactly what is refused. The engine stays available
for reads; the projection does not reach for it.

## The grammar

`data-project` on a region, JSON, output column to clause. Five kinds:

```html
<div role="tablist" data-live="tab_option" data-order="pos.asc"
     data-project='{"selected":{"eq":["id","{value}"]},
                    "posinset":"index","setsize":"count"}'>
```

- `"index"` — the row's 1-based position in the filter and order the region
  already declares. `aria-posinset` is a reader's ordinal, not an array offset.
- `"count"` — how many rows the region holds. `aria-setsize`.
- `{"eq": [column, value]}` — `"true"` or `"false"`. `value` may carry
  `{placeholders}`, resolved against the ENCLOSING row by the same
  interpolation a nested region's filter already uses.
- `"next"` / `"prev"` — the key of the row on either side, in the filter and
  order the region declares. Not "move by one", which is arithmetic: the
  neighbour, already named, for a gesture to write. The ends do not wrap: an
  end names itself, so a gesture there writes what is already true. Wrapping is
  a pattern's decision and APG makes it differently per pattern, so the read
  tier declines to take it.

The answers are merged into the row before binding, so nothing downstream
learns a projection was there: `aria-selected="{selected}"` is an ordinary
attribute binding and `data-when="selected=eq.true"` an ordinary arm. The
STORED rows are left alone — a machine reads its row off those, and a derived
column reaching a transition would widen what a chart is decidable from past
the row and the event that fired it.

Six things are refused at hydration rather than warned about, each as a
`ProjectionError` that propagates instead of being dressed as an outage: a
clause kind the parser does not admit; a derived name a stored column already carries, where
the merge order would otherwise decide which one a binding reads; a projection
on a slot, since `index` and `count` are facts about a set and one row is not
one; an `eq` clause naming a column no row carries, which would answer "false"
everywhere and paint a tablist where nothing is ever selected; a spec that is
not JSON; and one that parses into something other than a map of clauses —
`null` reaches the entries call and throws, and a bare `true` declares a
projection that states nothing.

The type carries more than the message, and it is not the projection's alone.
A nested region resolves every declaration it takes from the row it hangs under
— its filter, its own bound attributes, its machine — inside the PARENT's
refresh, where the dead-gateway guard is standing. Anything thrown there that
is not a `ProgramError` is retried on a backoff forever, reporting the store
down while the markup is what is wrong. So a wrong declaration raises one
wherever it is read, and not only where a projection reads it.

The unknown column follows a binding's rule exactly, including its one
carve-out: a row whose write is still in flight carries only the fields that
were submitted, so it is answered rather than refused.

A region carrying a projection also re-binds every row on every pass: a derived
column is a function of the whole set, or of a value outside the row, so a row
the delta never named can still be showing a stale answer.

## What it refuses

Every boundary that has held in this platform held because the vocabulary
stayed closed and the terminal owned the verbs. A projection that joins a
region's rows against a machine's row is the first construct here that starts
to resemble a query language in the read tier, so the refusals are the
load-bearing half of the design, and they stay whatever else changes.

State them as a boundary someone can re-run: the useful question is not whether
these rules read well, but whether the standard needs anything they forbid.
Walked against APG at the time of writing — `aria-activedescendant` is a
comparison against the machine's own row; `aria-posinset`/`aria-setsize` are
positional facts about the region's own projection; `aria-expanded` is the
machine's row; `aria-checked="mixed"` is an aggregate over rows the browser
holds; a filtered listbox is a region interpolating the machine's own term.
Every one is inside the boundary; none needed a predicate over a foreign
collection. Re-run that walk when a new pattern arrives, and if one genuinely
requires what is refused here, reopen the design rather than quietly widening
the rule.

Allowed:

- **Positional facts about the region's own projection** — the index of a row
  within the filter and order the region already declares, and the count of
  those rows. The region's read is the projection; nothing new is being
  queried.
- **A comparison against the machine's own row** — the row that region already
  binds. `active` is `index = machine.active`, and the machine's row is a
  parameter, exactly as a nested region's filter interpolates its parent's row.
- **The answer as a column**: a boolean, a number, a string a template can
  interpolate or a `data-when` can match as a literal.

Refused:

- **Arbitrary predicates over foreign collections.** A projection may read the
  region's rows and the machine's row. It may not join a third table, and it
  may not filter one collection by a subquery over another. That is a query
  language, and the moment it exists the chart stops being a complete
  inventory of what a screen can do.
- **Aggregates over server-tier tables.** The derived-counts rule already
  settles this: a count is exact when the reader can see the rows it is over.
  Browser-owned (`tab`, `device`) rows qualify; a `crud` or `live` table is a
  window onto rows the reader does not hold, and an aggregate over it is a
  number the screen cannot justify.
- **Expressions in markup.** The comparison happens in the projection, never in
  a binding. If a future need seems to want `data-when="{index} > 3"`, the
  answer is another derived column, not an expression grammar.

## Worked example: a tablist whose tabs are rows

`plugins/omnishell/test/row-backed-tabs.test.ts` is this design as a running
screen, and it is the doc's own claim under test rather than beside it.

Which tab is chosen lives as an id on the enclosing choice row. Every tab's
`aria-selected`, `aria-posinset` and `aria-setsize` come off one projection.
Which panel exists is a `data-when` arm over the same derived column, so the
panel cannot disagree with the tab. Both id references — the tab's
`aria-controls` and the panel's `aria-labelledby` — are built from the row's
own id, which is the naming rule above holding in practice: nothing reaches
for another row to name an element. The pick is written by the form the tab
already is, an upsert carrying the option row's id into the choice row's one
column, exactly as a row-backed follow or favourite is written today.

There is no machine on the screen at all, and that changes what a reviewer
reads. "Read the chart and you have seen the whole contract" is the property
this platform trades on, and for a row-backed component the chart is not where
the contract lives: it is the form and the projection, together. The property
survives — a projection is one attribute whose kinds are a closed set, which is
a finite thing to finish reading, and a derived column cannot reach a guard, an
assign or a target because `currentRows` keeps the stored rows. But the artifact set is different, and a reviewer should be told
which artifacts to read rather than discovering that the chart is empty.

Measured against the shipped
spelling at N = 3, `#OneOf` costs 3 states, 6 arrows, 18 literal assigns and
~860 bytes of machine JSON; the row-backed tablist costs no arrows and writes
one column per pick, at any N. The growth is the point: arrows are N(N−1) and
assigns N²(N−1), so an eight-tab strip would be 56 arrows and 448 assigns.

And the test asserts the thing the shipped spelling cannot do at any size —
a fourth tab arrives as a row, mid-visit, and the contract holds. `#OneOf`
cannot express that at all, because a new option is a new state and states are
compile-time keys.

The honest cost the example also records: the per-row form has to carry
`role="none"`, because a `<form>` between the tablist and its tabs would break
the pattern's required child structure. The shipped component emits
`<button role="tab">` directly under the tablist and needs no such wrapper.

## What it reaches, and what it does not

It reaches the state a row can answer for itself: selection, position, set
size — every ARIA state whose value is a fact about ONE row, compared against
one parameter.

It reaches the keyboard, as a GESTURE rather than as a chart — which is where
it belongs, and the distinction is the whole of it. Arrow keys as a machine
transition over the machine's own row (`active + 1`, clamped by `count`) is
what no projection supplies: that needs a transition selected by which key was
pressed, and arithmetic, and by the first rule below `index` and `count` are
*operands*. So the chart route stays shut, and the gesture route needs none of
it.

Three things compose, and each was already here for its own reason: virtual focus keeps DOM
focus on the container, so nothing has to move it; the container binds its own
element from the enclosing row, so it can name the active option; and `next`
and `prev` put the neighbour on each row. Then `data-key` submits the form the
container names, and a listbox walks its options with no chart, no arithmetic,
no `focus()` and no module. `test/roving.test.ts` is the whole pattern.

The shape is worth stating because it is the doc's own argument arriving
somewhere unplanned: the projection answers, the markup names, the form
writes. Nothing computes.

It does not reach `aria-checked="mixed"` either, and the reason is the
refusals doing their job. `mixed` is an aggregate: it is a fact about how many
children are checked, and it has to land on the PARENT's row. Every clause
here answers on the rows the region itself holds, so a sibling region filtered
to the checked children can count them but can only say so on those children —
and at zero checked there are no rows left to say it on. Reaching it means a
projection that writes onto the row of the region that OWNS the list, which is
a different mechanism and wants its own walk against the refusals, not a
fourth clause bolted on here.

The keyboard splits three ways, and only the third is unresolved:

- **The element owns it.** Radio group, select, checkbox, disclosure, slider.
  Native controls supply the whole APG contract — roving tabstop, arrows,
  Home/End, wrapping — for free. This is the catalog's own doctrine (dressed
  rather than rebuilt) and it deletes these deferrals rather than answering
  them.
- **Tab plus native activation is already the whole required contract.**
  The accordion says so in its own header. What is deferred there is APG's
  OPTIONAL keys.
- **Needs virtual focus:** listbox, combobox, grid, tree. APG lets these keep
  DOM focus on ONE container and name the active row with
  `aria-activedescendant`, and that is a plain binding off the enclosing row —
  no key moves focus, so nothing has to call `focus()`. This works. What stood
  in the way was not the design: a list region's own element was the one
  element nobody bound, so the container could not name a row of the list
  inside it.
- **Needs a roving tabstop:** tablist, toolbar, menubar. APG moves real DOM
  focus between the items here, and nothing in the interpreter calls `focus()`.
  This one is still open, and it is open for a reason no projection reaches:
  moving focus is a DOM write with a reader on the other end of it.

Jessie should not be what closes the third case, and the reason is not that a
module would be wrong. The chart will never model everything, and it is not
supposed to: what belongs in it is what is genuinely more elegant and less
bug-prone stated as a chart, and everything else belongs on the rung below.
truco's `{"type": "sitting"}` guard is a fair inhabitant of that rung — a
predicate about the table, not about the row.

The keyboard is different only because nobody has asked the question yet.
Reaching for a module first would settle by default what should be settled on
the merits: whether a declarative spelling exists that is better than a module,
not merely possible. Until someone has looked, deferring is what keeps the
question open — which is what the catalog is already doing.

The shape a declarative answer would have to take is worth recording, because
the row-backed spelling has already moved the ground. The pick is a FORM
there, not a transition — so nothing about roving focus is the machine's
problem any more, and the arithmetic that made it one is gone with it. What
is left is a key that submits a form: with `next` and `prev` projected onto
each row, ArrowDown submits the neighbour's, writing the same one column the
tab's own click writes. No machine, no guard, no arithmetic. The precedent is
narrow but real — a form with no submit button already submits on `change`,
inferred from its shape.

First built as a spike against a TABLIST — the one pattern APG gives no
virtual-focus model, and so the hardest place to have started. It stopped on
two things, and both are worth keeping because they say where the boundary
runs.

Focus did not follow. `next` is a column of the row whose form fired, so a
second press moved only if the first moved focus, and nothing in the
interpreter calls `focus()`. The linkedom tier cannot even decide it — it
answers `focus()` and never sets `activeElement`. For a LISTBOX the question
never arises, and that is the argument for reaching for virtual focus rather
than teaching the terminal to move focus: the pattern that needs no focus move
is the one this vocabulary can state.

And an arrow key has to cancel its own event or the page scrolls under the
reader. The catalog's `accept-menu-no-context` asserted the whole set of events
the interpreter cancels, because the menu declines `contextmenu` on the grounds
that a transition cannot cancel what it answered. A keydown cancel made that
assertion false while leaving the decision true — the claim it rests on is
about a MACHINE's dispatch, and the set was a proxy for it. The test now
measures the machine's dispatch directly, and the decision says what it always
depended on: every cancel the interpreter makes belongs to a gesture the markup
declared, and a machine's event dispatch is not one. That list may grow; the
claim does not.

What is left open is the roving tabstop, and it is open because moving focus
is a DOM write with a reader on the other end of it — not because a projection
is missing.

## Rules worth carrying

- The projection emits answers, not operands. If the markup would have to
  compare two columns the projection is not finished, and the rule holds just
  as hard when the thing doing the comparing is a chart. That is what rules
  the keyboard out of this doc.
- One dialect for reads and one for incremental views. A third is a defect.
- State belongs to the rows it describes. Stored anywhere else it needs
  prefixes, freezes its own item set, and pays an arrow per ordered pair.
- The chart earns a pattern only where stating it as a chart is more elegant
  and less bug-prone than the rung below. Reaching for a module before that
  question is asked answers it by default; asking it late costs a deferral,
  which is cheap.
- A derived column is exact only over rows the reader holds.
- The refusals above are the feature. A projection that can express anything is
  a query language wearing a column's clothes, and the grammar will stretch
  until it lies.
