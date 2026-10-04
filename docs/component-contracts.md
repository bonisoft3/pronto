---
type: concept
title: Component contracts
description: What each part of a pronto program — the app, the terminal, the cluster, the loop and the build graph — declares as its state, its capabilities and its surface, and how data flows between them as one graph.
---

# Component contracts

A pronto program is five CUE values in one package. `code` is the app itself,
a `pronto.#App`. The other four are the systems it runs on: `cluster` (mecha),
`terminal` (omnishell) and `loop` (sayt), each published by its own module, and
`build`, pronto's own build graph lowered onto bayt's `#project`. Each part
declares what it holds, what it offers or asks for,
and what it exposes for another part to compose against. `#emit` in
[`emit.cue`](../emit.cue) is the one place they meet, and data moves among them
as one graph.

## The five parts

| part | type | re-exported by | default instance |
|---|---|---|---|
| `code` | `#App` ([`schema.cue`](../schema.cue)) | — | the app's `program.cue` |
| `cluster` | `#Cluster` ([`cluster.cue`](../../../libraries/mecha/cluster.cue)) | [`clusters/mecha.cue`](../clusters/mecha.cue) | `#DefaultCluster` |
| `terminal` | `#Terminal` ([`terminal.cue`](../../omnishell/terminal.cue)) | [`terminals/omnishell.cue`](../terminals/omnishell.cue) | `#DefaultTerminal` |
| `loop` | `#Loop` ([`loop.cue`](../../sayt/loop.cue)) | [`loops/sayt.cue`](../loops/sayt.cue) | `#DefaultLoop` |
| `build` | `#Build` ([`builders/bayt.cue`](../builders/bayt.cue)), over bayt's `#project` | — | `#DefaultBuild` |

The brief's frontmatter and [SPEC](../SPEC.md#frontmatter-the-per-app-harness)
call the last four, with the team, **seats**: a slot in the program that an
implementation fills. `cluster: mecha` in a brief resolves through the file
under `clusters/`, which re-exports one implementation from its home. Pronto
owns the roster and each implementation owns itself, so adding an
implementation is one roster file, and pinning or forking its module is how a
program versions it. The emitted `bayt.cue` redeclares `cluster`, `terminal`
and `loop` unchanged, and that redeclaration is where a human overrides one by
unification.

## What each part declares

| | state | capabilities | surface | identity |
|---|---|---|---|---|
| `#App` | `entities`, `pipelines`, `schedules`, `migrations`, `rawMigrations` | requested: `auth`, `native`, `blobs`, `hatches`, `vendored` | `screens`, `handlers`, `design`, `flows` | `meta`: `name`, `ir`, `targets`, `clocks`, `decisions`, `tests`, `i18n`, `favicon` |
| `#Terminal` | `navigation: true` | offered: `auth`, `text-formats`, `message-arms`, `renderer`, `sensors`, `background`, `hardware`, `os-bridge`, `network-peer`, `isolation`, `hatch`, `floors` | the entry page and its `assets`, the served file lists, `verbs`, `checks`, `statics` | `app`, `description`, `language`, `direction` |
| `#Cluster` | `migrations`, `pipelines`, `schedules` (names only) | switches: `server`, `auth`, `blobs` | `targets`, `verbs`, `checks` | `meta`: `app`, `images`, the door, `statics` |
| `#Loop` | — | — | `sources`, `buildCmd`, `testCmd`, `verbs`, `checks`, `sayYaml`, `tasksJson` | `meta.app` |
| `#Build` | — | — | `project`, bayt's `#project`; `checks` beside the stack | `meta`, plus the `cluster` it lowers |

**State** is data that persists and is queried. It is domain-shaped on the app
(entities), infrastructure-shaped on the terminal (the navigation stack, which
the terminal owns outright and no app configures beyond a screen's `keep`), and
thin on the cluster, which learns only which migrations to apply and whether a
schedule exists. The loop and the build graph own no data.

**Capabilities are offered on one side and requested on the other.** The
terminal publishes what it offers as data, the app asks against that
vocabulary, and `#emit` refuses the mismatch at `cue vet`: an auth mode the
terminal does not list, a vendored unit whose `isolation` it does not offer,
a `"group.name"` capability it does not declare, or a unit whose `src` is not
among its files. The cluster's capabilities are switches, each turning on a
**plane**, mecha's word for the services behind one switch: the data plane
(`server`), the auth plane and the blob plane. `#DefaultCluster` derives every
switch from the app, so none is wired by hand.

**Surface** is what another part composes against. The terminal's screens are
a file-path projection of the app's (`#DefaultTerminal`), the cluster's surface
is the bayt targets it runs as, and the loop's is nearly everything it has,
because a lifecycle contract exists to expose verbs. The terminal's own entry
page, stylesheet, boot script and service worker reach the app as values
(`surface.assets`), embedded inside omnishell's package: `@embed` cannot leave
its directory, and `write.ts` refuses a `src` outside the app.

**Returned requests are a protocol, not a field.** A reduce's `{updates, then}`
and a machine's effects are how a unit acts on state
([the terminal's surfaces](../../omnishell/docs/terminal.md#what-the-terminal-owns)).
They are the verb, not a third noun beside state and capabilities, so no part
declares them. `#App.surface.flows` is the one place a program names one,
filed under the screen it starts from.

## Checks and verbs

The terminal and the cluster each declare `checks` and `verbs` about their own
surface, each naming the verb whose layer it needs: `lint` for what fails in
seconds without running the app, `test` for fixtures with no live service,
`integrate` for anything that needs the cluster up. `#DefaultLoop` merges both
with pronto's own compiler checks, a name declared twice is a unification
conflict rather than an overwrite, and the loop buckets them into `.say.yaml`
by verb. So a check the terminal publishes (visual lint, `check markup`,
`check battery`) lands in every app's loop, and mecha's `caddy` check with it.

The checks are invariants of that part's own surface, the way `auth` is its
doctrine: an app cannot be expected to re-derive that a tap target has a
minimum size, and apps that each did would each do it differently.

An app's own check that talks to the running app is declared on the build
seat, `build: checks: <name>: {cmds, note}`, because what it needs is a
container: the build graph gives each one a service beside the stack, on the
runtime's compose network, that waits on the launch aggregate healthy and
reaches the app at `https://caddy:8443` (`APP_URL`, which omnishell's
`baseUrl` honours). Caddy's own CA signs the certificate there, so a command
ignores errors for `caddy`. `#emit` files the rule under `integrate`, under the
check's `priority`; the rule brings the stack up if it is not, and its verdict
is the container's exit code. The image is setup's — the trees and the app's
pinned toolchain, under `mise x` — or, with `browser: true`, the same toolchain
on playwright's base. It carries `tests/**`, plus whatever `srcs` names.

```cue
build: checks: "favorites": {
	priority: 1
	cmds: ["deno run --config tests/deno.json --no-lock --allow-env --allow-read --allow-net --unsafely-ignore-certificate-errors=caddy tests/favorites.ts ."]
	note: "a favourite is counted by the pipelines"
}
build: checks: "paint": {
	browser: true
	srcs: ["fixtures/**"]
	cmds: ["deno run -A --unsafely-ignore-certificate-errors=caddy tests/paint.ts ."]
	note: "the painted colours against the ground truth"
}
```

## Web platform envelope

An app's inner domain is its state ([entities and pipelines](#what-each-part-declares)) and surface ([screens](screens.md)). Between the client runtime and the outside world sits the **web platform envelope**: the metadata, HTTP door routing, and discovery documents declared under `#App.meta` that browsers, OS shells, crawlers, and LLMs read before or outside screen execution.

### Favicons & App Icons (`meta.favicon`)

An app declares browser and home screen icons under `#App.meta.favicon`:

- **String shorthand**:
  - Short glyph, emoji, or text (e.g. `"🚀"`, `"R&D"`): synthesized into an SVG vector icon at `shell/favicon.svg` and linked as `<link rel="icon" type="image/svg+xml" href="./favicon.svg">`.
  - Raw SVG markup (e.g. `"<svg xmlns=..."`): written directly to `shell/favicon.svg` and linked as SVG.
  - Local asset path (e.g. `"favicon.ico"`, `"shell/favicon.svg"`): paths under `shell/...` are linked under base (`./...`), while other paths are linked from origin root (`/...`) with leading `./` or `/` normalized; registered as cluster statics (`/srv/...`). Supported formats: `.ico`, `.png`, `.svg`, `.webp`, `.jpg`, `.jpeg`.
  - Remote URL (e.g. `"https://..."`): linked verbatim without cluster static registration.
  - Data URI (e.g. `"data:image/svg+xml,..."`): linked with HTML attribute quotes escaped (`&quot;`).
- **Structured item or list**: `#FaviconItem` (`rel`, `sizes`, `type`, `href`). Local assets are registered as cluster statics (`/srv/...`), resolved per path rule, and inlined into data URIs during single-file page bundles (`bundle.ts`).
- **Safari on iOS apple-touch-icon constraint & auto-derivation**: Safari on iOS strictly refuses SVG, WebP, ICO, raw SVG markup, and emoji for `apple-touch-icon`. Declaring an explicit `rel: "apple-touch-icon"` with any unsupported format fails compilation loudly (enforced strictly by extension and content prefix, ignoring spoofed MIME types). When no explicit `apple-touch-icon` is declared, the compiler automatically derives `<link rel="apple-touch-icon" href="...">` if a PNG or JPEG favicon is available, prioritizing touch sizes (180x180, 192x192, 512x512). If only SVG, WebP, or emoji favicons are present, no invalid apple-touch-icon tag is emitted.
- **Door**: Caddy serves the first match among `/favicon.ico`, `/shell/favicon.ico`, `/favicon.svg`, `/shell/favicon.svg`, `/favicon.png`, and `/shell/favicon.png` with `Cache-Control: no-cache`. If none exist, unsolicited probes receive a 204 No Content response to satisfy Lighthouse audits without spurious 404 logs.

### Web App Manifest & Mobile Chrome (`meta.manifest`, `meta.themeColor`)

Declared via `meta.manifest: bool | #Manifest` and `meta.themeColor: string`:

- **Schema defaults**: When `manifest: true`, fields default from `#App.meta` (`name`, `short_name`, `description`). `display` defaults to `"standalone"`, `start_url` and `scope` to `"/"`, `background_color` to `"#ffffff"`. When omitted, icons are inferred from local and remote `#App.meta.favicon` declarations (including SVG, PNG, WebP, and ICO).
- **Adaptive theme color**: When `meta.themeColor` is omitted, the compiler derives adaptive `<meta name="theme-color" media="(prefers-color-scheme: light)" content="...">` and `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="...">` meta tags directly from `surface.design` tokens (`colors.surface` vs `dark.surface`).
- **PWA shortcuts derivation**: When `manifest.shortcuts` is omitted, shortcuts are automatically inferred from top non-root static screens in `surface.screens` (mapping `title` to `name` and `route` to `url`). When `capabilities.auth.required == true`, auto-deriving PWA shortcuts is suppressed behind the login wall unless explicitly authored in `manifest.shortcuts`.
- **Head injection**: Emits `<link rel="manifest" href="/manifest.webmanifest">`, adaptive `<meta name="theme-color">`, `<meta name="mobile-web-app-capable" content="yes">`, `<meta name="apple-mobile-web-app-status-bar-style" content="default">`, and `<meta name="apple-mobile-web-app-title">`.
- **Door**: Caddy routes `/manifest.webmanifest` and `/shell/manifest.webmanifest` with `Content-Type: application/manifest+json` and issues a `308` permanent redirect for `/manifest.json`.
- **Statics**: Local icons declared in manifest or inferred from favicons are registered as cluster statics under `/srv/`. Remote and protocol-relative icon URLs are preserved without local static registration.
- **Bundling**: `bundle.ts` parses the manifest, preserves absolute or rewrites relative `start_url` and `scope` under `--base`, inlines referenced local icon files as base64 data URIs, and serializes the manifest as a `data:application/manifest+json;base64,...` URI on `<link rel="manifest">`. Referenced local icon files must exist on disk; missing files fail bundling loudly.

### SEO, Social Cards & OpenGraph (`meta.social`)

Declared via `meta.social: #Social`:

- **Tags emitted**: OpenGraph (`og:title`, `og:description`, `og:type`, `og:image`, `og:image:alt`, `og:url`) and Twitter Card (`twitter:card`, `twitter:title`, `twitter:description`, `twitter:image`, `twitter:site`, `twitter:creator`).
- **Defaults**: `title` and `description` inherit from `#App.meta`. `card` defaults to `"summary_large_image"` if `image` is set, else `"summary"`. `type` defaults to `"website"`.
- **Absolute URLs & local images**: Social card scrapers require absolute image URLs. When `image` is a local asset path, `url` must be declared (refused at compile time otherwise), resolving the image against the origin extracted from `url` and mounting it as a cluster static under `/srv/` (root-hosted in cluster deployments). Protocol-relative URLs (`//`) and path traversal (`..`) are refused at compile time.
- **Canonical links**: Authored per-route by prerenderers rather than statically in the shared SPA shell to prevent client-routed non-root paths from falsely canonicalizing to root.

### Crawler & LLM Discovery (`meta.llms`)

Declared via `meta.llms: bool | #Llms`:

- **Auto-synthesis (`llms: true`)**: When enabled without manual files, the compiler automatically synthesizes `/llms.txt` (concise overview, authentication model, screens, entity index) and `/llms-full.txt` (full AST/IR specification with complete field types and screen reads). When `capabilities.auth.required == true`, auto-synthesizing schema is refused at compile time to protect private data models.
- **Author overrides**: `text` or `file` for `/llms.txt`, and `fullText` or `fullFile` for `/llms-full.txt`. When manual `text` or `file` is supplied, `/llms-full.txt` is not synthesized unless `fullText` or `fullFile` is explicitly declared. Declaring both `text` and `file` for the same document is refused at compile time.
- **Cluster statics**: Emits `srv/llms.txt` and `srv/llms-full.txt`.
- **Door**: Caddy serves `/llms.txt` and `/llms-full.txt` with `Content-Type: text/markdown; charset=utf-8` and `Cache-Control: no-cache`.

### Sitemaps & Search Engine Discovery (`meta.sitemap`)

Declared via `meta.sitemap: bool | #SitemapConfig`:

- **Intelligent priority and change frequency**: Root routes (`/`) infer priority `1.0`. Screens with entity reads infer priority `0.8` and `"daily"` change frequency. Static screens infer priority `0.6` and `"weekly"` or `"monthly"` frequency. Screen-level author declarations (`screen.priority`, `screen.changefreq`) override inferred defaults.
- **Auth conflict refusal**: When `capabilities.auth.required == true`, declaring `sitemap: true` or an enabled sitemap is refused at compile time because all routes are behind authentication and robots.txt declares `Disallow: /`.
- **Exclusion & Extra routes**: `exclude` (`[...string]`, prefix-matched, must start with `/`) filters screens out of `sitemap.xml`. `extra` (`[...string]`, must start with `/`, `http://`, or `https://`) appends external or unmapped URLs with XML entities properly escaped.
- **Head injection & robots.txt**: When declared, emits `<link rel="sitemap" type="application/xml" href="/sitemap.xml">` in the document head and advertises `Sitemap: {{$o}}/sitemap.xml` in `robots.txt`. When `sitemap: false`, sitemap generation, statics, and robots.txt declarations are disabled.

### Platform Well-Knowns (`meta.wellKnown`)

Declared via `meta.wellKnown: [string]: #WellKnownItem`:

- **Payload options**: `#WellKnownItem` supports string shorthand (text) or `{text?: string, file?: string}`. Declaring both `text` and `file` is refused at compile time.
- **Static emission**: Files are mounted under `/srv/.well-known/<name>`. Keys containing `/` or `..` and file paths containing `..` are compile-time refusals.
- **Door**: Caddy serves extensionless files under `/.well-known/*` (such as Apple App Site Association `apple-app-site-association` or asset links) with `Content-Type: application/json`.

### Early Resource Hints (`meta.preconnect`, `meta.dnsPrefetch`)

Declared via `meta.preconnect: string | #PreconnectItem | [...(string | #PreconnectItem)]` and `meta.dnsPrefetch: string | [...string]`:

- **Ordering**: Injected at the head of envelope links, preceding favicons, manifests, and social tags.
- **Crossorigin**: Preconnect accepts origin string shorthand (`"https://fonts.googleapis.com"`) or `#PreconnectItem` with `crossorigin: true` (emitting `<link rel="preconnect" href="..." crossorigin>`).
- **Validation**: Origins must begin with `https://`, `http://`, or `//` and cannot contain whitespace, newlines, or `..`.

## One graph

```
form or reduce ──► collection (optimistic, outbox) ──► PostgREST ──► Postgres
                        ▲                                               │
                        └────────────── Electric shape ◄─────────── WAL ┤
                                                                        │
collections ──► live query ──► region ──► DOM          bus ◄── Conduit ◄┘
                                                        │
                                          pipeline transform ──► sink table
```

- **Collections are the graph's input nodes**, not its sink. An optimistic
  local write and a row synced from the server arrive at the same node, which
  is why one model covers the terminal and the cluster.
- **Postgres is upstream of reads and downstream of writes.**
- **The region is the sink**, and the terminal owns it. Rows are keyed by
  primary key, so the sink applies a delta rather than diffing two trees
  ([screen updates](../../omnishell/docs/screen-updates.md#when-data-changes)).
  A sink whose input empties takes its output with it: a vanished row is a
  removal, never a template left standing over the last value.
- **A pipeline is the same shape one tier down.** The bus carries the
  messages, the transform is the pure operator, and its sink table is a
  materialised derived collection, kept off the publication so the pipeline
  does not feed itself ([the lattice](lattice.md#the-durability-ladder)).
- **Durability is an axis of the input nodes**
  ([the lattice](lattice.md)). A `tab` or `device` entity is a collection the
  browser builds from a local factory; the rest arrive through a shape or an
  outbox. A tab-local toggle is read by a region and written by a form exactly
  like a server row, so interface state needs no component, no lifecycle and no
  second data language.

A region's read is a query the store maintains
([omnishell's data](../../omnishell/docs/data.md#a-regions-rows)).
Server-computed reads (full-text search, embed-path filters, hinted or nested
embeds, a filter the store cannot translate) stay PostgREST queries, re-run
when a table they depend on changes. The collections are the change signal,
never a clock.

## Dual planes and the kinetic contract

Pronto separates application state into two planes:
1. **The relational plane**: Durable entities (`tab`, `device`, `server`, `live`) queryable via PostgREST and synchronized via ElectricSQL shapes. Mutations occur on-demand via forms and pure Jessie handlers.
2. **The kinetic plane**: Ephemeral high-frequency states living below `tab` (e.g. 35Hz, 60Hz, 120Hz physics loops, 3D simulations, and canvas interactions).

Rather than abandoning determinism at the kinetic boundary, Omnishell's runtime provides `createKineticHost` governed by the pure engine contract (see [Kinetic host](../../omnishell/docs/kinetic.md)):
- **`initState(seed)`**: Returns immutable initial state.
- **`advanceFrame(state, cmd)`**: Pure fixed-step transition step.
- **`saveState(state)`** and **`loadState(snapshot)`**: Formally verify the algebraic isomorphism $\text{loadState} \circ \text{saveState} = \text{id}$.

The kinetic host decouples simulation ticks from variable display refresh rates, maintains an in-memory snapshot ring buffer, and injects a deterministic Mulberry32 PRNG. This extends Pronto's universal time travel from low-frequency database transactions down to frame-by-frame physics scrubbing, rollback networking, and timeline branching.

## Rejected

- **Returned requests as a namespace beside state** — it repeats MVC's
  controller, which collapses what changed into where things live.
- **Deriving `#emit` by matching field names across the parts** — CUE
  comments are not values, and the lowering is a projection rather than a
  rename: the app's screens become the terminal's file paths, and even identity
  is `meta.name` on one side and `app` on the other. A part changing shape is a
  compile error at every stale reference, so the hand-written wiring cannot
  drift silently.
- **A generic capability map sized from one example** — named groups under
  `capabilities`, the way `auth` has its own field, beat a wrapper built for a
  guess.
- **Capability groups invented per need** — `sensors`, `background`,
  `hardware`, `os-bridge` and `network-peer` are caniuse's own categories,
  grouped by the shape of the authority they grant rather than by topic. GPU
  and Worker APIs (WebGL, WebGPU, OffscreenCanvas, SharedArrayBuffer) are no
  capability: they are the `isolation` axis, which boundary a unit runs behind,
  a different question from which resource it may reach.
- **`transport` for the unit boundary** — a compartment passes no messages;
  what varies across compartment, iframe and worker is the boundary, so the
  field is `isolation`.
- **`pages` for screens** — "screen" is the design-layer word both Apple's and
  Android's guidelines use, while their API class names have changed twice.
- **`islands` for handlers** — Astro's islands are hydrated components that own
  their DOM, nearly the opposite of a pure function with nothing endowed.
  Elm's `update` assumes the whole model, which a handler is denied, and
  React's `useEffect` assumes the imperative access SES exists to prevent; a
  plain event handler has the right shape, bounded arguments in and a decision
  out.
- **A file extension for Jessie** — Jessie is a subset of JavaScript's syntax,
  so a handler must stay loadable as an ES module; `#File.format` tells a
  handler apart as `"jessie"`, and `#Jessie` pins its path to `.js`.
- **Reaching the terminal's shell files by `src:` path** — `@embed` cannot
  cross a directory and `write.ts` refuses a `src` leaving the app, so the
  content travels through the package graph as values.
