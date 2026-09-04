# The reader is also a writer

Wave 7, which took one of the two successors the previous wave named and
declined the other on its own argument. The ground:
`2026-09-03-what-a-gesture-costs.md` (which named both, and was right about why
the tabstop was hard), `2026-09-01-aria-is-columns.md` (the projection, its
refusals, and its rule against a second dialect),
`2026-08-12-derived-counts-the-reader-is-inside.md` (when a number over rows is
exact).

Two claims. **The tabstop was never a focus problem; it was a two-writer
problem, and it is solved the way every other two-writer problem here is — by
giving one of them the only pen.** And **the aggregate is not a projection
clause, because the platform already has two fold vocabularies and a third
would be the drift `2026-09-01` exists to prevent.**

## Facts not to re-derive

Measured in this tree on 2026-09-03.

- `focus()` appeared nowhere in `interpreter/screen.js`, and virtual focus
  (`test/virtual-focus.test.ts`) is why: `aria-activedescendant` names the
  active row and DOM focus never leaves the container, so nothing had to move.
- `data-key` already routes an arrow to a form, and `region.addEventListener`
  already attaches a listener per event key the chart handles. Both writer
  paths existed; neither knew it had moved anything a reader stands on.
- `ownedBy` is the existing answer to "the region's own item, not a nested
  region's rows". A pass that forgets it reads a singleton as declaring every
  tabstop its children render — which is what the first run did.
- `check-visual`'s param fixtures had been keyed by the param NAME since they
  were first read off the markup, and two of xpense's six routes spell `:id`.

## A tabstop is one pen, and the reader holds the other

The doc that deferred this said the sharp reason was that "the user is also a
writer": Tab moves focus with no row changing, so a terminal re-asserting focus
on every refresh fights the reader for it. That is right, and it is also the
whole design once it is read as a writer conflict rather than an effect
problem.

Every other two-writer problem in this platform is settled by making the
disagreement unrepresentable rather than arbitrating it — one owner per
singleton resource, checked where the two would be spelled. Focus is a
singleton resource. So:

- **The terminal owns the tab order outright.** `data-rove="{column}"` names
  the derived column that says which row is current, and the terminal stamps
  `tabindex` on every item from it. A screen that spelled the tab order per
  item could disagree with itself about which row is reachable, and the DOM has
  only one answer.
- **Focus follows the tabstop MOVING, and nothing records who moved it.** The
  delta between two consecutive views is the whole licence: a refresh that left
  the column standing moved nothing, so there is nothing to follow. This is the
  part worth being strict about. The first build recorded a cause — a one-shot
  armed by a gesture and spent by the pass it caused — and that is state the
  rows do not hold: no trace records it, no snapshot restores it, so a replay
  and a jump to the same state could take different paths. A delta is a function
  of two views and answers the same either way.
- **The column has one writer, checked where that is decidable.** A delta cannot
  tell this reader's write from another's, so `roveLint` refuses a tabstop over
  a `crud` or `live` row at compile time: a second reader's move would land here
  as this reader's caret jumping. A `tab` or `device` row is the reader's own,
  and there the delta IS their move.
- **The reader closes the loop from their side.** `focusin` is an event key, so
  a chart that declares it has the DOM's own moves reporting back as causes, and
  the column follows the reader instead of arguing with them. Nothing new was
  needed for it — the event vocabulary being the DOM's is the previous wave's
  rule collecting its own dividend — and `#OneOf` now draws it under the same
  flag as the arrows, because a Tab into a group that left the column behind is
  the disagreement this is here to make unrepresentable.

The set is every `data-rove` the region owns, and the region's shape says
nothing about it. A list whose rows are the members and a compile-time item set
of N members under one row — three `<button role="radio">` each binding its own
`chk_` column — are the same set; a one-row list carrying a fixed set of
affordances is both at once, which is what a pass keyed on the shape gets wrong.
The invariant is not per row either: **one member reads true**, and two is a
tabstop decided by document order rather than by the columns.

What the delta rule buys beyond correctness is that the awkward cases stop being
cases. An arrow at the end of a lane names the row it is already on, so the
column does not change and there is nothing to spend or to leave standing. A
first paint carries no previous tabstop, so a set arriving is not a set moving
and the page is not taken from whatever the reader opened it on. Neither needed
a rule; both fall out of comparing two views.

Nothing about the DOM changed to make this possible. The vocabulary had been
complete for a wave: the projection could already name which row is current,
`data-key` could already route the gesture, `focusin` could already be heard.
What was missing was a statement of who owns the pen — and with that written,
the implementation is one pass over the region's own items and a flag with a
lifetime of one refresh.

Its acceptance is split, and both halves are now written. **linkedom answers
`focus()` and never sets `activeElement`**, so the whole-screen tier watches the
call and the tab order it stamps. The browser tier
(`playwright-tests/roving-tabstop.pw.ts`, served entirely by the test — no
cluster) has the half a shim answers wrongly, and the sharpest of its four cases
is the one that is not about focus at all: **a browser refuses `focus()` on an
element with no tabindex**, so the tab order is the precondition for the focus,
and a shim that answered `focus()` would report the terminal doing its job while
nobody moved. A tier that cannot see a failure is part of the failure — so say
which half it is checking, in the file, rather than letting green stand for more
than it measured.

## The arrows and the tabstop are one contract

`#OneOf` — the single-select chart three skins in the gallery run — takes a
`rove` flag, and the toggle group and the radio group set it. Not two flags:
a tabstop with no arrows to move it strands every unchosen option outside the
tab order, and arrows that changed the choice while focus stood still would tell
a reader nothing. A skin takes both or neither, and the menu's `menuitemradio`
set takes neither, because a menu's arrows cross every item and half a keyboard
there is the failure this avoids.

Three things fell out of building it, each one a hole the change would otherwise
have left:

- **A guard is a module, so an arrow's key is data.** The transition grammar has
  no literal comparison, and every roving arrow differs from its siblings only
  in the key that selects it — so one leaf reads `event.key` against a key
  carried as a param, and one module serves every arrow of every group.
- **The walk could not drive them.** The chart-derived walker fires every arrow
  and reports what never fired; a guard reading `event.key` is unsatisfiable by
  an event with no key, so all thirty-two arrows came back uncovered. Params are
  literals by construction, which is what makes the fix available: **a guard
  param named after an event field is the chart saying which event satisfies the
  arrow**, so the walk synthesizes it instead of guessing at a keyboard. A key
  whose candidates want different events is that many stimuli, not one.
- **The terminal had to cancel the arrow.** A keydown joins the displacing set
  by its KEY rather than its type — scrolling the page while the tabstop moves
  inside a group is a default incoherent to keep, where a chart answering a
  printable key is a reader typing and the browser's job stands.

The one claim that weakened is worth stating rather than hiding: the menu's
radio set and the radio group are no longer byte-identical charts. They are one
generator in two configurations, and the suite now compares the click arrows —
which is still the guarantee that mattered, since a copied generator would drift
there first.

## The aggregate is not a clause, and saying so is the wave's other result

`sum`, `min` and `max` were built as projection clauses, and then removed. The
argument for removing them is worth more than the clauses were.

`2026-09-01` has a section called "Do not invent a query language", and its
rule is that the platform has one dialect for reads and one for incremental
views, and **a third would be the drift that doc exists to prevent**. A clause
set of positional facts and one comparison is not that third dialect. A clause
set that names its own operations is, and `projection.test.ts` had been
guarding the line with `{"sum": [...]}` as its exemplar since the day the
clauses were closed.

The deferral in `2026-09-03` reads "it is a tier question rather than a clause".
That is a verdict, not an open question, and the tier it points at already has
two answers:

- **On a browser tier**, a derived column is a Jessie fold woken by
  `data-on-mutation`, in the fold seat. That is the device-tier doctrine, and it
  is where a running total already lives.
- **On a server tier**, `#Pipeline` declares a fold as four pure functions —
  `empty(key)`, `step(acc, row)`, `combine(a, b)`, `result(acc)` — with
  associativity and the empty case stated as laws. The realworld favourite
  count is that mechanism carrying a number no browser-side count could
  justify.

So a projection clause would have been a third spelling of a fold, weaker than
both: no accumulator, no `combine`, no laws, and no reach past the rows one
region happens to hold. The refusal `2026-09-01` wrote — a fold is exact only
where the reader holds the rows it is over — survives as the reason the two
existing seats are the seats, rather than as a precondition on a clause.

The rule the doc already stated for this case is the one to follow: **if a
pattern genuinely requires what is refused here, reopen the design rather than
quietly widening the rule.** Renaming a test's exemplar so a new clause can pass
is the quiet widening, precisely.

## A param is named by a route, not by a screen

The battery's fixtures come from the markup. What stayed wrong is subtler, and
was invisible for the same reason the earlier bug was: **the plan was keyed by
the param's NAME.** xpense spells `:id` on `/c/:id` (a category) and on
`/e/:id` (an expense). One answer under `id` filled the second route with the
first route's row, the screen rendered the gone state, and the battery reported
a stale fixture rather than a bug it never looked for.

The fix is the scope, not the lookup: a plan is `(route, param)`, because a
param is named by one route's markup and means what that markup says.

The general shape, and it is the second time a wave has found it: **a coverage
hole and a passing check look identical from the outside.** The guard meant to
catch the earlier one could not, because a param with no plan never reached the
list of params whose plan failed. This one had a plan — the wrong route's.

## Rules worth carrying

- **Read a deferral's argument, not its verdict** — and read the verdict too.
  One of this wave's items was specified by the doc that refused it; the other
  was refused by it, on grounds that still hold.
- **Before adding a vocabulary, count the ones that already say it.** A fold had
  two seats; a third spelling would have been the weakest of them.
- **A shared resource gets one owner, and the reader is one of the writers.**
  Focus is not an effect to sequence; it is a pen to hand out.
- **An effect keys off a delta, never off a recorded cause.** A cause the rows
  do not hold is state no trace records and no snapshot restores, so replay and
  time travel stop agreeing. If an effect seems to need to know who did
  something, look for the two views whose difference already says it.
- **A rule that needs one writer says where one writer is guaranteed.** The tier
  is decidable at compile time, so the precondition is a build failure rather
  than a caret that jumps when someone else is looking at the same row.
- **A test's exemplar is load-bearing.** When a change needs one renamed, the
  change is what to re-examine.
- **Scope a lookup by what names the thing.** A param is a route's, an item is
  a region's.
- **A capability arrives whole or not at all.** Half a keyboard is worse than
  none, so the flag that turns on the tabstop turns on the arrows.
- **A test tier that cannot drive a construct is part of the construct's cost.**
  The walker's blindness to a guarded arrow was found by the walker itself, and
  closing it took the same literal-params rule the guards already keep.
- **Say which half of a contract a tier checked.** linkedom answers `focus()`
  and sets no `activeElement`, so green there means the call and the tab order,
  never the landing.
