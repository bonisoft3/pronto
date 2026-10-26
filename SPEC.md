---
type: reference
title: Pronto artifact spec
description: What a conforming brief.md, ir.html and program.cue contain, and the lints that enforce it.
---

# Pronto artifact spec — brief & ir (alpha)

Status: DRAFT alpha.
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
  handler | validation | hatch | unit | machine | effect | paths | diagram |
  auth | review` — on a `validation` or a `machine`, `data-of` names the
  entity that owns it; a terminal chart's id is `<entity ir>-<field>`, a
  mecha machine's and an effect's their declared `ir`. Presence is by reach
  (review by consequence): a `tab` entity, its validations, its charts and the
  handlers only they name are machine-checked and owe no element; `device` or
  above does. **The compiler draws the entity's card**: right after an
  `entity` element's opening tag, `write.ts` keeps a generated region
  (`<!-- pronto:card -->…<!-- /pronto:card -->`, never hand-edited) holding
  the card — its chips, field names, referrers, references, validations, the
  derived line, and for an entity a machine moves, the chart as a D2 picture
  carrying the `machine` (and `effect`) element — and links `ir/card.css` from
  the head. The picture comes from the `d2` the app's `.mise.toml` pins beside
  `buf` and `duckdb` (the scaffold carries it), run in the app directory with no
  browser. The card's field table carries the notes column of the authored
  `data-extract="fields"` table, which `card.css` then hides under the card: it
  stays in ir.html as hop 2's input, shown again from the card's "authored
  table" toggle, beside the entity as collapsible JSON. The author's prose
  stays outside the region
- **Screen neighbourhoods are compiled from reads.** Each screen element
  carries a generated D2 graph of exactly the entities its settled `reads`
  name, including embedded relations and disconnected entities. References are
  drawn only when both
  ends belong to that screen. Nodes show primary keys, references and machine
  fields; retired and platform stamp columns are omitted. A generated app
  overview is the union of the screen graphs, not every entity in the schema.
  Both use the app's pinned D2 and are written beside the document as
  `ir/neighbourhood-<screen>.svg` and `ir/neighbourhood-app.svg`, shown by
  `<img>`, so ir.html stays the prose, cards and frames a reader loads. The
  adjacent entity list carries the links to entity cards and remains readable
  without the picture. See
  [[docs/screens|screens]] for how the markup supplies those reads.
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
`emit.cue` in this directory), evaluated with the
pinned CUE version. Nobody reviews it; it must merely be *checkable*.

- **Shape.** The app package's top level is the five components: `code:
  pronto.#App & {…}` (entities, pipelines, drains, screens with storyboard states
  and paths, flows, tests, decisions), `cluster:`, `terminal:`, `loop:`,
  and `build:` (the harness seats — defaulted via
  `pronto.#DefaultCluster`/`#DefaultTerminal`/`#DefaultLoop`/
  `#DefaultBuild` in program.cue, and
  [overridden in bayt.cue](docs/component-contracts.md#the-five-parts)). The loop (default sayt,
  rostered as `pronto/loops:sayt`) owns the verb surface; the build
  (default bayt, rostered as `pronto/builders:bayt`) owns the build
  graph, exported concrete as `bayt.json`. `out: pronto.#emit & {code,
  cluster, terminal, loop, build}` derives the emission. The seats wire
  through quoted labels — `{"code": code}` — never bare ones: inside
  `{code: code}` the value refers to the field being defined (a cycle that
  surfaces as an incomplete value far from the cause), while a quoted label
  does not enter the value's scope, so it resolves to the sibling. The
  canonical shape:

  ```cue
  code: pronto.#App & {...}
  terminal: (pronto.#DefaultTerminal & {"code": code}).out
  cluster: (pronto.#DefaultCluster & {"code": code, statics: terminal.surface.statics}).out
  loop: (pronto.#DefaultLoop & {"code": code, "cluster": cluster, "terminal": terminal}).out
  build: (pronto.#DefaultBuild & {"code": code, "loop": loop, "cluster": cluster, "terminal": terminal}).out
  out: pronto.#emit & {"code": code, "cluster": cluster, "terminal": terminal, "loop": loop, "build": build}
  ```

  An app has one layout wherever it is built: its repository's root, with
  the runtime where mise puts it. The cluster serves the app's own files
  (fingerprinted from the build context) and the build takes the
  terminal's statics from its image. In a source checkout, where pronto
  sits beside its siblings' sources, `write.ts` writes the app's
  `mise.local.toml`, which a mirror never receives: it points mise at the
  runtime's trees and sets `MONOREPO_COMPOSE_MODE`, under which the images
  build the runtime from those trees and lay the app out as the checkout
  does (`builders/bayt.cue`).

  A first `generate` converges without hand-made stubs: decisions carry an
  empty-note default until derivation writes `program_derived.cue`, and a
  not-yet-emitted `shell/design.css` records a sentinel the fixpoint
  re-derive replaces.
- **Pinning.** `meta.ir.sha256` is the sha256 of the ir.html the program was
  compiled from; the brief→ir→program chain is hash-linked end to end. The
  bijection checker must verify the pin before it compares anything, since
  against an ir the program was not compiled from every difference below is
  noise; none does ([pending](PENDING.md#the-compiler)).
- **Bijection.** Every object carries `ir`, defaulting to its name/key — the
  ir.html element id it realizes. A storyboard frame has no object of its own:
  its id is *built* as `<the screen's ir>-<state>` and compared whole. The
  checker compares thirteen ir kinds — {entity, pipeline, screen, state, flow,
  test, decision, handler, validation, hatch, unit, machine, effect}. A program
  id that owes review but has no ir element is code
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

**Review coverage follows reach.** A `tab` entity, its validations, its
terminal charts and handlers only those charts name are machine-checked
without owing an ir element. A terminal chart's reach includes its own row
and the entities its effects write; `device` or above owes review. Other
program objects owe their elements. Every declaration remains a claim, and
an ir element with no declaration is always an error. The decision is
[[docs/decisions/2026-08-27-review-by-consequence|review by consequence]].

Entity cards draw every distinct terminal chart for a field. Identical charts
share a diagram; differing charts receive separate IDs and labels naming their
screens, including multiple charts mounted on one screen.

**An entity's writers are derived.** `#Entity.writers` (`writers.cue`) lists
every declaration that writes its rows — a screen's forms and what its markup
writes past them, the terminal charts it carries (`#Screen.charts`, projected
from the markup like its reads and writes), a pipeline's sink and a fold's
pair, a computation's outputs, a mecha machine's row and relational effects —
each with its ops, and the card prints each as `kind:name op·op`. Nothing is
authored, and nothing refuses two kinds of writer on one entity; whether a
sink should be its pipeline's alone is open ([pending](PENDING.md#the-lattice)).
Every op is a word of the terminal's `#Machine.#MutationOp` (omnishell
`machine.cue`, where each is classified by what happens if it happens twice),
re-exported by `terminals/omnishell.cue`: a form's `action`, a `#Write.op` and
mecha's `#RelationalOp` each narrow it to the ops their performer runs, and
none extends it.

**An external effect belongs to its invoking machine.** `state.effects`
declares `input`, its instance `key`, a sink and a non-empty `note`; its
entity is derived from the machine whose state names it by `invoke.src`.
No invoking state, multiple invoking states or invocations from different
entities are refused. An idempotent sink carries no `reentry`; otherwise
`reentry` is `reconcile | unknown | repeat`, with `reconcile` as the default.
The peer's idempotency and the cost of a repeat are the claim the `note`
explains. The card derives delivery: idempotent or `reconcile` is
exactly-once, `unknown` at-most-once, and `repeat` at-least-once.

**Machine actions distinguish writes, signals and hatches.** `effect` contains
only relational mutations. `raise: {notify, payload}` sends a PostgreSQL channel
notification; `raise: {stream, signal?, key?}` signals a declared DuckStream
(`refresh`, `checkpoint` or `flush`, default `refresh`). Both accept lists.
`hatch: {name, call, args?}` calls a SQL function through a named
`capabilities.hatches` declaration of kind `sql`; the machine's `hatches` are
derived from its actions. Such a machine shows `delivery: unspecified` and
links the hatch's rationale in its card. `reject` refuses the transaction.
An effect outcome cannot contain a rejection, including its exit and entry
actions. State entry runs on insert; transitions run exit, transition and entry
actions in that order inside the transaction.

A raw pipeline is a hatch: it requires a non-empty `note`, has unspecified
delivery, and owes a `data-kind="hatch"` element. Its sink's writer is a hatch
with no derived mutation op, since the compiler cannot inspect its stream.

**A machine owns its initial state.** A mecha machine's `initial` supplies the
SQL default for its state field when the field declares none. A different
field default is refused, as is a generated or retired state field. If the field
has no CEL, the emitter supplies a
CHECK admitting exactly the machine's states; a parsed closed CEL enum must
include every state. State values in inline and held seeds must name one of
those states.

A mecha machine declares either a statechart (`states`) or lifecycle handlers
(`on.insert`, `on.update`, `on.delete`). Combining them is refused; separate
machines over the same entity keep both triggers explicit in SQL and in the IR.

**Lifecycle guards own predicate validation.** `state.machines.<name>.guards`
contains named Jessie predicates (`src`, `via`, `note`). Each `on.insert`,
`on.update` or `on.delete` transition names `guard` (one name or an ordered
list) and optional `actions`; an action or list alone is the action-only
shorthand. Every guard is used and every reference resolves in its own
machine. Names are unique across an entity's machines because they are also
the entity's refusal names. `entity.validations` is a closed derived projection
with each guard's owner and events. Guard-only machines inherit the entity's
effect level; server actions or statecharts on browser entities are refused.

The server lifecycle interpreter checks its guards before its actions. It
runs `AFTER` when guarded, after RLS and generated columns, reading related
rows in the same transaction; guard refusal rolls back the write and actions.
An `assign` cannot alter a row after its write and is refused there. Access
stays declarative RLS. The browser preflight chooses the same event's guards
before mutation; on delete, the event row and prior item are the deleted row.
A false result is a named non-retriable refusal; every non-boolean is a program
error. The predicate ABI and authoring contract are in [[GUIDE#validations|the guide]].

For a retained database, apply the generated `009_validations.sql` and
`010_machines.sql` together in an application migration while writes are
stopped. The former keeps predicate function identities and removes the old
validation-only trigger; the latter installs guarded lifecycle interpreters.
Changing declarations alone does not upgrade an initialized volume.

**A server machine's `after` is a durable timer.** Each nonnegative integer
millisecond delay arms a one-shot schedule on state entry, in the row's
transaction. The existing ticker inserts a private `machine_timer_tick`; its
interpreter locks the owner, verifies that the same visit is still active,
selects the first true guard, and performs exit, transition and entry actions.
A timed self-transition creates another visit. An earlier `AFTER` trigger
that rewrites or recreates the owner during the same row event is refused;
it cannot silently replace the visit being armed. A false or null guard consumes
that timeout; other delays remain armed. The clock's sweep cadence bounds
precision: `after` is a minimum delay, not an exact execution time.

Leaving a state, changing the primary key or deleting the row cancels its
schedules. Every entry has distinct schedule names, so a late tick cannot
advance a later visit to the same state. Duplicate tick IDs are absorbed.
Primary keys cross the ticker as text, preserving large integers and composite
keys. Client roles cannot read or write the schedule or tick tables. Timed
machines require a server-held entity and a primary key; final states have no
`after`. They require a declared cloud clock and cannot target Pages.

`010_machines.sql` installs the timer tables and interpreters before seeds.
Retained databases must apply the generated SQL through their migration path;
the `timer-check` startup step refuses a different interpreter. First adoption
also refuses existing timed rows without explicit schedules for their current
state's delays: a migration must supply deadlines from known entry times or
explicitly move those rows. Creation time is not state-entry time. Subsequent
timer changes require the migration to reconcile any pending schedules with
the new program. Airlock's automatic interpreter upgrade checks a timed
machine's signature before replacing it, so it cannot adopt timer changes.
The compiler never guesses elapsed time or resets deadlines
during startup.

**A terminal chart is closed over the entity's row.** `context` is refused:
other columns start from the entity's field defaults. The emitted
`shell.yaml` schema carries defaults as literal values: a SQL quoted string
is decoded, booleans retain their type, and `NULL` becomes null. Numeric
defaults follow the field's carrier: `int64` and `decimal` retain exact
canonical strings; other numeric types carry numbers.
SQL expressions such as `now()` and `gen_random_uuid()`, and literals requiring
a SQL payload cast, carry no terminal default. The field's `defaulted: true`
still tells markup lint that a pending row may await a database default. A
singleton machine region without `data-empty-row` requires a
filter pinning `id`; it binds those defaults, then the filter's equalities,
then its `field: initial`. An explicit `data-empty-row` remains the whole
row. The terminal's [machine contract](https://github.com/bonisoft3/omnishell/blob/v0.19.1/docs/machines.md) states
the row and effect grammar.

**Screen markup carries no executable code.** The markup check and terminal
parser refuse scripts, inline event handlers, executable URLs, `srcdoc`, and
embedded objects. Templates are checked recursively after HTML parsing, so
character references cannot hide an executable URL. Jessie and declared units
and explicit host-DOM hatches are the execution surfaces.

The door sends the terminal's Content Security Policy; the entry document
carries the same policy in its hashed bytes and the release cache preserves
its header. Trusted Types admits only the terminal's inert markup parser,
same-origin script URLs, and SES evaluation while the cage is running. A
rendered document boots through an external module after first paint.

Browser resources default to the app's origin. An exception is
`capabilities.resources.<name>: {kind, source, note}`: `kind` is a CSP fetch
directive stem (`img`, `font`, `media`, `frame` or `connect`), `source` is one
HTTPS origin, and `note` is non-empty. Reader-supplied images alone may use
`source: "https:"`; that explicitly admits requests to their chosen hosts.
Script sources cannot be extended. Vendored realm and agent files keep their
own execution boundary; the terminal's Trusted Types policies are not imposed
on their documents or workers.

**A host-DOM hatch is trusted browser code.** Declare
`capabilities.hatches.<name>: {kind: "host-dom", src, files, note}` and name it
in `surface.screens.<screen>.hatches`. `note` is non-empty and states the
reason for its ambient authority. `src` is an ES module under `shell/hatches/`
and must occur in `files`; those exact files are served and hashed with the
app release. This hatch can reach the whole host DOM, browser APIs and app
client. Its delivery is unspecified. Screen selection is a lifetime boundary,
not a sandbox; CSP and Trusted Types still apply.

The default export is synchronous `mount(screen, {signal, messages, params})`
and returns a cleanup function. Register partial-mount cleanup on `signal`
before allocating resources. The terminal aborts the signal then calls cleanup
on pause, stop and before a template morph, and mounts again on resume or after
a visible morph. Cleanup must be idempotent and release listeners, observers,
timers and subscriptions; asynchronous continuations must check the signal.
Server rendering validates the declaration without importing or mounting it.
Only the manifest selects executable paths; no markup attribute loads code.
A release-controlled browser imports the module through its pinned service
worker; an absent release asset or controller is refused.

**A vendored unit declares its ports.** `capabilities.vendored.<unit>.ports`
is `reads`, the entities whose rows the unit is handed (the row of the region
its mount sits in, through `data-prop-*`), and `raises`, the events it may
post (heard by the mount's `data-on-*`); ports and adapters, the terminal
being the adapter on both. CUE refuses a read naming no entity; the terminal's
`check markup`, which sees the emitted `units:` and the screens together,
refuses a mount fed a region the unit does not read, a mount handling an event
it does not raise, and a raise no mount on any screen handles; the mount
refuses the first two at runtime and the seat an undeclared raise, while a
raise nobody handles is the lint's alone, since no mount is where it would be
seen. Every refusal of the mount and the seats is a `ProgramError`: the mount
and a memo's question run inside the region's refresh, whose outage guard
retries anything else as a dead gateway, and an answer inside the port's
listener, where anything else is a console line; the shell banners a
`ProgramError` from a rejection and from the window's `error` event alike.

**An agent is a question whose answer lands in a memo.** A unit with
`isolation: "agent"` declares `memo: {entity, key}` — the entity whose row is
the answer, addressed by the question's fields (Michie's memo table), which
the mount binds as `data-prop-*` of the same names; a unit that acts on the
world is a process hatch. CUE refuses an agent without a memo, a memo on any
other isolation, a memo naming no entity, a key field the entity lacks or that
is primary or retired, an
entity without a unique over exactly the key fields (the natural key an answer
resolves against), a memo entity with a column that is not text (an answer
crosses the seat as strings), and an agent raising other than one event (a
question has one answer); `#emit` holds a memo's columns to the terminal's
`hatch.<seat>.detail` offer as far as the program states them — more columns
than `keys`, a column named outside `key`, a column whose declared size bound
exceeds `value` — since an answer carries every column in one event; the
alphabet, and the length of a column left unbounded, are the agent seat's
refusal at runtime, never a drop. The offer is stated once: the seat's parser
is held equal to it by `vendored-unit.test.ts`. The terminal performs the
memo: a keyed query asks for the question's row, and a row found answers
without asking. The unit's answer is upserted on the key before the chart
hears the raised event, whose detail is the key — the chart reads the answer as a row of a table its region reads,
which `check markup` requires. An answer the store refuses is the same
`ProgramError`, naming the unit and the table: no reduce authored the write,
so it is not a `refused` event. The entity's
writers carry the unit as
`unit:<name> upsert`; its card says `memo of: <unit> by <key>`, and an entity
a unit reads says `read by: <unit> (<isolation>)`.
The host registers the memo's table and schema even when no screen reads or
writes it. Its primary key is allocated by the store; the question's key uses
active non-primary fields, all carried in the answer.

A field's `cel:` is the one statement of its constraint. `plugins/pronto/cel.ts`
parses it once at generate into `.pronto/cel.json` (cel.expr.ParsedExpr as
protobuf-JSON); every rendering is a function of that file — in
`program_cel.cue`, the CUE field constraints under `seed` and, under one
`#Entity.cel`, the SQL CHECK bodies, the closed value sets the terminal's
per-kind template lint is judged against, and the bounds a battery proposes
values within. An
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
