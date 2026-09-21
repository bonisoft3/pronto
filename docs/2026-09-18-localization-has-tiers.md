# Localization has tiers

The ground: [`2026-09-09-i18n-is-a-contract.md`](2026-09-09-i18n-is-a-contract.md)
(an app declares its languages; catalog completeness is an export refusal, not a
runtime fallback), [`2026-09-17-localized-urls.md`](2026-09-17-localized-urls.md)
(a route has one address per language, and the door negotiates),
[`2026-09-07-validation-is-a-rung.md`](2026-09-07-validation-is-a-rung.md)
(a predicate runs in the browser and again inside the write), and
[`../../omnishell/interpreter/jessie.js`](../../omnishell/interpreter/jessie.js)
(the cage, and the per-role endowments).

The claim: **i18n settled what an app declares; l10n is about where the
declaration is honoured, and that is not one place. Jessie source runs in three
runtimes with three different ideas of what a locale is, and only one of them
has ICU. So the rule is not "which API is safe" but "what kind of value comes
out": a CLASSIFIER returns a member of a closed set and may run anywhere a
tier can supply it; a FORMATTER returns CLDR text and belongs only where its
output is pixels. Where two tiers must agree, they run the same vendored bytes
rather than each host's ICU — and where a tier cannot supply the capability at
all, the checker says so at `sayt lint` rather than the deployment saying so at
runtime.**

## Facts not to re-derive

Measured in this tree on 2026-09-18. Every line below was run, not recalled.

**The SES cage has no `Intl`, and its locale methods lie.**

```
default cage:               typeof Intl === "undefined"
(1234.5).toLocaleString("pt-BR")        => "1234.5"
["b","a","ä"].sort(localeCompare)       => "a,b,ä"
new Date(0).toLocaleDateString("pt-BR") => "Wed Dec 31 1969"
```

Two different mechanisms, and only the second is ours. `Intl` is ECMA-402, a
host global, and a `Compartment` starts with the ECMAScript shared intrinsics
only — so it is absent because nobody endows it, not because lockdown removed
it. `new Compartment({ Intl })` works fully. The tamed methods are ours:
`localeTaming` defaults to `'safe'` and `jessie.js` passes only `errorTaming`.
Endowing `Intl` does NOT untame them — they live on `Number.prototype` and
friends, not on `Intl`.

**`lockdown()` leaves the page realm alone.** After it runs, `typeof Intl` is
still `object` outside the cage, and `PluralRules("pl").select(3)` → `few`,
`NumberFormat("pt-BR")` → `1.234,5`. The interpreter is not caged; only app
source is.

**plv8 has no ICU at all**, in the image this repo builds:

```
Intl: undefined
(1234.5).toLocaleString("pt-BR") => "1234.5"
```

So for a validation the question is not which ICU version, it is whether the
capability exists. It does not.

**A plv8 `ReferenceError` is shaped wrong.** `ERROR: XX000: ReferenceError:
Intl is not defined`, and `2026-09-07-validation-is-a-rung.md:46` records what
PostgREST does with that: `XX*` → 500, where a returned `false` → `23514` →
400. `#validationSql` already distinguishes a verdict from a malfunction
(`verdict === true ? "true" : ... : "answered " + typeof verdict`) precisely so
the trigger can raise a different ERRCODE — and a thrown error escapes that
mechanism entirely.

**plv8 can be polyfilled, via `plv8.start_proc`.** Demonstrated end to end:

```
Intl: object
es 1/2:          one/other
pt-BR 0/1/2:     one/one/other
en categories:   one,other
es categories:   one,many,other
```

Two traps, both hit:

- **`SET plv8.start_proc` mid-session is too late.** The hook runs when the V8
  context is built, so a session that has already made a plv8 call ignores it.
  The deployable form is `ALTER DATABASE … SET`, and the database name is
  per-app, so it needs
  `EXECUTE format('ALTER DATABASE %I SET plv8.start_proc = %L', current_database(), …)`.
- **The FormatJS chain is three packages, in order.** `intl-pluralrules` alone
  throws `Intl.getCanonicalLocales is not a function`; adding that alone then
  throws `Intl.Locale is not a constructor`. Both failures happen INSIDE
  `start_proc`, which does not fail the one predicate that reached for `Intl` —
  it takes down **every session's first plv8 call**, i.e. every validated write
  in the app.

Bundled cost, minified, for three locales:

| stack | bytes |
|---|---|
| `intl-pluralrules` + pt/es/en | 71 631 |
| `+ intl-getcanonicallocales` | 237 823 |
| `+ intl-locale` | 474 177 |

The plural rules are the small part. The growth is the prerequisites' CLDR
data — region aliases and likely-subtags — so a bundle sized to three locales
and one sized to all of them differ far less than the table suggests.

**pglite cannot run plv8, and cannot be made to.** Its 0.5.8 tarball ships 34
contrib extensions (`amcheck auto_explain bloom btree_gin btree_gist citext
cube dict_int dict_xsyn earthdistance file_fdw fuzzystrmatch hstore intarray
isn lo ltree moddatetime pageinspect pg_buffercache pg_freespacemap
pg_stat_statements pg_surgery pg_trgm pg_visibility pg_walinspect pgcrypto seg
tablefunc tcn tsm_system_rows tsm_system_time unaccent uuid_ossp`) and no
procedural language beyond the built-in plpgsql. plv8 embeds V8, a native
engine; pglite is Postgres compiled to WASM. In a pglite deployment the
authoritative validation tier is absent and the browser's predicate is the only
one — which is the strongest argument for the two running identical bytes.
`guis/flashcards` already depends on pglite, so this is not hypothetical.

**A fold is browser-tier today.** `../schema.cue:638` calls it "the BROWSER-side
transform", and 644-648 records that rpk could run it through goja but
deliberately does not, because `redpanda-connect lint` catches a broken
bloblang mapping and nothing lints a JavaScript string inside a pipeline YAML.
Not verified here: goja ships no ECMA-402 either, so when bloblang goes away
the fold joins plv8 in needing the bundle rather than the host.

## The cages, and what each has

| Role | Runs in | `Intl` there |
|---|---|---|
| `handler` | browser Compartment · Deno check cage (`check-handlers`, `check-battery`, `instrument.ts`) | none endowed |
| `renderer` | same | none endowed |
| `validation` | browser Compartment **and plv8, inside the write** | plv8: **none at all** |
| `fold` | browser Compartment (container side is bloblang) | none endowed |

Four roles, three runtimes. `check-handlers.ts` says its job is loading every
module "in the cage production loads it in" — and today that is one cage for
all four, which is the assumption that is actually wrong.

## The rule

Three, and none of them asks what kind of API is being reached for.

**Endow uniformly, and let a tier that lacks the capability fail.** Not a
capability table: withholding a global to prevent a mistake is a type system,
and what is wanted is a loud, consistent failure. plv8 without ICU throws every
time, in every environment — that is the right behaviour.

**Where two tiers must agree, they run the same bytes.** Not native ICU on each
side checked against a corpus — the same vendored bundle endowed into the
browser Compartment, the Deno check cage and plv8. One CLDR version, no
divergence to test for, and a version bump becomes a visible diff in a golden
rather than a silent change in behaviour.

**Where output is pixels, the host's ICU is correct.** A renderer formats for
one reader; that reader's own ICU is the authority on how their dates look, and
nothing compares the result. So the renderer gets native `Intl`, and it is the
one role that should.

**The restriction lives in the checker, not the runtime.** A failure is only
useful if it arrives early and says what it means, and a `ReferenceError` from
plv8 arrives as a 500 from `integrate`. So `check-handlers` loads each role in
a cage modelling the runtimes that role really reaches, and says

> `validations/own-article.js: Intl is not defined — a validation also runs
> inside the write, in plv8, which ships no ICU`

at `sayt lint`, seconds after it is typed.

## How the bundle ships

Not committed. Pinned by `deno.lock`, cached in `DENO_DIR`, and produced during
the image build so no artifact lands in the tree:

```dockerfile
FROM denoland/deno:alpine-2.3.7@sha256:… AS intl
WORKDIR /w
COPY intl/entry.ts intl/deno.json intl/deno.lock intl/wrap.ts ./
RUN --mount=type=cache,target=/deno-dir \
    deno bundle --platform browser --format iife --minify entry.ts -o intl.js \
 && deno run --allow-read intl/wrap.ts intl.js > 000b_intl.sql
```

then `COPY --from=intl /w/000b_intl.sql /docker-entrypoint-initdb.d/`. Checked
in: the five-line entry, `deno.json`, `deno.lock` (the pin) and the wrapper.
Never the bundle. This mirrors the existing vendoring recipes
(`plugins/omnishell/package.json:17-19`) and the plv8 `.deb` stage already in
`libraries/mecha/services/database/Dockerfile`, which fetches by exact name and
checks a published sha256 — same shape, one tool further up.

Gate it on `len(E._validated) > 0`, the same condition that already decides
whether `CREATE EXTENSION plv8` is emitted at all.

## What l10n is still missing

Ranked by whether something is wrong today, not by size.

**Fixed on this branch, recorded because the reasoning is not obvious:**

- **Text sorted by byte value.** Every app initialised with `--no-locale`,
  i.e. `LC_COLLATE=C`, while shipped screens order on text — `handle.asc`,
  `name.asc`, `tag.asc`, `theme.asc`. Measured on postgres 18 that reads
  `Ana < Bruno < Zoe < ana < Ángel < árvore < ñandu`: accents past all of
  ASCII, and case splitting the alphabet so `ana` follows `Zoe`. Now
  `--locale-provider=icu --icu-locale=und --locale=C`, which gives
  `ana < Ana < Ángel < árvore < Bruno < ñandu < Zoe`. Root (`und`) and not a
  language, because the collation is one per database and an app serves every
  locale it declares out of the same rows. This is the one item on this page
  that could not be fixed in the client — the ordering happens in PostgREST's
  `order=`, which has no COLLATE syntax, so it is the column's or the
  database's. ICU also answers what `--no-locale` was guarding against: glibc
  reorders between versions and silently invalidates text indexes, where
  postgres records `pg_database.datcollversion` (`153.128` here) and warns.
- **Dates were American everywhere**, and **times were UTC everywhere** —
  `screen.js` pinned `Intl.DateTimeFormat("en-US", { timeZone: "UTC", … })`.
  The comment defended the locale pin with a real hazard: ONE formatter
  carrying both date and time interposes CLDR's date-time connector, `", "` on
  V8 against `" at "` on JSC. But the code already formats the two apart and
  joins them itself, so the hazard was already avoided and the pin bought
  nothing. Both now come from the screen's context, and the zone rides
  `screenEnv` beside `locale` and `messages` — `undefined` in production, which
  is how `Intl` spells "the reader's own", and `"UTC"` pinned by the storybook
  and the harness, because a frame those tiers compare is rendered off a
  reader's machine.

  Checked on both engines, since that is the whole reason the suite exists:
  JSC and V8 agree on every case (`2 de ago., 09:00` for pt-BR, `2 ago, 09:00`
  for es, `Aug 2, 06:00` for `America/Sao_Paulo`).

- **Plurals and gender had no machinery**, so "1 punto" against "2 puntos"
  could not be said. A catalogue value may now be a flat map of arms, and the
  element names which arm it reads: `data-msg-plural="<column>"` runs the count
  through `Intl.PluralRules(locale).select()` and indexes by the CLDR category,
  `data-msg-select="<column>"` indexes by the value itself. One mechanism, two
  selectors, and both `data-msg-*` because `{msg[column]}` is taken — it means
  "the row carries the key".

  Selection is the interpreter's because `Intl` is endowed there and nowhere
  else a screen can reach: a Jessie compartment has none and plv8 has none. Two
  supporting changes came with it. `lookup` THROWS on a value that resolves to
  an object with no arm in scope, where it used to render `[object Object]`
  silently in both a `data-text` and a bound attribute. And `check-i18n` grades
  the arms: every locale supplies exactly the categories its own language has,
  taken from `new Intl.PluralRules(tag).resolvedOptions().pluralCategories` —
  computed rather than tabled, so Spanish is asked for one/many/other, English
  for one/other, and Polish for one/few/many/other with nothing to update.

  An arm gets one inner interpolation pass, so `"vale {rung} pontos"` resolves
  its own count against the row. A plain string value is deliberately still
  single-pass: making every value two-pass would change what every catalogue
  already ships.

- **Numbers and currency had no formatter**, so a Brazilian read `1234.5` and
  an amount was grouped in SQL — xpense's `#grouped` is a reverse/regexp
  expression in a GENERATED column, which picks one language in the database
  and shows it to everybody. `data-text-format` gained two names beside
  `datetime`: `number` groups and punctuates for the reader's language, `money`
  adds the currency the bound column declares. Built exactly the way
  `formatDatetime` is — a memoised `Intl.NumberFormat` per (locale, currency,
  scale), the locale off `ctx`, an unparsable value passed through so fixture
  rows stay legible.

  The currency is declared ONCE, on the column (`schema.cue #Field.money`:
  `{currency, minorUnits}`, valid only on an `int`/`bigint`), and not in the
  attribute. A colon-argument spelling (`currency:usd`) would be a second
  grammar inside an attribute value carrying a fact the column already states,
  and would have to be re-validated against ISO 4217 at every use site. On the
  column it rides beside the `cel` and the bounds governing the same value, it
  reaches the terminal through the `schema:` shell.yaml already publishes, and
  `check-markup` grades every binding against it before a screen is mounted: a
  `money` binding whose column declares none, or whose expression is a route
  param, a message or an embedded join, is an error. `minorUnits` is on the
  declaration because the integer alone does not say what it counts — xpense
  stores whole reais where the convention is cents — and the split is done on
  the DIGIT STRING, never by dividing: 123456789012345678 cents is exact as
  text and rounds to `…568,00` as a double.

- **Nothing set `dir`**, so an app in a right-to-left language rendered
  left-to-right. Direction now comes from the tag, through one function —
  `fragment.js` `directionOf`, which asks `Intl.Locale`'s `getTextInfo()` (or
  the `textInfo` getter an older WebKit ships) and throws where neither exists,
  because answering `ltr` for a tag nobody can be asked about renders Hebrew
  backwards and reports success. Four surfaces write it, because four paint:
  the entry document's `dir` hole, each prerendered document, the live document
  on every navigation, and the screen root — the last because a row carrying
  its own `locale` switches one screen and not the page around it.

  One tier cannot ask `Intl`: CUE, which fills the entry document's hole at
  emit time. So `terminal.cue` carries `#RtlLanguages` as data, and
  `test/locale-resolver.test.ts` grades it against the engine both for every
  member and for every tag any app declares — which leaves exactly two ways it
  can be wrong, a language nobody has declared yet and a script subtag that
  flips its language (`sd-Deva` reads left-to-right where `sd` does not), and
  both of them are that test.

  The CSS was in better shape than expected, but not for the reason first
  measured: counting only INLINE-FLOW properties (`margin-left`, `text-align:
  right`, and the rest — absolute coordinates are a coordinate system, not a
  reading order, and truco's card fan is correctly pinned at `left: 50%`),
  truco's own sheets carry none at all. Its single hit was the emitter's own
  `body > nav .shell-me { margin-left: auto }`, present verbatim in all ten
  apps' `design.css` and now `margin-inline-start`. The other nine apps'
  authored sheets carry 138 between them, which is a budget-shaped problem and
  not this one's.

- **A string that reached no catalogue was invisible.** Every other i18n rule
  compares one shipped locale against another, so a hardcoded sentence renders
  the same in every language — exactly what a translated one does. `check-i18n`
  now renders every screen × state under two synthetic tags, `en-XA` and
  `ar-XB`, against a catalogue that is TOTAL over the default one's keys and
  arms and decorated beyond mistaking (`⟦Óĺá ɱúñðó···⟧`). Total is what makes
  the rule decidable rather than a heuristic: `lookup`'s fall-back to the
  default catalogue can never fire, so an undecorated painted run provably came
  from nowhere. Excluded, each for a stated reason: a `[data-text-format]`
  subtree (`Intl` formats a date under the pseudo tag's base language, so its
  output is correctly plain), the storybook's own fixture spellings, a run with
  no two-letter word in it, and a run that is nothing but un-interpolated
  bindings — that is a different finding, and reporting it here would claim
  this pass found something it did not.

  Two tags rather than one because the same render is where `dir` is observed:
  a frame root whose direction disagrees with its tag is a finding, which is
  what makes `screen.js`'s write a graded line instead of an unobserved one.

  This is also the only tier that sees prose inside a `<template data-item>`.
  The static `template_prose` invariant walks the parsed document, and
  `querySelectorAll` does not descend into template content.

**Absent machinery:**

- **Locale-aware input.** A reader typing `1.234,5` into a number field. Parsing
  is the mirror of formatting and deliberately did NOT land with it. The parser
  itself is the easy half — `Intl.NumberFormat(locale).formatToParts` yields the
  group and decimal literals, so it is constructible with no table. What blocks
  it is downstream: `screen.js` runs `form.checkValidity()` before `values()`,
  and a number is typed today into a plain text input guarded by a
  hand-authored ASCII `pattern=` (`apps/xpense/.../home.html`:
  `pattern="[1-9][0-9]{0,6}"`), which refuses `1.234` outright — in assembly
  markup the platform does not generate. And `values()` submits trimmed strings
  for PostgREST to coerce, so parsing forces a wire-shape decision for every
  text control bound to an int column in every app. Half-doing it is the worst
  outcome: a parser that guesses the separator wrong turns `R$ 1.234` into
  `R$ 1,234` silently and the store accepts it.

**Unproven ground:**

- **Text expansion.** German and Finnish run ~30% longer than English and break
  layouts. The pseudo-locale catalogue above already pads every sentence by
  40%, but the tier it renders in cannot grade the result: linkedom has no
  layout at all — `offsetWidth`, `clientWidth` and `scrollWidth` are undefined
  and there is no `getComputedStyle`. So "unlocalized strings and overflow in
  one pass" is not achievable where it was hoped. Overflow belongs in
  `check-visual.ts`, which already runs `checkHorizontalOverflow`,
  `checkClippedContent` and `checkViewportBounds` at two viewports and already
  uses `page.addInitScript` — the pseudo condition installs there as a third
  lane at the narrow viewport, decorating the catalogue fetch, and the
  assertion is COMPARATIVE: an overflow under pseudo that does not appear in
  the default locale. That lane is `verb=integrate` and contends on the docker
  daemon, so it is deliberately not landed with the free half.
- **Prose in CSS reaches no catalogue at all.** `apps/truco/shell/screens/
  arena.css` spells `content: "você" | "parça" | "eles"` and `shared/table.css`
  spells `content: "Robôs"`, rendered identically to its Spanish and English
  readers. No tier grades it: `facts.ts` strips `<style>` and never reads a
  screen's `.css` for prose, linkedom applies no CSS, and Chrome's `innerText`
  excludes pseudo-element content. The pseudo-locale pass above cannot see it
  either. The rule is decidable off the stylesheet parse `styles.ts` already
  runs — a `content:` string carrying a two-letter word, for an app with
  catalogues — and it fires on truco immediately, so it lands with a budget or
  as its own turn.
- **Content variants are not translations.** truco declares two idioms,
  `paulista` and `mineiro`, both Brazilian (`program.cue:38`). `/es/reglas`
  renders correct Spanish describing a game Spanish speakers do not play: no
  envido, no flor, a 12-point game where Argentine truco is 30, manilhas turning
  on a vira where the Río de la Plata game has four fixed top cards. The
  vocabulary switch already exists and is orthogonal to locale (`data-t`,
  `data-v` on a `variant` column), so adding one costs no i18n machinery. What
  IS l10n is defaulting the variant from the reader's REGION — `es-AR` →
  `argentino` — which is the first concrete use for the region subtag the URL
  design deliberately preserved.
