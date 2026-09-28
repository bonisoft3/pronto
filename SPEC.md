---
type: reference
title: Pronto artifact spec
description: What a conforming brief.md, ir.html and program.cue contain, and the lints that enforce it.
---

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

### DESIGN.md

The role layer, and the app's one design declaration. Its YAML frontmatter —
between the file's first two `---` lines — is the design block: exactly the
fields of pronto's `#Design` (`preset`, `colors`, `dark`, `rounded`,
`spacing`, `motion`, `control`, `measures`, `type`, `component`, `shell`),
every one optional, the named preset supplying the rest. It carries the app's
own overrides and additions, `var(--…)` references included, never the
resolved palette. `program.cue` embeds the file and derives its design from it
through `#DesignMd`, restating nothing; a frontmatter key `#Design` lacks, a
value of the wrong shape, or a file without a frontmatter is an error at
`cue vet`. The body is the argument for the values — the comparison, the
verdicts, and what each token means — in prose.

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
carries `pronto-team` (the reference), and recompiles by a different team
are different compiles.

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
  handler | validation | hatch | unit | paths | diagram | auth | review` — on a
  `validation`, `data-of` names the entity that owns it
- `data-of` — owner (states belong to a screen, tests to an entity/pipeline/screen)
- `data-durability` — durability on entities (`tab | device | server | live |
  offline`), the guarantee ladder of `#Entity.durability`
- `data-route` — the screen's route, on `data-kind="screen"`. The route is
  design, not prose: the ir's frame-to-storybook links are generated from it,
  and the bijection checker compares it against the program's `#Screen.route`.
- `data-from` / `data-to` — pipeline topology
- `data-accepts` — space-separated acceptance ids a test or path realizes;
  a program test's `accepts` is derived from its element's

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
back-reference the paragraph id, extending the bijection over behavior; a
test's `accepts` is derived from that paragraph's `data-accepts`, so the
design is the one statement of what a test settles.

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
  `#DefaultBuild` in program.cue, and
  [overridden in bayt.cue](docs/component-contracts.md#the-five-parts)). The loop (default sayt,
  rostered as `pronto/loops:sayt`) owns the verb surface; the build
  (default bayt, rostered as `pronto/builders:bayt`) owns the build
  graph, exported concrete as `bayt.json`. `out: pronto.#emit & {code,
  cluster, terminal, loop, build}` derives the emission.
- **Pinning.** `meta.ir.sha256` is the sha256 of the ir.html the program was
  compiled from; the brief→ir→program chain is hash-linked end to end. The
  bijection checker must verify the pin before it compares anything, since
  against an ir the program was not compiled from every difference below is
  noise; none does ([pending](PENDING.md#the-compiler)).
- **Bijection.** Every object carries `ir`, defaulting to its name/key — the
  ir.html element id it realizes. A storyboard frame has no object of its own:
  its id is *built* as `<the screen's ir>-<state>` and compared whole. The
  checker demands set equality both ways over eleven ir kinds — {entity,
  pipeline, screen, state, flow, test, decision, handler, validation, hatch,
  unit} — and both directions are errors. An id in the program with no ir element is code
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

**The bijection is total.** No kind and no write is exempt by durability: a
handler that updates only a `tab` entity owes its ir element as one writing the
database does. Levying ir coverage by what a write reaches is
[review by consequence](docs/decisions/2026-08-27-review-by-consequence.md),
not built.

A field's `cel:` is the one statement of its constraint. `plugins/pronto/cel.ts`
parses it once at generate into `.pronto/cel.json` (cel.expr.ParsedExpr as
protobuf-JSON); every rendering is a function of that file — the SQL CHECK
bodies and the CUE field constraints in `program_cel.cue`, and the closed
value set the terminal's per-kind template lint is judged against. An
entity's `invariant:` binds `this` to the row instead of the value, so it
derives a CHECK body and nothing for CUE: a predicate over several columns
constrains no one field's value.

### Field types

A field's type is one of fifteen portable types, and the type system is the
compiler's alone. Each type names a standard and a **canonical string, such
that two values are equal if and only if their canonical strings are**
([why](docs/types-and-identity.md#portable-types)).

| Type | Standard | Canonical form | String order is value order |
|---|---|---|---|
| `string` | Unicode | UTF-8 scalar values, no U+0000, no normalisation | [text order](docs/types-and-identity.md#portable-types) |
| `bool` | proto3 | `true`, `false` | — |
| `int32` | proto3 | decimal digits, no leading zeros, no `-0` | no |
| `int64` | proto3 | the same, as a JSON string | no |
| `double` | IEEE 754 | RFC 8785 number; `NaN` and `±Infinity` refused | no |
| `bytes` | RFC 4648 | canonical Base64 | — |
| `uuid` | RFC 9562 | lowercase, hyphenated | yes |
| `timestamp` | RFC 3339 | UTC with `Z`, exactly six fractional digits | yes |
| `date` | RFC 3339 | `YYYY-MM-DD` | yes |
| `time` | RFC 3339 | `HH:MM:SS.ffffff` | yes |
| `timezone` | IANA tzdb | a canonical zone name | — |
| `duration` | RFC 3339 App. A | total seconds, `PT5400S`; no month or day component | no |
| `decimal` | XSD 1.1 | exact fixed point, no leading zeros, no exponent | no |
| `json` | RFC 8259 | the text as given; unindexed | — |
| `geojson` | RFC 7946 | a GeoJSON geometry or feature | — |

Where the last column says no, values compare through the type's comparator;
where it says —, the type has no order, and a column that asks for one is
refused. `types.cue` states each type as data — its pattern, its order, and
`beyond`, the closed vocabulary of checks a pattern cannot say (`calendar`,
`int64-range`, `duration-range`, `tzdb`, `decimal-profile`, `scalar-values`,
`finite-numbers`, `ring-closure`) — and a holder meeting a check it does not
implement refuses the table rather than skipping it. Why, and where each
boundary makes a value canonical, is
[types and identity](docs/types-and-identity.md).

An entity is a durable identity — a Cap'n Proto type id, with ordinals for its
fields — that only `identity.ts` mints and `.pronto/identity.json` keeps
append-only ([workflow](GUIDE.md#identity),
[argument](docs/types-and-identity.md#identity)).
The `ir` strings the bijection compares are the ids, PascalCase for entities,
and a `[[wikilink]]`'s text is that id. What a change may do with an identity
is [schema changes](docs/schema-change-admission.md#what-pronto-admits).

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
reachable and a gate it cannot satisfy is a gate it will route around. Lints
1–3, 8, 9 and 11 and the CEL half of 10 have no checker
([pending](PENDING.md#the-compiler)):

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
11. `meta.ir.sha256` matches the current ir.html (program staleness) — the
    bijection checker's precondition, reported there.
12. ir↔program bijection: set equality both ways over the eleven checked kinds,
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
    Severity gates the exit as visual lint's does: a contradiction
    between two rungs is an error, an acceptance claim nothing has settled yet
    is a warning — the ledger exists to track that work, not to fail on it.
15. The design literal lint, from the same fact store: a CSS literal equal to a
    published rung of the same dimension (`styles.ts`'s table: `rule`, `space`,
    `radius`, `motion`, `layer`, `ratio`, `text`, `leading`) is a `warning`
    naming the token, a role before a rung; a root `font-size` is an `error`.
    `/* pronto-literal: derived */` or `pending` excuses the next declaration
    alone — `derived` only in a block that references a token, `pending`
    counted by `meta.design.pendingLiterals` with equality, any other reason an
    `error`. Every published rung equals the vendored bytes under `scales/` it
    quotes, joined on (source, token): the quotation, the witness, the
    contradiction, the admission and the provenance rules, all `error`, with
    emptiness an `error` too. Why a scale, and why a quotation:
    [the design scale](docs/design-scale.md).

## Compile diffs

Recompiling an unchanged brief may produce a different ir.html (model or
prompt changes). This is a merge-conflict workflow reviewed at IR altitude,
with a semantic differ (structure + prose, regression verdict). Accept,
keep, or merge.
