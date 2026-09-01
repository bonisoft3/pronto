# Machines, not widgets

Written from the design conversation that followed
`2026-08-30-the-smallest-interactive-thing.md` (whose items 1–3 and 5 landed
as PR #1640), against the ground `2026-08-03-component-tier.md` laid: XState's
config is data, it runs under SES with nothing endowed, and the browser now
ships the popover/dialog/anchor primitives. `2026-08-29-the-screen-typechecker.md`
supplies the R4 finding this doc finally answers. The forcing consumer is
`apps/omnishell-shadcn-ui` (its brief.md is the product statement).

The claim: **the widget tier's replacement is CUE-authored components that
expand to the existing binding vocabulary, and their behavioral ingredient is
a terminal-owned interpreter of the XState-JSON data subset.** The doc that
landed yesterday rejected app-defined statecharts; its own argument contains
the escape clause — *"a CUE-declared machine is only declarative if the
action vocabulary is closed and terminal-owned"* — and a machine whose only
action is "write the target state name into one field of the region's row"
meets it. That action is `put`, which the reduce machinery already owns.

## Facts not to re-derive

Read out of this tree on 2026-08-30.

- `plugins/omnishell/terminal.cue:128` advertises five widget kinds; the three
  row-backed ones (combobox, select, listbox) have never mounted —
  `screen.js` (mountFieldWidgets' first guard) skips every `[data-widget]`
  containing a `[data-live]`. thenote used one exactly as advertised; the only
  reference to its adapter was the dead `data-adapter` seam PR #1640 retired.
- XState 5.32.5: zero dependencies, config round-trips byte-identical,
  evaluates under `lockdown()` in a Compartment with a frozen no-op console;
  `after` is unavailable by construction because timers are the terminal's
  (`2026-08-03`, measured). `on: {click: "cool"}` target-shorthand is valid
  XState config, so the subset below pastes into a statechart visualizer.
- Radix/shadcn's observable contract is `data-state` attributes styled by CSS
  variables — omnishell's native render target and `#Design`'s token system.
- realworld's favorite/save pill block (two forms + a probe region, ~15 lines)
  repeats across 10 screens; truco's three pickers are one shape with
  per-option `id`/`data-opt` conventions its reduce parses back out of
  `event.from`. Both are components waiting for a spelling.
- Custom element names require a hyphen (`omnishell--button` is valid,
  `omnishellbutton` is not); an *unregistered* custom tag is a plain unknown
  element — CSS applies, `data-*` binds, `querySelectorAll` sees it.
- Every walker the interpreter has — `bindTree`, `ownedBy`, `clearBindings`,
  the keyed reconciler, the exit-animation wait, the emitted `design.css` —
  assumes one light tree. Shadow DOM is invisible to all of them.
- `parseFilterSpec` already yields a filter's `eq` constraints as data.
- Refusals are events since PR #1640: a write the store withdraws reaches the
  region's mutation reduce as `{type: "refused", entity, id, kind}`.

## The machine

Published in `terminal.cue` beside the capability roster, so checkers compare
against published data:

```cue
#Machine: M={
	// The row column the state lives in. The machine's current state IS this
	// field's value — no second store of truth.
	field:   string
	initial: or([for k, _ in M.states {k}])
	states: [Name=string]: close({
		// Event keys are the terminal's own event types. A target must name a
		// declared state — the disjunction makes a dangling target a vet error.
		on: [Event=string]: or([for k, _ in M.states {k}])
	})
}
```

(v1 as implemented in `plugins/omnishell/machine.cue`; the v2 grammar below
extends it.)

`close()` is the subset boundary: guards, actions, entry/exit, invoke,
context, nested and parallel states fail unification loudly instead of being
silently ignored. Determinism is structural. The exclusions are each a cliff,
per the third-case rule: a guard is the moment order becomes conditional, and
there the author writes the Jessie reduce they would have written anyway —
an explicit vet error, never a grammar stretching until it lies. `after:` and
literal `assign:` are still data and may enter later, each with a real
consumer; `after` maps onto the `then: {type, delay}` machinery the terminal
already owns.

**Execution is `step()`.** A region carrying `data-machine` runs transitions
through the same machinery reduces use: the write is a `put`, so `?seed=`,
`?tempo=`, `?clock=manual` and the refusal event all apply with the machine
knowing nothing about any of them.

**The machine is the writer of the initial fact.**

1. A machine region needs no `data-empty-row`: the terminal synthesizes the
   fallback row from the region's filter equalities (facts about any row the
   region can ever show) plus `{[machine.field]: machine.initial}`.
   Precondition, not fallback: without `data-empty-row`, the filter must pin
   the pk with an `eq`, or lint refuses — the first `put` has no key
   otherwise.
2. Where `data-empty-row` is present (a rich row with fields no machine
   owns), agreement is unification, not comparison:
   `emptyRow: (machine.field): machine.initial`. A disagreeing hand-authored
   value fails to vet.
3. Runtime never arbitrates: empty-row present → it is the fallback row,
   already vetted; absent → synthesized. No merge.

**State names are the ARIA attribute's values.** A switch's states are
`"true"` and `"false"` because `aria-checked` speaks that vocabulary and one
field binds both the semantics and the styling hook. Style the semantics;
never carry two spellings of one fact.

## The components

- A component is a CUE definition; screens use it as a tag. Terminal-published
  components are `omnishell--<name>`; an app's own are `<app>--<name>`. The
  emitter expands the tag into the existing binding vocabulary; the tag
  survives in served HTML as an inert semantic wrapper — visible to devtools,
  CSS and the visual battery, registered with nothing.
- A machine authored through a component is valid by construction — the CUE
  that generated it is the CUE that validates it. Hand-written `data-machine`
  JSON is extracted at lint and vetted against the published `#Machine`,
  never against a TypeScript mirror of it.
- Event discrimination (N triggers, one machine — tabs) is
  **component-generated, never hand-written**: the expansion writes one
  transition per trigger keyed by the `from` the event already carries;
  whatever grammar it emits is the component's implementation detail, not
  vocabulary an author learns. No `data-send` until a hand-authoring consumer
  proves the need.
- The ir threshold is graded by what the artifact is, which the tree already
  practices (truco ships its engine under a decision note, not a handler
  item): **data in markup is reviewed as the screen; code earns review** — a
  decision note at minimum, a handler item when it embodies its own design
  object. A machine sits on the data side; using a component adds no ir
  object.

## What this un-rejects, exactly

`2026-08-30-the-smallest-interactive-thing.md`'s non-goals rejected a cycle
grammar (two states, fixed order, dies on the third case) and app-defined
statecharts (action strings naming JS). The machine here is neither: it
covers any fixed transition table, its cliff is explicit, and its action
vocabulary is one terminal-owned verb. The doc's split survives intact —
durable state is rows — because the machine's state IS a row field; what
falls is only the assumption that transient-vs-durable decides whether a
machine may exist. What stays rejected: app-supplied actors and effects, a
per-app interpreter copy, `customElements.define`, shadow DOM. Guards and
assigns *by name* were rejected here first and are un-rejected by the v2
section below under row closure — the argument outlived the verdict, again.

## The machine, v2: XState + Jessie

Settled in the design conversation of 2026-08-31, after v1 shipped with the
gallery. The complaint that drove it: the guard/assign/leaves-module stack
was too many concepts, and the cliff from machine to reduce too steep. The
resolution follows XState's own conventions in every case but one, and that
one is a relocation, not an invention.

**Value positions, one signature.** Certain positions in the machine JSON —
`guard:`, the values of `assign:`, a delay — hold either a literal or the
name of a Jessie function. A reference is called with the reduce's exact
signature, `(state, event) => value`, and the result lands where the literal
would have gone; the position gives the value its meaning. Everything else —
`target`, `initial`, `context`, state names, raised event types — is always
data, because those are the arrows and the initial world: the review
artifact. A string literal that shadows a declared module name is a lint
error, never a silent pick. Under this rule a reduce is simply a code
position whose value vocabulary is the change set: the terminal has one
callable contract.

**Closure over the row, both directions.** A machine's leaves receive
`{items: [row]}` and no `rows` key — reads and writes alike never leave the
row. A foreign *fact* is derived into a column (the derived-values rule) and
guarded on there; a foreign *computation* is the layer above. This keeps the
chart a closed behavioral inventory — every arrow decidable from what the
artifact declares — and makes the correspondence with XState exact: the row
is (state configuration + context). Parallel machines are disjoint columns
of one row (two machines claiming one field is the one-writer rule violated,
an error), and a same-row cross-field guard is `stateIn`.

**Adopted from XState, verbatim in spirit:**

- **`context`** — literal initial values for the non-machine columns; with
  `initial:` it makes the machine the complete statement of the initial
  world, and `data-empty-row` retires from machine regions entirely.
- **Ordered guarded candidates** — conditionality as data arrows; the guard
  is code, every reachable target stays drawn.
- **`raise`** — the machine's spelling of the reduce's `then:`: a
  self-addressed event, literal type (the cascade stays drawable), delivered
  by the terminal through the same bounded step machinery. Targetless
  transitions (act and stay) come with it. Deviation from SCXML, deliberate:
  cascades are depth-bounded by the terminal, never run to quiescence — a
  cascade with no owner has no end.
- **Root-level `on:`** — transitions that apply in every state unless
  overridden; the consumer is the refusal stanza, declared once.
- **`after` is the relocated `invoke`** — being in a state *is* the pending
  timer: armed on entry, canceled on exit, re-armed by a self-target. The
  terminal performs the wait, so `?tempo=` and `?clock=manual` govern it.
  The refusal event is the machine's `onError`. `invoke`'s src universe is
  the terminal's closed effect roster only.

**The disposition rule** that organizes all of it: sync-and-pure goes to
Jessie; async-and-effectful goes to the terminal; anything addressed to
someone else goes through the store. (`sendTo`/`emit`/app actors are that
last clause's rejects — inter-machine communication exists as a write
observed through a read, recorded and lintable, never as a message.)

**Gated on consumers:** `params` on references (`(state, event, params)`,
literal-only — moves thresholds into the chart and lets one Jessie module
serve every component instance); entry-assigns folded into the arriving
transition's change set; history as a column (`assign: {prev: "current"}` —
expressible today). **Refused with reasons:** `always` (derived state
belongs to views and CSS; cascades to `raise`); wildcard `*` (a catch-all
would swallow the derived events); nesting/`final`/`onDone` (no consumer,
and root `on:` took the urgency off).

**Choosing machine vs reduce.** Both spellings are first-class and the
choice is the author's, per widget. The value curve: the machine is
strongest at the pure-data end (zero code, component-generated) and the
many-states end (the chart is a complete inventory a reviewer reads by
set-difference), weakest in the middle — two states around real arithmetic,
where sequential prose reads better. One hard tripwire for the reduce: if
it re-arms `then:` delays, it has the duplicate-chain hazard (two chains
both find the armed phase and both re-arm — permanent double speed); carry
a generation mark on the row or use the machine, whose state-scoped `after`
makes the bug inexpressible. Note that most machines are component-generated
and never read as JSON; the readability cost falls only on hand-authors,
who hold the choice.

**The layer above.** Raw Jessie reduces and folds keep their declared
foreign reads (`items` plus named reads) — that layer is also where future
capability injection lands (device sensors and the like, endowed through
the terminal's capability vocabulary the way vendored units already request
`"group.name"` strings), never the machine's. Doctrine leaning, recorded
but not yet adopted: foreign computation only in the fold seat (the
mutation-woken reduce — the tab-tier CDC), with DOM-event handlers stating
intent only; the drag stays grandfathered.

## Tier-scaled declarations (item 4), shaped

The machine is what makes item 4 worth its full form — it empties the tab
entity completely (fields in `data-empty-row` or synthesized, transitions in
`data-machine`, the collection name in `data-live`):

- An unknown `data-live` table derives into shell.yaml's `local:` as `tab`,
  keyed `id`. A non-`id` key with no entity is an error — state worth a named
  key can afford the line.
- `device` keeps its declared line: localStorage survives a code change, so
  the name is worth pinning.
- The bijection exemption is by absence: no entity declared, nothing to
  compare; a declared tab entity still needs its ir section.

## Ranked plan

1. **`#Machine` + the interpreter.** Publish the definition in
   `terminal.cue`; `screen.js` executes `data-machine` through `step()` with
   the synthesized fallback row; lint vets hand-authored JSON and the
   empty-row agreement. *Done when:* the colour-cycling button runs from
   markup alone and replays under `?seed=`.
2. **The expansion mechanism + `omnishell--switch`.** Tags expand at emit;
   the switch demo screen ships zero app JavaScript and zero
   `data-empty-row`. The consumer app is `apps/omnishell-shadcn-ui`.
3. **`omnishell--tabs`.** The forcing consumer for component-generated
   discrimination; panels are `data-state` projection.
4. **Item 4.** Tab tables with no entity, per the shape above.
5. **Graduation.** The proven components enter the terminal's roster; the
   three row-backed widget kinds and the stale `[data-widget]` guard are
   deleted rather than fixed.
6. **Chart-derived test paths.** A walker over the subset enumerates every
   (state, event, guard-branch) arrow and drives the linkedom harness
   through it, asserting row fields — every machine ships with every arrow
   exercised. Row closure is what makes the witnesses constructible: a
   branch witness is a single row, shaped by `context`, the assigns, and
   any `cel:` enum. *Done when:* the gallery's machines get arrow coverage
   with no per-machine test code.
7. **The v2 grammar** (value positions, `context`, `raise`, root `on:`,
   `after` lifecycle, row closure). *Done when:* the Fibonacci autoplayer
   of the design session runs from markup plus three one-line Jessie
   modules, and a leaf reading `state.rows` fails loudly.

## Rules worth carrying

- **A rejected design may contain its own license.** Read a non-goal's
  argument, not only its verdict: "only declarative if closed and
  terminal-owned" was a specification wearing a rejection.
- **Make one declaration the writer and derive the rest**; validate only
  where two hands author independently, and let unification be the
  validator.
- **Style the semantics.** When an ARIA attribute already speaks the state's
  vocabulary, its values are the state names.
- **Generated grammar is not vocabulary.** A spelling only a component ever
  writes can be ugly, precise and changed at will; the moment a human writes
  it, it must survive the third case.
