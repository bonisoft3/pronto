# Design: Pronto — Current Architecture

Date: 2026-07-12
Status: DRAFT (consolidates and supersedes the two lineage docs in `docs/`)

Related: `PRONTOUI.md` — prontoui, the planned self-hosting browser IDE (the escape-hatch stress test for this architecture).

## Concept

Pronto is an LLM-focused programming language. The developer describes the software; the system decides how it can be expressed with mecha and omnishell, sketches the architecture and screens; the LLM translates that into CUE; and CUE generates the whole program — which is just YAML configs for mecha, HTML/CSS for the screens, and small JS handlers for state handling. The program also carries the harness's other seats: the loop (sayt) and the build graph (bayt, handed off as concrete bayt.json).

Mecha and omnishell reduce an application to infra config, CSS, HTML, and JS handlers. The smaller the surface the LLM must write, the higher its success ratio — that is the constraint-cascade thesis, and it is the load-bearing claim of the whole project.

## The review ladder

Three artifacts, one per audience:

```
brief.md ── LLM hop 1 ──▶ ir.html ── LLM hop 2 (narrow) ──▶ program.cue ── cue export ──▶ outputs
```

- **brief.md** — product altitude. Natural-language description a business/product person writes and reviews. Mutable. `brief.html` is its presentation layer, nothing more.
- **ir.html** — engineering altitude. A design doc, not a spec for machines first: it maps user intent onto the architecture. It shows the boxes and how they communicate (mecha components, pipelines, escape hatches — mermaid or equivalent), and it shows the screens as SVG sketches. It is what an engineer reviews before intent gets frozen into a program. Renders in any browser with no tooling. Pinned per compile.
- **program.cue** — machine altitude. The actual program. Nobody reviews it; it is a compiler intermediate that happens to be committed. Pinned per compile.

Media follow altitude: SVG belongs in ir.html because boxes, arrows, and sketches are design-doc media. HTML/CSS does not appear until the program, where it is emitted rather than drawn.

### Why ir.html is a stage, not a projection

A projection (ir.html rendered *from* CUE) was considered and rejected: the IR's job is to capture architecture decisions at an altitude *above* the program — richer than the brief, coarser than CUE — and to be the human review point before those decisions are frozen. A projection can never hold information the program lacks, which defeats that purpose.

The cost of a real stage is a second probabilistic LLM hop. It is contained:

- The structured parts of ir.html (entity tables, flow topology, data-path assignments) extract into CUE **deterministically**.
- Only sketch → screen-config is heuristic.
- Every box, arrow, and sketch carries a machine-readable id. Generated CUE back-references those ids. A deterministic checker enforces a **bijection**: every IR box has a CUE entity/pipeline, every CUE entity cites an IR box. IR↔CUE drift is checkable.

The drift ladder that results:

| Rung | Mechanism | Deterministic? |
|------|-----------|---------------|
| brief ↔ ir.html | LLM judgment, human-reviewed (this *is* the design step) | No |
| ir.html ↔ program.cue | Id bijection check | Yes |
| program.cue ↔ outputs | `cue export` is a pure function | Yes |
| Behavior | Test pairs (data in the program) executed in a worker | Yes |
| Visual / flow | State and path diffs on rendered ir.html | Yes |

Only the top rung is probabilistic, and that is the rung where an engineer is reviewing anyway.

Storyboard structure (named states + happy/unhappy path sequences) is the spine of the visual sections: it is simultaneously the visual spec, the enumerated test scenarios, and two of the drift mechanisms. Inside ir.html the frames are SVG sketches; the shipped screens are HTML/CSS.

## The target surface

`cue export` emits everything; the program is data:

| Output | Consumer |
|--------|----------|
| YAML configs | mecha — schema DDL, PostgREST routes, CDC pipelines (bloblang/jq), ElectricSQL shapes |
| Layout/route/auth/form config | omnishell — interpreted at runtime; **no build step exists** |
| HTML/CSS | the screens |
| JS handlers | confined state handling (below) |

Screens as interpreted omnishell config (not generated framework code) is a load-bearing decision: it is what removes tsc/bundlers from the pipeline and makes browser-only development possible.

## JS handlers

Omnishell's doctrine (single data path, forms-only mutations, reactive live queries) already removes effects, fetching, and imperative DOM. The remaining computation is confined in layers:

1. **CUE absorbs pure derivations** — computed fields, filters, validation. CUE is total; every expression terminates — which is why no separate total language is needed.
2. **Handlers are authored in Jessie** (Mark Miller's tinySES successor, endojs/Jessie): a defined safe subset of JS — strict functional core, no `this`, no classes, no ambient authority. JS syntax preserves LLM fluency, which rules out Elm (no in-browser compiler, frozen ecosystem, weak LLM fluency) despite its philosophical fit. A defined grammar also enables constrained decoding at generation time.
3. **Dual enforcement**: static (Jessie grammar gate at compile) and dynamic (each handler runs in an SES Compartment — the MetaMask Snaps mechanism).
4. **Temporal-style determinism**: time and randomness are injected as inputs by the runtime, never ambient.

Handler shape: pure `(state, event) → state'` with CUE-contracted state types; the framework owns all effects. Anything that does not fit is not a handler — it is an escape hatch, which is the correct pressure.

Open alternative: reuse bloblang/jq (already WASM in the browser for CDC pipelines) for client-side pure transforms, unifying the transform language across client and pipeline. Decide empirically by writing the same computed views both ways.

Net property, worth stating loudly: **nothing in a Pronto application runs with ambient authority.**

## Escape hatches

Ranked; every escape is a box in ir.html, so holes in the guarantees are visible in the design doc an engineer reviews:

1. **Pre-compiled WASM** (preferred). Sandboxed; interface is a CUE contract; the same `.wasm` runs at every tier (tab, CDC pipeline, server) — the only escape that preserves vertical scaling untouched.
2. **External API endpoint.** Full escape with a clean trust boundary: the Pronto-managed database is only touched by Pronto; beyond HTTP is the external world.
3. **Container.** Full escape, realized per tier: a real container at compose/k8s/cloud; at browser tier it binds to a **declared shim** (MSW mock or degraded WASM stand-in). This is the snapcards precedent (ShimTextModel replacing Ollama behind one interface) and is consistent with mecha's best-effort browser consistency tier. Declaring the shim forces a mockable interface contract.

Browser-tier live containers were investigated and deprioritized: WebContainers (StackBlitz), Nodebox (CodeSandbox), and CheerpX/WebVM all require commercial licenses for production embedding. Open alternatives run at emulation speed (container2wasm, Apache-2.0; v86, BSD) and are offered only as opt-in. quickjs-emscripten (MIT, the Figma-plugins mechanism) covers "run arbitrary JS" escapes without full node.

## Browser-first: ejected from day one

The full development loop runs in a tab; there is no eject moment because the repo is the source of truth from the first commit.

- **CUE in WASM.** The evaluator compiles with Go's `js/wasm` target (proven by the official CUE playground). A thin wrapper exports `vet` / `eval` / `export`, runs in a Web Worker. Pin the same CUE version bayt uses (currently v0.16.1) so browser exports are byte-identical to laptop/CI exports — this determinism is what makes browser-produced commits of generated outputs safe and reviewable.
- **Runtime.** mecha `@browser`: PGlite + MSW + bloblang/jq WASM — proven in snapcards.
- **Git.** OPFS-backed virtual filesystem holding a real repo (isomorphic-git). Push via the GitHub REST API (CORS-enabled: blobs → tree → commit → ref) with a fine-grained PAT or device-flow app; raw smart-HTTP push needs a CORS proxy, so the API path is default.
- **Scaffold commit includes sayt/bayt files.** The browser never executes them; it authors a repo in which they are already true. Clone to a laptop → `sayt launch` works; the snapcards four-launch-modes property falls out automatically.
- **Committed artifacts**: brief.md, ir.html, program.cue, and the exported outputs (consistent with bayt committing its emissions; safe because export is deterministic).
- **CI is the outer loop.** `git push` is the promotion gesture; CI runs the real sayt/bayt lifecycle (containers, integrate, deploy tiers). The tab never needs Docker. Connects directly to the sayt CI-as-distribution thesis.

## The in-browser TDD loop

A dev cycle that round-trips through CI is too slow for the compile-edit-test rhythm, so the sayt TDD loop gets a browser tier: `lint@browser`, `build@browser`, `test@browser`. The design move is to port the *executor*, not reinvent the verbs. Sayt already has the `verb@platform` dimension and bayt already defines what a verb is (manifest + srcs + deps + stamp); a small JS "sayt-lite" verb-runner inside the pronto dev shell reads the same bayt target definitions from the OPFS checkout, hashes srcs via WebCrypto, and writes the same merkle stamps into OPFS. Incrementality, dep-ordering, and skip-on-unchanged behave exactly as on a laptop; the browser is simply the innermost layer of the sayt TDD cascade — ping-pong on `lint@browser`/`test@browser` until green, push, and CI runs the container-tier verbs above it.

| Verb | Browser realization | Notes |
|------|--------------------|-------|
| `setup@browser` | Service worker warms the pinned wasm toolchain (cue, bloblang/jq, PGlite, Jessie parser) | "Install" = cache-fill; `doctor@browser` checks OPFS, wasm loads, API keys |
| `lint@browser` | `cue vet` against the pronto stack schemas + IR↔CUE bijection check + Jessie grammar gate + `DOMParser`/`CSSStyleSheet` on screens + mermaid and bloblang parse checks | The constraint cascade itself; all deterministic, sub-second. HTML/CSS fidelity is *higher* than CI — the checking engine is the rendering engine |
| `build@browser` | `cue export` in a Web Worker → artifact tree in OPFS, then wire: schema into PGlite, routes into MSW, handlers into SES Compartments, config into omnishell | Byte-identical to CI output (pinned CUE). No bundler exists, so build is materialize + wire |
| `test@browser` | Four layers: (1) contract test pairs against handlers in Compartments — millisecond ping-pong; (2) data-path tests on fresh in-memory PGlite with snapshot/restore fixtures; (3) pipeline tests through bloblang/jq wasm; (4) storyboard-path flow tests driving interpreted screens in a hidden iframe | Layer 4 is driverless E2E: app and runner share a browser. PGlite is real Postgres in wasm, so SQL semantics match the container tier |
| `verify@browser` | Render each storyboard state, rasterize, pixelmatch against the pinned ir.html states | Visual drift detection moves into the inner loop |
| `integrate@browser` | Runs against declared shims only | Honest fidelity boundary — cross-service integration and real auth flows stay CI-tier, same contract as mecha's best-effort browser tier |

Two properties fall out. Every deterministic verb runs offline — the LLM is re-invoked only when brief.md or ir.html change, so iterating on a red test costs zero tokens and seconds, not a CI round trip. And CI never trusts browser-produced stamps; it recomputes them — the browser loop exists for feedback speed, not for skipping CI work.

### The tooling's imperative core is one JS + SES model

sayt-lite has an imperative core: bayt's dep-ordering, transitive-closure, and merkle-stamp logic — the graph work that lives in nushell on a laptop. That core is authored in the **same Jessie-subset + SES Compartment model as the handlers**, not in a separate language. The collapse is deliberate: Pronto's entire imperative surface — application handlers *and* build tooling — runs under one enforcement model (pure functional JS, no ambient authority, effects injected), so there is exactly one purity story to reason about.

The split of labor is by evaluator strength. **CUE-wasm owns declarative composition, constraint validation, and emission** — the surface the LLM authors, where fail-at-eval-time keeps it honest. **Pure JS-in-SES owns the graph/recursion engine** — where CUE's evaluator falls over: forcing concretization of a recursive graph is super-quadratic (a transitive closure is ~3 s at 200 nodes natively, and cue-wasm's Go runtime only makes it worse; CUE stays total, but not fast). Neither language is asked to do the other's job.

A Starlark (starlark-rust) wasm module for the graph engine was prototyped and rejected. Starlark buys intrinsic purity and guaranteed termination and is fast (an 1,600-node transitive closure evaluates in ~80 ms with **zero** host imports). But it is a *second* wasm runtime beside cue-wasm, on its own heap: every handoff of CUE's exported JSON becomes a serialize→copy→parse round-trip across the wasm boundary. JS shares the cue-wasm host heap — CUE's export is already a JS object the verb-runner walks natively — JIT beats the interpreter at these sizes, and native devtools beat cross-wasm debugging. SES plus a manual iteration bound recovers Starlark's two guarantees where they matter. The integration seam, not the speed, is what decides it.

## Compile conflict resolution

Recompiling an unchanged brief may produce different ir.html/CUE (model or prompt changes); the merge-conflict workflow is specified in [SPEC.md](SPEC.md) ("Compile diffs"). Compile diffs are productive; model improvements surface as reviewable changes, not silent mutations.

## Local runtime: Deno

The verb-runner and its FS host are runtime-agnostic — they read a checkout (OPFS in the tab, a real filesystem on a laptop) and drive cue-wasm plus the JS graph engine. The same JS therefore runs in three places: the **browser tab** (primary, OPFS-backed), a **local laptop** (Deno), and **CI** (container tier). Deno is the local incarnation, chosen over Bun for three load-bearing reasons, not stylistic ones:

1. **Permissions are a second purity boundary.** Deno denies fs/net/env by default; the pure graph engine runs with zero `--allow-*`, so purity is enforced by an OS-level sandbox *and* SES — belt-and-suspenders on the property the whole system rests on ("nothing runs with ambient authority"). Bun has no permission model — full ambient access by default — so it can offer only the SES half.
2. **Web-standard APIs mean browser parity.** Deno's `fetch` / WebCrypto / WebAssembly / ESM mirror the browser, so tab and laptop run byte-identical code paths — the uniform dev/prod property Pronto depends on. Bun leans on a Node-compat surface that diverges from browser semantics, reintroducing exactly the drift Pronto exists to remove.
3. **A foundation that is boring on purpose.** Deno is years of hand-written, memory-safe, secure-by-default Rust; Bun's runtime is a freshly AI-translated port with a large `unsafe` surface and no disclosed audit — for a tool whose entire pitch is determinism and safety, the wrong dependency to stake the local loop on.

Bun's speed edge is real and may matter later, and nothing in the architecture is Deno-specific (both run wasm + ESM, and SES is just JS) — so the runtime stays a pinned, swappable choice. Today Deno wins on the two properties that are the point: sandboxed purity and browser parity.

## Open questions

1. **Jessie grammar verification.** The restriction set described here is from memory; read endojs/Jessie's authoritative grammar before committing the lint gate to it. Same for quickjs-emscripten maintenance status.
2. **ir.html id convention.** Settled: the bijection scheme is built and wired into lint (objects.ts; SPEC.md specifies the nine compared kinds).
3. **Handlers language experiment.** Constrained-Jessie vs bloblang/jq for the same three computed views; pick by readability and LLM success rate.
4. **CUE package layout.** Settled: schema.cue defines `#Entity` / `#Pipeline` / `#Screen` / `#Flow` / `#App`, the schema surface the LLM writes against.
5. **cue-wasm binary size/perf.** Expected tens of MB uncompressed, single-digit compressed behind a service worker; measure.
6. **sayt-lite stamp parity.** Can a small JS verb-runner reproduce bayt's merkle stamp hashes byte-for-byte from an OPFS checkout (path normalization, hashing order)? If stamps match the laptop's, the cascade story is proven; prototype before building verbs on top.
7. **Iframe flow-runner.** The least conventional piece of `test@browser`: mount one interpreted screen in a hidden iframe, dispatch a storyboard path's events, assert the state sequence. Weekend-sized spike, no LLM needed.
8. **Benchmark** (from the June doc): the A/B working-app-rate and token-cost comparison against Lovable remains the gate for productization.
9. **Graph-engine parity across the three runtimes.** The JS graph engine (dep-order, transitive closure, stamps) must produce byte-identical stamps in the tab (OPFS), on Deno, and in CI. Ties to OQ 6; the risk is path-normalization and hashing-order differences between OPFS and a real FS. Prototype the same closure on all three before building verbs on it. The starlark-wasm alternative is measured and rejected (see "one JS + SES model"); the residual to prove is JS+SES matching Starlark's termination guarantee via a bounded outer loop plus a runaway-iteration guard.
10. **Runtime pin.** Pin a Deno version alongside the CUE pin, and confirm cue-wasm + SES Compartments + the OPFS/FS abstraction behave identically on it and in the tab. Re-evaluate Bun once its Rust rewrite has a disclosed audit and its `unsafe` surface is reduced — the swap is cheap by design, so this is a "watch and revisit," not a fork.
