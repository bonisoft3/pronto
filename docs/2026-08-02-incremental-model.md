# The incremental model: one graph, two tiers

Written alongside the realworld/Conduit compile, from questions that compile
raised. `2026-08-02-terminal-doctrine.md` and `-hatch.md` establish the role
vocabulary; this doc supplies the semantics under it, and the reading list for
where that semantics is already worked out.

The claim: **TEA gave pronto its vocabulary and cannot give it its
semantics.** `view`, `Cmd`, `Sub` name the roles well, and the terminal-hatch
doc already reads the island role as `Cmd` correctly. But TEA is silent on
*when to recompute*, and that silence is where every open question in the
terminal actually lives. Incremental computation — self-adjusting computation
on the UI side, incremental view maintenance on the data side — is the theory
that answers it, and it answers both tiers with one model.

## Facts not to re-derive

Measured in this tree on 2026-08-02, not recalled:

- `@tanstack/db` depends on **`@tanstack/db-ivm`**, whose own description is
  "Incremental View Maintenance for TanStack DB based on Differential
  Dataflow". Its operators are `map`, `filter`, `filterBy`, `join`, `count`,
  `distinct`, `reduce`, `concat`, `consolidate`; its only two dependencies are
  `fractional-indexing` and `sorted-btree`, which is the machinery for
  maintaining *ordered* and top-K results. It is compiled into
  `plugins/omnishell/interpreter/vendor/mecha-client.js`.
- The engine is entered through `createLiveQueryCollection`, which
  `@mecha/client` re-exports along with the predicate vocabulary. `data-crud.js`
  builds one view per distinct read and the region wakes on that view's own
  changes. *(When this doc was written none of that existed: every read was
  `toArray()` re-filtered and re-sorted on each wake, and `subscribeChanges`
  was handed a callback declaring no parameter, so the change set was
  discarded.)*
- `currentStateAsChanges` hands a collection's current contents *as* a change
  stream — measured returning `[{type:"insert",key,value}]`, the same shape a
  later change carries. It is the bootstrap primitive a dataflow sink needs,
  and it is still uncalled: first paint takes the reconsider-everything path.
- `embedTables()` recovers a region's dependency set by running a **regex over
  a PostgREST select string**. The stacked-hint defect fixed on 2026-08-02
  (`follow!followed_id!inner(` capturing `followed_id`, dropping `follow` from
  the dep set, leaving the feed silently deaf) is the failure mode a real
  dependency graph makes unrepresentable — dependencies would be edges
  discovered by reading, never parsed out of a string.

## The graph

```
form submit ──► collection (optimistic + outbox) ──► PostgREST ──► Postgres
                     ▲                                                │
                     └────────── Electric shape ◄──────────────── WAL ┘

collections ──► operators (map/filter/join/count) ──► derived collections
                                                            │
                                                      region sink ──► DOM
```

- **Postgres** is upstream of reads and downstream of writes. Both, not one.
- **TanStack DB collections** are the graph's *input nodes*, not a sink.
- **A remote write and a local optimistic write are indistinguishable at the
  input node.** That is the actual reason the model unifies: not that data and
  view share a theory, but that intent and truth converge on one input.
- **The region is the sink**, and it is ours.

The same shape repeats one tier down. A CDC pipeline is `update` for state no
single client owns: the bus is the message stream, bloblang is the pure
operator, and a pipeline's sink table is a materialised derived collection.
One graph, two tiers — which is what Electric Clojure means by titling its v3
work "Differential Dataflow for UI".

### Elm, mapped

| Elm | pronto |
|---|---|
| `Model` | the store — the *cluster's*, replicated, not client-owned |
| `Msg` | a form submit, or a shell event routed through a handler |
| `update` returning a new model | absent by design; the store is the model |
| `Cmd` | `{updates:[{id,patch}]}`, performed by the shell |
| `view` | screen markup + `data-*`, plus a renderer where markup cannot express a value |
| virtual DOM diff | the region sink |
| `Sub` | `data-live` — but static, see below |
| ports | the hatch |

Two divergences worth holding onto. **`Msg` is the platform's closed
vocabulary, not the app's** — create/update/delete/navigate against an entity,
plus drag. That single narrowing is where checkability comes from: a
deterministic checker can enumerate everything a screen can do. And a handler
returns only the `Cmd` half, never a model, because the model is a database it
does not own.

## The roles collapse to three

`renderer` and the proposed `derivation` are the same role. Both are pure
`map`s; the only difference is the output *type*, and that is a dispatch in the
sink — a scalar goes to `textContent`, a node description goes to `buildNodes`.
So:

- **derivation** — `map`. A value in, a value or a node description out.
- **adapter** — translation into a state machine the app does not own.
- **handler** — `Cmd`.

None holds state. Every kind of state has an owner that is not app code:
durable state the cluster's, interaction state the widget machine's, DOM state
the terminal's, foreign state a hatch's own document.

This also restates the markdown argument correctly. It is not "universal
formats belong to the platform", which is taste. It is: **the operator's body
is the app's choice; the sink's allowlist is the platform's.** Which is where
`render.js` independently landed.

## Durability is an axis, and `#Entity.path` is a partial spelling of it

Davi's framing, and the most useful design output of the session. Not every
mutation deserves a round trip; some state never leaves the tab. The answer is
not to make Jessie a state language — that reintroduces lifecycle, staleness
and ordering, the bug class removing DOM access eliminated. The answer is to
extend the existing axis *downward*:

| durability | lives in | survives | syncs | CDC | RLS |
|---|---|---|---|---|---|
| `tab` | in-memory collection | navigation | no | no | n/a |
| `device` | `localStorage` (measured 2026-08-27) | restart | no | no | n/a |
| `offline` | local + outbox | device loss | yes | yes | yes |
| `crud` | Postgres | always | yes | yes | yes |
| `live` | Postgres, pipeline-written | always | read-only | no | yes |

Nothing else changes. A tab-local entity is read by a `data-live` region,
mutated by a form, styled by CSS keyed on state — the identical vocabulary,
and **another input node in the same graph, entered through the same door.**
"Is this section expanded" becomes a `tab` singleton toggled by a form. That is
components-with-state without components, without `useState`, without a
lifecycle, and without a second data language.

**Durability and visibility are different axes** and today `path` and `access`
each half-express both. `crud` currently means *durable in Postgres* and
*shared subject to RLS*; a tab-local table is private by construction, with no
policy to write. Separated, the emitter derives everything mechanically from
the pair — table, migration, publication entry, RLS policy, outbox, shape
subscription — and a reviewer can see the cost someone chose, because
durability is monotonic in expense.

It also explains the state vocabulary: **the eight screen states are the tax
for a *remote* model.** A `tab` read is total and synchronous, so it has no
`loading`, no `gone`, no `network-error`. Which states a screen must handle
should fall out of the durability it declared, rather than being a fixed set
every screen pays for.

## The DOM sink is ours, and the delta is why

Full benchmark and method in
[`../../omnishell/docs/2026-08-02-reconciliation-libraries.md`](../../omnishell/docs/2026-08-02-reconciliation-libraries.md);
the conclusion belongs here.

**All three morphing libraries — morphdom, Idiomorph, Morphlex — key on the
`id` attribute. Pronto's rows carry `data-id`.** Without a real `id` all three
match rows *positionally*: the list displays in the correct order, every
state-survival flag reads clean, and a reader's half-written reply is now
attached to a different post. Measured, morphdom reversing a 20-row list:
**zero DOM operations, correct order, focus intact, draft intact, animation
intact, and every row's content rewritten onto a different node.** Nothing in
an operation count or a survival flag catches it.

The reason is structural, and it is the thesis paying out again: **because the
platform owns the data path it has a true key — the primary key.** A generic
HTML morpher must *infer* identity from the document, and inference is where
the silent corruption lives. So the valuable part of `screen.js` is not its
`moveBefore` call, it is the `live` Map keyed on `row.id`.

The ecosystem is full of tree-differs (morphdom, Idiomorph, Morphlex,
DeltaDOM, set-dom, diff-dom) and empty of delta-appliers, because almost
nothing else in a browser *has* a delta. **The delta is what makes a library
unnecessary, not what makes one possible.** Consuming it directly, given the
`live` Map already exists, is on the order of forty lines.

One carve-out survives, and it is real: **a body subtree has no delta.** When
a `map` fires, it emits a whole new node description against a whole old tree
— genuinely the two-trees problem, where node creation is ours and no keying
is involved. morphdom remains the right answer *there*, if body churn ever
justifies it: a live-preview editor, a streamed or generated body, comments
appended while read.

## First paint is not a special case

The initial load *is* a delta: every existing row arrives as `+1` at time
zero, which is exactly what `currentStateAsChanges` exists to produce. There is
no load mode and then a watch mode; one stream whose first message happens to
contain everything.

So opening an article: the screen mounts in `loading`; the collection becomes
ready and its contents arrive as `+1`; the markdown `map`'s input goes from
absent to present and fires **once**; the sink builds under the allowlist; the
state flips to `populated`. Today's code does the same by hand — a cold
`_prontoRendered` memo standing in for "this node has never fired".

Revisiting with `keep: 1` is where it pays: the input has not changed, so the
operator does not run and the body is never rebuilt. The reader's scroll and
selection survive **structurally**, rather than because a hand-written
`JSON.stringify` comparison happened to be right.

## SSR is a placement decision

Feasible, and most of the primitive exists. `storybook.js` already calls
`interpretScreen` against a fixture store with **no cluster, no PGlite and no
auth**, and the deno smokes already run the interpreter against linkedom. One
renderer that works in both places is normally the hard part of retrofitting
SSR; it is done and tested.

In the model, SSR moves the *first evaluation* of the graph to the server: the
same operators over the same rows, emitting the sink's output as HTML, with
the client resuming the same graph from that state. A different network cut for
the first frame, not a new mechanism — the same move as a derivation running
in a pipeline instead of a tab.

**Hydration is easy here for the exact reason the morphing libraries failed.**
React hydration mismatches hurt because there are no keys and the client must
match positionally. Pronto has real keys from data: hydration is adopting the
server's nodes into the `live` Map by `row.id`, and a newer client shape is a
delta to apply rather than a mismatch to reconcile.

Obstacles, honestly:

- **The auth gate kills the SEO half.** `required: true` gates every screen, so
  a crawler sees a login form. The payoff that matters needs anonymous read.
- **RLS makes cacheability follow the visibility axis.** `public-read` is
  cacheable across everyone; `owned` is cacheable for nobody.
- **It does not reduce JavaScript.** SSR moves content earlier, not
  interactivity; the client bundle still loads.

## What the model predicts is missing

Each of these surfaced as the realworld compile hitting a wall, not as
speculation. The workaround count is the metric — every CSS probe and extra tap
is the vocabulary naming what to add next.

1. **Anonymous read.** Blocks SSR's payoff and RealWorld's actual shape.
2. **`tab` / `device` durability.** Blocks app-authored frontend-only state;
   today the only honest home for a toggle is Postgres. Both tiers already have
   a factory in the vendored bundle — `localOnlyCollectionOptions` and
   `localStorageCollectionOptions`, exported from `@tanstack/db` — so what is
   missing is the emitter choosing between them, not the machinery. See
   [`../../omnishell/docs/2026-08-02-scaffold-salvage.md`](../../omnishell/docs/2026-08-02-scaffold-salvage.md).
3. **`Sub` as a role.** Elm's subscriptions are a *function of the model*;
   `data-live` is static markup, so a screen cannot subscribe to one post's
   comments only while it is expanded. This is also the principled home for the
   impurity handlers are rightly refused — timers, presence, keyboard — which
   is the terminal-doctrine doc's open Q3, and the queued lazy-shape follow-up.
4. **A `derivation` role reaching the graph.** Closes the whole "no computed
   values" gap at once: arithmetic, conditionals, relative time,
   pluralisation. "3 min read" and "2 days ago" are `map` bodies.
5. **Conditional rendering.** Faked with CSS `:empty` sibling probes, whose
   own flaw the compile flagged: the probe flashes on first paint. An
   imperative `if` would not. The constraint *created* that bug.
6. **Write-then-navigate.** No composite `Msg` constructor, so publishing costs
   a tap it should not.
7. **Multi-param routes.** One `:param` per route, so tag, search and
   profile-favorites cannot page at all.

Items 5–7 are the honest cost of the constraint: it pays where the vocabulary
covers the domain, and taxes where it does not. Mecha's vocabulary covers
nearly all of CRUD, so its constraint is almost free. The terminal's covers
less of the interaction domain — which is why there are three escape tiers, and
why this compile bent three times. The constraint is right; it is younger.

## Where this stands

The model is wired end to end and measured against the running cluster.

- **The graph is entered.** `@mecha/client` publishes
  `createLiveQueryCollection`, `liveQueryCollectionOptions` and the predicate
  vocabulary, all riding in `vendor/mecha-client.js`. A live query over
  `collections.article` filtered to one author preloads as 0 rows; an article
  written through `/crud` returns 201, Electric carries it to the base
  collection, and the maintained view emits `[{type:"insert"}]` carrying the
  row. Ordering is maintained too — a mid-sequence insert lands in place.
- **Reads that qualify are maintained views**, keyed by the read they stand
  for and refcounted, so the many nested regions sharing one enter the graph
  once between them (46 views on realworld's feed, 7 on an article). The
  view's own changes wake the region, computed by the engine against the
  actual query rather than guessed from a predicate over one table's raw
  change set.
- **The sink applies the delta.** A row the change set does not name keeps its
  node, its bindings and its nested regions. Skipping happens only when the
  pass can account for itself: a wake with no change set, or a change naming
  no row, reconsiders everything, because rendering stale is worse than
  spending a re-bind. Order still comes off the maintained array — the delta
  names rows, never positions.
- **A vanished singleton takes its output with it.** Bound attributes go back
  to *absent* rather than blank: restoring the template requests the literal
  `{image_url}` and blanking requests the page. `apps/realworld` can drop the
  `piece-probe` workaround it authored to get `gone` semantics.

What still reaches PostgREST, and why it is the right boundary rather than a
gap to close: full-text search, embed-path filters, `offset`, hinted and
nested embeds, `is.true`/`is.false` (a defaulted boolean is absent on an
unconfirmed optimistic row, which the snapshot predicate admits deliberately),
and any visibility a query cannot restate — a share, a parent chain, or an
embed of a table not everyone may read, since a left join has nowhere to put a
per-row visibility test.

Still open:

- Ordered comparisons (`lt`/`gt`/`gte`/`lte`) are exported but unused by the
  translator, so cursor routes like `/older/:when` still read through
  PostgREST. The snapshot predicate would compare raw column values, which is
  why this wants its own look rather than a line.
- `currentStateAsChanges()` is still unused: first paint takes the
  reconsider-everything path. Harmless, since first paint *is* a full pass,
  but it is the one place "first paint is not a special case" is not yet
  literally true.
- Ordering in a set-oriented engine. `fractional-indexing` and `sorted-btree`
  suggest db-ivm already carries the answer; unverified.
- Whether an LIS reorder pass is worth ~15 lines over our own `order` array.
  Not yet: 13 moves cost 0.1 ms at 20 rows and 0.9 ms at 200, and it has never
  appeared in a profile.

## Amendment: four bugs, one shape

Written after the realworld compile was QA'd live. Four defects surfaced in one
session, three of them by a person looking at the screen. They are the same
defect:

- **Mount before state.** `interpretScreen` connected the screen to the
  document, *then* interpolated params, *then* stamped `data-state`, then
  awaited three network round trips for handlers, adapters and renderers. For
  that whole window the page showed markup with no state attribute, so every
  `[data-state]` rule was inert — every region visible at once, links wearing
  the user-agent underline. Warm reloads hid it; cold loads did not.
- **The literal placeholder fetch.** The same connected-raw markup meant the
  browser requested `src="{image_url}"` as a relative URL. The visual battery
  reported it as `404 /shell/%7Bimage_url%7D`.
- **The ghost page.** Deleting an article left the article screen rendering the
  deleted article. `screen.js`'s vanished-singleton path sets `gone` when the
  screen declares it and `empty` otherwise, and **returns before re-binding** —
  so the last-rendered row stays in the DOM.
- **Sign-out.** Clearing the session rendered the door *beside* the still-mounted
  screen rather than in place of it, because the navigation stack appends.

Every one is **the DOM failing to be a function of the state**, and each was
produced by the same authoring order: put a template in the document, then
progressively correct it. The corrections are where the windows live.

An incremental sink inverts that order — compute, then connect — and the
inversion is what removes the class rather than the instances. The ghost page
is the sharpest illustration: it is precisely *a sink that kept the previous
delta's output after its input went empty.* In a region that applies deltas, a
removed row is a `-1` and its nodes go; there is no early return that can leave
stale output, because there is no "return" at all — there is an operator whose
input changed.

That is the strongest available argument for the model, and it is measured
rather than reasoned: the three fixes landed in `screen.js` this session are
each a hand-written approximation of "connect the result, not the template."

## Amendment: the terminal must declare its own checks

`plugins/omnishell/src/lint/playwright/` holds nine DOM checks —
theme-stability, focus-order, touch-targets, horizontal-overflow,
interactive-overlap, constrained-images, cls, console-messages,
viewport-bounds. `2026-08-01-visual-lint.md` records that **no emitted app is a
consumer**. By the prelude's own rule, a check no verb reaches does not exist.

Both runtimes declare their own checks, and each declaration carries the layer
it needs:

```cue
checks: [Name=string]: {verb: "lint" | "test" | "integrate", cmds: [...string], note: string}
```

`loop.cue` buckets them by verb and emits each into the matching rulemap, so a
runtime that declares nothing at a layer emits no key there and leaves the
app's builtin alone. mecha declares `caddy` at `lint`; omnishell declares
`visual` at `integrate`.

It *should* publish it, for the same reason it publishes `auth`, `text-formats`
and `widgets`: these nine checks are invariants **of the terminal's own
rendering surface**, not of any app. An app cannot be expected to re-derive
that tap targets have a minimum size or that absolutely-positioned chrome must
not cover flow content — and if each app did, each would get it differently,
which is the argument the prelude already makes about affordances.

### `lint` is the wrong verb for most of them, and that matters

The prelude is explicit that the layer follows from what a check *needs*:
`lint` for what fails in seconds without executing the app, `test` for
behaviour against fixtures with no live service, `integrate` for anything
needing the cluster up. A battery that measures a rendered page needs a
rendered page. So:

- **Fixture tier → `test`.** The storybook renders every screen × storyboard
  state against a fixture store with no cluster and no auth. That is a real
  rendering surface reachable without services, and it is the only surface
  where the *dark twin* and the rare states (`empty`, `gone`,
  `validation-error`) are all reachable on demand.
- **Live tier → `integrate`.** Real rows, real shape latency, real overlap
  under real content lengths.

Hence the battery runs at `integrate`, behind `docker compose up -d --wait
launch`, driven by `plugins/omnishell/check-visual.ts` under deno.

### Applicability turned out to be severity, not a per-rule annotation

Measured on the realworld app across 12 routes at two viewports. The first run
produced **216 findings and 20 of 24 route×viewport runs red**, from four
rules: `unconstrained-object-cover` 106, `touch-target-size` 104, `focus-order`
4, `no-interactive-overlap` 2.

Three of those four populations were the checks being wrong, not the app:

- **`unconstrained-object-cover` (106).** It walks three *ancestors* for an
  `aspect-ratio` and never reads the image's own box. `object-fit: cover` only
  crops unpredictably when the box ratio can move; `.avatar { width: 22px;
  height: 22px }` pins it. The discriminator is percentage versus absolute, and
  `computedStyleMap()` reports it exactly — computed values absolutize `em`
  but leave `%` alone — where `getComputedStyle` resolves everything to px and
  cannot tell them apart. The fixture that guards the rule is `width: 100%;
  height: 200px`, so "has both dimensions" would have silently disabled it.
- **`touch-target-size` (104).** The rule asks WCAG 2.5.5's AAA 44px. On a
  content surface every article title, byline and tag chip is sized by its line
  box and reports. At 2.5.8's AA 24px the population drops to 46, and those are
  real advice.
- **`no-interactive-overlap` (2), the two "criticals".** Both were false. The
  *"Yes, delete it permanently"* button sits inside a **collapsed
  `<details>`**, where Chrome keeps `display: block`, `visibility: visible`,
  `opacity: 1` and a non-zero box — so every hand-rolled visibility test passes
  while nothing is on screen, and `elementFromPoint` duly reports the body
  prose that genuinely occupies that space. `Element.checkVisibility()` returns
  `false` and is the only test that knows. The reader reaches the confirmation
  by opening the disclosure; there was never a bug.

So the lesson is not that a declaration must annotate where each rule applies.
It is that **severity already carries it**, once the rules stop lying:
`critical` gates, `major`/`minor` log. After the three fixes the battery reports
**48 findings, zero critical, gate green**, and its remaining output is honest
design advice rather than noise. `guis/snapcards` reached the same arrangement
independently at `tests/visual-lint.pw.ts`, and `guis/iris` reached it the
other way, by forking both broken checks rather than importing them — which is
the real evidence that they were broken.

The one thing a command-only declaration still cannot express is *coverage*: a
route whose `:param` never resolves is a hole, not a pass, so the driver emits
it as a finding rather than skipping quietly.

## Pointers

Prior art worth reading before re-deriving any of this. Self-adjusting
computation: Acar's work, realised as Jane Street's
[Incremental](https://blog.janestreet.com/introducing-incremental/) and
[Bonsai](https://github.com/janestreet/bonsai/) — whose
[Self Adjusting DOM](https://blog.janestreet.com/self-adjusting-dom/) post is
effectively the design document for the sink half, and whose `Bonsai_term`
proves the model is UI-surface-agnostic. Incremental view maintenance: DBSP,
differential dataflow, Materialize. One program spanning the network cut:
[Electric Clojure](https://github.com/hyperfiddle/electric) (v3 is commercial;
borrow the model). Methodology: Conal Elliott's denotational design — give
`Screen` a denotation and derive the rest, at which point the gaps above stop
being a list of annoyances and become visibly missing cases.

Roc's *platform* concept — the platform supplies the host and all effects, the
application is pure — is the virtual cluster/terminal split arrived at
independently, which is worth knowing as convergent evidence.
