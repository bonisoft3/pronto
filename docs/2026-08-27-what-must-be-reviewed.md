# What must be reviewed, and what merely has to check

Davi's call, from the truco dealer migration and the event proposals that came
out of it. `2026-08-02-incremental-model.md` establishes the durability axis;
this doc uses it to bound something the ladder currently applies uniformly.

The claim: **the ir↔program bijection is total, and should not be.** Coverage
should be levied by consequence, exactly as that doc already argues screen
states should be: "which states a screen must handle should fall out of the
durability it declared, rather than being a fixed set every screen pays for."
The same sentence, one rung up, is this doc.

## Facts not to re-derive

Measured in this tree on 2026-08-27.

- `program.cue`'s own header: "Nobody reviews this; it must merely be
  checkable — cue vet, the ir bijection, and the emitted surface are the
  contract." The program is already declared unreviewed, and the bijection
  still forces it to carry a reviewed counterpart for every object.
- `check-bijection` refuses any program object with no ir section, in both
  directions. In this session it refused a state, two flows and a decision
  before they were written up — correctly, and at a cost that is the subject
  of this doc.
- Every entity in every app today is `tab`, `crud` or `live`. The ladder's
  middle rungs — `device`, `offline` — are written down and unused.
- Forms declare what they write (`{id, entity, action}`) and lint against a
  declared flow. **Handlers declare nothing**; their targets are computed.
- `apps/truco` writes nothing above `tab`, and carries ir rationale for every
  state, flow and decision it has.
- It reads `?seed=` and `?storybook` out of `location.search` in page script,
  declared nowhere. `?seed=` determines the entire deal.

## Checkable and reviewable are different budgets

Two obligations are currently spelled as one:

- **Checkable** is cheap, mechanical and should stay total. Declaring a
  screen's message set, or which entities a handler may write, costs
  generation and buys exhaustiveness — no human reads it.
- **Reviewable** is expensive, human, and should be levied by consequence. An
  ir section exists so a design object ships with rationale someone agreed to.

Forcing them to be the same set taxes a UI toggle at the price of a schema.
Worse, it is regressive: the more awkward a thing is to declare, the stronger
the incentive to put it somewhere unreviewed instead — which is exactly how a
1,016-line dealer came to hold the whole of a game, outside Jessie, outside a
compartment, and outside everything the bijection can see. **Total coverage
did not produce total review; it produced one enormous hole.**

## The unit is the write, not the state and not the handler

A handler is neither durable nor ephemeral; its updates are. An update names
its entity, and an entity names its path, so the classification already exists
in the data:

- an update targeting `tab` → machine-checked only
- an update targeting `device` and above → ir coverage required

**Classify the write, never the state.** If per-tab *state* were exempt,
`globalThis.__truco` — a per-tab brain holding an entire game — would be exempt
by construction, and that is the hole this rule is meant to close, not open.

To make that static, handlers need the symmetry forms already have: a
declaration of what they may write.

```html
<ul data-live="play" data-rows="closevaza" data-writes="round">
```

Three things follow from one attribute. Lint derives the coverage requirement
from those entities' paths. The terminal enforces the declaration by refusing
an update to an entity the handler never named — capability-shaped, which
suits a compartment with nothing endowed. And a reviewer can see a handler's
blast radius without reading its Jessie.

## Reach is the axis, and the URL proves it

The ladder orders by lifetime. The question review actually asks is **who can
be surprised**, and those orderings differ. Ordered by reach:

| where | who sees it | survives |
|---|---|---|
| memory, `sessionStorage` | this tab | navigation |
| **the URL** | **anyone the link is given to** | **nothing** |
| `localStorage`, IndexedDB | the user's other tabs, later sessions | restart |
| Postgres | everyone, subject to policy | always |

The URL is minimal in durability and unbounded in reach, so a rule scoped by
durability alone would exempt the most shareable state an app has. In truco
that state is `?seed=`, which fixes the entire deal and is read by page script
that declares nothing — the single most transferable input in the app is also
its least accounted-for. (`localStorage` is per-origin, incidentally, not per
window: anything in it is already visible to the user's other tabs and outlives
the session, which puts it above the line on both axes.)

So the pair the incremental-model doc asks for — durability *and* visibility,
separately spelled — is what coverage should read, and the URL is the case that
makes keeping them separate unavoidable.

## Durability must be a dial, and that is the acceptance test

The ladder's promise is that a rung is a declaration and nothing else changes:
"another input node in the same graph, entered through the same door." That
promise is testable, cheaply, without building anything:

**Promote truco's `Match` from `tab` to `device`.** The game you were playing
should still be there tomorrow — a real feature, one word of program, and then
either the checks that now apply pass, or they say what is missing. Whatever
that exercise breaks is the ladder failing its own promise, and is worth more
than any argument in this doc.

Multiplayer is the limit case of the same test. `Match`, `Round` and `Play`
become `crud`; the house's hand stops being "private by construction, since the
client holds everything anyway" and becomes genuinely private, with a policy to
write; the dealer stops being an agent in the client. Full coverage returns,
correctly, because consequence arrived. If that transition is a rewrite rather
than a change of declaration, the ladder is wrong — and it is better to learn
that from a thought experiment than from a migration.

## Rules worth carrying

- **Levy review by consequence, and checking by default.** Cheap and
  mechanical should be total; expensive and human should be earned.
- **Classify the write, not the state and not the handler.** Durable
  conclusions drawn from ephemeral state are still durable.
- **Reach, not lifetime.** The URL outranks the database on who can see it and
  loses to memory on how long it lasts.
- **Durability sets the floor; an app may build above it.** Truco keeping full
  rationale for a tab-only game is a legitimate choice, not a tax the platform
  should impose.
