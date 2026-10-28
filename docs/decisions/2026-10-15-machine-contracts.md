---
type: decision
title: "Machine contracts: steps that hold their players, recorded time, declared reads and writes, and checks over them"
description: Rules out the races and stalls the review of Truco's machines found by construction — steps hold their players, time and randomness enter only as recorded input, each rule declares what it reads and writes — and lints every machine over those declarations, independent of the app, instead of simulating the backends.
status: partially-built
---

# Machine contracts

The review of Truco on [[2026-09-29-hybrid-machines|hybrid machines]] found no
data race: a fold is a pure function the terminal runs one at a time, and a
machine step runs under its instance's row lock. It found logic races and
stalls instead:

- a read of an instance's revision before its lock, so a lease renewal lost to
  the expiry it met (time of check to time of use, which read committed allows);
- a deadline decided by two clocks, the ticker's and the database's;
- an action reading the player on an event that arrives without one;
- folds that stopped because a pending wait lived only in memory.

Each was fixed where it was found. This record makes the classes impossible or
checked, without a language to replace SQL and without simulating backends.

## Steps hold their players

Built, replacing serializable steps (below). Every entry point of a machine
(`dispatch`, `deliver`, `wake`, an admission, `join`, and the `open`, `lease`
and `fire` triggers) first takes a transaction-scoped advisory lock on each
player of its instance (`hold`, keyed by the player and the same in every
machine's schema), in key order and in one call, before it locks any row. Two
steps that share a player then run one after the other, and a check reading
that player's other instances (seated elsewhere, unavailable) reads them as
their last step left them. Steps that share no player share no lock and never
abort each other. `serial()` refuses a step outside read committed: one that
waited for a player must read what that player's last step committed, which a
snapshot taken before the wait would not show. The gateway starts each
request's transaction at the database's default, read committed, for
`app_user` and `service` alike; a database built when they were serializable
gets that back when the machines' SQL runs again on release.

A lapsed lease that a renewal is writing is left for the next prune (`SKIP
LOCKED`): that renewal waits for the player the pruning step holds, so waiting
for its row in turn would deadlock.

### Why not serializable

Steps first ran serializable, and PostgreSQL guaranteed every committed outcome
was some serial order of them: a race aborted one side with `40001`. But
PostgreSQL locks a serializable read by index page, so on the small tables a
machine keeps, two players writing only their own rows read each other's page,
and one was aborted for a conflict no data caused. Measured on brawl-chess on
2026-10-22: two players saving the same move aborted each other until the roles
stopped planning sequential scans, and with every scan by index, four players
renewing presence leases at once still lost one renewal in a few hundred, when a
player first went online. The browser's outbox took the 500 as final, and the
board stopped following its game. A retry of the abort was the alternative;
holding the players removes the conflict instead.

## Time and randomness are recorded input

Built for Mecha machines. The terminal already owns every clock and draw a fold
sees; a machine's SQL now reads time only through its schema's `clock()` and
randomness only through its `draw()`.

Any other read is found by Postgres's own definitions rather than a list of
spellings (`sql-recorded.ts`). The SQL — the platform's and the app's port and
effect SQL alike — is parsed by Postgres's parser (libpg_query, PL/pgSQL bodies
included), and each call and cast it reaches is looked up in the catalog of the
database it runs on: a volatile built-in or extension function, a stable one
taking nothing and returning a date or a time (the transaction's clock), a
constant cast to a type whose input is not immutable (`'now'::timestamptz`),
and the standard's clock keywords are findings. The machine and Truco
integration tests run it against their migrated databases. What it checks is a
subset, as Jessie is of JavaScript: the PL/pgSQL the parser reads without a
catalog, so assigning to a field of a table-typed variable is outside it, and
`UPDATE … RETURNING … INTO` is the spelling inside. A function the parser
cannot read is a finding, never one let through.

The parser is libpg_query's Postgres 17 build: its 18.0.0 build answers "Not
implemented" or malformed JSON for ordinary functions, and it returns a
PL/pgSQL refusal as text that fails as JSON, so the refusal's own words are
lost.

- `clock()` is the transaction's time, the same on every read in it, so every
  check in one step agrees on it, and no session can set it.
- A timer's fire meets the deadline by the instant the ticker found due, so the
  database's clock decides no deadline, and runs the step it delivers at the
  later of that instant and the fire's own `clock()` (`deliver` and `dispatch`
  take it as `at`). A tick the ticker sent late therefore sets the next
  deadline from when it was decided, never in the past.
- `dispatch` records the time and draw it gave a step on the step's receipt,
  and an admission its time on the admission receipt, so a step replays from
  its rows.
- What was drawn and needs no drawing is derived: a delivery's command id from
  the revision it is delivered at, a schedule's name from the revision that
  armed it, Truco's room from its challenge.

Unbuilt: Pronto's own machine timers (`machine-timers.cue`) still arm from and
check against the database's clock, and the airlock's nudge reads it.

## Actions declare what they read and write

Built for the rules' guards and actions; lifting `data-reads` is unbuilt.
`config` stays XState's own; `setup` is ours, and names each guard and action
the chart uses (`libraries/mecha/machine.cue`):

```cue
guards: mayPlay: reads: ["actor", "now", "payload.slot"]
actions: play: {reads: ["now", "payload.slot", "payload.covered"], writes: ["plays", "turn", "deadline"]}
```

`reads` are the step's inputs beside the context — `actor`, `now`, `entropy`
and the event's `payload.<field>`; `writes` are the context fields an action
may change. A guard implemented in the database keeps its `sql` form and
states its rules guard's reads beside it; an action implemented there stays a
list of relational effects. The two forms are told apart by shape.

The runtime (`hybrid-runtime.js`, in the database and in the browser alike)
enforces it without translating the rules. A rule is handed only the inputs it
reads; every other input is a getter that refuses the step, and is not
enumerable, so the `{...context}` idiom passes over it rather than reading it.
An action that changes a field outside `writes` refuses the step. Generation
(`contracted` in `mecha-contracts.ts`) refuses a rule with no contract and a
write to a field the context does not hold: the runtime could not enforce
either.

Reads of the context itself are not declared. A rule's `{...state}` reads every
field, so the runtime could not tell a used field from a copied one, and none of
the properties below needs them.

Postponed: lifting Omnishell's folds into the same model. A Cortex actor would
declare in `setup.actors` what its region now spells in markup — `data-reads`
and `data-read-<name>` as its inputs, `data-on-mutation` as its `src`, its
pauses as `after`, its draws as `entropy`, its updates as `writes` — and the
interpreter would consume that one declaration rather than the attributes, so
the markup cannot disagree with the model that was checked. Carried by name
(`data-machine="arena"`, resolved against one served manifest), it would also
shrink each screen and cache the declarations once. Against it: the chart no
longer sits beside the markup it drives, and what a name means is not in the
DOM, where the attributes are read by selectors everyone understands. Forms
would follow as events of an implicit machine per entity, refined by its
lifecycle machine and referenced by its name.

## Checks over the declarations

Built, as the `hybrids` lint (`check-hybrids.ts`), and without a solver.
Generation refuses only what the runtime could not run as declared; these are
properties of a machine that runs, so they are findings, reported together
with paths, and a machine that has one still generates and launches to be
debugged. They read the machines and their surfaces from
`.pronto/check-inputs.json` and know no app. Rules and guards are Jessie and are
not translated, so what is left to prove about a machine is a walk over its
chart or a comparison of declared domains:

- a rule reads only inputs every event reaching it carries (`carries` in
  `mecha-contracts.ts`). The rules an event reaches are the transition's guard
  and action and those of every `always` arrow reachable from where it lands; a
  machine-tier event carries no `actor`. Truco's timeout ran the envido refusal
  with the wake's context and logged a null seat; its contract reads no
  `actor`, so that read is refused at the step, and a contract claiming it is
  a finding here;
- every non-final state the chart reaches has a transition to another, and
  every phase the ticker wakes takes the wake's event, whose delivery would
  otherwise be refused on every tick (`moving`);
- every value a projection's shape admits fits the surface column it fills: its
  type, and every range, length, set or pattern its CEL states (`fitting` in
  `mecha-surface.ts`). The CEL is read by `exactBounds` (`bounds.ts`), which
  answers only for a constraint it reads whole; one saying more is a finding
  rather than trusted, where the generators' reading widens it.

Z3 is deferred until a property turns on guards stated as constraints a solver
can reason over — the SQL `requires` guards over locks, or bounded sequences of
steps by several actors, which holding their players makes every interleaving. None
does today. Measured on 2026-10-15: the `z3-solver` WASM build runs under Node
only (Deno's worker shim overflows its stack on 4.15.4 and refuses its
`location` on 4.12.2; Bun fails in its worker threads); Z3's own 5.3.0 binary
installs through mise from its GitHub release, with native Windows, macOS and
glibc builds and no musl one, and would take the obligations as SMT-LIB.

## Alternatives

- **Deterministic simulation of the backends.** It needs a twin of PostgreSQL,
  Electric and the ports, and verifies the twins. Rejected: the guarantees here
  come from the real database and declarations, not from models of them.
- **Emitting Rust, SPARK or Lean.** Each brings a native toolchain to every
  machine and checks no more than the walks above do over the same
  declarations while the rules stay opaque; SPARK's prover is Z3 underneath. A model of the generic row protocol in Lean or
  TLA+ stays possible later, for the protocol alone.
- **Translating Jessie to SMT.** Unnecessary once actions declare their
  contracts and the runtime enforces them.
- **A generated language in place of SQL for locking.** Unnecessary: every
  step takes its players' locks in one call, in key order, before any row, so
  the framework fixes the order and no machine states one.

## Platform parity

Built. Omnishell's browser store, `interpreter/data-sync.js`, and the fake app
screen tests mount, `test/data-sync-fake.ts`, are two implementations of one
interface; four bugs in Truco's review passed under the fake.
`data-sync-parity.test.ts` drives both with the same writes over browser-owned
tables, scripted and drawn from fixed seeds, over a table of its own and every
table an app's `shell.yaml` declares a key or a unique for, with that key and
those uniques, and compares rows, wakes and refusals. It found the fake writing
the rows of a batch before the one it refused, where the store writes none;
staying silent on a write that changed nothing, where the store wakes the key it
settled; minting `id` on a table keyed on another column; and waking a
subscription after it stopped. The store keeps its file name: installed apps
copy it by that path.

The runtime and the timer have batteries of their own. `hybrid-battery.ts`
walks a machine from a fresh instance through seeded steps of every event,
from either tier and any seat. The runtime refuses what a caller sent that the
machine does not take (another tier's event, a payload outside its shape) as a
`RefusedError`; any other throw is a finding: a rule reading what is not there,
a state outside its shape or invariant, a write outside a contract, a step out
of fuel. It found presence's invariant demanding 36-character lease ids that
the payload's shape never promised. Truco's integration test ticks every timed
machine early, with its deadline cleared, and when due; each tick times the
instance out or arms it again, and none aborts. A tick sent a minute late runs
its step when it was decided, and the next turn's deadline is still ahead.
