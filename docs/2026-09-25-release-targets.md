# Release Targets

Written on 2026-09-25 as the release proposal for pronto apps, and validated
the same day on truco (§8). Grounded in
[[2026-09-12-pronto-configures-its-batteries.md]] (scale 4 is "a browser tab or
a cloud cluster"), [[2026-09-25-the-unified-lattice.md]] (the effect level picks
the runner), [[2026-09-24-refusing-a-schema-change.md]] (what no deploy can
reach), the terminal doctrine
([`terminal-doctrine`](../../omnishell/docs/2026-08-02-terminal-doctrine.md),
"the tiers are one interface with three adapters"), the tick design
([`a-tick-needs-no-durability`](../../../libraries/mecha/docs/2026-09-08-a-tick-needs-no-durability.md))
and sayt's configuration dimensions ([`plugins/sayt/README.md`](../../sayt/README.md)).

The claim: **a program declares the targets it is released to, and the release
story is that declaration projected through sayt's platform axis:
`sayt release@<target>` publishes the immutable artifact the target consumes,
`sayt verify@<target>` runs the app's own acceptance battery against the door
the target serves, and the deploy gesture between them is never a verb. Four
targets cover the ground. `release@pages` bundles the program into one HTML
file that GitHub Pages serves and one browser runs alone. `release@cloudflare`
bundles the same program and mecha's browser cluster into one Durable Object that Cloudflare's free
plan runs for everyone. Neither needs a kernel, and both are a GitHub login
away from nothing. `release@gcp` and `release@aws` publish the same program as
the images mecha already builds, run by each cloud's own managed services at a
floor of one small database, scaling by themselves from there. Each is one
command, and each carries the whole app. `sayt release` with no `@` is sayt's
`preview`: plain Kubernetes through skaffold, with the optimized images
built, the monorepo's convention for every project.**

---

## 1. Where release stands

- Every app declared `tiers: ["container"]`
  ([`apps/truco/program.cue`](../../../apps/truco/program.cue) was typical), and
  `#Tier` was `"cli" | "container" | "k8s" | "cloud"` ([`schema.cue`](../schema.cue)):
  sayt's doctor ladder, against which nothing was emitted. The README's tier
  diagram named a browser tier the schema did not have.
- The loop contract accepts `release` in its verb vocabulary and never projects
  it; `verify` is not in its checks vocabulary
  ([`plugins/sayt/loop.cue`](../../sayt/loop.cue)). So in every app
  `sayt release` dies with "No .goreleaser.yaml found"
  ([`release.nu`](../../sayt/release.nu)) and `sayt verify` is the documented nop
  ([`verify.nu`](../../sayt/verify.nu)). CI runs build, lint, test and
  integrate per app and nothing further (`ci-apps` in
  [`ci.yml`](../../../.github/workflows/ci.yml)).
- The build seat has no release target ([`builders/bayt.cue`](../builders/bayt.cue));
  bayt's sayt stack has one waiting behind `bake.image`
  ([`plugins/bayt/stacks/sayt/sayt.cue`](../../bayt/stacks/sayt/sayt.cue)).
- The emitted stack is a development stack: default secrets and `--auth=trust`,
  `fsync=off` baked into the database image's `CMD`
  ([`Dockerfile.database-image`](../../../libraries/mecha/.bayt/Dockerfile.database-image)),
  anonymous volumes, a `https://localhost:8443` site block on mkcert
  certificates ([`libraries/mecha/cluster.cue`](../../../libraries/mecha/cluster.cue)).
- The reference apps, `guis/iris` and `guis/snapcards`, show the monorepo's
  grammar: `sayt release` computes the version, gates it on `VERSION`, creates
  the local `guis/<app>/vX.Y.Z` tag and runs goreleaser as a thin shim whose
  before-hook pushes images; a tag push triggers `cd.yml`; Crossplane on GKE
  reconciles Cloud Run; `sayt verify` never touches production. snapcards
  already splits `release` by platform, with a `release@browser` that builds a
  static SPA on in-browser PGlite "hostable on any static server" that nothing
  hosts.

The mechanism exists end to end and pronto emits none of it; the vocabulary is
split between pronto's substrates, sayt's stages and snapcards' ad-hoc names.

---

## 2. Targets, tiers, and the default

Three words, each with one owner. A sayt **platform** is "where the verb
generates its effects", the string after `@`, and any string names one
([`skills/tdd`](../../sayt/skills/tdd/SKILL.md), "Platforms"). A pronto
**target** is a place a program is released to and verified against; the
emitter owns `.say.yaml` and names the release and verify platforms after the
targets, so the words in `program.cue` are the words after `@`. A mecha
**tier** is what the cluster is made of at a target, an ordered ladder the SQL
fence reads as a threshold (§4).

`#Target` is `"pages" | "cloudflare" | "gcp" | "aws"`, the names a reader
will look for. `#Tier` is `"browser" | "edge" | "container" | "cloud"`: pages
runs at browser, cloudflare at edge, gcp and aws at cloud, and the compose
stack is the container tier every app develops on and no target. `cli`,
`k8s` and `cloud` leave the old list: nothing was emitted against them, `k8s`
was never a place, and `cloud` is two places with two names. The substrate
names `isolate` and `managed` were the first draft of the targets and are the
rejected alternative: right as tiers, ringing no bell as places.

| | `release` publishes | The door | Deploy gesture, never a verb | `verify` hits |
|---|---|---|---|---|
| `preview`, the default with no `@` | the optimized images bayt builds, through skaffold | caddy in a Kind cluster | `skaffold run -p preview`, the monorepo's convention | the cluster's door |
| `@pages` | one HTML file | none; the router is `pushState` under the prefix the bundle bakes in | the tag push: the monorepo's `cd.yml` publishes the app's mirror and tags it, and the mirror's own `cd.yml` bundles and deploys to Pages | the mirror's Pages URL |
| `@cloudflare` | a Worker script with one Durable Object, the same file as its asset | `caddy-js` in the object | `wrangler deploy` | `https://<app>.<account>.workers.dev` |
| `@gcp` | the images bayt builds, tagged with the version, in Artifact Registry, and the list that names them | caddy on Cloud Run | `skaffold deploy -p gcp` with that list, the monorepo's convention | the Cloud Run domain, or the one mapped |
| `@aws` | the same images in ECR | caddy on App Runner | `skaffold deploy -p aws` | the App Runner domain, or the one mapped |

A private monorepo on a free plan has no Pages of its own, so the browser
release lives where the reference apps already do: each has a public mirror
under `bonisoft3`, fed by copybara with the app and its runtime, and the
mirror's Pages is a project site under `/<app>/`, the prefix the bundle bakes in
(§8).

The default platform stays sayt's, `preview`, and for a pronto app it is what
it is for every other project in the monorepo: plain Kubernetes through
skaffold, with the optimized images built. It is no target, since nothing is
published to a Kind cluster; it is where a developer previews the release.
Its rule is emitted in the next round, with `cloudflare`; until then a bare
`sayt release` runs the ceremony against the emitted shim and publishes
nothing, and rules without a `platform:` match only the default, so the named
rules sit beside the builtin and never run for a bare `sayt release`.

**The ceremony is shared.** `release.nu` owns the version: the git-cliff bump
under the `apps/<app>/` prefix, the `VERSION` gate, the local tag, then
goreleaser, emitted as the shim iris uses, builds skipped and the GitHub
release disabled, in a `dist/` of its own. A target's rule is three commands the
loop contract projects from one `release` verb
([`loop.cue`](../../sayt/loop.cue)): what builds the artifact, the ceremony,
and what makes it live. Under `--snapshot`, which sayt mirrors as
`SAY_RELEASE_ARGS_SNAPSHOT` ([`sayt.nu`](../../sayt/sayt.nu), `dispatch`), the
artifact is built, `release.nu` tags nothing and the publisher is skipped: the
asset without the release. sayt hands a rule of several commands its flags as
environment rather than on each command's line, so the ceremony spells
`--snapshot` itself where the verb was given it. A flag with a value rides the
same way, `--base=/truco` as `SAY_RELEASE_ARGS_BASE`, which is how the mirror's
workflow names its project-site prefix: it runs `sayt release@pages
--snapshot --base=…` through sayt's install action, the verb a developer runs,
and deploys what the rule wrote. The pages rule is emitted today; the others
are the same shape, proposed.

```yaml
release:
  rulemap:
    pages:
      platform: pages
      cmds:
        - {do: "… bundle.ts . --omnishell ../../plugins/omnishell --mecha ../../libraries/mecha --out dist/browser --base ($env.SAY_RELEASE_ARGS_BASE? | default '')"}
        - {do: "if ($env.SAY_RELEASE_ARGS_SNAPSHOT? | is-empty) { release --skip=validate --clean } else { release --snapshot --skip=validate --clean }", use: ./release.nu}
        - {do: "if ($env.SAY_RELEASE_ARGS_SNAPSHOT? | is-empty) { git push origin …(the tags release.nu left on HEAD) }"}
    cloudflare:
      platform: cloudflare
      cmds:
        - {do: "wrangler deploy --dry-run --outdir dist/cloudflare"}
        - {do: "…", use: ./release.nu}
        - {do: "if ($env.SAY_RELEASE_ARGS_SNAPSHOT? | is-empty) { wrangler deploy --var APP_VERSION:(app-version) }"}
    gcp:
      platform: gcp
      cmds:
        - {do: "skaffold build -p gcp --push=false --file-output dist/gcp/images.json"}
        - {do: "…", use: ./release.nu}
        - {do: "if ($env.SAY_RELEASE_ARGS_SNAPSHOT? | is-empty) { skaffold build -p gcp --push --tag (app-version) --file-output dist/gcp/images.json }"}
```

`verify` adds no checks: every integrate battery already honours `APP_URL`
([`base-url.ts`](../../omnishell/base-url.ts)), so the emitter re-projects each
`integrate` check as a `verify` rule per target with `APP_URL` bound to that
target's door, minus the `compose up` integrate prepends.

This document proposes the four named targets and what sayt's default means
for a pronto app.

---

## 3. What `pages` and `cloudflare` share

**The cluster is already JavaScript.** `libraries/mecha/packages` holds PGlite,
`postgrest-js`, `caddy-js`, `conduit-js`, `bloblang-js` and `rclone-js`, and
[`mecha-browser/src/dev-server.ts`](../../../libraries/mecha/packages/mecha-browser/src/dev-server.ts)
already boots PGlite with the `live` extension, the REST handler, the CDC
listener and the pipeline registry in one process. Its handlers speak fetch
`Request` and `Response`; the `node:http` shim is the only tie to a socket.
That file, minus the shim, is the program both releases host: in a tab for one
user, in a Worker for everyone.

**App code is data to the terminal.** Screens, CSS, handlers, adapters and
renderers are fetched as text through one helper
([`screen.js`](../../omnishell/interpreter/screen.js), `fetchText`) and evaluated
in SES compartments ([`jessie.js`](../../omnishell/interpreter/jessie.js),
`evaluateRole`). Nothing in the app tree is imported as a module. Folding an app
into one artifact needs one seam, a file source that reads from the document
instead of the network; the interpreter's own modules bundle like any library.

**The door is the same table.** `caddy-js` routes `/crud`, `/electric`, `/auth`,
`/poke`, `/blobs` and `/img` in both, as the real caddy does on the clouds, so
`shell.json` keeps its relative paths at every target.

**What each weighs**, measured in this tree; base64 of gzip is what lands in a
file.

| Piece | Raw | Gzipped | In the file |
|---|---|---|---|
| interpreter, vendored | 656 KB | ~180 KB | ~240 KB |
| interpreter, core | ~400 KB | ~100 KB | ~135 KB |
| a static app's tree, chess minus units | 400 KB | small | small |
| Stockfish unit | 7.3 MB | 5.6 MB | 7.5 MB |
| bloblang runtime | 37.7 MB | 7.9 MB | 10.5 MB |
| PGlite, wasm and data | ~12 MB | ~3 MB | ~4 MB |

---

## 4. `release@pages`: one file, one user

**The artifact** is `dist/browser/index.html`, the surface bundled into one document:
the interpreter as one module, every app file in an inline table the file source
reads first, every binary blob as base64 of gzip inflated at boot through
`DecompressionStream`, and the escape-hatch units started from `blob:` URLs.
It opens from any static host; GitHub Pages is the one exercised. A pronto
program begins as one HTML file, `ir.html`, and ships as one.

**What is not in it.** No service worker: registration from `blob:` or `data:`
is forbidden, and a single document has nothing to precache, so
[`boot.js`](../../omnishell/boot.js), which registers wherever the API exists,
is to register only where a worker script can be fetched. No Caddy
rewrites, `robots.txt` or `sitemap.xml`: a single file has nothing for a
crawler to index, and every route must resolve to the one document. The router
is `pushState` on `location.pathname`
([`shell.js`](../../omnishell/interpreter/shell.js)) and Pages serves a
repository under a prefix, so the shell takes a `prefix` from its config, off
every address it matches and onto every address it composes; the bundler writes
it into the `shell.json` it serves, and the document doubles as the site's
`404.html` (§8). `file://` is not a host: `pushState` refuses it, and it stays
unexercised. No door: a single-user app serves nobody. No access control: the
cluster mints its one user at boot, every request is theirs, no token is
checked, and the RLS the migrations carry runs with that subject's claims set
once for the session.

**The three hops of a unit**, chess being the worked case
([`hatch-worker.js`](../../omnishell/interpreter/hatch-worker.js),
[`unit.js`](../../../apps/chess/shell/units/stockfish/unit.js)), and the
change each asks for:

1. Page to hatch worker: `SRC_SCHEMES` in
   [`hatch.js`](../../omnishell/interpreter/hatch.js), today `http:` and
   `https:`, is to admit `blob:`. The unit's declaration already lists every
   file it ships and the hash that pins it, so the seat has exactly the list to
   mint.
2. Hatch worker to engine worker: the unit is to resolve its siblings from a
   table in its own `location.hash`, falling back to `./` when the hash is
   empty. One read of `location`, nothing imported from the terminal, which is
   what makes it a unit.
3. Engine worker to wasm: no change. The Stockfish glue reads its wasm URL from
   its own hash before falling back to swapping `.js` for `.wasm`, so the seat
   starts it at `glueBlobUrl#<wasmBlobUrl>` with the blob typed
   `application/wasm`, and the glue streams it.

**One user.** `tab` and `device` rows live in the file's browser; a server
app's rows live in the PGlite cluster the page boots, the module the object
hosts too (§5), with its one user minted at boot. An app with no migration
boots no cluster: its document carries the files alone, without PGlite. A
program with a unit, with a schedule that is not suspended, with an entity
shared between users, or with a validation is refused the target
([`emit.cue`](../emit.cue)), in the refusal shape the missing clock already
has: a closed tab ticks nothing, a tick that waits for the reader to return
never defended its moment, one user shares with nobody while the client opens
a keyed shape per grant that the page's cluster does not serve, and a
validation runs in plv8, which PGlite has none of. Eight of eleven apps
declare it; chess waits on its unit, thenote on keyed shapes, realworld on a
validation language the page can run.

**Host and gestures.** GitHub Pages: no new account, files to 100 MB, sites to
1 GB. The deploy gesture is the tag: `apps/<app>/vX.Y.Z` pushed to the
monorepo makes its `cd.yml` publish the app's mirror through copybara and tag
the mirrored commit, and the mirror's own `cd.yml` bundles the app and deploys
the document to Pages (§8). `verify@pages` runs the acceptance batteries
with `APP_URL` set to the Pages URL.

**Outside the monorepo** the story is shorter. The tag prefix is the app's
path inside its repository, so an app at the root of its own public
repository tags `vX.Y.Z`, and the same emitted workflow, at that repository's
own `.github/workflows/`, bundles and deploys on it: no mirror, since the app is
already public. The bundler reads three trees, pronto's, the interpreter's and
mecha's; in a monorepo checkout they are siblings, and elsewhere they are the
mise installs the app's toolchain pins, `github:bonisoft3/pronto`,
`github:bonisoft3/omnishell` and `github:bonisoft3/mecha`, each mirror
publishing its tree as a release asset for that pin. The emitted rule and
workflow name whichever applies.

---

## 5. `release@cloudflare`: one object, everyone

**The shape.** One Worker, one object, no other vendor. The Worker serves the §4
file as its static asset and routes the door's paths to the object over a
binding, so the shell is byte-identical to the pages release. The object is
the cluster:

| mecha service | In the object | Free plan | Note |
|---|---|---|---|
| caddy | `caddy-js` route table | yes | same paths, same origin |
| database | PGlite on a filesystem backed by the object's own SQLite, one 8 KB block per row; the shipped tarball is imported once, migrations run once, and every commit is durable when the object's write gate closes | 1 GB per object, 5 GB per account | `initdb` cannot run in the object (§8), so the tarball ships initialised |
| crud | `postgrest-js` | yes | |
| electric | a shape server over a per-table log fed by the notify trigger, the log's last thousand entries per table kept in the object's SQLite under a handle that never changes; live requests never reach it, the page's shim waits for a poke on one hibernating socket and then fetches plainly | yes | the one new piece, below; pokes cost a twentieth of a request each, fetches only follow changes, and a wake resumes every client at its offset |
| presence | connection tags on the hibernating sockets: a user's row lives while any of their sockets does, and goes thirty seconds after the last closes | free | no heartbeat row; the screen writes its row on a status change only |
| auth | [`services/auth/main.ts`](../../../libraries/mecha/services/auth/main.ts) ported: `Deno.serve` to `fetch`, `Deno.env` to bindings, TCP `postgres` to the object's PGlite | yes | `@simplewebauthn/server` is WebCrypto; the relying party is the `workers.dev` host or a custom domain |
| conduit, mesh-events, redis | `conduit-js` in-process | Queues on free since February, 10k ops a day, if a bus is wanted | in-process is enough |
| transform | `bloblang-js` | fits the 64 MiB script limit | 38 MB of it; apps without pipelines skip it |
| ticker, clock | object alarm as the fine clock, a Cron Trigger as the coarse one; both wake a hibernated object, the sweep is the ticker's own `sweep` over the cluster's crud | five crons per account | the clock is outside the object; a temporary account refuses cron triggers |
| rclone-s3 | KV | 1 GB, 25 MiB per value, 1k writes a day | R2 asks for a payment method, so it is out |
| imgproxy | Images transformations on the KV-served URL | 5,000 a month | fails loudly at the cap |

**Why PGlite and not the real Postgres.** Not performance. An isolate has no
fork, no threads, no sockets and 128 MB. Real Postgres needs all four, so inside
a Worker it runs only under a CPU emulator, minutes to boot and more memory than
exists. PGlite is Postgres rebuilt single-user for this container. On a host with
a kernel the real one is the better choice, and the same modules run there too.

**Limits that bound the demo.**

| Limit | Value | Meaning |
|---|---|---|
| CPU per object invocation | 30 s, raisable to 5 min | not the 10 ms Worker limit; cold loads and sweeps fit |
| memory per isolate | 128 MB | the whole budget: PGlite's declared memory, Postgres's shared buffers and the data directory are each cut to fit (§8) |
| requests | 100k a day, WebSocket messages 20 to 1 | a demo's traffic |
| duration | 13,000 GB-seconds a day | one 128 MB object awake all day is 11k of it, so the object sleeps between requests by design, not by option |
| SQLite | 5M rows read and 100k rows written a day, 5 GB stored | the filesystem is one row per 8 KB block: a boot reads a few hundred, a commit writes the blocks it touched |
| script | 64 MiB uncompressed, since 2026-09-04 | PGlite 12 MB, bloblang 38 MB |
| KV writes | 1,000 a day | the blob upload budget |

**The ticker works, and better.** The Cron Trigger is the doctrine's clock:
dumb, outside the thing being woken, carrying only "look at the time". It fires
at most once a minute, and the tick doc measured that a coarse clock against a
minutely schedule produces exactly one tick per minute, because `tick_at` is the
scheduled instant. Finer schedules add the object's alarm as a second clock, and
two clocks are free by construction; the alarm alone would not do, since a sweep
that dies before re-arming ends the chain silently. The clock-to-ticker poke
crosses a binding, not the public door, which closes the question the tick doc
leaves open at cloud tier: there is no credential because there is no route. The
ticker-to-mesh poke becomes a no-op, since `conduit-js` runs in the invocation
that woke the object. One change of contract: the sweep awaits the CDC drain and
the pipeline registry before returning, because an idle object may be evicted
and there is no "later" to rely on. The poke's meaning becomes "the tick is
answered".

**Sync is ours to build.** The omnishell client at the container tier and above consumes
Electric's HTTP shape protocol: a snapshot at `offset=-1`, then long-poll with
`live=true`, rows tagged insert, update or delete, an up-to-date control
message. Electric Cloud wound down in August 2026 and the BEAM does not run in
an isolate, so the object keeps a per-table log fed by the notify trigger,
persisted in its SQLite, and answers the protocol: full-row updates, no
compaction, snapshots from PGlite. The live half never reaches it from a page:
the page's shim waits for a poke on one hibernating socket and then fetches
plainly, so an idle object sleeps with its clients attached; the long poll
stays for clients that are not the page. Nothing in omnishell changes if the
object speaks the protocol.

**What is spent.** Not durability: a commit is on the object's SQLite when its
write gate closes, and a boot reads the directory back block by block. The
alternative, a dump of the whole directory after each write burst, bounds data
by memory and durability by the dump window, and buys nothing the filesystem
does not. Spent instead are one connection, so requests serialise; one
location, so every write pays the distance to it; and the row budget, since a
commit writes each block it touched as a row against a hundred thousand a day.

**One object per app.** All users share one PGlite behind one writer. Partition
per room or per user, one object each, is the first change when a demo outgrows
it, and it is a declaration on the cluster seat, not code in the app.

**Release mechanics.** `release@cloudflare` is `wrangler deploy`; the first run
also creates the KV namespace and puts the secrets, all from
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The account signs up with a
GitHub login and takes no card, and `wrangler deploy --temporary` needs none at
all: wrangler mints an account and a claim URL, good for an hour, that makes
it the person's (§8). `verify@cloudflare` runs the acceptance batteries
against `https://<app>.<account>.workers.dev`. From a Claude session the tokens
live in the repo's Actions secrets and the gesture is a tag push; the session
never holds a provider token.

---

## 6. `release@gcp` and `release@aws`: two clouds, low cost, scaling by themselves

**Why the clouds are targets.** The kernel-less targets cost nothing and carry a
demo; a cloud target carries users, and its floor is dollars a month rather than
requests a day. `guis/iris` and `guis/snapcards` already run the shape: images
from skaffold, Cloud Run services, a bucket and Pub/Sub topics declared as
Crossplane resources on one GKE cluster, the controllers scaled to zero between
deploys ([`skaffold.yaml`](../../../guis/snapcards/skaffold.yaml), the
production profile). They tuned for zero cost at zero users because nothing
else did; `cloudflare` does now, so the clouds are tuned for low cost and for
scaling with no hand on them, and the pieces that cannot do both are named
below.

**The shape.** The compose stack's services, each as the cloud's managed
equivalent, the images the ones bayt already builds, and the desire as
Kubernetes resources applied to the monorepo's control cluster, Config
Connector's on GCP and Crossplane's on AWS. mecha's
cloud mapping is the source
([`ARCHITECTURE.md`](../../../libraries/mecha/ARCHITECTURE.md), "Production
Deployment": GCP proven with iris, AWS proposed), with two departures. Cloud
SQL where it says Neon, because the target is named for the cloud and Neon's
regions are another cloud's, so every query would cross. App Runner where AWS
has a door, because a load balancer costs more than the services behind it and
App Runner needs none.

| mecha service | `gcp` | `aws` | Idle |
|---|---|---|---|
| caddy, the door | Cloud Run, the domain mapped | App Runner, the domain mapped | zero; App Runner keeps memory warm for cents |
| database | Cloud SQL for PostgreSQL, the smallest instance, logical decoding on, private IP | Aurora PostgreSQL Serverless v2 from half a capacity unit, logical replication on | the floor: a fixed small instance, half a unit |
| crud, auth, imgproxy | Cloud Run | App Runner | zero |
| electric | Cloud Run at zero to one instance, the shape log on a bucket volume, as iris runs it | App Runner at one instance, the log on the instance's disk | zero; the log is a cache the protocol rebuilds through 409 |
| conduit, mesh-events, transform, redis | the bundle mecha runs on Cloud Run: ingress, conduit and rpk as sidecars of one service, Pub/Sub for the bus | the bundle as one ECS Fargate task, since App Runner runs one container; SNS and SQS for the bus | zero on GCP; one task on AWS |
| ticker, clock | Cloud Scheduler with an OIDC identity the door's IAM admits | EventBridge Scheduler through an API destination that carries the credential | free at a minute's cadence |
| rclone-s3 | GCS through rclone-s3 | S3, native | storage only |
| secrets | Secret Manager | Secrets Manager | cents |
| the desire | Config Connector on the control cluster, Google's own controller for Google's resources | Crossplane on the same cluster, `provider-aws`, authenticated by web identity: AWS trusts the cluster's own issuer, and no key leaves AWS | the cluster the monorepo pays for; Config Connector runs as its add-on, Crossplane sleeps between deploys |

**What scales, and what is resized.** Cloud Run and App Runner scale by
request from zero and back, the Fargate task by CPU, Aurora by load between the
bounds its claim states, and none of it is a declaration in the program. Cloud
SQL does not scale its compute: the claim states a size, and a larger size is a
redeploy. That is the one hand the `gcp` target still needs; the size is one line
in the program, so the hand touches one line.

**The floor.** A small database on each cloud, one Fargate task on AWS, and
storage; everything else is zero when idle, and the first user costs nothing
more. Tens of dollars a month per cloud, the database most of it.

**Config Connector on GCP, Crossplane on AWS.** Config Connector is Google's
controller for Google's resources, an add-on of the cluster the monorepo
already runs, and the dialect Google documents against its own services; it
is the choice for `gcp`. AWS Controllers for Kubernetes is Amazon's
counterpart, but it wants a control plane in AWS or a cross-cloud trust
anyway, and Crossplane's AWS provider speaks from the same cluster and sleeps
between deploys as iris's GCP one does; it is the choice for `aws`. OpenTofu
needs no cluster at all and is the alternative if the cluster ever goes; iris
already runs a `Workspace` of it under Crossplane for what the GCP provider
lacks.

**Release mechanics.** `release@gcp` is the ceremony and `skaffold build -p gcp
--push --tag (app-version) --file-output dist/gcp/images.json`: the versioned
images in Artifact Registry and the list that names them. The gesture is
`skaffold deploy -p gcp --build-artifacts dist/gcp/images.json`, which applies
the resources with those images to the control cluster and waits for the services
to carry them, as snapcards' hooks do. `release@aws` and `skaffold deploy -p
aws` are the same against ECR. `verify@<cloud>` runs the batteries against the
door's domain. Project, account, region and domain are declarations on the
cluster seat; the credentials are the clouds' own, in the operator's `gcloud`
and `aws` logins or the repo's Actions secrets, never in the session.

**Region is a declaration.** Each cloud target takes one region from the program.
It is the first of the three axes a system shards along, region, time and
user, and the target is where it is first named.

---

## 7. What is emitted, and by whom

| Emission | Owner | Target |
|---|---|---|
| `#Target` is `pages`, `cloudflare`, `gcp` and `aws`, and `#Tier` the ladder `browser`, `edge`, `container` and `cloud`; `meta.targets` and `meta.clocks` range over targets, the SQL fence over tiers | pronto `schema.cue`, in place | all |
| the document file source behind `fetchText`, the messages fetch and the config load | omnishell | both |
| conditional service-worker registration | omnishell, `boot.js` | pages |
| `blob:` admitted for hashed units; the sibling table in the unit's hash | omnishell `hatch.js`, the unit wrappers | both |
| the interpreter as one pinned bundle | omnishell, a build step | both |
| the bundle: `shell.json`'s surface to one document, under the prefix the shell is told; the cluster it boots is mecha's | pronto, [`bundle/bundle.ts`](../bundle/bundle.ts), and mecha, [`cluster.ts`](../../../libraries/mecha/packages/mecha-browser/cluster.ts), in place | pages |
| `release@pages`: the bundle, the ceremony and the tag push as one rule, projected by the loop contract from a `release` verb; the goreleaser shim and the mirror's `cd.yml` beside it | sayt `loop.cue`, pronto `emit.cue`, in place | pages |
| the object entry module: `dev-server.ts` minus `node:http`, plus the filesystem over the object's SQLite, the shape server with its log in the same SQLite, the presence tags and the auth port | mecha, `packages/mecha-browser` | cloudflare |
| `wrangler.toml`: the object class, the KV binding, the assets directory, `nodejs_compat`, `crons` derived from the declared schedules where `meta.clocks` names the target | pronto, a `clusters/cloudflare.cue` adapter | cloudflare |
| the release-time data tarball from the migrations | pronto, `builders/bayt.cue` | cloudflare |
| the workerd build of PGlite: the environment defines, the callback trampolines, the side modules as deploy-time modules (§8) | mecha, `packages/mecha-browser` | cloudflare |
| the `gcp` and `aws` skaffold profiles: build to the cloud's registry, apply the claims to the control cluster with the published images, wait for the services to carry them | pronto, `builders/bayt.cue` | gcp, aws |
| the Config Connector resources on `gcp` and the Crossplane claims on `aws`, per declared service (§6): the database with logical decoding on, one service per door and per mecha service, the bus, the bucket, the scheduler jobs from the declared schedules where `meta.clocks` names the target | pronto, a `clusters/<cloud>.cue` adapter each | gcp, aws |

---

## 8. Validated on truco

`pages` and `cloudflare` ran end to end on [`apps/truco`](../../../apps/truco), a
server app with ten migrations and three synced tables, from a throwaway spike
under `libraries/mecha/packages/mecha-browser/spike/`, one working copy's and
kept out of the tree by its local exclude.
The interpreter and the mecha client ran unmodified in both; every change was a
build step or a shim around the app. The clouds did not run here; §6 rests on
what iris and snapcards run today.

**What the spike is.** One cluster module: PGlite, the RLS bootstrap
([`rls.sql`](../../../libraries/mecha/services/database/rls/rls.sql)), the
app's migrations, guest JWTs, `postgrest-js` behind `SET LOCAL ROLE`, and a
shape server that keeps a per-table log fed by a `pg_notify` trigger and
answers Electric's protocol: the snapshot at `offset=-1`, the long-poll with
`live=true`, `204` on a quiet timeout, `409` on a stale handle, the `txids` the
client confirms against. A bundling script writes the single file: the interpreter
bundled once, the manifest's files, migrations and RLS in a base64 table, SES
from a `data:` URL, the module inline, PGlite's wasm and data as
base64 of gzip inflated through `DecompressionStream`. A fetch shim serves the
table by path and hands `/crud`, `/auth` and `/electric` to the cluster in the
tab. The Cloudflare half hosts the same cluster module in one Durable Object
and serves the same file, minus the inlined wasm, as the Worker's asset.

**`release@pages` held.** One file, opened over HTTP, a guest signed in,
lobby rows written and confirmed by txid, the outbox replayed across reloads.

| | |
|---|---|
| the file, cluster inline | 12.14 MB, 7.24 MB gzipped |
| the file, cluster remote | 3.00 MB, 0.78 MB gzipped |
| assets inflated | 364 ms |
| PGlite up | 4.3 s |
| migrations | 153 ms |
| a lobby insert confirmed | 7 ms |

Seams the bundle found, each a change the emitter or the interpreter owns:

- Inline `<script>` cannot carry `<!--` or `</script`, and SES and the screens
  contain both. The data rides as base64; the module is written inline with
  the two sequences escaped, so `import.meta.url` is the page's own URL and
  PGlite's relative asset URLs resolve against it.
- Electric's client pauses every shape request while
  `document.visibilityState` is `hidden`. A background tab syncs nothing until
  focused; the spike overrides the property.
- The router is `pushState` on the pathname, so a subpath needs a prefix the
  shell now takes from its config (§4), and `file://` cannot be navigated at
  all; it was not exercised, since both browser automations refuse `file:`
  URLs.
- The bundler's first file list was `.pronto/manifest.json`, which is the writer's
  record of what it emitted, kept so a renamed target's old file is swept, and
  not the served set: a shared stylesheet is authored, named by the screens
  that import it and served from `shell.json`'s surface, and the writer never
  touches it, so `shell/shared/table.css` was in `shell.json` and not in the
  manifest. The served set is `shell.json`'s surface, and the emitted bundler
  reads that and nothing else.
- A migration's publication and replica identity exist for Electric's logical
  replication, which nothing here consumes. The emitter fences them between
  `-- tier: container` and `-- tier: any`, an authored migration does the
  same, the browser cluster skips what stands between the fences, and the
  bundler refuses a migration that names either outside one.

**`release@cloudflare` held under `wrangler dev`.** Two browsers, two guests,
one object: each user's lobby heartbeat arrived in the other's live shape, and
a third client read both rows at `offset=-1` under the object's handle.

| | |
|---|---|
| upload | 21.8 MiB, 9.6 MiB gzipped, of 64 MiB |
| first request on an empty object, boot included | 474 ms |
| the next | 4 ms |
| the data directory shipped | 4.25 MB gzipped |

The isolate compiles nothing at runtime, no wasm from bytes and no `eval`, and
that is every dynamic path in PGlite's Emscripten glue. Four adaptations, all
at build time, none in PGlite's source:

- **Environment.** `nodejs_compat` supplies `process.versions.node`, so the
  glue takes its Node branch and calls a `createRequire` that is not there;
  without it, `WorkerGlobalScope` exists but `self.location` does not. Both
  detections are defined away, and `import.meta.url`, undefined in workerd,
  becomes a constant.
- **Callbacks.** `addFunction` compiles a one-function trampoline from bytes
  to put a JS callback in the wasm table, and PGlite installs three: `system`,
  `popen`, `pclose`. The trampolines are emitted ahead of time, one per
  all-`i32` signature, imported as modules, and the glue's
  `WebAssembly.Function` branch is pointed at them.
- **initdb.** Its bootstrap `dlopen`s `dict_snowball.so`, so it cannot run in
  the object. Its output ships instead: `dumpDataDir` in Node at build time,
  `loadDataDir` in the object. §5 wanted the tarball for cold-start cost; it
  is a requirement.
- **Side modules.** Every `.so` the app touches is `dlopen`ed out of the file
  package. `plpgsql.so` is cut out of `pglite.data`, imported as a module, and
  the loader's instantiate-from-bytes is redirected to the precompiled module
  of the same size. An extension the app declares goes the same way; the
  loader's `eval` of a side module's EM_JS is the one path that could not, and
  `plpgsql` has none.

Also found: PGlite is one connection, so the cluster serialises requests; the
object's console output does not reach wrangler's log.

**And in production.** `wrangler deploy --temporary` publishes with no account:
wrangler mints a temporary one, prints a claim URL good for an hour, and the
Worker answers at `https://truco-spike.<subdomain>.workers.dev`. The object
booted there only after three more cuts, all to memory, because the isolate's
128 MB is the whole budget and `wrangler dev` enforces none of it:

- `pglite.wasm` imports its memory with a declared minimum of 2048 pages,
  128 MiB, so the allocation alone is the isolate. The minimum is a floor the
  heap grows past, and the two LEB128 bytes encoding it are rewritten to 512
  pages in place; the module boots in Node from the same tarball with 32 MiB.
- `initdb` writes `shared_buffers = 128MB` and `max_connections = 100` into
  the data directory, and Postgres allocates that at start. The object starts
  it with `shared_buffers=4MB` and the rest sized to match.
- The data directory inflated to 40 MB: a 16 MB WAL segment, cut to 1 MB with
  `--wal-segsize=1`, and two template databases, dropped, since one object
  serves one database and never runs `CREATE DATABASE`. It ships at 16 MB,
  2.4 MB gzipped.

| | |
|---|---|
| upload | 19.9 MiB, 7.8 MiB gzipped |
| first request on a cold isolate, boot included | 1.7 s |
| the boot inside it | 1.1 s |

The mecha client ran the app against it unchanged, and a second client read
the browser's rows through the shape. The account stays temporary until
claimed; claiming it, or minting an API token, is the one step that needs a
person.

**And with the object asleep.** The first production object was a server
pretending to be always on: three long polls per tab pinned it awake, a
five-second heartbeat woke it when nothing else did, and its memory was its
only state. The second one uses what a Durable Object is for.

- **Live is a poke.** The page's fetch shim, the one the browser tier already
  has, turns a live shape request into a wait: one WebSocket per tab, accepted
  by the object through the hibernation API, carries `{table}` when a shape
  table changes, and the shim then sends the same request without `live`. The
  object's notify listener is the only writer of pokes, so nothing is held.
  Keepalives are answered at the edge by auto-response and never wake it. The
  Electric client is unchanged and never learns the difference.
- **Presence is the connection.** Sockets are tagged with the user, the lobby
  row lives while any of their sockets does, and thirty seconds after the last
  closes the object deletes it. A boot gives every row without a socket the
  same thirty seconds rather than deleting it outright, because the page that
  just loaded is what booted the object, ahead of its own socket. The screen
  writes its row on a status change only, stops hiding rows by age and no
  longer queues a delete at unload, three rewrites the spike applies for this
  target, and what pronto would derive from a presence declaration on the
  entity.
- **The data directory is the object's storage.** PGlite takes a custom
  filesystem, and the object's SQL API is synchronous, which is what a wasm
  syscall can wait on; so Postgres's directory lives in two tables, files and
  8 KB blocks, and every read and write is one statement. The shipped tarball
  is imported once, through the same filesystem, and the migrations run once.
  A commit is durable when the object's write gate closes, the directory can
  grow to the object's gigabyte instead of its memory, and a boot reads the
  control file and the catalogs rather than a whole dump.
- **The shape log outlives the process.** Each table's handle and tail, and
  its last thousand entries, live in the same SQLite; the append rides in the
  write batch of the commit that caused it, since the notify fires inside the
  query. A wake answers a client's next fetch under the handle it already
  holds, from the offset it already has; a client further behind than the
  retained window gets the 409 that sends it back to a snapshot. In the tab
  the log stays in memory, since a tab has no second process to outlive.
  Measured in production: an object evicted after a write woke in 638 ms
  with the same handle and tail it had written.
- **Two clocks.** The alarm is the fine one: it settles leaves whose grace ran
  out. A Cron Trigger is the coarse one: the Worker's scheduled handler
  forwards it as a tick, which runs the ticker's own `sweep` over the
  cluster's crud when the app declares schedules and reconciles presence. Both
  wake a hibernated object. The
  temporary account refused the cron trigger, so production has the alarm
  only until the account is claimed.
- **Placement.** The object is created with a location hint for South
  America, since every write pays the distance to it.
- **Nothing pending.** An object with a pending JS timer is never idle, so
  `/poke` lists them, and the list found two. One was the spike's own boot
  watchdog, left armed after every request. The other was Postgres: it arms
  `setitimer` for its timeouts and keeps a ten-second one armed while idle,
  which Emscripten's glue turns into a JS timer re-armed after every fire;
  turning statistics off did not stop it. Single-user Postgres in the object
  has no timeout that must fire, so the build makes the glue's `setitimer`
  a no-op. With the list empty the object holds no work between requests.

The request budget per open tab per day falls from around thirty thousand to
the writes the player actually makes, the fetches that follow other players'
writes, and keepalives at a twentieth each.

Measured in production on the filesystem, with two browsers connected and
nothing else happening: the first boot imported the shipped directory into
SQLite, 2,414 blocks, in 1.4 s; the instance was cold within 25 s of its last
work and stayed cold through two idle minutes with both sockets parked; the
next request found both sockets attached, booted from SQLite in 266 ms,
reading 328 blocks, and answered in 0.39 s; and both browsers' rows were
there, each browser listing the other in the bar. A caution for anyone measuring this:
module state outlives an evicted instance, so a diagnostic that reads it
reports "up" from an isolate whose object is gone; only the instance's own
field tells the truth. The one thing that kept waking the object was the
client itself: a delete queued at unload sat in the outbox
and was replayed every minute, because the spike's shape server tagged a
deleted row with the transaction that had last written it rather than the one
that removed it, so the client never saw its delete confirmed. The trigger
now carries `txid_current()`, and under server presence the unload delete is
not queued at all. Four findings beyond the spike: a notification cannot carry a row, since
`pg_notify` caps its payload at eight kilobytes, so it carries the key and
the listener reads the row back; a delete's txid is the
deleting transaction's; a delete that matched no row produces no shape
message at all, so the client must count an empty delete as confirmed rather
than wait; and an outbox entry that cannot confirm is a wake-up on a timer,
and holds every write queued behind it.

**And on Pages.** The monorepo is private and its organisation is on GitHub's
free plan, which has no Pages for private repositories. The validation ran
from a scratch public repository written through the contents API, since
deleted; what replaced it is the mechanism the reference apps already have, a
public mirror per app under `bonisoft3` that copybara feeds with the app and
its runtime, whose own `cd.yml` runs the bundler and deploys the document to a
project site under `/<app>/`. The bundler writes that prefix into the shell's
config: every href the shell composes takes it, every pathname it matches
loses it, and
the same document sits at the site's `404.html`, which is how a deep link
boots instead of failing. Truco's mirror is
[`bonisoft3/truco`](https://github.com/bonisoft3/truco) and its site
<https://bonisoft3.github.io/truco/>, from the first tag on.

Pages was where the missing sheet finally showed: it is pulled by a CSS
`@import`, which the browser fetches outside the fetch shim, and the Worker's
SPA fallback had been answering that fetch with the page itself at 200. The
bundler inlines each `@import` into the sheet that asks for it and reads the served
set from `shell.json`, the files its routes and locales name; the spike's walk
of the tree had shipped two handler modules no screen named. With the sheet
in, a match was played to twelve by hand on Pages:
dealing, plays and the house's answers, a tied vaza, the ladder from truco
through seis and nove to doze, hand results, a new match and the rules deep
link, fourteen screenshots along the way.

The acceptance battery ran as `verify@pages` would, `APP_URL` bound to the
Pages URL and no compose prepend. Of 32 cases, 23 pass and 9 fail: seven are
waits that ran out, the battery navigates `${origin}/ar`, which a subpath
cannot answer, a trailing slash on `APP_URL` yields `//`, which the router
refuses, and the 20 s budgets are tuned to a local stack; the other two are
layout assertions, the tie spacing and the six-seat phone layout. Against the
object at its origin's root the same battery passes 29 and fails those two
layouts plus one wait. Those three are the app's at the commit the spike
bundled, not either target's: the checkout a running compose stack was built
from carries later, uncommitted work on the arena, and the bundle of that
checkout passes its own battery 32 of 32 against the object. A bundle is of a
commit, and a battery only means something against the bundle of the same one.
The bundle of that checkout on Pages passes 27: the five left are three cold
boots that outran a 20 s wall budget written for a warm stack, since the
manual clock the battery paces by does not exist until the interpreter has
booted, and the two cases that navigate `${origin}/ar`. Both are the verify
projection's to fix, the base and the budgets, and neither is the app's. The `verify` projection
has to hand the battery the base, and the budgets have to scale with the
door.

wrangler has no binary asset on GitHub, so it is `npm:wrangler`, which needs
`node` under mise; it is not in `.mise.toml` yet, and the pin is step 0's
(§9).

---

## 9. Order of work

0. **Vocabulary and honesty.** In place: `#Target` and `#Tier` in the schema,
   every app declaring `pages`, `release` projected and the shim emitted, so
   `sayt release@pages --snapshot` bundles an app and `sayt release@pages` tags it
   and pushes the tag. Remaining, `preview` and `cloudflare` first: the
   default's rule, the optimized images through skaffold onto Kind; rules for
   the three other targets; `verify` projected; `wrangler` pinned in
   `.mise.toml`.
1. **The bundle and the seams.** In place: the bundler
   ([`bundle.ts`](../bundle/bundle.ts)), the mirror workflow emitted for every app
   that declares the target, and a mirror for each of the eleven apps, with
   their keys and secrets. Remaining: `verify@pages`; the units, which the bundler refuses until
   the three hops of §4 are built, so chess does not declare the target yet;
   and the release set a consumer resolves, tagged after this lands and in
   this order: sayt, whose released binary must carry a flag's value for the
   mirror's `--base=`; mecha `v0.1.4`, the first release that carries its
   tree; omnishell, whose toolchain pins the Deno the bundler runs on; then
   pronto, with `#Version`, `#SaytVersion` and its mirror `module.cue`
   dependencies moved to the three.
2. **The object without sync.** Door, crud, auth, persistence. Server apps run
   for everyone; `live` entities update on reload. The spike proves PGlite in
   the object, the tarball import, the account-less deploy and the
   filesystem over the object's own SQLite.
3. **The shape server.** `live` entities update live. The spike proves the
   protocol against the unmodified client, first over long polls and then
   over pokes on hibernating sockets.
4. **The ticker on the cron.** Schedules run; the drain is awaited. The spike
   proves the alarm and the cron waking the object and the sweep wired to the
   cluster's crud; an app with schedules remains to run through it.
5. **Pipelines, blobs, images.** `bloblang-js` in the object, KV behind
   `/blobs`, transformations behind `/img`. The apps that need them last.
6. **The browser cluster in the tab.** In place: the object's PGlite cluster
   runs in the single file for one user (§4); a program with a unit or a
   schedule is refused the target instead.
7. **The clouds.** The `gcp` profile emitted for one server app and applied
   through the control cluster the monorepo runs, then `aws` through the same
   Crossplane once AWS trusts the cluster's issuer. Nothing is spiked; iris is
   the precedent.

---

## 10. Decisions taken, questions left

Taken here, reversible by argument:

- Four targets, named for where a reader looks: `pages`, `cloudflare`, `gcp`
  and `aws`, each on a tier of mecha's ladder. The default release is sayt's
  `preview`, plain Kubernetes through skaffold with the optimized images, and
  no target.
- The clouds are targets, not profiles of one: each maps every mecha
  service to the cloud's own managed one, and the desire lives on the control
  cluster the monorepo already runs, as Config Connector resources on GCP and
  Crossplane claims on AWS.
- Cloud SQL on `gcp`, in the region and sized by a line in the program; Neon
  would scale by itself, from another cloud's region.
- Low cost, not zero, on the clouds: `cloudflare` holds the zero-cost role, so
  each cloud keeps a database and scales everything else from zero by request.
- The publisher is the rule's second command; goreleaser is the iris shim.
- One object per app, single writer, until a demo outgrows it.
- Sync is spoken in Electric's protocol from the object, so the client stays.
- The object's SQLite is the data directory, block by block; a dump of the
  directory is the rejected alternative (§5).
- Blobs live in KV; R2 is out for asking for a card.
- A program with a unit, a live schedule, a shared entity or a validation is
  refused the `pages` target rather than emitted degraded; a server app's
  cluster runs in the tab.
- The browser artifact of a private monorepo is released from the app's
  public mirror, the one copybara already feeds, as a project site under the
  prefix the bundle bakes in.
- The browser module is `deno bundle`'s: the esbuild the Deno release pins
  and fetches on first use, driven by Deno's own resolver against the
  cluster's lock, so the page carries what `deno run` would resolve and the
  toolchain is Deno alone. `deno bundle` is experimental in 2.9.7, the
  release every pin names, and the page was validated on it and on 2.8.2; a
  Deno without the subcommand fails the bundler by `deno bundle`'s own error.
- Every wasm the object runs is compiled at deploy, and PGlite's memory floor
  is patched in the binary rather than bought on a plan that does not sell it.

Left open, with a lean:

- **Long-poll or WebSockets for live.** Decided by the second object (§8):
  pokes on hibernating sockets, with the client still unchanged because the
  page's shim does the waiting; the long poll stays in the shape server for
  clients that are not the page.
- **Whether `bloblang-js` ships in every object.** 38 MB of a 64 MiB budget for
  apps that declare no pipeline. Lean: only when a pipeline is declared.
- **Presence as a declaration.** The spike spells `{table, key}` out for
  truco; pronto should derive it from the entity, and the screen's "who is
  here" should read the connection rather than a timestamp at every target.
