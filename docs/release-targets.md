---
type: concept
title: Release targets
description: "Where a program is released: each target in meta.targets becomes a sayt release@<target> rule carrying the whole app on one tier of mecha's ladder; pages is built, and cloudflare, the clouds and k8s are designed."
---

# Release targets

A program names the places it is released to in `meta.targets`, and the
emitter projects each into a rule of sayt's `release` verb on the platform of
the same name, so the word in `program.cue` is the word after `@` in
`sayt release@<target>`. A release builds the immutable artifact the target
consumes, runs the version ceremony and makes the artifact live; each target
carries the whole app on one tier of mecha's ladder. `pages` is built.
`cloudflare`, `gcp`, `aws`, `azure` and `k8s` are designed and
[not built](../PENDING.md#release-targets). How an author releases an app is
[the guide's](../GUIDE.md#release).

## Targets, platforms and tiers

- A sayt **platform** is where a verb generates its effects, the string after
  `@`. `release` and `verify` default to `preview`.
- A pronto **target** is a place a program is released to and verified
  against: `#Target` in `schema.cue`, which admits `pages`, `cloudflare`,
  `gcp` and `aws`, and not `azure` or `k8s`.
- A mecha **tier** is what the cluster is made of there. The ladder is
  mecha's: browser, CLI, single machine, k8s, cloud and edge
  ([invariant 4](../../../libraries/mecha/README.md#4-vertical-scalability-down-and-up)).
  pronto's `#Tier` names four of its rungs — `browser`, `edge`, `container`,
  which is mecha's single machine, and `cloud` — and the browser and the
  container are built. `container` is where every app develops and is no
  target, and it is the one word the emitter reads: the SQL fence `-- tier:
  container` … `-- tier: any` around the publication and the replica identity,
  the statements that need a WAL reader
  ([the fence](../../../libraries/mecha/docs/browser.md#the-fence)).

| target | tier | the artifact | the door |
|---|---|---|---|
| `pages` | browser | one HTML file | none: the page's fetch shim |
| `cloudflare` | edge | a Worker and one Durable Object, the pages file its asset | the object |
| `gcp`, `aws`, `azure` | cloud | versioned images and the list naming them | caddy on the cloud's compute |
| `k8s` | k8s | skaffold's manifests | caddy in the named cluster |

## What a release is

A release rule is three steps the loop contract
([`loop.cue`](../../sayt/loop.cue)) projects from one `release` verb: the
target's `cmds` build the artifact; `release.nu` runs the ceremony — the
git-cliff bump under the app's tag prefix, the `VERSION` gate, the tag, and
goreleaser as a shim with builds and the GitHub release off; `publish` makes
the artifact live, and `--snapshot` skips it. sayt hands a rule its flags as
environment (`SAY_RELEASE_ARGS_SNAPSHOT`, `SAY_RELEASE_ARGS_BASE`), because a
flag is only a flag to nushell when it is spelled in the call. Deploying is
never a verb of its own: for `pages` the gesture is the tag push.

Any target where an unsuspended schedule must fire names its clock in
`meta.clocks`, or the emitter refuses it (`_clockDeclared`): that clock lives
in a deploy tree mecha does not write, and without the declaration a schedule
nothing wakes fails silently. Compose runs the cluster's own clock.

**`verify@<target>` adds no checks.** The integrate drivers that measure a
running app read `APP_URL` ([`base-url.ts`](../../omnishell/base-url.ts)), so
each becomes a `verify` rule per target with `APP_URL` bound to that target's
door and no compose prepend. Two things come first. The base: a driver that
navigates to `${origin}/ar` (`apps/truco/tests/acceptance.ts`) cannot reach a
site under a subpath, and an `APP_URL` ending in a slash yields `//`, which the
router refuses. And the budgets, whose 20 s are tuned to a warm local stack
that a cold page boot exceeds. The projection is
[not emitted](../PENDING.md#release-targets).

## pages

`sayt release@pages` runs [`bundle.ts`](../bundle/bundle.ts), which writes
`dist/browser/index.html`: the interpreter and mecha's browser cluster as one
`deno bundle` module written inline, the files `shell.json` serves in a base64
table, SES from a `data:` URL, and, for an app with migrations, `rls.sql`, the
migrations and PGlite's wasm and data as base64 of gzip, inflated at boot. The
page's fetch shim serves the table by path and hands `/crud`, `/auth` and
`/electric` to [the one-user cluster](../../../libraries/mecha/docs/browser.md#the-one-user-cluster),
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
  escaped. The module is inline so that `import.meta.url` is the page's own
  URL, which PGlite's relative asset URLs resolve against.
- **A publication or replica identity outside a container fence fails the
  bundle**, read by mecha's own fence grammar.
- **`--base` mounts the page under a path prefix**, as a GitHub Pages project
  site needs: the shell takes the prefix off every address it matches and puts
  it on every address it composes, and the document is also written as
  `404.html`, which is how a deep link boots. `file://` is not a host, since
  the router is `pushState` on the path.

**The deploy.** The rule's `publish` pushes the tag. The monorepo's `cd.yml`
propagates it to the app's public mirror, fed by copybara, whose own emitted
`cd.yml` runs `sayt release@pages --snapshot --base=/<repo>` and deploys the
file to a project site. A private repository on a free plan has no Pages, so
the site lives on the mirror. An app at the root of its own public repository
tags `vX.Y.Z`, and the same workflow deploys it without a mirror.

golaberto's mirror holds the app at its root and its runtime under `.runtime/`,
copybara rewriting every path the generated files name to that layout. The
app's `program_pronto.cue` states the layout, so `sayt` builds, launches,
lints, tests and releases the mirror as it stands, and a build there
regenerates what copybara wrote; `.github/mirror_test.sh` holds the two to each
other. Its lint leaves out the facts rule, whose artifact hashes are of the
monorepo's bytes. The alternatives each cost the runtime a concept: links break
on checkout and on Windows; vendoring or a package registry versions the
runtime apart from the app it was generated with; an image as the interface
makes docker a hard dependency of bayt; and a root taken from the environment
means the generated `Taskfile.yml` and compose files no longer run as they
stand.

**The refusals.** `emit.cue` refuses the target, a `cue vet` error rather than
a broken release, for a program with:

- a vendored unit, a worker the browser fetches past the document's shim;
- an unsuspended schedule, since a closed tab ticks nothing;
- a shared entity, since one user shares with nobody and the client opens a
  keyed shape per grant, which the page's cluster does not serve;
- a validation, which runs in plv8, and PGlite has none.

**The derived rows ship as the release found them.** The page runs no stream
and no computation, so for a program that declares either the rule first runs
[`derived.ts`](../bundle/derived.ts): it brings the app's container cluster up
under a compose project of its own, waits until it has settled, writes every
live table — the tables a stream or a computation writes without feeding the
publication — to `dist/derived.sql`, and tears the cluster down. The bundler
takes that file with `--derived` and the page runs it after the migrations,
each table emptied and refilled whole, so a seeded row the derivation no longer
produces is gone. The file is a release artifact, rebuilt at every release and
never committed. A write in the page recounts nothing: the archive the page
holds is read-mostly, and its derived tables answer the rows it was bundled
with ([pending](../PENDING.md#release-targets)).

Settled is a quiet window, opened once every stream's inputs are up, every
bus group has been delivered all of its stream with nothing pending, and every
computation has run once, and closed by any movement in the transform's
counters, which each read and post a stream makes advances, or in the
database's row writes. The window outlasts the slowest computation's cadence
and Postgres's statistics flush: a computation logs a run and nothing when it
looks and finds its reads unchanged, so its cadence is the one bound on its
having looked at rows that no longer move. Golaberto's ratings look every 300
seconds, so its release settles in about six minutes after the build.

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

The design: one Worker serves the pages file as its asset and routes the
door's paths over a binding to one Durable Object, and the object is the
cluster — PGlite on a filesystem over the object's SQLite, `postgrest-js`, a
shape server speaking Electric's protocol, the auth service ported to `fetch`,
the pipelines in-process, and the object's alarm and a Cron Trigger as the
ticker's clocks. It runs on the free plan, and `release@cloudflare` is
`wrangler deploy`. What fixes its shape:

- **An isolate has no fork, threads or sockets, and 128 MB.** PGlite runs
  there; Postgres needs all four. The 128 MB is the whole budget, so PGlite's
  heap, shared buffers and data directory are each cut to fit, and since
  `initdb` cannot run in the object, an initialised data directory ships and is
  imported once.
- **The object sleeps between requests.** One awake all day spends about
  11,000 of the free plan's 13,000 daily GB-seconds. Live sync is therefore a
  poke on one hibernating WebSocket per tab, after which the page's shim
  refetches without `live`; presence is tags on those sockets; and the data
  directory and each table's shape log live in the object's SQLite, so a woken
  object answers a client under the handle it already holds. A pending JS
  timer keeps an object awake, so Postgres's idle `setitimer` is a no-op there.
- **Two clocks.** The Cron Trigger is the coarse one, outside the thing woken,
  as [the ticker](../../../libraries/mecha/services/ticker/README.md#clocks)
  requires; the alarm adds finer schedules and never runs alone, because a
  sweep that dies before re-arming ends its chain silently.
- **What is spent is not durability** — a commit is on the object's SQLite
  when its write gate closes — but one connection, one location and the row
  budget: one object per app, every user behind one writer. Partitioning per
  room or per user is the first change when an app outgrows it.

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
[clouds as built](../../../libraries/mecha/docs/deployment.md#clouds-as-built)
is the mapping these start from.

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
  isolate lacks, and would run only under an emulator.
- **An object kept awake** by long polls and a heartbeat — it spends most of
  the free plan on waiting.
- **Electric's sync service at the edge, or Electric Cloud** — the BEAM does
  not run in an isolate, and Electric Cloud has wound down; the object answers
  Electric's shape protocol itself, and nothing in omnishell changes.
- **A service worker in the page** — registration from a `blob:` URL is
  forbidden, and one document has nothing to precache.
