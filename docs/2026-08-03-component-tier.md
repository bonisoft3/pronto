# The component tier: what an app may author, what the terminal keeps

Written after adopting the Zag date picker into thenote, from the questions
that adoption raised. `2026-08-02-terminal-doctrine.md` establishes the role
vocabulary, `-hatch.md` the island, `-incremental-model.md` the semantics.
This doc answers a narrower question those three leave open: **who may author
a widget, and in what language.**

The claim: **the widget tier is not one problem but three, separated by what a
component needs from the DOM.** Most of what a component library exists to do
— place a popover, dismiss it, move focus — has become browser primitives, and
in that light the platform's share collapses to a dispatcher and an effect
vocabulary. What is left over is state, and state is already what the
incremental model knows how to carry.

## Facts not to re-derive

Measured in this tree on 2026-08-03, not recalled.

**The isolation constraint.** A dynamic `import()` issued after SES
`lockdown()` never settles — it does not reject, the promise has no other end.
The same URL imports in ~0ms before lockdown and loses a 6s race after it.
Every edge from `screen.js` to a widget kind is static because of this; see
`reference_ses_lockdown_dynamic_import`. `page.evaluate` cannot use `import()`
at all once SES is loaded (`SES_IMPORT_REJECTED`) — probe with
`addScriptTag({type: "module"})`.

**The DOM surface a widget actually touches.** Instrumented `Node`,
`Element`, `HTMLElement`, `Document`, `Event` and the observers, then mounted
each widget through the real dispatcher and drove it (open, pick, page the
month; open, select an item):

| | members |
|---|---|
| dispatcher (`render.js` + `spreadProps`) | 13 |
| date picker, total | 52 |
| combobox, total | 55 |
| shared by both machines | 49 |
| union | 58 |

The component's own share of the date picker is 39, and it divides sharply:
~17 for measurement and placement (`getBoundingClientRect`,
`clientWidth/Height`, `offsetWidth/Height/offsetParent`, `scrollLeft/Top`,
`getComputedStyle`, `style.setProperty`, all three observers,
`requestAnimationFrame`, `documentElement`, `body`, `compatMode`,
`defaultView`), ~12 for dismissal and focus (`closest`, `matches`,
`getRootNode`, `ownerDocument`, `parentNode`, `assignedSlot`, `focus()`,
`click()`, `defaultPrevented`, `removeEventListener`), and ~10 for anything a
date picker specifically does (`dataset`, `id`, `value`, `removeAttribute`,
`firstElementChild`, `nodeName`, `nodeType`, `setTimeout`, `queueMicrotask`).

**Every upward-escaping accessor is in the first two groups.** None of it is
the calendar. Two structurally opposite components sharing 49 members says
this is one shared runtime, not per-component sprawl.

**The browser now supplies that runtime.** Verified by launching each engine:

| | Chromium 147.0.7727.15 | Firefox 148.0.2 | WebKit 26.4 |
|---|---|---|---|
| `popover` / `showPopover` | yes | yes | yes |
| `<dialog>` / `inert` | yes | yes | yes |
| `anchor-name` / `position-anchor` | yes | yes | yes |
| `position-area` / `position-try` | yes | yes | yes |
| `command` / `commandfor` | yes | yes | yes |
| `interestfor` | no | no | no |

**Screens are not gated by `render.js`.** `TAGS` and `GLOBAL_ATTRS`
(`class, title, lang, dir`) govern only what a renderer or a kind's `generate`
may build — "prose elements, and only prose". Screen HTML takes
`holder.innerHTML = html` in `screen.js` with no allowlist, because a screen
is app source emitted from CUE and reviewed at ir. This is why `note.html`
already carries `type`, `placeholder` and `aria-label`. **`popover`,
`commandfor` and anchor positioning are available to screen authors today with
no platform change**; the CSS half was never gated at all.

**Zag was never XState.** `@zag-js/core` has no `xstate` dependency in any
published version (first 2022-04-06, latest `2.0.0-next.1` 2026-08-01); its
deps have only ever been `klona`, `valtio`, `@zag-js/utils`, `@zag-js/store`,
`@zag-js/dom-query`. Its own npm description is "A minimal implementation of
xstate fsm for UI machines". `@ark-ui/react` 5.37.2 depends on Zag, not
XState. npm search for XState component libraries returns only XState's own
tooling. **There is no established component library driven by XState.**

**XState's config is data.** `xstate` 5.32.5, published 2026-07-14, **zero
dependencies**, **52KB minified ESM** (the 2.2MB unpacked figure counts types,
maps and both module formats). A machine parsed from a JSON string with every
action and guard referenced by name and supplied through `setup()` runs
correctly, and `machine.config` round-trips byte-identical. Ambient authority
in the bundle is narrow: `Date.now`×1, `Math.random`×1, `setTimeout`×6,
`clearTimeout`×5, `console.`×1, `globalThis`×2. The small official variant
`@xstate/fsm` has not been published since 2023-06-21.

**XState runs under Jessie's constraints.** Bundled as an IIFE publishing its
value to the compartment global, then evaluated after `lockdown()` inside a
`Compartment` whose only endowment is a no-op `console`: the module
evaluates, and a machine parsed from JSON with named actions supplied through
`setup()` transitions correctly (`closed → open → closed`). The compartment
has no ambient authority — `document` and `fetch` are `undefined`, and
`Math.random`, `Date.now` and `setTimeout` each throw `TypeError`.

Two consequences. `console` must be endowed or the module throws at
evaluation on its single `console.` reference; a frozen no-op suffices and
grants nothing. And **delayed transitions (`after`) are unavailable by
construction**, because they need `setTimeout` — which is the right answer
rather than a limitation: a machine that could read the clock would stop
being a function of its inputs, and timers are the terminal's to own like
every other effect.

**The effect layers are separately packaged.** `@zag-js/popper` (→
`@floating-ui/dom`), `@zag-js/dismissable`, `@zag-js/focus-trap`, all 1.43.0.
`@floating-ui/core` is pure geometry; `@floating-ui/dom` is the adapter over
it. Zag concentrates DOM access in `@zag-js/dom-query`, so a port has one
seam rather than scattered access.

**The IVM engine already has the operators this needs.** `@tanstack/db-ivm`
0.1.18 ships `map`, `filter`, `filterBy`, `join`, `count`, `distinct`,
`reduce`, `concat`, `consolidate`, `groupBy`, `orderBy`, `topK` (with
fractional-index variants), plus `pipe`, `tap`, `debug`, `output`, `negate`,
`keying`. `data-crud.js:436` already calls `.join(` — embeds are maintained
through it. `@tanstack/store` 0.11.0 (2026-04-17) has zero dependencies.

## The four tiers

Separated by what the component needs from the DOM, not by how much it is
trusted.

**Tier 0 — declarative.** Platform primitives and CSS, no script. `popover`
for light-dismiss, top-layer and focus-on-open; `anchor-name` /
`position-area` / `position-try` for placement with flip-and-fallback;
`<dialog>` and `inert` for modality; `command`/`commandfor` to wire a trigger.
Covers popovers, dialogs, disclosure, click-tooltips, much of a menu. Costs
nothing to build and nothing to permit: screens may already write all of it.

**Tier 1 — declared machines.** For components that have state rather than
only presentation: combobox, listbox, date grid, stepper, tag input,
segmented control. The machine is data (e.g. JSON FSM specs); the projection is
the incremental graph (below). No app JavaScript beyond pure state data.

**Tier 2 — Jessie pure transforms with membrane context.** Pure JavaScript
running inside SES (Secure ECMAScript) sandboxed compartments where Jessie is
the main authoring language. A host-side read-only membrane (`createReadOnlyMembrane`)
is passed into the transformation context to allow safe query operations
(`.matches()`, `.id`, `.closest()`, `.getAttribute()`) while strictly blocking all
DOM mutation vectors and ambient authority.

**Tier 3 — hatch units.** `hatch.js`, already shipped: a sandboxed iframe with
`allow-same-origin` refused permanently and without a widening path, props in
as a resynchronised feed, named events out, height negotiated. For anything
with its own DOM — charts, maps, editors, grids.

## The projection: a widget is a region

The strongest idea from this design pass, and it dissolves the hard half of
tier 2.

A region's input is whatever can deliver keyed change sets: `subscribe(table,
fn, opts)` builds a `maintainedView` and wakes on `view.subscribeChanges`,
coalescing batches and passing either a change set or `undefined` for
"reconsider everything". Nothing about that contract is intrinsically
Electric's.

So **a widget is a region whose rows come from a machine instead of from the
store.** A day cell is a row. Its `data-selected`, `data-today`,
`data-outside-range`, `data-active` and `tabindex` are columns produced by a
query over visible days joined with machine state. The existing reconciler
renders it, keyed, with the enter/exit vocabulary it already has, and CSS
projects the columns exactly as `note.css` already does.

Three mechanisms added on 2026-08-03 collapse under this: `generate` becomes a
template with rows, `partArg` becomes "the row is the cell", and `generateKey`
— the cache added because regenerating the calendar on every render replaced
the node under the pointer mid-click — becomes unnecessary, because deltas are
the point.

Consolidation is what makes it correct rather than merely tidy. When focus
moves from day 5 to day 6, a naive re-derivation touches all 42 cells because
every cell's `selected` column depends on a scalar that changed; differential
dataflow retracts the old `(row, value)` pairs and adds the new ones, and the
forty unchanged ones cancel. The sink sees two changes.

This also answers what had no precedent. The objection to a declarative
tier-2 was that `aria-activedescendant`, roving `tabindex` and cross-part `id`
wiring have no declarative projection anywhere — that `connect(state) → props`
is Zag's real contribution and XState has no equivalent. Under this design
they are *columns*, not a projection language.

**Scalars are the arity-zero case, not a second paradigm.** Singleton parts —
the trigger's `aria-expanded`, the content's `data-state`, the input's
`aria-activedescendant` — have no identity to key and nothing to consolidate.
`@tanstack/store` is the right representation for those, and using it
alongside relations is not a fracture: a signal is a relation with no key,
which is why `@tanstack/db` sits on `@tanstack/store` in the first place.

**The machine is itself a transform.** `db-ivm` ships `reduce`, and a state
machine is a fold over an event stream. In this algebra the machine is not a
separate tier — it is a stateful node in the same graph, which means XState
becomes a *convenience notation over a serialisable config*, not a foundation.
A fold gives a reducer, not a statechart; Downshift has driven combobox
behaviour off a plain reducer for years, so the common case is covered. What
statecharts add — hierarchical and parallel states, entry/exit actions, formal
analyzability — matters for review at the ir rung, which is the only reason to
reach for them.

The whole architecture then reads the same at both tiers: **tables → pure
transform → sinks, where a sink may emit events that feed another transform.**
The transform language differs by tier (bloblang server-side, Jessie
client-side) but the algebra does not.

## The palette: which third-party code an app may pick up

Split by what the library needs, and the trust question inverts.

**Pure libraries run in Jessie today.** No DOM, no clock, no randomness, no
network — a pure function of its inputs is exactly what a Compartment with no
endowments can run, and `evaluateRole` already exists. Whitelisting is a
pinned vendored bundle plus a lint entry. This is where "a dozen libraries" is
the right instinct and costs almost nothing: date math
(`@internationalized/date`, which Zag itself uses), colour, fuzzy search,
decimal arithmetic, JSON patch, `d3-scale`/`d3-shape` (SVG path strings are
pure string math, so a chart can be *computed* in Jessie and *rendered* as
markup — though `TAGS` does not model SVG's attribute surface today).

Anything reaching for time, randomness, network, storage or the DOM is out,
as is anything that monkey-patches intrinsics, since lockdown freezes them.
A useful proxy: if it would work inside a Worker with no DOM, it will work
here.

**Split at the library's own pure seam.** `@floating-ui/core` is geometry and
`@floating-ui/dom` is the adapter; Zag concentrates DOM access in
`@zag-js/dom-query`. When evaluating a library for the palette, look for that
seam first — the pure half is often the half worth having.

**DOM-driving libraries need no whitelist at all.** The sandbox is uniform and
the trust analysis does not vary per library, so what a chart library needs is
packaging as a hatch unit, not admission to a list. The dangerous class is the
one where the trust question disappears.

## Isolation: what was examined and rejected

**Remote DOM** (`@remote-dom/core` 1.11.1, 2026-05-08) is transport-agnostic —
`DOMRemoteReceiver`'s mutation path contains no `async`/`await`/`Promise` and
the package has no worker or thread dependency, so the async penalty is a
choice, not a property. Same-thread cost is ~0.6µs per mutation against
0.24µs direct, roughly 2.5×. **But its polyfill covers only 24 of the 55
members these widgets need**; the 31 missing include every layout and
measurement API, `focus()`, `click()`, `activeElement`, `closest`, `matches`
and `getRootNode`. That is structural: it is a mirroring DOM designed to run
where there is no layout. Zag does not work on it, and cannot without
reimplementing layout.

**near-membrane** (`@locker/near-membrane-dom` 0.18.0, 2026-07-30) is 11KB
whose single export is `createIframeVirtualEnvironment`; the iframe is an
intrinsics factory, not the boundary. It ships the machinery and a
`distortionCallback` — **not the DOM-clamping policy**. Measured with no
distortions, guest code reached `ownerDocument.defaultView.fetch`, the whole
document, `document.cookie`, and walked out through both `parentNode` and
`closest("body")`. Cost is ~2.0µs per `setAttribute` (15×), ~1.5µs per
`querySelector` (51×), and 34.6ms one-time realm setup. Zag works on it out
of the box precisely because nothing is contained; adding a policy that
*denies* the seven escaping members breaks Zag, so keeping both requires
LWS-style scoped virtualisation of those members and of `document` itself.

Prior art runs both directions and the decision rule is clean. Facades
succeed when authors write *to* them — Figma's plugin API, Shopify's Remote
DOM, VS Code's extension host, where extensions declare hovers and quick picks
and never position anything. Facades fail when authors bring *existing code
that expects the full DOM*: Salesforce's original Locker Service was exactly a
hand-written `SecureElement`/`SecureDocument` allowlist and was replaced by
LWS and near-membrane for compatibility, not security. Caja virtualised a
subtree correctly and died of the maintenance surface. So Zag's components are
*expressible* against a facade — their own logic needs ~10 members — but not
*droppable-in*.

**zoid stays rejected.** Last published 2022-01-12, 3.3MB unpacked, four
PayPal-internal dependencies including a synchronously-resolving Promise
implementation, against `hatch.js`'s 131 lines and none. The threat models
also differ: the hatch's isolation is `sandbox` without `allow-same-origin`
(opaque origin), zoid's is a genuinely different domain. And zoid marshals
*functions* across the boundary, widening a contract `hatch.js` deliberately
narrowed to "the unit describes, the terminal performs". The one idea worth
taking is the second origin — real origin isolation rather than opaque-origin
sandboxing, the way user content is served off a separate domain. That is an
infrastructure decision, not a library one.

## Cycles

Two different things wear the name, and only one is a hazard.

A cycle in the **state** dimension — a machine returning to a prior state — is
ordinary and necessary. A cycle in the **dataflow** dimension — a node's
output reaching its own input, which "sinks may emit events" admits — is the
one that does not terminate. The browser does not solve this either; it is why
a change handler that sets its own value spins.

The answer is contraction, not prohibition. **Equality-gated sinks converge**:
if a sink emits only when its value actually changed, a cycle settles instead
of spinning, and `consolidate`/`distinct` — already needed for efficiency —
are exactly that gate. Differential dataflow's own answer is the same shape:
cycles are legal only inside an explicit iteration scope with a fixed-point
condition. Static acyclicity of the *declared* graph is something CUE can
check, which leaves only the dynamic cases to the equality gate.

Making machines first-class helps here for a second reason: it shrinks the
amount of hand-written Jessie wiring, and hand-written wiring is where
undeclared cycles come from.

## Open questions

Ordered by what would change the design if answered badly.

1. **Does `maintainedView` consolidate correctly on a small in-memory
   collection?** The machinery was built for store tables with their indexes;
   driving it from a 42-row machine-derived collection is a different usage and
   is unmeasured.
2. **What does a dataflow pass cost per machine render?** Machines render on
   hover; 42 rows through a graph is heavier than spreading props onto nodes
   that already exist.
3. **How much of `subscribe(table, ...)` assumes a table name?** A
   machine-backed source must satisfy that contract or the region needs a
   second input path — a refactor, not a free composition.
4. **What is the smallest useful action and guard vocabulary?** Let it grow
   from one component rather than designing it up front.
5. **How does a machine reach the palette?** A kind will want date arithmetic
   (`@internationalized/date`) alongside its machine. Both are pure and both
   run in a Compartment, but the completion-value contract admits one value
   per module, so composing them is a packaging question that is not yet
   answered.

## First move, when this resumes

Rebuild thenote's date picker as tier 1 plus tier 2: `popover` and
`commandfor` in `note.html`, anchor positioning in `note.css`, the day grid as
a region whose rows come from a machine. Nothing in the platform changes to
begin, which is the point — if it lands, the widget tier is app-side, and the
measurements say it should be. Pick a small accessibility contract for the
*second* one (a stepper, a segmented control) rather than the combobox, whose
virtual-focus behaviour is the part with no declarative precedent.

`interestfor` is missing in every engine, so hover-opened menus still need
script whatever else is decided.
