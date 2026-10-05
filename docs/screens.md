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

Durability decides where data survives and how it stays current. Demand decides
when and how much to load, derived from the reads already present in the
screens. Delaying an eager collection's first subscription is lazy activation;
it still loads the whole shape. On-demand loading instead obtains the queried
subset. No additional app-authored loading mode is needed.

What the program concludes from the reads is CUE's: `sync.cue` computes
`#App.#sync`, every server entity's sync mode with its reason, and it lands on
`#Entity.sync`. Read tables can load **on demand**: the shape opens from now,
then each active query obtains the rows it needs. A broad query on another
screen does not force this screen to download the table.

The runtime chooses per query, using the existing filter, order, embeds and
carrier metadata:

- A maintainable query loads its subset and its embeds by key. Identical
  queries share a view, including nested queries. Distinct nested filters can
  issue distinct requests; this reduces unrelated rows, not necessarily the
  request count.
- A local whole or snapshot query demands complete snapshots of its base and
  embedded tables before evaluating. This includes unsupported predicates,
  unordered caps, unsupported joined keys and capped free-text ordering:
  Postgres collation and browser ordering need not choose the same rows.
- Offset paging, full-text search and other server queries remain server reads.
  Their registered base and embedded collections stay eager: a server result
  loads no local subset, and a collection only signals deletion of rows it
  already holds. Markup records hinted and nested dependencies; foreign-key
  column relations resolve through schema refs. Other tables can remain on demand.

A subscription retains its demands while active. A named read retains them
until it settles, even if its screen leaves. Releasing demand releases the
view, but does not promise immediate eviction of rows cached by Electric.

Entity-wide requirements remain **eager**: `offline` durability, restricted
visibility, folds, validations, access dependencies and the signed-in strip.
Keyed writes also require a key Electric can compare to load an unseen row;
unsupported keys keep their write targets eager. Opaque mutations that need
the complete table demand it when executed and retain that view for later
writes. Tables with no screen reads remain eager.

derive writes each mode and its first reason into the fact store as
`sync_mode`, and `shell.yaml` names the on-demand tables under `sync`. An author
cannot override the derived mode. The terminal refuses incidental partial
collection reads by validation, visibility and fold code; query snapshot reads
instead acquire explicit completeness ([data](../../omnishell/docs/data.md)).

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
a crawler are told. omnishell owns the mechanism: rendering a document anywhere
a DOM exists, and the shell taking it over where it stands once it boots
([screen updates](../../omnishell/docs/screen-updates.md#a-pre-rendered-page)).
The policy is a route's `ssr` crossed with the access scope of what it reads:

| `ssr` | read scope | rendering | caching | crawler | in this tree |
|---|---|---|---|---|---|
| `ssg`, `prerender: true` | none the server holds, each region naming the row it shows first | one document per locale at generate: the screen before its first read | file through a template, a hash of the file as its ETag | indexed; title, canonical, hreflang and OpenGraph | built |
| `ssr` | `public` | on first request, held until a read that drew it changes | `public, no-cache`, ETag | indexed; title, canonical, hreflang and OpenGraph from rows | built |
| `ssr` | `private`, `folder` | per session under row-level security | `private, no-store` | `noindex` | refused at emit ([pending](../PENDING.md#screens)) |
| `spa`, the default | any | the entry shell; the store takes over | shell only | disallowed | built |

A public row is cacheable for everyone and a private one for nobody, so
cacheability follows the visibility axis and is derived from `access.scope`,
never declared a second time ([access](access.md)). A route's scope is the most
restrictive among its top-level reads: a read nested in a region (`nested` in
the derived reads) is under whatever row encloses it, and a `tab` or `device`
entity has no scope, since the browser holds it. Rendering early moves content
earlier, not interactivity: the client bundle still loads, after the document
has painted.

A route whose first view reads rows is rendered with them or not early at all.
Drawn before its reads land, its lists fill once the shell takes it over and
push down whatever follows them: golaberto's `/campeonatos` measured a layout
shift of 0.12 prerendered, and its home 0.74, against 0 for each rendered on
request. So `#DefaultTerminal` refuses `prerender` on a screen reading any
entity the server holds, naming them. A `tab` or `device` read is the
browser's, and the terminal draws a prerendered document from an empty store,
so a tab entity's seed arrives with the shell as the server's rows do, and a
device entity's rows are each reader's own: the terminal's renderer refuses a
prerendered route with a region that draws nothing until its read lands, and
draws one that names the row it shows until then (`data-empty-row`) from that
row, which the reader's own replaces in place. truco's rules are the case: they
name the variant in force, from a fallback match. Drawing a tab entity's seed
into the document was the alternative; it buys nothing `ssr` does not already
draw, and a device read would still need its fallback row.

**`ssg`.** `prerender` and `ssg` imply each other, and `prerender` refuses a
route with a `:param`, because the rows an `/article/:slug` needs do not exist
when the build runs, and a route reading rows the server holds, as above. The emitter lists `documents<address>/index.html` for
every address of every prerendered route, in an app no sign-in walls, and
`write.ts` has the terminal render them (`terminal.surface.documentRenderer`,
`omnishell render documents`, under the config and lock
`terminal.surface.documentConfig` names) from the tree it has just written,
holding what it rendered to the list. Each is the app's entry with the screen in its mount
as it stands before its first read lands (`data-state="loading"`, no empty
note), the strip a guest sees, `lang`, `dir`, a `<title>` from the screen's
`h1`, and its canonical, `hreflang` alternates, `x-default` and OpenGraph.
Nothing at generate knows the origin those are absolute against, so they are
spelled after the sitemap's `{{$o}}`, and each document declares it as
`sitemap.xml` does: the emitter hands both to `write.ts` in the document's
entry, the terminal renders with the one, and `write.ts` writes the other ahead
of the document, any other `{{` in it written as the template's own literal of
it. The door answers them at `/srv<address>/index.html` through Caddy's
`templates`, so the origin is the deployment's `ORIGIN`, which the door holds
as `{$ORIGIN}` and never reads off the request: it answers any Host
([mecha's proxy](../../../libraries/mecha/docs/proxy.md#the-origin)). In
development that is `https://localhost:8443` whichever port the browser is on.

**`ssr`.** A route declaring `ssr: "ssr"` is answered by the terminal's server
renderer ([the server terminal](../../omnishell/docs/terminal.md#the-server-terminal)),
which the emitter adds to the cluster (`terminal.cue`'s `#Render`) beside a
Caddy route sending the route's addresses there, none of which is a file the
door serves: a route whose first segment is a :param widens to every path of
that depth. Its image is built from every file it reads beside its entry
(`shell/`, `messages/`), and an edit to the entry restarts it as an edit to
any of the others restarts the door it restarts with. The renderer reads as a fresh
guest through the door, so its documents hold nothing a stranger could not
read; that is why `#emit` refuses `ssr` over a top-level read whose scope is not
public, and in an app behind a sign-in. A `tab` or `device` read is the
browser's, so the renderer holds of it only what every reader starts from, the
entity's seed (`shell.json`'s `seed`, written from the program's): golaberto's
catalogue is drawn under its search's seeded row. A tab's rows last one page
load, so a document always meets the seed and keeps every row it was served; a
device that kept another row has the regions under it read again as the shell
takes the document over. It renders a document on first request
and holds it until the store wakes a read that drew it, so a document is never
older than its rows' last change reaching the door. While it is down those
addresses answer 502, and past its queue of renders 503: there is no fallback to
the entry shell. Started and still syncing, it is listening, and a request waits
for the rows it reads.

**The door and the crawler files.** Caddy answers a prerendered address with
its document, a route rendered on request from the renderer, `{path}` or
`{path}/index.html` when the image carries one, else the entry document for a
path that matches a route, else 404, all `Cache-Control: no-cache`. What the
door answers through `templates` (a prerendered document, `robots.txt`,
`sitemap.xml`) is answered with a hash of its bytes as its ETag, as every file
the door serves is (mecha's [proxy](../../../libraries/mecha/docs/proxy.md)),
so a revalidation of an unchanged one is a 304: `templates` deletes the
validator, since a template's output is in general no function of its file,
but these spell nothing beyond the address asked, and the asset's `templated`
snippet puts the file's back. A hash of each document stated in the Caddyfile
would be a second statement of every document, written before any is
rendered. An unprefixed address whose reader asks
for another language is answered with that language's document rather than
redirected to it, `Vary: Accept-Language`, and the shell restates the address
with `replaceState`. `robots.txt` allows everything and names the sitemap when
the app requires no sign-in, and disallows everything otherwise: an app behind
a login wall is not a site. `sitemap.xml` lists every route with no `:param` in
any locale's spelling, with its locale alternates where the app declares
locales, since an address invented for a row id is a 404 or somebody's row.

The shell takes the served screen over in place, its rows brought to the
store's by key. Every document names the template it was rendered from
(`pronto-cas`); where that is not the worker's copy of the template, the shell
asks the network which is current and morphs a skeleton whose template has
moved on before it adopts it. That is what lets the service worker paint a
kept document at once, however old.

## Rejected

- **Comparing a restatement of reads or handlers with the markup** — derive
  them, and there is no second statement to drift.
- **Deciding a table's sync mode in derive.ts** — derive projects the markup,
  and a rule over the projection, the entities and the type table is the kind
  of conclusion the rest of the program draws in CUE; in TypeScript it was a
  second front end for the program, with its own copy of the type table.
- **Declaring a sync mode per entity** — the reads already say it, and a
  declaration could claim on-demand for a table a validation requires whole.
- **A content hash in a public path** — it breaks every shared link at the next
  deploy, fragments a crawler's index, and needs a canonical back to the
  unhashed URL, conceding that URL was the identity. Hashes belong on internal
  assets.
- **Diffing the DOM against a collection, or a virtual DOM on the client** —
  the delta is already computed upstream (WAL, shape, collection, live query),
  and rows carry a real key, so hydrating is adopting nodes by `data-id` in one
  pass with no component tree to re-execute
  ([screen updates](../../omnishell/docs/screen-updates.md#rejected)).
- **Streaming HTML and Suspense chunks** — the document is whole, and changes
  stream over the sync connection.
- **Serialising machine state into the page** — only rows cross the wire, as
  markup.
- **A log position in the page (`pronto-lsn`)** — where a client would resume
  the rows from. Clients keep no rows across loads, so a booting shell's first
  read is never older than the document it adopts, and Electric cannot resume a
  shape at a log position without the shape's handle
  ([pending](../../omnishell/PENDING.md#the-terminal)).
- **Rendering the first screen beside the served one and swapping them** — it
  paints the same pixels, and throws away every node the reader was on, with
  their focus, their scroll in it and what they had typed.
- **Navigations from the network first** — a returning reader waits on the
  door for a page the worker holds, and the rows a kept document shows are
  brought current in place anyway.
- **Holding a prerendered list's space while it loads** — it trades the shift
  for a later largest paint (2.3 s against 0.8 s on golaberto's
  `/campeonatos`), since what paints first is then the list that lands last.
- **Rows written into a prerendered document at build or release** — stale at
  the first change after it, where a document rendered on request is dropped
  at that change.
- **Guessing a TTL** — change capture knows when a row changed, and the
  renderer's store is woken by exactly the changes that move a read.
- **The SSR frameworks as they are** — Next.js and Astro guess at invalidation
  with no view of the database, Qwik resumes with no sync engine, LiveView fails
  offline, and Linear's local-first sync ships no public page.
