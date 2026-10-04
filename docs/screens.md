---
type: concept
title: Screens
description: How pronto compiles a screen — what it derives from the markup, what it checks the markup against, and how each route's first document is rendered and cached.
---

# Screens

A screen is a route's HTML and CSS, written as assembly under `shell/screens/`
or composed as a `markup` string in CUE, plus what `#Screen` keeps about it:
the route, its forms, its storyboard states and paths, how many instances the
navigation stack holds, and how its first document is rendered. The markup is
the authority on what a screen reads and binds; the program is the authority on
what exists. pronto derives the first from the markup, checks the markup
against the second, and decides per route what a crawler and a first paint
receive. Writing a screen is omnishell's [GUIDE](../../omnishell/GUIDE.md), and
every attribute it may carry is its [REFERENCE](../../omnishell/REFERENCE.md).

## Derived from the markup

`derive.ts` reads each screen through the terminal's own markup reader and
writes three lists into `program_derived.cue`, which unifies into the program:

- `reads`, every read the markup makes as the terminal routes it (`#Read`): its
  table, whether it is a `data-live` region, a reduce's `data-reads` or a
  named `data-read-*`, whether an enclosing region nests it, its route (`server`, `snapshot`, `whole` or `view`, from
  omnishell's `routeOf`), its filter's clauses as column and op, the tables its
  select embeds, its cap, and every column an order it can be in names;
- `writes`, every write it states (`#Write`), by table: a form, a chart's
  effect, and each region's reduces (`data-on-<event>`, a drag's
  `data-handler`) as op `reduce` on its table;
- `files.handlers`, every module `data-handler` and `data-on-*` bind.

They are facts, never decisions. All three are required on `#Screen`, so a
screen the derived file misses fails the export, and so does an html file for a
screen the program no longer declares. A screen authored in CUE has no html
before its first export, so it starts from empty lists and `write.ts` re-derives
until the derived file holds what the emitted markup says.

**Two statements of one fact need a checker, or one of them derived.** Reads,
writes and handlers are derived, so no check compares them: a rule comparing a
restatement with the markup would be grading a copy.

### The reads decide how a table syncs

What the program concludes from the reads is CUE's: `sync.cue` computes
`#App.#sync`, every server entity's sync mode with its reason, and it lands on
`#Entity.sync`. A table loads **on demand** — its shape opened from now and each
view's rows loaded as a subset snapshot — only when nothing could read its
collection as if it were the table:

- it is not `offline`, the rung that keeps the whole table on the device
  ([lattice](lattice.md));
- everyone may read it, since a view cannot restate a narrower visibility;
- every read of it is a view the engine maintains, or one the server computes;
  a reduce's `data-reads`, a named read, a whole read, a snapshot read (a
  boolean, range or pattern clause), a view ordered by a column the engine
  does not order and any read of a table not everyone may read all read the
  collection, and so does such a read's embed;
- no view of it, and no view joining it, is read once per row of a list (one
  inside an item template, or a named one a region stamps, and so on out
  through the lists stamping that region): each row would ask
  for its own subset where an eager table loads once. A view nested only in
  slots reads once, as a slot binds one row, and so does one in a list whose
  filter pins a key or a unique of its table with `eq` (a game's goals under
  the one game). The reader names the lists stamping each read (`#Read.lists`)
  rather than the rule taking a declaration, so the markup that stamps the
  rows is what decides;
- every column such a view filters on, and every order column of a capped one,
  is a type Electric compares (`subset` in [the type table](types-and-identity.md));
- no capped view orders it by free text (an `order: "text"` type with no
  pattern, `string`): Postgres picks the rows inside the cap by the cluster's
  collation and the view orders them by the reader's locale, so the two can
  hold different rows. Pinning the view's comparison to the server's was
  rejected: TanStack offers a lexical order or a browser locale, and neither
  is ICU root;
- no fold, validation, visibility rule or the signed-in strip reads it outside
  a region;
- no screen has a reduce, whatever event it is bound to: its updates and
  effects name their own entities, which the markup cannot say, so a reduce on
  any screen keeps every server table eager. Declaring the entities a reduce's
  module writes was rejected while no app with an on-demand table has one: it
  is a statement of code a checker would have to grade;
- no screen upserts it or deletes from it by filter, and its key is a type
  Electric compares: a write by key loads a row
  no view loaded as a view of its key, so the key a form or an effect carries
  may come from anywhere on the screen. Asking instead that the screen hold a
  view of the table, or that the write sit in the region whose row it names,
  was rejected: an effect binds its key by interpolation, from any row, and a
  view of the table on the same screen proves nothing about which rows it
  loaded.

Every other server table is **eager**. derive writes each mode and its first
reason into the fact store as `sync_mode`, and `shell.yaml` names the on-demand
tables under `sync`. An author cannot state a mode: one the rule contradicts
fails to unify. The terminal raises a ProgramError at any read that would take
an on-demand collection for the table ([data](../../omnishell/docs/data.md)),
which is where a drift between the rule and the store shows.

## Checked against the program

Every check runs at the cheapest verb that can answer it, and the grammar's
rules belong to whoever publishes the grammar: `interpreter/lint.ts` states the
terminal's rules beside its vocabulary, and `check markup` runs them against
what the app emitted, so a terminal consumed without pronto brings them along.

| check | verb | judges against | refuses |
|---|---|---|---|
| omnishell `check markup` | `lint` | `shell.yaml`'s `schema:` and `routes:` | a table the program does not declare; a `data-filter` column its entity lacks; a slot that may bind more than one row; a format its column cannot carry; a machine write its column cannot hold; an item template that is not one element; a control no seam reaches; a link written as a path instead of a route |
| omnishell `check handlers` | `lint` | the role each module runs in | a declared module that does not load in its compartment |
| pronto `check-facts` | `lint` | `.pronto/facts.json`, through `invariants.sql` | a stylesheet redeclaring a token the shared layer owns; an `@import` nothing serves; a route the ir and the program spell differently; a literal where a rung exists ([the design scale](design-scale.md)) |
| visual lint | `integrate` | the running app | binding text such as `{col}` painted on screen, among its other checks ([visual lint](../../omnishell/docs/visual-lint.md)) |

**A rule that reports the platform's own grammar as an error is not ready.**
The filter rule reads the one filter grammar (`parseFilterSpec`), where `limit`
is a cap and an embed path is the server's to resolve, not a column. A region's
own `data-filter` interpolates the enclosing row, not its own. A rule gates
only after it has run clean over every app, which is where both of those
false positives show.

**Check against published data, never a copy.** The columns, uniques, closed
value sets and routes reach the checkers in `shell.yaml`, derived from the
program, and the text formats in `terminal.cue`. A checker that hard-codes any
of them is the next thing to drift.

What no static rule can say: whether a filter matches any row
(`pinned=eq.maybe` is well-typed and matches nothing), whether the CSS makes a
state visible (visual lint), whether a reduce's conclusion is right (a
[test pair](compiler.md#the-ladder)), or whether `keep` is right and the states `paths`
claims are reachable, which nothing walks without a browser.

**The numbered rules.** The comparisons between a screen's markup and its
program carry numbers the code and its tests cite (`R2` in `lint.ts`); there is
no R4.

| rule | states | where it stands |
|---|---|---|
| R1 | a region reads only collections its screen declares | derived: `reads` is written from the markup, so there is nothing to compare |
| R2 | a filter names only columns its entity has | `unknownColumns` in omnishell's `interpreter/lint.ts`, run by `check markup` |
| R3 | a `data-form` is a form the screen declares, with exactly its fields | not built |
| R5 | every `{field}` placeholder resolves against the row that binds it | not built; visual lint sees the braces once painted |
| R6 | a browser-tier `create` form states the whole row | not built |
| R7 | a handler, renderer or shared stylesheet the markup names is declared | handlers derived into `files.handlers`; an `@import` nothing serves is `check-facts`'s; renderer names not built |

What is not built is found at hydrate instead ([pending](../PENDING.md#screens)).

## How a route's first document is rendered

pronto owns the policy: which routes are rendered where, and what the door and
a crawler are told. omnishell owns the mechanism: rendering markup anywhere a
DOM exists, and adopting rows it finds already rendered
([screen updates](../../omnishell/docs/screen-updates.md#a-pre-rendered-page)).
The policy is a route's `ssr` crossed with the access scope of what it reads:

| `ssr` | read scope | rendering | caching | crawler | in this tree |
|---|---|---|---|---|---|
| `ssg`, `prerender: true` | `public` or none | one document per locale at build: the screen's empty state | immutable file | indexed | rendered and graded at `test`, never shipped |
| `ssr` | `public` | on write, purged on change | public, purged | indexed; title, OpenGraph and JSON-LD from rows | not built |
| `ssr` | `private`, `folder` | per session under row-level security | `private, no-store` | `noindex` | not built |
| `spa`, the default | any | the entry shell; the store takes over | shell only | disallowed | built |

A public row is cacheable for everyone and a private one for nobody, so
cacheability follows the visibility axis and is derived from `access.scope`,
never declared a second time ([access](access.md)). A `tab` or `device` entity
has no scope: the browser holds it, and a screen over one renders as the shell.
Rendering early moves content earlier, not interactivity: the client bundle
still loads.

**`ssg`.** `prerender` and `ssg` imply each other, and `prerender` refuses a
route with a `:param`, because the rows an `/article/:slug` needs do not exist
when the build runs. It also needs `meta.i18n`, since one document is written
per declared locale. [`prerender.ts`](../prerender.ts) renders each route in
its `empty` state through the storybook renderer against the fixture store and
writes the app's own entry document with the screen's markup in its mount:
`lang` and `dir`, a `<title>` from the screen's `h1` (a route without one
fails), canonical, `hreflang` and `x-default` links, the screen's stylesheet
inline (an `@import` in a linked sheet resolves against the sheet, not the
document), root-relative asset paths, and the dual witness —
`<meta name="pronto-cas">` (a hash of the markup), `<meta name="pronto-lsn">`
(`0`, since a build has no data clock) and `<script id="__PRONTO_STATE__">`
carrying both. The `prerender` check runs it at `test` into a directory it then
deletes: what is graded is that every address renders. The image carries none,
so Caddy's `{path}/index.html` never matches and a crawler gets the entry
shell ([pending](../PENDING.md#screens)).

**`ssr`.** `#Screen.ssr` is written into `shell.yaml`, and no interpreter file
reads it, so both `ssr` rows of the table are unbuilt.

**The door and the crawler files.** Caddy answers `{path}` or
`{path}/index.html` when the image carries one, else the entry document for a
path that matches a route, else 404, all `Cache-Control: no-cache`.
`robots.txt` allows everything and names the sitemap when the app requires no
sign-in, and disallows everything otherwise: an app behind a login wall is not
a site. `sitemap.xml` lists every route with no `:param` in any locale's
spelling, with its locale alternates where the app declares locales, since an
address invented for a row id is a 404 or somebody's row.

The shell replaces its mount's contents when it boots, so a live app renders
over a prerendered document from its own store rather than adopting it; that
document is the empty state and holds no rows to adopt. What the witness is for
— a stale page catching up by streaming the rows since `pronto-lsn` and
fetching the template whose `pronto-cas` differs — has no reader
([pending](../PENDING.md#screens)).

## Rejected

- **Comparing a restatement of reads or handlers with the markup** — derive
  them, and there is no second statement to drift.
- **Deciding a table's sync mode in derive.ts** — derive projects the markup,
  and a rule over the projection, the entities and the type table is the kind
  of conclusion the rest of the program draws in CUE; in TypeScript it was a
  second front end for the program, with its own copy of the type table.
- **Declaring a sync mode per entity** — the reads already say it, and a
  declaration could claim on-demand for a table a screen scans whole.
- **A content hash in a public path** — it breaks every shared link at the next
  deploy, fragments a crawler's index, and needs a canonical back to the
  unhashed URL, conceding that URL was the identity. Hashes belong on internal
  assets; the public route carries the witness instead.
- **Diffing the DOM against a collection, or a virtual DOM on the client** —
  the delta is already computed upstream (WAL, shape, collection, live query),
  and rows carry a real key, so hydrating is adopting nodes by `data-id` in one
  pass with no component tree to re-execute
  ([screen updates](../../omnishell/docs/screen-updates.md#rejected)).
- **Streaming HTML and Suspense chunks** — the document is whole, and changes
  stream over the sync connection.
- **Serialising machine state into the page** — only rows and the two clocks
  cross the wire.
- **Guessing a TTL** — change capture knows when a row changed, and the witness
  says what a page was rendered from.
- **The SSR frameworks as they are** — Next.js and Astro guess at invalidation
  with no view of the database, Qwik resumes with no sync engine, LiveView fails
  offline, and Linear's local-first sync ships no public page.
