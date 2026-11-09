# golaberto's mirror is an installed app

Date: 2026-10-03
Status: built. §9's guard was replaced on 2026-10-04 by a publish gate, whose
contract is in [release targets](../release-targets.md). The live contract is
[[../monorepo|monorepo mode]]; `.bayt/.env` and `MONOREPO_MECHA_PATH` gave way
to `mise.local.toml`'s `[env]` and `monorepo/service.yaml`, and `omnishell
materialize` to omnishell's runtime image.

## Problem

golaberto's public mirror (`bonisoft3/golaberto`) holds the app at its root and
a copy of the runtime under `.runtime/` ([release-targets.md](../release-targets.md)).
Its generated files are produced in the monorepo, with the app at
`apps/golaberto`. Copybara then rewrites the paths they contain with 41
search-and-replace rules (`rooted_app` in the monorepo's `copy.bara.sky`).
Each rule guesses at a shape some generator emits, and nothing proves the
guesses right. Running `generate` in the mirror, which needed two bayt fixes
first, and diffing against copybara's output found a broken bayt path in every
Taskfile, include keys that change with relocation, and the same compose file
listed twice.

The runtime does not need to travel with the app. pronto, omnishell, mecha,
bayt and sayt are released as mise tools and as CUE modules, and pronto's
installed mode resolves them at execution time (`run-mise where …`, in
[distribution/config.cue](../../distribution/config.cue)).
`bootstrap_test.ts` already runs jsfb this way.

## Goal

golaberto is an installed app in both places. Its generated files are the same
bytes in the monorepo and in the mirror. The monorepo differs only by two
committed files that the mirror never receives. Those two files point the
runtime at the sibling sources, so golaberto runs against HEAD there and
against releases everywhere else.

Copybara moves `apps/golaberto` to the root, leaves out the monorepo-only
files, and rewrites CUE imports until CUE 0.18 (§6). It edits no generated
file.

Done when:

- every generated file except `.pronto/facts.json` is byte-identical between
  `apps/golaberto` and the mirror;
- the mirror holds no runtime: no `.runtime/`, no `plugins/`, no `libraries/`;
- `installed_app` holds the move, the exclusions, the import rule and the
  targeted edits that §7 lists, and nothing else;
- golaberto's setup, build, lint and launch pass in the mirror against the
  pinned releases, and in the monorepo against HEAD.

Non-goals: the `reference_app` mirrors (truco, chess, realworld, shadcnui);
importing mirror PRs back (§9).

## Design

### 1. Two monorepo-only files

```toml
# apps/golaberto/mise.local.toml, with its mise.local.lock
[tools]
"github:bonisoft3/pronto"    = "path:../../plugins/pronto"
"github:bonisoft3/omnishell" = "path:../../plugins/omnishell"
"github:bonisoft3/mecha"     = "path:../../libraries/mecha"
"github:bonisoft3/bayt"      = "path:../../plugins/bayt"
"github:bonisoft3/sayt"      = "path:../../plugins/sayt"
```

```sh
# apps/golaberto/.bayt/.env
MONOREPO_COMPOSE_MODE=service
MONOREPO_MECHA_PATH=../../libraries/mecha
```

The shared `.mise.toml` pins released versions, and `mise.lock` locks them,
the same in both layouts. mise layers `mise.local.toml` over `.mise.toml`, and
its `path:` versions win. `mise where github:bonisoft3/mecha` returns the
sibling directory, relative to the file, with nothing to install, and returns
the release when the file is absent. This was spiked with mise 2026.5.2. The
precedent is `guis/snapcards/mise.local.toml`, committed and kept out of
container builds, which copy only `.mise.toml` and `mise.lock`.

The `MONOREPO_*` variables are for what cannot run a command: compose
interpolation (§5). `MONOREPO_COMPOSE_MODE` switches how compose reaches a
dependency's images; `MONOREPO_<DEP>_PATH` says where that dependency sits,
from the app's directory, as `mise.local.toml`'s `path:` does for commands.
Only mecha has compose fragments and images, so `MONOREPO_MECHA_PATH` is the
only path today.
Compose reads `.env` only from its project directory, which is
the directory of the first `-f` file, so `.bayt/.env` reaches compose even
outside mise (spiked). The shared `.mise.toml` loads the same file with
`[env] _.file = ".bayt/.env"`; mise skips it silently where it is absent
(spiked). bayt deletes `.bayt/` on every generate (`generate.nu`), so it keeps
`.env`, the one file there it never writes.

### 2. Commands find the runtime with `mise where`

Every command that reaches the runtime, in `.say.yaml`, the mise tasks and the
build, takes the installed form: pronto's `write.ts` and checks, omnishell's
CLI, compute's `admit.ts` and computation tests (`--config` on mecha's
`deno.json`), the pages bundle (`--mecha`). Each resolves its tool with
`run-mise where github:bonisoft3/…` when it runs, so the same generated line
reaches HEAD in the monorepo and the release in the mirror. The tests'
`@mecha/compute/…` imports already follow, mapped by the `deno.json` the
command passes.

What images copy from omnishell comes from `omnishell materialize` (into
`.omnishell/`), as installed mode does now. `tests/acceptance.ts` imports
`base-url.ts` from there instead of `../../../plugins/omnishell/`.

### 3. golaberto is its own bayt workspace

bayt computes every path from its workspace root, the nearest `cue.mod`. That
is the app itself in the mirror, and the monorepo's root in the monorepo,
where golaberto's dir is `apps/golaberto`. Its closures, for instance, include
its own fragments as `../../../apps/golaberto/.bayt/compose.launch.yaml`. So
golaberto declares `dir: "."`, which already means, for installed apps and for
mecha's mirror, that a project's directory is its root, and which then names
itself (no dir to derive a name from). bayt roots such a project at itself
wherever it sits (built). It has no sibling projects; everything it depends on
is pinned (§5). Generating the monorepo with `--all` regenerates it in place,
as its own root, together with any project below it. A monorepo project
cannot depend on it: its manifests state dir `.`, its own root, so bayt
refuses the ref by name.

Its CUE does not move. In the monorepo golaberto stays in the monorepo's
module and imports `bonisoft.org/plugins/…`, which is HEAD. The mirror gets a
module of its own, the way the pronto, bayt and mecha mirrors do:
`apps/golaberto/.mirror/cue.mod/module.cue` declares
`github.com/bonisoft3/golaberto@v0` and its pinned deps on
`github.com/bonisoft3/*`, and copybara stages it as `cue.mod`. CUE then
resolves the runtime's packages from the registry, at the versions
`mise.lock` installs.

`write.ts` infers local or installed from where pronto sits, and with
`mise.local.toml` the pronto it runs is inside the monorepo. So the layout
becomes a declaration: golaberto states installed, and `write.ts` honours it.
The installed `setup` is `mise.install` of the app's own `.mise.toml` over
`core.nubox`, so golaberto's toolchain (deno, buf, rpk, caddy, mkcert) is what
its images install in both layouts, and `workspaceroot` leaves its graph.

### 4. Identity is the name (built)

Taskfile include keys, `cross_*` runner tasks and their deps read the dep
manifest's `project`, not a slug of its dir (`gen_taskfile.cue`, `gen_bayt.cue`
`crossProjects`). A project may state a `discriminator`, four random
characters its author mints once and never changes, like a proto field's tag;
a dep that states one is keyed `<name>-<discriminator>`, so it cannot collide
with a local target's include, keyed by the target's name. One that does not
keeps its bare name, and a collision then fails as a CUE conflict. Compose services, images and Dockerfile stages already used
names. Two dirs claiming one name fail as a CUE conflict. In the monorepo the
regenerated Taskfiles hold the same data; 15 of them reorder one include key.

### 5. mecha's images: one switch per context

golaberto builds on five of mecha's seven service images: auth, compute,
conduit, database and mesh. The other two are ticker and clock. (The database
image is also the migration runner, and the blob store runs rclone's own
image.) Each is a pinned upstream base plus mecha's own files, with nothing
app-specific. Today the app reaches them as bayt cross-project refs
(`libraries_mecha:database-image`), which pull in mecha's manifests, its
`_srcs` and `_bayt` views and its compose fragments by path.

golaberto takes them as image names instead, with bayt features
that exist today:

- **`from: name: "libraries_mecha-database-image"`**: an image-name `FROM`,
  outside bayt's dependency graph. No manifests, no `_srcs` or `_bayt` views,
  no `cross_*` runners.
- **`compose: build: additional_contexts`**, emitted verbatim, carries the
  switch:
  `libraries_mecha-database-image: ${MONOREPO_COMPOSE_MODE:-docker-image://bonitao/mecha-database:0.2.0@sha256:…}${MONOREPO_COMPOSE_MODE:+:libraries_mecha-database-image}`.
- **`compose: includes`** appends `mecha/${MONOREPO_COMPOSE_MODE:-docker-image}.yaml`
  to every up closure (`required: false`). pronto emits `mecha/service.yaml`,
  which includes mecha's fragments where `MONOREPO_MECHA_PATH` says
  (`../${MONOREPO_MECHA_PATH}/.bayt/compose.<image>.yaml`, from `mecha/`),
  and an empty `mecha/docker-image.yaml`.

The mode's value supplies the prefix. `service` gives `service:<name>` and
the fragments; unset or empty gives the pinned image. A wrong value (`true`)
gives `true:…` and a missing `mecha/true.yaml`, which compose rejects. The
path is read only in `service` mode, so the mirror, which sets neither, never
needs one. This was
spiked with Docker Compose 5.0.2: unset built from the pinned image; `service`
built from mecha's sources and picked up edits to them.

The pins come from CUE, held by the consumer: pronto's `clusters/mecha.cue`
holds `published`, one image per service key, checked against the schema mecha
exports (`published.cue`: `#Images`, `#Pin`, `#Published`). A mecha release
prints its pin lines; a pronto release then names those images, and an app
pinning pronto gets them through it. The compose service and fragment follow
from the key (`libraries_mecha-<service>-image`).

No generated file names a monorepo path: where mecha sits is the value of
`MONOREPO_MECHA_PATH`, set only in the monorepo's `.bayt/.env`.

### 6. mecha releases its images

mecha's mirror `cd.yml` already publishes its CUE module and the tree mise
installs. As bayt's mirror does for its own image, on a `v*` tag it builds the
seven images for amd64 and arm64 (under QEMU, since they run commands while they
build) and pushes them to Docker Hub as `bonitao/mecha-<svc>:<version>`, with
no provenance, SBOM or labels and clamped timestamps, so build metadata never
moves a pinned digest. Each prints its pin line; the module and tree publish
after the images.
The digests are committed to pronto afterwards, the way
`bonitao/bayt-runtime` is pinned in bayt's `images.lock.cue`.
A golaberto change that needs new mecha behaviour reaches the mirror after a
mecha release; in the monorepo it runs against HEAD at once.

### 7. Copybara

`installed_app("golaberto")`:

- **origin:** `apps/golaberto/**` only, minus `mise.local.toml`,
  `mise.local.lock` and `.bayt/.env`;
- **move:** `apps/golaberto` to the root, and `.mirror/cue.mod` to `cue.mod`,
  as the pronto, bayt and mecha mirrors stage theirs;
- **search and replace:** CUE imports, `bonisoft.org/plugins/<x>` and
  `bonisoft.org/libraries/<x>` to `github.com/bonisoft3/<x>`, the mapping
  `bootstrap_test.ts` already applies. CUE 0.18's import resolution config lets
  the monorepo resolve the published paths locally, and the rule goes;
- **targeted edits:** none. The README names paths from the app and runs
  `./saytw`, so it reads right in both layouts (as built). `buf.yaml` needs none, with no runtime
  inside the mirror to exclude; `.github/workflows/cd.yml` needs none, since
  pronto emits the root-shaped workflow, inert in the monorepo.

`ROOTED_APP_RUNTIME` and every rule over generated files go.

### 8. Facts

`.pronto/facts.json` hashes `program.cue`, whose import line the rule
rewrites. Its seed key also hashes pronto's own `types.cue` and `schema.cue`,
which in the mirror are the released ones. The mirror's lint keeps skipping
the facts rule, as it does today (§Open questions 1).

### 9. The gate and mirror PRs

The mirror is published only once it builds and integrates with its pins, as
[release targets](../release-targets.md) states. It
is not held to what the monorepo regenerates, nor checked on pull requests.

Each sync rewrites the mirror whole, so a PR merged there would be lost.
Mirror PRs are imported into `apps/golaberto`, their authored files only, and
regenerated there.

## Alternatives

- **Keep rewriting** the generated files: the status quo, and §Problem.
- **Ship the runtime under `.runtime/`** and make generated files read their
  layout from variables (an earlier draft). It needs two path variables, and
  the runtime still travels with every copy of the app.
- **Regenerate in the mirror at publish:** correct, but publishing grows a
  staging repository, a toolchain and a commit amend.
- **A published shadow of mecha's fragments**, selected by a path-valued
  variable: the same switch, at the cost of copying mecha's directory layout
  into the app.
- **Compose mecha's targets into the app**, building them from a remote
  context: one variable for all of mecha, but bayt has no remote contexts. Its
  `#add` only downloads single files by checksum.
- **A `#From` arm holding a ref and a pinned image** (an earlier draft): it
  keeps the dep in bayt's graph, so the consumer needs mecha's manifests to
  generate, and the mirror has none.
- **golaberto as its own CUE module in the monorepo:** its imports would then
  resolve from the registry, so in the monorepo it would compile with released
  pronto while running HEAD's scripts.
- **A presence flag** (`MONOREPO=`, with `${V+a}${V-b}`): works, but needs the
  exact empty value, and `MONOREPO=1` silently yields `service:x1`.
- **The monorepo path in `service.yaml`**, a constant of the program: inert in
  the mirror, but a monorepo path in a generated file, unless copybara empties
  the file, which a byte-identical guard would then have to except.

## Rollout

1. **bayt:** name-keyed deps; keep `.bayt/.env`; `dir: "."` rooting a project
   at itself, generated in place by `--all` (all built).
   Gate: bayt's suites, and `just generate-all` changing nothing.
2. **mecha:** the image release, and its pins as CUE.
3. **pronto and golaberto:** the declared layout; golaberto a workspace,
   installed, its images by name with the switch; `mise.local.toml`,
   `.bayt/.env`, `.mirror/cue.mod`; tests importing from `.omnishell/`.
   Gate: golaberto's ladder in the monorepo against HEAD.
4. **mirror:** `installed_app` as in §7, and the gate of §9.

## As built (phase 3)

- sayt is reached through `saytw` and `saytw.ps1`, committed in the app as
  `sayt commit-wrappers` writes them; the monorepo's sayt tree carries no
  binary for `mise.local.toml` to put on PATH. The wrapper honours the pin, so
  the app's sayt is the release in both layouts.
- Replay is off for installed apps for now: in the monorepo its image would
  lack the module the program evaluates in and the runtime at HEAD.
- `prerender.ts` takes the terminal's root from its caller (`.omnishell` for an
  installed app); pronto no longer imports a monorepo sibling statically.
- Gaps the mirror test found and the releases fixed: bayt's launcher resolves
  its nu stub unlocked; `omnishell materialize` ships what `check-visual.ts`
  imports; a builder naming auto-bayt's priority kept its commands.

Open question 2 is moot: an installed app's check image carries `.omnishell/`
and no mecha tree.

## Open questions

1. Should facts hash the runtime's version rather than its bytes, so the
   mirror's lint can check them too?
2. `check-acceptance` copies mecha's whole tree into its image, not an image
   of it. It needs the same switch, with the installed or materialized tree as
   the default.
4. Includes of mecha's fragments ride `compose.includes`, whose files are
   meant to hold bare services. `mecha/service.yaml` includes instead, every
   entry `required: false`. If a mecha fragment includes files of its own, a
   flat list of services is the fallback.
