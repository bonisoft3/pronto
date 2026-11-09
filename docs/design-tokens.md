---
type: metric
title: daisyUI theme coverage
description: The finding design-tokens.test.ts prints when its reading of daisyUI's themes and its pin disagree.
---

# daisyUI theme coverage

The finding produced by `design-tokens.test.ts`, which runs under `sayt test`
from `plugins/pronto`. Every number below is what the tenth case prints when
its reading and its pin disagree: the run quoted here is one taken with the pin
removed. Where a number is not printed, it is not here.

## What is graded, and against what

The specification is daisyUI 5.7.32's theme stylesheets, vendored byte for byte
under `testdata/daisyui-5.7.32/theme/` out of the tarball whose sha512 is
recorded in `source.integrity`. The suite parses them. No published value is
transcribed anywhere, so the quotation cannot drift from its source by being
retyped, and a hash over the vendored bytes plus the daisyUI meanings the
reading quotes is pinned in the test file — not in the fixture — so editing the
fixture cannot move the number it is checked against.

The thing graded against is the **contract**: `schema.cue` and the `press`
preset inside it, reached with real `cue`. It is deliberately not
any app's emitted `design.css`: that file is generated, and grading it would
let a hand edit grant the platform roles it does not publish.

Three facts are derived rather than asserted:

- **the role census** — `cue export -e '#Design'`, the schema's own default
  field set, with each bucket's emitted prefix read out of `emit.cue`'s
  comprehensions;
- **what the design layer refuses** — measured by unifying a real `#Design`
  with the name in question and reporting what `cue` does;
- **whether a published value survives** — measured by writing all 28 of a
  theme's values into a real `#Design` and comparing what exports back, byte
  for byte.

The fixture holds only this platform's *reading*: which press role a daisyUI
token lands on, and why it departs. That reading is checked for injectivity —
two published tokens may not collapse onto one role — and every role it names
must be one the schema really publishes.

## The run

```
running 10 tests from ./design-tokens.test.ts
the specification the suite grades is the one that was pinned ... ok (9ms)
the vendored themes and the platform's reading join, and every published declaration is graded ... ok (145ms)
every role the reading names is one the design layer publishes, and no two readings claim the same one ... ok (0ms)
every role the design layer publishes is mapped or stated as pronto's own ... ok (0ms)
what the design layer refuses is measured, and it refuses only an untwinned colour ... ok (0ms)
every published value is carried into the design layer byte for byte ... ok (0ms)
the wide-gamut census is a fact about daisyUI's palette and not a loss here ... ok (2ms)
a colour the preset does not publish costs a twin, and one it does publish is rebound silently ... ok (30ms)
one preset, two appearances, no siblings: daisyUI's theme system has no seam here ... ok (38ms)
every published theme is expressible: a published name for each token, and a value that carries ... FAILED (3ms)
```

The tenth case is the finding. Its message:

```
35 of 35 published themes cannot be expressed, on the naming axis alone.

NAMES: the design layer publishes 42 roles. 9 of the 28 published tokens land on one
(--color-base-100->colors/neutral --color-base-200->colors/surface
 --color-base-300->colors/surface-muted --color-base-content->colors/primary
 --color-primary->colors/accent --color-error->colors/danger
 --radius-field->rounded/sm --radius-box->rounded/md --size-field->control/h),
and the remaining 33 ROLES are reached by no daisyUI token and are stated as pronto's own.
The other 19 are not refused by #Design — every bucket is an open map, and the probes in
this file measure that — they are simply unpublished, so each app would coin its own
spelling and nothing shared could bind to it.
  14 would go in colors, where the closed twin makes each cost a dark value too:
    --color-primary-content --color-secondary --color-secondary-content --color-accent
    --color-accent-content --color-neutral --color-neutral-content --color-info
    --color-info-content --color-success --color-success-content --color-warning
    --color-warning-content --color-error-content
  5 would go in an untwinned bucket and cost one line each:
    --radius-selector (rounded) --size-selector (control) --border (control)
    --depth (control) --noise (control)

VALUES: 980 of 980 published declarations are stored byte for byte, wide-gamut oklch
included — a bucket holds an opaque string. Storage is not the gap.
```

## The finding: the gap is a vocabulary, not a schema

`#Design`'s buckets admit any name, and `component` constrains only its values,
to `var()` references. The suite probes each one with a name it does not publish
and reports what `cue` does, and the answer is that it refuses no name — a `rounded.selector`, a `control.size-selector`, a
`colors.info`, all export. The one refusal in the whole design layer is a
colour written without its dark half: `close()` over `D.colors` makes
`dark.<name>` non-concrete and the export fails, which the suite exercises by
name for each of the unpublished colours.

So "pronto has no name for this token" is false, and the suite never says it.
What it says instead is the cost it can demonstrate:

- **the preset publishes no vocabulary for 19 of the 28 tokens.** An app can
  invent a name for any of them, and that is the problem: two apps would invent
  two, and a shared component set binds to a published name or to nothing. This
  is what makes the naming axis the whole of the failure.
- **a new colour costs a twin.** Fourteen of the nineteen are colours, and the
  closed twin means each one is two declarations — a light value and a dark
  one — in every app that wants it, forever, unless the preset grows it.
- **five sit in untwinned buckets and cost one line each.** They are cheap and
  still unpublished, which is the same vocabulary problem without the twin tax.

Adding `info` to `#designPresets.press` moves the NAMES count from 9 to 10 and
moves nothing else. That is the point of splitting the verdict onto two axes:
the run is a progress meter rather than a constant.

## The values all carry

`980 of 980`, wide-gamut `oklch()` included. A colour bucket holds an opaque
string that the emitter interpolates into `light-dark()` unchanged — press's
own shadow inks are `hsl(220 3% 15% / 3%)`, so the bucket was never
hex-shaped — and nothing downstream parses a design-layer value as a colour.
There is no storage constraint in the schema to derive a fidelity loss from,
so this suite derives none: a colour verdict that assumed hex would be grading
a rule the platform does not have.

The gamut census is kept because it is a real property of daisyUI's palette and
because it is the number that would start mattering the day the design layer
grew a colour type: **700** colour declarations, of which **128** in **26**
themes fall outside sRGB and **12** in **6** themes fall outside Display-P3.
The case that computes it asserts, in the same breath, that not one of those
values is one the design layer loses. It is an observation about daisyUI, not a
verdict on pronto.

## The theme system, established by construction

This is the gap that survives everything above, and it is four probes rather
than an argument. Each asks the schema for the seam that would hold a second
identity:

| probe | what `cue` does |
|---|---|
| `#designPresets` | publishes exactly one identity, `press` |
| `#Design & {preset: "dracula"}` | `undefined field: dracula` |
| `#Design & {dim: {...}}` | `dim: field not allowed` — `dark` is the twin, and there is no third |
| `#App.surface & {design: {press: ..., dracula: ...}}` | `design.dracula: field not allowed` |

daisyUI publishes 35 sibling identities, each pinning its own `color-scheme`,
selected at runtime by `[data-theme]` on any element and with no JavaScript.
`#Design` is one build-time preset with exactly two appearances, and the twin
mirrors every colour key and no more. 35 identities would be 35 forks. That is
why the theme probe in the carriage case has to write each theme's light half
into `dark` as well: a single-appearance identity has no twin to give.

## What each theme sets for itself

The naming loss is uniform across all 35 — it is a property of the preset, not
of any theme — so what varies is what a theme sets that press has no way to
say at all. From the same run:

| theme | scheme | what this theme sets for itself |
|---|---|---|
| light | light | `--depth: 1` |
| dark | dark | `--depth: 1` |
| cupcake | light | `--border: 2px`; `--depth: 1`; field `2rem` > box `1rem` |
| bumblebee | light | `--depth: 1` |
| emerald | light | — nothing beyond the shared loss |
| corporate | light | — nothing beyond the shared loss |
| synthwave | dark | — nothing beyond the shared loss |
| retro | light | — nothing beyond the shared loss |
| cyberpunk | light | — nothing beyond the shared loss |
| valentine | light | field `2rem` > box `1rem` |
| halloween | dark | `--depth: 1` |
| garden | light | — nothing beyond the shared loss |
| forest | dark | field `2rem` > box `1rem` |
| aqua | dark | `--depth: 1` |
| lofi | light | selector `2rem` > box `0.5rem` |
| pastel | light | `--border: 2px`; field `2rem` > box `1rem` |
| fantasy | light | `--depth: 1` |
| wireframe | light | — nothing beyond the shared loss |
| black | dark | — nothing beyond the shared loss |
| luxury | dark | `--depth: 1` |
| dracula | dark | — nothing beyond the shared loss |
| cmyk | light | — nothing beyond the shared loss |
| autumn | light | `--depth: 1` |
| business | dark | — nothing beyond the shared loss |
| acid | light | `--depth: 1` |
| lemonade | light | — nothing beyond the shared loss |
| night | dark | — nothing beyond the shared loss |
| coffee | dark | — nothing beyond the shared loss |
| winter | light | — nothing beyond the shared loss |
| dim | dark | — nothing beyond the shared loss |
| nord | light | selector `1rem` > box `0.5rem` |
| sunset | dark | — nothing beyond the shared loss |
| caramellatte | light | `--border: 2px`; `--depth: 1`; `--noise: 1`; selector `2rem` > box `1rem` |
| abyss | dark | `--depth: 1`; selector `2rem` > box `0.5rem` |
| silk | light | `--border: 2px`; `--depth: 1`; selector `2rem` > box `1rem` |

A radius ordering shown as `field > box` or `selector > box` is one an ordered
`sm`/`md`/`full` ladder cannot state whatever it is filled with, because press
orders radii by size and daisyUI orders them by element class.

## What catches a perturbation, and what does not

Five perturbations of the shape that lets a departure pass as a clean map,
plus the coverage one. Each is caught by a named case:

| perturbation | result |
|---|---|
| collapse `--color-secondary` onto `colors/accent`, already claimed by `--color-primary` | red — `colors/accent is claimed by both --color-primary and --color-secondary, which collapses two published tokens into one` |
| replace a published value with a fabricated one in the vendored CSS | red — the quotation hash moves |
| reword what daisyUI is quoted as publishing | red — the quotation hash moves |
| hand-edit `apps/jsfb/shell/design.css` to declare `--info`/`--success`/`--warning`, then record those maps | red — `--color-info: maps to colors/info, which #Design does not publish`; the artifact is not consulted at all |
| fake progress: map `--color-info` onto `colors/secondary`, a role press publishes that no daisyUI token reaches | red — `colors/secondary is both mapped and stated as pronto's own` |
| delete a published token's reading, leaving its 35 declarations undriven | red — `35 published declarations nothing graded: light/--noise, dark/--noise, …` |

The last is the coverage property this suite exists to reproduce, and it is
live rather than tautological: `driven` is filled by the grading pass as it
builds the `cue` probe, and checked against the declarations parsed out of the
vendored CSS. The two sets come from different places, which is the only way
the check can ever fire.

## What the meter reads, and what that means

Ten cases pass, and the tenth is the deliverable: a meter, pinned as an
equality on the MAPPING it reads — the nine `token->role` pairs listed in
`PINNED_NAMED` — the way `meta.design.pendingLiterals` is pinned. The suite
gates (`sayt test`'s design-tokens rule grants `--allow-run=cue` for the
probes, beside the `schema.cue` and `emit.cue` it reads), so a change that
moves the reading fails until the pin moves with it, in a diff a reviewer sees;
a reading that falls, or swaps one token for another, cannot pass in silence.

The pin is exhausted when the press preset publishes a role for all 28 tokens.
The values axis is already at `980 of 980`, asserted by its own cases.

## What this does not cover

No app is compiled, so nothing here measures a rendered page: no touch targets,
no focus order, no CLS, no overflow under a dark twin. That `light-dark()`
re-resolves when `color-scheme` flips on a frame is browser behaviour visual
lint exercises.

daisyUI's component roster — the other half of its contract — is not graded,
and "one component set holds under every published palette" is therefore
asserted nowhere. `apps/shadcnui` is already the component-roster oracle;
grading it under N themes means parameterising its design block over themes,
which the fourth probe above shows `#Design` does not admit. That is the same
gap, reached from the other side.
