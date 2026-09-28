# Pronto

Pronto is a programming language where the source code is markdown and the compiler is an LLM. It compiles to a constrained target architecture — [mecha](https://github.com/bonisoft3/mecha) for data, [omnishell](https://github.com/bonisoft3/omnishell) for UI, and [sayt](https://github.com/bonisoft3/sayt)/[bayt](https://github.com/bonisoft3/bayt) for build/deploy — producing applications that run identically from a single browser tab to a cloud cluster.

The insight: AI can generate anything, but "anything" is where bugs live. Pronto constrains generation to an architecture where entire categories of bugs — deployment drift, data inconsistency, infrastructure misconfiguration — cannot exist. The same way Rust constrains C to gain memory safety, Pronto constrains AI-generated code to gain architectural safety.

## Installation

Install the Pronto plugin for your agent. The plugin packages the [`pronto-turn`](skills/pronto-turn/SKILL.md) outer-loop skill, specialist studio seats, and project bootstrap knowledge.

**Antigravity (`agy`):**
```bash
agy plugin install https://github.com/bonisoft3/pronto.git
```

**Claude Code (`claude`):**
```bash
claude plugin marketplace add bonisoft3/pronto
claude plugin install pronto@bonisoft3-pronto
```

**Codex (`codex`):**
```bash
codex plugin marketplace add bonisoft3/pronto
codex plugin add pronto@bonisoft3-pronto
```

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
3. **Enforced twice**: statically by a gate on the names Jessie denies at compile time, dynamically by running each handler inside an SES Compartment (the mechanism behind MetaMask Snaps).
4. **Deterministic by construction**: time and randomness arrive as inputs injected by the runtime, never ambient — the same discipline Temporal enforces on workflow code.

Net property: nothing in a Pronto application runs with ambient authority.

## Escape hatches

Pronto cannot express every computation. Four escapes, ranked; all appear as boxes in ir.html so every hole in the guarantees is visible in the design doc:

| Escape | Guarantee | Runs where |
|--------|-----------|-----------|
| **Pre-compiled WASM** (preferred) | Sandboxed; touches Pronto state only through its CUE-contracted interface | Every tier — the same `.wasm` runs in the tab, in CDC pipelines, and server-side |
| **Vendored unit** (terminal-tier hatch) | Trusted, audited component or worker mounted by the terminal at a declared point; CUE-contracted props-in/events-out with declared isolation (compartment, iframe, or worker) and capabilities | Browser surface, every tier |
| **Container** | Full escape | Real container at the container and cloud tiers; at the browser tier it binds to a **declared shim** (mock or degraded WASM stand-in), consistent with mecha's best-effort browser consistency model |
| **External API endpoint** | Clean trust boundary: the Pronto database is only touched by Pronto; beyond HTTP is the external world | Every tier |

The browser-tier shim supplies an in-browser implementation behind the same interface. Declaring the shim forces the interface contract to be precise enough to mock — pressure in the right direction. (Live-in-tab containers via container2wasm/v86 exist as an opt-in, at emulation speed; WebContainers-class products require commercial licenses.)

## Drift detection

Deterministic at every rung below the top:

| Rung | Mechanism | Deterministic? |
|------|-----------|---------------|
| brief ↔ ir.html | LLM judgment, human-reviewed — this is the design step | No (by nature) |
| ir.html ↔ program.cue | Id back-reference bijection check | Yes |
| program.cue ↔ outputs | `cue export` is a pure function of the program | Yes |
| Behavior | Omnishell's battery and machine walk over the program's modules and charts, and the app's own drivers against the running app | Yes |
| Visual / flow | Visual lint over the rendered app | Yes |

## The virtual cluster

Pronto programs don't target machines; they target a **virtual cluster**, the way Java targets a virtual machine. The virtual cluster is mecha's contract surface — a Postgres-shaped store, a CRUD gateway, a CDC event bus, pipeline workers, live query shapes — and every tier realizes that contract with different components, from a cloud deployment all the way down to a single browser tab:

```
Browser ──────── Edge ──────── Container ──────── Cloud
 PGlite         PGlite in a    Docker Compose     managed services
 fetch shim     Durable Object                    controllers
 one user       single writer  full               full
 eventual       consistent     consistent         consistent
```

No code changes between tiers. Components swap — PGlite for PostgreSQL, a fetch shim for real HTTP, shims for real containers — while the data paths, CDC guarantees, and application logic stay identical.

### The loop

Development turns **the loop** — the lifecycle contract (the ten verbs, the
TDD cascade, CI), default implementation [sayt](https://github.com/bonisoft3/sayt) (`sayt:loop`,
rostered as `pronto/loops:sayt`) — and the loop drives **the build graph**,
default [bayt](https://github.com/bonisoft3/bayt) (rostered as `pronto/builders:bayt`, handed the
program's build seat as concrete `bayt.json`). Programs target a cluster,
users touch a terminal, developers turn the loop; all four seats are
published CUE, overridable by unification, versioned and forked by module
pin.

### The virtual terminal

The frontend is the cluster's **virtual terminal**. As in the block-mode terminals of mainframe lineage, a screen is rendered from data and the only way back is submitting a form — but this terminal carries its own replica of its slice of the cluster: reads are local and reactive, writes land locally first and travel the same CDC guarantees, so offline is the default condition rather than an error state. What remains of client computation is Elm-shaped — pure `(state, event) → state'` handlers, effects owned entirely by the shell. A 3270 with a database in its pocket, attached to a cluster that can live in the same tab.

### The unified lattice

Pronto does not coordinate cross-cutting concerns (durabilities, effect safety spectrum, RLS authorization, offline queueing, and test fuel budgets) through procedural pipelines or middleware stacks. Instead, every concern is an orthogonal dimension of a **bounded join-semilattice**. CUE unification (`&`) is the mathematical Greatest Lower Bound ($\sqcap$): database schema, interaction lifecycles, and verification tiers intersect into a single deterministic fixed point. Most contradictions fail closed at compile time (`cue vet`) before code runs; [the lattice](docs/lattice.md#which-joins-the-code-enforces) lists the joins checked later, at lint or when the writer runs, and those not checked yet.

## Philosophy

Programming languages exist on a spectrum from "express anything" to "express safely." AI code generation today is at the "assembly" end: infinite output space, probabilistic correctness. Pronto moves it toward the "Rust" end by fixing the target:

- **Deployment drift** — sayt/bayt pin everything; dev and prod run the same code paths
- **Data inconsistency** — mecha guarantees at-least-once delivery with idempotent sinks
- **Infrastructure misconfiguration** — the program generates all infrastructure; there is nothing to hand-configure
- **State management bugs** — omnishell enforces a single data path and forms-only mutations; handlers cannot perform effects
- **Runtime surprises** — most errors fail at `cue vet` time, not runtime ([the joins checked later, or not yet](docs/lattice.md#which-joins-the-code-enforces)); the constraint cascade catches them before anything runs

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
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how the pieces fit, and where to change each one
- [`prelude.md`](prelude.md) — shared component knowledge, implicit context of every compile
- [`docs/component-contracts.md`](docs/component-contracts.md) — component contracts: each part's state, capabilities, and surface, and how data flows between them
- [`docs/lattice.md`](docs/lattice.md#views-folds-and-the-dom) — the durability ladder, DOM as bottom rung
- [`docs/localization.md`](docs/localization.md#catalogues) — i18n as a contract, refused before release rather than falling back
- [`docs/localization.md`](docs/localization.md#addresses) — localized routing, BCP 47 paths, and Caddy's path matchers
- [`docs/screens.md`](docs/screens.md#how-a-routes-first-document-is-rendered) — server-side rendering: a route's ssr mode crossed with its read scope, pronto's policy over omnishell's mechanism, and which cells are built
- [`docs/lattice.md`](docs/lattice.md#which-joins-the-code-enforces) — cross-cutting concerns via CUE unification: durability, effect safety spectrum, interaction lifecycles, and verification budgets, and which joins the code enforces
- [`docs/release-targets.md`](docs/release-targets.md) — release targets: a program declares them, each is a sayt platform on a tier of mecha's ladder, `release@pages` bundles the app into one HTML file for one user, and `release@cloudflare` (one Durable Object on the free plan for everyone), `release@gcp`, `release@aws`, `release@azure` and `release@k8s` (mecha's images on managed services above a floor of one small database) are designed and not built
- [`../omnishell/docs/machines.md`](../omnishell/docs/machines.md) — unbreakable machines, closed effects, DuckDB synthetic seeds, statechart storybook battery, and formal verification
- `docs/` — one document per subsystem, and the decisions not yet built
- [`docs/index.md`](docs/index.md) — every document, with its type and status
- `docs/archive/` — the superseded design whose business analysis still stands ([`2026-06-12-design-constraint-cascade.md`](docs/archive/2026-06-12-design-constraint-cascade.md))

## License

LGPL-3.0
