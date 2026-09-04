# Pending

What is argued but not built, per line of work. A line leaves this file when it
lands or when it is refused in writing; a refusal belongs in a dated doc under
`docs/`, not here.

Every claim below was checked against this tree on 2026-09-04. Where a doc or a
commit already states the argument, this file points at it rather than
restating it.

## Interaction and projection

Wave 7 closed this line: the roving tabstop, `data-focus`, parallel charts,
typeahead and the chord all landed, and the accordion, the four menu surfaces
and the menubar consume them. `docs/2026-09-03-the-reader-is-also-a-writer.md`
carries the argument; the ir carries the per-component reasons. What is left:

- **The browser-tier fold seat has no consumer**, and neither of the two
  things this file said would need it does. `aria-checked="mixed"` needed the
  header's value to stop being a FIELD (ir decision-47); a line chart needed
  one derived column, the neighbour's value, which the program states because
  the program states the rows (ir decision-46). What is left is the case both
  of them point at: items or points a READER can change, where the derived
  column has to be maintained by something. That is the seat, and the data
  table's select-all is where its first consumer belongs — blocked in this app
  by shadcnui's own brief, which refuses a module reachable any way other than
  as a chart's leaf.
- **A region cannot render SVG.** A `<template>`'s content is parsed as HTML,
  so a region filling an `<svg>` produces elements in the wrong namespace:
  present, carrying every attribute the binding wrote, and drawn by no engine.
  linkedom renders them, so only the browser tier sees it. The chart's line
  works around it with a clip-path per segment; a region that could clone into
  the SVG namespace would let a chart draw arcs, areas and axes.
- **A browser-tier case for `data-focus`.** The tabstop has one
  (`playwright-tests/roving-tabstop.pw.ts`); the accordion's and the menus'
  carets do not, and `activeElement` is the half linkedom answers wrongly. The
  hover card's Tab-into-the-surface is the same gap in the other direction: its
  whole-screen test fires the focus events the DOM would, and only a browser
  moves focus for real.
- **A chord pressed from anywhere**, waiting for a second caller rather than
  for a design. It is a SCOPE and not a component: every listener the terminal
  attaches is a region's, so a key pressed with focus elsewhere has nobody to
  deliver it to. `accesskey` is the platform's own answer and gives every part
  of it except the key — the modifier is the UA's — which is why a chord we
  choose needs a listener of our own. The shape that fits is a map on the
  ROUTE, chord to a control it aliases, torn down with the screen: one owner
  per chord by construction, `commandfor`'s lint, and a trace with one cause.
  `/command` carries the note; the palette is the only caller today.

Components: the shadcn roster is complete, checked against the live docs on
2026-09-04 rather than against this file's own earlier audit — which had
missed sixteen entries, most of them the conversation family and the
composition primitives. Everything in that index now has a screen, and three
of them turned out to be things this catalog already had under another name:
Field is the form screen's, Native Select is the select screen's, and Direction
is an attribute rather than a component.

What the last wave's builds contradicted, worth keeping because the file said
otherwise: Input OTP is ONE control and the refusal of the six-slot caret IS
the component; a bar chart's geometry needs no fold, only a domain the program
states, and a LINE needs one derived column beyond that; `aria-checked="mixed"`
needed the header's value to stop being a field. The ir carries each
(decision-44 through decision-51).

## Machines

The v2 grammar landed with PR #1642. What did not:

- **The doc.** `docs/2026-08-30-machines-not-widgets.md` has no v2 section, so
  value positions, `context`, `raise`, `after`, root-level `on:`, closure over
  the row, the layering rungs and the machine-vs-reduce curve live only in
  session notes.
- **`schema-vet` at the store chokepoint.** Half of it landed: `writeLint`
  (`interpreter/lint.ts`, run from `derive.ts`) judges column spelling against
  the entity's declared field types over browser-tier writes, which is what
  killed the number-vs-text class. What it does not do is judge a VALUE — the
  CEL invariants ship in `shell.yaml` and nothing enforces them, and the check
  reads the markup at compile time rather than standing at the store where every
  write passes.
- **The trace recorder**, its loader and replay-to-N: a trace is
  `{snapshot rows, boundary-crossing inputs, pins including the ir sha}`,
  anchored when gzip+base64url fits ~8KB and filed otherwise; the loader is a
  fixture-mode store under the manual clock, so it runs in linkedom.
- **TypeScript for the interpreter**, with a build step rather than JSDoc.
  Deferred to its own day by ruling.
- Smaller, each one sentence of work: the silent-fixpoint doctrine sentence (a
  fold rewriting identical rows raises no deltas and sleeps the seat); truco's
  dead `then.with` field; `membrane-smoke.js` and `tier2-smoke.js` are on disk
  but absent from the `cache-smokes` list in
  `plugins/omnishell/.vscode/tasks.json`; the app-level migration seam for
  repair-not-deletion reconciliation; the toggle-flag wrapper-tag convention;
  the flight-animation island's move into a terminal enter/exit vocabulary.

## Test tiers

- **Nothing catches a column no screen reads.** Three appeared in one wave — a
  chart's `nxt_pos` whose reader was rewritten out from under it, and `typed`
  on four menu entities, a fossil of the typeahead's first shape. Each was
  found by hand. The rule is decidable off the facts the derive already
  extracts: a field must be bound in markup, named in a filter, an order or a
  projection, be a chart's own field, or be written by one. The same pass would
  catch a CSS rule matching no class on its own screen, which is the same
  fossil one rung down.

- **The battery cannot tell a perpetual animation from a screen still moving.**
  `settle()` fingerprints the geometry of every element and waits for it to
  hold still; a rotating square's bounding box changes with the angle, so one
  spinner leaves a route reported as moving and everything measured after that
  measured a moving screen. The shadcnui atoms screen works around it by
  spinning a pseudo-element, which the fingerprint does not walk — an app
  should not have to know that. Emulating `prefers-reduced-motion` for the
  battery would settle every such route by construction, and it is what the
  battery already means by a settled moment.

- **The battery never hovers.** `check-visual` measures one settled moment per
  route, so a hover rule that outranks a state rule — pagination's did, hiding
  the page a reader had just chosen until the pointer left — is invisible to it.
  A second moment per route, with the pointer on the first interactive element,
  would catch the class.

- **The battery's param fixtures** are per route since wave 7, so a name two
  routes spell over different tables no longer fills the second with the first
  one's row. What is still unmeasured is a route whose screen needs a row a
  fresh cluster has not got: that comes back as a finding, not as coverage.
- **The battery measures one arbitrary moment per route.** It never enters a
  hand of truco, and reports zero criticals there while a reader sees cards
  covering each other. The clock that fixes this already ships —
  `?clock=manual` with `__prontoClock.advance(ms)`, `?tempo=`, `?seed=`
  (`interpreter/screen.js`), driven by `apps/truco/tests/acceptance.ts`. At
  ~18ms per page of checks, walking every beat of a hand costs less than one of
  the sleeps it replaced.
- **Open platform questions from the whole-screen tier**: an optimistic create
  whose region binds a GENERATED column throws and leaves the screen on
  network-error after a write that succeeded; screen state is decided by
  whichever top-level region refreshed last, so a screen can settle on a state
  its route does not declare; `just generate` fails in the gallery. (The
  un-keyed `#Tabs`/`#Picker` ids this list carried are keyed — both take a
  `key` and spell it into every id.)

## The incremental read path

`lt`/`gt`/`gte`/`lte` are exported from the predicate vocabulary but no
translator emits them, so cursor routes still reach PostgREST.
`currentStateAsChanges` has no caller, so first paint is still a full pass.

## Cost

- **Healthcheck intervals.** Every service polls at 5s across a ~4-level
  dependency chain, so most of cold boot waits for the next tick rather than for
  readiness. 250ms took realworld's cold boot 16.9s → 12.5s; ~1s probably
  captures most of it. The change belongs in bayt's compose emission and touches
  every app.
- **Get the cluster out of the loop.** After the above, ~87% of the cold gate is
  cluster boot. `check-visual.ts`'s header says the fixture storybook cannot host
  these checks because a screen there is a 360px frame on a flex board, so
  geometry resolves against the board — a framing artifact, not a law. Fixing it
  moves the battery below `integrate`, which is the only path to another order of
  magnitude. The cost is realistic content, which is what the cluster supplied.
- **SSR**, parked. omnishell is already isomorphic — `interpretScreen` runs under
  linkedom — so a deno sidecar is days, not weeks; the blocker is auth, since
  per-tab sessions are invisible to a server, so it covers public-read content
  only. A service worker would serve real repeat visitors better than any of the
  ranked paths.

## prontoui

Designed in full in `PRONTOUI.md`, no code. The first app written in Pronto
itself, and the escape-hatch doctrine's stress test.
