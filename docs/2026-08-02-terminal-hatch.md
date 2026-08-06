# The terminal hatch: props in, events out

Continuation of `2026-08-02-terminal-doctrine.md`, read first. That doc left
six open questions and a real/designed/speculated split. This session worked
the six against the code the doctrine doc points at, plus two documents it
does not cite but should have: `plugins/pronto/PRONTOUI.md` and
`plugins/pronto/DESIGN.md`'s escape-hatch ranking. Four questions move from
open to answered-with-evidence; two stay open, sharper than before.

## Two things named "hatch"

Before anything else: the word collides. `plugins/pronto/schema.cue:233`
declares `#App.hatches: [Name=string]: {ir: *Name | string, kind:
"container", note: string}` — real, built, exercised by Keep's OCR hatch
(`2026-07-30-keep-stage4-vocabulary.md`). It is a **cluster-tier** escape:
a container service, wired into `program.cue`'s cluster unification, reached
over HTTP by a pipeline. It is not the fifth rung of the doctrine doc's unit
ladder. The **terminal-tier** hatch — a unit inside the shell that brings its
own build — is still designed-not-built, exactly as the prior doc says. Keep
the two apart; the codebase does not do it for you, and a search for "hatch"
returns both without distinguishing them.

## Q1 resolved: it is not channel-versus-object

The prior doc framed this as a binary and leaned channel on Elm's authority.
That framing was wrong, and `PRONTOUI.md` — written two weeks earlier, never
cross-referenced by the doctrine doc — already contains the right answer
without knowing it was answering this question.

`DESIGN.md` ranks three escapes (WASM, external API, container). `PRONTOUI.md`
§"Extending the escape-hatch taxonomy" forces a fourth: **the vendored UI
component** — "a trusted, audited JS component mounted by omnishell at a
declared mount point, with a CUE-contracted props-in / events-out interface."
That is the terminal-tier hatch. Its own open question #1 — "how does
omnishell declare a mount point + CUE-contracted props/events for a big
*stateful* React component?" — is this doc's open question 1, asked from the
other side. Two documents converged on the same shape independently; that is
worth more than either one's argument alone.

Props-in, events-out is not a compromise between channel and object — it is
neither, applied to the two halves of the contract that need different
things:

- **Props in** are shaped like what the widget tier already does. `mountWidget`
  hands `adapter` a plain `rows` array and calls `widget.update(rows)` — a
  live, resynchronised-on-every-render object, not a message. A hatch reading
  collections needs the same thing: a current-value feed, not an event per
  change, because Dockview's `fromJSON` and a React component's props are
  both "give me the current state," not "tell me what changed."
- **Events out** are shaped like what the island role already does. In
  `wireDrag` (`interpreter/screen.js`), `reduce(state, event)` returns
  `{updates: [{id, patch}]}`, and the shell — not the island — performs
  `store.update` for each entry. That is Elm's `Cmd` in the codebase today,
  proven independent of this question. A hatch's output side wants the same
  shape scaled from one call to a stream: named events over its lifetime,
  because Dockview emits layout-change events and assistant-ui emits tool
  calls, and neither hands back a single completion value the way an island
  does.

The safety argument the prior doc reached for — channel because a foreign
bundle cannot run inside SES — is answered a different way, and better:
`PRONTOUI.md`'s purity boundary states it directly. **Generated logic (islands,
adapters) stays pure and SES-sandboxed; vendored components are the declared,
trusted escape — not generated, not sandboxed, but contracted and visible.**
Trust comes from audit at hatch-authoring time, not from runtime containment.
A hatch does not need a worker or an iframe to be safe; it needs a CUE
contract an engineer reviewed, the same way the container escape's safety is
the Dockerfile someone read, not a seccomp profile guessed at generically.
Isolation (worker/iframe) stays available as an implementation choice for
crash containment or lazy loading — orthogonal to the trust question, and not
required to answer it.

The contract above is now wired for the iframe boundary:
`interpreter/hatch.js` plus a `data-hatch` / `data-prop-*` mount point in
`screen.js`, published as `terminal.cue`'s `capabilities.hatch`. There is
still no bundle-loading path parallel to `vendor/zag.js`'s
`bun run bundle:zag` — a unit is a document the app declares and serves, not a
bundle the platform links.

**One claim above needs correcting, and the first consumer is what corrects
it.** "A hatch does not need a worker or an iframe to be safe … isolation stays
an implementation choice … orthogonal to the trust question" holds only while
the unit's *content* is as audited as the unit. It is not, for the case that
made the hatch worth building: a third-party article embed is a provider's
document, fetched at read time, reviewed by nobody. Trust-by-audit covers the
unit — the small document the app wrote to host the embed and speak the
bridge; it cannot cover what that document renders. So for this consumer the
two arguments compose rather than compete: the unit is trusted because an
engineer read it, and sandboxed because what it shows arrives from someone
else. Isolation is orthogonal to trust only for a unit whose content is its
own code.

## Q2 resolved: two Jessie patterns already coexist

`interpreter/screen.js`'s `ROLES` map has exactly two entries today, and they
already answer "is returned-requests right for every role":

- **island**: `endow: () => ({})`, must return a function. Its call site
  (`wireDrag`) treats the return value as a request — `{updates}` — that the
  *shell* executes. This is `Cmd`, empirically, not by analogy.
- **adapter**: `endow: () => ({})`, must return `{toItems, toValue?}`. Its
  call site (`widget.js`) treats the return value as data consumed directly —
  `items = adapter.toItems(rows)` feeds a Zag collection; `adapter.toValue`
  writes straight into a hidden form field in `screen.js`'s `onValue`
  callback. Nothing is ever "performed" on the adapter's behalf; its output
  *is* the answer, not a description of one.

So the question as posed had a false premise: it is not that returned-requests
might be wrong for adapter, it is that adapter was never given returned-request
semantics — it is a pure translation role, and the code already treats it that
way. The general lesson for the hatch design above: a role is either a
**request-shaped** role (returns a description, the host performs it, matches
`Cmd`) or a **translation-shaped** role (returns data, the caller consumes it
directly). A hatch's events-out is request-shaped; its props-in is
translation-shaped in reverse (the host performs the translation — computing
the current view — and the hatch consumes it directly). No code changed;
`ROLES`' two entries are correct as they stand, and a hatch's contract would
be a third role that is *both* shapes on two different channels rather than a
variant of either.

## Q3 narrowed, not resolved: subscriptions cannot reach into an island

The frozen mechanism in `screen.js` is explicit: island roles get
`endow: () => ({})`, and the comment above `ROLES` says why — "a role that
could read the clock or reach the network would stop being a function of its
inputs, which is the only reason it is safe to run app source without reading
it." A timer, a keyboard listener, or a presence feed is by definition
something that reads the clock or reaches the network. Generalising
subscriptions into the island grammar is therefore not a vocabulary extension,
it is a purity violation — the two are in direct tension, and the prior doc's
"does that stay in markup" question undersold how load-bearing this is.

What the code already does with impure reactivity stays terminal-native: `guarded()`'s
retry/backoff loop, the drag wiring gated on `data-drag-handle` presence in
the template (markup-triggered, imperatively wired — a real middle case the
prior doc's "ad-hoc" list undersells, since the *existence* of the wiring is
declared in markup even though the *mechanism* is not a first-class
subscription abstraction), and `createShell`'s single page-level `navigation`
listener, which is terminal chrome and was never a per-screen concern to begin
with.

The shape this points to: a subscription that needs impurity is either (a)
terminal-native, built the way `data-live` and drag already are, with the
platform, not app code, holding the endowment — or (b) a hatch capability,
since the ladder already grants hatch "capabilities" that islands are
explicitly refused. What stays open is the markup grammar for (a): whether a
timer or a keyboard binding gets its own `data-*` attribute family, or whether
`data-live` generalises to a `data-subscribe="kind"` with kind-specific
options. Both are vocabulary growth of the kind the diagnosis in the prior doc
warns against, so this should wait for a second concrete need before either
is chosen — one instance (drag) is not enough to infer a grammar from, the
same objection that applies to Q4 below.

## Q5 refined: the merge-policy role's raw material is bigger than believed

The prior doc's "facts not to re-derive" already established TanStack DB
tracks `rowOrigins` and `preSyncVisibleState` internally. Reading
`vendor/mecha-client.js` (the bundled TanStack DB, lines ~2840–2910) finds
more: every row gets a `getVirtualPropsSnapshotForState` call that stamps
`$synced`, **`$origin`** (`"local" | "remote"`, from `getRowOrigin`), `$key`,
and `$collectionId` — a full virtual-props envelope, not just an internal
map. `interpreter/data-crud.js` and `screen.js` read `$synced` in four places
(the pending badge, the `is.false` filter translation, the binding-lookup
fallback, the sync-probe for FK joins) and never read `$origin`, `$key`, or
`$collectionId`. The raw material for a merge-policy role is therefore already
delivered on every row, unused: a role that received rows would already know,
per row, whether it is locally- or remotely-sourced, without needing new
plumbing into TanStack DB's internals. What is still missing is exposure of
**conflicting pairs** — `preSyncVisibleState` is consulted during commit and
rollback internally but never handed out as a public snapshot a role could
diff against the post-sync state. That gap, not the origin tagging, is the
actual unbuilt part.

## Still open

**Q4, the Msg-equivalent / contribution manifest.** Unchanged, and now
sharper: the codebase contains exactly one request-shaped return value —
`{updates: [{id, patch}]}` from the drag island. A vocabulary needs more than
one member to have a shape worth designing; inferring a closed enumeration
from a single instance is guessing, not design. This should wait for the
hatch's events-out to exist, or for a second island use beyond drag, whichever
comes first — at that point there are two data points and a real question.

**Q6, where presence lives.** Now diagnosed rather than merely open. Neither
surface offers what presence needs. Collections are Electric-synced,
Postgres-durable state — wrong shape, presence is explicitly not durable.
The CDC bus (`mesh-events`/redis streams/conduit in `cluster.cue`) is
at-least-once, durable-ish, WAL-sourced — also the wrong shape, and it only
carries events that originated as a database write, which presence pings are
not. Jessie roles are pure and endowment-free by the same argument as Q3.
A hatch's events-out channel is the closest fit shape-wise (ephemeral,
broadcast-shaped, matches the assistant-ui/Dockview event pattern this doc
just resolved), but that only relocates the question to "what publishes
presence pings into a hatch's channel," which is a cluster-tier gap
(mecha has no low-latency ephemeral broadcast primitive at all — everything
it offers is Postgres-durable or WAL-triggered) that the terminal cannot
answer by itself. This is a cluster-tier design gap wearing a terminal-tier
question's clothes.

## Facts not to re-derive

- `#App.hatches` (schema.cue:233) is real and built (Keep's OCR hatch); it is
  a **cluster**-tier container escape, unrelated to the terminal-tier hatch
  this doc and its predecessor design. Same word, two tiers, no code shares
  them.
- `PRONTOUI.md` (2026-07-19) independently proposes the terminal hatch under
  the name "vendored UI component," with a props-in/events-out contract and
  the purity-boundary argument (generated code stays SES-sandboxed; vendored
  code is trusted by audit, not contained by sandbox). Its own open question
  1 is this doc's Q1, unasked as such. Read it before re-deriving the hatch
  contract from scratch.
- `screen.js`'s `ROLES` map has three entries (`handler` — the role this doc
  calls `island` throughout, which is not what the code names it — plus
  `adapter` and `renderer`), all `endow: () => ({})`. `handler`'s return value
  is executed by the shell (request-shaped); `adapter`'s and `renderer`'s are
  consumed directly by the caller (translation-shaped). This split is real
  code, not a designed distinction, and `renderer` is the third data point Q4
  was waiting for.
- `vendor/entry-zag/` bundles the selection kinds (`combobox`, `select`,
  `listbox`), one module each, published as `capabilities.widgets`. Adding
  another is `bun run bundle:zag`, a platform-side rebuild — there is no
  app-supplied bundle injection point today. The renderer role is the
  counter-example worth noting: it is the one place an app extends the terminal
  with its own module rather than waiting for a platform rebuild. "A region hatch is [the widget
  tier's] machinery with the code coming from a bundle instead of an import"
  (prior doc) is aspirational at the bundle-selection level too, not only at
  the mount-point level.
- `vendor/mecha-client.js` stamps `$synced`, `$origin` (`"local"|"remote"`),
  `$key`, `$collectionId` on every row via `getVirtualPropsSnapshotForState`.
  Only `$synced` is read anywhere in `plugins/omnishell/interpreter/`.
- `SPEC.md`'s `data-*` grammar (`data-kind`, `data-of`, `data-path`,
  `data-from`/`data-to`, `data-accepts`) documents the **IR-authoring**
  vocabulary only. The terminal's **runtime** markup vocabulary — `data-live`,
  `data-widget`, `data-adapter`, `data-island`, `data-select`, `data-empty`,
  `data-empty-row`, `data-drag-handle`, `data-text`/`data-text-format`,
  `data-filter`, `data-value`, `data-action`/`data-entity`/`data-target`/
  `data-upload`, `data-order`, `data-hatch`/`data-prop-*` — is documented
  nowhere but `interpreter/` source comments, with three exceptions, all
  published as capability data because a compiler has to read what the terminal
  offers before it designs a screen around it: `data-text-format`'s built-in
  values (`capabilities."text-formats"` — `plain`, `datetime`, `markdown`), the
  renderer role that makes that list open-ended (`capabilities.renderer`), and
  the hatch's mount, props and events (`capabilities.hatch`). `emit.cue` never
  emits these attributes (screens are hand-authored assembly per SPEC's own
  doctrine). A search of `SPEC.md` for this vocabulary will find nothing; that
  is not a search failure.

## Pointers

Same as the prior doc, plus `plugins/pronto/PRONTOUI.md` (§"Extending the
escape-hatch taxonomy", §"Component stack", open question 1) and
`plugins/pronto/DESIGN.md` (§"Escape hatches", the three-rung ranking
PRONTOUI's fourth rung extends). `interpreter/vendor/entry-zag.ts` and
`interpreter/vendor/mecha-client.js` are worth reading directly rather than
through their call sites — both are small enough, and the second is the only
place the `$origin` fact is verifiable.
