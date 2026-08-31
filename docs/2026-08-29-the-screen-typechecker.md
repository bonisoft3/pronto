# The screen typechecker

Written from building a browser-tier app end to end in one sitting, and from
what the loop cost while doing it. `2026-08-01-visual-lint.md` is the ground:
it settled which checks need a rendered page and which do not. This doc is
about the ones that need neither a page nor a cluster, and are not written.

The claim: **`program.cue` and a screen's markup are two statements of the
same thing, and nothing compares them.** Every rung below the screen has a
checker — `cue vet` for the program, `check-bijection` for ir↔program,
`check-handlers` for the Jessie grammar, `check-screens` for design-token
forks — and then the assembly, which is where most of an app's surface lives,
is checked by running it.

## Facts not to re-derive

Measured in this tree on 2026-08-29, not recalled. A prototype checker
(~90 lines of Python, no browser, no Docker) was run over all four apps.

- `check-screens.ts` is 91 lines and enforces **one** rule: a screen's
  stylesheet must not redeclare a token the shared layer declares. That is the
  whole of what the assembly is checked for today.
- The program's export carries everything the markup needs to be checked
  against: `surface.screens[*].reads[*].entity`, `.forms[*].{id,entity,action,fields}`,
  `.files.{handlers,shared}`, and `state.entities[*].{table,fields[*].name}`.
  Read with `cue export . -e code --out json`, which `check-bijection` already
  does.
- The terminal publishes its own half as data too:
  `terminal.capabilities.widgets` gives each kind's exact `parts` list
  (`terminal.cue:128`), and `text-formats`, `auth` and `isolation` are beside
  it. Nothing has to be invented or kept in sync by hand.
- The markup vocabulary the interpreter actually reads is small and closed:
  `data-live`, `data-filter`, `data-order`, `data-select`, `data-reads`,
  `data-text`, `data-text-format`, `data-value`, `data-empty`,
  `data-empty-row`, `data-form`, `data-entity`, `data-action`, `data-target`,
  `data-handler`, `data-on-*`, `data-on-mutation`, `data-widget`,
  `data-part`, `data-hatch`, `data-enter`, `data-exit`, `data-item`.
- **The prototype found four real drifts across four apps**, listed under the
  rules below. It found them in under two seconds.

## The problem, stated exactly

An app's screens are assembly: HTML the compiler writes directly, not CUE it
derives. The compiler "owns their consistency" with `reads`/`forms`
(`schema.cue`, `#Screen.files`) — owns it, meaning nothing enforces it. So a
screen can read a collection its program never declares, address a form by the
wrong name, bind a column that does not exist, or use a widget seam the
terminal retired, and every one of those is discovered by running the cluster
and reading a console.

That is the loop: edit markup → `docker compose up --build` → drive
Playwright → read the console. Forty seconds and a Docker daemon per
iteration, for a class of mistake that is a set difference between two files.

## The rules

Each is stated as: input, what it catches, evidence from this tree, readiness.

### R1 — a region reads a collection the screen declares

`data-live="<table>"` must name the table of an entity in that screen's
`reads`. Same for every table in `data-reads`.

> **Found:** `xpense/ledger` renders `data-live="category"`; the screen's
> program declares `MonthStat` and `Expense` and nothing else. It works at
> runtime because the store serves any table in `tables:`, so the screen reads
> a collection the ir's Reads list — the reviewed artifact — does not mention.

Ready.

### R2 — a filter names columns the entity has

Every `col` in a `data-filter` fragment must be a field of that entity.

The rule has to read the *same* filter grammar `parseFilterSpec` reads, or it
reports the grammar's own vocabulary as errors: `limit` is a cap, not a
column, and a dotted path is an embed filter the server computes. A first
draft flagged 14 of those. That is an argument for the grammar having one
parse, which is the standing complaint about `parseFilter` vs the view's
`clause` builder — here it becomes a third reader.

Clean on all four apps once the grammar is respected. Ready.

### R3 — a form is the form the program declares

`data-form="<id>"` must name a form in that screen's `forms`, and its
`data-entity`/`data-action` must match. Its `[name]` inputs must be exactly
the declared `fields` — no more, no fewer.

> **Found:** `realworld/editor` writes `data-form="publish-article"` where the
> program declares `id: "publish"` with `flow: "publish-article"`. The markup
> used the flow's name where the form's id belongs. Same again in
> `realworld/edit-article`. Harmless at runtime — the terminal keys off
> `data-entity` and `data-action` — but the id is the *review handle*: the
> storyboard, the screen's `paths`, and the ir all address the form by it.

The field-set half is what would have caught this session's
`binding {body} not in row`: see R6.

Ready.

### R4 — a widget is a kind the terminal serves, with parts it has

`data-widget` must name a kind in `terminal.capabilities.widgets`, every
`data-part` under it must be in that kind's published `parts`, and a `root`
part must be present.

Clean on all four apps — which is the finding. See "Not the app's fault"
below.

Ready, and cheap, because the roster is published data.

### R5 — every `{field}` placeholder resolves

A `{name}` in any attribute must be a field of the row that binds it:
`param.*` resolves against the route, `{now}` is the shell's clock, a dotted
path is an embed, `data-empty-row` supplies the fields a missing row still
binds — and a region's **own** `data-filter`/`data-order` interpolate the
*enclosing* row, not its own. A first draft missed that last one and reported
seven false positives; with it, **zero findings across four apps**, so the
rule is sound on real markup rather than merely plausible.

Ready. This is the rule that pays for the whole checker: it is the one that
turns "the wall rendered three cards and stopped" into a line number.

### R6 — a browser-tier create form states the whole row

For an entity on `tab` or `device`, a `create` form's fields must cover every
field the entity declares. No SQL default will fill the rest in, and the
terminal refuses to bind a column a row does not carry.

This is program-only — it needs no markup at all — and it is exactly the
defect that cost this session an hour: a capture form that omitted `body`
produced rows the card template could not bind, and the wall stopped
rendering mid-list. No app in the tree has a browser-tier create form today,
so the rule would report nothing; it is specced because the next such app
will hit it on its first screen.

Ready, no consumer yet.

### R7 — a handler, renderer or shared stylesheet named is a file declared

`data-handler`, `data-on-*` and `data-on-mutation` must name a module in the
screen's `files.handlers`; `data-text-format` must be a built-in or a
declared renderer; every `@import url("shared/…")` must be in `files.shared`.

The terminal already throws for the handler cases at hydrate time
(`screen.js:79`, `:104`) — this only moves the throw to lint, where it costs
no container.

Ready.

## What it cannot check

Stated so the checker is not oversold:

- Whether a filter matches any row. `pinned=eq.maybe` is well-typed and
  matches nothing.
- Whether the CSS makes the state visible. That is the visual battery's job
  and needs a rendered page.
- Whether a reduce's conclusion is right. That is `tests/pairs.yaml`'s job,
  which remains unbuilt.
- Whether a region's `keep` is the right number, or a screen's states are the
  ones it can actually reach. The `paths` map claims those; nothing walks them
  without a browser.

## Where it hooks, and what it costs

`lint`, as a rule beside `screens` and `bijection` in the emitted `.say.yaml`
— the loop's existing seam, no new verb. It reads two files per screen and one
`cue export`; the prototype ran the whole tree in under two seconds with no
network and no Docker. `--allow-read=.` and `--allow-run=cue`, the same
permissions `check-bijection` already has.

It should **replace** `check-screens` rather than sit beside it: the token-fork
rule is one more rule of the same kind, over the same files, and two commands
in the rulemap is two things to fail separately.

## Not the app's fault

R4 finds nothing, and that is the most interesting result here.

`terminal.cue:128` publishes five widget kinds, three of them row-backed
(combobox, select, listbox) — their items are a live region's rows. thenote's
note screen declares a combobox correctly: right kind, right parts, a nested
`data-live="label"` region for its items. It has never mounted.

`screen.js:917`, the first line of the only mount path:

    if (root.querySelector("[data-live]") !== null) return;

Every row-backed widget is silently skipped. `widget.js`'s header says as
much — *"Only field-backed kinds remain… Row-backed selection is the platform
`<select>`'s job"* — while `screen.js:902` still comments that "hydrateRegion
mounts it below", a path that no longer exists. So the terminal advertises
three kinds it cannot mount, an app used one exactly as advertised, and the
result was six visual criticals nobody could trace.

No app-side checker finds this, because the app is right. The check that
finds it is a **terminal self-check**: every kind in
`capabilities.widgets` must have a mount path, asserted where the roster is
declared. That belongs with the widget work, not here — but it is the reason
the widget tier feels untrustworthy, and it is one stale guard, not a design
problem.

## Ranked plan

1. **R5 + R1 + R7** — one new `check-assembly.ts`, absorbing
   `check-screens`'s rule. Highest value per line: R5 alone converts the most
   expensive failure mode (a region that stops rendering mid-list) into a
   lint line, and R1 and R7 are set differences over data already exported.
2. **R3 + R6** — the form rules. R3 found two real drifts; R6 is the
   browser-tier precondition and costs nothing to state now.
3. **R2** — worth doing with, not before, giving the filter grammar a single
   parse; otherwise this is the third hand-maintained reader of it.
4. **R4 plus the terminal self-check** — do them together, as the first step
   of any widget-tier work. A roster that advertises what it cannot mount is
   what makes the tier feel like a place to route around.

## Rules worth carrying

- **Two statements of one fact need a checker, not care.** This is the same
  argument as ir↔program, one rung lower, and the reason that rung is the only
  one that does not drift.
- **A rule that reports the platform's own grammar as an error is not ready.**
  Both R2 and R5 were wrong on their first draft and looked right; they were
  fixed by running them over four real apps, not by rereading them.
- **Check against published data, never a copy.** The widget roster, the text
  formats, the entity fields are all exported already. A checker that
  hard-codes any of them becomes the next thing that drifts.
