---
type: metric
title: Pending
description: What pronto argues for and has not built, and what a measurement found that nothing has fixed, each checked against this tree on the date given.
---

# Pending

What pronto argues for and does not have, and what a measurement found that
nothing has fixed. A line leaves when it lands or when a document refuses it.
Anything a subsystem document already states is not repeated here.

Every claim below was checked against this tree on 2026-09-27, unless it says
otherwise.

## The compiler

**[The ir pin](SPEC.md#programcue) is compared with nothing**:
`apps/thenote/program.cue` pins a hash its `ir.html` no longer has, and lint
stays green.

**The brief's lints do not exist.** SPEC's lints 1–3, 8 and 9 have no
implementation: nothing reads a brief's `[[id]]`, a `![[…]]` transclusion, the
harness frontmatter or `pronto-brief-sha256`. The CEL half of lint 10 is
missing too: no `<code class="cel">` span in an ir is parsed, while mermaid
blocks are (`diagrams.ts`).

**Review is not levied by consequence**, and no handler declares a write set
([review by consequence](docs/decisions/2026-08-27-review-by-consequence.md)).

**Nothing parses a module against Jessie's grammar.** `jessie.ts` scans for the
names in `DENIED` and checks the completion value's shape, omnishell's `check
handlers` loads the module in its role's compartment, and SES confines it at
run time. A construct Jessie excludes and SES runs, such as a `class`, passes
all three.

## Types and identity

**A statement nothing can keep still compiles.** The argued rule: the program
derives an `enforced_by` for each statement from a table of what each tier can
keep, declared non-empty, so a statement no tier keeps does not unify; and
every prohibition carries at least one row it refuses, handed to every keeper,
because a keeper existing is not a keeper working (`matches()` is RE2 in CEL,
POSIX in a `CHECK` and ECMAScript in the browser). Neither `enforced_by` nor
refused rows exist in `schema.cue`.

**Set statements stop at uniques.** The argued vocabulary is dbt's test
grammar verbatim — `unique`, `relationships`, `unique_combination_of_columns`,
`mutually_exclusive_ranges` — with `relationships.to` holding a type id and
`config.where` holding CEL, because nothing else is portable for sets: Datalog
has only incompatible dialects, and DuckDB rejects `ON DELETE CASCADE`. Today
`uniques[].where` speaks the data plane's fragment grammar on browser
durabilities only, and `ref:` means both the edge a validation walks and `ON
DELETE CASCADE`, so an app that wants the edge takes the cascade.

**Productions are SQL strings.** `#Field.default` and `#Field.generated` are SQL
expressions. The argued vocabulary, kept per tier like prohibitions: `default`
limited to a uuid, the clock, the caller or a literal; `stamp` for a field no
writer may set; `computed` as CEL with its strings extension; `on_delete` on a
relationship.

**No shape fingerprint.** It would be sha256 over the RFC 8785 form of the
identity projection — the type id, then each ordinal's type, `required` and
`retired`, with no label — so a rename leaves it unchanged. A versioned device
collection needs it ([omnishell's pending](../omnishell/PENDING.md#data)), and
a message on the bus would carry it in its metadata to say which shape wrote
it. Nothing computes it, and nothing in the tree implements RFC 8785.

**Two apps on one origin share a device collection.** The mecha client keys a
`device` collection's `localStorage` as `mecha:<table>`, so two apps served
from one origin that each declare a table of that name read and write each
other's rows. Keying by type id, with the shape fingerprint beside the rows,
would end it.

**An entity cannot be retired.** `retired` exists only on `#Field`.
`identity.ts` refuses an entity that disappears, and no declaration retires
one.

**An entity has two names.** `#Entity` carries `name`, the PascalCase ir id,
and `table`, snake case, authored separately. Casing is rendering, and a second
authored spelling is how one entity comes to have two names that drift; nothing
derives one from the other or checks them.

**The platform's columns belong to no identity.** `txid` and `scope_id` are
emitted columns no entity declares, and `#tickFields` is concatenated into an
app's field list, taking the app's ordinals; the argued rule is that mecha
mints these once. `identity.ts mint` reads only a literal `fields: [` list, so
an emits entity spelled `list.Concat([#tickFields, [...]])`, as the guide
writes it, cannot be minted.

**`app_user` has no owner.** truco, xpense, thenote, ponto and realworld each
declare it under a type id of their own. Who mints it waits on whether it is
mecha's entity an app extends or an app's entity mecha is told about.

**CEL is rendered without its field's type.** `cel-emit.ts` renders a
comparison the same way whatever the field's type, so ponto's `this > '0'` on a
decimal is right in SQL and lexical in CUE, and `duration()` and subtraction
have no rendering, so "a break fits inside its shift" cannot be stated.

**CEL is parsed and never checked.** `cel.ts` calls `parse` alone and never
resolves an identifier against the entity's fields, which is cheap and
certain over `ParsedExpr`; a type checker would also refuse a string compared
with an integer.

**A server row's transitions cannot be stated.** A machine governs a `tab` or
`device` row only ([omnishell's chart](../omnishell/docs/machines.md#the-chart)),
and nothing else speaks of transitions. Either machines govern cluster rows
too, or CEL gains a binding for the previous row.

**A label is rewritten by hand.** Inside a program a field's label is spelled
in six languages nothing rewrites: CEL, the fragment grammar, bloblang, Jessie,
SQL assembly and the markup's `data-live` and `data-text`. The argued surface
is one command, `pronto rename <entity>.<old> <new>`, which rewrites every
spelling and keeps the ordinal. Once holders keep the name,
[schema changes](docs/schema-change-admission.md#what-pronto-admits) refuse the
rename, so the command serves a field no deployment holds yet.

**`tsvector` is a field.** realworld, thenote and xpense each declare a
generated `search` column of type `tsvector`, which `#typeAlias` maps to
`string` though it is an index, a construction rather than a value anyone
states. Each is filtered by markup as `search=plfts(simple).…`, so once it is
an index the markup checks must admit a filter on a name no field carries, and
the construction must keep that name.

**A value's spelling in markup is not defined per type.** 93 fields across the
apps are booleans spelled as text (`this in ['true','false']`, or yes and no)
against 10 declared `bool`, and a `date` form control submits `…T00:00:00Z`
(`#FormField`) rather than `YYYY-MM-DD`.

**The first hop is not told how identity moves.** The prelude, read on every
compile, says nothing about type ids, ordinals or retirement: that a new entity
or field carries no identity, a rename keeps the identity attributes, and a
drop retires. Those are in GUIDE and SPEC, which a compile does not read.

**A statement is declared inside its entity.** The argued rule is that a
reference goes from what cannot stand alone to what can, so a validation or an
access rule would name its entity rather than be declared inside it. The
machine case is [omnishell's](../omnishell/PENDING.md#data).

**An enum value cannot be renamed.** A value in `this in [...]` and a chart's
state names are data every holder keeps in rows, so renaming one has a field
rename's reach, and nothing declares one.

## Schema changes

**Nothing prompts folding a pgroll migration into its entity.** The second
step of [the rule](docs/schema-change-admission.md#pgroll-migrations)
is manual, and a migration left declared after its effect moved into the
entity fails every fresh-volume replay.

**A hatch may withhold an emitted file.** `withheld()` in `check-sql.ts` and
`check-proto.ts` accepts any path, `005_create_tables.sql` or
`schema/entities.proto` included. A path `.pronto/manifest.json` lists should
be an error.

**A `proto` hatch may withhold a file that does not exist.** `check-sql.ts`
refuses a missing file; `check-proto.ts` does not look.

**An undeclared key reaches a device row.** The mecha client's `normalizeRow`
copies every key and canonicalizes only the declared ones (pronto's copy in
`portable-types.ts`), so a handler can write an undeclared column into a `tab`
or `device` collection, and none of the four readers sees it.

## The lattice

**Durability and effect level are declared together and compared nowhere.**
`#DurabilityEffectLevel` is written twice, in `schema.cue` and omnishell's
`machine.cue`, and nothing unifies an effect's level with its entity's
durability, so an ephemeral effect on a `server` entity passes `cue vet`, lint
and every test. Unifying each effect's level against its entity's row — at
`cue vet`, where the program holds both, or in `machineLint`, which already
reads the level ([omnishell's half](../omnishell/PENDING.md#machines)) — makes
the lattice's first join a refusal, and lets one copy of the table import the
other.

**The three cluster rungs differ only in the publication**
([the lattice](docs/lattice.md#the-durability-ladder)): `live` owes a client
that sees changes without asking and `offline` one that works with no network,
and neither emits anything `server` lacks.

**`writers` is read by nothing.** `#Entity.writers: "pipeline"` marks a derived
entity, and no lint, store check or policy consults it: a form, a reduce or an
effect may target one, and `app_user` holds whatever write arm the access mode
grants. Refusing a form or effect aimed at a pipeline-written entity at lint,
and emitting no `app_user` write arm for it, would make "a sink is written by
its pipeline alone" a rule.

**A `tab` or `device` write is judged by its validations alone**
([the lattice](docs/lattice.md#the-validation-ladder)); a judge beside
`validate.js`, where every write passes, would hold type, field CEL and row CEL
at every rung ([omnishell's `cel:` line](../omnishell/PENDING.md#data)).

## Access

**The owner is stamped by a column default**
([owner stamping](docs/decisions/2026-08-31-owner-stamping.md)).

**`public` names no owner**
([access](docs/access.md#the-browsers-mirror)); an `owner`
on `public` would let the emitter write both the arms and the stamp.

**A cluster entity may omit `access`**
([access](docs/access.md#the-four-modes)); every app in the tree declares one,
and requiring it wherever `#Entity.server` is true would keep it so at `cue
vet`.

## Pipelines and schedules

**No pipeline runs below the cluster**
([below the cluster](docs/pipelines-and-schedules.md#below-the-cluster)); either
the transforms run in the page, or `pages` refuses a pipeline as it refuses an
unsuspended schedule.

**Nothing holds a CDC pipeline's source to `server` or its sink off it.** The
publication carries `server` tables only, so a pipeline `from` a `live` or
`offline` entity never fires, and one whose `to` is `server` publishes its own
upserts to every stream, kept from feeding itself only by its mapping's table
check. The prelude states the sink rule as one the author keeps, and
`_scheduleShape` states both rules for a schedule's entities; `#Pipeline` has
no counterpart that would refuse a feedback loop at `cue vet`. Every pipeline
in the apps reads a `server` entity and writes a `live` one.

**A schedule's hour and cadence are unchecked.** An hour-pinning expression
with no `timeZone` fires by UTC, the default rather than anyone's choice. A
cadence finer than the resolution of the clock at a declared target keeps pace
on a laptop and never where that clock runs, and nothing compares them, since
`meta.clocks` names targets and no clock declares a resolution.

**No app declares a schedule.** `testdata/emit/schedule.cue` pins the seed and
where the table comes from, but `_scheduleShape` and `_clockDeclared` are hidden
fields of `#emit` it never references, so `cue vet` does not evaluate them: its
program still passes with the schedule emitting into a `live` entity.

## Localization

**Catalogue completeness is not a `cue vet` error.** Only `slug` and `label`
keys fail at export; any other key missing from a locale is found at `test` by
`check i18n`, as default-language text after a render. Closing each catalogue
over the default's key set, the way `#Design.dark` closes over `colors`, would
refuse it at `lint`; `#I18n.catalogues` is open.

**A validation cannot use locale data.** `Intl` is denied to every role but the
adapter, and `derive.ts` refuses it in a validation because plv8 in the
database image has no ICU. Where two tiers must agree, the design is one
vendored ICU bundle (FormatJS) pinned by `deno.lock`, built into the database
image as a plv8 `start_proc` migration and endowed alike into the browser
compartment, the Deno cage and plv8, gated on the app having a validated
entity. Nothing in the tree mentions `start_proc` or FormatJS.

**A number field reads only ASCII.** A reader typing `1.234,5` is refused by the
hand-authored `pattern=` before the form submits. `Intl.NumberFormat(locale)
.formatToParts` gives the separators; what blocks it is choosing how the value
crosses the wire for every text control bound to a numeric column, since a
parser guessing the separator wrong turns `R$ 1.234` into `R$ 1,234` silently.
Nothing in omnishell's `interpreter/` parses locale-formatted input.

**Text expansion is not graded.** German and Finnish run about 30% longer than
English. The pseudo-locale pads 40%, but linkedom has no layout; the check is a
narrow-viewport lane in `check-visual.ts`, at `integrate`, reporting an
overflow the pseudo-locale shows and the default does not. There is no such
lane.

**Prose in CSS reaches no catalogue.** truco's `arena.css` writes `content:
"você"`, xpense's `month.css` `content: "orçamento "`, thenote's `wall.css`
`content: "on its way"`. `facts.ts` strips `<style>`, linkedom applies no CSS,
and `innerText` excludes pseudo-element content, so no pass sees them. A
`content:` string carrying a word, in an app with catalogues, is decidable
from the stylesheet parse `styles.ts` already runs.

**Rows are not translated, and the route is where demand would come from.** A
screen's reads carry no locale to the server, and pronto emits no translation
table, view or pipeline. The design
([rows in the reader's language](docs/localization.md#rows-in-the-readers-language)):
a route's reads run under the page's locale; the server answers
`coalesce(translation, source)` at once and enqueues the missing (row,
language) on the change feed; a pipeline translates only that pair and sync
delivers it. The demand row's primary key is derived from (row, language),
because the door's `ignore-duplicates` resolves only on the key and a composite
unique answers 409; a translated row indexed for search needs its language's
text-search dictionary; and omnishell's `data-prefetch` would warm a route
before the click. `guis/iris` runs the change-feed half: `translate.yaml`
captures a translation-request row, and `server/utils/translate.ts` translates
and caches it per (item, language).

## The design scale

**The ladders a second vocabulary has not won.**
[The quotation](docs/design-scale.md#the-quotation) refuses an app seam on
`#Design` until a second whole vocabulary exists that an app measurably lands on
more than the shipping one. Primer Primitives 11.10.0 supplies two of the nine
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
dimension fail `cue vet`, so each argument has to be won before the composition
compiles. The step counts are upstream Primer's, which this tree vendors only
as `typography.css`.

## Screens

**Forms, placeholders, create forms and renderer names are found at hydrate,
not at lint.** `check markup` compares a region's table and filter columns with
the emitted schema, and nothing compares a `data-form` whose id is not in
`#Screen.forms` or whose `[name]` inputs differ from its `fields`; a `{col}`
with no column on its row (`screen.js` throws at bind, and visual lint sees
only painted braces); a `create` form on a `tab` or `device` entity that
omits a field no SQL default fills; or a `data-text-format` that is neither a
built-in nor a declared renderer. Each is a set difference needing no page and
no cluster, and belongs in omnishell's `interpreter/lint.ts`; the placeholder
rule must resolve `param.*`, `{now}`, dotted embeds and `data-empty-row`
fields, and read a region's own `data-filter` against the enclosing row.

**No rendered document ships, and a route's `ssr` is read by nothing**
([screens](docs/screens.md#how-a-routes-first-document-is-rendered)).

**The dual witness has no reader.** `prerender.ts` writes `pronto-cas`,
`pronto-lsn` and `__PRONTO_STATE__`, and nothing reads them. The design: rows
since `pronto-lsn` stream in as deltas, a template whose `pronto-cas` differs
is fetched by hash and applied when `__prontoBusy()` is idle, and template,
bundle and stylesheet live under content-addressed paths. Every asset is served
under a stable path with `no-cache`.

**A screen's states are not derived from what it reads.** A `tab` or `device`
read is total and synchronous, so it has no `loading`, `gone` or
`network-error`; `#Screen.states` is a free list, so a browser-only screen is
storyboarded against states it cannot reach.

**Nothing catches a column no screen reads.** Each one so far was found by hand
with a grep: a chart's `nxt_pos` whose reader was rewritten out from under it,
and `typed` on four menu entities, a fossil wearing a one-member CEL that made
it look deliberate. The rule is decidable off the facts `derive.ts` extracts —
a field must be bound in markup, named in a filter, an order or a projection,
be a chart's own field, or be written by one — and the same pass catches a CSS
rule matching no class on its own screen.

**Screen state is decided by whichever top-level region refreshed last**, so a
screen can settle on a state its route does not declare (`screen.js`).

**A region cannot render SVG.** A `<template>`'s content is parsed as HTML, so a
region filling an `<svg>` produces elements in the wrong namespace — present,
carrying every attribute the binding wrote, drawn by no engine, and rendered
happily by linkedom. Only the browser tier sees it.

**`check parity` runs nowhere.** realworld declares `capabilities: native:
true` and `check-parity.ts` exists, but omnishell's `terminal.cue` declares no
`parity` check, so no app's `.say.yaml` carries one and the native peer of a web
affordance is never compared.

**`just generate` fails in the shadcnui gallery** (last checked 2026-09-20).

## Visual lint

**A perpetual animation reads as a screen still moving.** `settle()`
fingerprints every element's geometry and waits for it to hold still; a
rotating square's bounding box changes with the angle, so one spinner leaves a
route reported as moving and everything measured after it measured a moving
screen. The atoms screen works around it by spinning a pseudo-element, which
the fingerprint does not walk — an app should not have to know that. Emulating
`prefers-reduced-motion` would settle every such route by construction, and it
is already what visual lint means by a settled moment.

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

## Release targets

Only `pages` is emitted, and each design is
[release targets](docs/release-targets.md)'s, built on a branch of its own.

**`cloudflare` has no rule** ([the design](docs/release-targets.md#cloudflare)).

**`gcp` has no rule**, no `clusters/gcp.cue` and no skaffold profile in
`builders/bayt.cue` ([the design](docs/release-targets.md#the-clouds-and-k8s)).

**`aws` has no rule** ([the design](docs/release-targets.md#the-clouds-and-k8s)).

**`azure` is not in `#Target`**
([the design](docs/release-targets.md#the-clouds-and-k8s)).

**`k8s` is in neither `#Target` nor `#Tier`**
([the design](docs/release-targets.md#the-clouds-and-k8s)).

**`verify@<target>` is not emitted**
([the design](docs/release-targets.md#what-a-release-is)).

**The page runs no pipeline and serves no blob, and `pages` refuses neither**
([pages](docs/release-targets.md#pages)); either mecha's `pipeline` package runs
in the page, or the target refuses both.

**A unit cannot be bundled** ([pages](docs/release-targets.md#pages)). Bundling
it needs three changes the terminal owns: `hatch.js` admitting `blob:`, the
hatch worker resolving its siblings from its own `location.hash`, and the glue
starting at `glueBlobUrl#<wasmBlobUrl>`.
