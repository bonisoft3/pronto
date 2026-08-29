# Events and the clock: what a compartment cannot ask for

Written from the apps/truco compile, from questions that compile raised and
could not answer inside the app. `2026-08-02-terminal-doctrine.md` names the
roles, `-incremental-model.md` supplies the semantics under them, and
`2026-08-12-derived-counts-the-reader-is-inside.md` works one derivation all
the way through. This doc answers a narrower question those three leave open:
**what may wake a handler, and where does time come from.**

The claim: **pronto's event surface is not too small, it is asymmetric.** Data
subscriptions are declared in markup and are the best thing in the terminal.
Everything else that can wake an app — a click, a drop, a beat — is either
spelled as a write or not spelled at all. Closing that asymmetry needs one new
attribute family and no new concepts.

## Facts not to re-derive

Measured in this tree on 2026-08-27, not recalled.

- `screen.js:609` — "Stage-4's only handler event source: DOM drags become
  `{type:"move", fromId, toId}` against `{items: [{id, position}]}` read from
  the region's current rows in DOM order; the handler's
  `{updates: [{id, patch}]}` apply as ordinary update mutations." The wiring
  only happens when the item template contains `[data-drag-handle]`.
- `terminal.cue:105` — a Jessie handler is "evaluated in a compartment with
  nothing endowed, like handler and adapter". No `document`, no `globalThis`,
  no `fetch`, **no timers**.
- `screen.js:688` — "Item nodes persist across refreshes, keyed by row id… and
  only its bindings are patched — rebuilding the list instead costs all four,
  and leaves no node alive long enough for an enter or exit animation to play
  on."
- `terminal-doctrine.md:105` — "The gap Elm points at is subscriptions… Pronto
  has this for **data only, in markup** (`data-live` is a declared
  subscription, which is genuinely elegant) and imperative ad-hoc everything
  else: `store.subscribe` in closures, the `navigate` listener, retry timers,
  drag handlers. That asymmetry is the most concrete thing this comparison
  surfaced."
- `apps/realworld/shell/screens/feed-older.html:62` — a row-shaped click is
  already first-class, spelled as a form: a `data-live` probe switches between
  a `favorite` and an `unfavorite` form, the button lives inside the row, and
  the number beside it is a live query over `article_stats`. The click writes;
  the count is derived.
- `apps/truco` declares `hatches: {}` and `handlers: []`, and its
  `decision-14` reads "escape hatches: none… the dealer is app code at the
  terminal tier". Its `arena.html` is 301 lines of markup and **978 lines of
  inline script**, which is therefore neither Jessie nor compartmented: it
  holds `globalThis`, `document`, `setTimeout`, `matchMedia` and
  `location.search`.

## The problem

A card game is the smallest app that breaks the current event surface. It is
tap-driven, not drag-driven; its opponent must act a beat after you do; and a
hand resolves on a timer rather than on an input. None of that fits
`{type:"move", fromId, toId}`, so all 978 lines of it live outside the
contract — outside Jessie, outside the compartment, and outside everything the
ir/program bijection can check. The app ships design rationale for every state,
flow and decision it has, and none at all for its actual game.

## What is already solved, and what its spelling is

**A click on a row is not missing.** Realworld's counter is the worked example:
the button sits inside the row, a `<form>` carries the write, hidden inputs
bind `{id}`, and two forms are switched by a probe region. It is declarative,
row-scoped, and lints against a declared flow.

So `data-on-click` would be a second way to say something the platform already
says well, and the first way is better: a form names the entity and the action,
which `check-bijection` can verify against the ir. **Writes stay forms.**

The second half of that example matters as much. The count next to the heart is
not computed by the click — it is a live query. Most of what looks like "the
engine must react to an event" is "the consequence is derived", and the
derivation belongs to `db-ivm`, not to a handler.

## What is missing is time

Strip out the writes that forms already carry and the state that live queries
already maintain, and one thing is left that no markup in this tree can say:
**a beat passed.**

It is not a small remainder. It is the tell that lands before the call, the
pause before the house answers, the deferred close of a trick. And it is
structural rather than cosmetic: **a handler evaluated with nothing endowed has
no clock.** It cannot call `setTimeout`; that is ambient authority it was
deliberately denied. So a compartmented handler can only learn that time passed
if the terminal tells it.

This is why the clock is not a nicety alongside the event work. It is the thing
that makes confinement possible at all.

## The clock is CSS, and it already exists

CSS animations fire real DOM events — `animationstart`, `animationiteration`,
`animationend` — and transitions fire `transitionend`. An animation with a
known duration is a declarative timer whose duration lives in the stylesheet,
beside the motion it belongs to. An infinite animation's `animationiteration`
is a repeating tick.

That is a better fit for this platform than a timer attribute would be. The
duration is already where a designer edits it, the subscription is declared
rather than opened in a closure, and the terminal keeps the one decision that
should not be an app's: what a tick means when the tab is in the background.

## The spelling: borrow the DOM's names

```html
<div class="play" data-live="round" data-handler="beat" data-on="animationend">
```

Or, when an element wants more than one:

```html
<div data-on-animationend="beat" data-on-transitionend="settle">
```

`data-on-<dom-event>="<declared handler>"`. The event name is the DOM's, so
there is no invented vocabulary to learn or to keep an allow-list for; the
validity check is "is this a DOM event name, and is that handler declared".
Multiple events are multiple attributes, so there is no mini-language to parse.
It sits in the same shape as `data-live`, `data-form` and `data-handler`: an
attribute that **names a declared thing**.

**Not inline DOM handlers.** `onanimationend="beat(event)"` borrows the same
name and would work today — nothing blocks inline script here, and the truco
dealer is already inline. It is still the wrong trade, for two reasons that are
the two properties the platform is built on. The value stops being a
declaration: you cannot tell from the assembly what it listens to, what it
writes, or whether the handler it names exists, and the lint story for the whole
event surface goes with it. And the value stops being a reduce: an inline
attribute takes a DOM `Event` and may do anything, which is precisely the
"imperative ad-hoc everything else" the doctrine names as the disease. The
difference between the two spellings is one character of intent — a reference
instead of a body — and it is the whole difference between assembly you can
lint and assembly you cannot.

Neither objection is about safety. Jessie in a compartment with nothing
endowed cannot escape anything; confinement was never the argument.

## What the handler receives, and what it returns

Unchanged in shape from the drag reduce, which is the point:

- **In:** `{type, id, items}` — the DOM event's name as `type`, the row the
  event landed on (absent for a region-level event such as a tick), and the
  region's current rows. Never a DOM `Event`, never a node. A handler stays
  testable with no DOM.
- **Out:** `{updates: [{entity, id, patch}]}`, where `entity` is optional and
  defaults to the region's own collection — the drag's case.

**Inserts are not needed, and asking for them is usually a sign of a misplaced
write.** An append is nearly always an update seen from the child's side: truco
closes a trick with a single update to the round the plays belong to
(`advance-round`), and scores a hand with a single update to the match
(`score-hand`). The rows themselves were appended by the form that caused them.
That is the division worth keeping: **forms create, handlers conclude.** A form
states a write it can name in advance; a handler reduces over rows and writes
what only the rows can say. Granting handlers `create` would let a reduce grow
the store without any declared flow to check it against, and buys nothing that
an addressed update does not already give.

What the address does buy is the parent. A reduce over one region's rows
routinely concludes about the row those rows belong to, and without `entity` it
could only ever write back into its own collection.

## The edges, and one that is already live

- **Reduced motion would collapse the clock.** `apps/truco/shell/shared/table.css`
  sweeps `animation-duration: 1ms !important` and `animation-iteration-count: 1
  !important` over `.screen *` under `prefers-reduced-motion`. A beat driven by
  an animation would fire in about a millisecond, and an iteration tick would
  fire once — the game would run at infinite speed for exactly the users who
  asked for calm. A clock animation must be exempt from that sweep, or the
  sweep must scope itself to decorative animations. This is the strongest
  argument for the terminal owning the tick rather than each app rolling one.
- **Background tabs throttle animations**, so the clock stops. For a card game
  that is arguably correct — the table waits — but it must be a decision the
  terminal states, not a surprise each app discovers.
- **No animation events fire on a `display: none` element.** The tick must be
  attached to something rendered.
- **It is a beat, not a metronome.** Adequate for a table that waits on people;
  wrong for anything that needs real accuracy.

## What this unlocks

The prize is not a smaller dealer. It is a dealer that can cross the
compartment boundary at all:

1. `data-on-*` gives a confined handler a way to hear that time passed.
2. The dealer becomes a Jessie handler evaluated with nothing endowed — the
   same logic, now linted and reviewable rather than opaque page script.
3. Its derived half dissolves into live queries: whose turn it is, whether a
   card may be played, a trick's verdict, the legal next rung. All are pure
   functions of rows, and `db-ivm` is already compiled into the client.
4. What remains is a persona policy function, which is exactly the kind of
   thing a compartment should hold.

Step 1 stands alone. Steps 2 and 3 need only the addressed update above, not a
new verb.

## What this does not solve

Randomness. A shuffle needs entropy, a compartment with nothing endowed has
none, and a seeded replay needs the seed to arrive from outside. That is a third
endowment question and this doc does not answer it.

## Rules worth carrying

- **Forms create, handlers conclude.** A form states a write it can name in
  advance; a handler reduces over rows and writes what only the rows can say. A
  row-shaped click is already spelled as a form; do not invent a second
  spelling for it.
- **An insert is usually an update on the parent.** Reach for the parent's row
  before reaching for a new verb.
- **Consequences are derived.** Before reaching for an event, ask whether the
  thing you want to update is a query over rows. Usually it is.
- **Borrow the DOM's event names; keep the value a reference.** The event name
  is not the platform's to invent, and the handler body is not the markup's to
  hold.
- **A compartment with nothing endowed has no clock.** Anything time-shaped must
  arrive as an event, which makes the tick a platform concern rather than an
  app's.
