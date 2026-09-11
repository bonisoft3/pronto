# A scale is a quotation

A vocabulary of 122 values typed into `schema.cue`, above a comment naming the
tarball they came from, has that comment as its whole provenance story. Nothing
joins the block to the bytes, so the difference between "these are Open Props
1.7.23" and "these were Open Props 1.7.23 in September" is a reviewer's memory.

That is the defect this change closes, and it is the third time this shape has
appeared here. The first token oracle's verdict read a column a human had
authored. Its rebuild read the same column under a new name. Now a proposal to
generate the vocabulary from vendored bytes offered three checks — a tarball
digest at refresh time, a fixture hash beside the generator, and
regenerate-and-diff — and not one of them crosses the generator. A `build.ts`
with a hardcoded table quotes nothing and passes all three forever.

So the rule that governs everything below: **derive it, never assert it.** A
fact that only one reader produces is not checked; it is believed.

Verified against `5d6d95811` on `feat/design-scale`. Every number here was
measured in that tree, or against an archive re-fetched from the registry whose
sha512 matches the digest its `source.json` names, and each says how.

## Facts not to re-derive

**The vocabulary publishes 133 steps and 126 of them are literally a vendor's
bytes** (`select count(*), count(*) filter (kind = 'quoted') from
scale_declaration`). Every one of the 17 `size`, 5 `border`, 81 `ease`, 6 `layer`
and 6 `ratio` values is byte-identical to its declaration in Open Props 1.7.23's
`sizes`/`borders`/`easings`/`zindex`/`aspects.min.css`, and the 6 `text` and 5
`leading` values to @primer/primitives 11.10.0's
`dist/css/base/typography/typography.css` — both archives re-fetched from the
registry, both digests matching `source.json`, and all seven checked-in
stylesheets byte-identical to the tarball's copies. The other seven values are no
vendor's: the six shadows are pronto's own geometry over its twinned ink roles
(upstream composes `hsl(var(--shadow-color)/var(--shadow-strength-10))`, a
component triple and a percentage, and neither is a `<color>` `light-dark()` can
twin; pronto writes `var(--shadow-ink-10)`), and `min/touch` is the terminal's
measured floor.

**The vendored files declare far more than the scale admits, and every refusal
is a row with a reason.** `sizes.min.css` declares 74 names against 17 admitted;
`borders.min.css` 29 against 5; `shadows.min.css` 21 against 0. `easings`,
`zindex` and `aspects` are admitted whole. Open Props' refusals fall into 15
families — `--size-px-*` (17), `--size-relative-*` (17), `--size-fluid-*` (10),
`--size-content-*` (3), `--size-header-*` (3), seven word-shaped
`--size-xxs..xxl`, the five `--radius-*` families (24), `--shadow-color`,
`--shadow-strength*` (8), `--inner-shadow-*` (6) — and `--shadow-1..6` itself,
which pronto republishes under the upstream names without quoting the upstream
values. Primer's base typography sheet declares 15 names against 11 admitted, and
its one refusal covers the remaining four: the `--base-text-weight-*` ladder.

**The interchange document cannot carry the bytes, and cannot supply the
taxonomy either.** Open Props 1.7.23's own `open-props.resolver.json` (28
groups at `resolutionOrder[0].sources[0]` — there is no `sets` key) types 66
`ease` names against pronto's 81; the missing 15 are `step-*`, `spring-*` and
`bounce-*`, whose `steps()` and `linear()` values have no DTCG type. Its `size`
group is 41 keys against pronto's 17. And its `$type` does not decide pronto's
dimension: across the admitted groups it is `dimension` 46, `cubicBezier` 56,
`number` 12, absent 10 — one `dimension` covering both `space` and `rule`, one
`number` covering both `layer` and `ratio`.

**Typography, measured over the set the scanner actually reads.** `derive.ts`
scans `shell/screens/*.css` plus each screen's declared `files.shared`;
`shell/design.css` and `shell/shell.css` are in neither. Over that set, all nine
apps, read by the rule of record — `select dimension, count(*), count(distinct
value), count(distinct norm) from app_literal group by 1`, which is why these
cannot drift from what the lint joins:

| dimension | sites | distinct values | distinct norms |
|---|---|---|---|
| `text` | 484 | 49 | 35 |
| `leading` | 196 | 20 | 19 |
| `shorthand` | 95 | 27 | — |

`font-weight`, `letter-spacing` and `font-family` have no rows there at all —
`PROPERTY_DIMENSION` classifies none of them — so they are counted by grep over
the same 92 files: `font-weight` 229 occurrences over 9 spellings,
`letter-spacing` 74 over 28, `font-family` 44 over 13.

In `apps/shadcnui` alone: 334 of the sizes and 155 of the leadings — the two apps
that have drafted a `type` ramp write no size literal at all. The corpus's most
common size is `.875rem` ×135, its second `.8125rem` ×102; its most common leading
is `1.6` ×65, its second `1.5` ×59.

**Tailwind v4 is not a length vocabulary.** Its `theme.css` publishes
`--spacing: 0.25rem` — one multiplier — no border-width or z-index ladder at all,
and one ratio (`--aspect-video`). Meanwhile `apps/shadcnui`'s 533 joins outside the
two type buckets are 475 rung and 58 role, dominated by `--border-size-1` ×201,
`--border-size-2` ×152 and `--size-1` ×114. That is why it was never a candidate
to replace the whole vocabulary, only the two type buckets.

## The quotation is checked by the lint, not by the generator

A generator cannot be proven to have read a file. What can be proven — and is
the property actually worth having — is that its **output equals the file**,
continuously, because a generator that read the bytes and then dropped one is
exactly as wrong as one that never opened them.

So the check is on the artifact and it runs where every other design rule runs.
`check-facts.ts` parses the vendored stylesheets with `tokenDeclarations`, the
same function `design.css` is already read back with, into three tables beside
the two the export publishes:

```
vendor_declaration(source, token, value)   vendor_source(name, origin, version)
vendor_exclusion(source, pattern, reason)
scale_declaration(token, value, source, kind)   scale_source(name, kind, origin, version)
```

The vendor tables are read at QUERY time and not at derivation, which is the
difference between a rule and a report: the archives are not derived from
anything, they ARE the input, so a row snapshotting them into `facts.json` would
let the rule hold the vocabulary against bytes that had since moved — silenced by
not regenerating, which is exactly the silence it exists to break.

A step carries its bucket's `source`, so every rule below joins on
**(source, token)** and not on the name alone. Two archives sharing a name is not
hypothetical — every vendor spells `--text-*` and `--radius-*` — and a name-only
join grades a step against whichever tree happens to declare it, which is right
only for as long as no two do. Five rules, all `error`:

- **The quotation.** A step equals the declaration its own bucket's source makes.
  *`--size-3` is published as `1rem`, and open-props 1.7.23 declares it
  `1.0625rem`.*
- **The witness.** A join is silent about a row that matches nothing, so a quoted
  source must declare every name published from it — otherwise a step invented
  under a vendor's prefix is graded by no archive at all.
  *`--size-16` is published from open-props 1.7.23, which declares no such name;
  a step with no upstream names an own source.*
- **The contradiction.** A refusal is an argument for not quoting a name, so a
  file cannot both refuse a token and publish it. Unsaid, one appended refusal row
  takes a published token out of the quotation's reach and the scale can then say
  anything about its value.
- **The admission**, the other direction, and the reason the quotation is not
  satisfied by quoting nothing: a declared name is published, or it is refused
  with a reason a reviewer can read. Scoped to the sources the scale composes,
  which is what keeps registering a tree cheap: until a bucket is drawn from it,
  there is nothing for its names to be admitted into.
  *`open-props 1.7.23 declares --radius-2, which this scale neither publishes
  nor refuses`.*
- **The provenance.** The witness and the admission both exempt a source no tree
  answers, which is right for a source claiming no upstream and wrong for one
  claiming an archive: `quoted` with nothing behind it publishes a whole ladder
  graded by nobody's bytes. Keyed on the source row rather than on a step, so it
  convicts a fabrication before it grows a bucket — and it is the only query in
  the file that reads `kind`, because CUE cannot see the filesystem and the claim
  and the archive can be joined nowhere else.
  *`tailwind quotes tailwindcss 4.3.3, and no tree under scales/ answers that
  name`.*

The exemption is that no vendored tree answers the source's name, and never the
label. The witness asks `EXISTS (… vendor_source WHERE name = source)`, which is a
fact about what is on disk, so `shadow` and `min` are acquitted because no tree
answers them rather than because they say `own`. Reading `kind` instead put the
whole exemption one plausible line away — `{kind: "own", origin: "open-props",
version: "1.7.23"}` bought a fabricated rung its way into every app's stylesheet
with both gates green. Plus two emptiness guards, in the shape the file already
carries elsewhere — zero `vendor_declaration` rows, and no `scale_source` a
vendored tree answers — keyed on the tree for the same reason, because a guard
that trusts the label is disarmed by the line that disarms what it guards. The
exemption itself is what the provenance then constrains: a source may go
unanswered by any tree only by claiming no upstream, and `#Source` already refuses
a fabricated version for one that does.

That is one hop upstream of the two `scale_declaration` ↔ `design_declaration`
rules, which hold each app's `:where(html)` block equal to the export in both
directions and name the token that differs. The chain is **vendored bytes →
export → design.css**: three tables and two joins, every hop a row-level rule
whose message names one token, with the source tables there to say whose bytes
they were.

**The command that catches a hardcoded generator is `just lint` in any app** —
the `facts` rule, `check-facts.ts`. The falsification is mechanical:

```
sed -i '' 's/--size-3:1rem/--size-3:1.0625rem/' \
  plugins/pronto/scales/open-props-1.7.23/sizes.min.css
cd apps/shadcnui && just lint     # error, naming --size-3
```

A generator that quotes nothing fails that the instant the bytes move, which is
the only moment at which the two can disagree.

`check-facts.ts` runs with `--allow-read=.,../../plugins/pronto`, which is where
the archives are, so `derive.ts`'s grant stays `--allow-read=.` and neither
`emit.cue`'s `buildCmd` nor the generated `lint: derive` rule widens for a table
that must not be snapshotted anyway.

### What replaces the witnesses that go away

`requireBuckets` and `SCALE_PREFIX` are deleted, and each one's fact is
re-stated somewhere it can still fail.

`requireBuckets` witnessed **presence**: a bucket that stopped arriving
publishes zero steps and every joining rule reads green. Its replacement is two
things, because the fact was two. `styles.ts` raises when the export's `buckets`
is empty or any bucket's `steps` is — a precondition that cannot be met raises,
it does not degrade. And `invariants.sql`'s "the scale published no steps at
all" guard narrows to `WHERE NOT EXISTS (SELECT 1 FROM scale_step WHERE kind =
'rung')`, one word, because `facts.ts` already carries `kind` into the table and
the design block's roles alone would otherwise keep it non-empty.

`SCALE_PREFIX` witnessed that the scanner's prefix agreed with `emit.cue`'s
comprehension. After this change there is one prefix, declared as bucket data
and read by both, so there is nothing left to disagree — and the fact it
protected, that the emitted block's tokens are the scale's tokens under the
right prefix, is exactly what the two `scale_declaration` ↔
`design_declaration` rules already check per app.

The `identity` digest the proposal offered as the replacement is **dropped.**
It was taken from the generated file, downstream of the same surface it was
meant to witness, and its message would have been two base64 strings where every
other message in that file names a token. A digest is not a check; it is a
smaller diff.

## What the dimension enum is for

A closed enum is only defensible once something says what its members are drawn
from, and without that a new kind of token is either a contradiction or an
arbitrary addition.

**`#Dimension` is not a taxonomy of tokens. It is the list of joins the scanner
implements.** A bucket's `dimension` says which `norm()` runs over its steps and
which properties' literals can reach them, so its members are exactly the
dimensions in which a literal can be refused. Read that way the enum settles
itself:

- `token`, `root` and `shadow-color` are classifications of a **literal**, never
  of a bucket, and are correctly absent.
- `color` is absent because colour ramps are refused (below); had they been
  admitted the enum would have needed it.
- `opaque` is the answer to a bucket that publishes a name and joins no literal:
  `shadow`, because an elevation is a list and not a value, and `min`, because a
  touch floor is a decision. It is defined at the enum and assigned to those two,
  and `scaleSteps` skips it explicitly rather than relying on a prefix list's
  silence. Getting this wrong is live: `min` under `space` would answer
  `padding: 24px` with "use `--min-touch`".

The closedness then buys something, because the second language derives its half
rather than restating it: `styles.ts` looks a bucket's dimension up in the
`norm()` dispatch table and **raises** when there is no case. CUE refuses at
`cue vet ./...` in every app's lint; TypeScript raises at derive. Neither
carries a hand-written copy of the other's list, so there is no two-language
fact to drift.

## A step's dimension is its bucket's, so the prefix scan disappears

`--font-` is a proper prefix of `--font-size-`, `--font-weight-`,
`--font-lineheight-` and `--font-letterspacing-`, and an ordered first-match
scan over bucket prefixes would classify `--font-size-3` by whichever bucket the
generator happened to emit first. The names are not wrong — Primer publishes
`--base-text-size-*`, `--base-text-lineHeight-*` and `--base-text-weight-*` all
under `--base-text-`, and Open Props publishes `--size-1` beside the `--size-px-1`
its `admitted.json` refuses, so any vocabulary worth quoting will nest — and a CUE
constraint forbidding nesting would refuse a real vendor.

The matching rule is not fixed. It is **removed.**

A name-matching table exists only where something builds one flat token→value map
and then asks a name what it is. Buckets are data, so the emitter and the scanner
both iterate buckets: a step's token is `prefix + key` and its dimension is the
bucket's, by construction, with nothing to match and no order to depend on. What
survives is `ROLE_DIMENSION`, which holds roles and only roles — `--sp-`, `--r-`,
`--motion-`, `--type-leading-`, `--type-` — because a role's dimension is the one
thing still read off a name. Its motion row is `[/^--motion-/, "motion"]`, a role
prefix alone; `--ease-*` steps come off the `ease` bucket.

`#Bucket.prefix` carries a shape regex and one more constraint: **prefixes are
unique across buckets.** Two buckets under one prefix is a collision the emitter
cannot resolve; a nested prefix is a vocabulary.

Roles get none of this, and the document does not pretend otherwise. `ROLE_PREFIX`
stays hardcoded in `styles.ts`, and `wrongBuckets` over its keys is what holds the
design block to carrying every one of them. Giving roles the same
(prefix, dimension) treatment is a `#Design` change with its own argument; the
subject here is the scale.

## Typography: two buckets, and the other three refused

Open Props publishes five font groups. Measured against the corpus only two earn
a place, and the measurement is what rules.

Joins over the scanned set, all nine apps, one occurrence per declaration:

| bucket | sites | Open Props 1.7.23 | Primer 11.10.0 base |
|---|---|---|---|
| `font-size` | 484 | **87** (18%), 7 of 10 steps join | **215** (44%), 6 of 6 join |
| `line-height` | 196 | 68 (34%), 4 of 7 join | 63 (32%), 2 of 5 join |
| `font-weight` | 229 | 215 (94%) | 181 (79%) |
| `letter-spacing` | 74 | 2 | no ladder declared |
| `font-family` | 44 (13 spellings) | **0** | not vendored |

A bucket earns its place on two tests: it must **refuse** a meaningful share of
the corpus, and the name it offers must **carry an argument the literal did
not.**

**`font-weight` fails the second test outright, and that is the ruling that
matters most.** `--font-weight-6` *is* `600`. The ladder is the identity function
on the CSS specification's own numbers, and 154 of the 215 joins are the single
value `600`. Primer spells that same `600` `--base-text-weight-semibold`, which is
a rename rather than a ladder position, and its four steps stop there: `700` ×25,
`650` ×11 and `800` ×9 fall outside it. Rungs that teach an author to write a
longer spelling of what they already wrote are not a vocabulary; they are noise
wearing a token's name. **Dropped**, and the refusal row carrying that measurement
is what `PROPERTY_DIMENSION`'s absent `font-weight` points at. If weight is wanted
it belongs in the role bucket, where a name means something in the design's
argument.

**`font-family` fails the first.** Zero of 44 occurrences over 13 spellings join
Open Props' 18 family names — the corpus writes
`ui-monospace, SFMono-Regular, Menlo, monospace` where `--font-mono` is the Dank
Mono / Operator Mono stack. Eighteen rungs refusing nothing. Three of them
(`--font-sans`, `--font-serif`, `--font-mono`) are `var()` aliases the generator
would have to resolve, forfeiting the byte-verbatim property for a bucket that
refuses nothing. Primer's stacks are worse than useless here: they are in the
functional sheet, which is not vendored, and `--fontStack-sansSerif` opens
`"Mona Sans VF"`, so quoting it would put a vendor's display face in every app's
rung block. Which face an app wears is its identity. **Dropped**, and two of the
corpus's twelve spellings — `var(--mono)`, `var(--face-figure)` — already reach for
the app's own role.

**`letter-spacing` fails the first too:** 2 of 74 join Open Props' eight tracking
steps, and the corpus's dominant `-0.02em` ×19 lands on none of them. **Dropped**,
and after the typography swap no vendored tree declares a tracking name at all, so
there is nothing left for a literal here to be refused toward — which is the whole
of `PROPERTY_DIMENSION`'s argument for omitting the property.

**`font-size` and `line-height` are taken, both from Primer 11.10.0's base
typography sheet.** Size at 44% is in the same range as the `space` ladder the
migration already paid for (173 of 319), and it names the corpus's most common
size, `.875rem` ×135, which Open Props has no step for at all. Leading at 32% is
weaker but every one of its findings deduplicates `1.5` written 59 times.

Tailwind 4.3.3 was the other candidate and joins one more occurrence, 216 against
215; what decides against it is step economy rather than coverage. Every one of
Primer's six steps joins something, where six of Tailwind's thirteen (`3xl`,
`5xl`..`9xl`) publish a name no stylesheet in this corpus writes — 35.8
occurrences per step against 16.6. The five occurrences given up are `1.5rem` ×3,
`1.125rem` ×1 and `2.25rem` ×1, against `2.5rem` ×2 and `2rem` ×2 gained, and the
whole delta is a rename otherwise. Leading is a tie at 63 either way, two joining
steps each: the two ladders spell tight, snug, normal and relaxed identically and
differ only at `loose` (1.75 against 2), which the corpus never writes. So it
follows its size from one vendor rather than splitting a designed pair to chase
Open Props' five extra occurrences — fitting a vocabulary to its only consumer is
the failure this whole document is about.

Emitted names are the upstream names: `--base-text-size-xs..2xl` (6) and
`--base-text-lineHeight-tight..loose` (5), 11 lines of every app's rung block. No
app stylesheet declares `--base-text-`, so nothing is shadowed. The block reads
alphabetically rather than as a ladder — `2xl, lg, md, sm, xl, xs` — because
`build.ts` keeps the archive's declaration order and Primer declares
alphabetically; sorting it would break the property that the emitted CSS and
upstream read in one sequence. The weight ladder declared beside them is the one
refusal the tree carries, and the functional sheet's purpose names
(`--text-body-*`, `--text-title-*`, `--fontStack-*`) are not vendored at all —
enforced by the tree reader rather than by convention, since both of Primer's
typography sheets flatten to one basename and vendoring both raises.

**`--base-text-size-sm` is a word-shaped rung, so a name's shape does not separate
the two namespaces.** What is load-bearing is the other property — the emitted name IS the
upstream name, which is what makes a version bump a `curl | diff` — and the
namespaces are kept apart by the blocks they are declared in and the rules over
those blocks. `docs/2026-09-08` carries that argument.

### What the scanner does with the two dimensions

`PROPERTY_DIMENSION` gains three rows, none overlapping an existing pattern:
`[/^font-size$/, "text"]`, `[/^line-height$/, "leading"]`, `[/^font$/,
"shorthand"]`. A literal's dimension is decided by the property it sits on and
never by its unit, so `padding: 14px` is `space` and `font-size: .875rem` is
`text` by construction and neither can ever be offered the other's token.

`norm()` gains two cases, and the third dimension is the absence of one:

- **`text`** — `Nrem` → `rem:<round(n*1000)>`, `Npx` → the same through
  `ROOT_PX`. Not `pxNorm`, which returns null unless the conversion is integral:
  66 of `apps/shadcnui`'s occurrences over 9 distinct values are not, and 102 over
  14 corpus-wide (`1.05rem` = 16.8px, `.9rem` = 14.4px) — they would vanish rather
  than fail to join.
  `em`, `%` and `ch` are relative to the element's own inherited size and
  comparable to no rung, so they take the existing `em` sentinel, and `text`
  joins `rule` and `radius` on the sentinel's allowlist in `lengthLiterals` so the
  existing rule reports them — 6 such `font-size`s across four apps, the root's
  own being the ROOT_PX guard's and not type's. Viewport and
  container units publish **no norm and no row**, for the same reason a `clamp`
  does: a size keyed to the viewport is a fluid decision and the ladder has no
  standing to police it. That is chess's three `cqmin` sizes.
- **`leading`** — unitless → `num:<round(n*1000)>`, a length → `rem:<…>`. Two
  kinds in one dimension, kept apart by the tag as `motion` keeps a time from
  an easing: `line-height: 1.5` and `line-height: 1.5rem` are different
  values and must never join.
- **`shorthand`** — deliberately has no `NORM` entry, so it can join nothing; the
  row is written by a branch in `lengthLiterals` that carries the whole
  declaration under the literal norm `shorthand`. Giving it a norm is what would
  make it joinable. The `font:` shorthand sets four dimensions in one declaration
  and no rule can read any of them, so it gets one `warning` over `app_literal`
  rows of dimension `shorthand` whose value is neither `inherit` nor a single
  `var()`: *a font shorthand sets size, leading, weight and family at once and no
  rule here can read any of them; write the longhands.* Population: 28 of 95, in
  chess (12), truco (12), thenote (3) and w3caria (1); zero in shadcnui and
  realworld.

**`clamp`, `min`, `max` and `calc` are stripped for `text`**, the way colour
functions already are. The scanner deliberately keeps calc operands for
lengths — arithmetic on a literal is a literal — but a fluid size is a decision
with an explicit range and the ladder has no standing to name one operand of it.
Without this the rule would tell truco's author to tokenise the minimum of
`clamp(0.75rem, 1.7dvh, 0.9375rem)`, in an app this vocabulary does not otherwise
touch. Population: 16 `font-size` declarations carry such a call — 14 in truco, 1
in chess, 1 in xpense. This is
also the deferral of fluid steps restated as a mechanism instead of a paragraph.

**Neither `text` nor `leading` joins `TOKEN_DIMENSIONS`,** the list a private
custom property consults, and the reason is stated at the list because it is now
measured rather than anticipated: `--size-3` is `1rem` and `--text-base` is
`1rem`, so `--x: 1rem` would join both and naming the wrong one is how a rule
teaches people to distrust it. The norms already separate them (`px:16` against
`rem:1000`); this is the belt, and it is the one that matters if `remNorm` is
ever widened.

### What adoption costs, and why it is not a debt wave

Corpus-wide the two buckets produce **278 joining occurrences over 138 distinct
findings**; in `apps/shadcnui`, 229 over 102. Every one is an exact-value
rename with zero computed-value delta at a 16px root — a rung join is an
equality by definition, so there are no MOVEs here and none of the coupled-system
risk that made the length migration delicate. That is the RENAME class the
earlier migration booked at zero delta for 591 occurrences, and it is paid down
the same way.

| app | joins | distinct findings | tail, joining no step |
|---|---|---|---|
| shadcnui | 229 | 102 | 260 |
| realworld | 17 | 16 | 46 |
| chess | 13 | 7 | 18 |
| plausible | 12 | 7 | 25 |
| xpense | 5 | 4 | 39 |
| truco | 2 | 2 | 14 |
| thenote | 0 | 0 | 0 |
| w3caria | 0 | 0 | 0 |
| jsfb | 0 | 0 | 0 |

`thenote` and `w3caria` are at zero because each has drafted a `type` ramp and
consumes only `--type-*`; the other six are the paydown that remains.

The tail is every `app_literal` row of those two dimensions whose
`(dimension, norm)` joins no `scale_step`: **417**, being 286 `text` and 131
`leading`. It decomposes as 408 whose value the ladders carry no step for, three
line-heights written as a length (`realworld` 28px, `shadcnui` 1.75rem, `xpense`
24px), and six `em` font-sizes that join nothing by construction because they
normalise to a sentinel. None of it is a finding or a budget line, because the
rule fires only where a step exists. Stated as a join rather than as a total, the
number re-derives from the nine fact stores, which is what makes it falsifiable;
a count that excludes the sentinel rows is a different question and answers 396.
The `type` role bucket is where such a value gets a name: `type: [string]:
string`, emitted `--type-*`, chosen so it collides with neither the size prefix nor
the leading one. `press` names six purposes and two leadings, and a further name
enters only when a screen asks for one. On frequency alone three values have the case:
`.8125rem` ×102, `line-height: 1.6` ×65, `line-height: 1.55` ×23 — and the first
of those is named by no admitted ladder, which is what a role is for.

The promotion of the literal rule from `warning` to `error` still waits on every
app reporting zero, unchanged. Typography lands on the platform branch
and the reference app pays down on its own; the six remaining apps' paydown is
what the promotion was already waiting for.

## Plurality is two vendors in one vocabulary, not two vocabularies

Registering a second WHOLE scale — Tailwind v4 was the candidate measured — and
having `apps/shadcnui` name it would be plurality on paper, and measured the trade
is not close to even. Tailwind publishes no space ladder, no border-width ladder
and no z-index ladder, so naming it in the reference app buys 172 font-size
findings and silently retires **467** of its 475 rung findings —
`--border-size-1` ×201, `--border-size-2` ×152, `--size-1` ×114. No emptiness
guard fires, because that scale publishes plenty of steps, just not those.
**Refused.** A vocabulary is composed per dimension instead, which is what the
typography swap did: two buckets replaced, seven others untouched.

What couples a vocabulary to one vendor is not the absence of a second registry
entry; it is **the vendor's taxonomy being the schema.** A
`close({size, border, shadow, ease, layer, ratio, min})` — six of Open Props' group
names and one of pronto's, in CUE — makes a vocabulary with a `tracking` and no
`ratio` a schema edit. The taxonomy is data instead:

```cue
#Dimension: "space" | "rule" | "radius" | "motion" | "layer" | "ratio" |
	"text" | "leading" | "opaque"

#Source: {
	kind:    "quoted" | "own"
	origin:  string
	version: string
	if kind == "quoted" {
		url:       string
		integrity: string
	}
	// An own source has no archive, so no version an archive could pin.
	if kind == "own" {
		version: "this repository"
	}
}

#Bucket: {
	prefix:    scales.#Prefix
	dimension: #Dimension
	source:    string
	steps: [string]: string
}

#Scale: S={
	sources: [Name=string]: #Source
	buckets: [Name=string]: #Bucket
	prefixes: {for n, b in S.buckets {(b.prefix): n}}
	sourced: {for n, b in S.buckets {(n): S.sources[b.source] & #Source}}
	joined: {for n, b in S.buckets if b.dimension != "opaque" {(b.dimension): n}}
}

#scale: #Scale
```

Each field's argument is written at `schema.cue`, beside the declaration a reader
is looking at when they need it. What the shape buys: `#Dimension` is the list of
joins above; `kind` is what makes `url` and `integrity` owed by a quotation and
absent from an `own` source, and what pins an own source's version to this
repository — and it is deliberately NOT the exemption the rules read, because a
label an author writes is an exemption an author can take. `prefixes` and `sourced` are non-hidden because a
hidden field is evaluated only where something dereferences it and nothing
dereferences either — non-hidden, they ride `#emit`'s `scale`, so `cue export`
fails before the writer emits a byte. Building the prefix index IS the uniqueness
check: two buckets under one prefix write two names into one key and conflict,
while a NESTED prefix is a vocabulary and nothing matches a name against the map.

`joined` is that trick one level up, and it is what makes this section's claim a
check rather than an argument. Two buckets in one JOINING dimension both answer a
literal, and `wins()` has nothing left to separate them — so the canonical name
the lint teaches would be whichever token sorts first. The index makes that a
conflict, which is "a replacement argument per dimension rather than an addition"
stated in CUE. `opaque` is exempt: a step there publishes a name and joins
nothing, `scaleSteps` skipping the dimension before it offers, so `shadow` and
`min` cannot compete for a norm. The falsification is mechanical — compose a
second bucket at `dimension: "rule"` in `#scale` and any app goes red:

```
cd apps/xpense && just lint
# #scale.joined.rule: conflicting values "borderWidth" and "border"
```

`wins()` closes what the index cannot reach: two steps in one bucket whose
spellings normalise alike, and two roles at one value. Both raise, naming the two
tokens and the norm they share.

`scales.#Prefix` and `scales.#Vocabulary` live in the generated package rather
than only on `#Bucket`, because the two grade different sets: a package-level
pattern constraint grades whatever `build.ts` drops there under `cue vet ./...` on
the day it lands, while `#Bucket` grades only what `#scale` draws from. Registering
a vendored vocabulary and adopting one are separate acts, and the first is what
this buys a check for.

The prefix pattern admits camelCase because a vendor's spelling is the vendor's:
Primer Primitives publishes `--borderWidth-thin` and `--zIndex-skipLink`, and a
pattern that reshaped either would make the emitted name stop being the upstream
name — the one property that lets a release bump be read as a diff. For the same
reason `parse()` folds an ordinary property name, so the dimension tables can be
keyed by it, and never folds a custom one: a folded name is one the archive never
declared, and the quotation join would compare it against nothing.

Verified with the pinned cue v0.16.1: the shape compiles, and a bucket naming an
absent source fails `cue export` and `cue vet -c` with
`sourced.rogue: undefined field: nope`, naming both the bucket and the missing
source.

Plurality is then real in the shipping configuration rather than in an unused
registry key: `size`, `border`, `ease`, `layer` and `ratio` quote Open Props
1.7.23; `text` and `leading` quote @primer/primitives 11.10.0; `shadow` and `min`
are pronto's own and name a source that says so. Four sources and one vocabulary,
quoting every vendored tree under `scales/`, and one reader, because every
archive is CSS. What the composition
forces is the part that could not be faked: `build.ts` iterates the trees rather
than naming one, each tree carries its own admission table, and every quotation
rule keys on `source` because two archives spelling one name is the ordinary case.
A second registry entry nothing selects forces none of that.

**There is no `scale:` field on `#Design` and no `#scales` registry.** The
measured case for an app seam collapsed with the whole-scale trade above, and a
one-entry registry keyed by a name nothing selects is the speculative generality
this document exists to refuse. The property that all nine rung blocks are
identical survives by construction, and the two `scale_declaration` rules keep
checking it per app. The seam is added the day a second whole vocabulary exists
that an app measurably lands on more than this one. Primer Primitives supplies two
of the nine dimensions and no more; which of its other ladders could follow, and
why each is a replacement argument rather than an addition, is in
`PENDING.md`. That argument is now also a constraint: `#Scale.joined` refuses two
buckets in one joining dimension, so a second vendor's `--borderWidth-*` beside
Open Props' `--border-*` fails `cue vet` rather than being decided by ASCII.

## What the interchange format is for

Measured, the design token interchange format splits: **DTCG is the oracle's
ingestion shape and not the scale's**, and both halves of that are load-bearing.

For the scale it cannot carry the bytes. 15 of 81 easings have no DTCG type, and
Open Props' own resolver drops exactly those 15 — `step-*`, `spring-*` and
`bounce-*`, whose `steps()` and `linear()` values the format cannot express — so
the limit is confirmed by the format's own publisher. Of the 115 Open Props steps
the scale quotes, that leaves 100 typed at all, and rendering the resolver's typed
values back to CSS the obvious way — a `dimension` as value plus unit, a
`cubicBezier` as `cubic-bezier(a, b, c, d)` — reproduces 25 of the 90 whose key the
resolver spells identically byte-for-byte (`0.25rem` against `.25rem`,
`cubic-bezier(0.25, 0, 0.5, 1)` against `cubic-bezier(.25,0,.5,1)`). So adopting it
rewrites most of a 133-declaration rung block in all nine apps at once, and
degrades `ratio/widescreen` from `16/9` to `1.7777777777777777`, with `16/9`
surviving only in `$description`. Nor can it supply the taxonomy: its `$type` maps
many-to-one onto `#Dimension`, and its 28 groups reach the scale's five Open Props
buckets only through the same exclusion table the CSS needs anyway.

For the oracle it is exactly right, because the oracle's question is "can eight
roles and a closed twin express a token system" and DTCG is what makes *any*
token system reachable. `design-tokens.test.ts` splits into an ingest layer plus
its ten cases, with two adapters — read a DTCG document, and parse a CSS theme
block into one — and grades three vendors through them: Open Props' resolver,
Tailwind's `@theme`, daisyUI's 35 `[data-theme]` blocks (28 tokens per theme, 20
oklch colours, 6 dimensions and 2 numbers; 980 of 980 expressible — measured by
that suite on `feat/token-oracle`, where it lives, and not in this tree). Each
adapter's **output** is hashed the way `QUOTATION` hashes the reading today, so
a converted document cannot drift in silence. And the theme finding is restated
in the format's own vocabulary, which is the sharper statement: pronto's
`#Design` is a Resolver with one modifier (`appearance`) of two contexts and no
set composition, against daisyUI's one modifier of 35.

## The gaps

**Colour ramps: refused, and the refusal is now on record twice.** The case for
admitting them rested on `colors.accent: "{blue.6}"` being "a role pointing at a
rung, the pattern `control.pad-x: var(--sp-md)` already establishes". It does
not: `--sp-md` is a role, and the comment on `press`'s `rounded` in `schema.cue`
declines to make roles point at rungs, with a stated reason about converting six
apps' spacing from device px to rem. The temptation argument fails too — `--gray-7` and
`--surface-muted` are different custom properties and never contend in the
cascade, so specificity adjudicates nothing between them, and `color:
var(--gray-7)` writes no literal for the lint to see. And admitting them would
hollow out the colour lint mechanically: `scaleSteps`' colours loop calls
`colorNorm` directly on the design block's raw values and never calls
`resolve()`, so `colorNorm("var(--blue-6)")` returns null and every role
redirected onto a ramp silently stops publishing a colour step. The oracle's
tenth case therefore cannot go green under current doctrine. **That belongs in
the oracle as a stated verdict, not as a red run nobody reads, and not as a
reason to change the doctrine to satisfy the meter.**

**The component tier: built, as a role bucket keyed by element class.**
`component: [string]: string`, emitted `--c-*`, keys `<element>-<property>` —
`field-radius`, `selector-radius`, `box-radius`, `field-size`, `selector-size` —
values pointing at a role or a rung. The emitter interpolates the value verbatim
into `:root`, and `--c-` is absent from `ROLE_DIMENSION`, so `scaleSteps` drops
the token before it resolves anything: the tier publishes no step and its values
are never dereferenced. That is the point rather than an omission — which box
wears which geometry is a decision, not a value to refuse a literal toward, and
`--r-sm` stays what a 6px corner is answered with. Precedence is not the reason:
`wins()` makes an alias lose to the step it points at, so a `--c-field-radius`
holding `var(--r-sm)` could not outrank `--r-sm` even if the tier did publish.
`press` declares none, so the bucket is empty in every app. Two of daisyUI's
own switches, `--depth` and `--noise`, are not lengths and would enter here rather
than the scale for the same reason; no app in this tree declares either, and
neither name occurs anywhere in it. Element class is the one thing an ordered
sm/md/full ladder cannot state whatever it is filled with, because press orders
radii by size and daisyUI orders them by element class — 8 of its 35 published
themes carry such an ordering, counted on `feat/token-oracle`.

**The fact store's freshness: closed.** `check-facts.ts` re-hashes every
`artifact` row before running a single query, so a row the file no longer matches
is a finding rather than a rule graded on yesterday's numbers. Every `appCss` path
is in that table with `derived: false`, and its hash comes from **the string derive
scanned**, not from a re-read at hashing time: the paths are read early and the
table is built after the writes, so re-reading there would let a write between the
scan and the hash produce a row matching a file no rule was derived from.
`shell/design.css` enters with `derived: true`, hashed off disk because that is the
artifact the claim is about and `write.ts` prefixes a provenance header the export
does not carry. It is in the table for freshness only and never in the literal
corpus — it is emitted, and the rules over it are the declaration rules, which is
why `emit.cue`'s own `font: var(--shell-font, …)` needs no exemption from the
shorthand rule.

**Fluid steps: still deferred, with a mechanism instead of a paragraph.** Each
name the vocabulary could not carry is a row in its tree's `admitted.json` with the
reason beside it — 15 patterns for Open Props, 1 for Primer — and the
admission rule fails if a declared name is in neither that table nor the scale, so
"fluid is missing" is a row a reviewer reads rather than an absence nobody
notices. The generated CUE carries only what was admitted. And the `text`
dimension's stripping of `clamp`/`min`/`max` is the operative half: a fluid value
publishes no literal, so the rule cannot half-name one. A `fluid` dimension would
be ingested from the vendored CSS with `norm()` returning
`clamp:<min>|<pref>|<max>` and comparable literal-to-literal only. That is a
scanner change with its own case table.

## Stages

Each names its branch and what proves it. `feat/design-scale` is the platform,
`feat/shadcnui-scale` the reference app, `feat/token-oracle` the grader.

**1 — the freshness guard covers the stylesheets.** `feat/design-scale`. In
`derive.ts`, push every `appCss` path into the artifact list with `derived:
false` and `shell/design.css` with `derived: true`, hashing the strings already
read rather than re-reading. No new machinery: `check-facts.ts` already
re-hashes every row before any query and already writes the right message for
each case. *Proves:* edit one screen stylesheet without regenerating, expect
exit 1 naming that path; regenerate, expect green. This is the smallest stage
and it goes first because every stage after it is an answer about yesterday
otherwise.

**2 — the vendored bytes and the quotation rule, at zero emitted diff.**
`feat/design-scale`. Add `plugins/pronto/scales/open-props-1.7.23/` (the six
`*.min.css` files byte-for-byte from the tarball, plus `source.json` with name,
origin, version, licence, tarball URL, sha512 and the file list) and
`admitted.json`: 5 `admit` rows carrying a bucket's prefix, dimension and key
shape, and 15 `refused` rows keyed by name pattern, each with a reason. Pronto's
`shadow` and `min` are not exclusions but buckets whose source says so, and
`--shadow-1..6` is in both — declared upstream, refused as a quotation, republished
as pronto's geometry. `refresh.ts` downloads a tarball, verifies its sha512 against
`source.json`, and rewrites the directory — it is the only thing that touches the
network and it is never run by `just generate`. `check-facts.ts` reads the three
vendor tables off the archives at query time; `invariants.sql` gains the four rules
and the two emptiness guards above.
*Proves:* the `facts` rule reports no scale error in any of the eight — 115
quotations agreeing, and 7 steps the witness acquits because their source is
`own` (jsfb carries pre-existing `ir.html` errors of its own, which no rule here
touches). Then the falsification above: mutate one vendored byte, expect `error`
naming `--size-3`; revert. Then delete one `refused` row, expect the admission
rule to name the orphaned upstream token; append one for a published token, expect
the contradiction rule to name it.

**3 — the taxonomy becomes data.** `feat/design-scale`. Replace
`close({size,…,min})` with `#Dimension`/`#Source`/`#Bucket`/`#Scale` as given.
`scales/openprops.cue` is generated by `scales/build.ts` — offline,
`--allow-read=. --allow-write=.`, reading the vendored CSS for bytes and
`admitted.json` for what may enter, and failing on a declared name that is neither
refused nor under an admitted prefix wearing that bucket's key shape. The rung
block is one comprehension over `#scale.buckets` in `emit.cue`'s `_scaleCss`;
`#scale` has no `css` field, there is no `scale:` on `#Design`, and nothing selects
a vocabulary — `#emit.scale` is the whole `#Scale`, so the lint reads both sides of
its join out of one export. In `styles.ts`, the prefix constants and the
rung-matching table are gone: emitter and scanner iterate buckets, `ROLE_DIMENSION`
keeps roles only with `--motion-` as its motion row, and `scaleSteps` raises on an
empty bucket set, on an empty bucket and on a dimension with no `NORM` case. The
SQL emptiness guard narrows to `kind = 'rung'`. *Proves:* regenerate every app
and expect a **zero-line diff** in every `shell/design.css`; the stage-2
quotation rule still green, now watching a generated file; `deno run
scales/build.ts` reproduces `openprops.cue` byte-for-byte; hand-edit one value
in `openprops.cue` and expect `just lint` to name that token.

**4 — typography enters the scale.** `feat/design-scale` for the platform,
`feat/shadcnui-scale` for the paydown. Vendor `@primer/primitives@11.10.0`'s
`dist/css/base/typography/typography.css` with its own `source.json` and its own
admission rows, counted above. Register `text` (6 steps) and `leading` (5) off it;
add the `type` role bucket. Add the three `PROPERTY_DIMENSION` rows, the two
`norm()` cases and the `shorthand` branch in `lengthLiterals`; add `text` to the em
sentinel's allowlist there; strip `clamp`/`min`/`max` for `text`; add the shorthand
rule at `warning`. Leave `TOKEN_DIMENSIONS` alone, with the `1rem` collision stated
at the list. *Proves:* the rung block grows by exactly 11 lines in all nine apps
with no role displaced; the quotation rule now spans two sources and stays green;
the lint reports 138 distinct findings across the corpus and 102 in shadcnui where
none were possible before; shadcnui pays its 229 occurrences down to zero by
rename, with `git diff --stat` showing no value changed — and the promotion of the
literal rule to `error` still waits on the remaining apps, as it already did.

**5 — the terminal's floor stops being two constants.** `feat/design-scale`.
The floors are declared once, at `omnishell.#Terminal.capabilities.floors`, an
open struct `#emit` already reads. `#scale`'s `min` bucket reads them for the
`--min-*` rungs and names the terminal as its source; `#shellConfig` carries them
into `shell.yaml`; `check-visual.ts` reads them from there through `floorsFrom`,
which raises when the file has none rather than defaulting to a second copy of the
number. *Proves:* change the number in one place and
expect both the emitted `--min-touch` and the visual battery's threshold to
move together. The comment in `schema.cue` saying nothing couples them is
deleted, not amended.

**6 — the component tier.** `feat/design-scale` for the bucket,
`feat/shadcnui-scale` for the reference app's values. `component: [string]: string`
emitted `--c-*`; the preset declares none, so the five keys pointing at roles and
rungs are named on that branch. *Proves:* on `feat/token-oracle`, whose suite
holds the count, the oracle's NAMES figure moves from 9/28 to 14/28 with no twin
tax, since none of the five is a colour. That branch is red at its own tip for an
unrelated reason — the naming axis over 35 themes — so the figure is read out of a
failing run rather than a passing one.

**7 — the oracle becomes a token-system grader.** `feat/token-oracle`. Split
`design-tokens.test.ts` into an ingest layer plus the ten cases; two adapters
(DTCG document, CSS theme block); three vendors. Hash each adapter's output the
way `QUOTATION` hashes the reading. Restate the theme finding in the Resolver
Module's vocabulary. Record the colour-ramp refusal as the oracle's own verdict
on its tenth case rather than a red run. Move the `cue` probes to file mode with
two path arguments — file mode still works because nothing is `@embed`-ed, which
is why stage 3 generates a file: probed with cue v0.16.1, `cue export <file>.cue`
against an `@embed`-ing package fails with *cannot embed files when not in a
module*, and package mode does not unify stdin, so an `@embed` would force a
read-only test to write files into the platform package. *Proves:* the suite
runs and reports per vendor; the tenth case's verdict is stated rather than red.

Dropped, with the reason: the `identity` digest and the per-app `scale:` seam
(measured against, above); a whole second scale the reference app names (467 rung
findings against 172); colour ramps as rungs (the analogy is false against the
tree and the mechanism hollows out the colour lint); the `fontWeight`,
`fontFamily` and `fontLetterspacing` buckets (94% coverage with no argument, and
0% and 3% coverage respectively).

## Rules worth carrying

- **A generator cannot be proven to have read a file; its output can be proven
  equal to one.** Check the artifact, not the process, and check it where every
  other rule runs.
- **Regenerate-and-diff proves determinism, not provenance.** A pure function of
  nothing is still a pure function.
- **Never delete a witness without re-stating what it witnessed.** Presence and
  agreement are different facts and a deletion that conflates them buys a green
  run over an empty table.
- **Say what an enum is for before arguing it should be closed.** A list of the
  joins the scanner implements settles its own membership; a taxonomy of tokens
  never does.
- **Fix the matching rule, not the names — and best of all, remove the match.**
  A step's dimension is its bucket's by construction, so nesting is a vendor's
  business and not a hazard.
- **A ladder whose steps are the specification's own numbers is not a
  vocabulary.** Coverage without an argument is a rename, and 94% of it is still
  a rename.
- **Measure a vocabulary over the set the scanner actually reads.** The
  emitted stylesheet is not in the corpus, and counting it moves every headline
  number.
- **Prove plurality in the configuration that ships.** Two sources inside one
  vocabulary force the generator to iterate and every rule to key on source; a
  second registry entry nothing selects forces nothing.
- **A join is silent about a row that matches nothing.** So an exemption is
  inferred from a fact on disk and never declared: a vendored tree answering the
  source's name is what acquits a step, because a declared exemption is a label an
  author can write. `kind` is honest only because one rule joins it to the tree.
