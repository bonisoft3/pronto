# What a gesture costs

Written from wave 6 of `apps/omnishell-shadcn-ui`, whose catalog had twenty-one
sentences deferring some part of a contract and whose four remaining shadcn
components were each refused in writing with a mechanical reason. The ground:
`2026-09-01-aria-is-columns.md` (the projection and its refusals),
`2026-08-30-machines-not-widgets.md` (the machine and its closed action
vocabulary), `2026-08-31-the-session-is-a-value.md` (record cause, re-derive
consequence), `2026-08-27-events-and-the-clock.md` (a compartment has no clock).

The claim: **the event vocabulary was never the thing that was closed — the
EFFECT vocabulary was, and four of the catalog's walls were one question about
it.** What a gesture costs is not permission to hear it; the interpreter already
attaches a listener for every event key a chart handles. It is permission to
displace what the browser would otherwise have done, and permission to move
something CSS cannot.

## Facts not to re-derive

Measured in this tree on 2026-09-03.

- `interpreter/screen.js` attaches a DOM listener per event key the chart
  handles. `contextmenu`, `mouseenter`, `focusin` all dispatched before this
  wave; the event names are the DOM's by doctrine (`2026-08-27`'s own rule).
- The interpreter cancelled in exactly three places — a form's submit, a drag's
  `dragover`/`drop`, a `data-key` binding's keydown. Each is a gesture the
  markup declared. That was the whole of it.
- `focus()` appeared nowhere, and still does not.
- The projection's clauses were `index`, `count`, `next`, `prev`, `eq`.
  `ROVING_KEYS` already admitted `Home` and `End`; the deferral was the clause
  set, not the key set.
- The calendar walked two axes with two `data-order`s over one collection, so
  2-D was never a missing clause — but the minor axis ran off the foot of one
  lane into the head of the next, which the screen documented.
- `data-order` was read raw, and `REGION_ATTRS` did not carry it.
- A nested LIST region that re-hydrated read its item templates off the DOM
  again, found none, and took the SLOT branch. Correct-looking at one matching
  row; a cardinality error at two. Only a moved read reached it, which is why
  nothing had.

## The rule that did not move

*Every cancel the terminal makes belongs to a gesture the markup declared.*

What moved is which markup counts. An arrow keyed on `contextmenu` IS such a
declaration, as much as a `data-key` map is — so `contextmenu` joins a closed set
of **displacing types**, whose default is cancelled wherever an arrow answers
them. The set is closed and that is the whole of it today, so an arrow can only
displace a default it was already incoherent to keep: an app menu and the UA's
cannot both be what the reader asked for.

Two things make it safe, and both are load-bearing:

- **The cancel is the ARROW's, not the type's.** Candidates resolve
  synchronously — `preventDefault` cannot survive an await — and an arrow
  narrowed to one affordance declares the gesture *there*. A right-click
  elsewhere in the region, or in a state drawing no such arrow, keeps the
  platform's own menu. Cancelling by type would make a whole region inert for
  one narrowed arrow inside it, which is a fix costing more than the bug.
- **The set is closed in CUE**, beside the chart it belongs to, so growing it is
  an edit someone reviews rather than a string an app can pass.

## Record cause, re-derive consequence — applied to geometry

A context menu opens at the pointer, so a coordinate has to reach a row. The
naive spelling is `clientX`/`clientY`, and it replays *exactly* in the state
domain: same row, same guard branches. What it loses is the rendered position,
and with it the one bug class worth engineering for — the menu that opened
clipped off the right edge.

Viewport-fraction normalization fixes the class but needs the viewport, and a
window resized mid-session makes any one pin a lie.

The answer is to move the frame of reference, not to pin one. The event already
carries `from`, so the terminal expresses the point in **the affordance's own
box**: `(clientX − rect.left) / rect.width`, in parts per thousand. Three things
fall out at once.

- The frame is an element the replay also renders, so nothing needs pinning and
  a layout change carries the point with it.
- It composes with the placement story that already existed. The surface anchors
  to the affordance and the offset displaces it *within* that anchor, so
  `z-index` stays absent and `position-try` recomputes the clipping. **The
  clipping bug reproduces because CSS re-derives it, not because we recorded
  pixels.**
- The app sees the quotient and never the divisor. No guard, assign or binding
  can reach the box, so no chart can depend on the geometry it was measured
  against: idempotence under a resize is *structural* rather than a contract
  someone keeps. That is `2026-08-12`'s rule one tier down — a fact about how a
  value was derived belongs to whoever derived it.

Integral rather than fractional, deliberately: a column a replay must reproduce
exactly should not be a float, and the stylesheet is where the pixels come back.

## The effect roster, and its one rule

Two effects joined the terminal's closed roster, and both are functions of
something the app declares rather than things anyone schedules.

**A surface's place in the top layer.** `popover` openness is not a style — the
element is moved — and the browser offers only an imperative call and an invoker
that answers a click. A right-click has no invoker, so `data-open` lets a row
decide it: re-derived on every bind, idempotent, so a replay puts the surface
exactly where the session had it.

**A surface opened on interest.** `data-interest` names a surface a trigger
opens on hover or focus. This one holds *no* state, and that is precisely what
licenses it: **openness nobody stores cannot disagree with anything.** Nothing
reaches the store, nothing is journalled, a replay has nothing to reproduce —
the same licence `popover="auto"`'s own light dismiss has always run on.

The rule that makes both safe is the one the Rust memory model suggests, and it
is worth stating as a rule rather than as two checks: **a surface has one
owner.** `data-interest` naming a surface whose openness is already a column is
refused, not arbitrated, because the two disagree the moment either moves — the
row restating its answer on the next bind would shut a surface the reader is
still under. Where a resource is a singleton, two claimants is a compile error.

Two constraints kept the interest polyfill from being the imperative ad-hoc the
doctrine names as the disease. Its waits are the terminal's clock, never
`setTimeout`, so `?tempo=` and `?clock=manual` govern them like every other
delay — a hover delay on a timer of its own is nondeterminism no replay could
hold still. And the surface must be `popover="auto"`, so WCAG 1.4.13's
*Dismissable* clause is the element's and the polyfill never listens for a key.
It is not named `interestfor`: naming an attribute after a spec no engine ships
would dress our own behaviour as a standard, and a spec landing differently
would strand the name.

## Vary over a closed set, never over a name

`data-order` was read raw for a good reason, and the reason survives:
interpolating the *clause* would let a row name a COLUMN, which is reflection,
and the set of reads a screen has would stop being enumerable — a reviewer could
no longer finish reading what the screen can do.

Interpolating a **key of a map the file states** costs none of that. Every order
the region can be read in is written down, a column picks among them, and a key
the map does not carry is a `ProgramError` rather than an unordered read.

That is the same trade `data-when`'s arms and a machine's compile-time state set
already make, and it generalizes past this attribute: **where a declaration must
vary, vary it over a closed set enumerated in the markup, never over a name.**
Finite selection, no arithmetic, and the inventory property intact.

Two things the change forced, both worth carrying:

- `data-order` joins `REGION_ATTRS`. The binder consumes a placeholder on first
  resolve, so an order map bound once would answer its first key forever — a
  sort that never sorts again.
- **Both halves of a read count.** `syncNested` compared the resolved filter and
  reused the region when it matched; an order left out of that comparison is a
  header that writes its column and never re-reads.

## A lane is a partition, not only an order

The projection gained `first` and `last`, and all four lane clauses gained an
optional partition: `{"next": "col"}` is the neighbour among the rows sharing
this row's `col`.

The partition is the more valuable half, and the reason is worth keeping.
`first`/`last` closed a deferral repeated on four screens — a *missing* answer.
The partition fixed a *wrong* one: a grid's minor axis is a second `data-order`
over the same collection, and without a partition its walk ran off the foot of
one lane into the head of the next, so a caret walking down a Monday arrived on
a Tuesday. Prefer the clause that corrects an answer to the clause that supplies
one.

Both stay inside the refusals `2026-09-01` drew, and the walk was re-run rather
than assumed: each answers over the region's own rows, compared against a column
of the same row, in the single pass the region already makes. No foreign
collection, no aggregate, no expression in markup.

The walk's partition and the ends' partition differ on one lane, and that is not
an accident to tidy away: the calendar's arrows walk the month while Home is the
start of a *week*, so a component names them separately.

## What this did not open

- **Aggregates.** A sum is a read across rows and a region hands its template
  one. Deferred deliberately; it is a tier question rather than a clause.
- **The roving tabstop.** Still open, and the doc's stated reason is not the
  sharp one. "A DOM write with a reader on the other end" is true of rendering
  too. The real problem is that **the user is also a writer**: Tab moves focus
  with no row changing, and a terminal re-asserting focus each refresh is a
  focus-stealing loop. The shape of an answer is already in the algebra —
  `focusin` is an event key, so the DOM's own moves report back as causes and
  the terminal performs focus only when a chart moves the column. Disagreement
  becomes unrepresentable rather than managed. Its acceptance lives at the
  Playwright tier: linkedom answers `focus()` and never sets `activeElement`.
- **Home and End on the data table.** The palette has them; the table does not,
  because its order is a map and reversing it means reversing every clause of
  that map rather than one literal.

## A miss means two different things

Every key on a filtered list names a form off the caret's own id, so a filter
matching nothing renders no forms and the key names one that is not there.
`data-key` called that a program error — loudly, on a state a reader reaches by
typing. The palette and the data table both threw on it before this wave.

Nothing saw it, and that is the more useful half. **linkedom keeps a
`<template>`'s children parented to the template**, so its `getElementById`
answers from markup that never rendered; a browser parses that content into a
fragment of another document where `getElementById` cannot reach it. Its
SELECTORS are already right — `querySelector("#x")` and `querySelectorAll("form")`
both decline to enter template content — so the gap is one method wide, and the
harness closes it by rejecting a hit whose `closest("template")` is not null.
No library swap: happy-dom and jsdom are more faithful in general, but this tier
is chosen for speed and the one method is cheaper to correct than to replace.

The rule that replaced the contract reads the DECLARATION rather than the
resolved value. A literal id naming nothing is the markup naming a form that is
not there, and stays loud — the typo case is worth keeping. An interpolated one
may legitimately resolve to nothing, because the set it names can be empty, so a
miss there is a no-op and the key is left uncancelled.

The general shape, and it is the third time this doc has drawn it: **a
declaration that varies and one that cannot are different declarations, and the
platform can tell them apart without asking anyone.** It is the same move as
varying an order over a closed map, and as measuring the pointer only where a
chart reads it.

## Rules worth carrying

- **The event vocabulary is the DOM's; the effect vocabulary is ours.** When a
  wall looks like a missing event, check which one it actually is.
- **A cancel belongs to a declared gesture — and an arrow is a declaration.**
  Read a refusal's argument, not its verdict; this one specified its own
  successor.
- **Frame a measurement on something the replay already has.** Then nothing
  needs pinning, and the app can be denied the frame entirely, which turns a
  contract into a structure.
- **Openness nobody stores cannot desync.** That is what licenses the terminal
  to perform it.
- **One owner per singleton resource**, checked where the two would be spelled
  rather than arbitrated when they disagree.
- **Vary over a closed set, never over a name.**
- **Prefer the clause that corrects a wrong answer to the one that supplies a
  missing answer.** A screen that documents its own wrong answer is telling you
  where the clause goes.
- **A test tier that cannot see a failure is part of the failure.** Check what
  the tier answers before trusting that it is green, and correct the tier at the
  one method rather than replacing it.
