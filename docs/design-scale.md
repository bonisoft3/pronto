---
type: concept
title: The design scale
description: "The value vocabulary beneath an app's design roles: rungs quoted byte for byte from vendored Open Props and Primer, a lint that refuses a literal wherever a rung exists, and a hatch with two checkable reasons."
---

# The design scale

An app's look is its design block: the frontmatter of its `DESIGN.md`, read
through `#Design` in `schema.cue`. It declares **roles**, the names a screen
consumes: colours with their dark twins, radii (`--r-*`), spacing (`--sp-*`),
motion, control geometry, measures, type and the component tier. Beneath the
roles is the **scale**, `#scale`: one ladder of values per dimension, the same
in every app. The emitter writes roles under `:root` and rungs under
`:where(html)` in `shell/design.css`. A lint refuses a literal wherever a rung
of the same dimension exists, and the quotation rules hold every rung equal to
the vendored bytes under `scales/` it was drawn from. The normative statement is
[SPEC's lint 15](../SPEC.md#lints). Where the vocabulary goes next is
[the next vocabulary](decisions/2026-09-08-the-next-vocabulary.md).

## Roles and rungs

Colour is the dimension where discipline holds, because a role exists for it:
`apps/shadcnui`'s stylesheets carry no hex literal. Where a vocabulary runs
out, the author, human or model, answers with a number that looks right. The
fix is a name, and whether it is a role or a rung is the design:

- **A role is a decision.** It lives in the app's block, carries its own value,
  and may alias another role but not a rung. An aliased rung would win its
  norm, drop out of what the lint can name in that app, and let a vendor's
  release move the app's identity. `--control-*`, `--measure-*`, `--c-*` and
  `--shell-*` publish no step: they are decisions a literal is never refused
  toward.
- **A rung is not a decision.** `#scale` has no app seam. A length the scale
  lacks is named as a role in the app's own block, which is what `control`,
  `measures` and `type` exist for, and what keeps the scale from becoming a
  junk drawer.

**A scale stays coarser than the author's imagination.** Classify literals by
the property they sit on before designing anything. In the corpus this scale
is read off, shadcnui's 892 px literals, 41% are rule widths (`1px` and `2px`),
then spacing, control geometry, shadows and measures, and the apparent gaps at
6, 10 and 12 px are one unnamed compound (a table cell's inset, a control's
height spelled seven ways), not three missing rungs. Rungs 2 px apart would rename all of it and name none
of it.

## What the scale is made of

| bucket | source | dimension |
|---|---|---|
| `size` (`--size-*`) | Open Props | `space` |
| `border` (`--border-size-*`) | Open Props | `rule` |
| `ease` (`--ease-*`) | Open Props | `motion` |
| `layer` (`--layer-*`) | Open Props | `layer` |
| `ratio` (`--ratio-*`) | Open Props | `ratio` |
| `text` (`--base-text-size-*`) | Primer Primitives | `text` |
| `leading` (`--base-text-lineHeight-*`) | Primer Primitives | `leading` |
| `shadow` (`--shadow-*`) | pronto: geometry over the ink roles | `opaque` |
| `min` (`--min-*`) | the terminal's measured floors | `opaque` |

Radius and motion times have no bucket; they are roles (`--r-*`,
`--motion-*`). A bucket earns its place by refusing a real share of the corpus
and by offering a name that carries an argument the literal did not. Type is
Primer's on step economy: over the 484 `font-size` literals the rule reads,
Primer's six steps join 215 and Tailwind's thirteen join 216, one occurrence
for seven more names. Leading ties, and follows its sizes from one vendor
rather than splitting a designed pair.

Only values come in. A name a vendored file declares is either admitted into a
bucket or refused with its reason in that tree's `admitted.json`: Open Props'
pixel and fluid sizes, its radii (a role here), `--shadow-color`; Primer's
weight ladder, the identity function on the specification's own numbers
(`--base-text-weight-semibold` is `600`). What is not vendored is not a
vocabulary: Open Props' animations (shorthands unusable without the keyframes
beside them), its theme layers, `@custom-media`, and its colour ramps, since a
missing colour is a role, and 247 grey and hue rungs would invite
`var(--gray-7)` wherever one is missing.

## Dark twins

`#Design.dark` is closed over `colors`, so a missing twin and an orphan twin
are both errors. A scale beneath the roles keeps that closure because nothing
in it has an appearance:

- A rung whose value carries a colour is an error.
- Elevation is decomposed. Open Props' `--shadow-color` and
  `--shadow-strength` are no `<color>` that `light-dark()` can twin, so the
  strengths are pre-composed into seven ink roles (`#shadowInks`), which every
  preset declares in both halves, and the shadow rungs reference them.
- Every `var()` either emitted block writes names a token one of the two blocks
  declares, so a dangling reference is an error rather than a declaration that
  silently fails to apply.
- Each app's `:where(html)` is held equal to `#scale` both ways, and a token
  declared under any third block is an error, so no `[data-theme]` or `.dark`
  fork can exist.

## The literal lint

`styles.ts` reads each literal's dimension from the property it sits on and a
rung's from its bucket, compares both in a normal form (`norm`: easings,
layers, ratios and leadings have no px), and joins them in `invariants.sql`.
Lengths normalise through `ROOT_PX = 16`, so a `font-size` on the root is an
error no hatch excuses: it would silence every rem comparison at once. Both
sides of the join come from one `cue export`, never from the emitted
`design.css`, which could be stale or missing and yield zero findings; and an
empty rung or declaration table is itself an error, because a rule whose fact
table can be empty reads as green.

A `box-shadow` with a literal colour reports, because ink roles exist. `em`
is refused in `rule`, `radius` and `text`, and untracked in `space`, where
`padding: 0.25em` is typographic rhythm. The rule reports at `warning` until
every app reports zero; scoping it per app would be a loophole.

**An escape hatch is honest only if its reasons are checkable.** Both of
[SPEC's](../SPEC.md#lints) are: `derived` claims arithmetic on a token, which
is why its block must reference one, and `pending` is counted with equality,
so debt only goes down, in a diff a reviewer sees.

**A coupled system migrates as one change.** `switch.css`'s track, padding,
border, thumb and `translateX(20px)` (40 − 20) are one arithmetic system;
migrated value by value, the thumb leaves the track while the one value that
had to change is booked as unchanged, and no gate sees a transform escape its
parent's box. And a migration targets the reference, not the nearest rung:
snapping shadcnui to proximity walks it away from shadcn's own `h-9`, `h-8`,
`size-4` and `w-11`.

## The quotation

A vocabulary typed into `schema.cue` under a comment naming its tarball has
that comment as its whole provenance. A generator cannot be proven to have read
a file; its output can be proven equal to the file, continuously, in the lint.
`check-facts.ts` parses the vendored stylesheets under `scales/` with the same
parser that reads `design.css`, into `vendor_declaration`, `vendor_source` and
`vendor_exclusion`, read at query time and never snapshotted into
`facts.json`. Five rules in `invariants.sql`, all errors, each joined on
(source, token), because every vendor spells `--text-*`:

1. **The quotation.** A rung equals the declaration its bucket's source makes.
2. **The witness.** A quoted source declares every name published from it, so
   a rung invented under a vendor's prefix is not graded by nothing.
3. **The contradiction.** A tree cannot both refuse a name and publish it.
4. **The admission.** Every name a composed source declares is published or
   refused, so quoting nothing does not satisfy the quotation.
5. **The provenance.** A source claiming an archive has one on disk.

The witness and the admission exempt a source only when no vendored tree
answers its name, never because of its `kind` label: a label is one plausible
line away from buying an exemption, which is why `#Source` pins an `own`
source's version to `"this repository"`. Changing one byte of
`scales/open-props-1.7.23/sizes.min.css` fails `lint` in every app, naming the
rung.

**The taxonomy is data.** A rung's token is its bucket's `prefix` plus its key,
and its dimension is its bucket's, so nothing classifies a name by scanning
prefixes in emission order, which nested vocabularies (`--font-` inside
`--font-size-`) would break. `#Scale.prefixes` makes two buckets under one
prefix a conflict. `#Dimension` is closed, and `styles.ts` raises on a member
with no `norm()` case. A vendor's spelling, camelCase included, is kept so a
release bump reads as a diff.

**Refreshing a vendor** is `scales/refresh.ts`, the only step that reaches the
network: it re-fetches the archive `source.json` names and verifies its digest.
`scales/build.ts` then writes the tree's `.cue` offline from the checked-in
bytes. Neither is trusted; the quotation rule is what proves the result.

**Two vendors compose one vocabulary, per dimension.** `#Scale.joined` makes two
buckets in one joining dimension a conflict, since nothing would say which name
a rule should teach. There is no `scale:` on `#Design` and no registry: that
seam is added when a second whole vocabulary exists that an app measurably
lands on more than this one ([pending](../PENDING.md#the-design-scale)).

## Grading the roles

omnishell's `test/design-tokens.test.ts` grades daisyUI's 35 themes against
pronto's role set, with verdicts derived from the schema's export rather than a
hand-written column, since copying an oracle's columns grades only the
fixture's consistency with itself. What it finds is what the role set cannot
name ([its finding](../../omnishell/test/design-tokens.md)). What must hold in
every app (one scale everywhere, no colour in it, no appearance fork) lives in
`invariants.sql` and `derive.ts --self-test` instead, because an app's design
block is outside omnishell's CI filter, so a change there would never trigger
it.

**Layout is what a vocabulary cannot constrain.** A defect spelled in tokens
passes this lint. The two escapes cheapest to reach for, `overflow: hidden` and
`opacity: 0`, are measured by [visual lint](../../omnishell/docs/visual-lint.md)'s
`clipped-content` and `focusable-but-invisible`; the answer is that spacing
between children belongs to the parent.

## Rejected

- **A finer scale** — rungs 2 px apart rename every literal and name none.
- **An app seam on `#scale`** — a scale per app is a preset, and a length an app
  needs is a decision, which is a role.
- **A second whole scale beside the first** — Tailwind as a second vocabulary
  publishes no space, border-width or z-index ladder: it would add 172
  font-size findings and silently retire 467 of shadcnui's 475, with no guard
  firing. Plurality has to be proven in the configuration that ships.
- **Colour ramps as rungs** — a missing colour is a role; a ramp is a reason
  never to name one.
- **`physical` as a hatch reason** — it is the argument for every
  `border: 1px solid`, and a reviewer who accepts it there cannot refuse it for
  the 41% of the corpus that is rule widths. `vendor` has no site to apply to.
- **Reading the emitted `design.css` for the rungs** — a stale or missing file
  yields zero findings, a silent pass.
- **Provenance by digest at refresh, a fixture hash, or regenerate-and-diff** —
  each proves determinism, and each passes forever for a generator with a
  hardcoded table.
- **Exempting a source by its `kind`** — a label a line can change is a label
  that can buy an exemption.
- **Classifying a token by the first matching prefix** — nested vocabularies
  make the answer depend on emission order.
- **Quoting a vendor through its DTCG export** — DTCG cannot carry the bytes:
  15 of Open Props' 81 easings have no type, and `16/9` degrades to a float.
- **Migrating a coupled system value by value, or snapping to the nearest
  rung** — the first breaks the arithmetic, the second walks away from the
  reference an app reproduces.
