---
type: decision
title: Pronto written in pronto
description: The whole development loop in a browser tab — authoring, compilation, running and version control, with sayt's verbs run by an in-tab executor, inside an IDE that is itself a pronto app — none of which exists yet.
status: unbuilt
---

# Pronto written in pronto

## Browser-first, ejected from day one

The entire development loop runs in a browser tab:

- **Authoring**: brief editing and model calls
- **Compilation**: a WASM build of the CUE evaluator in a Web Worker, pinned to
  the version the loop pins, so an export in the tab is byte-identical to one
  on a laptop or in CI — which is what makes a commit of generated files made
  in the tab safe to review
- **Running**: mecha's [browser platform](../../../../libraries/mecha/docs/browser.md),
  the cluster `release@pages` already ships
- **Version control**: a real git repository in OPFS, pushed through the
  GitHub REST API (blobs, tree, commit, ref), which answers CORS where
  smart-HTTP push needs a proxy

There is no "eject" moment because the app is ejected from day one: the repo is
the source of truth from the first commit, and the tab is a checkout that
happens to also be a runtime. The scaffold commit includes the sayt and bayt
files — the tab never executes them, it authors a repository in which they are
already true — so cloning to a laptop gives `sayt launch` at once. The tab is
the inner loop; `git push` is the promotion gesture; CI runs the real
lifecycle — containers, integration, deploys — and recomputes every stamp
rather than trusting one the tab wrote. The tab loop exists for feedback speed,
not to skip CI's work.

### The inner loop: sayt verbs in the tab

The executor is ported, not the verbs. A small JS verb-runner ("sayt-lite")
reads the same bayt targets from the OPFS checkout, hashes sources with
WebCrypto and writes the same merkle stamps, so incrementality and the cascade
behave as on a laptop:

| Verb | In the tab |
|------|-----------|
| `lint@browser` | `cue vet`, the bijection, the Jessie gate, `DOMParser` and `CSSStyleSheet` over the screens, mermaid and bloblang parses — sub-second, and the checking engine is the rendering engine |
| `build@browser` | `cue export` in a worker to OPFS, then PGlite, the fetch handler, compartments and the shell wired to it |
| `test@browser` | handlers in compartments; data paths on a fresh PGlite with snapshot and restore; pipelines through bloblang WASM; storyboard paths driving screens in a hidden iframe |
| `verify@browser` | each storyboard state rendered and compared with the pinned ir |
| `integrate@browser` | declared shims only — cross-service integration stays CI's |

Everything deterministic runs offline; the model is re-invoked only when the
brief or the ir changes, so iterating on a red test costs seconds and no
tokens. The runner's graph work — dependency order, transitive closure, stamps
— is JavaScript under SES, the model the handlers already run under, so
application and tooling share one purity story (why not CUE or Starlark:
[the compiler](../compiler.md#rejected)).

## The IDE is a pronto app

The editor for all this — chat, a live preview and the ir, with code a minor
surface — is itself a pronto app, and it edits its own brief once running. That
is a forcing function, not a slogan: an IDE cannot be expressed in a language
that only expresses todo lists, so self-hosting drags the whole runtime to
real-application weight in the project's own hands. It is also the far end of
the escape-hatch spectrum: a docking layout, a chat runtime, a code editor, a
WebGPU model and the CUE evaluator are each a vendored unit or a WASM hatch
with a contract, and the chat reducer, selection and verb status are handlers.
Where "written in pronto" degrades to "wired in pronto" — a framework app with
a manifest stapled on — is the measurement building it makes.

**The trust boundary is authorship.** A vendored unit — the in-tab model
included — is code an engineer audited and runs outside the compartment; what
the model *emits* still passes the Jessie gate and runs inside one. The model is
trusted to run, never to emit unsandboxed code.

**Selecting in the preview names the design object.** The one bespoke piece is
a bridge from a clicked element to its ir id, handed to the chat as context, so
"edit this" edits the right artifact exactly. It needs the emitter to stamp a
stable identity on emitted elements, which it does not
([pending](../../../omnishell/PENDING.md#visual-lint)).

**The model and the compute are the user's.** Nothing runs on infrastructure
the project operates: the model is in-tab WebLLM, then the user's own API key;
batch containers run on the user's GitHub Actions, interactive ones in their
Codespace; the IDE ships as static files. Every rung is metered against the
user's login.

## Rejected

- **A visual-editor framework** (Onlook, GrapesJS, Puck) — each owns the editing
  model, which fights the program being the source of truth; an ir id stamped
  on each emitted element makes selection exact without one.

## Open questions

- Can the tab reproduce bayt's stamp hashes byte for byte from an OPFS checkout
  (path normalization, hashing order)? Until it does, the cascade is not shared.
- How big and how slow is the CUE evaluator as WASM behind a service worker?
- Chat state and layout state each have an owner of their own (the chat
  runtime, the docking engine) beside the terminal's single data path: a
  handler-backed runtime, or a sanctioned unit with a declared boundary?
- What is the seed — hand-authored or agent-authored artifacts — and does it
  compile under the shipped evaluator and terminal, without which self-hosting
  is a claim?
