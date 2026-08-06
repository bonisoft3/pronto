# The virtual terminal: doctrine handover

A conversation reached a working definition of the virtual terminal by asking
why the virtual cluster reads as a mature product and the terminal does not.
This is where it got to, what is load-bearing, and what is still open. It is
written for someone picking the thread up cold.

## The question

`libraries/mecha` has opinions and a story. `plugins/omnishell` is patchy.
Both are the same age and the same authorship. Why?

## The diagnosis

The cluster has **one substrate**. Everything is postgres or a thing that
reads and writes postgres, and the profiles (crud → sync → cdc → stream → ai →
blobs) are additive layers on that one idea. It **borrows** its languages —
SQL, bloblang, Caddyfile, compose, PostgREST — so its own surface is only the
composition. Its seams are **protocols**, which forces boundaries rather than
leaving them to taste. And it was shaped by things breaking: the CDC feedback
loop, the publication scoping, txid confirmation.

The terminal has nine concerns and no substrate — router, renderer, form
engine, data binder, state machine, motion system, widget host, sandbox,
fixture harness. It **invents** where the cluster borrows (`data-live`,
`data-item`, `data-text` have no prior art), and the parts that feel solid are
exactly the borrowed ones: PostgREST filter syntax inside `data-filter`, Zag's
own `data-part`, CSS custom properties, SES from the ocap tradition.

The structural cause, which is the useful part:

> **The cluster can afford to be small because its escape hatch is unbounded.**
> "Add a container" absorbs everything mecha declines to be. The terminal has
> no relief valve, so every unmet need becomes a core feature.

That is not a discipline failure. It is the predictable output of a platform
that cannot say no. Build the hatch before adding vocabulary.

## The doctrine, current form

> **The terminal is a host. It owns what cannot be federated, and it mounts
> units into boxes.**

**Surfaces**

- **Collections** — all state, including the session and the route. Read-only
  where a unit should not write. This is the data interface every unit
  receives; it is not an invented abstraction, it already exists.
- **Markup** — slots. The element carrying `data-widget` or `data-island`
  *is* the slot; nothing new is needed. Loading policy would be another
  attribute on the same element.
- **Returned requests** — Jessie's effect channel. A role returns a
  description; the host performs it.
- **A capability object** — hatches only, and see the open question below.

**Units**, one ladder, differing only in authority received and whether they
bring their own build:

| unit | receives | own build |
|---|---|---|
| island | its arguments, nothing else | no |
| widget | collections through an adapter | no |
| region | collections, its filter | no |
| screen | collections, params, capabilities | no |
| hatch | collections, capabilities | yes |

**Languages**

- **CUE** declares what exists — entities, screens, routes, access, design.
- **Jessie** maps between vocabularies — the island reduce, the adapter, and
  the merge policy nobody has written.

Everything else is **assembly**: the HTML and CSS a unit renders.

**Not hostable**, and this is verified rather than asserted: the durable
outbox (leader-elected per origin through Web Locks — two of them means one
wins and the other's writes silently stop being durable) and the shape
connections (one connection budget per origin). Everything else is handed in.

Consequence worth keeping: **the tiers are one interface with three adapters.**
The fixture tier is the host with fixture collections, the browser tier with
PGlite collections, the cluster tier with Electric collections.
`@mecha/collections` already takes an adapter and already has two.

## What Elm contributed

`update : Msg -> Model -> ( Model, Cmd Msg )`.

**"Returned requests" is `Cmd`.** It is not a workaround for a sandbox; it is
the mechanism that lets Elm promise no runtime exceptions. Calling it a
*command* removes most of the strangeness.

**Elm's escape hatch is message-based.** Ports send and receive values; the
program never holds a JavaScript object. That argues the hatch should get a
**channel**, not handles — which also makes it relocatable to a worker or
iframe without changing its code, and versionable in a way a passed object is
not. The cost is that everything becomes async.

**The Redux resemblance is ancestry.** Redux descends from TEA. The difference
is that Elm has effects **in the return type** while Redux bolts them on
through middleware — which is where all of Redux's weight comes from. So the
cure for `reduce` feeling Redux-ish is putting the command in the return, not
abandoning reduction.

**The gap Elm points at is subscriptions.** `subscriptions : Model -> Sub Msg`
— a program declares, from its state, what it wants to hear. Pronto has this
for **data only, in markup** (`data-live` is a declared subscription, which is
genuinely elegant) and imperative ad-hoc everything else: `store.subscribe` in
closures, the `navigate` listener, retry timers, drag handlers. That asymmetry
is the most concrete thing this comparison surfaced.

**A deliberate fork:** Elm's `view : Model -> Html Msg` is a pure function,
which is what makes its virtual DOM possible. Pronto chose **assembly** so the
artifact is data you can serve and lint. Defensible, but it means pronto can
never have Elm's view guarantees — the keyed-reconciliation work was paying
that bill.

**And a caveat:** Elm has the same bounded-core-narrow-hatch problem, and
reaching for ports is its community's most persistent complaint. It validates
the shape *and* demonstrates the failure mode.

## Why the cluster is fine

Fine, not finished. Its coherence is not threatened by its gaps, which is the
difference. Known and open: schema evolution is declared in SPEC and unbuilt;
there is no server-side multi-row atomicity (a client transaction is one outbox
entry, but the writes are N independent PostgREST calls, so postgres never sees
them as one); presence has no home; and CEL is declared on every invariant and
evaluated by nothing, so the client half of every constraint is dead.

## Real, designed, speculated

Do not confuse these.

**Real, in code and tested:** collections with an adapter seam
(`@mecha/collections`, two adapters); Jessie roles `island` and `adapter`, both
evaluated in SES compartments with no endowments; the widget tier (a generic
Zag dispatcher plus a pure adapter, ~60 lines of omnishell); keyed
reconciliation; the navigation stack on the Navigation API with push-versus-
traverse scroll semantics; the motion vocabulary; design tokens compiled from
the program with a lint refusing redeclaration; the bijection checker.

**Designed, not built:** the hatch's worker and compartment boundaries (the
iframe one is built — `interpreter/hatch.js`, `capabilities.hatch`); the
capability object, which an opaque-origin unit is granted nothing of; slots
as a loading policy; the local-only collection adapter; a merge-policy role;
subscriptions as a general form.

**Speculated:** adopting single-spa (measured at 8 KB gzipped, indivisible, not
adopted); channel-versus-object for the hatch; screen-level versus region-level
hatch — leaning region, because the widget tier already built the mount point,
the adapter bridge and the form participation, so a region hatch is that
machinery with the code coming from a bundle instead of an import.

## Open questions

1. ~~**Channel or object for the hatch?**~~ Resolved as neither, and built for
   the iframe boundary: props in are a current-value feed, events out are named
   and request-shaped. See `2026-08-02-terminal-hatch.md` §Q1.
2. **Is "returned requests" right for every Jessie role**, or only the pure
   mapping ones?
3. **Do subscriptions generalise** from `data-live` to timers, keyboard,
   presence — and does that stay in markup?
4. **Is there a Msg equivalent** — a closed vocabulary of what a unit may
   emit? That is what a contribution manifest would be.
5. **What does a merge-policy role receive?** TanStack DB has no conflict
   resolution, but it does track `rowOrigins` and `preSyncVisibleState`, which
   is the raw material without the policy.
6. **Where does presence live?** Shared but not durable — neither side owns
   that quadrant today.

## Facts not to re-derive

- TanStack DB has **optimistic writes with rollback, not conflict resolution**
  (`onConflict`, `mergeStrategy`, `rebase`: zero hits in the bundle).
- A transaction **can** carry many mutations — `mutate(callback)` collects
  every collection mutation made inside it. mecha's handlers read
  `transaction.mutations[0]` and discard the rest, so the one-row limit is
  mecha's, not TanStack's.
- bun **cannot resolve remote imports at all** (reads the URL as a file path);
  deno resolves and caches them.
- `guis/iris` is pnpm through the root workspace and imports only the
  Playwright subpaths; `guis/snapcards` is bun and imports the auth half, the
  eslint rules, and eleven of the twelve mecha packages as `workspace:*`. So
  mecha cannot move to deno without breaking snapcards.
- `plugins/omnishell/interpreter` has **no package importers** — `terminal.cue`
  mounts it as statics. That is why it is the one piece that can move freely.
- `WebAuthnAdapter`, `tailwind-preset.ts` and `lint/css/tokens.css` have zero
  importers.

## Pointers

`plugins/omnishell/terminal.cue` (the published contract),
`plugins/omnishell/interpreter/` (the implementation),
`plugins/pronto/{schema.cue,emit.cue,SPEC.md,prelude.md}`,
`libraries/mecha/cluster.cue`,
`plugins/pronto/docs/2026-08-01-visual-lint.md`.

Branches: `docs/pronto-design` carries the platform work and thenote;
`chore/omnishell-mecha-deno` carries the interpreter's move to deno and an
unfinished attempt to publish the terminal's motion vocabulary as data — whose
central claim (that the stylesheet cannot name an unpublished slot) is
**false as it stands**: `--motion-ease` and `--motion-shift` are still
hard-coded in the rule templates, and `#MotionCue.slot` is an open `string`.
