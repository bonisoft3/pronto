---
type: decision
title: Review by consequence
description: Levies ir coverage by what a write reaches — an update to a `tab` entity machine-checked only, one reaching `device` or above owing an ir element — with each handler declaring what it may write, where today every program object owes one.
status: unbuilt
---

# Review by consequence

The ir↔program bijection is total: every program object of the eleven compared
kinds owes an ir element a reviewer signs, and both directions are errors
([SPEC](../../SPEC.md#programcue)). This record levies that
coverage by consequence instead, and none of it is built.

## Checkable and reviewable are different budgets

Two obligations are spelled as one:

- **Checkable** is cheap, mechanical and should stay total. Declaring a
  screen's messages, or the entities a handler may write, costs generation and
  buys exhaustiveness, and no person reads it.
- **Reviewable** is expensive and human, and should be earned. An ir section
  exists so a design object ships with rationale someone agreed to.

One budget for both taxes a toggle at the price of a schema, and it is
regressive: the more awkward a thing is to declare, the stronger the pull to
put it where nothing looks, such as a game's whole dealer in page script,
outside Jessie, a compartment and the bijection. Total coverage does not
produce total review; it produces one large hole.

## The unit is the write

A handler is neither durable nor ephemeral; its updates are. An update names
its entity and the entity names its durability, so the classification is
already in the data:

- an update to a `tab` entity is machine-checked only;
- an update reaching `device` or above owes ir coverage.

Exempting per-tab *state* instead would exempt a per-tab brain holding a whole
game, by construction. Making the rule static needs the symmetry forms already
have, a declaration of what a handler may write:

```html
<ul data-live="play" data-rows="closevaza" data-writes="round">
```

Lint derives the coverage from those entities' durabilities; the terminal
refuses an update to an entity the handler never named, a capability that
suits a compartment with nothing endowed; and a reviewer sees a handler's
reach without reading its Jessie.

## Reach, not lifetime

The ladder orders by lifetime. Review asks who can be surprised:

| where | who sees it | survives |
|---|---|---|
| memory, `sessionStorage` | this tab | navigation |
| **the URL** | **anyone the link is given to** | **nothing** |
| `localStorage`, IndexedDB | the user's other tabs, later sessions | restart |
| PostgreSQL | everyone, subject to policy | always |

The URL is minimal in durability and unbounded in reach: `?seed=` fixes every
draw the terminal makes, so a shared link replays a whole deal, and a rule
scoped by durability alone would exempt the most shareable state an app has.
Coverage reads durability and visibility as separate axes, and the URL is why
they stay separate.

## Durability is a dial

Promoting an entity a rung is one word of program: either the checks that now
apply pass or they say what is missing, and if it takes a rewrite the ladder is
wrong. Multiplayer is the limit case: a game's entities become `server`, a
hidden hand needs a policy, and full coverage returns because consequence
arrived. Durability sets the floor, and an app may build above it: full
rationale for a tab-only game is a choice, not a tax.

## Not built

`objects.ts` compares every kind with no exemption by durability, and
`surface.handlers` is `{ir, of, src, note}`: no handler declares a write set,
so nothing can classify its writes.

## Rejected

- **One review budget for everything** — it taxes the trivial like the
  consequential and drives the awkward out of sight.
- **Exempting review by the durability of state** — a per-tab brain holding a
  whole game would be exempt by construction; the write is the unit.
