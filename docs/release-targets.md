---
type: concept
title: Release targets
description: "Where a program is released: each target in meta.targets becomes a sayt release@<target> rule carrying the whole app on one tier of mecha's ladder; pages, cloudflare, docker and gcp are built, and the other clouds and k8s are designed."
---

# Release targets

A program names the places it is released to in `meta.targets`, and the
emitter projects each into a rule of sayt's `release` verb on the platform of
the same name, so the word in `program.cue` is the word after `@` in
`sayt release@<target>`. A release builds the immutable artifact the target
consumes, runs the version ceremony and makes the artifact live; each target
carries the whole app on one tier of mecha's ladder. `pages`, `cloudflare`,
`docker` and `gcp` are built, `cloudflare` for guests, passkeys and providers and, of the derivations, with its drains and its clock alone,
`docker` as a single-container standalone appliance, `gcp` for a cluster of the
database, crud, auth and electric alone, and `k8s` against a named kube context
([the clouds and k8s](#the-clouds-and-k8s)). `aws` and `azure` are designed
and [not built](../PENDING.md#release-targets). How an author releases an app is
[the guide's](../GUIDE.md#release).

## Targets, platforms and tiers

- A sayt **platform** is where a verb generates its effects, the string after
  `@`. `release` and `verify` default to `preview`.
- A pronto **target** is a place a program is released to and verified
  against: `#Target` in `schema.cue`, which admits `pages`, `cloudflare`,
  `docker`, `gcp` and `aws`, and not `azure` or `k8s`.
- A mecha **tier** is what the cluster is made of there. The ladder is
  mecha's: browser, CLI, single machine, k8s, cloud and edge
  ([invariant 4](https://github.com/bonisoft3/mecha/blob/v0.18.1/README.md#4-vertical-scalability-down-and-up)).
  pronto's `#Tier` names five of its rungs — `browser`, `edge`, `container`,
  which is mecha's single machine, `k8s`, and `cloud` — and the browser, the
  edge, and the container are built. `container` is where every app develops,
  and for release it is the `docker` target: the SQL fence `-- tier:
  container` … `-- tier: any` around the publication and the replica identity,
  the statements that need a WAL reader
  ([the fence](https://github.com/bonisoft3/mecha/blob/v0.18.1/docs/browser.md#the-fence)).

| target | tier | the artifact | the door |
|---|---|---|---|
| `pages` | browser | one HTML file | none: the page's fetch shim |
| `cloudflare` | edge | a Worker, one Durable Object running PGlite, and the data directory it loads | the Worker |
| `docker` | container | single-container appliance image running postgres, crud, caddy, auth, and process-compose | caddy on port 8080 |
| `gcp` | cloud | images by digest in Artifact Registry, one Cloud Run service and the Job that builds its schema | caddy, the service's ingress container |
| `aws`, `azure` | cloud | versioned images and the list naming them | caddy on the cloud's compute |
| `k8s` | k8s | skaffold's manifests | caddy in the named cluster |

## What a release is

A release rule is three steps the loop contract
([`loop.cue`](https://github.com/bonisoft3/sayt/blob/v0.45.1/loop.cue)) projects from one `release` verb: the
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
running app read `APP_URL` ([`base-url.ts`](https://github.com/bonisoft3/omnishell/blob/v0.20.3/base-url.ts)), so
each becomes a `verify` rule per target with `APP_URL` bound to that target's
door and no compose prepend. Two things come first. The base: a driver that
navigates to `${origin}/ar` (`apps/truco/tests/acceptance.ts`) cannot reach a
site under a subpath, and an `APP_URL` ending in a slash yields `//`, which the
router refuses. And the budgets, whose 20 s are tuned to a warm local stack
that a cold page boot exceeds. The projection is emitted for `gcp` alone
(`verify@gcp`, [gcp](#gcp)), whose address is a host with no subpath and no
trailing slash; the other targets' are
[not emitted](../PENDING.md#release-targets).

## A release is its entry

Every target serves the files a page runs or fetches at their content
addresses, `_immutable-<sha256>-<name>` beside each file, and every document
that boots the terminal — the entry, a prerendered document, one rendered on
request — carries the map from logical path to address as its import map,
`#pronto-assets` (omnishell's [`release-addresses.ts`](https://github.com/bonisoft3/omnishell/blob/v0.20.3/server/release-addresses.ts)).
A page therefore runs one release, and an open one takes the next at the
level its changes allow ([screen updates](https://github.com/bonisoft3/omnishell/blob/v0.20.3/docs/screen-updates.md#when-a-deployment-lands)).
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

## ICE servers

An online race's data channel (omnishell's [kinetic](https://github.com/bonisoft3/omnishell/blob/v0.20.3/docs/kinetic.md))
gathers its candidates over the ICE servers in the terminal config,
`shell.json`'s `iceServers`. They are derived from the release target, by
`#IceServers` in [`distribution/config.cue`](../distribution/config.cue), and
an app never declares them:

| where | `iceServers` |
|---|---|
| tests, `launch`, `integrate` | none: host candidates only, so no test depends on a server outside the stack |
| `release@cloudflare` | `stun:stun.cloudflare.com:3478` |
| `release@docker`, `release@gcp`, `k8s` | `stun:stun.l.google.com:19302` |

The emitter writes `iceServers: []` beside `kinetic` in every app that mounts a
kinetic child, and a release writes its list into the config as it addresses
the tree (omnishell's `addressRelease`), so the list is part of the release's
identity. The cloudflare rule passes `edge.ts --ice-servers`. The container
targets share one stage, `served-release`, the door's tree addressed with
`--ice-servers`: the docker image copies it in place of the door's, and the gcp
and k8s releases bake their images from the app's compose project with every
`<app>-served` context moved to it (`release-tree` in
[`k8s/release.nu`](../k8s/release.nu)), so their door and renderer serve it.
`edge.ts` holds the tree it
built to the list, and `publish-edge.ts` holds what the deployed `/` maps
`shell.json` to the build's ([`edge-ice.ts`](../bundle/edge-ice.ts)).
`kinetic-child.test.ts` holds each target to its own list and the dev stack
to none, and `k8s/release_test.nu` the bake to the release's tree. Nothing
tests a NAT.

A STUN server sees each player's public address as the race connects. A
symmetric NAT needs a TURN relay as well
([RFC 8656](https://www.rfc-editor.org/rfc/rfc8656)), which needs an account and
short-lived credentials minted by a server-side key. At `release@cloudflare`, the
Worker serves dynamic ICE servers from `/rtc-ice`: when `CLOUDFLARE_TURN_KEY_ID`
and `CLOUDFLARE_TURN_KEY_TOKEN` are configured as secrets (or via `.turn-secret`),
the Worker calls Cloudflare Calls TURN to mint ephemeral credentials. Without
them, the release defaults to STUN alone, preserving deployment on the free
card-less tier. Omnishell's kinetic child prefetches `/rtc-ice` to use dynamic
relays when available.

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
`/electric` to [the one-user cluster](https://github.com/bonisoft3/mecha/blob/v0.18.1/docs/browser.md#the-one-user-cluster),
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

**The page runs its drains and its clock**
([mecha's dispatcher](https://github.com/bonisoft3/mecha/blob/v0.18.1/docs/browser.md#drains-and-the-clock)):
the bundler carries the drains from `.pronto/cluster.json` and places mecha's
`schedule` table before the seed, as the edge's data directory does
([`edge-scripts.ts`](../bundle/edge-scripts.ts)). The clock runs while the
page is open, so the target asks for no clock: a boot records what came due
meanwhile, late where its lateness has passed. `code.meta.edgeClock:
"disabled"` stops it in a page as at the edge.

**The derived rows ship as the release found them.** The page runs no stream,
whose mapping is bloblang, and no computation, so for a program that declares
either the rule first runs
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
never committed. A write in the page recounts what its drains recount and
nothing a stream or a computation derives: those tables answer the rows it
was bundled with ([pending](../PENDING.md#release-targets)). A drain's sink
among them is recomputed at boot.

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
`/electric`. Social sign-in providers (`capabilities.auth.providers`) are
refused at release (`_authTargetRefusal`): the browser tier runs a local
one-user cluster with guest sessions and has no server to redeem OIDC codes or
receive callbacks. A duckstream is neither a stream nor a computation, so xpense
targets `pages`, declares `recount-months` and `recount-buckets`, and nothing
in the page fills `MonthStat` or `CategoryMonthStat`.

## cloudflare

`sayt release@cloudflare` runs [`edge.ts`](../bundle/edge.ts), which writes
`dist/cloudflare/`. The terminal modules and declared public files live in
`public/`, so each route loads only its own screen and required catalogues.
The terminal asks the Worker's origin for `/crud`, `/auth` and `/electric`.
The edge cluster runs guest sessions, passkey ceremonies, the auth service's
provider sign-in and shape tokens in its Durable Object, so social sign-in
providers (`capabilities.auth.providers`) are admitted here as on the
container and cloud tiers ([below](#cloudflare-sign-in)).

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
See [omnishell/docs/native-worker-ssr](https://github.com/bonisoft3/omnishell/blob/v0.20.3/docs/native-worker-ssr.md) for the freshness and isolation
contract. Authentication and derivation support remain the edge target's.

The integrated deployment has been exercised on Paid; Free enforcement,
including the documented per-object storage limit discrepancy, requires
verification on a Free account before claiming a free deployment.

A program that declares `capabilities.blobSeed` (a manifest of `{file, sha256}`
and the public origin the files come from) ships that set as static assets
under `public/blobs/mecha-objects/`, the URLs the blob plane answers in compose:
each file is fetched from the origin and refused unless it hashes to its sha256
([`edge-blobs.ts`](../bundle/edge-blobs.ts)), and `_headers` marks `/blobs/*`
immutable. Blobs written at run time, such as uploads, have no store at the
edge yet; a seed is the set known at release.

The release also contains PGlite for workerd in `pglite/`, baked from mecha's pinned sources
([pglite-workerd](https://github.com/bonisoft3/mecha/blob/v0.18.1/packages/pglite-workerd/README.md))
([`edge-pglite.ts`](../bundle/edge-pglite.ts)): with `EDGE_BUILD_PROJECT=<project>` in that
project's Cloud Build, kept in `gs://<project>-pronto-edge` under a hash of those sources, so
the next release on the same mecha downloads it and the machine releasing needs no Docker;
without it, by the local Docker;
the data directory in `pgdata/`; and a Worker in `src/index.ts` exporting
[mecha's edge cluster](https://github.com/bonisoft3/mecha/blob/v0.18.1/packages/mecha-edge/README.md)
as its one Durable Object, over the shell's tables. `publish` runs
[`publish-edge.ts`](../bundle/publish-edge.ts): `wrangler deploy` at the
version pglite-workerd's `mise.toml` pins, with `JWT_SECRET` (once) and a new
`IMPORT_TOKEN` in the same version, then the data directory loaded into the
object. `sayt release@cloudflare --temporary` deploys with no login, to a
throwaway account wrangler creates and reuses; it expires unless claimed at
the link wrangler prints. wrangler cannot list a temporary account's
deployments, so such a publish has no version to roll back to when the data
directory refuses its migrations. The target keeps the compose stack's shape, one Cloudflare piece per
service, and nothing runs while no one uses the app:

| compose service | at the edge | sleeps | |
|---|---|---|---|
| caddy | the Worker: static files, `/crud`, `/auth`, `/electric`, settled reads from the Cache API | per request | built |
| database, crud, electric, auth | one Durable Object running mecha's edge cluster on PGlite, its data directory in the object's SQLite | when idle | built, guests, passkeys and providers |
| conduit, mesh-events | for drains, a trigger per table and the object's dispatcher; for streams, an outbox table and a Cloudflare Queue | with the object | drains built, streams designed |
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
  `schedule` table, the container image's 800 step, before the 801 seed.
  `--from=<dir>` starts it from a directory built elsewhere
  instead, an archive restored from its database with its pgroll ledger
  ([`restore.ts`](https://github.com/bonisoft3/mecha/blob/v0.18.1/packages/pglite-workerd/restore.ts)),
  applies the cluster's pgroll migrations the ledger lacks, as its migrate step
  would ([`migrate.ts`](https://github.com/bonisoft3/mecha/blob/v0.18.1/packages/pglite-workerd/migrate.ts)),
  and skips the derivation.
- **Loading is once, and a later release migrates.** The object opens only
  a directory whose load verified every chunk; a load resumes where it
  stopped and leaves a complete directory alone, so a later release changes
  the Worker and the page and never the data, unless `--reset` replaces it.
  A directory left alone is handed the release's migrations
  (`migrations.json`: the shell's files and the cluster's pgroll set, by
  name), and the object applies the ones its ledger lacks and starts over on
  the new schema. The ledger is the docker appliance's `_pronto_migrations`,
  with each script's digest beside its name: a directory records what it
  applied when it was built (a fresh one applies the pgroll set after its
  files, as a fresh volume's migrate step does), a script the ledger lacks
  is applied in name order, a seed never, and a recorded file whose text the
  release changed is refused by name — a live schema moves only by a pgroll
  migration ([schema change admission](schema-change-admission.md)), never
  by the entity file a directory already ran. A directory built before the
  ledger existed is refused too. A refusal rolls every Worker the publish
  deployed back to the version it replaced, so the site keeps serving the
  schema it has, and `--reset` loads a directory built for this release.
- **One object, every user behind one writer.** PGlite is one connection.
  [`createRestHandler`](https://github.com/bonisoft3/mecha/blob/v0.18.1/packages/postgrest-js/src/rest-handler.ts)
  opens each request with a transaction-local role, `app.scopes` and
  `request.jwt.claims`, so a shared connection never leaks a subject, and row
  policy is Postgres's own here as on a single machine.
- <a id="cloudflare-sign-in"></a>**The auth service's sign-in, in the object.**
  `/auth/guest` mints a guest's credentials, the passkey ceremonies run with
  the Worker's door as the relying party, and the object runs the auth
  service's provider sign-in (`/auth/oidc/*`) for the providers the program
  names (`auth.providers`): [`edge-signin.ts`](../bundle/edge-signin.ts)
  writes the settings compose would give the auth service into the Worker's
  vars, the program's or the build environment's `OIDC_<NAME>_<SETTING>`, and
  `publish-edge.ts` puts each client secret, `OIDC_<NAME>_CLIENT_SECRET` from
  its environment, beside `JWT_SECRET`; register the callback
  `<origin>/auth/oidc/<name>/callback` with the provider (or the broker).
- **Sync holds requests open.** A tab's live shape request waits on the
  object, which keeps the object awake while a tab is open; that is the price
  of the simplest path, and a poke on a hibernating WebSocket is the cheaper
  later step. The shape log lives in the isolate, so a new object sends every
  client back to a snapshot.
- **Settled reads are the colo's.** A shape response that is not live is a
  prefix of its log, so the Worker answers it again from the Cache API, keyed
  by the object's epoch; a public table's chunks are every guest's.
- **The drains run in the object**, called as their tables change and once
  after every boot that serves, a failed one's retry at the alarm
  ([the edge cluster](https://github.com/bonisoft3/mecha/blob/v0.18.1/packages/mecha-edge/README.md#drains)).
  A drain's writes reach a guest's cached `/crud` read once its 5 seconds pass,
  and a cached render once its minute does, as every write the object makes
  itself; the shape stream carries them at once.
- **The derived rows ship as the release found them**: no stream, whose
  mapping is bloblang, and no computation runs at the edge yet.
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
  for a fifth of it. A tick wakes the drains that name its table.

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
([the edge cluster](https://github.com/bonisoft3/mecha/blob/v0.18.1/packages/mecha-edge/README.md#machines)).
A deadline a machine arms and a cron schedule the program declares are the
object's alarm, swept as the ticker sweeps them
([the clock](https://github.com/bonisoft3/mecha/blob/v0.18.1/packages/mecha-edge/README.md#the-clock)).
For a frozen archive, `code.meta.edgeClock: "disabled"` emits `--clock disabled`:
the object preserves schedule rows, clears alarms at boot and delivery, and no
Cron Trigger is written. The default, `"ticker"`, runs them.

## docker

`sayt release@docker` packages the container tier into a single-container
appliance image running under process-compose: PostgreSQL 18, PostgREST (`crud`),
Caddy as reverse proxy and static asset server, and, when `capabilities.auth` is
configured, Deno running the app's `auth` service.

What fixes its shape:

- **Single self-contained image.** The appliance builds on `core.nubox`
  (openSUSE Leap 16.0 with the lazybox toolbelt, Nushell, and GNU utilities),
  adding PostgreSQL 18 with ICU collations (`--locale-provider=icu --icu-locale=und`),
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
- **Configuration knobs and persistence.** The appliance runs standalone or with mounted state:
  - `PGDATA`: path to PostgreSQL database directory (default `/var/lib/pgsql/data`). Bind-mounting a host directory or named volume to `/var/lib/pgsql/data` preserves database state across container updates while executing idempotent migrations on startup.
  - `PORT`: external HTTP ingress port served by Caddy (default `8080`).
  - `ORIGIN`: public base URL of the service (default `http://localhost:8080`).
  - `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN`: WebAuthn relying party identity and origin; automatically inferred from `ORIGIN` when unset.
- **Image tagging and publication.** Distribution tasks derive the OCI image tag
  by stripping any path prefix from a prefixed release tag (`$tag | path basename`),
  defaulting publication to `ghcr.io/bonisoft3/<app>:<tag>` or the registry
  configured via `${BAYT_DOCKER_REPOSITORY}` and `${BAYT_IMAGE_TAG}`.

## gcp

`sayt release@gcp` runs [`gcp/release.nu`](../gcp/release.nu) with gcloud
alone — the Cloud CLI installed on the machine, the one tool here the
toolchain does not pin ([pending](../PENDING.md#release-targets)) — against
the app's `release.cue`, which declares `GCP:
schema.#Release & {name, project, region, domain, ...}` and `gcpRelease:
schema.#Build & {release: GCP}` from [`gcp/schema`](../gcp/schema/gcp.cue).
Every resource is described before it is made, so a second release with
nothing changed pushes the same digests and rolls nothing.

A release goes behind its integration tests, run against a preview of what
it deploys rather than a stack on the machine releasing: `release.nu` first
releases the checkout as the preview `rc` ([Previews](#previews)), then runs
`verify@gcp` against it, and only when every driver passes releases the app,
with the very images tested: copied by digest from the previews' repository,
not built again. The drivers' images build in Cloud Build while the preview
deploys, and the build waits for the release's go, a marker in the project's
Cloud Build bucket, to run them; while they run, the release's project copies
the preview's images as `candidate`, and tags them `release` only once every
driver passed. While they run the release also stages production: the
project, the plan rendered with the tested digests, the bucket and the
grants, none of it running the app; when they pass only the schema job and
the deploy are left, the first of the release's code production runs
([staged release](decisions/2026-10-29-staged-release.md)). A release skips the schema job when the live service already carries the hash of the
job it would run (the `pronto-job` label of its revision, the hash of the rendered job: its
image, so every migration, seed, policy, publication and hybrid machine, and its commands,
roles and secrets); a missing label, a revision not ready or a failed read runs it, as do
previews and `PRONTO_RELEASE_FORCE_SCHEMA=1` (a rotated role password, say).
`--rollback`
sends the traffic back to the revision before, where its schema is the
same. The preview is stopped whatever happened (its service, jobs
and clock), and its Cloud SQL instance stays for the next release, which
starts it on an empty database: making an instance is most of ten minutes.
One release at a time, then; `--preview rc --delete` removes it all. A failing driver, or a
preview that does not come up, stops the release there. `--preview`,
`--dry-run` and `--snapshot` deploy as asked, untested, and `--no-gate`
releases without the preview.

Before any of that, a release (gated or `--no-gate`, not a preview, a dry run
or a snapshot) runs the same drivers on the machine releasing: `release.nu`
runs `sayt integrate@local` with `INTEGRATE_LOCAL_DRIVERS=all`, which brings the
app up as host processes, runs the visual lint and then every other driver
the rc gate runs (the same selection, [`local-drivers.ts`](../local-drivers.ts)),
each from the app's directory with `APP_URL` at the local door, and fails if
any failed. A failing scenario stops the release in about a minute with
nothing built, pushed or deployed, where the rc gate would find it half an
hour in. A scenario a driver skips away from localhost (a stand-in's) runs
here, where its stand-in is. The rc gate stays after it, since a preview finds
what only the cloud has. An app without `integrate@local` is refused;
`--no-local-gate`, or `PRONTO_RELEASE_NO_LOCAL_GATE=1`, skips the pre-gate,
only when asked.

The pre-gate runs beside the preview's emptying, the tests' build and the
preview's deploy, its output prefixed `local-gate|`; the tests are told to run,
and production staged, only once it passed, and a failing gate stops the deploy
and the preview. A tree that already passed it on this machine, whether by a
release or by `integrate@local` with `INTEGRATE_LOCAL_DRIVERS=all` run by hand,
is not run again: the stamp is `~/.cache/pronto/local-gate/<app>/<key>`, the key
a hash of the app's files as git lists them and of the pronto files the gate
runs ([`gcp/local-gate-key.nu`](../gcp/local-gate-key.nu)), so any change to
either runs it. `go-live` runs what does not depend on the rest together: the
retired migrate job's removal beside the service's replacement, then the door's grant, the sidecars, the clock
and the domains
([decision](decisions/2026-11-01-release-concurrency.md)).

Where the local gate passed for the tree, and the deploy-shaped files (release.cue,
program.cue, compose files, Dockerfiles and `docker/`, web server, entrypoint and sidecar files,
`.say.yaml`, `.pronto/cluster.json`, `infra/`, cue.mod/module.cue, `.mise.toml`, mise.lock, pronto's
`gcp/*.nu`; not database migrations, which the local gate runs) are those of a release that passed the rc gate, the release skips rc:
no preview, no copy, its images built and staged for production as `--no-gate` does,
and live. `~/.cache/pronto/rc-passed/<app>/<key>` records the last such pass, written
after a gated release succeeds. `--rc` runs the rc gate anyway, and so does
`--no-local-gate`; the log says which path and why
([decision](decisions/2026-11-01-local-gate-replaces-rc.md)). An app's own
rehearsal records a local pass with `nu gcp/local-gate-key.nu stamp <app dir>`.

`sayt verify@gcp` ([`gcp/verify.nu`](../gcp/verify.nu)) runs the drivers of
`verify@<target>` against the release's address, or a preview's with
`--preview`: every service of the app's compose project that reads `APP_URL`,
built as integrate builds it and run as integrate runs it, with `APP_URL` at
the service's `run.app` address and nothing else of the stack up, all at once.
They run in Cloud Build in the target's project, on 32 vCPUs, since a driver's browser
renders in software and a 2-CPU runner timed a 3D page out; a machine whose
network refuses `run.app` verifies all the same. A check that reads no
`APP_URL` drives the cluster itself, and stays with integrate.

The images are built in Cloud Build, not on the machine releasing, which needs
no Docker daemon: the release uploads the app's files as git sees them (never
`.certs/`, the certificate pair `sayt setup` issues for one machine), and a
build step runs the app's compose project through `docker buildx bake --push`,
as integrate builds it, for linux/amd64 and reproducibly. Every context of the
app's images is its own directory or an image by digest, so nothing else is
sent. The build runs as the project's default Cloud Build account, which the
release lets push to the repository and write its log; the release reads each
digest back from the registry and names it in the service and jobs.

Each image has its own key, so an edit to one service's files builds that
image and the ones built from it, and no others. The key hashes the image's
build record from the compose project, its Dockerfile, the files of its
context that the Dockerfile `COPY`s (a source that is a build argument, or a
bound mount, counts as the whole app), and, through its `service:` contexts,
the keys of the images it is built from; it is left on the pushed image as the
tag `src-<key>`, and a release builds only the images without one (an
`--override`, release@k8s's release tree, keys each image by the whole app, as
a `.dockerignore` is not read: both only ever build more). The drivers of
`verify@gcp` are cached the same way, as `<service>-verify-<driver>:src-<key>`:
one whose key is in the registry is pulled by digest instead of built, and the
others are pushed once built. `PRONTO_VERIFY_NO_DRIVER_CACHE=1` builds them all.

| compose | on GCP |
|---|---|
| database | Cloud SQL, PostgreSQL 18, `cloudsql.logical_decoding=on`; the app's database image builds the schema once as the Job `<app>-initdb`, over the socket Cloud Run mounts, and reapplies its re-runnable steps every release |
| migrate | where the app declares pgroll migrations, the cluster's runner in the same Job `<app>-initdb`, after initdb and before the service rolls, as compose runs it on every boot: its image is `<app>-schema`, migrate's with the database image's initdb directory, which the release builds beside compose's, so the Job starts once |
| caddy, crud, auth, electric | containers of one Cloud Run service sharing localhost, beside the Cloud SQL Auth Proxy, caddy its ingress; at most one instance, since electric is one, and none at rest |
| ticker | where the app runs one, one more container of the service, writing through crud with the service role's token (`<app>-service-jwt`, signed with the gateway's secret) |
| clock | the Cloud Scheduler job `<app>-clock`, POSTing the door's `/poke` at the service's run.app address each minute with that token and no retry, as compose's clock does: the service answers anyone, so Cloud Run has no OIDC token to check |
| electric's storage | the instance's own: a new instance rebuilds its shapes from Postgres |
| the stack's secrets | Secret Manager, generated once; the database URLs are composed from the passwords there, since Cloud Run expands no `$(VAR)` |

This is mecha's [bundled unit](https://github.com/bonisoft3/mecha/blob/v0.12.1/docs/deployment.md#the-bundled-unit)
applied to the door: the containers wake together, reach each other on
localhost, and need no invoker between them. The door dials each upstream at
its own `PRONTO_UPSTREAM_<SERVICE>`, which a gcp release sets to the
service's port there and a k8s release to its Dapr sidecar. Electric takes
3002, since crud holds compose's 3000.

What bit on a real instance:

- **Cloud SQL's `postgres` is no superuser.** It creates `anon`, `app_user`
  and `service` with admin over them but no `SET`, so PostgREST could not
  switch into `anon`; initdb grants them to it on every release. PostgREST
  logs in as mecha's `authenticator` role, whose password initdb sets from
  `<app>-authenticator-password`, as compose's does. It owns the tables
  mecha puts under `FORCE ROW LEVEL SECURITY` and the `SECURITY DEFINER`
  functions that write them, so without a superuser's bypass every
  hybrid-machine write failed its policies; initdb gives it `BYPASSRLS`.
- It does grant `BYPASSRLS` and `REPLICATION` to a role it made, so electric's
  role is compose's.
- **Electric's storage cannot be a bucket.** Its shape metadata is SQLite,
  which a GCS bucket mounted over FUSE cannot lock, so a restarted instance
  failed to migrate it; mecha's GCP deployment predates that store.
- **One instance takes 1000 requests at once**, Cloud Run's most: at its
  default of 80, a page load's hatch files beside electric's held live
  requests met "Rate exceeded".
- **A schema initdb built is not rebuilt.** initdb runs once per database, and
  only pgroll's migrations reach one it built, with one exception: the steps
  emit.cue writes re-runnable run again on every release. `005_create_tables`
  creates a new entity's table and leaves every other alone; `006_policies`,
  `007_txid` and `008_publication` restate every policy, trigger and
  publication; `016_mecha_actors` replaces the hybrid machines' functions and
  triggers, so a changed guard, rule or port reaches games already in play,
  keeping their instances, and refuses a new protocol `version`, whose
  instances need a migration. A column added to an existing entity is still
  pgroll's: `CREATE TABLE IF NOT EXISTS` keeps the table's shape. When an app's initdb set changes
  in ways none carries (a framework upgrade restating its own steps, say),
  raising `GCP.sqlGeneration` starts it on a new, empty instance
  (`<app>-db-<n>`); the earlier one keeps its data and its replication slot,
  untouched, until its owner deletes it.
- **The smallest tier admits about 25 connections**, so the instance is raised
  to 50 and crud's and electric's pools are capped at 5; and a probe reaches a
  container at the instance's address, so crud binds `*`.

The release refuses an app whose compose project runs anything else: the
change-feed unit, the airlock, compute, blobs, images or render. A provider's settings come from compose as
the k8s release's do, under any `GCP.auth.oidc` the app sets, and its client
secret from Secret Manager by `GCP.auth.oidcSecrets`. With `domain` set, the
release maps it onto the service and prints the DNS records it needs; each of
`aliases` (www, say) is mapped too, and the door sends it on to the domain
(`PRONTO_ALIASES`), since a passkey's relying party is the domain alone. A
domain is verified once by its owner (Search Console) before Google routes it.

`GCP.sidecars` adds containers of the app's own beside the cluster's: each
names a service of the app's compose project (a plugin's collector, such as
pronto-perf's `perf-collector`), which the release builds and pushes as it does
the cluster's images and runs in the same instance, on a port none of the
cluster's holds. The door dials it at `PRONTO_UPSTREAM_<NAME>`, without waiting
on it: a collector down is no outage. One with `metrics: port` exports
Prometheus metrics, and Google's Managed Service for Prometheus collector for
Cloud Run runs beside it, scraping that port on loopback from a `RunMonitoring`
config the release keeps in the secret `<name>-gmp-config`; the release enables
Monitoring and gives the service's account `roles/monitoring.metricWriter`. The
series keep their names, so the app's PromQL rules and dashboards read them in
Cloud Monitoring (or a Grafana over its Prometheus API). A preview runs its
sidecars and scrapes nothing.

A sidecar runs with the environment compose gives its service, as the ticker
does, so one that talks to the cluster (a plugin's service writing through the
REST gateway) needs nothing more in `release.cue`. In the instance a peer
compose names is the port that container holds there: `http://crud:3000` is
`http://127.0.0.1:3000`, `electric:3000` is `127.0.0.1:3002`, and another
sidecar is its own port (the plan's `loopback`). A key naming one of the
cluster's secrets (`SERVICE_JWT`, `PGRST_JWT_SECRET`, …) is mounted from Secret
Manager, never compose's development value, and `ORIGIN` is where readers are.
`sidecars: <name>: env` adds to what compose gives.

```cue
GCP: schema.#Release & {
	sidecars: "perf-collector": {port: 8687, metrics: port: 9599}
	// A plugin's service writing through the gateway, as the service.
	sidecars: billing: {port: 8688, cpu: 100}
}
```

Cloud Run runs at most 10 containers in a revision, and the cluster holds up to
eight of them (caddy, crud, auth, electric, the Auth Proxy, the ticker, and the
blob plane's two), so the release refuses a service of more. A sidecar given
`apart: {}` runs as a Cloud Run service of its own, `<service>-<name>`, in
place of a container of the cluster's instance: one container taking the
service's requests at its port, beside Managed Prometheus's collector where it
exports metrics (its config the secret `<name>-<sidecar>-gmp-config`). The
release applies it after the cluster's service, public as the door is, and a
preview's goes with the preview. The door dials it at its run.app address over
TLS, so the app's route to it sets the Host that address answers to (`header_up
Host {upstream_hostport}`, as pronto-perf's, pronto-billing's and
pronto-flags' routes do). Outside the instance, the cluster is reached through
the door: compose's `http://crud:3000` is `https://<the service's run.app
address>/crud`, another sidecar apart is its own address, and nothing else of
the cluster's is reachable (the plan's `peers`). It scales on its own
requests, none at rest; one that serves none, a worker polling the gateway,
keeps `apart: minScale` instances, its CPU unthrottled between requests.

```cue
GCP: schema.#Release & {
	// Behind the door's /perf, its own service and collector.
	sidecars: "perf-collector": {port: 8687, metrics: port: 9599, apart: {}}
	// A worker, which nothing calls: one instance kept.
	sidecars: analyst: {port: 8689, apart: minScale: 1}
}
```

A sidecar's `memory` is its container's (`"4Gi"`), as Cloud Run spells it;
absent, Cloud Run's default. `alwaysOn: true` keeps the instance's CPU
unthrottled between requests, for a sidecar inside it whose work runs while
nobody is asking.

An app that acts for its owner alone sets `iap: true`: Identity-Aware Proxy
stands in front of the service, the release grants `roles/run.invoker` to IAP's
service agent instead of `allUsers`, and only the people the project's owner
admits reach it, once, outside any release:

```sh
gcloud iap web add-iam-policy-binding --resource-type cloud-run --service <service> \
  --region <region> --project <project> --member user:<email> --role roles/iap.httpsResourceAccessor
```

A preview has no proxy, so the gate's drivers reach it; it holds nothing of the
release's.

A provider is refused at release in two cases that a program's development
settings produce. One whose issuer or internal address is a developer's machine
(`localhost`, `127.0.0.1`, `[::1]`, `host.docker.internal`), as the program's
defaults for a broker on that machine are, would send every reader to their own.
One the program offers that production does not serve leaves the terminal's
way in answering 404. `GCP.auth.oidc` gives the provider its production
settings: a broker the operator runs, or the provider's own issuer with a
client registered for the domain.

### Previews

`sayt release@gcp --preview=pr-32` releases a pull request's own copy of the
app beside the released one, and `sayt release@gcp --preview=pr-32 --delete`
removes it when the pull request closes. A preview is the release's whole
stack, not a stand-in for it: its own Cloud Run service (`<service>-pr-32`),
Cloud SQL instance (`<name>-pr-32-db`), initdb and migrate jobs, and secrets,
so it builds its schema and carries its migrations exactly as the release
does. Each thing two copies could not share is its own: the `postgres` and
`electric` passwords are the instance's, and electric's replication slot is
named alike in every database. It answers at its run.app address alone, with
no domain or alias mapped, so a passkey made there belongs to the preview.
Its images are tagged for it in the repository it releases to; the service
names them by digest, as the release's does.

What fixes its shape:

- **An instance each.** A first release of a preview waits several minutes
  for Cloud SQL; later pushes reuse it. The smallest tier costs cents a day,
  and `--delete` removes it.
- **A project of its own.** A preview runs a pull request's code, deployed by
  whatever the pull request's workflow signs in as. With `previewProject` set
  on the release, every preview lives there: its service, instance, jobs,
  secrets, images and account. The deployer holds roles there alone and none
  in the released app's project, so a pull request cannot reach the release.
  Conditions on resource names cannot give the same: Cloud Run does not
  recognize `resource.name` in IAM Conditions, so a role on its services would
  reach the release's service too. Absent, previews run beside the release.
- **No say over the project.** A preview's release enables no API, makes no
  repository or service account and grants no role, Cloud Build's included. Previews share one
  account, `<name>-preview`, which the project's owner makes once; the release
  refuses to run without it, or without the repository.
- **`--delete` names a preview.** Without `--preview` it refuses: a release is
  never deleted here.

What the owner does once, for an app `<name>` whose previews run in project
`<previews>` (number `<number>`, given the release as `previewProject`), released
from a GitHub repository `<owner>/<repo>`:

```sh
gcloud services enable run.googleapis.com artifactregistry.googleapis.com sqladmin.googleapis.com \
  secretmanager.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  cloudbuild.googleapis.com --project <previews>
gcloud artifacts repositories create pronto --repository-format docker --location <region> --project <previews>
# The account Cloud Build builds the images as pushes them and writes the build's log.
builds=$(gcloud builds get-default-service-account --project <previews> --format 'value(serviceAccountEmail)' | awk -F/ '{print $NF}')
gcloud artifacts repositories add-iam-policy-binding pronto --location <region> --project <previews> \
  --role roles/artifactregistry.writer --member serviceAccount:$builds
gcloud projects add-iam-policy-binding <previews> --role roles/logging.logWriter --condition None \
  --member serviceAccount:$builds
gcloud iam service-accounts create <name>-preview --project <previews>
for role in roles/cloudsql.client roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding <previews> --role $role --condition None \
    --member serviceAccount:<name>-preview@<previews>.iam.gserviceaccount.com
done
gcloud iam workload-identity-pools create github --project <previews> --location global
gcloud iam workload-identity-pools providers create-oidc github --project <previews> \
  --location global --workload-identity-pool github \
  --issuer-uri https://token.actions.githubusercontent.com \
  --attribute-mapping google.subject=assertion.sub,attribute.repository=assertion.repository \
  --attribute-condition "assertion.repository == '<owner>/<repo>'"
gcloud iam service-accounts create preview-deployer --project <previews>
gcloud iam service-accounts add-iam-policy-binding preview-deployer@<previews>.iam.gserviceaccount.com \
  --role roles/iam.workloadIdentityUser \
  --member principalSet://iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/github/attribute.repository/<owner>/<repo>
for role in roles/run.admin roles/cloudsql.admin roles/secretmanager.admin roles/browser \
  roles/cloudbuild.builds.editor roles/storage.admin roles/logging.viewer; do
  gcloud projects add-iam-policy-binding <previews> --role $role --condition None \
    --member serviceAccount:preview-deployer@<previews>.iam.gserviceaccount.com
done
gcloud artifacts repositories add-iam-policy-binding pronto --location <region> --project <previews> \
  --role roles/artifactregistry.writer --member serviceAccount:preview-deployer@<previews>.iam.gserviceaccount.com
gcloud iam service-accounts add-iam-policy-binding <name>-preview@<previews>.iam.gserviceaccount.com \
  --role roles/iam.serviceAccountUser --member serviceAccount:preview-deployer@<previews>.iam.gserviceaccount.com
# The release copies the images its gate tested: Cloud Build of the release's
# project reads the previews' repository (nothing of the release's is granted
# to previews).
released=$(gcloud builds get-default-service-account --project <project> --format 'value(serviceAccountEmail)' | awk -F/ '{print $NF}')
gcloud artifacts repositories add-iam-policy-binding pronto --location <region> --project <previews> \
  --role roles/artifactregistry.reader --member serviceAccount:$released
```

The repository's workflow signs in through the provider as the deployer: its
variables `GCP_WORKLOAD_IDENTITY_PROVIDER`
(`projects/<number>/locations/global/workloadIdentityPools/github/providers/github`)
and `GCP_PREVIEW_DEPLOYER` (`preview-deployer@<previews>.iam.gserviceaccount.com`).

## The clouds and k8s

A cloud target carries users, so its floor is dollars a month rather than
requests a day, and it is tuned for low cost and for scaling with no hand on
it. Each service of the compose stack becomes the cloud's managed equivalent
running the images bayt builds, declared as resources the cloud's own tool
applies:

| target | controller | compute | database |
|---|---|---|---|
| `gcp` | gcloud ([built](#gcp)) | Cloud Run | Cloud SQL |
| `aws` | ACK | ECS Express Mode on Fargate | Aurora Serverless v2, from 0.5 ACU |
| `azure` | Azure Service Operator v2 | Container Apps | Flexible Server, B1ms |
| `k8s` | skaffold, against a named kube context | mecha's images, scaled from zero by KEDA | CloudNativePG |

`k8s` is built for Kind and for a cluster the operator runs behind NAT
(`envs.Metal`): its images built in Cloud Build and pulled from Artifact
Registry, its door a Cloudflare Tunnel ([k8s/README.md](../k8s/README.md#12-metal-a-cluster-of-your-own-behind-nat)).

The compute scales by itself; the floor is the database, and AWS's is the
highest, since Aurora does not pause while logical replication is on. Project,
account, region and domain are declarations on the cluster; credentials are
each cloud's own and never in the session. Region is the first of the axes a
system shards along, before time and user. mecha's
[clouds as built](https://github.com/bonisoft3/mecha/blob/v0.18.1/docs/deployment.md#clouds-as-built)
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
(mecha's [provider sign-in](https://github.com/bonisoft3/mecha/blob/v0.18.1/services/auth/README.md#provider-sign-in)).
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
- **Config Connector for `gcp`** — it reconciles from inside a Kubernetes
  cluster, GKE or Config Controller, whose bill is a floor beside the
  database's for an app that otherwise scales to zero; gcloud applies the same
  declarative documents (`gcloud run services replace`) with none.
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
