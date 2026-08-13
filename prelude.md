# The pronto prelude

Implicit context for every brief → ir compilation. A brief never re-describes
these components; it only speaks up where it deviates from or extends them.

## Entities

An entity is a typed table managed by [mecha](../../libraries/mecha). Fields
carry CEL constraints (`this` bound to the field value); rows may carry a
row-level CEL invariant. Schema DDL, migrations, and API routes are generated
from the program — there is nothing to hand-configure.

## Data paths

Each entity is assigned one mecha data path:

- **crud** — forms write through PostgREST; reads are reactive live queries.
- **live** — read-only on the client; written only by pipelines, read via
  ElectricSQL shapes.
- **offline** — local-first with sync; reserved for briefs that ask for
  offline capture or multi-device use.

## Pipelines

A pipeline consumes CDC events from one entity and writes another. Transforms
are pure (bloblang or jq), delivery is at-least-once, and sinks must be
idempotent — absolute recomputation over deltas whenever the table is small
enough to make that trivial.

## Liveness and delivery

The store is the platform's, and nothing above it may poll or fetch: at
cluster tier every table syncs into the shell as an Electric-shaped
TanStack DB collection (mecha's published client,
`libraries/mecha/packages/client`), regions render reactively from
collections, and server-computed reads (fts, embeds) re-run when a table
in their dependency set changes — the collections are the change signal,
never a clock. Writes are durable offline transactions: optimistic,
queued through an outbox, retried until delivered, and confirmed against
the sync stream by the write's transaction id (every table carries an
emitted `txid` column for exactly this). Delivery is at-least-once end to
end — WAL to bus to pipelines, and WAL to shapes to screens — so every
consumer, browser included, must be idempotent; client-minted keys and
the proxy's duplicate-absorbing posture make retries safe. The CDC
publication covers crud-path tables only: that scoping, not consumer
discipline, is what makes pipeline feedback loops unrepresentable.

## Screens and the shell

Screens are interpreted [omnishell](../omnishell) config plus emitted HTML/CSS:
single data path, forms-only mutations, reactive live queries. There is no
build step and no application-owned effects. Residual computation lives in
Jessie handlers running in SES Compartments, each receiving its arguments and
nothing else — no DOM, no store, no ambient authority; time and randomness
are injected. A handler returns a description of an effect for the shell to
perform (Elm's `Cmd`, not `update` — a handler never receives the whole
model); see `docs/2026-08-02-terminal-doctrine.md` for the full comparison
and why "handler," not "island" or "update."

## Capability

Both runtimes publish what they offer as data the compiler reads before it
designs anything — the terminal module's `auth` block and its shell.css, the
cluster's service fields — and an ir is designed against the whole of it. An
app that reimplements a platform affordance is not more independent, it is
worse: the hand-rolled copy is unreviewed, untested, and behaves differently
from every other app for no reason a user benefits from. Demanding what a
runtime does not offer is a compile error; declining what it does offer is
silent, and costs the user instead — which is why the bar is stated here.

- **The terminal** owns the navigation stack — one back button, screens held
  with their DOM and scroll position, each screen saying how many of its
  instances survive (0 rebuilds on every visit) — and the nav chrome it
  builds from the routes themselves, sign-out included. It owns the screen's
  states (`loading`, `empty`, `populated`, `form-submit`, `success`,
  `validation-error`, `network-error`, `gone`) and its recovery from a dead
  gateway; a screen only styles the state it is told it is in. The set is open
  at the app's end — a storyboard frame may name a state the app invents, and
  most do — but a screen that reinvents one of these has taken over a
  transition the terminal already drives. It owns motion — rows arriving
  and leaving, the screen change, the refusal that arrives rather than blinks
  — timed at moments no screen could observe and tuned by the app's `motion`
  tokens. A row keeps its node across a refresh, so focus, scroll and a
  half-played animation survive it; a write the cluster has not confirmed
  wears a badge; an edit the user typed and has not sent is never overwritten.
  Its widget tier drives real accessible controls from markup plus a pure
  adapter, and its control primitives make the unstylable ones themeable.
  Every screen × state renders in the storybook against fixtures — that is the
  review surface, and appearance there is a token resolution, so the dark twin
  is a palette to supply, not a feature to design.
- **The cluster** owns identity and row visibility — declared per entity and
  enforced as policy, never as a filter a screen remembers to write — blobs
  with image derivatives served at the size they are shown, full-text search
  and generated columns as server-computed reads, and scheduled pipelines
  beside the CDC ones for retention and expiry. Each plane switches on by
  being used; none of it is wired by hand.

The target is an app a professional would ship, not a demonstration that the
compiler works. An empty state with words in it, a refusal the user can read,
a search that searches, a list still there after a trip through a detail
screen: none of these are polish for later — they exist already, and an ir
that leaves them unspent has made the app worse than the platform it compiles
onto. Where the team decides against a capability the app plausibly wants,
that is a Decisions entry.

## Identity

The terminal owns sign-in, and its doctrine is published data (the terminal
module's `auth` block): one-tap passkey ceremonies with a server-generated
display handle — users never type identifiers, passwords, or emails. The
terminal always offers guest sign-in beside the passkey: one click, no
ceremony, origin-independent, minting the same generated identity; the
passkey remains the durable identity. Briefs speak of people and names; they
never design login screens. An app whose program demands an auth mode the
terminal does not offer fails to compile.

## Escape hatches

Ranked: pre-compiled WASM behind a CUE contract, then a vendored component
at the terminal tier (declared isolation and capabilities), then an
external API endpoint,
then a container (with a declared shim at the browser tier). Every escape is a
box in ir.html; an app with none says so in its Decisions section.

## The virtual team

Compilation itself is staffed: the brief's `team:` (default squad —
product, design, eng, qa) names the roles that author and sign the
compile. Each role holds a gate over the surface it owns, wherever the
ladder produces it: the seats that shape the ir sign the ir, and the
seats whose surface is the assembly — screen markup and stylesheets, the
shell, the emitted SQL — sign that, before the program ships. A hop
nobody signs loses things quietly. Translation is where a multi-arm
assertion becomes a single one, because the program's shape admits one;
assembly is where one design system becomes a copy per screen, and the
copies then differ. Neither loss is visible in the ir, which is why a
gate that stops at the ir is a gate on a third of the work. Briefs stay
minimal — the team asks the questions the human didn't.

## Composition

Every rung composes naturally: brief.md and ir.html through hyperlinks —
transclusions and anchors — and program.cue through CUE itself. When
complexity justifies it, the compiler is free to split any artifact into
multiple files for parallelism, legibility, or organization; `./brief/`,
`./ir/`, and `./program/` are the conventional homes for the parts. The
markdown parts are linked from the root files; `./program/` is its own
package, which program.cue imports and unifies into the app package. The
root files remain the entrypoints; a small app has no reason to split.

## The loop

Development rides the loop — the lifecycle contract (verbs, TDD cascade,
CI) published as data by its implementation (sayt, via
`pronto/loops:sayt`), beside the virtual cluster and virtual terminal.
Briefs never describe build, test, or deploy mechanics; the loop is
platform doctrine, and its surface (lint rules, ide tasks, the launch
gate, agent-driven verify) is emitted, not designed per app.

Emitted is not absent: a check no verb reaches does not exist. Every
validator the compiler writes is declared in the program, and the loop turns
that declaration into a rule — so the compiler never invents a verb, a bare
script a reader must know to run, or a CI step. Which verb follows from what
the check needs, never from what it is about: `lint` for anything that fails
in seconds without executing the app, `test` for the app's own behaviour run
against fixtures with no live service, `integrate` for anything that needs the
cluster up. Fetching a lockfile-pinned dependency is a prerequisite of a
layer, not grounds for demoting a check to a slower one.

## Tiers

The same program runs in a browser tab, at cli (native binaries), container
(Docker Compose), k8s, and cloud. A brief's `cluster:` harness slot declares which the app
targets; nothing in the program changes between them.

## Tests

Invariants are prose with embedded CEL. Bindings are injected, never ambient:
`input` (the given data, plus `input.now` for the clock), `output`, `error`
(`error.kind`, `error.field`). Acceptance ids from the brief's checklist are
cited via `data-accepts`; full coverage is a lint.
