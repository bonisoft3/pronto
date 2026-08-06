# Pronto

Pronto is a programming language where the source code is markdown and the compiler is an LLM. It compiles to a constrained target architecture — [mecha](../../libraries/mecha) for data, [omnishell](../omnishell) for UI, and [sayt](../sayt)/[bayt](../bayt) for build/deploy — producing applications that run identically from a single browser tab to a cloud cluster.

The insight: AI can generate anything, but "anything" is where bugs live. Pronto constrains generation to an architecture where entire categories of bugs — deployment drift, data inconsistency, infrastructure misconfiguration — cannot exist. The same way Rust constrains C to gain memory safety, Pronto constrains AI-generated code to gain architectural safety.

## The review ladder

Pronto has three artifacts, one per audience. Each audience reviews at its own altitude; nobody reviews below their rung.

```
brief.md ──LLM──▶ ir.html ──LLM (narrow)──▶ program.cue ──cue export──▶ everything
(product           (engineering              (machine                    (mecha YAML,
 altitude,          design doc:               altitude,                   omnishell config,
 natural            architecture boxes,       reviewed by                 HTML/CSS screens,
 language)          SVG screen sketches)      no one)                     JS handlers)
```

| Artifact | Audience | Contents | Mutability |
|----------|----------|----------|------------|
| `brief.md` | Product / business | What the app should do, in prose; `brief.html` is its browser presentation | Mutable |
| `ir.html` | Engineer | Architecture diagram (boxes and how they communicate), SVG screen sketches, contracts, test pairs — a design doc that renders in any browser | Pinned per compile |
| `program.cue` | Machine | The program. Everything downstream is `cue export` | Pinned per compile |

Only the two LLM hops are probabilistic, and the second is narrow: the structured parts of ir.html (entity tables, flow topology, data-path assignments) extract into CUE deterministically. Every box, arrow, and sketch in ir.html carries a machine-readable id; the generated CUE back-references those ids; a deterministic checker enforces the bijection. IR↔CUE drift is a checkable property, not a hope.

The ids are pronto's sourcemaps: as in TS/JS, every compiled artifact points back at its source — but they map design objects rather than line numbers, they survive into the running DOM as `data-*` attributes, and the mapping is enforced by a checker rather than emitted on faith.

## The target surface

The compiled program is data, not code. `cue export` emits:

- **YAML configs** for mecha — schema DDL, PostgREST routes, CDC pipeline definitions (bloblang/jq), ElectricSQL shapes
- **Omnishell config** — layout, routes, auth, forms; the shell interprets it at runtime, there is no build step
- **HTML/CSS** for the screens
- **JS handlers** for the residue of state handling that config cannot express

### JS handlers

Omnishell's doctrine — single data path, forms-only mutations, reactive live queries — already removes effects, fetching, and imperative DOM from application code. What remains is pure derivation and event handling, and it is confined in layers:

1. **CUE absorbs pure derivations.** Computed fields, filters, and validation live in the program itself. CUE is total: every expression terminates.
2. **Remaining handlers are authored in [Jessie](https://github.com/endojs/Jessie)** — the defined safe subset of JavaScript (strict functional core; no `this`, no classes, no ambient authority). Still JS syntax, so LLM fluency is untouched.
3. **Enforced twice**: statically by the Jessie grammar at compile time, dynamically by running each handler inside an SES Compartment (the mechanism behind MetaMask Snaps).
4. **Deterministic by construction**: time and randomness arrive as inputs injected by the runtime, never ambient — the same discipline Temporal enforces on workflow code.

Net property: nothing in a Pronto application runs with ambient authority.

## Escape hatches

Pronto cannot express every computation. Three escapes, ranked; all appear as boxes in ir.html so every hole in the guarantees is visible in the design doc:

| Escape | Guarantee | Runs where |
|--------|-----------|-----------|
| **Pre-compiled WASM** (preferred) | Sandboxed; touches Pronto state only through its CUE-contracted interface | Every tier — the same `.wasm` runs in the tab, in CDC pipelines, and server-side |
| **External API endpoint** | Clean trust boundary: the Pronto database is only touched by Pronto; beyond HTTP is the external world | Every tier |
| **Container** | Full escape | Real container at compose/k8s/cloud tiers; at browser tier it binds to a **declared shim** (mock or degraded WASM stand-in), consistent with mecha's best-effort browser consistency model |
| **Vendored UI component** (terminal-tier hatch) | Trusted, audited component mounted by the terminal at a declared point; CUE-contracted props-in/events-out with declared isolation (compartment, iframe, or worker) and capabilities | Browser surface, every tier |

The browser-tier shim is the same move [snapcards](../../guis/snapcards) uses to swap Ollama for an in-browser model behind one interface. Declaring the shim forces the interface contract to be precise enough to mock — pressure in the right direction. (Live-in-tab containers via container2wasm/v86 exist as an opt-in, at emulation speed; WebContainers-class products require commercial licenses.)

## Browser-first, ejected from day one

The entire development loop runs in a browser tab:

- **Authoring**: brief editing + LLM API calls
- **Compilation**: CUE evaluated by a WASM build of the CUE evaluator (pinned to the same version bayt uses, so exports are byte-identical everywhere), in a Web Worker
- **Running**: mecha `@browser` — PGlite, MSW, bloblang/jq WASM pipelines — proven in snapcards
- **Version control**: a virtual filesystem (OPFS) holding a real git repo; commits and pushes go to the remote via the GitHub REST API

There is no "eject" moment because the app is ejected from day one: the repo is the source of truth from the first commit, and the tab is just a checkout that happens to also be a runtime. The scaffold commit includes the sayt/bayt files, so cloning to a laptop gives `sayt launch` immediately. The tab is the inner loop; `git push` is the promotion gesture; CI runs the real sayt/bayt lifecycle — containers, integration tests, deploys.

### The inner loop: sayt verbs in the tab

The sayt TDD loop gets a browser tier so a dev cycle never waits on CI. A small JS verb-runner ("sayt-lite") reads the same bayt target definitions from the OPFS checkout and writes the same merkle stamps — the verbs, incrementality, and cascade are shared; only the executor is a browser port:

| Verb | In the tab |
|------|-----------|
| `lint@browser` | `cue vet` + IR↔CUE bijection check + Jessie grammar gate + `DOMParser`/`CSSStyleSheet` on screens + mermaid/bloblang parse — the constraint cascade, sub-second |
| `build@browser` | `cue export` in a worker → OPFS (byte-identical to CI), then wire PGlite, MSW, Compartments, omnishell config |
| `test@browser` | Contract pairs in Compartments; data-path tests on fresh PGlite (real Postgres semantics); pipeline tests through bloblang/jq wasm; storyboard-path flow tests driving screens in a hidden iframe |
| `verify@browser` | Pixelmatch rendered storyboard states against the pinned ir.html |
| `integrate@browser` | Shims only — cross-service integration stays CI-tier, by declared contract |

Everything deterministic runs offline; the LLM is only re-invoked when the brief or ir.html change. See [`DESIGN.md`](DESIGN.md) for the full loop design.

## Drift detection

Deterministic at every rung below the top:

| Rung | Mechanism | Deterministic? |
|------|-----------|---------------|
| brief ↔ ir.html | LLM judgment, human-reviewed — this is the design step | No (by nature) |
| ir.html ↔ program.cue | Id back-reference bijection check | Yes |
| program.cue ↔ outputs | `cue export` is a pure function of the program | Yes |
| Behavior | Test pairs (data in the program) run against the app in a worker | Yes |
| Visual / flow | State and path diffs on the rendered ir.html | Yes |

## The virtual cluster

Pronto programs don't target machines; they target a **virtual cluster**, the way Java targets a virtual machine. The virtual cluster is mecha's contract surface — a Postgres-shaped store, a CRUD gateway, a CDC event bus, pipeline workers, live query shapes — and every tier realizes that contract with different components, from a multi-cloud deployment all the way down to a single browser tab:

```
Browser ──────── CLI ──────── Container ──────── Cloud
 PGlite         native        Docker Compose     managed services
 MSW, WASM      binaries                         Crossplane
 best-effort    full          full               full
 eventual       consistent    consistent         consistent
```

No code changes between scales. Components swap — PGlite for PostgreSQL, MSW for real HTTP, shims for real containers — while the data paths, CDC guarantees, and application logic stay identical.

### The loop

Development turns **the loop** — the lifecycle contract (the ten verbs, the
TDD cascade, CI), default implementation [sayt](../sayt) (`sayt:loop`,
rostered as `pronto/loops:sayt`) — and the loop drives **the build graph**,
default [bayt](../bayt) (rostered as `pronto/builders:bayt`, handed the
program's build seat as concrete `bayt.json`). Programs target a cluster,
users touch a terminal, developers turn the loop; all four seats are
published CUE, overridable by unification, versioned and forked by module
pin.

### The virtual terminal

The frontend is the cluster's **virtual terminal**. As in the block-mode terminals of mainframe lineage, a screen is rendered from data and the only way back is submitting a form — but this terminal carries its own replica of its slice of the cluster: reads are local and reactive, writes land locally first and travel the same CDC guarantees, so offline is the default condition rather than an error state. What remains of client computation is Elm-shaped — pure `(state, event) → state'` handlers, effects owned entirely by the shell. A 3270 with a database in its pocket, attached to a cluster that can live in the same tab.

## Philosophy

Programming languages exist on a spectrum from "express anything" to "express safely." AI code generation today is at the "assembly" end: infinite output space, probabilistic correctness. Pronto moves it toward the "Rust" end by fixing the target:

- **Deployment drift** — sayt/bayt pin everything; dev and prod run the same code paths
- **Data inconsistency** — mecha guarantees at-least-once delivery with idempotent sinks
- **Infrastructure misconfiguration** — the program generates all infrastructure; there is nothing to hand-configure
- **State management bugs** — omnishell enforces a single data path and forms-only mutations; handlers cannot perform effects
- **Runtime surprises** — errors fail at `cue vet` time, not runtime; the constraint cascade catches them before anything runs

What you give up in expressiveness (real-time collaboration, GPU compute, sub-100ms distributed state) you gain in correctness for the large class of applications that don't need those things: CRUD apps, SaaS tools, dashboards, content management, workflow automation, internal tools, admin panels.

## Related work

| Project | Similarity | Key difference |
|---------|-----------|----------------|
| [Darklang](https://darklang.com) | Deployless, bugs eliminated by construction | Custom language, not natural language |
| [Wing](https://www.winglang.io) | Preflight/inflight distinction, cloud-safety | Infra-only scope; Pronto covers data + UI + deploy |
| [Encore](https://encore.dev) | Correctness by construction, infra-from-code | Backend-only; closest production system to Pronto's philosophy |
| [Lovable](https://lovable.dev) / [v0](https://v0.dev) / Bolt | Prompt-to-app UX | Unconstrained generation into a wide substrate; correctness by iteration instead of by construction |

## Design documents

- [`SPEC.md`](SPEC.md) — the artifact spec: brief, ir, program
- [`DESIGN.md`](DESIGN.md) — current design
- [`PRONTOUI.md`](PRONTOUI.md) — prontoui, the self-hosting browser IDE
- [`prelude.md`](prelude.md) — shared component knowledge, implicit context of every compile
- `docs/` — the dated design record (lineage)

## License

LGPL-3.0
