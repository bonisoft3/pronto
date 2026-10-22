---
type: concept
title: Release targets
description: "Where a program is released: each target in meta.targets becomes a sayt release@<target> rule carrying the whole app on one tier of mecha's ladder; pages, cloudflare, and docker are built, and the clouds and k8s are designed."
---

# Release targets

A program names the places it is released to in `meta.targets`, and the
emitter projects each into a rule of sayt's `release` verb on the platform of
the same name, so the word in `program.cue` is the word after `@` in
`sayt release@<target>`. A release builds the immutable artifact the target
consumes, runs the version ceremony and makes the artifact live; each target
carries the whole app on one tier of mecha's ladder. `pages`, `cloudflare` and
`docker` are built, `cloudflare` for guests and without derivations, `docker` as
a single-container standalone appliance. `gcp`, `aws`, `azure` and `k8s` are
designed and [not built](../PENDING.md#release-targets). How an author releases an app is
[the guide's](../GUIDE.md#release).

## Targets, platforms and tiers

- A sayt **platform** is where a verb generates its effects, the string after
  `@`. `release` and `verify` default to `preview`.
- A pronto **target** is a place a program is released to and verified
  against: `#Target` in `schema.cue`, which admits `pages`, `cloudflare`,
  `docker`, `gcp` and `aws`, and not `azure` or `k8s`.
- A mecha **tier** is what the cluster is made of there. The ladder is
  mecha's: browser, CLI, single machine, k8s, cloud and edge
  ([invariant 4](https://github.com/bonisoft3/mecha/blob/v0.14.0/README.md#4-vertical-scalability-down-and-up)).
  pronto's `#Tier` names five of its rungs — `browser`, `edge`, `container`,
  which is mecha's single machine, `k8s`, and `cloud` — and the browser, the
  edge, and the container are built. `container` is where every app develops,
  and for release it is the `docker` target: the SQL fence `-- tier:
  container` … `-- tier: any` around the publication and the replica identity,
  the statements that need a WAL reader
  ([the fence](https://github.com/bonisoft3/mecha/blob/v0.14.0/docs/browser.md#the-fence)).

| target | tier | the artifact | the door |
|---|---|---|---|
| `pages` | browser | one HTML file | none: the page's fetch shim |
| `cloudflare` | edge | a Worker, one Durable Object running PGlite, and the data directory it loads | the Worker |
| `docker` | container | single-container appliance image running postgres, crud, caddy, auth, and process-compose | caddy on port 8080 |
| `gcp`, `aws`, `azure` | cloud | versioned images and the list naming them | caddy on the cloud's compute |
| `k8s` | k8s | skaffold's manifests | caddy in the named cluster |

## What a release is

A release rule is three steps the loop contract
([`loop.cue`](https://github.com/bonisoft3/sayt/blob/v0.44.2/loop.cue)) projects from one `release` verb: the
target's `cmds` build the artifact; `release.nu` runs the ceremony — the
git-cliff bump under the app's tag prefix, the `VERSION` gate, the tag, and
goreleaser as a shim with builds and the GitHub release off; `publish` makes
the artifact live, and `--snapshot` skips it. sayt hands a rule its flags as
environment (`SAY_RELEASE_ARGS_SNAPSHOT`, `SAY_RELEASE_ARGS_BASE`), because a
flag is only a flag to nushell when it is spelled in the call. Deploying is
never a verb of its own: for `pages` the gesture is the tag push.

Any target other than `pages` and `cloudflare` where an unsuspended schedule must fire names its clock in
`meta.clocks`, or the emitter refuses it (`_clockDeclared`): that clock lives
in a deploy tree mecha does not write, and without the declaration a schedule
nothing wakes fails silently. Compose runs the cluster's own clock, and the
cloudflare release writes its own ([below](#cloudflare)).

**`verify@<target>` adds no checks.** The integrate drivers that measure a
running app read `APP_URL` ([`base-url.ts`](https://github.com/bonisoft3/omnishell/blob/v0.14.0/base-url.ts)), so
each becomes a `verify` rule per target with `APP_URL` bound to that target's
door and no compose prepend. Two things come first. The base: a driver that
navigates to `${origin}/ar` (`apps/truco/tests/acceptance.ts`) cannot reach a
site under a subpath, and an `APP_URL` ending in a slash yields `//`, which the
router refuses. And the budgets, whose 20 s are tuned to a warm local stack
that a cold page boot exceeds. The projection is
[not emitted](../PENDING.md#release-targets).

## A release is its entry

Every target serves the files a page runs or fetches at their content
addresses, `_immutable-<sha256>-<name>` beside each file, and every document
that boots the terminal — the entry, a prerendered document, one rendered on
request — carries the map from logical path to address as its import map,
`#pronto-assets` (omnishell's [`release-addresses.ts`](https://github.com/bonisoft3/omnishell/blob/v0.14.0/server/release-addresses.ts)).
A page therefore runs one release, and an open one takes the next at the
level its changes allow ([screen updates](https://github.com/bonisoft3/omnishell/blob/v0.14.0/docs/screen-updates.md#when-a-deployment-lands)).
An address never changes and is served `immutable`; the map is an inline
script, so the door's policy names its hash.

The container door builds its tree as a release in a stage of its own, the
`served` target (`#DefaultCluster`): omnishell's tree, from the workspace or
an installed app's runtime image, and every static the door serves, each at its
URL's path, addressed in place (`omnishell.#Address`). The door copies that
tree and the scripts its documents run, which its `script-src` names as
`$PRONTO_RELEASE_SCRIPTS`; the renderer takes the entry from it. An edit under
`launch --watch` rebuilds the door, so the development loop takes a deployment
as a reader's tab does.

## pages

`sayt release@pages` runs [`bundle.ts`](../bundle/bundle.ts), which writes
`dist/browser/index.html`: the interpreter and mecha's browser cluster as one
`deno bundle` module written inline, the files `shell.json` serves in a base64
table, SES installed through the interpreter's Trusted Types policy, and, for
an app with migrations, `rls.sql`, the
migrations and PGlite's wasm and data as base64 of gzip, inflated at boot.
Every PGlite bundle also embeds the full ICU data archive and loads it before
applying migrations, so declared collations retain case and accent semantics
offline. ICU and PGlite versions are pinned together in the browser runtime;
this is part of the database contract and requires no application setting. The
page's fetch shim serves the table by path and hands `/crud`, `/auth` and
`/electric` to [the one-user cluster](https://github.com/bonisoft3/mecha/blob/v0.14.0/docs/browser.md#the-one-user-cluster),
which mints its user at boot, so the tenancy floor runs against a real subject
and there is no door. A program begins as one HTML file, `ir.html`, and ships
as one.

What the bundler holds to:

- **The served set is `shell.json`'s**: what its routes name, the catalogues
  its locales name, and the shell's three files. `.pronto/manifest.json` is the
  writer's record of what it emitted and lacks a shared stylesheet an author
  wrote.
- **An `@import` is inlined** into the sheet that asks for it, because the
  browser fetches it past the shim; one naming a file outside the served set
  fails the bundle.
- **Inline script data cannot carry `<!--` or `</script`**, and SES and screens
  contain both, so the data rides as base64 and the module has both sequences
  escaped. The document's CSP authorizes the exact module bytes with a SHA-256
  hash. The module is inline so that `import.meta.url` is the page's own
  URL, which PGlite's relative asset URLs resolve against.
- **A publication or replica identity outside a container fence fails the
  bundle**, read by mecha's own fence grammar.
- **`--base` mounts the page under a path prefix**, as a GitHub Pages project
  site needs: the shell takes the prefix off every address it matches and puts
  it on every address it composes, and the document is also written as
  `404.html`, which is how a deep link boots. `file://` is not a host, since
  the router is `pushState` on the path.

**The deploy.** The rule's `publish` pushes the tag. It reaches the app's
public mirror, whose emitted `cd.yml` runs
`sayt release@pages --snapshot --base=/<repo>` and deploys the file to a
project site. A private repository on a free plan has no Pages, so
the site lives on the mirror. An app at the root of its own public repository
tags `vX.Y.Z`, and the same workflow deploys it without a mirror.

**An installed app's mirror** is the app as its own repository, at its root
and without `mise.local.toml`, the file that points a checkout's copy at the
runtime's sibling trees, so the mirror runs the pronto, omnishell, mecha, bayt
and sayt releases its `.mise.toml` pins. It is published only once, with those
pins, `setup`, `build`, `lint` and `integrate` pass on the synced tree.
Nothing holds the mirror to what a checkout would regenerate. An app need not
be in sync with the framework, which is what anyone bumping one runtime piece
on its own meets; a change that needs an unreleased framework change holds the
mirror back until that release is pinned, rather than failing the pull request
that made it, as a check of every pull request against the pins would.

**The refusals.** `emit.cue` refuses the target, a `cue vet` error rather than
a broken release, for a program with:

- a vendored unit, a worker the browser fetches past the document's shim;
- a shared entity, since one user shares with nobody and the client opens a
  keyed shape per grant, which the page's cluster does not serve;
- a validation, which runs in plv8, and PGlite has none.

A schedule is skipped rather than refused. Its tick wakes only streams, and
the page runs none, so the page holds the same derived rows with or without
one; the target asks for no clock, and the schedule's seed, which writes the
container database image's `schedule` table, is container-tier.

**The derived rows ship as the release found them.** The page runs no stream
and no computation, so for a program that declares either the rule first runs
[`derived.ts`](../bundle/derived.ts): it brings the app's container cluster up
under a compose project of its own from the launch target's closure, which
publishes no port, so a running launch keeps the door's, waits until it has
settled, writes every
live table — the tables a stream or a computation writes without feeding the
publication — to `dist/derived.sql`, and tears the cluster down. The bundler
takes that file with `--derived` and the page runs it after the migrations,
each table emptied and refilled whole, so a seeded row the derivation no longer
produces is gone. Restoration is atomic and temporarily suspends user triggers
on the restored tables, preventing derived rows from being computed again.
Foreign-key checks remain active; original trigger modes are restored. The file is a release artifact, rebuilt at every release and
never committed. A write in the page recounts nothing: the archive the page
holds is read-mostly, and its derived tables answer the rows it was bundled
with ([pending](../PENDING.md#release-targets)).

Settlement requires unchanged committed table contents, started stream inputs,
drained bus groups, completed pipeline work, and at least one completed run of
each computation. Successful no-op polls do not restart the quiet window;
changed rows or failure counters do. Repeated failures prevent settlement. The
window outlasts the slowest computation's cadence plus a 15-second margin,
allowing it to inspect stable inputs. Golaberto's ratings look every 300 seconds,
so its quiet window is 315 seconds.

Pipeline completion is checked at each original input, before any split or
filter changes its batch size. Input processor counters or a declared
single-message generator establish comparable acknowledgment counts; inputs
bound to the app's Redis use its pending and delivery state. Buffers must also
drain. Inputs without observable completion are refused.

The exported tables and their content fingerprint share one database snapshot.
A subsequent state check must still agree before the file is written. Row JSON
stays text through the exporter so bigint and numeric values retain their
precision. Computation logs establish that each computation has completed once,
but do not expose whether a later run is currently in progress.

The rule needs what `sayt launch` needs — Docker and the app's compose, whose
images build from the trees the compose names — on the machine that releases,
the mirror's workflow runner included. An app with no stream and no computation
releases without it.

The page serves no blob, and nothing refuses a program that declares one
([pending](../PENDING.md#release-targets)): `_pagesBundle` does not read
`capabilities.blobs`, and the shim routes only `/crud`, `/auth` and
`/electric`. A duckstream is neither a stream nor a computation, so xpense
targets `pages`, declares `recount-months` and `recount-buckets`, and nothing
in the page fills `MonthStat` or `CategoryMonthStat`.

## cloudflare

`sayt release@cloudflare` runs [`edge.ts`](../bundle/edge.ts), which writes
`dist/cloudflare/`. The terminal modules and declared public files live in
`public/`, so each route loads only its own screen and required catalogues.
The terminal asks the Worker's origin for `/crud`, `/auth` and `/electric`.

The public tree is addressed as every target's is ([a release is its
entry](#a-release-is-its-entry)); Cloudflare's assets take its immutable rules
from `_headers`, answer `/` from a copy of the entry, and are given addressed
templates as `.txt`, since they answer `.html` by rules of their own.

The build computes the native modules' transitive static import closure and
places its modulepreloads after the import map. Response `Link` headers preload
styles, configuration, the requested screen's files, and the resolved locale's
catalogue. Modulepreloads in headers could resolve imports before the map;
ordinary `as=script` preloads promote the whole module graph ahead of first
paint. In-app navigation uses the same map for its screen preloads and fetches.
Cloudflare can turn eligible `Link` headers into HTTP 103 when the zone's
[Early Hints setting](https://developers.cloudflare.com/workers/examples/103-early-hints/)
is enabled. Emitting those headers does not establish that 103 is enabled on
the deployed hostname; verify the interim response on the wire.

For a subsequent deployment, preserve the previous `public/` outside the new
output tree and pass `edge.ts --assets-from <previous-public-dir>`. The build
verifies and retains its immutable files, including earlier retained releases,
so an open tab can still enter a screen it has not downloaded. It does not copy
the old entry, canonical files, or cache rules. A fresh build without that
input contains only the current release's URLs.

For native M-SSR, declare `code.meta.ssrOrigin: "https://<public-host>"` so the
generated release recipe passes `edge.ts --ssr-origin https://<public-host>`.
By default,
the entry keeps its existing `Cluster` namespace and persisted filesystem format,
so enabling SSR does not replace live data. The builder also writes
`renderer.jsonc`; `publish-edge.ts` deploys that renderer before updating the
entry and its database class. Publishing leaves a complete directory intact.
Keep the existing `.jwt-secret` beside the release directory to preserve sessions.

A new deployment can opt into `--ssr-database separate`: it writes
`database.jsonc` for `<app>-database` with compressed 128 KiB filesystem blocks,
and deploys renderer, database, then entry. That namespace starts empty; this
option is not an in-place migration of an existing app. The resumable import
verifies checksums and uses gzip transport. Do not switch database modes on a
live deployment without migrating its current data and controlling the cutover.

Both modes keep the renderer in a separate isolate. Renderer Worker names include
a digest of the origin, sources and assets, so an old entry continues to use its
matching renderer during an upgrade. Retain previous immutable assets with
`--assets-from`; old renderer Workers can be removed after their entry versions
are no longer serving or needed for rollback.

Every navigation renders under public RLS from a fresh database transaction,
without guest login. No HTML cache can bypass that transaction. Language
negotiation matches the browser, and the response varies on `Accept-Language`.
See [omnishell/docs/native-worker-ssr](https://github.com/bonisoft3/omnishell/blob/v0.14.0/docs/native-worker-ssr.md) for the freshness and isolation
contract. Authentication and derivation support remain the edge target's.

The integrated deployment has been exercised on Paid; Free enforcement,
including the documented per-object storage limit discrepancy, requires
verification on a Free account before claiming a free deployment.

The release also contains PGlite for workerd in `pglite/`, baked from mecha's pinned sources
([pglite-workerd](https://github.com/bonisoft3/mecha/blob/v0.14.0/packages/pglite-workerd/README.md));
the data directory in `pgdata/`; and a Worker in `src/index.ts` exporting
[mecha's edge cluster](https://github.com/bonisoft3/mecha/blob/v0.14.0/packages/mecha-edge/README.md)
as its one Durable Object, over the shell's tables. `publish` runs
[`publish-edge.ts`](../bundle/publish-edge.ts): `wrangler deploy` at the
version pglite-workerd's `mise.toml` pins, with `JWT_SECRET` (once) and a new
`IMPORT_TOKEN` in the same version, then the data directory loaded into the
object. The target keeps the compose stack's shape, one Cloudflare piece per
service, and nothing runs while no one uses the app:

| compose service | at the edge | sleeps | |
|---|---|---|---|
| caddy | the Worker: static files, `/crud`, `/auth`, `/electric`, settled reads from the Cache API | per request | built |
| database, crud, electric, auth | one Durable Object running mecha's edge cluster on PGlite, its data directory in the object's SQLite | when idle | built, guests only |
| conduit, mesh-events | an outbox table and a Cloudflare Queue | — | designed |
| transform, compute | a Container each, from the images bayt builds | after an idle timeout | designed |
| ticker, clock | the object's alarm, and a Cron Trigger poking it | between occurrences | built |
| render | none: the page renders, as `pages` does | — | built |

```
browser ──/crud──▶ Worker ──▶ object (PGlite) ── commit: triggers write the outbox
   ▲                 │ Cache API                    │
   │                 ▼                 Queue ◀── outbox, after commit
   │                                     │
   │                            consumer Worker ──HTTP──▶ transform ──/invalidate──▶ compute (tables on R2)
   │                                                          └──── batched writes back through /crud ────┘
   └──── object ──held-open shape requests──▶ every open tab
```

What fixes its shape, as built:

- **An isolate has no fork, threads or sockets, and 128 MB.** PGlite runs
  there; Postgres needs all four. Its data directory lives page by page in the
  object's SQLite, read when Postgres asks for it, so the database is bounded
  by the object's storage, not its memory. Stock PGlite does not load in
  workerd — it misdetects its environment, asks for 128 MiB at instantiation,
  compiles WebAssembly at runtime for plpgsql and its callbacks, and re-arms an
  idle timer every 10 s that keeps the object awake — so the target ships a
  PGlite built without those, with ICU's root collation set.
- **The data directory is built off the object**, since `initdb` cannot run
  in it: [`pgdata.ts`](../bundle/pgdata.ts) applies `rls.sql`, the
  migrations and, for a program with streams or computations, the rows
  `derived.ts` wrote (as for `pages`) with npm's PGlite, the same Postgres the
  object runs. Where the program declares schedules it also applies mecha's
  `schedule` table, the container image's 800 step, and takes the 801 seed
  whole — fenced container-tier for the page, which runs no clock, where
  the object runs one. `--from=<dir>` starts it from a directory built elsewhere
  instead, an archive restored from its database with its pgroll ledger
  ([`restore.ts`](https://github.com/bonisoft3/mecha/blob/v0.14.0/packages/pglite-workerd/restore.ts)),
  applies the cluster's pgroll migrations the ledger lacks, as its migrate step
  would ([`migrate.ts`](https://github.com/bonisoft3/mecha/blob/v0.14.0/packages/pglite-workerd/migrate.ts)),
  and skips the derivation.
- **Loading is once.** The object opens only a directory whose load verified
  every chunk; a load resumes where it stopped and leaves a complete
  directory alone, so a later release changes the Worker and the page and
  never the data, unless `--reset` replaces it.
- **One object, every user behind one writer.** PGlite is one connection.
  [`createRestHandler`](https://github.com/bonisoft3/mecha/blob/v0.14.0/packages/postgrest-js/src/rest-handler.ts)
  opens each request with a transaction-local role, `app.scopes` and
  `request.jwt.claims`, so a shared connection never leaks a subject, and row
  policy is Postgres's own here as on a single machine. Guests only:
  `/auth/guest` mints the credentials; passkeys and providers wait for mecha's
  auth service to run in the Worker.
- **Sync holds requests open.** A tab's live shape request waits on the
  object, which keeps the object awake while a tab is open; that is the price
  of the simplest path, and a poke on a hibernating WebSocket is the cheaper
  later step. The shape log lives in the isolate, so a new object sends every
  client back to a snapshot.
- **Settled reads are the colo's.** A shape response that is not live is a
  prefix of its log, so the Worker answers it again from the Cache API, keyed
  by the object's epoch; a public table's chunks are every guest's.
- **The derived rows ship as the release found them**: no stream or
  computation runs at the edge yet.
- **The clock is two, and sleeps.** The object's alarm stands at the next
  instant any schedule owes a runnable tick and sweeps as mecha's ticker
  does; a Cron Trigger (`triggers.crons`, written where the program declares
  an unsuspended cron schedule or a machine that arms a deadline, and the
  clock is not disabled) pokes the object hourly from outside it, re-arming
  an alarm the platform dropped and recording the occurrences a lost span
  left behind; a publish pokes once.
  Each wake of the object is a request and a boot, so the alarm, not the
  trigger, is the resolution: an app with a daily schedule idles inside the
  Free plan's day (100,000 requests, 13,000 GB-s of object duration, five Cron
  Triggers an account), where a minutely trigger would hold the object awake
  for a fifth of it. A drain's tick is a row nothing reads here until the
  outbox exists.

As designed and [not built](../PENDING.md#release-targets):

- **The change path is an outbox.** There is no WAL reader in the object, so
  the statements fenced `-- tier: container` stay skipped and the triggers
  that fill the outbox run instead; the object sends the outbox to the Queue
  after each commit. A Queue delivers at least once, unordered, with retries,
  backoff and a dead-letter queue of its own, so every stream must be an
  idempotent keyed upsert. A long write holds every read behind it, so
  derivations write back in batches of hundreds of rows, and the object
  checkpoints after a burst, since every wake replays what the WAL holds.
- **The containers are the stack's own images, scaled to zero.** transform and
  compute run what `./saytw launch` runs, with the Worker in place of
  `crud:3000` and `compute:9997` and the service token as today. A batch from
  the Queue wakes transform; its `/invalidate` wakes compute. Their disks are
  ephemeral, so compute keeps its tables as Parquet on R2 and a cold start
  reads only what it needs. The container classes are generated from the
  compose closure bayt emits, so a service added to the app is a container
  added to the release.
- **Cost follows use.** Workers Paid at $5 a month, Containers billed for the
  memory and disk they hold while awake and the CPU they spend, R2 inside its
  free tier: about $5–10 a month for an idle app.

Measured with GolAberto's full archive deployed (2026-10-10, 11): 7.1 GB in
the object's SQLite, loaded at 10.2 MiB/s and verified in the object in 70 s;
a guest's first request reaching an evicted object in about 2 s, a warm one in
0.25 s; object CPU per request 1–3 ms at the median, under 0.8 s at the
largest; no memory or CPU kill.

Derivation stays in containers until DuckStream runs. Work that is
incremental by construction — a stream's mapping, a join or window kept up to
date — needs memory proportional to a change, not to the data, so it fits an
object with its state as indexed tables in the object's SQLite, on the free
plan too. That is [DuckStream](decisions/2026-09-29-hybrid-machines.md): the
SQL parsed at build time as `check-sql.ts` already parses it, lowered to a plan
an object runs. It is built only together with the Feldera-backed engine that
runs the same SQL locally, so an edge-only engine never becomes the reference.
Batch work over the whole history — ratings refit over years — stays in a
container on any tier.

An app's machines step in the object: the migration declares each step over
an engine the tier supplies, and the object's is PGlite for workerd's host
import, handed the machines `edge.ts` renders from the app's rules
([the edge cluster](https://github.com/bonisoft3/mecha/blob/v0.14.0/packages/mecha-edge/README.md#machines)).
A deadline a machine arms and a cron schedule the program declares are the
object's alarm, swept as the ticker sweeps them
([the clock](https://github.com/bonisoft3/mecha/blob/v0.14.0/packages/mecha-edge/README.md#the-clock)).
For a frozen archive, `code.meta.edgeClock: "disabled"` emits `--clock disabled`:
the object preserves schedule rows, clears alarms at boot and delivery, and no
Cron Trigger is written. The default, `"ticker"`, runs them.

## docker

`sayt release@docker` packages the container tier into a single-container
appliance image running under process-compose: PostgreSQL 18, PostgREST (`crud`),
Caddy as reverse proxy and static asset server, and, when `capabilities.auth` is
configured, Deno running the app's `auth` service.

What fixes its shape:

- **Single self-contained image.** The appliance inherits OpenSUSE Tumbleweed,
  PostgreSQL 18 with ICU collations (`--locale-provider=icu --icu-locale=und`),
  `setpriv`, PostgREST, Caddy and `process-compose`. When `capabilities.auth` is
  enabled, the Deno binary and cached `/deno-dir` are copied into the image and
  run alongside the other services.
- **Loopback networking.** Internal services communicate over loopback.
  `appliance-entrypoint.sh` appends `127.0.0.1 crud database auth` to
  `/etc/hosts` before launching `process-compose`, so internal HTTP and database
  references resolve without external DNS service discovery.
- **Idempotent schema upgrades on existing volumes.** `docker-entrypoint.sh`
  initializes fresh `PGDATA` databases or inspects existing volumes. A dedicated
  ledger table, `_pronto_migrations`, records applied migration scripts. On a
  volume mounted from an earlier release, pending migrations run in order while
  seed scripts are skipped.
- **Startup isolation.** `pg_ctl` runs with `listen_addresses=''` during initial
  setup and migration runs, ensuring Postgres is only reachable over its Unix
  domain socket until all migrations finish. External clients and readiness
  probes see Postgres only once the final `postgres` daemon binds network
  interfaces.
- **Electric shape fallback.** For apps using Electric sync, Caddy intercepts
  `/electric/*` requests and responds with a static up-to-date control shape
  (`[{"headers":{"control":"up-to-date"}}]` with `electric-offset: 0_0` and
  `electric-up-to-date: true`). Browser sync engines settle cleanly in
  standalone mode without requiring a full live replication cluster.
- **Image tagging and publication.** Distribution tasks derive the OCI image tag
  by stripping any path prefix from a prefixed release tag (`$tag | path basename`),
  defaulting publication to `ghcr.io/bonisoft3/<app>:<tag>` or the registry
  configured via `${BAYT_DOCKER_REPOSITORY}` and `${BAYT_IMAGE_TAG}`.

## The clouds and k8s

A cloud target carries users, so its floor is dollars a month rather than
requests a day, and it is tuned for low cost and for scaling with no hand on
it. Each service of the compose stack becomes the cloud's managed equivalent
running the images bayt builds, declared as Kubernetes resources that the
cloud's own controller reconciles:

| target | controller | compute | database |
|---|---|---|---|
| `gcp` | Config Connector | Cloud Run | Cloud SQL |
| `aws` | ACK | ECS Express Mode on Fargate | Aurora Serverless v2, from 0.5 ACU |
| `azure` | Azure Service Operator v2 | Container Apps | Flexible Server, B1ms |
| `k8s` | skaffold, against a named kube context | mecha's images, scaled from zero by KEDA | CloudNativePG |

The compute scales by itself; the floor is the database, and AWS's is the
highest, since Aurora does not pause while logical replication is on. Project,
account, region and domain are declarations on the cluster; credentials are
each cloud's own and never in the session. Region is the first of the axes a
system shards along, before time and user. mecha's
[clouds as built](https://github.com/bonisoft3/mecha/blob/v0.14.0/docs/deployment.md#clouds-as-built)
is the mapping these start from.

A sign-in provider (`auth.providers`) is registered with the provider, told
the callback `<origin>/auth/oidc/<name>/callback`, which hands back a client
id. The program may give it, with the issuer and the rest, as
`auth.provider.<name>`: the auth service's defaults, which every target's
compose renders without an environment, a visual check's nested one included.
The deployment overrides each as `OIDC_<NAME>_<SETTING>`, and gives what the
program must not hold, Google's client secret as `OIDC_GOOGLE_CLIENT_SECRET`.
Another OpenID issuer may stand in the provider's place, such as a broker an
operator runs, by its issuer and the client `origin`
(mecha's [provider sign-in](https://github.com/bonisoft3/mecha/blob/v0.14.0/services/auth/README.md#provider-sign-in)).
Compose refuses to render the stack when neither gives a client id, and the
k8s release copies the public `OIDC_*` settings onto the auth service. Nonempty
client secrets go to a separate Kubernetes Secret through stdin; the Deployment
holds only Secret references and a digest that rolls auth when secrets change.
Client secret values never enter the rendered workload manifests or temporary
release metadata.

## Rejected

- **App Runner as AWS's door** — it has been closed to new customers since
  2026-04-30.
- **Crossplane for a single-cloud target** — each cloud's own controller is
  the vendor's reading of its own API, with no provider family to pin beside
  it.
- **A multicloud target on Crossplane** — deferred until partitioning and
  disaster recovery are solved: with one writer in one region, a second cloud
  is a second bill and not a second chance.
- **Neon as `gcp`'s database** — its regions are another cloud's, so every
  query would cross between clouds.
- **Postgres at the edge** — it needs fork, threads and sockets, which an
  isolate lacks; PGlite is Postgres without them, built for workerd.
- **Docker in one container running `./saytw launch`** — Containers run
  Docker without privilege or iptables, so compose's network is crippled, the
  disk is ephemeral so every wake re-pulls the stack, and the stack's own
  Postgres, Electric and Caddy would stand beside the object that already is
  them.
- **Containers kept awake** — about $30 a month for one that does nothing most
  of the day; scaling to zero with state on R2 costs a cold start instead.
- **DuckDB-wasm as compute in an object** — measured: it gives compute's
  answers exactly, but needs about 65 MiB before its first query, a single
  chances group peaks near 172 MiB, ratings over one year near 270 MiB, and
  with no disk to spill to its memory limit only turns that into failures.
- **Splitting the archive by age** across a live object and a read-only one —
  the whole archive fits one object's storage, and reads that span seasons
  would merge two sources.
- **Row policy compiled into the object's SQLite** — enforcement in the
  request path's own code turns a bug there into a breach, where Postgres's
  policies make it an outage.
- **Electric's sync service at the edge, or Electric Cloud** — the BEAM does
  not run in an isolate, and Electric Cloud has wound down; the object answers
  Electric's shape protocol itself, and nothing in omnishell changes.
- **A service worker in the page** — registration from a `blob:` URL is
  forbidden, and one document has nothing to precache.
