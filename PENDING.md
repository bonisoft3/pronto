# Pending

What a MEASUREMENT found and no other file states. A line leaves when it lands
or when it is refused in writing, and a refusal belongs in a dated doc under
`docs/`, not here.

The bar is that rule and not a wider one, because the wider one is how this
file became a ledger: it carried two claims that were wrong (a chord needs a
design; a mixed checkbox needs a fold) for a year of sessions before anyone
tried to build them, and each took an afternoon once someone did. It also
rotted where it was right — it listed `tier2-smoke.js` as a file on disk after
that file was deleted. Anything an ir decision, a screen or a doc already
argues is not repeated here; the shadcn catalog's own walls live on the screens
that meet them, which is where a reader is standing when the question occurs to
them.

Every claim below was checked against this tree on 2026-09-20.

## The checks that do not exist

**Nothing catches a column no screen reads.** Three appeared in one wave: a
chart's `nxt_pos`, whose reader was rewritten out from under it, and `typed` on
four menu entities, a fossil of the typeahead's first shape wearing a
one-member CEL that made it look deliberate. Each was found by hand, twice by
the same grep. The rule is decidable off the facts `derive.ts` already
extracts — a field must be bound in markup, named in a filter, an order or a
projection, be a chart's own field, or be written by one — and the same pass
catches a CSS rule matching no class on its own screen, which is the same
fossil one rung down.

**`schema-vet` at the store chokepoint.** Half of it landed: `writeLint` judges
column SPELLING against the entity's declared types over browser-tier writes,
which killed the number-vs-text class. It does not judge a VALUE — the CEL
invariants ship in `shell.yaml` and nothing enforces them — and it reads the
markup at compile time rather than standing where every write passes.

## What the visual battery cannot see

**A perpetual animation reads as a screen still moving.** `settle()`
fingerprints every element's geometry and waits for it to hold still; a
rotating square's bounding box changes with the angle, so one spinner leaves a
route reported as moving and everything measured after it measured a moving
screen. The atoms screen works around it by spinning a pseudo-element, which
the fingerprint does not walk — an app should not have to know that. Emulating
`prefers-reduced-motion` would settle every such route by construction, and it
is already what the battery means by a settled moment.

**It never hovers.** One settled moment per route, so a hover rule outranking a
state rule is invisible: pagination's did, hiding the page a reader had just
chosen until the pointer left. A second moment with the pointer on the first
interactive element catches the class.

**It measures an arbitrary moment.** It never enters a hand of truco and
reports zero criticals while a reader sees cards covering each other. The clock
that fixes it ships already — `?clock=manual` with `__prontoClock.advance(ms)`,
driven the way `apps/truco/tests/acceptance.ts` drives it — and at ~18ms per
page of checks, walking every beat costs less than one of the sleeps it
replaced.

## Open questions the whole-screen tier surfaced

- An optimistic create whose region binds a GENERATED column throws and leaves
  the screen on `network-error` after a write that succeeded.
- Screen state is decided by whichever top-level region refreshed last, so a
  screen can settle on a state its route does not declare.
- `just generate` fails in the shadcnui gallery.
- A region cannot render SVG: a `<template>`'s content is parsed as HTML, so a
  region filling an `<svg>` produces elements in the wrong namespace — present,
  carrying every attribute the binding wrote, drawn by no engine, and rendered
  happily by linkedom. Only the browser tier sees it.

## The interpreter's own

**The v2 grammar has no doc section.** `2026-08-30-machines-not-widgets.md` is
still the only machines doc, and it predates value positions, `context`,
`raise`, `after`, root-level `on:`, closure over the row and the
machine-vs-reduce curve, all of which shipped.

**The trace recorder**, its loader and replay-to-N: a trace is `{snapshot rows,
boundary-crossing inputs, pins including the ir sha}`, anchored when
gzip+base64url fits ~8KB and filed otherwise; the loader is a fixture-mode
store under the manual clock, so it runs in linkedom.

**One smoke is on disk and in no list**: `interpreter/membrane-smoke.js` is
absent from `cache-smokes` in `plugins/omnishell/.vscode/tasks.json`, so
`just test` never runs it.

**The incremental read path**: `lt`/`gt`/`gte`/`lte` are exported from the
predicate vocabulary and no translator emits them — `data-sync.js` refuses a
spec carrying one — so cursor routes still reach PostgREST;
`currentStateAsChanges` has no caller outside the vendored client, so first
paint is still a full pass.

## The ladders a second vocabulary has not won

`docs/2026-09-09-a-scale-is-a-quotation.md` refuses an app seam on `#Design`
until a second whole vocabulary exists that an app measurably lands on more
than the shipping one. Primer Primitives 11.10.0 supplies two of the nine
dimensions — `text` and `leading` quote its base typography ladder. The other
four are the measurement that would decide the rest, and each loses to what is
already there:

- `--base-size-*`, 33 steps, against Open Props' seventeen in `space`.
- `--base-duration-*` and `--base-easing-*`, 12 and 5, against Open Props'
  eighty-one curves in `motion`.
- `--borderWidth-*` against `rule`, which carries a units argument on top:
  `--borderWidth-thin` is `0.0625rem` where `--border-size-1` is `1px`.
- the `zIndex` ladder against `layer`.

`#Scale.joined` states that as a constraint: two buckets in one joining
dimension fail `cue vet`, so each argument has to be won before the
composition compiles.

## Cost, measured

**Healthcheck intervals.** Every service polls at 5s across a ~4-level
dependency chain, so most of cold boot waits for the next tick rather than for
readiness. 250ms took realworld's cold boot 16.9s → 12.5s; ~1s probably
captures most of it, and the change belongs in bayt's compose emission.

**After that, ~87% of the cold gate is cluster boot.** `check-visual.ts`'s own
header says the fixture storybook cannot host its checks because a screen there
is a 360px frame on a flex board, so geometry resolves against the board — a
framing artifact rather than a law. Fixing it moves the battery below
`integrate`, which is the only path to another order of magnitude.
