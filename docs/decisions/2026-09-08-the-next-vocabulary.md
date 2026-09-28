---
type: decision
title: The next vocabulary
description: Chooses the platform's next token layer — DTCG as the format, Tailwind's namespaces as the grammar, shadcn's names as the roles — for the names a model will write, of which only the contrast grading is built.
status: accepted
---

# The next vocabulary

**A vendor is chosen for the names a model will write.** That a quoted table
grades nothing stays the rule for tests; it is not the rule for choosing. Public
code on GitHub, as a proxy for what a model has read: shadcn's `var(--primary)`
with `var(--muted-foreground)` in 899,072 files, Tailwind v4's `var(--spacing)`
in 78,080, Material 3 in 6,416, Open Props in 4,144, Utopia in 1,632, Primer's
base sizes in 1,496. So three published things become layers rather than
competing vocabularies: DTCG is the format tokens arrive in, Tailwind's
namespaces and compiler are the grammar classes are written in, shadcn's names
are the roles shared code consumes. Which values fill them is the app's.

None of it is built but the contrast grading, which omnishell's
[visual lint](../../../omnishell/docs/visual-lint.md) runs on the rendered page
in each appearance `color-scheme` claims. `#scale` still quotes Open Props and
Primer ([the design scale](../design-scale.md)), no compiler runs over template
classes, no app exports DTCG, no app declares which appearances it covers, and
`#Design.dark` still demands a twin. `apps/primer` is the reference written
against Primer's own published tokens alone.

## The decisions

- **DTCG 2025.10, two rules stricter.** Every context is closed against the
  base, and one token path has one source (DTCG takes the last occurrence — the
  silent vendor mix `#Scale.joined` already refuses). `DESIGN.md` stays the one
  declaration; a `.tokens.json` is its export, prose travelling into
  `$description`. Open Props' shadows alias two variables its bundle never
  declares, so they leave the platform.
- **Appearance is a modifier, and coverage is the app's choice while
  correctness is not.** An app claims the appearances it covers; a light-only
  app emits `color-scheme: light` and is correct. Browser-signalled axes
  (`light-dark()`, `prefers-contrast`) are selected by the emitter; everything a
  reader picks is a named theme under `[data-theme=…]`, closed the same way.
  Contrast is checked in every cell, ground × contrast × theme.
- **Roles are two tiers.** Contract roles, the names shared code consumes, are
  shadcn's (`-foreground` on-colours, `--chart-*`); app roles are open and
  closed per context, and one equal to a contract role everywhere is refused.
  Primer's role layer is refused because **a role set is an opinion**: 959 roles
  in its light theme, 876 of them GitHub's product, would make every custom
  theme a 959-value job.
- **The rungs are Tailwind v4's**, its compiler run in Deno over any theme
  (`p-4` is `calc(var(--spacing) * 4)`). Every class in a template must resolve,
  because the compiler drops an unknown one silently; a bracket value is the
  class-side literal the lint already reads; cascade layers are declared once,
  every app stylesheet in `components`, because an unlayered stylesheet outranks
  any utility. The palette ships untwinned and `dark:` twins it; pronto computes
  a default for uncovered pairs — the dark step whose contrast meets the light
  one's — which kept the WCAG band in 90.6% of 584 legible pairs where mirroring
  the step kept 55.5%. Contrast is graded on the rendered page, once per claimed
  appearance, and a non-flat backdrop is skipped rather than guessed.
- **Typography is three layers**: Tailwind's text scale, where each size carries
  its line height; shadcn's heading recipes in screens; `prose` for rendered
  markdown, its variables mapped onto roles.
- **Computation is allowed at every tier** — CUE at generation, Deno at build,
  CSS at runtime; only a literal operand is refused. A fluid rung is its
  endpoints, the emitter writing the `clamp()`; Material 3's colour engine runs
  in Deno at build to derive an identity from a seed.

Surveyed and out: Radix Themes (px only), Atlassian, Carbon and Spectrum (no
DTCG), Polaris, Pollen and Fluent (no stable release in a year), Workday Canvas
(CC-BY-ND), Utopia (least familiar names), USWDS (Sass); Primer's base layer
lost on familiarity alone, Open Props on a DTCG export valid only for colours.

## Order of work

A spike regenerated RealWorld's visual layer twice from one identity, on the
shipping vocabulary and on Tailwind with shadcn's roles. Both came out close to
each other and far from the hand-driven app: **the identity is the lever for how
an app looks, not the vocabulary**, so identity at creation matters more than
the rung swap. The Tailwind arm also named what the swap must absorb: no build
hook for an app script, test-only classes generating nothing, the ir's probe
rules losing to display utilities, fonts not servable as files, and
`@theme inline` emitting no font variables.

One transformation per pull request, nothing kept for compatibility, every app
regenerated as each lands: declared appearance; DTCG export; the shadcn role
contract; Tailwind (theme quoted by digest, compiler over template classes,
layer order, the computed dark default, text scale and `prose`, Open Props and
the Primer quotation leaving); resolver modifiers; identity at creation through
the M3 engine. Deferred until asked: the engine's CUE port, Every Layout's
primitives as `@utility`, shadcn/typeset.

## Rules worth carrying

- **Count an idiom before refusing it.** A familiar spelling refused is a tax on
  every screen a model writes.
- **A colour's contrast belongs to a pair.** A role knows its ground; a twin for
  a lone colour is tuned to an assumed one.
- **Layout is ownership, not a property ban.** Spacing between children belongs
  to the parent.
