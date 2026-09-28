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
| `#App` | `entities`, `pipelines`, `schedules`, `migrations`, `rawMigrations` | requested: `auth`, `native`, `blobs`, `hatches`, `vendored` | `screens`, `handlers`, `design`, `flows` | `meta`: `name`, `ir`, `targets`, `clocks`, `decisions`, `tests`, `i18n` |
| `#Terminal` | `navigation: true` | offered: `auth`, `text-formats`, `message-arms`, `renderer`, `sensors`, `background`, `hardware`, `os-bridge`, `network-peer`, `isolation`, `hatch`, `floors` | the entry page and its `assets`, the served file lists, `verbs`, `checks`, `statics` | `app`, `description`, `language`, `direction` |
| `#Cluster` | `migrations`, `pipelines`, `schedules` (names only) | switches: `server`, `auth`, `blobs` | `targets`, `verbs`, `checks` | `meta`: `app`, `images`, the door, `statics` |
| `#Loop` | — | — | `sources`, `buildCmd`, `testCmd`, `verbs`, `checks`, `sayYaml`, `tasksJson` | `meta.app` |
| `#Build` | — | — | `project`, bayt's `#project` | `meta`, plus the `cluster` it lowers |

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
