# Cortex client compositions

`state.cortex` composes existing Mecha actor ports with browser protocol machines.
[[../cortex.cue]] admits two bounded forms: `#CortexSession` for a leased session
and `#CortexCommand` for admission and commands on one actor. [[../cortex.ts]]
checks the bindings and emits `shell/shared/cortex-<name>.js`; the terminal
packages those files and the shared protocol drivers automatically.

This is a constrained composition vocabulary, not the full arbitrary cross-tier
statechart proposed in [[decisions/2026-09-29-hybrid-machines]]. The generated
browser graph owns only interaction state. Mecha retains the referenced domain
charts, authorization, locking, writes, private views and durable receipts.
Composition introduces no transaction coordinator, worker, pipeline or ledger.
External effects still use Mecha's existing Airlock machinery.

## Session

A session names a Mecha machine with a `ports.session`, a polling interval, a
private-view field for an editable draft, and the confirmed value that locks
editing. Optional `rebaseUnsent` names a command route to that same machine and
private-view fields that must be unchanged before a queued intent can use the
latest revision. This policy is an authored semantic assertion: the compiler
checks field existence and ownership, not that those fields capture every
meaningful domain change.

The emitted graph covers connecting, ready, sending, reconnecting, failed and
closed. Its runtime stores draft, pending command, confirmed snapshot and
in-flight request in one state. Draft edits cannot mutate snapshots. Reads do
not disable controls. A click during a read persists an intent and sends it
after the read. An uncertain transmitted command keeps its exact ID and body;
reload treats every restored pending command as already transmitted. Only a
correlated accepted/rejected receipt clears it. Closing cancels scheduling and
ignores late responses; undeliverable lease cleanup is resolved by Mecha expiry.

Bindings must reference declared machines, receipt-producing admissions and
private-view fields. No authored SQL is sent to the browser. Read-only SQL
projection semantics remain a Mecha declaration boundary validated by the app's
integration tests.

## Actor commands

A command composition names a Mecha machine with public view-returning
admission keyed by `instance_id`, join and sync ports. The compiler derives admission
input names, command version and the
allowed browser event set; Mecha-only events cannot be submitted through this
client. The driver owns entry, create/join retries, command persistence,
polling, failure and shutdown. Admission and in-flight status live in its
machine state. Its receipt/view actions use Omnishell's existing
[[../../omnishell/interpreter/hybrid-client.js|hybrid interaction reducer]].

Mecha joins can declare a fixed `seat` or a state-array field `seats` with
`membersPayload`. The latter generates an optional `requested_seat` input.
Under the instance lock, Mecha resumes existing membership or claims one vacant
seat, then delivers the member-seat list through the declared internal event.
That transition decides whether enough participants have arrived to start.
Membership, state and private views commit together. Cortex derives the join
input from that port and persists it through retries; it does not allocate seats.
Admission parameters can declare SQL defaults, while the generated create client
requires explicit input values so a pending request retains its meaning.

Admission input is persisted before sending. Unknown creation retries reuse
that input. A definitive admission refusal clears the opening record, allowing
another invitation; uncertain delivery retains it. Commands are persisted before transmission and remain pending until
the correlated receipt and a sufficiently recent authorized view reconcile.
A view arriving first does not acknowledge a command. One request runs at a
time; an input queued during a read is sent next. Unlike a session visibility
intent, a game command never rebases its expected revision.

## Host boundary and evidence

Hosts provide authenticated RPC, actor-scoped storage, lifecycle cancellation,
and rendering/navigation callbacks. They translate DOM gestures to protocol
inputs; they do not decide whether an uncertain operation should be repeated.
Storage failure must prevent transmission. Protocol failure enters a visible
failed state; transport loss retries the same identity.

[[../../../apps/truco/machines/lobby.cue]] composes the lobby and online table.
The local arena remains outside this composition. `test:hybrid` includes
compiler refusal tests, bounded session delivery schedules and driver tests for
lost admission/command replies, reload and late responses. `test:truco-online`
checks the generated clients against real PostgreSQL and HTTP, including two
mounted DOM clients completing a match. DOM mounting does not establish browser
layout, service-worker behavior or full-shell acceptance. These are executable
safety checks, not an unbounded proof of liveness or domain correctness.
