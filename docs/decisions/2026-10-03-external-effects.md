---
type: decision
title: External effects
description: How a machine reaches outside the cluster — a state invokes an external effect, the interpreter claims a ledger row and enqueues a Graphile job in the transition's commit, mecha's airlock runs the effect's Jessie handler against one declared sink through its Dapr binding, and the outcome returns through the interpreter as the machine's next event.
status: partially-built
---

# External effects

[Hybrid machines](2026-09-29-hybrid-machines.md) gives level 4 to cortex, the
coordinator, alone. Until now the door it coordinates through was half built: a `#SagaEffect` inserted a `saga` row and sent a `pg_notify`,
and nothing read either. This record closes the door. A machine *invokes* an **external
effect**. Mecha's **airlock** performs it against a declared **sink**. The answer comes back as
the machine's next event. A **ledger** that pronto owns records the input, every entry
and the outcome.

## Two kinds

Durable-execution engines split work in two. Temporal has workflows and activities;
DBOS has workflows and steps:

| | Pure | Impure |
|---|---|---|
| Temporal / DBOS | workflow | activity / step |
| Requirements | deterministic; time, sleep and entropy only through the engine; replayed after a crash | none |
| Delivery | replayed until it finishes | at-least-once, retried |
| Pronto | the machines cortex coordinates: omnishell, mecha, DuckStream and its compute nodes, whose state is a row or a recomputation | an external effect, performed by mecha's airlock |

Most of an engine's work goes into the pure half. A workflow written as code keeps its
progress on a call stack, which cannot be serialised. So the engine rebuilds it after a
crash by replaying the code against recorded step results. Pronto has no such stack. A
machine's progress is its row, so after a crash there is nothing to replay: the row is
read. Pronto already has the pure half, and its rules (no ambient I/O, no clock, time as
an event) are the workflow rules. What it lacks is the impure half, and that is all this
record builds.

## The grammar

```cue
state: effects: charge: {
	key:     ["id"]                             // identity: the ledger key is "charge:" || NEW.id
	input:   {amount: "NEW.total", customer: "NEW.customer_id"}   // XState's input, frozen in the ledger at the claim
	sink: {
		origin:     "https://api.acquirer.example"  // the only origin the handler's fetch may reach
		idempotent: true                             // honours our key, so re-entry calls again
	}
	note: "the acquirer deduplicates on Idempotency-Key"  // the claim about the peer, in prose
	attempts: 5                                 // tries on a thrown error before the outcome is unknown
}

machines: Payment: states: {
	pending:  on: pay: "charging"
	charging: invoke: {src: "charge", onDone: "settled", onError: "failed"}
	settled:  type: "final"
	failed:   type: "final"
}
```

`invoke` is XState's word with XState's meaning: it starts when the state is entered and
answers with `onDone` or `onError`. Omnishell's `machine.cue` already describes `after`
as "the relocated invoke", one whose actor is the terminal's clock. An external effect is
the other invoke, the one whose actor is a handler.

The outcome is the event's data, never a third exit. Every outcome is a ledger row's
`outcome`, `{target, kind, data, reconciled}`. `kind` is `done`, `failed` or `unknown`.
`onError` receives `failed` and `unknown` alike. Actions on either arrow read the
outcome as `outcome`, so a machine that must tell them apart assigns
`outcome->>'kind'` to a column and lets the next state or the screen decide. Treating
`unknown` as `failed` cannot double-perform anything: trying again means a new instance
with a new key, and the old key's ledger row already holds its outcome.

### The sink, and re-entry

A sink is where the effect lands. Pipelines already promise delivery "at least once into
an idempotent sink" ([pipelines and schedules](../pipelines-and-schedules.md)). An
external effect may also land in a sink that is not idempotent, and the ledger is what
makes that sound.

**Re-entry** means a handler starting again with the ledger showing a previous entry.
The previous run might have died before or after its call reached the sink:

| `sink.idempotent` | `reentry` | On re-entry |
|---|---|---|
| `true` | (absent; refused if present) | call again with the same key; the sink makes it safe |
| `false` | `"reconcile"` (default) | ask the sink by key through the handler's `reconcile`; call only if the sink has no record of it |
| `false` | `"unknown"` | the outcome is `unknown`; a human decides |
| `false` | `"repeat"` | call again; the effect's `note` says why a duplicate is acceptable |

Pronto cannot verify `idempotent: true`, because it is a claim about a third party. What
pronto checks is its own side: the handler's `fetch` sends `Idempotency-Key: <ledger
key>` on every request, and a fixture sink in `integrate` that deduplicates on that key
shows the declaration is honoured end to end.

### Refusals

The program does not compile when:

- an `invoke.src` names no declared effect;
- an effect is invoked by no state, by more than one, or by machines of two
  entities: its `entity` is the invoking machine's, and a ledger key names one
  instance of one state;
- an effect's name is not a DNS label, which its Dapr binding's must be;
- a state that invokes also declares `on` or `after`. Only an outcome leaves it, so a
  late answer about money that moved can never land on a machine that has moved on;
- a machine names an undeclared entity, invoking or not;
- the entity's rows do not live in the cluster (`tab`, `device`). The interpreter that claims
  runs in the cluster, once per committed write; a browser-held row would fire the effect
  from every tab;
- a `key` field is not a field of the entity;
- an effect carries no `note`, or an empty one: the sink's idempotency and the cost of
  a repeat are claims about a peer the compiler cannot check;
- `reentry` is declared on an idempotent sink;
- `sink.origin` is not an `https` origin (scheme and host, no path);
- an effect reaches an undeclared bridge, or a declared bridge is reached by no
  effect;
- a bridged sink is declared idempotent, or reconciles: past a bridge nothing is the
  platform's to promise, and a bridge answers no query by key, so the effect states
  `unknown` or `repeat`;
- an outcome could never be delivered: the invoking state is `final`, an outcome
  targets a state the machine lacks or the invoking state itself, `onDone` and
  `onError` share a target while carrying actions, or an outcome's transition, exit or entry actions `reject`;
- an `input` value reads `NEW.<col>` where `<col>` is not a field of the entity;
- a credential's header is one daprd would not forward (lowercase first) or one the host
  or HTTP sets, its secret is also among the handler's `secrets`, or a secret's name is a
  variable the cluster's own services read (`SERVICE_JWT`, `POSTGRES_PASSWORD`, …);
- any entity takes table `schedule` or `airlock_wake` while an effect is declared, or a
  schedule is named `airlock`: the wake's own names.

Past compile time the interpreter refuses, while a row is in an invoking state, a change to
its key fields or primary key and its deletion: the row is the ledger's instance until
its outcome lands.

## The ledger

`airlock.external_effect_ledger` is mecha's, in the airlock's
[`airlock.sql`](https://github.com/bonisoft3/mecha/blob/v0.17.1/services/airlock/airlock.sql), and the
cluster places it as it places the ticker's `schedule`. A row holds the key
(`<effect>:<key fields>`, also the sink's idempotency key), the instance's primary key,
the input frozen at the claim, the count of runs begun, and the outcome, set once.

Graphile Worker cannot hold this record. A finished job's row is deleted, so the same
`job_key` enqueued again runs again (G1 below). DBOS kept finished workflows; a queue
does not. A ledger pronto owns has three uses an engine's private record would not:

- **It is the only claim.** The interpreter inserts the row with `ON CONFLICT DO NOTHING` and
  enqueues only `IF FOUND`. A key already in the ledger means the effect was performed,
  so entering the invoking state again raises instead of enqueuing. Re-entry with a
  different key needs a key field the transition changes.
- **It is the authority for the outcome.** Leaving an invoking state requires a ledger
  row whose `outcome->>'target'` is the new state. So no writer except the airlock
  can forge an outcome (G4); the ledger is closed to every role but its owner,
  which is the airlock's connection (G7).
- **It is time travel's record of the outside world.** Replay answers an `invoke` from
  `outcome` instead of performing it. That is the replay handler of the handler
  triad: live, replay from the ledger, fixture.

## The airlock

Cortex coordinates across tiers ([hybrid
machines](2026-09-29-hybrid-machines.md#4-cortex-coordination-and-level-4-external-effects));
when a coordination must leave the cluster, it does so through the **airlock**. The
airlock is a mecha service, `libraries/mecha/services/airlock`, on Deno, with Graphile
Worker as its queue. It is the only place in a cluster where code reaches the world
outside, and like an airlock it never has both doors open: the claim commits before the
call.

```
 CRUD write ─► interpreter (BEFORE UPDATE)                       airlock: LISTEN jobs:insert
               │ pending → charging                        │ unlock pools whose key is free
               │ INSERT ledger ON CONFLICT DO NOTHING      │ run(): task external_effect
               │ IF FOUND: graphile_worker.add_job(...)    │   outcome set? deliver it again
               └─ one commit ──────────────────────────────┤   entered := entered + 1 (commits)
                                                           │   entered = 1 → handler.issue
                                                           │   entered > 1 → the re-entry table
 interpreter: charging → settled, only if the ledger says so ◄───┤ ledger.outcome commits, then
                                                           └   UPDATE status = outcome.target
```

- **The handler** is one module, `effects/<name>.js`, exporting `issue` and, where it
  reconciles, `reconcile`. It runs in compute's realm (`services/compute/realm.ts`, which
  compute's own cage shares): SES, no clock, no entropy, nothing of the host, and the
  realm's deterministic `Crypto`. Its one capability is an argument, `sink`, whose `fetch` the host
  performs as a call of the effect's Dapr binding (below), stamped with the idempotency
  key; the others are the frozen `input` and the values of the effect's `secrets`. `issue` returns `{done: data}` or `{failed: data}`. Throwing means
  "no answer", not "failed". The airlock's
  [README](https://github.com/bonisoft3/mecha/blob/v0.17.1/services/airlock/README.md) is the contract.
- **A thrown error** is retried by Graphile with backoff, and each retry is a re-entry.
  After `attempts` runs counted by the ledger the outcome is `unknown`: no answer ever
  came, and the sink may have acted. The ledger counts, not Graphile, which counts a run
  when it locks the job and keeps the count across a crash, so a crash on the last
  attempt would leave a job no worker takes (G8); Graphile is given the attempts plus 25.
- **Only an effect handler holds a sink.** Every other Jessie role keeps the safe set
  (`#SafeEndowment`), so the boundary between level 3 and level 4 is where the
  capability is, not a convention. Level 4 is renamed from `exterior` to `external` to
  match.
- **A crash** leaves a Graphile job locked under its pool's random id, and open-source
  Graphile treats it as abandoned only after a hard-coded four hours. Each airlock process
  holds a session advisory lock under a random key for its life and records its pool
  against that key before any run begins; Postgres frees the key when the process's
  connection ends, so a sweep that can take a recorded pool's key unlocks that pool's jobs
  through Graphile's `force_unlock_workers` (G5), and one that cannot leaves a live
  process's jobs alone (G9). It needs no replica name, so any number of processes may run.
  At start and once a minute the process settles `unknown` any job Graphile gave up on with
  no outcome, the queue's last error as the outcome's data, and moves again one it gave up
  on with an outcome recorded (G10), so a dead letter is a row the machine sees rather than
  a queue nobody reads; Graphile's row stays as the record, and a key the sweep cannot
  settle stops no other.
  Like any lease, it leaves the moment between Postgres ending a process's session and the
  process hearing of it, when a call in flight can meet a re-entry; the process exits as
  soon as it hears, and a `reconcile` that runs before the earlier call lands is the cost.
- **The process is Graphile's long-lived worker.** `run()` listens on `jobs:insert`,
  which `add_job` notifies at the interpreter's commit, so an effect starts as its transition
  commits (W1) ([the wake](#the-wake-the-tickers-re-armed-by-the-interpreter)).

A saga is a cortex coordination with several invoking states, whose failure arrows lead
to states that invoke compensations. Every compensation is itself an external effect, with
its own ledger row.

### Every sink is a Dapr binding

Every effect is a Dapr HTTP output binding of the airlock's daprd, emitted with the
program and named after the effect: its `url` is the declared origin, and `errorIfNot2XX`
is off so a sink's refusal comes back as an answer. The handler's `fetch` takes a path,
never a URL. The host calls `/v1.0/bindings/<effect>` with the path, the `Idempotency-Key`
and the content type as metadata, which the binding sends as headers; the sink's status
comes back in `Metadata.statuscode` (B1, B6). A sink that reads a credential from a header
(`Authorization: Bearer …`, `X-Api-Key`) declares it on the sink, `credential: {header,
scheme, secret}`, naming an environment variable the cluster requires: the airlock reads
it once and adds the header to every call through the same metadata (B11), so the handler
never holds it and no component carries it. A client certificate, which ponto's eSocial
submission will need, is a binding's `MTLSClientCert` and is not declared yet
([open](#open)).

The airlock's daprd runs under a configuration that allows the bindings API and nothing
else (`services/airlock/dapr.yaml`). That removes the hole M3 measured, daprd forwarding an
invoke whose target is a full URL to any origin, by removing service invocation itself
(B2), with state, pubsub, secrets and metadata (B5); an undeclared binding is refused (B4).
So the only traffic this daprd can originate is a call of a binding the program declared.

### The wall is the allowlist

- **The endowment.** The handler names a path, and the host only its own effect's
  binding. No code path in the airlock builds a URL.
- **The allowlist.** The daprd has no API that reaches anything but a declared binding, over
  HTTP or over the gRPC it always serves; a list naming HTTP alone leaves gRPC whole, and
  there it fetched `https://example.com` by service invocation (B9).
- **The airlock's network.** The airlock stands on an internal network with the database
  and its daprd, so its own code cannot go around the daprd.

The wall is therefore configuration the daprd keeps, not a route that does not exist; what
it leaves is a daprd defect, in pinned upstream code. It also does not see where a declared
name resolves: an origin is spelt as an https DNS name of two labels or more, which refuses
`https://database:5432` and every address, but a wildcard-DNS name or one whose owner
points it inward is dialled. Nor does it see a redirect: the HTTP binding follows one a
declared sink answers, method and body kept. Those are the residual, and a gateway behind
the daprd ([rejected, for now](#rejected)) is what would close them.

### A hatch

The airlock is a hatch. Pronto's hatches are the places where perfect time travel stops:
a replay can answer an invoke from the ledger, but it cannot re-run the world on the far
side. It is one kind of hatch among several, with its own declaration (the sink and its
`reentry`) and its own record (the ledger). How the hatch kinds relate is for a later
record.

## Bridges: a sink the cluster hosts

The airlock speaks HTTP and nothing else. That is what makes everything crossing it one
shape: a request with an idempotency key, recorded in the ledger, traced by daprd. A sink
that speaks something else (SMTP, SFTP, SOAP, AMQP) is reached through a **bridge**: a
container that takes HTTP and speaks the other protocol outward.

Past the airlock nothing is guaranteed. The ledger records what was asked and what came
back; what the far side does is level 4, whether it is Postmark, a container the cluster
runs, or a relay in someone else's datacenter. A bridge is therefore not a platform
promise and its code is not pure in any sense: it is a sink that happens to run on the
cluster's hardware. The guarantee wall is the airlock's call; the network wall is what
traffic may leave the cluster, and a hosted bridge sits behind the second and beyond the
first. What the platform offers is only that: it treats a bridge as any other sink, same
ledger and same re-entry, and it walls the bridge's own reach.

```cue
state: bridges: mail: {kind: "mail", server: "smtp.provider.example:587", domain: "mail.example"}
state: effects: confirm: sink: {bridge: "mail", idempotent: false}
```

- **A bridge's wall is its own permission set.** It runs on Deno with `--allow-net` set to
  its port and its declared server, and it refuses a server whose name resolves inward,
  checking the socket it actually connected before any byte crosses. Only the airlock's
  daprd reaches it, on the internal `airlock-out` network, where its effect's binding `url`
  is `http://bridge-<name>:8080`.
- **Re-entry follows the protocol.** SMTP carries no idempotency key, so a mail bridge is
  a sink that is not idempotent: the server's `250` is the done answer, and a crash
  between that answer and the ledger's outcome is decided by the effect's `reentry`. The
  bridge sets `Message-ID` from the ledger key, so a duplicate that does go out collapses
  in the recipient's mail client.
- **A Dapr binding is a bridge with no code.** The daprd calls bindings directly, so any
  binding type whose features a sink needs is one, declared as configuration. Dapr's SMTP
  binding has no attachments, no multipart body and no custom headers, so it can neither
  carry a calendar invite nor set `Message-ID`; mecha's `mail` bridge, on nodemailer, is a
  reference image for that case, swappable for any HTTP-to-SMTP relay.
- **A provider with an HTTP API needs no bridge.** Postmark, SendGrid and SES are HTTPS
  origins.

### A signature is a computation

A signature is a pure function of a key and a message, so it belongs to the language,
not to the airlock. A module may be endowed with `Crypto`: WebCrypto's SubtleCrypto,
admitting only what is deterministic by its specification, with `TextEncoder` to give it
bytes. Endowments are declared per module, as an omnishell module declares `Intl`: an
effect or a computation lists its `endowments`, drawn from what the cages can endow
(`Crypto`, `TextEncoder`, `TextDecoder`, `URL`, `URLSearchParams`), the cage grants
exactly those, and one used undeclared throws where it is used. `lint` catches it
first: an effect's handler joins the fact rows in the `effect` role, as a computation
does in its own, its declared endowments excepted from the denylist, and `lint` admits
each handler as the airlock does at startup (its `admit.ts`). The rule is the specification and not the engine: each
operation below was signed or encrypted twice on Deno, and ECDSA came out identical
there (RFC 6979 nonces) but not on Node, and the WebCrypto spec leaves it open, so a
realm meant to hold on every tier refuses it.

| Admitted | Refused |
|---|---|
| `digest`; `sign` by HMAC, RSASSA-PKCS1-v1_5, Ed25519, RSA-PSS with `saltLength: 0`; every `verify` and `decrypt`; `encrypt` and `wrapKey` by AES-GCM, AES-CBC, AES-CTR (the IV given) and AES-KW; `deriveBits` and `deriveKey` by PBKDF2, HKDF, ECDH, X25519; `importKey`, `exportKey`, `unwrapKey` | `generateKey`; ECDSA `sign`; RSA-PSS with a salt; RSA-OAEP `encrypt` and `wrapKey`; `getRandomValues` and `randomUUID`, which are not there |

Its operations answer promises, as WebCrypto's do: a handler awaits them, and a
computation's `plan` and `finish` may now answer a promise, which the host awaits. A
promise does not cost purity, since the jobs settle in an order the code fixes. No seed
makes the refused operations deterministic, because their randomness is WebCrypto's own
and never passes through `getRandomValues`; randomness a computation needs is derived from
its inputs instead, an HKDF of the seed or the ledger key and a label.

The key is an input: an effect declares `secrets`, the environment variables its handler
needs, and the airlock hands their values to the handler as a third, frozen argument at
each call, never writing them to the manifest or the ledger. The handler signs where it
builds the body.

- **A host-held signing capability** (`sink.sign`, built and removed): it kept the key
  out of program code, but specialised one algorithm into the airlock, when the
  computation is general and the credentials that must stay outside program code
  (static tokens, client certificates) already belong to the binding.
- **SHA-256 and HMAC written out in the realm** (`Digest`, built and replaced):
  synchronous, so it needed no change to compute's contract, but a second implementation
  of what WebCrypto already holds, and only two algorithms of it.
- **Blocking on WebCrypto with `Atomics.wait`**: a synchronous answer from a second
  thread over shared memory, which the language leaves out.
- **The compute service**: a scheduled program over the lake, no place for a per-message
  call; its realm, which the handler already runs in, is.

## In a cluster

The cluster places the airlock only where a program declares an effect, as it places the
ticker only where one declares a schedule: `state.effects` in mecha's `cluster.cue`, each
effect's name and its origin or bridge, brings two services (`airlock` and its daprd
`airlock-mesh`), a `bridge-<name>` per declared bridge, the ticker and its clock, two initdb
steps, and four networks. The
airlock's [README](https://github.com/bonisoft3/mecha/blob/v0.17.1/services/airlock/README.md#in-a-cluster) is
the contract; what follows is why it has that shape.

### The networks

Three internal networks. `airlock` holds the airlock, its daprd and the database:
the airlock reaches the world only through its daprd (B7). `airlock-out` holds the daprd and
the bridges, which nothing else reaches. `airlock-wake` holds the airlock and the ticker
alone, so the ticker's wake reaches the airlock's health port and nothing of its daprd.
What goes out leaves on a network of its own:
`airlock-egress` for the daprd's bindings, `bridge-<name>-egress` for each bridge's server.
None of them stands on the default network, where every other service is (B10): a
service there that reached the daprd's bindings API, or a bridge's `/send`, would perform
an effect with no claim and no ledger row.

bayt declares no network, so the cluster publishes the declarations as `surface.networks`
and the consumer writes them into its compose model. Pronto writes `compose.networks.yaml`,
which the app's `bayt.json` lists in `compose.includes`, so every up closure includes it, and
which the root `compose.yaml` includes beside bayt's tree. The cost is bayt's overlay rule:
an app with effects gets the union of its targets' closures instead of the exact one. The
alternative is a target-level `networks` in bayt that a fragment declares at its top, which
compose merges across fragments; that is a bayt change, and until it lands mecha's own stack
places no airlock, since every app's compose includes mecha's fragments and those would name
networks the app does not declare. `tests/airlock_test.ts` therefore writes a bayt project
of its own for the run, a cluster with two effects, one through a bridge, has bayt generate
it, and boots its launch closure: bayt's Dockerfiles and fragments, and the
`compose.includes` file carrying the networks, are what it runs.

### The wake: the ticker's, re-armed by the interpreter

Inside a running cluster everything is reactive, and the airlock is no exception: its
worker hears an enqueue at the interpreter's commit (W2), and a retry follows Graphile's backoff,
whose future-dated jobs Graphile's own worker fetches on its poll. Where a cluster scales to
zero, the ticker is the platform's one wake. The interpreter that claims and enqueues also
re-arms a one-shot schedule row named `airlock` in the same commit (`due_at` in place of
`cron`, owed again when its watermark is cleared); the next sweep emits one tick into
`airlock_wake`, however many claims since the last, and GETs each of `WAKE_URLS`, the
airlock's `/healthz` among them (W3). So an effect enqueued on a cluster asleep is owed to
the next poke, not to whichever schedule happens next, and an effect places the ticker and
clock as a schedule does. The ticker writes its ticks through crud as `service`, the role
PostgREST switches to on the token's claim, so a cluster that wakes has crud verify the
service token and the program's roles step creates `service`, auth plane or not; the plane
itself (passkeys, `app_user`, policies) stays the app's choice. A transport credential such
as mTLS would name the peer and not the role, so it stands in for nothing here; where a
peer identity is wanted it is the tier's, beside the token. The airlock owns no wake of
its own.

The row is seeded by the airlock's initdb step, which carries the schedule table ahead of
its own text so that a caller's step at 013-019 writing an invoking row finds it. The
re-arm is an `UPDATE` of the row only where its watermark is set, through `FOR UPDATE SKIP
LOCKED`: claims never queue on the one row, a claim that finds it armed writes nothing, and
one that finds the ticker ticking it at that instant is woken by that tick. The interpreter
pins `TimeZone` and `DateStyle`, so a key built from a date's text is the same in every
session. `airlock_wake` is closed to the client roles as `schedule` is: a tick's instant
says when some tenant's row entered an invoking state. The airlock prunes ticks older
than a day.

- **A clock of the airlock's own, poking `runOnce`**: a second wake beside the platform's,
  with its own service and credential, and an effect started up to one interval after its
  commit, each retry waiting for the next poke as well. It was chosen while the airlock's
  wake was thought to be its own business; the ticker's one wake is what scales to zero.
- **Waiting for whatever schedule comes next**: no row of the airlock's, the cluster woken
  only by an app's own cadence, or never where it declares none. One row, re-armed by the
  interpreter, makes the wake owed to the enqueue.
- **The interpreter poking over HTTP** (`pg_net`): I/O inside the transaction, a poke even on
  rollback, and egress from the database.

### Graphile's schema at initdb

The interpreter calls `graphile_worker.add_job` inside the transition, and a held seed row in an
invoking state makes that transition at initdb, so the schema must exist before any process
could run Graphile's migrator. The one-shot migrate step cannot carry it: it exists only
where pgroll migrations are declared, its image has no Deno or Graphile, it runs after the
seed, and the replay check builds its database from the image's initdb steps alone.

So `graphile.sql` is an initdb step, written by `graphile_sql.ts` from the migration texts
of the graphile-worker `deno.lock` pins: Graphile's bootstrap, then every migration with its
`migrations` row. A regenerated file that differs fails `task test:airlock`. Graphile's own
migrate check then finds nothing to do (S1), and the schema equals what `runMigrations`
installs (S2). The airlock's migrate check at start is what carries an outlived volume across a
Graphile upgrade.

- **`pg_dump` of a migrated database**: needs a database at build time, couples to
  pg_dump's format, and pg_dump 18 writes a random `\restrict` key and install timestamps.
- **The airlock migrating before the readers start**: the seed runs before any reader.

`011_graphile_worker.sql` and `012_airlock.sql` take the first digits after the steps a
caller opens with: pronto's 000-010, whose last is the machines, and whose plpgsql interpreters
resolve add_job and the ledger only when they run. Every caller step that can write a row,
a raw step or a seed, is numbered above them, so a row written into an invoking state finds
both. A raw step on 011 or 012 is refused where an effect is declared, as two steps sharing
digits always are; the apps that hold those digits today declare no effect, and one that
does renumbers.

- **After every raw step, at 018 and 019**: a raw step at 011-017 writing an invoking row
  would call a interpreter whose ledger does not exist yet, and initdb would die on it. Nothing
  could refuse that without reading the step.
- **Refusing raw steps between the machines and 018**: the same order, bought by
  renumbering every app's 011-015 rather than two digits.
- **Before the machines**: no digit below 011 is free; pronto's derived steps and mecha's
  tenancy floor hold them all.

### The role: the owner

The airlock connects as the database's owner, not as `service`. `service` is `NOLOGIN`,
pronto creates it only when auth is on while an effect does not need auth, and it is
precisely the role that must not reach the ledger: it holds `BYPASSRLS` and every table in
`public` by default privileges, and `SERVICE_JWT` is the pipelines' and the ticker's. As
built, `airlock.sql` revoked only `anon`, `app_user` and `electric`, so anyone holding the
service token could PATCH an outcome through crud.

The ledger and the pool table live in an `airlock` schema that only the owner may use. A
revoke on the tables alone holds only against grants made before it: a caller step after it
running `GRANT … ON ALL TABLES IN SCHEMA public TO service`, the form pronto's own grants
take, would hand the ledger back. A grant over `public` names only `public`, and a role with
no USAGE on `airlock` reaches nothing in it whatever a table grants. `airlock.sql` also
revokes what default privileges gave the schema or its tables at creation (G7). mecha's
`rls_exempt` lives outside `public` for the same reason. Handlers hold no database handle,
and the interpreter is `SECURITY DEFINER`, so no client writer needs a grant. Graphile's migrate
check needs DDL on its schema to survive an upgrade, which only the owner has.

- **The ledger in `public`, every grantee revoked**: undone by the next schema-wide grant.
- **Refusing caller steps after the airlock's**: every seed is one.
- **A login role of the airlock's own**: stronger in depth, and the next hardening if the
  owner's privilege is judged too wide; it rewrites pronto's roles.
- **The owner connecting with `role=service`**: forgeable, and breaks Graphile's upgrade.

The trust this leaves is the one that existed before: mecha's own services connect as the
owner too, and whoever holds `PGRST_JWT_SECRET` can mint any role. "No writer forges an
outcome" means no program-authored path but the airlock's settle.

### The airlock's own reach

The airlock runs with `--allow-net` naming the database, its daprd and its health port.
Its reads are unscoped, because Graphile's config search stats every directory up to `/`.
A handler still runs in a worker with no permissions at all. At k8s and Cloud Run the
airlock shares a network namespace with daprd, so this flag is the whole wall on the
airlock's side there.

### Per tier

The wall travels with the daprd: its allowlist and its bindings are its configuration on
every tier, so compose, k8s and Cloud Run hold the same one.
[Tiers and clouds](https://github.com/bonisoft3/mecha/blob/v0.17.1/docs/deployment.md#the-airlocks-wake-and-wall)
holds the table. Crash recovery reads each process's own advisory key, so an overlap of two
revisions, or any number of instances, unlocks nothing a live process holds.

## Measured

`run.sh` in [`2026-10-03-external-effects/`](2026-10-03-external-effects/run.sh)
reproduces the D, G1-G6 and M rows against mecha's pinned Deno 2.9.7, the cluster's
postgres 18 image and its daprd 1.16.1. `peer` stands in for the sink: a row in it is a
call that happened. The B rows are steps of `task integrate:airlock` (daprd under the
bindings-only allowlist, a sink served from the test) and of `tests/airlock_test.ts`, which
boots the plane bayt lowers for a cluster with two effects, one through the mail bridge; G7,
S1-S2 and W2 are steps of the first, W1 of the second.

| | Experiment | Sink calls | Result |
|---|---|---|---|
| D1 | DBOS: one workflow id started twice | 1 | the id deduplicates |
| D2 | DBOS: crash inside a step, after the call | **2** | steps are at-least-once; no engine can commit atomically with a foreign system |
| D3 | DBOS: crash after a datasource transaction | 1 | exactly once inside DBOS's own postgres |
| D4 | DBOS: `dbos.enqueue_workflow` from a interpreter trigger | 1 | rollback enqueues nothing; commit enqueues once |
| D5 | DBOS: a finished workflow id enqueued again | — | still one row, `SUCCESS`, not rerun |
| G1 | Graphile: a `job_key` enqueued again after completion | **2** | a key deduplicates only while its job exists |
| G2 | the interpreter claims the ledger and enqueues in the transition's commit | 0 | rollback leaves no row and no job |
| G3 | the task settles through the interpreter | 1 | the outcome commits first, then the move through the interpreter; a crash between them re-delivers the move alone, and a row already moved is left |
| G4 | a client writes the outcome state itself | 0 | refused: the ledger holds no such outcome |
| G5 | crash after the call, its pool recorded against a key no session holds | **1** | the sweep unlocks the job, the re-entry reconciles |
| G6 | the job delivered again after completion | 1 | the task finds the outcome and only re-delivers it |
| M1 | daprd 1.16.1: invoke the declared `HTTPEndpoint` by name | 1 | reaches the sink; method, path, body and `Idempotency-Key` unchanged |
| M2 | daprd: invoke an undeclared endpoint name | 0 | refused, `ERR_DIRECT_INVOKE` |
| M3 | daprd: invoke an undeclared origin as a full URL | **1** | forwarded: the mesh is not the wall against undeclared traffic |
| G7 | `service` and default privileges, on tables and on schemas, granted before `airlock.sql`, and `GRANT ALL ON ALL TABLES IN SCHEMA public` after it | — | before the change, `service`, a default-privilege role and `PUBLIC` held the ledger; after, no grantee but the owner on the schema or its tables, and as `service` or the default-privilege role every read and update is refused (42501) |
| G8 | crash on the last attempt (`attempts: 1`), Graphile having counted the dead run | 0 more | the ledger's count runs out and settles `unknown`; with Graphile's count deciding, the unlocked job is never taken |
| G9 | a job locked by a pool whose recorded key a live session holds, through two sweeps; then that session ends | 0, then 1 | untouched while the process lives, unlocked and run once its connection ends |
| B1 | a call of the declared binding, a path, the ledger key and a body | 1 | arrives as `POST <path>`, the key as `Idempotency-Key`, the body intact; over https, trusting the binding's `MTLSRootCA` |
| B2 | invoke an undeclared origin as a full URL, with the bindings-only allowlist | 0 | 404: service invocation does not exist on the daprd |
| B4 | call a binding no one declared | 0 | refused |
| B5 | the state and metadata APIs | — | 404 |
| B6 | the sink answers 402, the binding declared with `errorIfNot2XX` off | 1 | daprd answers 200 with `Metadata.statuscode: 402`; the handler's `failed` |
| B7 | from the airlock, the sink by name and by address, and a bridge | 0 | unreachable; only its daprd answers |
| B8 | the plane booted with the daprd's `--config` removed | — | B2 fails in it, and nothing else does: the allowlist is what refuses |
| B9 | over gRPC, `InvokeService` to `https://example.com`, `GetMetadata`, `Shutdown`; with an HTTP-only list, then with the gRPC rule | — | with HTTP only, the page's HTML and the metadata came back; with the rule, UNIMPLEMENTED for each, `InvokeBinding` still served |
| B10 | from a container on the default network, the daprd's port and the bridge's | 0 | neither name resolves there |
| B11 | an effect declaring `credential: {scheme: Bearer, secret: VAULT_KEY}`, the sink recording its headers | 1 | `Authorization: Bearer <value>` arrives; the ledger's input and outcome hold no trace of the value; an effect without one sends no such header |
| R1 | the mail bridge against Mailpit | 1 | 200 with the key's `Message-ID` and the invite; 422 for a 5xx refusal and for a refused STARTTLS, nothing sent in the clear; 503 with no server; 403 for an inward server |
| S1 | Graphile's `runMigrations` after `graphile.sql` | — | `pg_dump -s -n graphile_worker` unchanged: nothing to migrate |
| S2 | `graphile.sql` against Graphile's own install | — | the same schema and the same `migrations` rows |
| W1 | commit into the invoking state to `settled`, nothing poking, in the plane bayt lowers | 1 | 155 ms; one call carrying `Idempotency-Key: probe:settles` |
| W3 | a claim in the plane, then two pokes of the ticker | 1, then 0 | the `airlock` row owed once; one `airlock_wake` row, the wake landing on the airlock's `/healthz`; the second poke emits nothing and wakes nothing |
| G10 | a job with `attempts = max_attempts` and no run, written with its claim | 0 calls | the sweep settles it `unknown`, `data.dead` the queue's last error, the machine in onError |
| W2 | `LISTEN "jobs:insert"`; a transition rolled back, then one committed | — | nothing heard before the commit, one notification after; the rolled-back one claimed and enqueued nothing |

## Rejected

- **DBOS as the airlock's runtime.** Its centre is the durable function, which is the
  alternative to the statechart. Around that centre it duplicates what pronto has or
  plans: schedules (the ticker), `sleep` (`after`), `send`/`recv` and streams (mecha
  events and change capture), migrations at launch (the baked image and pgroll), code
  patching (declaration versioning), and its own worker process (Graphile's, which the
  airlock already runs). What it would add — familiarity to models, Conductor's observability —
  pays off when authors write DBOS code, and pronto's authors write statecharts. D2 shows
  it does not close the call-to-checkpoint window either. **Revisit if** machines cannot
  express a saga's shape, such as fan-out with a join, or loops that carry data from step
  to step. Then
  workflow-as-code is the right escape hatch for cortex, as a library beside the machines.
- **Restate, Temporal, Inngest, Hatchet, Trigger.dev, Dapr Workflow.** The same pure
  half, plus a server or a sidecar. Restate's `ctx.run` is the cleanest
  recorded-side-effect primitive among them, and the one to study if the escape hatch
  above is ever opened.
- **Dapr's other building blocks.** Resiliency policies retry a call but keep no record
  that an attempt happened, so the airlock's daprd has none and bindings are its transport
  only. The outbox publishes atomically only with writes made through Dapr's state API,
  never with a PostgREST write or a trigger. The Jobs API is the ticker's job.
- **The CONNECT egress proxy** (built and removed): a Deno program tunnelling only to the
  declared origins, behind two internal networks, so the wall was a route that did not
  exist and it refused a declared name resolving inward. It existed because daprd's
  service invocation forwards a full URL anywhere (M3); the bindings-only allowlist removes
  invocation itself (B2), which leaves the proxy guarding a door that is gone.
- **A Caddy egress gateway, for now**: Caddy reverse-proxying a route per effect would see
  plain HTTP for logs, hold credentials and client certificates, and refuse what has no
  route. The bindings carry the credentials and certificates and daprd traces the calls,
  so what remains is hardening: a missing route instead of a missing API, and the inward
  refusal. It is the gateway the Open list keeps.
- **Mecha's change feed** (Conduit → Dapr → Redis Streams → Redpanda Connect). It is
  at-least-once already, but it retries forever with no dead letter, where an effect needs
  to end in an outcome. Its contract is delivery into an idempotent sink, and an external
  effect is precisely the case of a sink that may not be.
- **pg-boss.** Enqueue goes through its JS API rather than a published SQL function, so
  a trigger could not enqueue in the transition's commit without writing its private
  tables. **River** (Go) and **Oban** (Elixir) are the wrong runtime for mecha's Deno
  services. **pgmq** is a queue with no retry policy or worker.
- **The saga outbox as built**, the `saga` table plus `pg_notify` plus a poller. It is a
  second status column beside the queue's, and a notify that a scaled-to-zero worker never
  hears. It is removed.
- **Hand-rolling the queue**, the `stream_due` sweeper pointed at effects. Leases,
  backoff, wake-up and concurrency are where executors go wrong, and Graphile has done
  them. Pronto keeps only the ledger, because the ledger is what nothing else provides.

- **Graphile Worker Pro's crashed-worker recovery.** Exactly the liveness the advisory
  key gives, from the library's authors, but at USD 100 a month under a source-available
  license that forbids redistribution, which a published mecha cannot carry. **Revisit if**
  its recovery covers a case the key cannot, such as a process alive but wedged.
- **A stable replica name per process, its previous pool unlocked at start.** It needs a
  name no scale-to-zero tier gives, nothing enforces that two live processes never share
  one, and it unlocks only when the same name starts again.

## Open

- **A client certificate for a sink.** Dapr's HTTP binding takes `MTLSClientCert`,
  `MTLSClientKey` and `MTLSRootCA` as component metadata, which would have to be read from
  a secret store the airlock's daprd does not run. The grammar would be `credential` with a
  `certificate` kind; nothing declares one until an app needs it (ponto's eSocial).
- **Bridges beyond mail.** A Dapr binding of another type as a bridge needs only its
  declaration in `state.bridges` and a call shape for the handler; a bridge the program
  owns needs a declaration for its image and its server.

- **Invoking the other tiers.** Cortex's coordination reaches frontend handlers and
  their effects, DuckStream pipelines and their compute nodes as well. `invoke` with
  `onDone`/`onError` is the shape meant to carry all of them; the mecha interpreter is only its
  first host. A pure actor's outcome can be recomputed, so it needs no ledger claim; only
  an external effect does. Where a coordination's own state lives when it spans tiers is
  not decided.

- **A gateway behind the daprd.** Should the allowlist be judged too thin, a gateway the
  daprd's bindings go through makes the wall a missing route again and refuses a declared
  name that resolves inward: Caddy, from the same image as the door and a separate
  instance, since a door every service reaches cannot also be the one only the daprd
  reaches.
- **Networks in bayt.** A target-level `networks` that bayt declares at its fragment's
  top would replace the consumer's `compose.networks.yaml` and let mecha's own stack carry
  the airlock ([the networks](#the-networks)).
- **The hatch kinds.** The airlock is one; what they share, and how each declares and
  records what it lets through, is a later record.
- **The settle at cloud tier.** The airlock's settle is a direct write, which the bundled
  change-capture unit sees only at its next wake; a pipeline reading the settled row waits
  for the ticker's.
- **Guards on outcome arrows.** XState allows `onError: [{interpreter, target}, …]`. The
  first slice takes one target per arrow; a interpreter over `outcome` is the obvious extension.
- **`unknown` to a reader.** Still owed by the frontend, as rows, time and effects
  question 6 says.
- **The wake is all or nothing.** An effect brings the ticker and the clock with it,
  whatever the cluster's tier; a cluster that never scales to zero pays for a wake it
  never needs. A tier-aware placement is the obvious cut.
- **The row match by text.** The settle matches the row by `::text` of each key field,
  which a type whose text is not canonical could miss; the settle then refuses, loudly.

## Slices

One PR. These are its commits, in order, each green:

1. **The compiler** (built). `#ExternalEffect`, `invoke` and the refusals in
   `schema.cue`. The interpreter's claim, enqueue and outcome check in `emit.cue`.
   `#SagaEffect`, `#Saga` and `015_sagas.sql`
   removed, and level 4 renamed to `external`. `mecha-machine.test.ts` covers the emitted
   SQL and every refusal. `external-effects.integration.test.ts` runs the interpreter in
   postgres: rollback claims nothing, a forged outcome is refused, a performed key is never
   claimed twice, and the ledger is closed to the client roles.
2. **The airlock** (built). `libraries/mecha/services/airlock`, with the ledger moved into
   its `airlock.sql`. Pronto emits `services/airlock/effects.json`, one output binding per
   effect, and the handler as a source the writer checks is present, and refuses an
   effect invoked by other than one state. The handler runs in compute's realm,
   extracted for both cages to share. `task test:airlock` covers the re-entry table, the
   manifest, the cage and its door. `task integrate:airlock` runs postgres, Graphile, the
   cluster's daprd and a counting sink through every outcome and every post-crash
   ledger; it fails when a dead pool's jobs are not unlocked or a live one's are, when the
   ledger's count does not decide `unknown`, and when a re-entry issues where it should
   reconcile or give up.
3. **The cluster** (built). The airlock and its daprd placed only where a program
   declares an effect, with Graphile's schema and the ledger as initdb steps 011 and 012,
   and the ledger in a schema only its owner may use. `cluster_test.ts` covers placement
   and every refusal, `testdata/emit/effect.cue` pronto's wiring, and
   `tests/airlock_test.ts` the plane bayt lowers, end to end.
4. **Bridges, Crypto and the bindings wall** (built). `state.bridges` in pronto and the
   cluster, each placed as `bridge-<name>` with its server as its only reach, and mecha's
   mail bridge on nodemailer; `Crypto` in the realm and `secrets` as the handler's third
   argument; the airlock calling a Dapr output binding per effect, its daprd allowed the
   bindings API alone, in place of HTTPEndpoints and the CONNECT proxy.
   `mail_docker_test.ts` holds the bridge's answers against Mailpit, `crypto_test.ts`
   Crypto's against FIPS 180-2 and RFC 4231 and each refusal, and `tests/airlock_test.ts`
   sends a signed confirmation through the bridge and fails without the allowlist.
5. **The oracle app** (started). `apps/calcom`, a
   clone of Cal.com, the open-source Calendly, at brief stage. It is the first app graded
   against a live original: `apps/plausible` is graded by a second computation over its
   fixture, while this clone's every email, invite, webhook, reminder and offered slot is
   compared with what Cal.com v6.2.0 does for the same inputs. Its effects must leave the
   clone exactly once under the airlock's fault schedule, matching Cal.com's run with no
   faults. One host, one event type, the booking lifecycle with approval and its
   reminders; no teams, no round-robin, no calendar sync. The harnesses, the fidelity
   decisions they force (the invite's unstable `UID`, `METHOD:REQUEST` on cancel) and the
   slot oracle's disagreement classes are in its
   `apps/calcom/oracle/README.md`.
