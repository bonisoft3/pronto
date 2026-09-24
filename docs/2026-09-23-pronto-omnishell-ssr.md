# Pronto & Omnishell: The Architecture of Server-Side Rendering

The ground: [`2026-08-02-terminal-planes.md`](2026-08-02-terminal-planes.md) (state, capabilities, surface),
[`2026-08-31-one-ladder-one-grammar.md`](2026-08-31-one-ladder-one-grammar.md) (the durability ladder, DOM as bottom rung),
[`2026-09-17-localized-urls.md`](2026-09-17-localized-urls.md) (localized routing, `prerender: true`, `try_files` in Caddy),
[`../../omnishell/docs/2026-08-02-terminal-doctrine.md`](../../omnishell/docs/2026-08-02-terminal-doctrine.md) (the virtual terminal, units, islands vs screens vs hatches),
and [`../../omnishell/docs/2026-08-02-reconciliation-libraries.md`](../../omnishell/docs/2026-08-02-reconciliation-libraries.md) (rejection of VDOM/diffing libraries, adoption of `moveBefore`).

The claim: **SSR in Pronto is not a separate application server bolted onto a single-page app; it is the projection of the durability ladder through the proxy. Omnishell owns the execution mechanism (pure-rung LinkeDOM evaluation, zero-cost event delegation, state deserialization, and hatch slot containment); Pronto owns the policy and classification (compile-time route labeling from `#Access` and screen read topologies, Caddyfile generation, minimal IVM state dehydration, and CDC-driven cache invalidation).**

---

## 1. Division of Responsibility: Mechanism vs. Policy

The boundary between Omnishell and Pronto is clear:

```
+--------------------------------------------------------------------------+
| PRONTO (The Compiler & System Orchestrator) — Policy & Classification    |
|                                                                          |
| • Reads CUE schemas (#Entity, #Access, #Screen, #Route).                 |
| • Derives read topology: which tables, columns, and filters are read.    |
| • Labels each route at compile time: ssg | ssr | spa.              |
| • Queries Postgres/Electric to produce minimal IVM state slices.         |
| • Emits Caddyfile routing, proxy handles, and CDC cache purge hooks.     |
+------------------------------------+-------------------------------------+
                                     | passes (HTML, CSS, State Slice, Route)
                                     v
+--------------------------------------------------------------------------+
| OMNISHELL (The Virtual Terminal Host) — Pure Mechanism                   |
|                                                                          |
| • Headless LinkeDOM harness (synchronous DOM evaluation).                |
| • Evaluates the pure rung: data-live, data-item, data-text against       |
|   in-memory TanStack DB.                                                 |
| • Serializes state to <script id="__PRONTO_STATE__">.                    |
| • On client: zero-cost event delegation without node replacement.        |
| • Hatches: renders isolated static slots / Declarative Shadow DOM.       |
| • Completely agnostic of Postgres, RLS, CUE, and network boundaries.     |
+--------------------------------------------------------------------------+
```

* **Omnishell is the Terminal.** It executes anywhere (browser DOM, headless Deno, mobile webview). It has no awareness of Postgres, SQL, RLS, or CUE. It knows only templates, in-memory collections, and DOM nodes.
* **Pronto is the Platform.** It compiles high-level product intent into clusters and terminals. It holds the schema graph, knows entity access and durability, configures Caddy, and governs data flow.

---

## 2. Fast in the Pure Rung, Correct in Hatches

Omnishell divides UI into units ([`terminal-doctrine.md`](../../omnishell/docs/2026-08-02-terminal-doctrine.md)): `island` (pure function), `region` (collections + filter), `screen` (collections + params), and `hatch` (isolated escape hatch).

### The Pure Rung (Screens and Regions)
* **Contract**: Pure declarative HTML (`data-live`, `data-item`, `data-text`, `data-filter`) bound to TanStack DB views, styled with CSS. Zero arbitrary user JavaScript.
* **SSR Execution**: Evaluated in LinkeDOM within a **Deno runtime running behind Caddy** (explicitly rejecting Bun in Pronto for uniform Deno standard-library adherence and locked security model).
* **Performance**: Sub-millisecond. Because the pure rung is synchronous and deterministic once rows are in memory, rendering requires no browser instance, no network I/O, and no IPC.

### Hatches and Isolation
* **Contract**: Escape hatches for vendored code, canvas, WebGL, or complex widgets running under explicit isolation ([`schema.cue`](../schema.cue)):
  * `isolation: "compartment"`: SES (Hardened JavaScript) compartment for trusted scripts running in-process with shared memory and zero DOM access.
  * `isolation: "shadow"`: Declarative Shadow DOM (DSD) for layout and CSS style encapsulation without process boundaries.
  * `isolation: "iframe"`: Strictly reserved for untrusted 3rd-party network embeds, rendered with `sandbox="allow-scripts ..."` (strictly omitting `allow-same-origin` to enforce a `null` origin).
* **SSR Execution**: Hatches *cannot* and *must not* execute arbitrary imperative code inside the server's synchronous render loop.
* **Strategy**:
  1. SSR renders the static container element: `<div data-hatch="name" style="...">`.
  2. If the hatch declares static fallback layout, render it via native **Declarative Shadow DOM**:
     ```html
     <div data-hatch="chart">
       <template shadowrootmode="open">
         <style>/* critical fallback CSS */</style>
         <div class="hatch-placeholder">Loading visualization...</div>
       </template>
     </div>
     ```
  3. Client-side [`hatch.js`](../../omnishell/interpreter/hatch.js) takes over post-hydration, instantiating the worker/iframe inside the prepared slot.
* **Verdict**: Microsecond speed in the pure rung; structural correctness and layout stability in hatches.

---

## 3. The Authorization Model: The Google Drive Mental Model

Pronto declares row visibility in [`schema.cue`](../schema.cue#L459) as `#Access`, modeled directly after Google Drive permissions:

```cue
#Access: {
    // 1. Private to owner, with optional explicit collaborators (shared)
    scope: "private"
    owner: string // e.g. "user_id" or "owner_id"
    shared?: {via: string, on: string, user: string}
} | {
    // 2. Inherited from a parent folder/aggregate root
    scope:  "folder"
    parent: string   // parent entity name (e.g. "Note", "Workspace", "Project")
    on:     string   // foreign key column
} | {
    // 3. Anyone on the internet can read
    scope: "public"
} | {
    // 4. System / internal backend only
    scope: "internal"
}
```

### The Nomenclature Shift: From Mechanics to Intent
* **`private`** (replaces `owned`): A resource private to its owner (`owner`), with optional explicit per-object sharing (`shared: {via, on, user}`).
* **`folder`** (replaces `through`): Inherited access from a parent container. A note tag, checklist item, or attachment inherits the permission of its parent `Note`.
* **`public`** (replaces `public-read`): "Anyone with the link can view". Open read access.
* **`internal`** (replaces `service-only`): System-internal pipelines and services; excluded from UI screens.

All legacy `mode:` fields and aliases have been excised: all apps in the monorepo evaluate against pure `scope`.

### How Authorization Directly Governs SSR:
* **`public`**: Anonymous execution. **Publicly cacheable** at CDN/Caddy (`Cache-Control: public, s-maxage=...`). Global state dehydration.
* **`private` / `folder`**: Requires ambient session. Must inject JWT/session into Postgres transaction GUC (`auth_uid()`). **Strictly private** (`Cache-Control: private, no-store`). State dehydration is safe only for the recipient.
* **`internal`**: Refused at compile time if read by any UI screen.
* **`tab` / `device` Durability**: Private to client storage; invisible to cluster and server SSR. Rendered as shell/skeleton; hydrated by client PGlite.

---

## 4. What Beats Everything in Existence: "Materialized SSR" (M-SSR)

Mainstream frameworks (Next.js, Remix, Nuxt, Astro) are bound by the limitations of generic JavaScript component trees: runtime guessing of caching, heavy VDOM hydration, hydration mismatches, and complex server-action protocols.

Pronto’s mathematical foundations (CUE semilattice, Electric lattice homomorphisms, pure-rung declarative HTML) unlock four radical capabilities that define a new paradigm: **Materialized SSR (M-SSR)**.

### 1. Zero-JS Resumable Hydration (0ms TTI)
* **The Industry Dilemma**: React/Vue re-executes the entire component tree on client load to attach event listeners and verify the DOM matches the VDOM. Qwik solved this with a complex compiler that serializes JavaScript closures into DOM attributes (`$()`).
* **The Pronto Breakthrough**: Omnishell screens author **zero JavaScript**. Screens are pure HTML attributes (`data-live`, `data-item`, `data-text`, `data-filter`, `data-on`).
  * The server-rendered DOM is *already* the exact IVM projection.
  * The client needs no VDOM and no component re-execution.
  * Omnishell attaches a **single global event delegation listener** on `#app` for `[data-on]`.
  * **Hydration time is literally 0ms**. The page is interactive the millisecond HTML is parsed.

### 2. Differential Hydration via the Electric Sequence Clock
* **The Industry Dilemma**: A server renders HTML at timestamp $T_0$. The client boots at $T_1$. If database state changed in the interim, React throws a Hydration Mismatch error, causing a full page re-render or flash of content.
* **The Pronto Breakthrough**: Pillar #7 establishes a monotonic sequence clock ($\mathbb{N}$) via ElectricSQL/Postgres:
  1. The server renders HTML at offset $L_0$ and stamps it into the document: `<meta name="pronto-lsn" content="482910">`.
  2. The client seeds its in-memory TanStack DB from `<script id="__PRONTO_STATE__">`.
  3. When the client connects to Electric, it asks for changes: `sync(shape, since: 482910)`.
  4. Electric returns **only the delta** between $T_0$ and $T_1$.
  5. The DOM reconciler uses `moveBefore` to update only the changed rows.
  * **Result**: Zero hydration mismatch, zero duplicate initial fetch, sub-millisecond convergence.

### 3. The Database IS the CDN: IVM-Driven Instant Cache Invalidation
* **The Industry Dilemma**: Edge caching (ISR / SWR) relies on developer guessing: arbitrary TTLs (`revalidate: 60`) or manually authored cache tags (`revalidateTag("article-123")`). Content is either stale or cold.
* **The Pronto Breakthrough**: Pronto compiles `#Screen.data-reads` and `#Route`. The compiler mathematically proves the relationship:
  $$\text{Route}(/\text{article}/:\text{slug}) = f(\text{table: articles}, \text{slug} = :\text{slug})$$
  * When a mutation commits in Postgres, the CDC pipeline (Electric / Mecha transform) knows *exactly* which route was modified.
  * The cluster renders the updated static HTML in the background and pushes it straight to Caddy / Edge KV, or issues an HTTP `PURGE`.
  * **Result**: Dynamic content is served as a static file from the edge (0ms TTFB) with **zero-second staleness**.

### 4. Structural Drift: Structural Clock vs. CAS-Based URLs

What happens when the **static HTML template itself** changes (code deployment, layout tweak, updated CSS), not just the dynamic data rows?

There are two competing strategies:
* **Strategy A**: Put the CAS hash directly in the public route path (`https://example.com/v/b_9f82c/es/reglas`).
* **Strategy B**: The Git Model — Stable Canonical Public Routes with Internal Content-Addressed Storage (CAS) and a Dual-Witness Clock.

#### Why Strategy A (CAS Hash in Public URL Path) Fails:
Tim Berners-Lee's foundational web doctrine is *"Cool URIs don't change"*. Placing the content hash in the public URL path breaks the fundamental contract of the Web:
1. **Broken Links & Social Shares**: If a user shares `/v/b_9f82c/es/reglas` on Twitter or bookmarks it, a typo fix deployed 5 minutes later creates a permanent dead link or forces eternal 301 redirect tables.
2. **SEO & PageRank Destruction**: Search engine crawlers index URLs. If deployment hashes alter paths, Google must discover and index new pages from scratch, fragmenting PageRank and depleting crawl budget.
3. **Canonical Paradox**: To fix SEO, you must add `<link rel="canonical" href="/es/reglas">` anyway, acknowledging that the un-hashed URL is the true identity.

#### Strategy B (The Winner): The Git Model — Public Pointers, Internal CAS
Just as Git pairs mutable human-readable branch pointers (`main`) with immutable content-addressed trees (`commit SHA`), Pronto separates public identity from internal storage:

```
PUBLIC LAYER (Stable Identity / SEO):
  GET /es/reglas  ---------------------> Canonical, permanent, bookmarkable
                                         Returns HTML containing Dual-Witness:
                                         • <meta name="pronto-lsn" content="482910"> (Data Clock)
                                         • <meta name="pronto-cas" content="c_8a12e"> (Structural Clock)

INTERNAL LAYER (Immutable CAS Cache):
  /_pronto/templates/regras.c_8a12e.html -> Cache-Control: public, max-age=31536000, immutable
  /shell/bundle.c_8a12e.js             -> Cache-Control: public, max-age=31536000, immutable
  /shell/style.c_8a12e.css              -> Cache-Control: public, max-age=31536000, immutable
```

#### How the Dual-Witness Clock Revalidates Stale HTML:
When a client boots with a cached HTML document:
1. **Instant First Paint**: The cached document renders immediately (0ms FCP).
2. **Data Reconciliation**: Electric streams row deltas since `pronto-lsn` (0ms data staleness).
3. **Structural Stale-While-Revalidate**:
   * The client shell checks the current cluster CAS hash via the Electric sync handshake metadata.
   * If `document.cas !== cluster.cas`:
     * The shell requests the new immutable template: `GET /_pronto/templates/regras.<new_cas>.html`.
     * Because this URL is CAS-addressed, it is guaranteed to be cached, immutable, and immune to 404 ChunkLoadErrors.
     * The shell evaluates the new template against the live, in-memory TanStack DB store and applies the update at the **Quiescence Boundary**.

#### Mutations and the Quiescence Gate: Why Hot-Swap Never Locks the Store

A critical architectural question arises: **Will hot-swapping the template destroy mutations applied by TanStack DB, or must we lock the store while the new template fetches?**

Neither. Locking the store violates local-first 0ms reactivity, and destroying mutations violates durability. Pronto solves this cleanly through the **durability ladder's separation of rungs** ([`2026-08-31-one-ladder-one-grammar.md`](2026-08-31-one-ladder-one-grammar.md)):

1. **Mutations Live in the Store, Not the Template**:
   * Optimistic writes, unconfirmed transactions, and synced rows live in the **Collections rung** (TanStack DB / PGlite in memory), *not* in the DOM or the template.
   * When the new template is fetched, it is rendered against the **current, live TanStack DB store**. Any optimistic rows or local mutations already present in memory are rendered into the new template automatically.
2. **Never Lock the Store (0ms Reactivity Preserved)**:
   * While the client fetches the new CAS template `/_pronto/templates/regras.<new_cas>.html` in the background, user interactions continue uninterrupted.
   * The user can click buttons, trigger Jessie handlers, or dispatch forms with zero network locking.
3. **The Quiescence Gate (`__prontoBusy`)**:
   * Omnishell already instruments active work via `__prontoBusy()` ([`screen.js:84`](../../omnishell/interpreter/screen.js#L84)): tracking `regions` (active DOM re-bindings) and `waits` (timers held by the clock).
   * A template swap *never* executes during an active gesture or in-flight refresh. It executes only when the screen reaches **quiescence** (`regions == 0`, `waits == 0`).
4. **The Dirty-Hold Veto Downward**:
   * The DOM holds private state that the store cannot see: unsent input text, cursor focus, and scroll position ([`screen.js:398`](../../omnishell/interpreter/screen.js#L398)).
   * If the user is actively typing in a form input, the **dirty-hold exercises an absolute downward veto**: the template hot-swap is deferred. Unsent text is never overwritten by a template swap.
5. **Deferred Navigation Fallback**:
   * If a screen is intensely active (e.g. an ongoing Truco match in `/arena`), the shell defers the template swap entirely.
   * The new template is pre-warmed in the browser cache, and mounts cleanly on the user's next route navigation without interrupting live gameplay.

#### The Diffing Engine: Why Omnishell Does NOT Diff Collections Against the DOM with `d2ts`

A natural question in the "DOM as a database" model is: **To find the perfect diff to apply to the DOM, do we run `d2ts` between two collections (one representing the store and one bound to the DOM)?**

The answer is **no**: running differential dataflow (`d2ts`) between two collections or against the DOM would be an architectural category error and a severe performance tax.

1. **The Delta is Already Computed Upstream**:
   * In the durability ladder ([`2026-08-31-one-ladder-one-grammar.md`](2026-08-31-one-ladder-one-grammar.md)), view maintenance flows strictly downward:
     $$\text{Postgres WAL} \longrightarrow \text{Electric Shape} \longrightarrow \text{Collection} \longrightarrow \text{IVM / } d2ts \longrightarrow \text{Change Stream} \longrightarrow \text{Region Sink (DOM)}$$
   * `d2ts` (`@tanstack/db-ivm`) operates *above* the region, compiling relational operators (`map`, `filter`, `join`, `consolidate`) over multiset relations $(record, \text{multiplicity})$.
   * When a query result changes, the IVM engine *already emits the exact delta* through `subscribeChanges(changes)`:
     ```js
     [{ type: "insert" | "update" | "delete", value: { id, ... }, previousValue: { id, ... } }]
     ```
   * The relational diff is already in hand. Re-running a diffing algorithm between collections or against the DOM to "find" what changed would be re-discovering a fact the engine already knew.

2. **The DOM is a Keyed Sink, Not a Collection to Diff Against**:
   * The DOM is the bottom rung of the durability ladder: elements are rows, attributes are columns, and private tables are focus, selection, scroll, and dirty unsent input text.
   * The region reconciler in [`screen.js`](../../omnishell/interpreter/screen.js#L2819) maintains a primary-key index:
     ```js
     const live = new Map(); // key (row.id) -> { node, ctx, tmpl, nested }
     ```
   * When `refresh(changes)` executes:
     * **Dirty Row Extraction**: It extracts modified primary keys into `dirty = new Set(changes.map(c => c.value?.id ?? c.previousValue?.id))`.
     * **Zero-Work for Unchanged Rows**: For any row where `!dirty.has(key)`, `screen.js` does **zero DOM work** (0.0003 ms). No attribute checks, no text parsing, no child traversal.
     * **Surgical In-Place Patch**: Only dirty rows execute `bindAttributes`, `bindTexts`, and `syncNested`. Unsent form drafts are protected downward by the `_prontoDirty` veto ([`screen.js:398`](../../omnishell/interpreter/screen.js#L398)).
     * **State-Preserving Moves via Native `moveBefore()`**: When row positions change, `screen.js` aligns them using native `Node.moveBefore()` ([`screen.js:3094`](../../omnishell/interpreter/screen.js#L3094)). Unlike `insertBefore`, `moveBefore` relocates connected elements without dropping focus, resetting animations, or reloading hatch iframes.

3. **Why Collection/DOM Diffing (and VDOM Libraries) Fail for Live Rows**:
   * As measured in [`plugins/omnishell/docs/2026-08-02-reconciliation-libraries.md`](../../omnishell/docs/2026-08-02-reconciliation-libraries.md):
     * Generic morphing libraries (morphdom, idiomorph, morphlex) require constructing a **throwaway detached target tree of $N$ nodes on every tick**. On a 200-row social feed where a counter ticks with no structure change, that tax is **3–9× wall clock** (7.0 ms vs 1.0 ms for `screen.js`).
     * Tree-diffing libraries key on the standard HTML `id` attribute. Pronto's rows carry entity primary keys (`data-id`). Without document-unique `id`s, morphing libraries match positionally—**silently rewriting a user's half-written reply onto another post's node**.
     * `d2ts` evaluates multiset algebra; it has no concept of layout, scroll positions, selection ranges, or iframe lifetimes.
   * **Where Morphlex IS Used: Static Skeleton Morphing (`morphScreen`)**:
     * While live rows inside `[data-live]` are reconciled surgically via primary-key indices and `moveBefore()`, outer screen structural changes (e.g. navigation between screens sharing chrome, or hot-swapping CAS templates) use `morphScreen` via `morphlex` ([`screen.js:3393`](../../omnishell/interpreter/screen.js#L3393)).
     * Crucially, `morphScreen` configures `beforeChildrenVisited` to immediately prune descent when encountering `[data-live]` or `[data-hatch]`. Dynamic query islands and sandboxed frames are untouched, while the surrounding skeleton (headers, badges, layout chrome) morphs in-place with `preserveChanges: true` protecting dirty form inputs.

4. **Zero-Diff Hydration in M-SSR**:
   * Because the server stamps `data-id` on every pre-rendered row, client hydration performs **no tree diffing**:
     ```js
     // O(N) single-pass adoption into the primary key index
     for (const el of region.children) {
       live.set(el.dataset.id, { node: el, ctx: createContext(el), ... });
     }
     ```
   * Post-boot, as Electric catches up from the server's sequence clock (`pronto-lsn`), the incoming LSN delta flows directly into `refresh(changes)`. Only rows modified *after* the SSR snapshot was generated are touched.

#### The Exact TTL Strategy for Non-CAS Public Routes

Because the non-CAS public URL (e.g. `https://example.com/article/my-slug`) must remain stable and canonical, its HTTP caching headers split responsibilities between the **Shared Edge CDN** and the **Private Browser Cache**:

```http
Cache-Control: public, s-maxage=31536000, max-age=0, must-revalidate, stale-while-revalidate=86400
ETag: W/"c_<cas_hash>-l_<lsn>"
```

1. **Shared Edge CDN (`s-maxage=31536000` — 1 Year)**:
   * The edge (Caddy, Cloudflare, Fastly) holds the pre-rendered HTML indefinitely.
   * There is zero risk of long-term staleness: the cluster's CDC pipeline issues an immediate HTTP `PURGE` the millisecond a database write commits.
2. **Private Browser Cache (`max-age=0, must-revalidate` + `ETag`)**:
   * The browser must revalidate before treating the cached document as authoritative.
   * On navigation, the browser sends `If-None-Match: W/"c_<cas_hash>-l_<lsn>"`.
   * Because the edge CDN has the static file in memory, it answers in ~5–15ms with `304 Not Modified` (**zero payload bytes**), confirming the layout is current.
3. **Instant First Paint via `stale-while-revalidate=86400`**:
   * If supported by the browser, `stale-while-revalidate` allows the browser to display the cached HTML in **0ms from disk**, firing the revalidation request in the background.
   * If dynamic rows changed during that window, **Electric Differential Hydration (Pillar 2)** catches the DOM up via sequence deltas in ~2ms.
   * If the template structure changed, the **Dual-Witness Revalidation** hot-swaps the CAS template in the background at the quiescence boundary.
4. **Private Routes (`/settings`, `/dashboard`)**:
   * `Cache-Control: private, no-store, must-revalidate`.
   * Never cached at the edge; evaluated per session with Postgres RLS.

### 5. Adaptive Edge Splitting (Anonymous Edge to Private Local-First)
* When an anonymous reader requests `/note/:id`:
  * If the note is marked `public`, Caddy serves the pre-rendered static HTML directly from the edge cache without hitting Postgres.
* When the author logs in:
  * The client does not reload the page or fetch a new HTML document.
  * The client's local TanStack DB opens an authenticated Electric shape. Electric streams the author's private permissions and edit handles.
  * The UI dynamically unlocks edit controls on top of the already rendered DOM without a page refresh.

---

## 5. Has Anyone Done Anything Similar?

| System | What They Do | Where They Fall Short Compared to Pronto |
| :--- | :--- | :--- |
| **Next.js (ISR / RSC)** | Periodic timer re-rendering (`revalidate: 60`) or manual cache tags. Streams serialized React Server Component trees. | No database engine awareness. Relies on heavy Node.js servers, developer guessing for cache invalidation, and suffers from client VDOM hydration cost and ChunkLoadErrors. |
| **Qwik** | Solved resumability (0ms hydration) by serializing JS closures into DOM attributes (`$()`). | Qwik is purely a frontend component compiler. It has no concept of database synchronization, CDC, local-first, sequence clocks, or automatic edge materialization. |
| **Phoenix LiveView** | Server renders HTML, connects over WebSocket, diffs state on server, pushes DOM patches. | Server-authoritative and not local-first: fails offline, incurs network roundtrip latency on every user tap, and requires stateful sticky server connections. |
| **Linear / Figma Sync** | Local-first relational storage (SQLite/WASM) syncing via a monotonic sequence clock with central Postgres. | Linear and Figma are 100% client-side SPAs. They offer **zero SSR and zero public SEO** (a blank loading screen on cold start). |
| **Astro** | Islands architecture (static HTML with selective client component hydration). | Astro's islands are manually designated and mostly static. Lacks a continuous CDC database sync engine and cannot perform differential sequence hydration. |

**Pronto is the first system to unify:**
1. **The Database IS the CDN**: Database CDC / IVM acts as the continuous edge HTML generator.
2. **Zero-JS Declarative Resumability**: Pure HTML attributes (`data-live`, `data-on`) with 0ms client TTI via event delegation.
3. **Differential Sequence Hydration**: Electric LSN delta synchronization catches up dynamic rows sub-millisecond on boot.
4. **Git-Model Dual-Witness Stale-While-Revalidate**: Stable public canonical routes paired with immutable CAS internal templates, hot-swapped while preserving the `dirty-hold`.
5. **Adaptive Edge Splitting**: A public static edge page transforms dynamically into private authenticated local-first state without a page reload.

---

## 6. What is Kept vs. What is Abandoned

With Materialized SSR established, we discard the accidental complexity of generic SSR frameworks:

| Concept | Status | Rationale |
| :--- | :---: | :--- |
| **Streaming HTML / Suspense Chunks** | **ABANDONED** | Streaming chunks was invented for slow origin servers doing sequential database joins in Node.js. In Pronto, the edge already holds the pre-rendered static HTML (0ms TTFB). Any subsequent dynamic changes stream over Electric's WebSocket/SSE delta connection post-boot. Chunked HTML streaming adds brittle client parsing scripts for zero benefit. |
| **Client VDOM Reconciliation (morphdom/snabbdom)** | **ABANDONED** | The server-rendered DOM is already the exact IVM projection. Event delegation binds with 0ms overhead. Subsequent reactive changes are reconciled via Omnishell's surgical `moveBefore` without tearing down nodes. |
| **Complex UI State Machine Serialization** | **ABANDONED** | XState chart transitions are ephemeral UI state. Only the durable relational state (`__PRONTO_STATE__`) and sequence clock (`pronto-lsn`) cross the wire. |
| **Arbitrary Time-Based TTL Guessing** | **ABANDONED** | Replaced by CDC-driven instant edge purges + Dual-Witness Stale-While-Revalidate (LSN + CAS hash). |
| **Pronto Compile-Time Labeler (`ssr: "ssg" \| "ssr" \| "spa"`)** | **KEPT (Core)** | The CUE compiler labels routes as `ssg`, `ssr`, or `spa`. Whether an `ssr` route is publicly cacheable at the edge or on-demand/private is derived automatically from the read closure over `#Entity.access.scope`. |
| **LinkeDOM Pure-Rung Execution** | **KEPT (Core)** | Fast, synchronous, headless template evaluation against TanStack DB views running in Deno behind Caddy. |
| **Declarative Shadow DOM for Hatches** | **KEPT (Core)** | Structural correctness, style encapsulation, and layout stability for vendored/untrusted widgets. |

---

## 7. The Unified SEO, Caching, and Hydration Matrix

Content across Pronto applications is governed by `#Screen.ssr: "ssg" | "ssr" | "spa"` combined with `#Entity.access.scope`:

```
                          CONTENT CLASSIFICATION
                                    |
          +-------------------------+-------------------------+
          |                                                   |
        PUBLIC                                             PRIVATE
(all read scopes: "public")                        (any scope: "private" / "folder")
          |                                                   |
    +-----+-----+                                       +-----+-----+
    |           |                                       |           |
  STATIC     DYNAMIC                                  DYNAMIC      SPA
 (Rules)    (Articles)                               (Settings)   (Arena)
  [ssg]       [ssr]                                    [ssr]       [spa]
```

| Route SSR Mode | Data Visibility (`access.scope`) | Example | Rendering Strategy | Caddy & CDN Caching | SEO & Crawler Directives | Hydration Mechanism |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`ssr: "ssg"`** | `public` / none | [`route_rules`](2026-09-17-localized-urls.md#L117) (`/es/reglas`), `shadcnui` docs | Static generation at build time via `prerender.ts`. Written to disk. | `public, s-maxage=31536000, immutable` | Full indexation. Pre-computed canonical URLs, `<title>`, `<meta>`. | Zero-JS or minimal shell boot. |
| **`ssr: "ssr"`** | `public` | `/article/:slug` (RealWorld), public blog | **Materialized SSR (Pillar 3)**. Pre-rendered on write, purged via CDC. | `public, s-maxage=31536000, no-cache`. Instant CDC purge. | High priority. Server `<title>`, OpenGraph meta, JSON-LD from row data. | Zero-diff hydration (Pillar 1) + Electric LSN delta catch-up (Pillar 2). |
| **`ssr: "ssr"`** | `private` / `folder` | User settings, billing invoices, private dashboard | **On-Demand Dynamic SSR** (for FCP/UX). Executed with session RLS in Postgres. | `private, no-store, must-revalidate` | `<meta name="robots" content="noindex, nofollow">`. Disallowed in `robots.txt`. | Seeded with user's private state slice. Zero loading spinner on first paint. |
| **`ssr: "spa"`** | Any | Active Truco arena match (`/arena/:id`), live game lobby | **Client-Side App Shell**. Minimal shell HTML emitted. | `public, max-age=3600` (shell only) | Disallowed in `robots.txt`, `noindex, nofollow`. | App shell loads; Electric sync stream takes over immediately. |

---

## 8. Implementation Status

1. **Schema Refactoring (`schema.cue`)**: **LANDED**. `#Access` migrated to pure Google Drive model (`scope: "private" | "folder" | "public" | "internal"`), with legacy `mode:` aliases removed. `#Screen.ssr` unified to `"ssg" | "ssr" | "spa"`.
2. **Policy Emission (`emit.cue`)**: **LANDED**. Postgres RLS policies, DDL triggers, shape keys, and `shell.yaml` access configurations generated strictly from `scope`.
3. **App Migrations**: **LANDED**. All 10 Pronto apps migrated to pure `scope` and regenerated with `ssr` modes.
4. **Zero-Diff M-SSR Hydration (`screen.js`)**: **LANDED**. Single-pass adoption of pre-rendered server nodes matching `child.dataset.id === row.id` directly into `entry.node` without DOM recreation.
5. **Dual-Witness Metadata (`prerender.ts`)**: **LANDED**. Injects `<meta name="pronto-cas">`, `<meta name="pronto-lsn">`, and `<script id="__PRONTO_STATE__">`.
6. **Engine Validation (`m-ssr-hydration.test.ts`)**: **LANDED**. 163 tests passing across omnishell test suite with zero regressions.
7. **In-Place Skeleton Morphing (`morphScreen`)**: **LANDED**. Bundled Morphlex ([`vendor/morphlex.js`](../../omnishell/interpreter/vendor/morphlex.js)), exposed via `interpretScreen().morph()`. In-place skeleton updates prune `[data-live]` and `[data-hatch]` subtrees while preserving dirty inputs ([`morph-screen.test.ts`](../../omnishell/test/morph-screen.test.ts)).
8. **Cold Boot & Speculation Rules Optimization**: **LANDED**. Pre-emitted `shell.json` bypasses runtime YAML parsing, dropping `yaml.js` from the critical path. Speculation rules in `shell.html` prefetch and prerender internal navigation targets.
9. **Resilient Offline Storage (`@mecha/client`)**: **LANDED**. `ResilientIndexedDBAdapter` ([`storage.ts`](../../../libraries/mecha/packages/client/src/storage.ts)) handles `onversionchange`, `onclose`, and catches `InvalidStateError: The database connection is closing` to recreate connections and retry transactions cleanly.
10. **LinkeDOM W3C IndexedDB Polyfill**: **LANDED**. LinkeDOM test harness incorporates `fake-indexeddb@6.2.5/auto` and polyfills `HTMLFormElement.prototype.checkValidity()`. Verifies full offline mutations in Deno with zero container dependencies ([`indexeddb-linkedom.test.ts`](../../omnishell/test/indexeddb-linkedom.test.ts), `apps/realworld/tests/editor.test.ts`).
