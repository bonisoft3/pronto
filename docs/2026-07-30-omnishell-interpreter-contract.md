# What omnishell must grow to interpret pronto's emission

Date: 2026-07-30
Status: v0 implemented in `plugins/omnishell/interpreter/` (shell.js, data.js,
screen.js — vanilla ES modules, no build step; store is PGlite booted from the
emitted migrations, pipelines run as declared browser shims). The todo app
runs end to end. Open per-ask gaps: icon registry (no multi-screen app yet),
island loading (stub throws), CSS scoping (raw injection, dedupe only),
Jessie/SES enforcement.

program.cue emits the frontend's final form directly — per-screen HTML, CSS,
and Jessie islands — on the load-bearing premise that screens are interpreted
artifacts with no build step. `shell/shell.yaml` is deliberately **not a
DSL**: it only maps routes to files (`{html, css, islands}`), carries nav
labels, and names the boot `tables` list. All screen semantics live in the
markup; nothing the runtime consumes is stated twice. Omnishell today is a
TypeScript library (`createLayout`, `createAuth`, mecha collections, TanStack
scaffold conventions) — component-shaped, not artifact-interpreting. The gap
is six asks. Omnishell's internals may stay React/TanStack throughout; the
contract is only that the shell consumes the emitted artifacts at runtime.

## 1. Config entry point

`createShell(config)`: read the file map and mount routes at runtime instead
of one TSX file per screen — fetch each route's `files.html`/`files.css`,
load `files.islands` into SES Compartments. Nav labels map onto
`createLayout`'s `{path, label}`; icons need a string-keyed registry in place
of component references.

## 2. Screen interpreter (the big one)

A runtime for the binding vocabulary in the emitted HTML:

| Binding | Meaning |
|---------|---------|
| `data-live="<table>"` (+ `data-order`) | bind a reactive live query to this region |
| `<template data-item>` | row template, instantiated per result |
| `data-text="{field} …"` | text interpolation from the bound row/singleton |
| `data-text-format="datetime"` | render the interpolated value as the app's one fixed UTC timestamp |
| `data-text-format="markdown"` | an app renderer (realworld: `shell/renderers/markdown.js`) |
| `data-text-format="<name>"` | an app renderer, resolved by basename out of the route's `files.renderers` the way `data-handler` resolves — a pure `(value) => nodes` Jessie module, with `interpreter/render.js` owning the node schema, the tag and attribute allowlist, the URL-scheme check and the DOM write |
| `data-empty="…"` | empty-state copy when the query returns no rows |
| `data-form` + `data-entity` + `data-action` | a self-describing mutation form |
| `data-done="{field}"`-style attributes | attribute reflection for state-dependent CSS |

Parse the HTML once, project it into components, hydrate against mecha
collections. This replaces hand-written `useLiveQuery` screens. Islands are
not ambient scripts: the shell loads a screen's island files into SES
Compartments and wires them at their binding sites (todo exercises none).

## 3. Generic form engine

Forms-only mutations driven entirely by the form markup: `data-entity` +
`data-action` name the mutation (create → insert, update → patch by the
enclosing item's row id, delete → remove), all through the existing
collection layer (optimistic writes included). Validation is the platform's:
native constraint attributes (`required`, `maxlength`) which the compiler
derived from the same CEL constraints that became SQL CHECKs; the invalid
message is markup beside the field.

## 4. Storyboard state surface

The shell owns a per-screen state machine exposed as `data-state` on the
screen root, with exactly the storyboard vocabulary: `empty | loading |
populated` from the live-query lifecycle, `form-submit | success |
validation-error | network-error` from the form engine. Screens only style
states; they never transition them. This attribute is the hook that flow
tests and visual verification drive — without it the storyboard rungs of the
drift ladder have nothing to observe.

## 5. Data boot from config

Collections built from the config's `tables` list (compiler-derived from the
union of the screens' reads) instead of a hand-written `TABLES` const —
`bootPlatform(adapter, config.tables)`. This also makes the Electric shape
set config-derived, closing the loop with the tables the Conduit pipeline
declares.

## 6. Per-screen CSS scoping

Load each screen's emitted CSS scoped to its subtree (prefix under
`[data-screen="<name>"]`, or `@scope` when baseline allows). Emitted CSS
assumes it owns the screen, not the page.

Auth is deliberately absent: the todo brief has no accounts, and `shell.yaml`
reserves no auth block yet; `createAuth` remains the component-level story
until a brief forces the config shape.

Sequencing: 2+3 are the new engine, 1+5 are plumbing, 4 is the contract the
test rungs depend on, 6 is trivial. The proving prototype: interpret todo's
emitted `shell/` against PGlite and drive the happy storyboard path green
with zero app-specific TypeScript.
