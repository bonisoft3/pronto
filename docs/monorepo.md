# Monorepo mode

A pronto app lives in two places: in the monorepo at `apps/<app>`, where it
runs against the platform's trees at HEAD, and in its mirror,
`bonisoft3/<app>`, where it runs against the releases it pins. Its generated
files are the same bytes in both. What differs is a handful of monorepo-only
files that Copybara leaves out, and what mise resolves the pinned tools to.
This page is the contract. The design that introduced it is
[[archive/2026-10-03-regenerable-mirror-design|golaberto's mirror is an installed app]].

## Two layouts, one set of files

The platform is pronto, omnishell, mecha, bayt and sayt, each released as a
mise tool and a CUE module. An app's `.mise.toml` pins the tools and
`mise.lock` locks them; bootstrap's generate writes both. They are the same in
both layouts.

`write.ts` writes `mise.local.toml` where pronto sits inside the app's CUE
module, which is the monorepo. It holds:

- **`path:` overrides** for the five tools, pointing at `../../plugins/pronto`,
  `../../plugins/omnishell`, `../../libraries/mecha`, `../../plugins/bayt`
  and `../../plugins/sayt`. mise layers the file over `.mise.toml`, and its
  `path:` versions win.
- **`MONOREPO_COMPOSE_MODE=service`**, the one switch for what cannot run a
  command (see [the switch](#images-the-switch)).
- **`BAYT_RUNTIME` and `COMPOSE_PROJECT_NAME`**: the checkout's bayt runtime
  and the per-checkout compose project.

Copybara's `installed_app` publishes `apps/<app>/**` at the mirror's root. It
leaves out `mise.local.toml`, `mise.local.lock` and `monorepo/service.yaml`,
stages `.mirror/cue.mod` as `cue.mod`, and rewrites CUE imports from
`bonisoft.org/{plugins,libraries}/<x>` to `github.com/bonisoft3/<x>`. It edits
no generated file.

## Commands find the platform with `mise where`

The platform is pronto, omnishell and mecha; apps run on mecha and omnishell,
and pronto compiles them. Nothing imports pronto as a library, tests included:
pronto emits files into the app or runs as a command. One rule resolves every
cross-tree module: **a command that runs code of another tree passes that
tree's own Deno config and lock, found as the command runs with `mise where
github:bonisoft3/<tree>`.** In the monorepo `mise where` resolves through
`mise.local.toml`'s `path:` override to the checkout's tree; in a mirror, to
the pinned release. The caller's own imports are relative or full `npm:` and
`jsr:` specifiers; the dependency's config maps its own name onto itself
(omnishell's `test/deno.json` maps `@bonisoft3/omnishell/` to `../`, mecha's
`packages/mecha-browser/cluster.deno.json` maps `@bonisoft3/mecha/` to
`../../`), so its specifiers resolve inside its own tree, wherever it sits.

Every generated command follows the rule, with `run-mise where` in a sayt rule
and `^mise where` beside the stack (`#Platform` in `platform.cue`). The build
verbs run pronto's scripts under `($pronto | path join deno.json)`, bundles
under `bundle/deno.json`, the compute check under mecha's
`services/compute/deno.json`. An app's test that imports omnishell runs under
omnishell's test harness, its `test/deno.json` and `test/deno.lock`, frozen
(`#Harness`):

```cue
loop: surface: checks: "screens": {
	verb: "test"
	cmds: ["\(pronto.#Harness.rule); deno test \(pronto.#Harness.flags) --allow-env --allow-read tests/screens.test.ts"]
}
build: checks: "ledger": {
	cmds: ["\(pronto.#Harness.check); deno test \(pronto.#Harness.flags) --allow-net --unsafely-ignore-certificate-errors=caddy tests/ledger.ts"]
}
```

which renders as

```
let omnishell = (^mise where github:bonisoft3/omnishell | str trim); deno test --config ($omnishell | path join test deno.json) --lock ($omnishell | path join test deno.lock) --frozen … tests/ledger.ts
```

The test imports `@bonisoft3/omnishell/test/screen-harness.ts` as omnishell's
own tests do, and `./platform.ts` re-exports what an app takes from the
harness. A test that imports mecha runs under mecha's cluster config the same
way (`#Platform & {tree: "mecha"}`). omnishell's test lock is the harness's
environment: an app test's `npm:` or `jsr:` import that the lock lacks is
added there, since omnishell owns the harness. A test that imports no
platform runs under the app's own `tests/deno.json` and `tests/deno.lock`,
frozen.

What an app's tests take from pronto is what pronto emitted: the compilers'
inputs in `.pronto/check-inputs.json`, each Mecha machine's step compiled as
PostgreSQL runs it in `.pronto/mecha-reducers.json`, stepped through
omnishell's `test/mecha-local.ts` and walked by `test/mecha-battery.ts`, and
the cluster's database image in `.pronto/cluster.json`.

The platform's trees reach one another the same way. omnishell pins mecha in
its `.mise.toml` like any consumer, and `mise.local.toml` points the pin at the
checkout; its data-plane bundle, `interpreter/vendor/mecha-client.js`, is a
build product of bayt's `bundle` target (`bundle:mecha-client` in
`package.json`), bundled from mecha's own `packages/client/omnishell-entry.ts`
under mecha's config at `mise where github:bonisoft3/mecha`, and is not
committed: the host verbs that import it build it first, and the mirror's
`cd.yml` builds it before its image and release. So an omnishell release needs
a mecha release that carries the entry, pinned first. The pin lags that
release: omnishell's `.mise.toml` names a mecha without the entry, so the
mirror's `cd.yml` fails at the bundle until mecha releases it and the pin and
`mise.lock` move. An app's host verbs build the bundle in the monorepo and
refuse an omnishell tree without it (`builders/bayt.cue`), since the terminal
would otherwise come up dead. An installed pronto contains its tree alone: a
module of its release imports nothing outside it, neither by a path nor by
the sibling names its `deno.json` maps, and the checkout-only harnesses are
the `#TestModules` of `distribution/config.cue` (`installed_test.ts`); which
of its tests read an app is in
[[component-contracts#the-platforms-dependency-graph|the dependency graph]].

### Integrity

`mise.lock` checksums each release's tarball, so it is what pins the
platform's bytes. `tests/deno.lock` records the `npm:` and `jsr:` graph of
the checks that run against it, and not the local files; a check under a
platform's config is held by that platform's lock. `apps/platform_pins.nu lock
<app>` writes the app's lock over the checkout's trees. `lock <app> --mirror`
adds the mirror's graph, from a copy of the app outside the repository whose
pins resolve to the releases. A frozen run accepts entries its graph does not
reach, so one lock serves both layouts.

## Images: the switch

`MONOREPO_COMPOSE_MODE` decides what a compose build context reads. Set, as in
`mise.local.toml`, `service:<name>` builds mecha's and omnishell's images, and
the `pronto-sources` view, from the checkout. Unset, as in a mirror,
`docker-image://<pin>` pulls the published image whose pin
`clusters/mecha.cue` holds. The app's images take the monorepo's layout under
the switch (`project.imageDir`), so `mise.local.toml`'s relative paths hold
inside them. `monorepo/service.yaml` includes the sibling compose fragments,
and `monorepo/docker-image.yaml` is its empty mirror counterpart.

An image mecha has not published yet builds in the monorepo alone. In a mirror
the context is `docker-image://unpublished.invalid/mecha-publishes-no-<svc>-image-yet`,
and the pull fails naming why. What a check image takes from omnishell is
its runtime image, mounted at `/omnishell`.

## The app's own workspace

An installed app is its own bayt workspace (`dir: "."`) in both layouts. bayt
roots it at itself, and a monorepo project cannot depend on it. Its CUE stays
in the monorepo's module and imports HEAD. The mirror's module,
`.mirror/cue.mod/module.cue`, declares `github.com/bonisoft3/<app>` and
requires the platform's modules at the releases that resolve them from the
registry. A pronto release can carry a tool version that lags its CUE module
([[../skills/pronto-turn/references/bootstrap|bootstrap]] says why). The two
pins are related, not equal: `apps/platform_pins.nu check` holds each
installed app's platform tools to what bootstrap writes, requires each in the
mirror's module within its major and no older than the tool. It also refuses
an app that reaches a platform it does not pin, by `@bonisoft3/` specifier or
by its mise tool's name (`mise where github:bonisoft3/<x>`) in a source or a
generated command.

## The escape rule

A mirror is the app alone. A path import or `new URL()` that lands outside
`apps/<app>` resolves only in the monorepo, whether it climbs with `../`, is
absolute, or is a `file:` URL. The exception is a path under the terminal's
home, `/omnishell/`, which the browser and the image serve. A generated
command that hands a tool a relative path outside the app, runs one, or `cd`s
into one, works only in the monorepo too, and so does a relative path in
`.mise.toml`, which mise evaluates on entering the mirror. A raw GitHub URL of
a platform names a tag that no lock holds to the release mise installs. All
are refused. `apps/platform_pins.nu check` refuses them on every
pull request that touches an app, the platform or the script (ci.yml's `pins`
job), import map targets and the commands in `bayt.json` and `.say.yaml`
included, and `check-mirror` again on the tree Copybara builds.

## Mirror lag

A mirror may lag the monorepo. An app can import a platform module its pinned
release lacks, and only the mirror waits. Pull request CI runs the checkout
only. `sync.yml` builds the tree it will push, using `.github/mirror_tree.sh`
(Copybara's `<app>_local` workflow on HEAD, cloned outside the monorepo). It
then refuses to publish until `.github/mirror_pins.sh` passes there. That
script runs `platform_pins.nu check-mirror`, which applies the escape rule,
installs deno and the platform releases the tree pins, and runs a frozen
`deno cache` of every locked check, each under the config and lock its
command names, or the `deno.lock` beside its config when a frozen run names
none, its `mise where` bindings evaluated in the mirror as the check
evaluates them: `tests/deno.lock`, omnishell's test lock for a test of the
screens, mecha's cluster lock for `retained-edge`, mecha's compute lock for
golaberto's computations. A tree none of whose checks run against a lock is
refused, since nothing would hold its imports; one held by the platforms'
locks alone carries no `tests/deno.lock`. A module only an unlocked tool
imports is resolved when that tool runs. To publish, release the platform,
bump the app's pins, and run `platform_pins.nu lock <app> --mirror`, which
writes `tests/deno.lock` alone.

## The host tier

`integrate@host` and `launch@host` run the stack as host processes rather than
containers, under `MISE_ENV=host`. The extra tools come from
`.mise.host.toml`, the roster bootstrap's `#Roster` renders, and
`mise.host.lock`, which bootstrap ships. Pull request CI runs
`integrate@host`, and `main` runs the container `integrate`. `platform_pins.nu
write` (in `just generate-all`) copies the roster and lock into each host app,
and `check` refuses a copy that differs.

## Rejected

- **Raw mirror URLs, rewritten by an import map.** Tests imported
  `https://raw.githubusercontent.com/bonisoft3/<x>/<tag>/…`. A generated
  `apps/deno.json` workspace mapped each tag to the checkout. That made two
  graphs to lock and a network fetch from GitHub in every mirror and check
  image. Tags also had to agree with three files, the app's ordinary
  `--config` reached nothing, and a module imported conditionally became a
  dynamic `import()`. mise already installs and checksums the same trees.
- **A workspace at `apps/`.** A workspace anchors every member's lock at its
  root and has one `nodeModulesDir`. The root's `package.json` needs it manual,
  and the members want none.
- **A directory of links to the platform (`.platform/`)**, made at setup by
  symlink or junction and mapped by the app's `tests/deno.json`. Symlinks do
  not exist on Windows, so junctions were a second code path; a link is a
  per-machine file that goes stale after a pin bump until setup runs again;
  and the trees' relative imports of one another held only because the links
  copied the monorepo's layout.
- **A per-machine Deno config written at setup.** Absolute paths would sit
  in the config itself, differ between host and image, and hide which modules
  the tests import. With `mise where` in the command, the config is committed
  and the same everywhere.
- **A wrapper per deno call** that resolves the platform and runs deno with
  the right config. It is one more file in every app saying what one line in
  the command says, and the pins check would have to read through it.
- **A self-contained "slice" release of pronto carrying omnishell and mecha.**
  It changes what `mise where github:bonisoft3/pronto` means for the hundreds
  of generated commands that run pronto's scripts, and duplicates two trees
  into a third release to pin.
- **Vendoring a dependency's bundle into the tree.** A committed
  `mecha-client.js` carried whichever mecha HEAD someone last bundled from,
  with a test to catch it going stale; a pin names the version and the
  build makes the file.
- **Copybara rewriting `tests/*.json`** to mise's install paths. The paths
  differ per machine. `/omnishell` in a check image is the runtime image,
  which omits the test harness. pronto's own modules reach omnishell
  relatively.
- **JSR, or pnpm `github:` dependencies.** JSR adds a registry account beside
  the git mirrors and the CUE registry. Deno refuses to strip types under
  `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`).
