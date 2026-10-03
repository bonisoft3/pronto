---
type: howto
title: Writing a pronto app
description: The app author's tour — starting an app and running a turn, the layout, the build loop, data modelling, screens, i18n, the capability bar, testing and release.
---

# Writing a pronto app

The author's tour of one app, from the first turn to a release. What a
conforming `brief.md`, `ir.html` and `program.cue` contain is
[`SPEC.md`](SPEC.md); the component knowledge every compile assumes is
[`prelude.md`](prelude.md); a screen, in detail, is omnishell's
[`GUIDE.md`](../omnishell/GUIDE.md), and every attribute it may carry is
omnishell's [`REFERENCE.md`](../omnishell/REFERENCE.md). `apps/thenote` is the
golden reference, compiled through the whole ladder.

## Starting an app and running a turn

Pronto is a CUE module and a source distribution, not a CLI; the agent plugin
carries the installation knowledge, and the
[bootstrap contract](skills/pronto-turn/references/bootstrap.md) is the seed
phase that ends in `./saytw setup`, `doctor`, `generate` and `lint`.

Everything after that is a **turn**: the [`pronto-turn`](skills/pronto-turn/SKILL.md)
skill on every host, [`commands/turn.md`](commands/turn.md) in Claude Code. A
turn routes each obligation to the budget that can decide it — checkable to a
sayt verb, reviewable to a seat — and each step ends in a verdict. It writes no
state file: the tree is the state, and re-running the turn resumes it.

## The layout

An app is one directory. What you author:

| File | What it is |
|---|---|
| `brief.md`, `brief.html` | the product-altitude source and its browser presentation |
| `ir.html` | the engineering design doc, pinned per compile |
| `acceptance.md` | the flat checklist whose `{#accept-…}` ids every test and path cites |
| `DESIGN.md` | the design block in its frontmatter, the argument in its body |
| `program.cue` and the `.cue` files of its package | the program: entities, pipelines, screens, flows, tests, decisions |
| `shell/screens/<name>.html` + `.css`, or `markup:` in CUE | a screen: HTML at `files.html`, or a `markup` string for a component-bearing screen, which the writer emits there |
| `shell/handlers/*.js`, `shell/validations/*.js` | Jessie modules, one arrow function each |
| `pipelines/*.blobl`, `pipelines/*.browser.js` | a pipeline's transform and its browser twin |
| `messages/<tag>.json` | one message catalogue per declared locale |
| `services/database/sql/*.sql` | SQL beyond the derived DDL |
| `seed.json` | seed rows a tool produced, held as data ([Seed rows](#seed-rows)) |
| `tests/*` | the app's own tests and drivers, each declared as a check |
| `.mise.toml`, `mise.lock` | the toolchain, scaffold-owned |

`write.ts` emits the rest — the shell (`shell/shell.yaml`, the entry page, the
stylesheets), migrations, `schema/entities.proto`, `docker/*`, `compose.yaml`,
`bayt.cue` and `bayt.json`, `.say.yaml`, `.vscode/tasks.json`, and the derived
`program_*.cue` files that unify into the program — each with a do-not-edit
header and listed in `.pronto/manifest.json`. Never edit an emitted file; edit
what it derives from and run the writer. `.pronto/` is the compiler's own record
and is committed: `manifest.json`, `identity.json` (see [Identity](#identity)),
`cel.json`, `facts.json`, `seeds.json`.

## The build loop

```bash
deno run --allow-read --allow-write --allow-run --allow-env \
  plugins/pronto/write.ts apps/<name>
```

`write.ts` derives from the emitted markup, re-emits and re-derives until a
fixed point, so a markup change reports errors about the previous markup on the
first run — run it again. Do not delete `shell/screens/*.html` to clear a stale
error: manifest cleanup removes what the last manifest listed and the current
bundle lacks, hand-authored handlers included; omnishell's guide has
[the recovery](../omnishell/GUIDE.md#the-writer-deleted-my-handler).

The verbs are sayt's, and every check lands under the verb whose layer it
needs: `lint` for anything that fails in seconds without executing the app
(`cue vet`, `check-facts`, `check-sql`, `identity.ts check`, omnishell's `check
handlers` and `check markup`), `test` for the app's behaviour against fixtures
with no live service (`tests/*.test.ts`, `check machines`, `check battery`),
`integrate` for anything that needs the cluster up (the migration replay, the
scheduled pipelines, visual lint). `sayt launch` brings the cluster up,
minting a local TLS pair on first run. An app adds a check as
`loop: surface: checks: <name>: {verb, cmds, note}` in its program, and one
that talks to the running app as `build: checks: <name>: {cmds, note}`, which
runs in a container beside the stack
([checks and verbs](docs/component-contracts.md#checks-and-verbs)); it never
invents a verb or a script nobody runs.

On the running shell, `?storybook` renders every screen × state against
fixtures — the review surface, where the dark twin is one more frame — and
`?clock=manual` stops the terminal's clock, which `__prontoClock.advance(ms)`
steps, so a test asserts a timeout rather than sleeping through one; `?tempo=`
and `?seed=` pin motion and randomness the same way.

## Data

### Durability

An entity takes one durability, the cheapest that still holds — `tab`,
`device`, `server`, `live`, `offline`, defined in the
[prelude](prelude.md#durability). The emitter derives table, trigger,
publication entry, policy and the terminal's collection from that one word, so
a reviewer sees the cost someone chose, and a program promotes an entity by
changing it ([the lattice](docs/lattice.md#the-durability-ladder)).

### Access

Each cluster entity declares who may see and change its rows, as `#Access` in
`schema.cue`:

```cue
access: {scope: "private", owner: "owner_id", shared: {via: "note_share", on: "note_id", user: "user_id"}}
access: {scope: "folder", parent: "Note", on: "note_id"}
access: {scope: "public"}
access: {scope: "internal"}
```

`private` rows belong to their `owner` column, optionally shared through a
table (`via`, joined on `on`, granting `user`); `folder` rows inherit a private
parent's access through `on`; `public` is read-only to anyone; `internal` is
reachable by backend services alone. What each mode compiles to, and why, is
[access](docs/access.md).

### Validations

A rule a field or row CEL cannot state and a unique cannot encode is a
validation: a Jessie predicate over the row and the rows its declared
references reach.

```cue
Favorite: validations: "own-article": {
	src:  "shell/validations/own-article.js"
	via:  ["article_id"]
	note: "a reader cannot favorite what they wrote"
}
```

```js
(state, event) => state.rows.article.every((a) => a.author_id !== event.row.user_id);
```

`via` lists the edges the predicate may follow: a field of this entity carrying
`ref` walks forward to the one referenced row, and `"<Entity>.<field>"` whose
field refs this entity walks backward to every row pointing here. `event` is
`{type: "insert" | "update", row}`, the row as it will stand; `state.items` is
`[]` on insert and `[previous]` on update; `state.rows` holds one array per
edge, keyed by the target table, and an edge may be empty. The answer is a
boolean; a refusal carries the validation's name (`refused.validation` in a
machine, `validation <table>.<name>` from the server). No clock, no draw, no
reads beyond `via`.

`derive.ts` refuses, when the writer runs, a `via` that is no reference, an
edge from a server entity to a `tab` or `device` one, two edges to one table,
an edge to a table no screen reads and no form writes, a name a unique already
uses and a denied name in the source. A validation is an ir kind
(`data-kind="validation"`, `data-of` its entity), paired by the bijection like
a handler. Where it runs, when the server judges it, and the rung it fills are
[the lattice's](docs/lattice.md#the-validation-ladder).

### A count the reader is inside of

If the reader can see every row an aggregate is over, count them in a live
query. If they cannot — a favourite count over private favourites — declare a
`fold` pipeline whose sink carries the total and whose private `pair` table
tells each reader whether that total counted them; its fields are
[the fold's](docs/pipelines-and-schedules.md#the-shapes), and why nothing local
can tell is [access](docs/access.md#a-count-the-reader-is-inside-of).

### Seed rows

An entity's `seed` states the rows its store holds before anyone writes one: a
cluster durability renders them into `900_seed.sql`, a `tab` one into
`shell.yaml`. CUE unifies each with its entity's constraints, at every
evaluation of the program — which is right for the rows a program means, and a
tax on every export, vet and check for an archive a crawler produced.

Such an archive is held as data instead: a JSON file beside the program,
outside its package, named by `state: seed: src`.

```cue
state: seed: src: "seed.json" // {"<Entity>": [row, ...]}
```

- Its rows go only to server entities, and render into `900_seed.sql` with the
  stated ones; an entity's rows are stated or held, never both.
- `derive.ts` judges them with `cue vet -d 'code.#Seed' . seed.json` — the same
  constraints a stated row meets — and then with the `beyond` checks. A bad row
  fails the writer, its path in cue's report (`Game.5.home_score`).
- The verdict is recorded in `.pronto/facts.json` (`seed_vetted`) under a key
  over the file, the entities, `program_cel.cue` and pronto's `types.cue` and
  `schema.cue`, so a write that changed none of them does not judge again, and
  the file's `artifact` row makes `check-facts` refuse an edit the writer never
  saw.
- Write a row's constraints as its fields' types and `cel`. A constraint
  written on `seed` by hand is still applied, but the key does not cover it.

Why data, and why judged this way rather than in TypeScript or not at all, is
[held seeds](docs/archive/2026-10-02-held-seeds.md).

### Schedules

Periodic work is declared as `schedules` (`#Schedule` in `schema.cue`), and
mecha's [ticker](../../libraries/mecha/services/ticker/README.md) turns each
occurrence into a row the app's pipelines read; how it wakes, what it
guarantees and how to choose a cadence are there.

```cue
schedules: "session-keepalive": {
	cron:               "*/5 * * * *"   // three touches inside a 15-minute session
	maxLatenessSeconds: 300             // never wider than the cadence
	emits: {entity: "SessionTouch", values: {status: "requested"}}
}
```

- `emits.entity` takes the ticker's five columns with
  `list.Concat([#tickFields, [...]])`.
- `concurrency` is `Allow` unless a second run would do damage; `Forbid` names
  a `done` entity and a filter that says the previous tick was answered.
- A table only the pipeline may read, such as the sessions' cookies, is
  `access: {scope: "internal"}`, and its rows still reach the change feed if it
  is `server`: keep a credential in blob storage and put its key in the row.
- `suspend: true` keeps a schedule declared and inert.

What the emitter refuses — each entity's durability, a target's clock — is
[pipelines and schedules](docs/pipelines-and-schedules.md#schedules).

### Identity

An entity is a durable identity — a Cap'n Proto type id, with ordinals for its
fields — and no model mints it:

```bash
deno run --allow-read --allow-write plugins/pronto/identity.ts mint apps/<name>
```

stamps every entity and field that has none and grows `.pronto/identity.json`;
`identity.ts check` runs at lint and refuses a program that lost one. To drop a
field, set `retired: true` and leave it in place; to change a field's type or
name, retire it and add a new one
([what pronto admits](docs/schema-change-admission.md#what-pronto-admits)).

To change a live database, declare the change as a pgroll migration in
`code.state.migrations` while the entity does **not** declare it; once every
deployment has run it, fold the change into the entity and delete the
migration ([the two-step rule](docs/schema-change-admission.md#pgroll-migrations)).

## Screens

A screen is HTML the terminal interprets, with no build step and no component
per screen. Omnishell's [`GUIDE.md`](../omnishell/GUIDE.md) is the contract and
the rules that bite, and [`REFERENCE.md`](../omnishell/REFERENCE.md) is every
attribute and placeholder, [machines](../omnishell/REFERENCE.md#machines)
included.

## i18n

An app declares its locales in `meta.i18n`, one
[BCP 47 tag](docs/localization.md#locale-tags) each, with the URL segment it is
served under:

```cue
_catalogues: _ @embed(glob="messages/*.json")   // at the package's top level
meta: i18n: {
	default: "pt-BR"
	locales: {"pt-BR": path: "pt-br", "es-AR": path: "ar"}
	catalogues: _catalogues
}
```

`@embed` resolves against the directory it is written in, which is why the
catalogues, `messages/<tag>.json`, are embedded in the app and handed in
([catalogues](docs/localization.md#catalogues)). Markup names a message as
`{msg.key}`, or `{msg[column]}` where a row stores the key, as text content or
an attribute value, never CSS `content`; an element's `data-msg-plural` or
`data-msg-select` picks an arm of a message that is a map. Dates, numbers and
money are the terminal's value formats
([where locale-dependent code runs](docs/localization.md#where-locale-dependent-code-runs)).

A screen opts into a localized address with `slug: "<key>"`, localizes its nav
word with `label: "<key>"`, and, on a route with no `:param`, asks for one
crawlable document per locale with `prerender: true`
([addresses](docs/localization.md#addresses),
[crawlable documents](docs/localization.md#crawlable-documents)). An internal
link names a route rather than a path — `<a data-route="<screen>">`, with
`data-param-<name>` for its params ([links](../omnishell/REFERENCE.md#links)) —
and a language switcher is the same link with `data-locale`.

A missing translation is refused, never shown in the default language: at
`cue vet` for a slug or label key, and by `check i18n` at `test` for the rest
([what it finds](docs/localization.md#catalogues)). Rows are not translated
([rows](docs/localization.md#rows-in-the-readers-language)), and `order=`
cannot order per language ([sorting](docs/localization.md#sorting)).

## The capability bar

An ir is designed against everything the terminal and the cluster publish, and a
decision against a capability the app plausibly wants is a Decisions entry; the
bar, item by item, is the [prelude](prelude.md#capability).

## Testing

The acceptance spine — `acceptance.md` ids cited by `data-accepts`, invariants as
prose with CEL — is [SPEC's](SPEC.md#acceptancemd), and `check-facts` warns
about an acceptance claim nothing has settled. What runs today is the app's own
drivers and omnishell's battery ([the ladder](docs/compiler.md#the-ladder)). An
acceptance driver walks the checklist against the running
app, each case citing the ids it realizes — `apps/truco/tests/acceptance.ts`,
declared as an `integrate` check, drives the table under `?clock=manual`.
Omnishell's `check battery` (at `test`) runs
[the battery](../omnishell/docs/automated-tests-battery.md) over every handler
and validation module; `check machines` fires every arrow of every chart;
visual lint (at `integrate`) fails only on `critical`. Every driver reads `APP_URL`
when set, so the same drivers can be pointed at any door.

## Release

A program names the targets it is released to in `meta.targets`, and each
becomes a `release@<target>` rule. Which targets exist, what `pages` bundles and
refuses, and how a tag deploys are [release targets](docs/release-targets.md).

```bash
sayt release@pages --snapshot   # build dist/browser/index.html and tag nothing
sayt release@pages              # bump the version, tag, and push the tag, which deploys
```

`sayt verify` is [agent-driven](SPEC.md#verify-is-agent-driven). To check a
released door, run an `integrate` driver with `APP_URL` set to it.
