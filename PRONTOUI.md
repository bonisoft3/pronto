# Design: prontoui — the first app written in Pronto

Date: 2026-07-19
Status: DRAFT
Sibling to `DESIGN.md` (the Pronto architecture). This doc assumes it: the review ladder (brief.md → ir.html → program.cue → outputs), the browser-first runtime (cue-wasm + mecha@browser + omnishell), the in-browser TDD loop (sayt-lite), the JS+SES tooling core, and the Deno local runtime.

## Concept

prontoui is the Lovable-class web IDE for building Pronto apps — chat-first, visual-preview-centred, code (CUE) a minor surface because no human writes CUE well. It runs fully in the browser with **no infrastructure operated by us**; when it can't, it borrows the *user's own* free tiers (their GitHub, their LLM key).

The load-bearing decision: **prontoui is itself a Pronto app — the self-hosting one.** The same omnishell runtime that interprets generated Pronto apps interprets prontoui; once running, prontoui edits its own Pronto source. This is not a slogan — it is a forcing function and a stress test, and it has consequences that shape the rest of this doc.

## Why self-hosting is the right constraint

Two things fall out of "prontoui is a Pronto app," and both are the point:

1. **It forces Pronto to be complete on day one.** You cannot express an IDE in a language that can only express todo apps. Making prontoui the first app drags the whole runtime — data path, forms, auth, escape hatches, the compile loop — up to real-application weight immediately, exercised by its own author.
2. **It is the escape-hatch doctrine's hardest case.** A todo app has ≈zero escape hatches. prontoui is *mostly* escape hatches — a WebGPU model, a docking layout engine, a code editor, the CUE compiler itself. It anchors the far end of the spectrum. If omnishell can wire those as contracted boxes with pure handlers for the glue, the "everything is a box in ir.html" review model holds even for a complex app. If it can't, prontoui is exactly where we want to discover the limit — early, in our own product, not in a customer's.

The honest risk, stated up front: prontoui may be *so* escape-hatch-dense that "written in Pronto" degrades to "wired in Pronto" — a hand-coded React app with a CUE manifest stapled on. Finding where that line falls is [an open question](#open-questions), and answering it is half the value of building prontoui first.

## Bootstrap sequence

Like any self-hosting compiler, prontoui bootstraps from a seed authored in something else:

```
v0: brief.md + ir.html + program.cue authored by hand / Claude Code (not prontoui)
      │  cue-wasm export + omnishell interpret
      ▼
running prontoui  ── edits its own brief.md / ir.html ──▶  self-hosting
```

The seed is hand/Claude-authored Pronto artifacts, compiled by cue-wasm + omnishell into the running IDE. From that point prontoui can open its own repo and edit its own review-ladder artifacts. The compiler-bootstrap analogy is exact: write v0 in another toolchain, then self-host.

## Decomposition into Pronto's model

prontoui maps onto the standard split — omnishell owns structure, handlers own pure glue state, everything heavy is a declared escape.

| Concern | Owner | Notes |
|---|---|---|
| Panel set, default layout | **omnishell layout config** | configures the Dockview escape; which panels exist (chat, preview, editor, files, verbs) is config |
| Routing | **omnishell** | open project / artifact / screen |
| Auth | **omnishell + external API escape** | GitHub device-flow / fine-grained PAT |
| Forms | **omnishell (forms-only mutations)** | settings: provider, model, keys, GitHub token |
| Data path | **omnishell single data path + live queries** | the OPFS repo + artifact tree (brief/ir/cue/outputs), reactive |
| Chat message reducer | **handler** (Jessie/SES) | pure `(state, event) → state'` |
| Selection context, verb-run status, compile-diff state | **handlers** | pure state machines |
| Chat render + agent runtime | **escape: assistant-ui** | vendored UI component |
| Docking layout engine | **escape: Dockview** | vendored UI component |
| WebGPU model | **escape: WebLLM** | pre-compiled/vendored, sandboxed to GPU |
| CUE compiler | **escape: cue-wasm** | pre-compiled WASM |
| Code editor | **escape: CodeMirror/Monaco** | vendored UI component |
| Repo ops | **escape: isomorphic-git + OPFS** | library escape |
| LLM inference (tier ≥1) | **escape: external API** | user's free/BYOK key, browser-direct |
| Docker tier | **escape: container** | user's GitHub Actions / Codespaces |

## Extending the escape-hatch taxonomy: the vendored UI component

`DESIGN.md` ranks three escapes: pre-compiled WASM, external API, container. prontoui is the stress case for the fourth — the **vendored UI component**, the terminal-tier hatch (schema.cue: declared `isolation` and checked `capabilities`; here assistant-ui, Dockview, Monaco): a trusted, audited JS component mounted by omnishell at a declared mount point, with a CUE-contracted props-in / events-out interface. It is a box in ir.html like any escape, so its presence is visible in the design doc an engineer reviews.

The purity boundary still holds, and this is the key claim: **generated logic (handlers) stays pure and SES-sandboxed; vendored components are the declared, trusted escape — not generated, not sandboxed, but contracted and visible.** WebLLM is the sharpest case: the model itself is a vendored escape running outside SES, but its *output* (generated CUE / handlers) still passes through the Jessie grammar gate and SES Compartments before it runs. The trust boundary is "vendored code we audited" vs "code the model wrote" — the latter never escapes the sandbox.

## Component stack

Every row is a contracted box, not bespoke code — the reuse is the point (see `DESIGN.md`'s tooling section for why one JS + SES model spans app and tooling).

| Surface | Component | Contract (in → out) |
|---|---|---|
| Chat + agent runtime | **assistant-ui** (shadcn-based; deep-chat-web-llm for turnkey WebLLM) | messages, tools, approvals → tool calls, edits |
| WebGPU model | **WebLLM** (OpenAI-compatible) | prompt → tokens |
| Agent loop / provider swap | **Vercel AI SDK** (assistant-ui runtime) | provider config → streamed tool-use |
| App layout | **Dockview** (`toJSON`/`fromJSON`) | panel manifest → layout events |
| Design primitives | **shadcn/ui** (+ Vercel AI Elements) | — |
| Editor (minor) | **CodeMirror 6** | doc → edits |
| Compiler | **cue-wasm** in a Worker | program.cue → outputs / vet errors |
| Repo + FS | **isomorphic-git + OPFS** | git ops → tree |
| Verbs | **sayt-lite** (JS + SES) | manifest → stamps / results |
| Runtime / preview | **omnishell interpreter in iframe** | config → rendered screens |

The only *bespoke* piece is the click-to-id bridge below. Everything else is assembled.

## The one bespoke piece: click-to-id

The preview-select-to-chat experience is small, and it is ours by design because it rides the id-bijection Pronto already has (`DESIGN.md`: every ir.html box carries a machine-readable id; generated CUE back-references it):

```
omnishell emits HTML with data-pronto-id (from the id-bijection)
   → iframe inspector overlay: hover-highlight + capture click
   → postMessage the id to the shell
   → assistant-ui inserts a context chip / frontend action referencing that id
```

Because the id maps deterministically to a CUE entity / ir.html box, "click element → reference in chat → LLM edits the right artifact" is exact, not heuristic — cleaner than Onlook's `data-oid` JSX patching, which is where the pattern is borrowed from. Full visual-editor frameworks (Onlook, GrapesJS, Puck) are rejected: they insist on owning the editing model, which fights "CUE is the source of truth."

## The agent loop is the review ladder, rendered

assistant-ui's generative UI + human-in-the-loop map directly onto brief → ir → cue → outputs, which keeps the agent thin (two probabilistic hops; everything between them deterministic):

- LLM tool calls (`edit brief`, `edit ir`, `run verb`) render as UI, not opaque text.
- Diffs are approved inline — this *is* `DESIGN.md`'s accept/keep/merge compile-conflict flow.
- ir.html renders as a generative-UI artifact in the chat, at the altitude an engineer reviews.
- Deterministic verbs (cue-wasm vet, bijection check, `test@browser`) run between hops; the LLM is re-invoked only when brief/ir change.

Tool contract exposed to the model: `read_file` / `write_file` (OPFS), `run_verb(lint|build|test)` (sayt-lite), `compile` (cue-wasm). The model edits review-ladder artifacts, never raw output.

## Zero-infrastructure runtime (the distribution model)

prontoui operates **no backend we own**. It runs in the browser; when it can't, it runs on the *user's* free tier — because those tiers meter against the user's login, not ours (GitHub per-user, not Cloudflare per-author). Every rung is user-metered:

| Axis | Tier 0 | Tier 1 | Tier 2 |
|---|---|---|---|
| **Model** | WebLLM (offline, no account) | user's free API key (Gemini 1M / Groq 70B, client-side) | user's paid BYOK frontier |
| **Compute** | browser | user's GitHub Actions (batch Docker) | user's Codespace (interactive Docker + server, public port-forward) |
| **Hosting** | static (GitHub Pages / from-browser) | — | user's Codespace endpoint (only if ever needed) |

This is the sayt CI-as-distribution thesis taken to its endpoint: **prontoui distributes as "it runs on your browser, your GitHub, and your free API key."** We ship static assets; the user supplies the compute and the model, from quotas they already have.

## prontoui develops itself

prontoui's own dev loop is the in-browser TDD loop from `DESIGN.md`: `lint@browser` / `build@browser` / `test@browser` via sayt-lite over the OPFS checkout, with GitHub Actions as the outer (container-tier) loop. So prontoui is edited *in prontoui*, checked by the same cue-wasm + JS verbs it ships, and promoted by `git push`. The dogfood is total: the tool, the app it builds, and the app that is the tool are one repo interpreted by one runtime.

## Open questions

1. **Vendored-component contract.** How does omnishell declare a mount point + CUE-contracted props/events for a big *stateful* React component? Prototype with Dockview first (it has clean `toJSON`/`fromJSON` state), then assistant-ui.
2. **Escape-hatch density threshold.** Where does "written in Pronto" become "wired in Pronto"? Define the ratio of omnishell/handlers to escape-hatch surface below which prontoui stops being a Pronto app and becomes a React app with a CUE manifest. Measuring it on prontoui is the experiment.
3. **assistant-ui state vs the single data path.** assistant-ui's runtime owns chat state; omnishell owns the single data path. Two owners — reconcile. Likely: the chat runtime becomes a handler-backed custom runtime, or chat is a sanctioned escape that owns its own state with a declared boundary.
4. **Layout state ownership.** Dockview `toJSON` vs omnishell layout config: omnishell owns default panel layout (config); Dockview owns user rearrangement (runtime), persisted to OPFS. Confirm the split doesn't create drift.
5. **Bootstrap seed.** Is v0 hand-authored Pronto artifacts, or Claude-Code-generated? Either way it must compile under the *shipped* cue-wasm + omnishell, or self-hosting is a lie. Define and pin the seed.
6. **WebLLM trust boundary.** Confirm: WebLLM (vendored) runs outside SES; its output passes the Jessie gate + SES before executing. The model is trusted to *run*, never trusted to *emit unsandboxed code*.
7. **Editor is minor.** Confirm CodeMirror over Monaco/Sandpack — the code surface is secondary to chat + preview + ir.html, so optimize for light, not IDE-complete.
