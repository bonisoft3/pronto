# A palette is not a design system

The design block names eight colours, three radii, four spacings and four
motion values. Colour is the one dimension named properly, and colour is the
one dimension where discipline held: **zero hex literals across 34 stylesheets
in `apps/shadcnui`.** Everywhere else the vocabulary ran out and the author
invented a number.

That is not a discipline problem. It is what a primitive layer exists to
prevent, and its absence is why an LLM authoring pronto screens produces
arbitrary values: asked for a hairline, a control inset or an elevation, there
is nothing to reach for, so it reaches for a number that looks right.

This says what enters, what is refused, what changes, and — from the two
oracles at the end — what the design block still cannot say.

## Facts not to re-derive

Measured in this tree on 2026-09-08 over `apps/shadcnui/shell/{screens,shared}`,
comments stripped, classified by the CSS property each literal sits on.

- **892 px occurrences, 40 distinct values.** 595 of them are under 8px, which
  is the smallest spacing token.
- The population is **not** spacing. `RULE` (border widths, outline, outline-offset,
  text-underline-offset) is **365** — 41% of the corpus, `1px`×201 and `2px`×152.
  `SPACE` is 319, `CONTROL` (width/height ≤64px) 125, `SHADOW` 30, `MEASURE`
  (>64px) 29, `FX` 16, `CUSTOM` 6, `RADIUS` 2.
- **Radius already won.** 183 `--r-*` uses against 2 raw px. The role layer
  works wherever it exists.
- **No shadow token exists anywhere in the platform.** 13 raw `rgb(0 0 0 / N%)`
  box-shadows at five elevations — 8/10/12/14/18% — which is Open Props'
  `--shadow-1..6` ladder rederived by hand.
- **Open Props is already in the tree.** `apps/xpense/shell/shared/easings.css`
  vendors `open-props@1.7.16/easings.min.css` verbatim, 81 tokens, byte-identical
  to 1.7.23's (5504 bytes both). Ten screens consume `--ease-spring-*` from it.
  It sits in `shell/shared/`, which the token lint never scans.
- **`em` is 89 occurrences** across the corpus, 21 of them in
  `apps/realworld/shell/screens/article.css` as correct typographic rhythm.
- **The rendered-page battery is advisory.** `check-visual.ts:15` — "Only
  `critical` exits non-zero" — and `checks/touch-targets.ts` reports at `major`
  and early-returns above a 768px viewport.

## 892 is not one population, and that decides everything

The obvious reading of 595 sub-8px literals is a missing rung between 4 and 8.
That reading is wrong twice over, and both errors would have produced a scale
that made things worse.

**First: the dominant class is rule widths, not spacing.** `--border-size-1: 1px`
and `--border-size-2: 2px` are exact, so 353 occurrences — 40% of the whole
corpus — are a pure rename with no design content at all.

**Second: the apparent gaps at 6px, 10px and 12px are one unnamed compound,
not three missing rungs.** Block-level co-occurrence, measured rather than
assumed: `padding: 6px 10px` appears in **19 blocks, 11 of them the state-matrix
footer** (`.matrix th, .matrix td` — a table cell, once per screen), and only 5
also carry `min-height: 36px`. Meanwhile the 16 blocks that *do* declare
`min-height: 36px` use **seven different horizontal insets**: `6px 10px`×3,
`6px 16px`×3, `padding-inline: var(--sp-md)`×4, `var(--sp-sm)`, `var(--sp-lg)`,
`0 6px`, `0 10px`, `0 var(--sp-md)`.

So there is no single control box to name — there is a table cell, and a control
whose inset the corpus already spells three different ways, one of which is
`var(--sp-md)`. Extending the size ladder to hold 6, 10 and 12 would have
renamed all of it and named none of it. **A ladder whose steps are 2px apart
imposes no discipline; it only makes you spell your literal differently.** The
scale must stay coarser than the author's imagination or it is not a scale.

## Two namespaces, and the scale is not a preset

Semantic **roles** stay the binding contract screens consume. A **scale** is
published beneath them: the vocabulary an author reaches for when no role fits,
which is exactly the case that today produces an invented number.

The scale is `#scale`, a **sibling** of `#designPresets`, not a key inside it.
A preset is an identity — exactly one is selected, and `preset: "open-props"`
would mean *losing* press's identity while press lost the vocabulary its own
tokens are spelled in. A scale is what every identity is spelled in.

`#scale` in `schema.cue` is the composition, and its comments carry each
bucket's argument: Open Props 1.7.23 for size, border widths, easings, layers and
ratios; Primer 11.10.0's base ladder for type size and leading; pronto's own
shadow geometry over twinned inks; and the terminal's measured floors. A quoted
bucket carries its archive's URL and integrity, and 128 names reach jsfb's rung
block today. Emission is mechanical — `for k, v in` a bucket, under its prefix —
so **the emitted name is the upstream name** and a vendor release is a
`curl | diff` against the generated files under `scales/`, with no mapping table.
That claim is load-bearing and it is why `--inner-shadow-0` is dropped: under a
`--shadow-` prefix the key `inner-0` renders `--shadow-inner-0`, which is not an
upstream name, and nothing in the measured corpus needs an inner ring.

Roles gain two buckets, seeded exactly as `motion` is:

```cue
	// Lengths a screen reaches for by role rather than by rung. sm/md/lg/xl
	// orders spacing by size and says nothing about which BOX gets which, so
	// a control's geometry had no name and became a number. This is that name.
	control: [string]: string
	control: {for k, v in D._preset.control {(k): *v | string}}
	// Page-level widths. Identity, not scale: no vocabulary contains 720px,
	// and pretending one does is how a measure stays a bare number. press
	// declares none, so every entry here is the app's own.
	measures: [string]: string
	measures: {for k, v in D._preset.measures {(k): *v | string}}
```

**Press's spacing stays px literals.** Three of its four values are exactly a
rung, and that is evidence the roles were already right, not a reason to make
them indirections. Rewriting them as `var(--size-N)` would silently convert six
apps' `--sp-*` from device px to rem — identical at a 16px root, not identical
above it — while `apps/realworld/program.cue:84` and `apps/thenote/program.cue:81`
declare `spacing` concretely and would keep the literals, forking the corpus on
the very role that was supposed to demonstrate the two namespaces meeting. The
worked example of a role resolving into the layer beneath it is
`--control-pad-x: var(--sp-md)` — a role pointing at a role — and the app-level
`--measure-*` block.

## How the closedness survives

The guarantee is `dark: close({for k, _ in D.colors {(k): string}})`. Four
mechanisms keep it, in order of how much work each does.

**The scale is not in `colors`, and has no app seam.** `#scale` is read by the
emitter directly, never through `E._design`; there is no `scale:` field on
`#Design` and no `#scalePresets` selector. An app cannot revalue a step, add
one, or opt out. Zero Open Props colour ramps are admitted, so nothing wants a
twin. And "platform-owned" is a check, not a claim: an invariant holds each
app's emitted `:where(html)` block equal to `#scale` name for name and value for
value. That is what makes the block the same in all eight, and unlike a
cross-app comparison it is a check a per-app lint can actually make — it also
catches the one remaining seam, an app-added rung publishing a step to the lint
that the CSS never declares.

**The one dimension with a real appearance is decomposed so the closure gets
stronger.** Open Props' shadows carry a genuine dark story —
`@media (prefers-color-scheme:dark){--shadow-color:220 40% 2%;--shadow-strength:25%}`
— and it cannot pass through `light-dark()`: `--shadow-color` is a bare
`220 3% 15%` component triple and `--shadow-strength` a percentage, and neither
is a `<color>`. So the strengths are pre-composed into seven finished colours
declared as **roles** in `colors`/`dark`:

| role | light | dark |
|---|---|---|
| `shadow-ink-3` | `hsl(220 3% 15% / 3%)` | `hsl(220 40% 2% / 27%)` |
| `shadow-ink-4` | `hsl(220 3% 15% / 4%)` | `hsl(220 40% 2% / 28%)` |
| `shadow-ink-5` | `hsl(220 3% 15% / 5%)` | `hsl(220 40% 2% / 29%)` |
| `shadow-ink-6` | `hsl(220 3% 15% / 6%)` | `hsl(220 40% 2% / 30%)` |
| `shadow-ink-7` | `hsl(220 3% 15% / 7%)` | `hsl(220 40% 2% / 31%)` |
| `shadow-ink-8` | `hsl(220 3% 15% / 8%)` | `hsl(220 40% 2% / 32%)` |
| `shadow-ink-10` | `hsl(220 3% 15% / 10%)` | `hsl(220 40% 2% / 34%)` |

A missing twin is a non-concrete `dark.<name>` and `cue export` refuses to write
design.css. An orphan twin is rejected by `close()` — verified, `field not
allowed`. No second appearance block enters the emission, and
`.screen[data-state$="-dark"] { color-scheme: dark }` re-resolves the inks along
with everything else, so both shadow appearances are reviewable on one device.
`--inner-shadow-1..4` and `--inner-shadow-highlight` are dropped: the highlight
is a shadow *list* with its own upstream twin, so it cannot be twinned by
`light-dark()`, and decomposing it would put geometry in the colour namespace.

**The scale→role direction is closed too, and this is the trap.** Every
`--shadow-*` value is `var(--shadow-ink-N)` — platform-owned geometry depending
on an app-overridable role. A second preset that omits the inks exports cleanly
and emits `--shadow-1: 0 1px 2px -1px var(--shadow-ink-10)` with nothing
declaring it: the box-shadow is invalid at computed-value time and every
elevation silently disappears. The fix is to require the ink names in
`#designPresets`' own pattern constraint:

```cue
#designPresets: [Name=string]: {
	colors: [string]: string
	colors: {for n in #shadowInks {(n): string}}
	dark: [string]:   string
	dark: {for n in #shadowInks {(n): string}}
	// …
}
```

Verified: an omitting preset now fails at export with `incomplete value string`
on all seven names in both halves, and press still exports. Generalised, an
invariant asserts **every `var(--x)` in the emitted `:where(html)` block names a
token the `:root` block or that block itself declares** — the ten
`--ease-elastic-*`/`--ease-squish-*` aliases reference steps inside the rung
block, so the narrower form would have refused them. It closes the direction for
anything added later, not for shadows only.

**A colour cannot re-enter the scale.** A declaration in the rung block whose
value contains a colour literal is an `error` — the `--shadow-*` and `--ease-*`
names are where it would happen, and the rule is written against the block
rather than those prefixes because the twinned inks are `--shadow-ink-*` roles
in `:root` and must keep their colours. A colour in the scale is how the
closedness would be lost, so the CSS says it cannot be there.

## The value policy

Four policies, applied per value, and the honest split is: adopting the scale
**renames** most values, **names** a large second group as roles, and **changes**
a small enumerated third group.

- **RENAME** — the value already equals a rung. 591 occurrences. Zero delta.
- **ROLE** — a repeated design decision with no name. Zero delta; the number
  moves from N sites to one.
- **CALC** — arithmetic on a token. The negatives, three centring insets. Zero delta.
- **MOVE** — a deliberate visual change, storyboard-adjudicated.

`--size-*` is the **rem** ladder, not `--size-px-*`. At the 16px root every
browser ships — and no app or the emitter sets `font-size` on `html`/`:root` —
every RENAME is pixel-identical today. Above it, spacing scales with the user's
setting where before it did not. That is the reason rem was chosen and it is
named rather than hidden; the `ROOT_PX = 16` coupling the lint depends on is
itself guarded by an invariant refusing `font-size` on the root. Rules stay px:
a hairline is a device measure and a 1.5px border is a rendering artefact.

### The migration unit is the coupled system, not the value

This is the correction that matters most, because getting it wrong is the only
irreversible breakage in the whole change. `apps/shadcnui/shell/screens/switch.css`
is one arithmetic system: track `44×24` with `padding: 2px` and `border: 1px`
gives a `40×20` content box; thumb `18×18` plus `1px` border is `20` outer;
travel is `translateX(20px)`, which is exactly `40 − 20`. Treat those as five
independent rows and the track content box goes 38→30 while the thumb outer box
goes 20→22 with the travel still hard-coded — **the thumb leaves the track**, and
the one value that must change is the one a per-value table books as unchanged.
No mechanical gate can see a transform escaping its parent's padding box.

So: before any MOVE, enumerate the systems whose literals are arithmetically
dependent — the switch, the checkbox glyph (`--cb-box: 18px` with a `4×8` tick
at `margin-top: -2px` over two 2px borders, and a `9×2` mixed bar), the spinner
`--ring`, `--otp-*`, `--cb-box`, chess's board arithmetic. Each migrates as one
atomic commit with the arithmetic re-derived off a single named role, or takes a
`derived` claim and is expressed as `calc()`. The scanner refuses a MOVE in a
block that also carries a `transform`/`translate` literal.

### The reference is the reference, not the nearest rung

`apps/shadcnui/DESIGN.md` argues that "shadcn's palette is not a taste; it is a
contract thousands of interfaces already build on." Snapping to the nearest Open
Props rung walks away from that contract in four places. The MOVE target is
shadcn's own value: `.ig-input` 34→**36** (`h-9`), `.toggle-group` 26→**32**
(`h-8`), `--cb-box` 18→**16** (`size-4`), and the switch's `44px` track
(`w-11`) **stays**. Nor does press inherit `pad-x: 10px` / `pad-y: 6px` — neither
is a shadcn value at any size, while the corpus already spells the correct inset
as `var(--sp-md)` (16px = `px-4`) in four places. `--control-pad-x` is
`var(--sp-md)`, and the 10px sites are the ones that move.

### Per-value decisions

40 distinct values, negatives collapsed into one row.

| px | occ | dominant class | policy | target | delta |
|---|---|---|---|---|---|
| 1 | 220 | RULE 201, CONTROL 9, FX 5, SHADOW 3, SPACE 2 | RENAME | `--border-size-1` | none |
| 2 | 181 | RULE 152, SPACE 17, FX 7, SHADOW 3 | split | RULE/FX/SHADOW/CONTROL 163 → `--border-size-2`; SPACE 17 → `--size-1` MOVE; RADIUS 1 → `--r-sm` | 18 sites |
| 3 | 6 | RULE 3, SPACE 2, RADIUS 1 | MOVE | 3→2 rule, 3→4 space, → `--r-sm` | 6 sites |
| 4 | 121 | SPACE 114, SHADOW 4, CONTROL 3 | RENAME | `--size-1` | none |
| 5 | 4 | SPACE 4, padding on a 28px control | ROLE | `--control-pad-y-sm` | none |
| 6 | 63 | SPACE 63 | split | padding 38 → `--control-pad-y`; margin/gap 25 → `--size-2` MOVE | 25 sites |
| 8 | 69 | SPACE 54, CONTROL 10, SHADOW 5 | RENAME | `--size-2` | none |
| 9 | 1 | CONTROL | MOVE | `--size-2` | 1 site |
| 10 | 32 | SPACE 28, CONTROL 4 | MOVE | control padding → `--control-pad-x` (=16px, shadcn's inset); other 8 → `--size-2` | 32 sites |
| 11 | 3 | SPACE, centring in a 36px control | CALC | `calc((var(--control-h) - <box>) / 2)` | none |
| 12 | 32 | SPACE 18, CONTROL 8, SHADOW 6 | split | cell padding → `--cell-pad-x`; SHADOW → `--shadow-*`; gap/inset 3 → `--size-3` MOVE | 3 sites |
| 14 | 6 | SPACE 4, CONTROL 1, CUSTOM 1 | ROLE | tab inset role; `--ring` keeps its value | none |
| 15 | 1 | CUSTOM (`--cb-box` arithmetic) | CALC | off `--control-h-sm` | none |
| 16 | 8 | CONTROL 4, SPACE 3, FX 1 | RENAME | `--size-3` | none |
| 18 | 4 | CONTROL 3, CUSTOM 1 | MOVE | **16** (`size-4`), with the checkbox glyph re-derived | 4 sites, coupled |
| 19 | 1 | SPACE (inset) | CALC | off `--control-h` | none |
| 20 | 2 | FX 1, CUSTOM 1 | RENAME | `--size-4` | none |
| 22 | 2 | CONTROL (a badge) | ROLE | `--badge-min: 22px`, value kept | none |
| 24 | 32 | CONTROL 26 (21 `min-height`), SHADOW 5, CUSTOM 1 | ROLE/RENAME | `var(--min-touch)`; lengths → `--size-5` | none |
| 26 | 2 | CONTROL | MOVE | **32** (`h-8`) | 2 sites |
| 28 | 6 | CONTROL 5, SPACE 1 | RENAME/ROLE | `--size-6` / `--control-h-xs` | none |
| 30 | 2 | CONTROL 1, CUSTOM 1 | MOVE | `--size-7` | 2 sites |
| 32 | 17 | CONTROL 14, SHADOW 3 | ROLE | `--control-h-sm: 32px` | none |
| 34 | 3 | CONTROL | MOVE | **36** (`h-9`) | 3 sites |
| 36 | 17 | CONTROL 17 | ROLE | `--control-h: 36px` | none |
| 38 | 1 | CONTROL | MOVE | `--control-h` | 1 site |
| 40 | 9 | CONTROL | ROLE | `--control-h-lg: 40px` | none |
| 44 | 1 | CONTROL (switch track, `w-11`) | ROLE | `--switch-track-w`, value kept, system re-derived | none |
| 96 / 180 / 254 / 260 / 360 / 420 | 10 | MEASURE | ROLE | app `--measure-*`, values kept | none |
| 160 / 320 | 2 | MEASURE | RENAME | `--size-12` / `--size-14` | none |
| 720 | 18 | MEASURE (all `max-width`) | ROLE | `--measure-page: 720px` | none |
| −1 / −2 / −4 | 16 | RULE 9, SPACE 5, FX 2 | CALC / RENAME | `calc(var(--border-size-N) * -1)`; −4 → `--size-00` | none |

The residue is the MOVE class, and every member is a value chosen once in one
place that no other place shares — the definition of an invented number.
Exempting them forever would leave the vocabulary with a permanent hole and the
lint with a permanent allowlist. The `gap: 2px` case is the most arguable and
the most instructive: in the same stylesheets 2px is *also* the focus-ring
width, so the author reached for one number for a gap and for a rule, which is
exactly the confusion a scale prevents. Adding `--size-0: .125rem` to keep it
would put two rungs 2px apart at the bottom of the ladder — the half-step
policy this design rejects everywhere else.

### How a visual change is reviewed

There is no screenshot baseline in this repo; `check-visual.ts` measures
geometry, not pixels, and it reports at `major` so it cannot gate. Two things
follow.

The human surface is `just launch`, then `?storybook`, which renders every
storyboard state as a figure including the `-dark` frames. That surface must
itself be on the tokens — `interpreter/storybook.js` currently appends a
`<style>` with `#6C7278`, `#d8d5cf`, `#0B7A5A` and an `8px` radius that agrees
with no preset. It is the one place a human judges the design, so a frame border
disagreeing with `--border` is actively misleading. It also cannot host geometry
checks (every geometry check there resolves against the board), so geometry
deltas are reviewed by `just integrate` on real pages at the battery's 400px
narrow frame.

The mechanical surface is a **checked-in finding baseline**, diffed per commit.
That is the only way an advisory battery gates, and it replaces every
"must not regress" that assumed an exit code. The 22px badge is not a bug fix
in disguise: it is outside `touch-targets.ts`'s interactive selector set and the
check early-returns above 768px, so it keeps its value under a `--badge-min` role.

## The lint: refuse a literal where a step exists

Without this the scale is a suggestion. With it, it is a capability boundary,
and it is decidable off the CSS the derive already reads.

```sql
-- CLOSED against CLOSED. The scale block publishes a length under a name; a
-- stylesheet that writes the same length as a literal in the same dimension
-- has a second copy of a value the scale already owns, and the two will not
-- stay equal. The rule fires only where a step EXISTS, so a value the
-- vocabulary has no name for is not a finding — extending the scale is what
-- extends this rule, which is why adding a step is a decision.
SELECT DISTINCT 'error', l.path,
       l.value || ' in ' || l.prop || ' is ' || s.token
         || '. Consume it with var(' || s.token || ').'
FROM app_literal l
JOIN scale_step s ON s.norm = l.norm AND s.dimension = l.dimension
WHERE NOT EXISTS (SELECT 1 FROM literal_exception e
                  WHERE e.path = l.path AND e.line = l.line)
```

**`norm`, not `value_px`.** Four of the eight dimensions have no px value at
all: easings are `cubic-bezier(…)`/`linear(…)` strings, layers are unitless
integers, ratios are `16/9`, and a leading is a unitless multiplier. Easings additionally need whitespace-insensitive
comparison, because press writes `cubic-bezier(.2, 0, 0, 1)` and Open Props
writes `cubic-bezier(.25,0,.5,1)`. So `norm` is a per-dimension normal form,
stated in `styles.ts` beside `ROOT_PX`: integer px for lengths, integer ms for
times, whitespace-stripped lowercased function text for easings, the raw token
for layer and ratio.

**Both sides come from the cue export, not from parsed CSS.** `derive.ts` already
exports the program; `#scale` is platform data the emitter owns. Reading the
emitted `design.css` instead would inherit `derive.ts:507`'s
`.catch(() => "")` — a missing or stale file yields an empty step set and the
rule reports zero findings, a silent pass indistinguishable from compliance for
the one rule whose whole value is that it cannot be silenced without a trace.
`count(scale_step) = 0` is an `error`.

**Dimensions are two closed maps, not one.** A property→dimension map decides
what a literal is; a token→dimension map decides what a step is, and without the
second, press's `--sp-xl: 40px` and `--control-h-lg: 40px` both match
`padding: 40px`.

| dimension | properties | step tokens |
|---|---|---|
| `rule` | `border*-width`, the length slot of `border`/`outline` shorthands, `outline-width`, `outline-offset`, `text-underline-offset` | `--border-size-*` |
| `space` | `margin*`, `padding*`, `gap`, `*-gap`, `inset*`, `top`/`right`/`bottom`/`left`, `scroll-*`, `translate` | `--size-*`, `--sp-*` |
| `radius` | `border-radius`, `border-*-radius` | `--r-*` |
| `motion` | `transition-duration`, `animation-duration`, the time and easing slots of their shorthands | `--motion-*`, `--ease-*` |
| `layer` | `z-index` | `--layer-*` |
| `ratio` | `aspect-ratio` | `--ratio-*` |
| `text` | `font-size`, a fluid size exempt | `--base-text-size-*`, `--type-*` |
| `leading` | `line-height` | `--base-text-lineHeight-*`, `--type-leading-*` |

Everything else — `--control-*`, `--measure-*`, `--shell-*`, `--min-*`, colours —
contributes no step. **A role beats a rung in the message**: where two steps
share a norm in one dimension the finding names the role, because an author
should reach for `--sp-md` before `--size-3`. One level of same-file `var()`
indirection is resolved when building `scale_step`, so a role defined as a rung
is still joinable under its own name.

Two dimensions where matching by value is the wrong test. **Elevation**: a
shadow list is not a length, so `box-shadow`/`text-shadow` geometry is not
joined; instead a shadow whose *colour* is a literal is an `error`, because the
ink roles exist. That is the 13 raw blacks, plus thenote's three
`rgba(28, 27, 24, …)` paper shadows which hardcode a copy of its own `--primary`.
`color-mix(in srgb, var(--accent) N%, transparent)` — realworld's and thenote's
disciplined focus rings — is clean, because its colour comes from a token.
**Colour**: a literal that equals a declared role's light or dark value is an
`error`, hex lowercased and expanded to six digits first. truco's 164 hex
literals are its own private palette and are untouched: the rule refuses a
duplicate of a published token, not the existence of a colour.

What it must not flag, deliberately: anything in `width`, `height`, `min-*`,
`max-*`, `flex-basis` — control geometry and layout measures are identity, and a
role's value is a decision the lint has no standing to police. `font-weight`
and `letter-spacing` — the one vendored weight ladder is refused and no vendored
tree names a tracking step, so there is nothing to refuse toward (`font-size` and
`line-height` are the `text` and `leading` rows above). The values with no rung —
6, 12, 14, 36 — forever, unless someone adds the rung. And at-rule preludes are not descended, so
`@media (min-width: 720px)` is not a `min-width` declaration.

**`em` is a named hole.** It is refused outright in `rule` and `radius`, where a
hairline keyed to font size is almost always a mistake. In `space` it is
untracked, because realworld's 21 uses are correct typographic rhythm and
`padding: 0.25em` on 16px text is 4px that no `ROOT_PX` can normalise.

### The escape hatch

One line, one declaration, one closed reason:

```css
/* pronto-literal: derived */
transform: translateX(20px);
```

**Two reasons, both checkable.** `derived` — the value is arithmetically tied to
another token where `calc()` cannot express it; the scanner requires the block
to reference a token, so the claim has a subject. `pending` — a MOVE not yet
adjudicated, capped by `count(pending) = code.meta.design.pendingLiterals`,
**equality, not `<=`**: fixing a site without lowering N fails, adding one
without raising N fails, raising N is a diff in `program.cue` a reviewer sees.
Debt is strictly monotone downward.

`physical` is **not** a reason, and refusing it is the point. "A device measure
with no design meaning" is exactly the argument this doc makes for keeping rule
widths in px — so a reviewer who accepts it there has no ground to reject
`/* pronto-literal: physical */` above `border: 1px solid`, which is 41% of the
corpus. `vendor` is not a reason either: `apps/*/shell/units/**` contains no CSS
and `#Screen.files.shared` admits only `^shell/shared/.*\.css$`, so it has no
site, and an unused enum value is a loophole waiting for a reader who needs one.

The hatch applies to **exactly the next declaration** — not a file, not a block,
not a range. Every use is a `literal_exception` row printed with the findings, so
the population is countable. An unrecognised reason is itself an `error`.

### The scanner's cases

`lengthLiterals(css)` and `literalExceptions(css)` live in `styles.ts` beside
`ownedTokens`, run by `derive.ts --self-test` — the platform's existing test rung,
no new seat. Against a fixture scale plus roles `{--control-h: 36px, --sp-md: 16px}`:

| css | expected | pins |
|---|---|---|
| `border: 1px solid var(--border)` | 1, `--border-size-1` | a length inside a shorthand — the dominant case |
| `padding: 6px 10px` | 0 | **no rung exists, and this is what keeps the rule usable** |
| `margin: 4px` | 1, `--size-1` | rem↔px at `ROOT_PX` |
| `gap: 1px` | 0 | dimension discipline: 1px is a rule width, never a space rung |
| `min-height: 4px` | 0 | control geometry is never a finding, even at a rung |
| `max-width: 720px` | 0 | a measure is never a finding |
| `--sp-md: var(--size-3)` + `margin: 16px` | 1, names **`--sp-md`** | the role wins the message |
| `padding: 40px` with both 40px tokens declared | 1 | the token→dimension map |
| `transition: opacity var(--motion-fast) cubic-bezier(.25,0,.3,1)` | 1, `--ease-3` | easing norm, spacing-insensitive |
| `transition: opacity 180ms` | 1, `--motion-base` | time norm |
| `z-index: 1` / `aspect-ratio: 16/9` | 1 each | non-length dimensions |
| `padding: 0.25em` | 0 | `em` untracked in space |
| `border: 0.0625em solid` | 1, the em rule | `em` refused in rule |
| `box-shadow: 0 4px 12px rgb(0 0 0 / 10%)` | 1, the ink rule | geometry not joined, colour is |
| `box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 40%, transparent)` | 0 | token-derived colour is clean |
| `--otp-pad: 4px` | 1, `--size-1` | a private token is not a hiding place |
| `--otp-pad: calc(var(--control-h) / 9)` | 0 | the intended shape |
| `@media (min-width: 720px)` | 0 | preludes are not declarations |
| `color: #09090b` where a role is `#09090B` | 1 | hex normalised |
| hatch + two declarations | 1 | covers the NEXT declaration only |
| `/* pronto-literal: physical */` | 2 | the enum is closed and `physical` is gone |
| `html { font-size: 18px }` | 1 | the `ROOT_PX` coupling is checked, not assumed |
| `:root { --sp-md: 16px }` in a screen | 2 | redeclaration and literal are independent rules |

## The migration

**An app on press that ignores the new vocabulary is computed-value-identical at
a 16px root.** Every value press publishes keeps it: both palettes byte-for-byte,
all three radii, all four motion values, all four spacings *as px literals*. The
additions are seven shadow inks and the control roles, and nothing consumes them
until an app chooses to. `apps/jsfb` (1 stylesheet, 3 literals) and
`apps/w3caria` (3 stylesheets, zero colour literals of any kind) need no change.

Five things break, and each is fixed in the change that breaks it.

**The scan is too narrow, and that is the prerequisite.** `derive.ts:506-516`
reads owned tokens from `shell/{shell,design}.css` and screen tokens from
`shell/screens/<name>.css` only. `shell/shared/*.css` is in neither set, so 26 of
truco's 29 private tokens and 85 of xpense's 93 are invisible, as are truco's 164
hex literals. The fix unions `files.shared` across screens — the set is
*declared* in the program (`schema.cue:428`), so this reads a declaration rather
than walking a directory. Enumerated consequence, not a grepped expectation: the
only tokens in the scale's namespaces anywhere outside `screens/` are xpense's 81
easings; the rest of the shared inventory is truco's `--cloth`/`--wood`/`--rim`/
`--pad*` family, chess's `--mono`/`--serif`, and xpense's `--accent-raise`/
`--primary-raise`/`--over-amt`. Zero new findings. `screen_token` becomes
`app_token`, because its `path` column now carries shared stylesheets too.

**xpense's easings must go in the same commit as the scale.** They collide 81
ways, and the specificity story inverts once the scale moves to `:where(html)`:
screen and shared stylesheets are injected as `<style>` into `document.head`
after both `<link>`s and never removed, so a sheet declaring at `:where(html)`
*ties* the scale block and wins on order. Delete the file, its six `shared:`
entries and its `@import`; the ten `var(--ease-spring-*)` sites keep working
because the names and values are the same names and values.

**`--shell-font` cannot be promoted as one token, because it carries two
contracts.** The emitter uses it as a whole `font` shorthand
(`font: var(--shell-font, 1rem/1.5 system-ui, sans-serif)`); chess uses it in the
*family* slot of its own shorthand
(`font: 600 0.6875rem/1 var(--shell-font, system-ui), sans-serif`) and works only
because the token is undeclared and the fallback is taken. Declaring it expands
chess's rule to an invalid shorthand that the browser drops entirely, silently
losing size, weight and family on the board's coordinates and the shelf's
captions. So the hook splits: `--shell-font` stays the chrome's shorthand,
`--shell-font-family` becomes the family token, and chess's three sites migrate
in the same commit.

**The emitter's own chrome literals become shell roles at their current values.**
32 px occurrences over 15 values live inside the generated `design.css` —
`gap: var(--shell-nav-gap, 20px)`, `padding: var(--shell-nav-pad, 14px 24px)`,
`.shell-who { gap: 5px }`, the login gutter's `12px`, `padding: 8px 10px`,
`z-index: 10`. Snapping them to rungs would be four unbudgeted MOVEs landing in
all eight apps including the two declared unchanged, outside any storyboard pass.
Promoting them to declared `#Design.shell` fields **at the values they already
have** names everything and moves nothing; `z-index: 10` becomes `--shell-layer`,
a role, because a chrome stacking order is a decision and not a rung. Separately,
every `var(--x, fallback)` on a token the emitter itself declares is deleted:
three of them disagree with the value they shadow — `var(--r-sm, 6px)` where
press is 4px, `var(--r-md, 8px)` where shadcnui is 10px and thenote 12px.

Per-app blast radius, in migration order: jsfb none; w3caria RENAME only; chess
RENAME plus 8 shadows plus the `--shell-font-family` migration; **shadcnui** the
measured app; thenote RENAME plus four raw shadow colours to inks; realworld
RENAME plus the corpus's widest `--measure-*` vocabulary; xpense RENAME, its 82
easings already gone; truco RENAME plus `--measure-*`, its hex palette untouched.
The rule lands as an `error` only after all eight are at zero — scoping the rule
per app would be a loophole; ordering the migration is not.

**Typography** is not Open Props': shadcnui alone writes ~300 rem type sizes over
13 distinct values, two spellings of `.875rem`, and Open Props' ladder contains
three of them. A scale nothing lands on is worse than no scale, so type is quoted
from Primer's base ladder, and `#scale`'s comment carries the measurement.
**Themes** are out of scope here: the oracle's job is to prove the gap exists and
name its mechanism, not to close it. "The next vocabulary" closes it.

## What comes in, and what refusing buys

Open Props **1.7.23** pinned. The `2.0.0-beta.*` line is stale — `beta.5`
published 2024-01-28, twenty-four months *before* 1.7.23 — and v2 collapses the
per-group split this design depends on.

| group | names | measured need |
|---|---|---|
| `--size-000…15` | 17 | 319 SPACE occurrences, 173 landing on a rung exactly |
| `--border-size-1..5` | 5 | 365 RULE occurrences — 1px×201, 2px×152 — with no name today |
| `--shadow-1..6` | 6 | 13 raw blacks at five hand-rederived elevations; no shadow token existed |
| `--ease-*` | 81 | 10 live sites in xpense, against a file the lint cannot see |
| `--layer-1..5`, `--layer-important` | 6 | z-index is the classic invented number |
| `--ratio-*` | 6 | 3 raw `aspect-ratio` values, all three a named ratio |
| `--min-touch` (pronto's) | 1 | 21 raw `min-height: 24px`, which is `TOUCH_MIN` spelled by hand |

Every refusal is a decision about what a scale is for, and each would otherwise
be N names in every app for zero uses.

`--size-px-1..15` — **the most important refusal**: a second name for the same
rung makes the lint unable to say which one to use, and the rule rests on one
name per value per dimension. `--radius-*` — radius is the dimension the role
layer already won, and the ladder (2/5/16/32/64/128px) contains neither of
shadcnui's 6px nor 10px roles. `--font-*` — type is quoted from Primer, argued at `#scale`.
The 19 colour ramps and every oklch variant — zero hex literals means colour
discipline held wherever a role existed, and the daisyUI oracle shows the missing
colour dimension is a **role**, not a rung; 247 rungs would tempt
`var(--gray-7)` where a role is missing, which is the fork the role layer
prevents. `--duration-*` — `--motion-*` covers it, and
`--duration-moderate-1` being exactly press's 180ms is evidence the motion roles
are right, not a reason to add 56 names. `--size-fluid/content/header/relative/xxs..xxl`,
gradients, masks, svg, highlights, layouts — unmeasured; revisit when a screen asks.

Refused as **rules**, and checked rather than trusted: `animations.min.css` (23
shorthands unusable without the 25 `@keyframes` beside them — the only genuinely
rule-shaped group), `media`/`supports` (`@custom-media`, not properties, and they
need PostCSS), `normalize`/`buttons`/`utilities` (element and class selectors),
and every theme layer — `theme.light.css` declares `--surface-1..4`/`--text-1`,
and Open Props UI's `theme.css` declares `--primary` and `--neutral` outright.
pronto already owns the role layer and does it in one declaration instead of two
blocks. For the record: gradients and masks are **values**, not rules; they are
refused for need, not for kind.

**Both naming conventions stay, and the emitted name is the upstream name.**
That second half is the load-bearing one: it is what makes a release bump a
`curl | diff` against the vocabulary, what lets an oracle case be seeded
verbatim, and what the quotation rule joins on. Renaming forfeits all three and
buys cosmetic uniformity.

The shape is evidence for the two-namespace distinction rather than the rule
behind it — `--r-sm: var(--radius-2)` reads correctly and `--r-sm: var(--r-2)`
reads like a typo — and it is not reliable evidence once a second vendor is
quoted: `--text-sm` and `--leading-tight` are word-shaped rungs. What keeps the
namespaces apart is the blocks they are declared in, `:where(html)` against
`:root`, and the rules over those blocks.

## The oracle: daisyUI's themes are the grader

daisyUI's real contract is a semantic token set over **35 published themes** —
one component set that must hold under every palette. That is the
`apps/w3caria` shape exactly: the specification is data, and coverage of it is
the check. It answers the question a preset cannot: can eight roles plus a
closed twin express a *theme system* rather than a single identity?

It lives in `plugins/omnishell/test/design-tokens.test.ts` with a fixture, not in
a new app. `#App.surface.design` is a **single struct**, so an app can only
instantiate one answer; grading 35 themes would need 35 apps. And
`plugins/omnishell/test/` is the only glob-discovered deno seat in the repo,
while `plugins/pronto` has no project seat at all.

**980 rows** — 35 themes × the 28-variable contract every one of them declares —
in six columns, following `Keystroke`'s discipline:

| column | meaning |
|---|---|
| `theme` | published name |
| `token` | daisyUI's published token name |
| `value` | **daisyUI's own value, verbatim; nothing here may edit it** |
| `maps_to` | the pronto role it resolves to, or `""` |
| `departs` | `no` \| `approximated` \| `unexpressible` \| `declined` |
| `why` | required whenever `departs != "no"` |

Keeping `value` and `maps_to` in different columns is load-bearing, because two
collisions would make a shared column produce a wrong "maps cleanly" verdict:
daisyUI's `primary` is a brand hue where pronto's is ink, and daisyUI's `neutral`
is a dark UI colour where pronto's is the page ground — the opposite. Rewording
our reading to match the quotation would be a diff on a column that is supposed
to be a quotation.

**The columns are not enough, and this is where copying w3caria half-way would
fail.** `Attribute` has a `probe` — a selector, not shown to a reader — and that
is the whole mechanism: it gives the claim a subject a machine can look at. A
fixture graded only on its own self-consistency passes when someone writes
`departs: approximated` with any `why`, which is precisely the lossy mapping the
exercise exists to expose. So the oracle computes two derived columns:

- **Gamut and fidelity, per colour row.** Is the value inside sRGB, which is what
  hex can store? Does substituting it into the role's `light-dark()` reproduce
  the published oklch within a ΔE bound? 128 of the 700 colour declarations are
  outside sRGB and 12 outside Display-P3, and asserting that count means a future
  move to `oklch()` storage shows up as the number going to zero.
- **Whether the twin accepts the theme, per theme.** Construct the theme's key
  set and unify a real `#Design`, asserting `close()` takes it. This needs `cue`,
  which is the honest reason to give the oracle its own script with
  `--allow-run=cue` rather than leaving the whole `test/` glob's permissions
  loose or fixturing the export.

The unexpressible set is **derived from those two**, never pinned in the test —
otherwise the test asserts the author's answer and reports a stale verdict
against a schema that has moved.

**The verdict today is that all 35 are unexpressible**, for four independent
reasons each sufficient alone. The ten `-content` foreground tokens: pronto has
zero on-colour tokens, so a screen writing `background: var(--accent)` has no
theme-safe text colour — it works under press because `accent` is a dark green
and is unreadable under `acid`, whose accent is a near-white lime. This is the
single mechanism that lets one component set survive 35 palettes.
`--color-info`/`--color-success`/`--color-warning`/`--color-base-300`: pronto has
`danger` but no `success`, two surfaces but no third. `--depth`/`--noise`,
`declined`: daisyUI answers elevation with a scalar multiplied into `color-mix`es
off the component's own background, and this design answers it with an Open Props
ladder over twinned inks — two genuinely different answers, and the fixture
records which one was taken rather than inheriting whichever oracle was read
last. And the mechanism itself: **a dark twin is not a theme.** daisyUI publishes
35 sibling identities each pinning its own `color-scheme`, selected at runtime by
`[data-theme]` on any element, with `:has(input.theme-controller[value=…]:checked)`
doing it with no JavaScript. `preset` is a CUE constant, so 35 presets would be
35 build-time forks. The radius axis is `approximated`: pronto names radii by
size and daisyUI by role, and nine published themes are non-monotone —
`radius-field 2rem > radius-box 1rem` in cupcake, forest, pastel, valentine —
which an ordered ladder cannot state.

Coverage runs the `aria.test.ts` shape, `rows.map(grade).filter(problem)`, not
the `driven` ledger, because one function grades every row. Then the reciprocal,
which makes it a bijection and not a checklist: **every role the emitted
`design.css` declares appears in some `maps_to`, or in a `pronto_only` list with
a reason** — so `--border` as a colour, `--r-full` (a pill is a Tailwind utility
outside the theme), `--motion-*` and `--measure-*` are *stated*, not silent.

Two assertions do **not** belong here, and putting them here would have made them
never run. The CI filter for `plugins/omnishell` is `plugins/omnishell/**` only,
so a rename in `schema.cue` or a design-block edit in an app does not trigger the
job — and "a rename fails this test" was the headline claim. So the scale being
the same in every app, the no-colour-in-the-scale assertion and the
no-`[data-theme]`-fork assertion move into `derive.ts --self-test` and
`invariants.sql`, which run in **every** app's lint on every pronto change.
`plugins/pronto/**` joins the omnishell filter for the daisyUI cases that stay.
The fork assertion is written against the DECLARATION rather than against
colour: every custom property the emission declares sits under `:root` or
`:where(html)`, so a `[data-theme]` sibling palette or a `.dark` class fork
cannot exist, and the emitter's own
`.screen[data-state$="-dark"] { color-scheme: dark }` needs no exemption because
it declares no token — it is a token resolution, not a palette. Stated that way
the assertion also covers design.css's other half, the terminal's chrome, which
consumes tokens and declares none.

What the oracle cannot cover, said rather than implied: no app means no rendered
page, so nothing here measures touch targets, focus order, CLS or overflow under
a dark twin. Contrast is recovered arithmetically. That `light-dark()` resolves
when `color-scheme` flips on a frame is a browser behaviour the existing apps'
battery already exercises. And "one component set holds under every published
palette" is the deferred rung: `apps/shadcnui` is already the component-roster
oracle, and grading it under N themes means parameterising its design block over
themes, which `#Design` does not admit.

## Layout is what a vocabulary cannot constrain

The scale constrains values, and every visual defect the battery has found since
is expressible entirely in them. A link padded to the 24px touch floor grows the
line it sits on; a clip hides content with no ellipsis and no way to reach it; a
control at `opacity: 0` stays in the tab order. Each is spelled in tokens and each
passes. The scale answers which number; nothing answers which structure.

That is an asymmetry in what pronto owns. It emits `design.css` and nothing else
visual — every layout stylesheet under `apps/*/shell/` is hand-authored. The
vocabulary is refused at build: two buckets in one dimension fail `cue vet`
through `#Scale.joined`, and two roles at one value raise. Layout is raw CSS,
measured by `check-visual` after it renders. The battery is not wrong; it is
compensating for the half the language leaves open. Two of its rules are
satisfied most cheaply by defeating their own intent — `no-horizontal-overflow`
by `overflow: hidden`, which narrows the document by making its content
unreachable, and `viewport-bounds` by `opacity: 0` — and five skip what
`checkVisibility` calls invisible, so invisibility is one escape through all
five. `clipped-content` and `focusable-but-invisible` measure those two escapes
directly; they are the interim, not the answer.

**Considered, and not discarded: constrain the layout algebra.** In `elm-ui`,
spacing belongs to the parent and a child cannot carry margin, so a padded link
cannot grow its line — the defect is not caught, it cannot be written. elm-ui is
not adoptable: its algebra is Elm's type system, and pronto authors HTML read by
a JS runtime. What is adoptable is Every Layout (Pickering and Bell), the same
discipline as a published set of CSS primitives — Stack, Box, Center, Cluster,
Sidebar, Switcher, Cover, Grid, Frame, Reel, Imposter, Icon — each owning the
spacing between its children. It is a reference rather than a package, which is
the shadcn precedent: reimplement a published catalogue rather than invent one.
Modern CSS already carries its core, since `gap` on flex and grid is spacing the
parent owns.

The rule it implies is ownership, not a property. Spacing appears inside a
primitive's definition and a screen does not author it on its own children;
banning `margin` outright would ban Every Layout's own Stack, which spaces its
children from the parent's selector.

What it would move, measured over `apps/*/shell/{screens,shared}/*.css`: 820
margin declarations against 350 `gap`, margin-first by more than two to one. It
binds new screens; an app whose spacing predates it keeps that spacing as the
escape hatch, on the terms the literal lint's migration already takes.

**Where it lands, with Tailwind supplying the grammar** (see "The next
vocabulary"): Every Layout contributes its rule and a handful of primitives, not
its vocabulary. Its names are rare where Tailwind's compositions are
everywhere — `<stack-l>` in 1,264 public GitHub files, `<sidebar-l>` in 1,720,
`<cluster-l>` in 559, against 2,768,896 for `flex flex-col gap-4` and 3,276,800
for `flex flex-wrap gap-2`. So ownership becomes a check on the classes in a
template — spacing between children through `gap-*` or `space-*` on the parent,
a child's margin utility reported — which is easier to decide than the same
rule over CSS. It reports rather than refuses: margin utilities are among the
most familiar classes there are, and ownership is a default the reference app
shows before it is a rule. The primitives no composition states intrinsically — Switcher,
Sidebar, Cover, Reel, Frame, Imposter — are reimplemented from the book as
`@utility` definitions under its names, in the same compiler. Verified on 4.3.3:
`stack`, `cluster` and `switcher` compile, Switcher's
`flex-basis: calc((var(--threshold) - 100%) * 999)` included, and a misspelt
`stack-bogus` generates nothing, so the rule that every template class resolves
covers the primitives too.

## The next vocabulary: DTCG at the platform, vendors in the app

Decided, not built. Everything above describes the tree as it stands; this is
where it goes, and the measurements that decided it, taken on 2026-09-10.

**A vendor is chosen for the names an LLM will write.** A quoted table grades
nothing, and that stays the rule for tests; it is not the rule for choosing.
Public code on GitHub, as a proxy for what a model has read:

| names | from | files |
|---|---|---|
| `var(--primary)` with `var(--muted-foreground)` | shadcn roles | 899,072 |
| `var(--spacing)` | Tailwind v4 | 78,080 |
| `var(--md-sys-color-primary)` | M3 | 6,416 |
| `var(--size-3)` | Open Props | 4,144 |
| `var(--space-m)` with `var(--step-0)` | Utopia | 1,632 |
| `var(--base-size-16)` | Primer | 1,496 |

### The platform reads tokens as DTCG

DTCG 2025.10 is stable in three modules: Format, Color and Resolver. Format gives
typed tokens, `{alias}` references whose cycles and dangling targets are errors,
composite types, `$description`, `$deprecated` and `$extensions`. A `typography`
composite binds family, size, weight, line height and tracking into one token —
the unit `press.type` splits across two tables, which is how naming four leadings
cascaded. Resolver gives sets, modifiers whose contexts an input selects, and a
resolution order.

Pronto keeps two rules stricter than the spec, and every document it accepts is
still a valid resolver document. **Every context is closed against the base**:
DTCG lets a context restate part of a set, where the closed twin is why a missing
dark value fails export today. **One token path has one source**: DTCG resolves a
conflict by taking the last occurrence, which is a silent vendor mix, and
`#Scale.joined` already refuses that shape at build.

The platform is close to vendor-free already. omnishell's CSS consumes no vendor
token. Pronto's vendor-specific code is `#scale`'s quotation, `scales/build.ts`
and `refresh.ts`, and the shadow-ink decomposition above — which exists because
Open Props' shadows reference `--shadow-color` and `--shadow-strength` that its
bundle does not declare. Under DTCG that is an alias with no target, refused for
every vendor, and the patch leaves the platform.

Three published things sit at the platform, as layers rather than competing
vocabularies: DTCG is the format tokens arrive in, Tailwind's namespaces and
compiler are the grammar classes are written in, and shadcn's names are the roles
shared code consumes. Which values fill them is the app's.

DESIGN.md stays: its frontmatter is the role layer's one declaration, read by
`#DesignMd` into the program, and its body is the argument. A DTCG
`.tokens.json` is an EXPORT of the resolved design beside it — that is what
Style Dictionary, Tokens Studio, Penpot and Figma's plugins read — and the
prose can travel into `$description` on the way out; Primer's DTCG already
carries usage rules written for LLMs under `$extensions`.

### Appearance is a modifier, of two kinds

**Coverage is the app's choice; correctness is not.** An app declares which
appearances it claims, and closure binds only those. A light-only app emits
`color-scheme: light` and is correct — the browser keeps it light and nothing
breaks under a dark system setting — where today `#Design.dark` requires a twin
for every colour and so makes dark mode mandatory. What is refused is claiming an
appearance the app does not cover. It is the shape idioms already have: no app is
forced to be multi-idiom.

A preference the browser signals is an axis the emitter selects automatically:
light/dark through `light-dark()`, contrast through
`@media (prefers-contrast: more)`. Each axis is closed against the base keys —
verified: a contrast level omitting a role fails export (`incomplete value`), one
adding a role fails `close()` (`field not allowed`), and the emission stays one
`light-dark()` per colour per level. Everything a user or an author picks is a
**named theme**, closed the same way and emitted under `[data-theme=…]`: Primer's
dimmed ground and colourblind modes, M3's medium contrast. The oracle's fork
assertion refuses a `[data-theme]` palette because nothing closes one today; a
declared, closed theme is not a fork, and the assertion narrows to undeclared
ones. Contrast is checked in every cell — ground × contrast × theme — or the check
is narrower than its name.

### Roles are two tiers

**Contract roles** are the names shared code consumes: the shell chrome and the
widgets. They take shadcn's names, the most familiar role vocabulary in the table
and the source of pronto's widgets. Today the contract is pronto's own and
unwritten: `--shell-*`, `--surface`, `--danger`, `--r-sm/md`, `--sp-md/lg`,
`--motion-*` and the shadow inks.

**App roles** are open, named by the app, and closed per context like everything
else — shadcn's own model, where `--chart-*` and `--sidebar-*` began as app
extensions. An app role equal to a contract role in every context is refused: the
two-roles-at-one-value rule, across tiers.

Primer's role layer is refused, and the reason generalises: **a role set is an
opinion about which distinctions matter.** Its light theme declares 959 roles. 83
are generic foreground, background and border colours; the rest are GitHub's
product — 285 `display-*` label colours, 133 `label-*`, 118 across its buttons, 61
for syntax highlighting, and `diffBlob`, `contribution`, `ansi`, `closed`, `done`,
`sponsors`, `upsell`. Under other values the names still build GitHub's
components, and closure would make every custom theme a 959-value job.

### Computation is allowed at every tier

CUE at generation, Deno at build, CSS at runtime. `calc()` was never refused: the
literal lint refuses a *literal* operand in an app's CSS, which is a hidden
number, and a computed token consumed through `var()` is clean today. The
constraint is the format: a DTCG dimension is `{value, unit}` in px or rem with no
expressions, which is why Open Props' 77 `clamp()` tokens come out untyped. So a
fluid rung is its endpoints in DTCG with the viewport range under `$extensions`,
and the emitter writes the `clamp()`; a ratio such as `calc(1.25 / 0.875)` is a
number CUE computes.

M3's colour engine runs in Deno at build time, which is reuse. It also ports to
CUE, verified in parts, for when generation must run in the browser. `math` has `Pow`, `Cbrt`,
`Atan2`, `Sin`, `Cos`, `Exp` and `Log`, and a fixed-count iteration is a keyed
struct whose step i+1 reads step i — Newton, and a 20-round bisection with a
branch, both evaluated. Every loop in `hct_solver.ts` has a small constant bound
(12, 3×8, 5), and `dynamic_color.ts` has none: its contrast adjustments are
closed-form over a dependency graph, which is what CUE fields already are. Image
quantisation is data-dependent and out of scope; a scheme starts from a source
colour. CUE computes in 34-digit decimals but trig in float64, against the
engine's float64 throughout, so agreement with the engine run in Deno is ±1 per
channel. The engine's own guarantee — a tone difference of 40 gives 3:1 and 50
gives 4.5:1, USWDS's "magic number" in another notation — makes contrast
arithmetic on declared tones.

### The reference app teaches composition

Vendors are the app's choice, stated in a resolver document; a quoted archive is
stored once by digest and referenced, not copied per app. An LLM learns
composition from a reference app the way it learned widgets from shadcnui.
`apps/materialweb` is that reference: M3 is the implementation it reproduces, the
engine computes its colour roles, and they map onto the shadcn contract. That
mapping — `on-primary` to `primary-foreground`, `outline-variant` to `border` — is
pronto's, and the one table here nobody published.

A model copies the happy path and not the reasons, so every composition lesson
this change learned is a platform refusal on DTCG input, never a convention in the
reference: the cascading leading, two roles at one value, a vendor mixed per
token, an alias to a token nobody declares. What no refusal grades is whether the
reference is beautiful; that is decided once, by hand.

### The rungs are Tailwind v4's

Chosen for familiarity, the criterion this section opens with. Its theme
namespaces (`--color-*`, `--spacing`, `--text-*`, `--radius-*`, `--shadow-*`,
`--ease-*`) are the contract between tokens and classes, and its compiler runs in
Deno as plain JS: `compile()` builds from the class list it is handed and from any
theme — verified on 4.3.3, `p-4` is `calc(var(--spacing) * 4)` and `bg-primary` is
`var(--color-primary)` over a theme that is not Tailwind's. That is full adoption
through the real compiler, and the utility grammar is the most familiar surface in
the table. It ships no DTCG, so `theme.css` is converted and pinned by digest.

Classes are the default the reference app shows, not a mandate: `bg-primary`
compiles to `var(--primary)`, the same token a stylesheet writes, so the two
authoring modes fork no value and stylesheets stay legal. Three rules come with it.
A class in a template must resolve to a rule, from the compiler or from an app
stylesheet, because the compiler drops an unknown one silently. A bracket value
(`p-[13px]`) is the class-side literal, and the literal lint already flags one
that duplicates a rung.  A templated class — jsfb's
`class="{cls}"`, xpense's `chip-{color}` — reaches the compiler only where pronto
can enumerate its domain; elsewhere it names a stylesheet rule.

Preflight and cascade layers are part of the grammar, not extras. A model writing
classes assumes Tailwind's reset, and Tailwind's utilities sit in cascade layers,
which any unlayered stylesheet outranks whatever its specificity. So pronto declares the order once —
`@layer theme, base, components, utilities;` — every app takes preflight, and
every app and screen stylesheet is placed in `components`, so a class beats
hand-written CSS the way a model expects. The computed dark default's first
attempt lost to exactly this: its rule sat in a layer, and the utilities it had to
beat sat outside one.

Primer's base layer was the other coherent candidate — valid DTCG (63 files), rem
throughout, 15 releases in the last year — and lost on familiarity alone.
`apps/primer` keeps it, as the reference an app writes against the DTCG layer
alone: it quotes Primer's own tokens with no vendor default beneath them, which is
what shows the platform needs none.

Open Props is out. Its DTCG export is valid only for its 247 colours — 79
dimensions are CSS strings, 81 easings carry the wrong type name and 77 tokens are
untyped — and its resolver has one set and no modifiers.

**Tailwind's colour palette is admitted as it ships, and `dark:` is how an app
twins it.** `theme.css` publishes 286 `--color-*` steps, 26 hues of eleven. A step
is not twinned in its variable: a twinned `--color-gray-900` resolves to its twin
under a dark scheme, so `dark:bg-gray-900` would flip twice, and `dark:` is the
most familiar dark-mode spelling there is — `dark:text-white` in 4,538,368 public
files and `dark:bg-gray-900` in 1,519,616, against 1,298,432 for shadcn's
`bg-background text-foreground`.

What pronto computes instead is a default. For every palette colour an app's
templates use, the generate step emits a rule under the dark appearance that
applies only to an element carrying no authored `dark:` colour for the same
property; the exclusion list is the compiler's exact candidate list, so a
size-only `dark:text-sm` does not count. Verified in Chromium: `text-gray-900`
alone renders gray-100 in dark, `text-gray-900 dark:text-white` renders white, and
`text-gray-500 text-sm dark:text-sm` renders gray-400; axe's contrast rule reports
two failures without the default (1.13:1 and 4.16:1) and none with it. The twin is
the step whose contrast on the dark ground meets or beats the light step's on the
light ground. Measured over 584 text-on-ground pairs legible in light — 23 hues on
gray-50, 100, 900 and 950; the hues written with a `none` hue (zinc, mauve, the
neutrals) not measured — it keeps the WCAG band or better in 90.6%, and 12 of 486
AA pairs fall below AA, every one text on a ground other than the default, which
is what a role's pairing exists for. Mirroring the step (100↔900), which is what an
author reaches for by hand, keeps 55.5% and loses 80 AA pairs.

So an app that claims dark gets a reasonable dark by default, overrides any
element by writing its own `dark:` colour, and reaches dark contrast by
construction through roles.

**Contrast is graded on the rendered page, by axe-core.** Its `color-contrast`
rule is the standard one — it resolves what is actually behind the text, applies
the large-text thresholds and accounts for opacity — and it reads Tailwind's oklch
values in both appearances, verified in the same Chromium run. It runs in the
battery on every route, once per appearance the app claims. A violation is
critical, because correctness is mandatory; a node axe cannot decide, text over a
gradient or an image, is its own counted finding rather than a pass; and the
message names the computed twin. Nothing measures a rendered pair today.

Surveyed and out, from each package's tarball and the registry:

| candidate | why |
|---|---|
| Radix Themes | 798 px declarations and none in rem, so a user's font size never reaches it |
| Atlassian tokens | the most active (80 releases a year), but Primer's two-layer shape under its own brand, and no DTCG |
| Carbon, Spectrum | tokens as JS/SCSS or pre-DTCG JSON; no custom properties, no DTCG |
| Polaris, Pollen, Fluent | no stable release in a year, or alpha |
| Workday Canvas | CC-BY-ND, which forbids derivatives |
| Utopia | a computation rather than a vocabulary, with the least familiar names; a fluid step is endpoints, above |
| USWDS | Sass; its system/theme split is this doc's rung/role split, published |

### Typography is three layers

**Rungs** are Tailwind's text scale, where every size carries its own line height
— `--text-sm: 0.875rem` with `--text-sm--line-height: calc(1.25 / 0.875)` — the
pairing `press.type` broke by holding sizes and leadings in two tables. It costs
no coverage: over the 484 text literals the lint reads, Tailwind's thirteen steps
join 216 and Primer's six join 215, and Primer was chosen for step economy, which
familiarity outranks. **Headings in screens** are shadcn's class recipes —
`scroll-m-20 text-4xl font-extrabold tracking-tight` is in 11,232 public files —
compositions rather than tokens. **Rendered markdown** is
`@tailwindcss/typography`'s `prose`: 11.6M downloads a week,
`prose dark:prose-invert` in 176,640 files, and verified to compile in the same
Deno run as a plugin. Its colours are 36 `--tw-prose-*` variables, mapped onto
roles with `light-dark()`; mapping the `--tw-prose-invert-*` set to the same roles
makes the familiar `dark:prose-invert` harmless rather than refused. Its 165 em
and rem literals are compiler output, and the lint reads the classes that
produced them.

shadcn/typeset, published in July 2026, is the one to watch. It is one CSS file
with three controls, sized by its container and reading the app's theme tokens,
so it needs no colour mapping at all. It covers rendered content only — no scale,
no screen headings — and about a thousand public files mention it.

`press.type` and the Primer quotation leave the platform; `apps/primer` keeps
Primer's type through its own DTCG. thenote (51 `--type-*` references),
`apps/primer` (18) and w3caria (12) either move to the text scale or keep their
type roles as app roles, and realworld and chess, the two markdown apps, are
`prose`'s first sites.

### Order of work

Nothing is kept for compatibility: every app is regenerated on the design as it
lands. One transformation per pull request, none stacked.

0. **The spike, run on 2026-09-11, decided that this branch ships as it stands.**
   RealWorld's visual layer was regenerated twice from one identity taken from
   the brief — once on this branch's vocabulary, once on Tailwind, shadcn's roles
   and `prose` wired as app code — and set beside the current hand-driven app. The
   two regenerations came out close: with the identity and the ir's screen
   structure fixed, the vocabulary moved details (a hero card against uniform
   rows, a ruled tag list against pills, a drop cap), not the look, and both
   differed from the current app far more than from each other. **The identity is
   the lever for how an app looks, not the vocabulary**, which is why step 8
   matters more than step 6. The Tailwind arm took 38m51s to green against
   27m51s, and found what step 6 has to absorb: pronto's build reads the
   generated sheet while the script that writes it needs the built HTML; an app
   has no hook to run a script at build; classes kept only for tests generate
   nothing; the ir's probe rules in `components` lose to any display utility, and
   the terminal strip's unlayered rules cannot be restyled from a layer; fonts
   cannot be served as files and went in as 364 KiB of data URIs; `@theme inline`
   emits no font variables; and `prose` draws backticks round inline code and
   quote marks round blockquotes until configured.
1. **Land `feat/design-vocabulary` as it stands.**
2. **The contrast check**, above, in the battery.
3. **Appearance is declared.** Closure binds only claimed appearances, and
   `color-scheme` and the battery's dark pass follow the claim.
4. **DTCG as the export.** `#Design` exports `.tokens.json`, validated
   against the 2025.10 schemas, from the frontmatter DESIGN.md declares.
5. **The role contract.** shadcn's names, with `-foreground` on-colours and
   `--chart-*` for series; the shell chrome takes the nearest published names,
   shadcn's `--sidebar-*` set being the candidate.
6. **Tailwind.** `theme.css` quoted by digest and converted to DTCG, the compiler
   run over template classes at generate, the class rules, the layer order and
   preflight, the computed dark default, the text scale and `prose`. Open Props,
   the Primer type quotation and `press.type` leave the platform.
7. **Resolver modifiers.** The contrast axis and named themes, closed per
   context; `apps/primer` wears Primer's fourteen themes from Primer's own DTCG.
8. **Identity at creation.** A seed colour through M3's engine in Deno, a font
   pairing, a radius and a density, taken from the brief rather than left at the
   defaults that make these apps look alike. `apps/materialweb` is the reference.
9. **Regenerate every app.**

Deferred until something asks for it: the CUE port of the M3 engine, Every
Layout's primitives as `@utility`, and Typeset.

## What is guarded at the file, and what is not

`DESIGN.md`'s frontmatter is read by `#DesignMd` and unified with `#Design`, so
a key the schema lacks, a value of the wrong shape or a missing frontmatter is
a `cue vet` error, and the freshness guard hashes the file as a source. What
the prose beside it argues is not guarded, and stays that way: a body can
describe a palette the frontmatter no longer carries, and only a reader
notices. "The next vocabulary" adds a DTCG export beside the file; it does not
replace it.

## Rules worth carrying

- **A vocabulary that runs out is answered with a number.** Colour held because
  it was named; everything else was invented. The fix for an invented number is
  a name, and which *kind* of name — role or rung — is the whole design.
- **A scale must be coarser than the author's imagination.** Rungs 2px apart do
  not impose discipline; they let you spell your literal differently.
- **Classify literals by the property they sit on before designing anything.**
  41% of what looked like a spacing problem was rule widths, and the apparent
  gap at 6/10/12 was one unnamed compound plus a table cell.
- **The migration unit is the coupled system, not the value.** A per-value table
  shreds arithmetic across policy classes, and no mechanical gate sees a
  transform escape its parent.
- **Check against the reference, not against the nearest rung.** Four MOVEs
  derived from proximity walked away from the contract the app exists to reproduce.
- **An escape hatch is only honest if its reasons are checkable.** `physical` was
  self-consistent, uncapped, and claimable over the largest population the rule
  exists to police.
- **A rule whose fact table can be empty reports zero findings, which reads as
  green.** Both sides of a join must come from the same run, and emptiness must
  be an error.
- **A check placed where CI cannot reach it is a comment.** The paths filter is
  part of the check.
- **A gate compensates for what the language leaves unconstrained.** Its metric
  is a proxy, its cheapest satisfaction is a workaround, and the collateral lands
  where nothing measures. Constrain the structure and the gate has less to police.
- **Copying an oracle's columns is not copying the oracle.** Without a derived
  column, coverage grades the fixture's self-consistency, and a lossy mapping
  passes by declaring itself approximate.
- **A vendor is chosen for the names a model will write.** That a table grades
  nothing is a rule for tests, not for choosing.
- **A role set is an opinion.** Adopting a vendor's roles adopts its anatomy,
  whatever values fill them.
- **Correctness is mandatory, coverage is not.** An app may leave an appearance
  unclaimed; it may not claim one it leaves uncovered.
- **A colour's contrast belongs to a pair.** A twin for a lone colour can only be
  tuned to an assumed ground; a role knows its ground.
- **Count an idiom before refusing it.** A familiar spelling refused is a tax on
  every screen a model writes.
