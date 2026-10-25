# Cortex machines

`state.cortex` declares `#CortexMachine`s ([[../cortex.cue]]): the app's
screens over the Mecha machines in `state.hybrids`, and over the races its
screens host. Each state names the screen that hosts it and the child it
invokes: a fold the terminal runs over a Mecha machine, or a kinetic child. Nothing runs in the browser that the terminal does not record:
a child's state is rows, its pauses are the terminal's clock, its entropy is
the terminal's draw, and everything it asks of a Mecha machine is a row it
writes.

Where this vocabulary is heading — Cortex spanning the tiers, each tier's own
`#Machine` — is §4 of [[decisions/2026-09-29-hybrid-machines]]. Mecha retains
the invoked domain charts, authorization, locking, writes, private views,
receipts and deadlines. Cortex introduces no transaction coordinator, worker,
pipeline or ledger.

## The parent

A `#CortexMachine` is XState's own `{config, setup}`. A state of `config`
names the screen that hosts it in `meta.screen` and invokes its children by
`invoke.src`; `setup.actors` implements each, as XState's `setup()` does.

A Cortex state is hosted by a screen. Navigating to the screen enters the
state and mounts the child's regions; leaving unmounts them, and a child's late
write lands as a row like any other. The parent's state is the terminal's
navigation, which it already holds and replays, so there is no second chart to
persist. `#App` refuses a state whose screen or machine is undeclared, a
session over a machine without a lease, a sync child over a machine without a
join, and a sync child whose screen's route does not carry its `instance`.

## Invoking a Mecha machine

An invoke's `src` names an actor of `setup.actors`, `{machine, via, handler}`:
the Mecha machine it reaches, how, and the fold that does; or a
[kinetic](#kinetic) child. A sync child's
`input.instance` names the route parameter that carries the instance.

| `via` | Child | Lifetime |
| --- | --- | --- |
| `session` | holds a lease row on the terminal's clock | while the screen is open; a lapsed lease is the ticker's to drop |
| `sync` | opens the instance its route names and commands it | attached: leaving detaches, and the instance plays on |
| `local` | plays the machine's own reducer in the terminal | owned; its state is the app's rows |
| `kinetic` | hosts a race on the screen's mount ([below](#kinetic)) | the screen's: leaving stops the host and drops its ring |

`handler` is the fold: `write.ts` emits `shell/handlers/<actor>.js` from the
app's Jessie module at that path — a function `(state, event, machine, machines)`.
`machine` is the invoked machine's declaration, `{spec}`, and for a local child
also `execute`, the hybrid runtime and rules PostgreSQL runs, evaluated in the
handler's cage. `machines` holds every hybrid's declaration, so a fold that
opens another machine (a lobby opening a challenge) states its protocol version
from the declaration rather than a copy.

### Through rows

A Mecha machine's surface is the live entities the app declares beside it,
checked against it by [[../mecha-surface.ts]] as the migration is written:

| Entity | Written by | Says |
| --- | --- | --- |
| `<m>_seat` | the machine, at every accepted step | a reader's view, private to them |
| `<m>_command` | the reader | an event; the insert dispatches it and stamps the receipt on the row |
| `<m>_open` | the reader | a creation or a join; the insert runs the admission and stamps it |
| `<m>_public` | the machine | what anyone may read, where the machine publishes |
| `<m>_lease` | the reader | a tab's lease; writing admits and renews, deleting leaves |

A row's key is what it says. A command is keyed by its instance, the revision
it was made at, the seat and the gesture, so the same gesture twice is one row
and the store's outbox replays it under the same key; a gesture on a stale view
is a stale-revision receipt. A creation is keyed by its instance's id, drawn by
the terminal. A domain refusal is a receipt on the row; a protocol violation is
a 4xx and arrives at the fold as `refused`. Deadlines are armed on the ticker
as a timed phase is entered, so a timeout and a lapsed lease fire whether
anyone is reading.

A seat's columns past the protocol's are its view's fields of the same name,
and a public row's its projection's: the bar lists rooms by the seat's
`variant`. A view, a request and an input travel as JSON in a text column,
since a server table's columns ride the change feed, which has no `json`.

### Session

The fold draws a lease key once per tab and holds it; renewing is a `then` on
the terminal's clock. A fold's seat is held through its waits, so the renewal
sits on a seat of its own and the screen's other folds never wait a beat for
it. A tab that closes stops renewing, and the machine's deadline drops it.

### Sync

The screen's route carries the instance. The fold reads the room's seat,
commands and admissions through named reads filtered by the route, and a slot
keyed by the route names the instance before any row of it exists. With no
seat, it asks to join under a drawn key; with one, it draws the seat's view
into the screen's rows and turns a gesture into a command row.

### Local

The invoke names a machine with an object initializer. The terminal plays the
machine's own reducer; a Mecha-tier event is executed with `tier: "mecha"`,
standing in for Mecha's ports and ticker. Because it is a handler, everything
the game is lives in rows and every step is the terminal's, so a local game
replays like any other screen:

- its state is a row the module writes, at the durability the app declares;
- a pause is a `then` delay on the terminal's clock;
- entropy is the terminal's draw (`then: {seed: true}`), recorded on a row and
  expanded purely — never ambient randomness or the wall clock, which the cage
  refuses anyway;
- a gesture writes an intent row, and the fold the app seats with
  `data-on-mutation` applies it, so no two steps race over the game. A seat
  wakes on writes to its region's own table, so the gesture also touches that
  table's row.

The module decides when a game starts and what a save from another machine
version means; Truco deals a new game rather than resume one.

## Kinetic

`via: "kinetic"` hosts a race rather than reaching a machine: the actor
names its `engine` and `sound` (`surface.engines`), its `presenter`
(`capabilities.vendored`), the car's `bindings` (and each hot seat's), and the
`menu` and `pause` presses a reduce hears between races
(`cortex.cue` `#KineticActor`). `#App` refuses one whose engine, sound role
or presenter is undeclared, and one whose screen carries no
`data-kinetic="<actor>"`. Its `handler` is no composed fold but the screen's
own reduce, named by the mount's region: it hears each lifted milestone and
menu press as an event and answers in rows, and the row's columns are the
mount's props, so the race is the row's to start, hold and hand to the menu
([the kinetic child](https://github.com/bonisoft3/omnishell/blob/v0.19.1/docs/kinetic.md#the-kinetic-child)). With
`mode: online` the row races one seat of a GGRS session whose two session
descriptions a Mecha machine's rows carry, and its milestones go back to that
machine as commands, which Apex Run's lobby fold sends to `apexrun_duel`. Why
the race reaches rows only so is
[[decisions/2026-10-23-kinetic-machine|the kinetic-machine record]]; Apex
Run's run machine (`shell/handlers/run.js`) is the instance.

## Evidence

Truco's root machine is its own `machines/root.cue`. `test:hybrid` covers the
reducer's commands, races, receipts, timers and Airlock claim on the surface
rows, and the surface check's refusals. `test:truco-online` runs Truco's
machines through their surface in PostgreSQL under the generated policies —
leases, challenges, admissions, seat races, team matches, the ticker's
timeouts — and two readers completing a match through PostgREST as the store
writes it. Truco's mounted lobby and table screens check the folds' keys,
draws and renewal on the harness's store and clock. Mounting does not establish
browser layout, Electric delivery or full-shell acceptance; these are
executable safety checks, not an unbounded proof of liveness.
