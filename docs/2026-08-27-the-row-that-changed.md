# The row that changed, and the step after

Written from the apps/truco dealer migration, from what the detour through CSS
took to build. `2026-08-27-events-and-the-clock.md` proposes the DOM-event
family and the clock; this doc is the correction that fell out of using them.
`2026-08-02-terminal-doctrine.md` and `-incremental-model.md` are the ground.

The claim: **the terminal already knows the moment a row changed, and hands
that knowledge to nobody.** Everything an app does to recover it — a
MutationObserver, a manufactured animation, a write bounced through a
collection to make an event happen — is a detour around a fact the renderer
held all along.

## Facts not to re-derive

Measured in this tree on 2026-08-27, not recalled.

- `screen.js:796` — `currentRows = rows`. One assignment, in the region's
  refresh, before a single attribute is patched. The terminal knows which rows
  a region now has and, by `screen.js:688`, which item node each one owns.
- **A DOM update fires no event.** There is no `attributechange`. Changing
  text or an attribute notifies nothing; the only declarative way to turn a
  render into an event is to start or end a CSS animation or transition. Every
  other route is JS: `MutationObserver`, or a custom element's
  `observedAttributes` + `attributeChangedCallback`.
- `apps/truco` carries **two MutationObservers** after its migration — one
  keeping the hand's playability in step with the terminal's rendering, one
  waiting for the round to state a verdict. Both exist only to learn what the
  terminal just did.
- `terminal.cue:105` — a handler is "evaluated in a compartment with nothing
  endowed". No timers, no DOM, no store handle.
- `terminal-doctrine.md:100` — "the cure for `reduce` feeling Redux-ish is
  putting the command in the return, not abandoning reduction", and `:105` —
  the subscriptions gap: declared for data in markup, imperative ad-hoc for
  everything else.

## The problem, stated exactly

A handler concludes something and writes it. Whatever must happen next —
the dealer reading a verdict, a second fold, the table saying a word — needs
to know the write landed. The store is reactive and the DOM re-renders, and
then nothing happens, because a re-render is silent.

Three ways out, and two of them are detours:

1. **Observe the DOM.** Works, and truco does it twice. But by the time an
   observer fires, the DOM has settled and the row that caused it has to be
   reconstructed by reading attributes back out — the reduce is handed a
   reconstruction rather than the fact.
2. **Manufacture an event.** Arrange CSS so the change starts an animation
   whose end you listen for. Also works — the beat does exactly this — but it
   puts control flow in a stylesheet. A `@keyframes` nested inside a style
   rule is dropped by CSS nesting, silently, and the program simply stops. That
   is not a hypothetical; it cost a debugging session in this tree.
3. **Hand it over.** The renderer calls the handler with the rows it just
   applied.

## The hook belongs at the patch site

Only the third is honest, because the terminal is the renderer. It does not
need to observe a DOM it wrote; it needs to say so.

The event is a **data** event and must be named as one. The DOM-event family
from the companion doc borrows the DOM's names because those events are the
DOM's; this one is the store's, and calling it `data-on-change` would be
borrowing the wrong vocabulary. It is the reaction half of the subscription
`data-live` already declares:

```html
<ul data-live="play" data-filter="round_id=eq.{id}" data-rows="closevaza">
```

`data-rows="<declared handler>"`: when this region's rows change, reduce them.
Same contract as every other handler — `{type: "rows", items}` in, `{updates}`
out, nothing endowed — and it retires both of truco's observers.

It is also better on the two counts the CSS bounce is worst at. The reduce is
handed the snapshot the terminal just applied rather than whatever the DOM
settled into, so there is no window in which the two disagree; and there is no
intermediate write whose only purpose was to make an event happen.

## The step after, and why it is bounded

A hook makes cascades cheap, which makes runaway cascades cheap too:
handler → update → rows change → handler. Nothing in the loop stops.

So the command goes in the return, as the doctrine already says it should:

```js
{ updates: [...], then: { type: "settle", delay: 700 } }
```

`then` is not an effect. It is the next event, which the terminal delivers to
the same handler after applying the writes — optionally after a delay, which
is how a compartment with no clock asks for one without being given one. The
terminal owns the depth, so a cycle is bounded once, centrally, rather than
each app discovering its own.

That is the whole vocabulary. A handler still cannot reach anything: it names
rows to write and, at most, the next thing to consider.

## Mapped to Elm

The correspondence is close, and the places it breaks are the interesting ones.

| TEA | here |
| --- | --- |
| `update : Msg -> Model -> (Model, Cmd Msg)` | the reduce: `(state, event) -> {updates, then}` |
| `Cmd Msg` | `then` — the next event, delivered by the terminal |
| `subscriptions : Model -> Sub Msg` | `data-live` (what to hear) + `data-rows` (what to do) |
| `view : Model -> Html Msg` | assembly — data, not a function |

Three divergences, all deliberate and worth naming:

**The view is data.** Elm's `view` is a pure function, which is what makes its
virtual DOM possible; pronto chose assembly so the artifact can be served and
linted. The keyed reconciliation in `screen.js` is the bill for that choice,
and it is already paid.

**The model has many writers.** TEA has exactly one funnel — `update` — which
is why it needs no hook at all: a program that changed the model already knows
it changed. Here the store is written by forms, by handlers, and by sync, so
no single caller knows. That is precisely why the transition has to be
published, and why `then` has to be bounded: TEA gets termination free from
having one writer and a view that cannot write, and we do not.

**Subscriptions are declared in markup, not derived from state.** Elm asks the
model what it wants to hear; we ask the assembly. The gap shows: truco wants
to hear the clock *only while a trick is closing*, and spells that as an
attribute the dealer sets, which switches a CSS animation on. That attribute is
a hand-rolled `subscriptions : Model -> Sub Msg`, and it is the honest reading
of what `data-closing` is. Closing that gap properly — a subscription whose
predicate is a query — is a later doc.

## What this retires

- Truco's two MutationObservers, which exist only to learn what the terminal
  just did.
- The CSS bounce for *data* transitions. The clock keeps its narrow job:
  beats that are genuinely about motion and time, where the duration belongs
  in the stylesheet beside the thing it animates.
- The argument that a compartment cannot continue a computation. It can: it
  returns the next event, and the terminal delivers it.

## Rules worth carrying

- **Publish the transition, do not observe it.** A renderer that watches its
  own output is recovering a fact it had.
- **Name a data event after the data.** The DOM's names are for the DOM's
  events; the store's changes are not the DOM's.
- **The command goes in the return, and the terminal bounds it.** A cascade
  with no owner is a cascade with no end.
- **One writer is what makes TEA safe.** Anything with many writers has to
  publish its transitions and bound its cycles, and should expect to pay for
  both.
