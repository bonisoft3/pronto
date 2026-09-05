# Pronto artifact spec — brief & ir (alpha)

Status: DRAFT alpha. Normative example: [`apps/thenote`](../../apps/thenote)
(the golden reference, compiled through the full ladder: its ir.html is
produced from its brief, its program.cue from that ir.html, and the
emitted app is acceptance-verified live).
Scope: all three artifacts of the review ladder.

## The app triple

An app directory holds `brief.md` → `ir.html` → `program.cue`, per the
review ladder in [`README.md`](README.md). This spec defines the first two,
plus their satellites: `acceptance.md` (transcluded checklist), `DESIGN.md`
(visual identity), `brief.html` (presentation), and agent cards under
`plugins/pronto/agents/`.

## brief.md

The product-altitude source: a plain markdown file. The compiler reads
brief.md; every other rendering of it is presentation.

### brief.html: the presentation layer

A sibling HTML shell that renders brief.md in any browser. It carries no
content of its own — the source of truth is always brief.md:

- Shell JS comes from CDN `<script>` tags pinned to exact versions with SRI
  `integrity` hashes (markdown-it, markdown-it-attrs, js-yaml). Pronto-specific
  semantics (the link taxonomy) are inline — they are ours, not a library's.
- Editing is a source pane: a textarea over brief.md with live re-render.
  Save writes brief.md back (File System Access API, download fallback).
- Transclusions resolve by `fetch`, so they inline when served over HTTP and
  degrade to a boxed link on `file://`. The compiler always sees the full
  composition; only raw-file viewing degrades.

### Format

CommonMark (markdown-it) plus two extensions:

- **attrs** — `{#id .class}` on blocks, list items, and links.
- **wikilinks** — the pronto link taxonomy below.

### The link taxonomy

| Syntax | Meaning | Resolution |
|--------|---------|------------|
| `[[Todo]]` | design-object reference | renders `<a href="ir.html#Todo">`; the text **is** the object id, verbatim |
| `![[path.md]]` | transclusion (composition) | fragment is part of the brief's source; concatenated before hop 1 |
| `[x](path){.agent}` | compile directive | agent card hop 1 must consult; inline placement scopes it to its section |
| `[x](path-or-url){.context}` | citation | document resolved into hop 1's prompt |
| `[x](url)` | plain link | for the human reader; semantically inert |

Hop 1's input is the transitive closure of the brief under `![[]]` and
`{.context}`; its toolbox is the `{.agent}` set; its output must define every
`[[id]]`. All four resolutions are deterministic.

Id spelling: PascalCase for entities, kebab-case for screens, states, and
flows. The IR may define objects the brief never names; the brief may not
reference objects the IR does not define.

### Frontmatter (the per-app harness)

YAML between `---` fences at the top of brief.md. Machine-readable and
normative; the prose never restates it.

| Field | Names |
|-------|-------|
| `pronto` | format version (`alpha`); implies the check suite |
| `name` | app name |
| `business` | the business shape: who pays, who uses, what kind of undertaking |
| `stage` | how far along: the rigor dial for the compile |
| `team` | the virtual team that compiles and signs |
| `cluster` | the virtual cluster the program targets |
| `terminal` | the virtual terminal users touch |
| `loop` | the lifecycle contract developers turn |
| `build` | the build graph the loop drives |

Beyond `pronto` and `name`, every value is free-form, interpreted by the
compiling LLM. The conventional spellings, in rising explicitness:

- **a bare name** resolving through pronto's rosters — `team: studio`,
  `cluster: mecha`, `terminal: omnishell`, `loop: sayt`, `build: bayt`
  (today's defaults);
- **an inline spec** — `team: 2 frontend, 1 backend`, `business: b2b saas,
  seat-priced`, `stage: production, regulated (LGPD)`;
- **a markdown pointer** — `team: ./AGENTS.md`, `terminal: someother.md`,
  `business: ./PITCH.md`;
- **a CUE pointer** — `terminal: ./path/to/omnishell.cue`.

Resolution happens in hop 1 and is recorded in the ir head (`pronto-team`
and friends), so a free-form value never crosses to the ir unresolved; a
recompile under a different resolution is a different compile.

`business` and `stage` are posture, not seats: they name no component, but
every judgment call downstream reads them. Screens and tone follow the
business — b2b brings roles and audit trails, b2c brings onboarding polish,
an internal tool skips the ceremony — and rigor follows the stage: an `mvp`
compile tolerates thin acceptance coverage where `production` demands
unhappy paths and hardened auth. Promotion is a one-word diff on the line
that governs how strict the check suite's judgment calls are.

The harness names the seats and the posture; it configures neither. Shared component
knowledge lives once in [`prelude.md`](prelude.md), implicit context of
every compilation; a brief only speaks up where it deviates or extends.

### Sections

Title + lead, then in order: `## Data`, `## Screens`, `## Behavior`,
transcluded acceptance, `## Out of scope`. Consumer behavior: unknown
sections are preserved without error; duplicate sections reject the file.

The brief stays at product altitude: it names what the user sees and needs
("a counter, always current"), never mechanisms ("pipeline",
"materialization"). Architecture words in a brief are a review smell.

### acceptance.md

A flat checklist; each line carries an attrs id (`{#accept-…}`). These ids are
the traceability spine: ir.html invariants and storyboard paths cite them via
`data-accepts`, and full coverage is a lint.

## The virtual team

The compile-time counterpart of the cluster, terminal, and loop: the roles
that turn a brief into an ir and sign it. The team is **pronto source, not
CUE**: CUE appears only below the ladder's waterline — the compiler target
(program.cue) and the emission libraries (clusters/terminals/loops) —
while everything people or LLMs consume composes as markdown, Obsidian
style. A brief's frontmatter `team:` resolves per the harness conventions
above (default `squad`, under `plugins/pronto/teams/`). A
team file lists its roles as links/transclusions of role cards
(AGENTS.md-shaped markdown with a charter and a gate). The team's work
product IS the ir: one `data-kind="review"` section per listed role
(verdict + findings), linted deterministically by extracting the team
file's role links — like acceptance coverage. Provenance: the ir head
carries `pronto-team` (the reference) and recompiles by a different team
are different compiles; hashing the composed team markdown into the pin
chain follows when the team first exercises.

## ir.html

Engineering-altitude design doc, plain HTML, pinned per compile. Renders with
no JS except mermaid (pinned CDN + SRI) and an inline CEL highlighter.

### Head metadata

| Meta | Content |
|------|---------|
| `pronto-ir-version` | IR format version |
| `pronto-source` | `brief.md` |
| `pronto-brief-sha256` | sha256 of brief.md (leading/trailing whitespace stripped, UTF-8) — staleness is detected by rehashing |
| `pronto-generated` | compile timestamp |
| `pronto-compiler` | model that compiled it |

### Id convention

Every design object is an element with a native HTML `id` (giving free anchor
navigation from the brief) plus data attributes:

- **Ids are opaque tokens; structure lives in data attributes, never parsed
  out of the id string.**
- `data-kind` — `entity | pipeline | screen | state | flow | test | decision |
  handler | hatch | unit | paths | diagram | auth | review`
- `data-of` — owner (states belong to a screen, tests to an entity/pipeline/screen)
- `data-path` — mecha data path on entities (`crud | live | offline`)
- `data-route` — the screen's route, on `data-kind="screen"`. The route is
  design, not prose: the ir's frame-to-storybook links are generated from it,
  and the bijection checker compares it against the program's `#Screen.route`.
- `data-from` / `data-to` — pipeline topology
- `data-accepts` — space-separated acceptance ids a test or path realizes

The hop-2 bijection checker walks `[data-kind]` elements and matches CUE
back-references against literal id strings — it never splits an id to recover
what it points at, which is what makes the convention above enforceable rather
than aspirational.

### Sections

1. **Overview** — engineering summary + one architecture mermaid diagram whose
   node names are exactly the object ids defined below. In any mermaid block,
   a node id matching a design-object id is a reference; other nodes are local
   narration.
2. **Entities** — per entity: rationale prose, a field table
   (`data-extract="fields"`: field, type, CEL constraint with `this` bound to
   the field value, notes), optional row invariant
   (`data-extract="invariant"`), data-path assignment.
3. **Pipelines** — prose transform description at engineering altitude;
   `data-from`/`data-to`; idempotence argument stated.
4. **Screens** — reads (`data-extract="reads"`), mutations
   (`data-extract="mutations"`, forms only), form contracts
   (`data-extract="form"`), then the storyboard: one SVG wireframe `figure`
   per named state (`data-state`), and a paths JSON block
   (`data-kind="paths"`): named state sequences with `accepts`. Frames are
   SVG sketches — design-doc media; HTML/CSS does not exist until the program.
5. **Flows** — one mermaid diagram per user-visible mutation flow.
6. **Invariants & test pairs** — see below.
7. **Decisions** — numbered entries (`data-kind="decision"`): architecture
   choices, which agent-card rules fired, and an explicit **escape hatches**
   entry even when the answer is "none" — holes in the guarantees are always
   visible.

### Invariants: prose with embedded CEL

Each invariant is a paragraph — `id`, `data-kind="test"`, `data-of`,
`data-accepts` — whose body is natural language with the formal parts as
`<code class="cel">` spans (CEL: total, effect-free, protovalidate/Kubernetes
lineage). The attributes keep coverage linting deterministic; the LLM at the
program rung translates the paragraph into executable tests that
back-reference the paragraph id, extending the bijection over behavior.

Bindings are injected, never ambient: `input` (given data, plus `input.now`
for the clock), `output`, `error` (`error.kind`, `error.field`).

## program.cue

The machine rung: a CUE instance of the `pronto` package (`schema.cue` +
`emit.cue` in this directory, module `bonisoft.org`), evaluated with the
pinned CUE version. Nobody reviews it; it must merely be *checkable*.

- **Shape.** The app package's top level is the five components: `code:
  pronto.#App & {…}` (entities, pipelines, screens with storyboard states
  and paths, flows, tests, decisions), `cluster:`, `terminal:`, `loop:`,
  and `build:` (the harness seats — defaulted via
  `pronto.#DefaultCluster`/`#DefaultTerminal`/`#DefaultLoop`/
  `#DefaultBuild` in program.cue; the runtime trio is redeclared in
  bayt.cue as the out-of-band override seams). The loop (default sayt,
  rostered as `pronto/loops:sayt`) owns the verb surface; the build
  (default bayt, rostered as `pronto/builders:bayt`) owns the build
  graph, exported concrete as `bayt.json`. `out: pronto.#emit & {code,
  cluster, terminal, loop, build}` derives the emission.
- **The manifest is part of the program.** `cue export -e out` yields
  `manifest` (the sorted list of every file the program emits) and `files`
  (path → `{format, text | data}`). Raw formats (sql, caddyfile, html, css,
  cue) render to strings inside CUE; structured formats stay structs for the
  writer to serialize — bayt's `#render` division of labor. `write.ts` walks
  the bundle onto disk, and is the app's `build` task.
- **Pinning.** `app.ir.sha256` is the sha256 of the ir.html the program was
  compiled from; the brief→ir→program chain is hash-linked end to end. The
  bijection checker verifies the pin before it compares anything: against an
  ir the program was not compiled from, every difference below is noise.
- **Bijection.** Every object carries `ir`, defaulting to its name/key — the
  ir.html element id it realizes. A storyboard frame has no object of its own:
  its id is *built* as `<the screen's ir>-<state>` and compared whole. The
  checker demands set equality both ways over ten ir kinds — {entity,
  pipeline, screen, state, flow, test, decision, handler, hatch, unit} — and
  both directions are errors. An id in the program with no ir element is code
  no reviewer signed; an id in the ir with no program object is a designed thing
  the running app silently lacks, and it is the more dangerous of the two.
  Neither is a work-in-progress state to be tolerated: one hop produced the
  program from the ir it pins, so a difference either way is a compiler defect.
  Ids are also unique within each side — a bijection is one-to-one, and set
  equality alone cannot see a duplicate. The four uncompared kinds each have a
  reason: `paths` and the architecture diagram are narration, covered via their
  screen; `auth` has no CUE object bearing an id (that section exists as a
  `data-of` anchor for the sign-in flow and its tests); `review` is the virtual
  team's work product, which no CUE object realizes and no lint yet covers.
  Handlers and hatches
  *are* compared, because they carry `ir` — and a handler is arbitrary code in
  an SES compartment, the largest escape from the declarative surface and
  precisely what a bijection exists to police.
- **Emitted surface**: the cluster's data plane (migrations, the CDC
  pipeline, one stream transform per program pipeline, the gateway), the
  terminal's shell surface, `tests/pairs.yaml`, and the loop and build
  surfaces. What each runtime demands of the emission — and why — lives
  with that runtime and its roster seam; the mechanism and its rationale
  ride `emit.cue` beside the code.
- **The runtime is published CUE, owned by its implementations.** *Virtual
  cluster*, *virtual terminal*, *loop*, and *build* are contracts; mecha,
  omnishell, sayt, and bayt are the default implementations, and others
  can exist. Each implementation lives with its product and publishes its
  *role* as a CUE package. **Pronto owns the roster by indirection**: the
  re-export files under [`clusters/`](clusters/), [`terminals/`](terminals/),
  [`loops/`](loops/), and [`builders/`](builders/) are the seam — each
  carries what pronto relies on from its tool, so consumers name the
  runtime through pronto while the internals stay with their owner.
  Adding an implementation is adding one re-export file; pinning or
  forking these modules is pronto's versioning and forking story.
  Pronto's emitter is their fixed composition — that is the whole "pronto
  runtime". **Escape hatches are CUE unification on a seam that always
  exists**: hatches compiled from the ir land in program.cue's cluster
  unification (`cluster: services: <name>: {...}` plus its launch-gate
  dep) — they are program output, like every other compiled object. The
  emitted bayt.cue redeclares the runtime trio unchanged; that
  redeclaration is the *out-of-band human* override seam (add a service,
  modify one, `null` drops one) — ir's "escape hatches: none" ⇔ neither
  the program's cluster unification nor the redeclaration carries changes.
  The build seat's handoff contract — concrete bayt.json embedded by a
  thin bayt.cue stub — lives with the roster in
  [`builders/bayt.cue`](builders/bayt.cue).
- **The loop runs on builtins.** The emitter emits the files the loop's
  builtin verbs expect — `.vscode/tasks.json`, `compose.yaml` (the local
  virtual cluster; `launch` drives its gate service), and `.say.yaml`
  carrying the checks, each filed under the verb whose layer it needs —
  `lint` for the ones that read files, `test` and `integrate` for the ones
  that need a mounted screen or a running cluster. A check the terminal
  publishes lands in every app's `.say.yaml`; an app adds its own beside
  them. The doctrine — argv-shaped commands, which
  check lands at which verb, agent-driven verify — rides the loop
  contract itself ([`plugins/sayt/loop.cue`](../sayt/loop.cue), rostered
  as [`loops/sayt.cue`](loops/sayt.cue)).
- **The shell surface is files, not a DSL.** Screen semantics — bindings,
  forms (`data-entity`/`data-action` + native constraint validation), states —
  live in the directly generated HTML/CSS/Jessie. `shell/shell.yaml` is only
  a file map: route → `{html, css, handlers}` plus nav labels and the boot
  `tables` list (derived from the screens' reads). Nothing the runtime
  consumes is stated twice.
- **Assembly files.** ir.html defines the units; the foreign-language files —
  HTML, CSS, Jessie, bloblang, SQL beyond the derived DDL — are the assembly
  the compiler emits directly, living in the app tree (`shell/screens/*`,
  `pipelines/*.blobl`). program.cue is the link map: it derives what is
  derivable, references assembly by path (`src` entries; the writer verifies
  presence and copies only when target ≠ src), and inlines content via
  `@embed` only where a consumer cannot reference a file (rpk's mapping).
  Trivial static stack text (migration preludes) may stay in CUE;
  pronto-owned static assets (the Caddyfile) ship under
  `plugins/pronto/assets/`, embedded at export.
- **Not emitted**: `.mise.toml` (scaffold-owned), the ir view (ir.html is
  itself the pinned artifact).

A field's `cel:` is the one statement of its constraint. `plugins/pronto/cel.ts`
parses it once at generate into `.pronto/cel.json` (cel.expr.ParsedExpr as
protobuf-JSON); every rendering is a function of that file — the SQL CHECK
bodies and the CUE field constraints in `program_cel.cue`, and the closed
value set the terminal's per-kind template lint is judged against. An
entity's `invariant:` binds `this` to the row instead of the value, so it
derives a CHECK body and nothing for CUE: a predicate over several columns
constrains no one field's value.

Known gaps, deliberate at alpha: the
pairs runner behind `tests/pairs.yaml` is unbuilt; derived entities rely on
convention, not roles, to stay pipeline-only-writable; and **schema
evolution is unsolved** — initdb SQL only runs on a fresh volume. The
declared direction is migration diffing on a schema emitted
deterministically from `#Field`, on the surface mecha reserves for it
(Atlas).

## Verify is agent-driven

The visual half of `verify` needs judgment: the storybook renders the
evidence, an agent reviews it against the ir's storyboard frames, state
vocabulary, and Decisions — doctrine carried with the loop
([`loops/sayt.cue`](loops/sayt.cue)). When the unattended vision harness is
wired, pronto emits its context prompts from the program's storyboard data.

## Lints

All deterministic, all pre-LLM, reported as structured findings
(`{severity, path, message}` JSON). A finding fails its verb unless its
severity says otherwise: a check that cannot reach part of what it grades
reports that as `advisory`, because an app carrying one has no way to make it
reachable and a gate it cannot satisfy is a gate it will route around:

1. Every brief `[[id]]` resolves to an ir.html element id.
2. Every `![[]]` transclusion target exists.
3. Every `{.agent}` / `{.context}` local path exists.
4. Every acceptance id is cited by at least one `data-accepts` (test or path).
5. Every `data-accepts` value is a defined acceptance id.
6. Element ids are unique; `data-of` targets exist.
7. Every state named in a paths block has a frame, and vice versa.
8. Frontmatter conforms to the harness schema.
9. `pronto-brief-sha256` matches the current brief.md (staleness).
10. Mermaid blocks parse; CEL spans parse.
11. `app.ir.sha256` matches the current ir.html (program staleness) — the
    bijection checker's precondition, reported there.
12. ir↔program bijection: set equality both ways over the nine checked kinds,
    plus id uniqueness on each side, plus each screen's `data-route` equal to
    its `#Screen.route`.
13. Every `cel:` has its parsed IR in `.pronto/cel.json`, and every derived
    file still hashes to what the derivation wrote — both asked by lint 14.
14. The fact-store invariants in `plugins/pronto/invariants.sql`, evaluated by
    DuckDB over `.pronto/facts.json`. The queries state the modality they read:
    a program fact is closed, so naming something outside it is a
    contradiction; an ir fact is loose, so a claim with no witness is a finding
    while a program fact no diagram draws is not. `.mise.toml` is
    scaffold-owned, so a new app carries the `http:duckdb` pin the rule needs.
    Severity gates the exit as the visual battery's does: a contradiction
    between two rungs is an error, an acceptance claim nothing has settled yet
    is a warning — the ledger exists to track that work, not to fail on it.

## Compile diffs

Recompiling an unchanged brief may produce a different ir.html (model or
prompt changes). This is a merge-conflict workflow reviewed at IR altitude,
with a semantic differ (structure + prose, regression verdict). Accept,
keep, or merge.
