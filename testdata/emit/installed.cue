// An app takes mecha's images by name and resolves each through one switch:
// the pinned release unless MONOREPO_COMPOSE_MODE builds it from mecha's
// sources. The monorepo is named only by the switch's own file, which a mirror
// never reads, and by bayt's imageDir, which the switch empties there.
package emit

import (
	"list"
	pronto "github.com/bonisoft3/pronto"
	mecha "github.com/bonisoft3/pronto/clusters:mecha"
	omnishellTerminal "github.com/bonisoft3/pronto/terminals:omnishell"
	core "github.com/bonisoft3/bayt/core:bayt"
)

_installedTerm: (pronto.#DefaultTerminal & {code: _code}).out & {surface: _installedSurface}
_installedCluster: (pronto.#DefaultCluster & {code: _code, statics: _installedTerm.surface.statics}).out
_installedBuild: (pronto.#DefaultBuild & {code: _code, loop: _loop, cluster: _installedCluster, terminal: _installedTerm}).out
_installedProject: _installedBuild.project
_installedSeats: {
	code:     _code
	cluster:  _installedCluster
	terminal: _installedTerm
	loop:     _loop
	build:    _installedBuild
}
_installedFiles: (pronto.#emit & _installedSeats).files

checkerInputVersion: _installedFiles[".pronto/check-inputs.json"].data.version & 1
checkerInputEntities: (_installedFiles[".pronto/check-inputs.json"].data.entities == _code.state.entities) & true
checkerInputHatches: (_installedFiles[".pronto/check-inputs.json"].data.hatches == _code.capabilities.hatches) & true
checkerInputRawMigrations: _installedFiles[".pronto/check-inputs.json"].data.rawMigrations & []
checkerInputDuckstreams: _installedFiles[".pronto/check-inputs.json"].data.duckstreams & {}

// The app is its repository's root in the monorepo as in its mirror, which
// receives these files unchanged; its images take the checkout's layout under
// the switch, so the views they copy land where mise.local.toml names them.
installedDirectory: _installedProject.dir & "."
installedImageDir:  _installedProject.imageDir & "${MONOREPO_COMPOSE_MODE:+apps/\(_code.meta.name)}"

installedImageName: _installedCluster.meta.images.database & {name: "libraries_mecha-database-image"}
installedFrom:    _installedProject.targets.database.dockerfile.from.name & "libraries_mecha-database-image"
installedContext: _installedProject.targets.database.compose.build.additional_contexts["libraries_mecha-database-image"] & "${MONOREPO_COMPOSE_MODE:-docker-image://\(mecha.published.database)}${MONOREPO_COMPOSE_MODE:+:libraries_mecha-database-image}"
installedIncludes: _installedProject.compose.includes & ["monorepo/${MONOREPO_COMPOSE_MODE:-docker-image}.yaml"]
// The switch's file names the monorepo's targets at the paths the checkout
// keeps them, spelled out: no variable relocates them. It is the checkout's,
// so no manifest a mirror copies records it.
_service: (pronto.#emit & _installedSeats).checkout["monorepo/service.yaml"].data.include
installedServiceUnrecorded: [if _installedFiles["monorepo/service.yaml"] == _|_ {true}, false][0] & true
installedService:      list.Contains(_service, "../../../libraries/mecha/.bayt/compose.database-image.yaml") & true
installedAirlock:      list.Contains(_service, "../../../libraries/mecha/.bayt/compose.airlock-image.yaml") & true
installedOmnishellService: list.Contains(_service, "../../../plugins/omnishell/.bayt/compose.runtime-image.yaml") & true
installedToolchainService: list.Contains(_service, "../../../.bayt/compose.pronto-sources.yaml") & true
installedServiceCount: len(_service) & 10
installedPulled:       _installedFiles["monorepo/docker-image.yaml"].data & {}
installedRoot:         _installedProject.targets.caddy.compose.build.additional_contexts.root & ".."
installedRootCompose: _installedFiles["compose.yaml"].data.include & [{path: "./.bayt/compose.yaml"}, {path: "monorepo/${MONOREPO_COMPOSE_MODE:-docker-image}.yaml"}]

// The toolchain the stages install is the runtime's tree in the monorepo: the
// root's view of it, copied where mise.local.toml's relative paths resolve; in
// a mirror the switch names an image with no /monorepo, and nothing is copied.
// Without it an image's mise found mise.local.toml naming paths it lacked.
_busyboxView: "${MONOREPO_COMPOSE_MODE:-docker-image://\(core.lock.images.busybox)}${MONOREPO_COMPOSE_MODE:+:workspaceroot-pronto-sources_srcs}"
// After the pinned install, so an edit to the tree leaves it cached; a
// second install resolves the path: tools without fetching.
installedToolchainCopy: _installedProject.targets.setup.dockerfile.epilogue & ["COPY --from=workspaceroot-pronto-sources_srcs /monorep[o] /monorepo/", "COPY [m]ise.local.toml ./", "RUN mise install"]
installedToolchainContext: _installedProject.targets.setup.compose.build.additional_contexts["workspaceroot-pronto-sources_srcs"] & _busyboxView

// A runner's RUN builds its stack inside, where the host's environment does
// not reach: the switch and bayt's runtime arrive as build args, the siblings'
// targets as views, and every mode's file, since a view carries only the one
// the outer build's mode named. Without them the inner stack pulled releases
// older than the tree it was meant to test.
_visualRunner: _installedProject.targets["ci-visual"]
installedRunnerSwitch: list.Contains(_visualRunner.dockerfile.preamble, "ENV MONOREPO_COMPOSE_MODE=$MONOREPO_COMPOSE_MODE") & true
installedRunnerArgs: _visualRunner.compose.build.args & {MONOREPO_COMPOSE_MODE: "${MONOREPO_COMPOSE_MODE:-}", BAYT_RUNTIME: "${BAYT_RUNTIME:-}"}
installedRunnerModes: [for c in _visualRunner.dockerfile.copy if c.srcs == ["monorepo/*.yaml"] {c.dst}] & ["./"]
installedRunnerViews: [for v in ["workspaceroot-pronto-sources_srcs", "libraries_mecha-database-image_srcs", "libraries_mecha-database-image_bayt", "plugins_omnishell-runtime-image_bayt"] {_visualRunner.dockerfile.defaultCopy[v] != _|_}] & [true, true, true, true]

// omnishell reaches the images as one image of its runtime tree, switched as
// mecha's are: the door's release is built from it, the visual check and every
// check's tests read it at /omnishell; nothing is copied into the app.
_omnishellContext: "${MONOREPO_COMPOSE_MODE:-docker-image://\(omnishellTerminal.published.runtime)}${MONOREPO_COMPOSE_MODE:+:plugins_omnishell-runtime-image}"
// A grouped copy lands each source under its `dst`, so the target is per source.
// The door serves the terminal from its release, and from nothing else.
installedCaddyStatics: [for c in _installedProject.targets.caddy.dockerfile.copy for f in c.srcs
	if [if c.parents != _|_ if c.parents {c.dst + f}, c.dst][0] =~ "^/omnishell/" {c.from.ref}] & [":served"]
installedServedRuntime: [for c in _installedProject.targets.served.dockerfile.copy if c.from != null if c.from.name != _|_ if c.from.name == "plugins_omnishell-runtime-image" {[c.srcs, c.dst]}] & [[["/"], "/omnishell"]]
installedServedContext: _installedProject.targets.served.compose.build.additional_contexts["plugins_omnishell-runtime-image"] & _omnishellContext
installedVisual:       list.Contains(_installedProject.targets.integrate.dockerfile.preamble, "COPY --from=plugins_omnishell-runtime-image / /omnishell") & true
installedVisualContext: _installedProject.targets.integrate.compose.build.additional_contexts & {"plugins_omnishell-runtime-image": _omnishellContext}
_installedChecked: (pronto.#DefaultBuild & {code: _code, loop: _loop, cluster: _installedCluster, terminal: _installedTerm} & {out: checks: probe: {cmds: ["true"], note: "probe"}}).out.project
installedCheckOmnishell: _installedChecked.targets["check-probe"].dockerfile.copy & [{from: name: "plugins_omnishell-runtime-image", srcs: ["/"], dst: "/omnishell"}]
installedCheckContext: _installedChecked.targets["check-probe"].compose.build.additional_contexts["plugins_omnishell-runtime-image"] & _omnishellContext
installedNoCopy: [for k, t in _installedProject.targets if t != null && t.srcs != _|_ for g in t.srcs.globs if g =~ "omnishell" {k}] & []

// Every app with a server replays its migrations inside ci-replay's RUN layer:
// process-compose brings the database up and runs replay against it.
installedReplayRule:   _loop.surface.checks.replay.cmds[0] & "use integrate.nu; integrate --bake --no-up --with-buildx --target ci-replay"
installedReplayAfter:  _installedProject.targets.replay.entrypoint.after.database & "healthy"
installedReplayRunner: _installedProject.targets["ci-replay"] & {
	dockerfile: from: ref: ":database"
	cmd: builtin: do: "process-compose --no-server -f .bayt/process-compose.yaml run replay"
}
// Commands reach sayt through the wrapper the app commits, at its pin.
installedBuildCmd: _loop.surface.buildCmd & "./saytw build"
// The wrapper reaches the build image on the app's whole tree.
installedBuildWrapper: _installedProject.targets.build.srcs.defaultGlobs["pronto-tree"].glob & "**"

// The app type-checks pronto's own modules, not its checkout-only ones, which
// import their siblings.
installedTypes: _loop.surface.checks.types.cmds[0] & =~"--exclude \\[\\*_test\\.ts \\*\\.test\\.ts hybrid-local\\.ts hybrid-battery\\.ts refresh-portable-types\\.ts\\]"
// The terminal's checks reach omnishell through the app's mise, not PATH:
// mise makes no shim for a `path:` version.
_installedTerminal: (pronto.#DefaultTerminal & {code: _code}).out.surface & {runtime: ""}
installedHandlers: _installedTerminal.checks.handlers.cmds[0] & "use tools.nu [run-mise]; run-mise exec -- omnishell check handlers ."

// A route rendered on request is served by omnishell's renderer, copied from
// the runtime image whose root is omnishell's, as the workspace's tree holds
// it; nothing of it is read from the app's directory.
_ssrApp: (#readCase & {reads: [_view]}).app & {surface: screens: jogo: {ssr: "ssr", files: {handlers: [], adapters: []}}} & {capabilities: auth: {required: false, service: "/auth"}}
_ssrTerm: (pronto.#DefaultTerminal & {code: _ssrApp}).out & {surface: _installedSurface}
_ssrCluster: (pronto.#DefaultCluster & {code: _ssrApp, statics: _ssrTerm.surface.statics}).out
_ssrLoop: (pronto.#DefaultLoop & {code: _ssrApp, terminal: _ssrTerm, cluster: _ssrCluster}).out
_ssrRender: (pronto.#DefaultBuild & {code: _ssrApp, loop: _ssrLoop, cluster: _ssrCluster, terminal: _ssrTerm}).out.project.targets.render
installedRenderCopy: [for c in _ssrRender.dockerfile.copy if c.from.name != _|_ if c.from.name == "plugins_omnishell-runtime-image" {"\(c.srcs[0]) \(c.dst)"}] & ["/interpreter /render/plugins/omnishell/interpreter", "/server /render/plugins/omnishell/server"]
installedRenderContext: _ssrRender.compose.build.additional_contexts & {"plugins_omnishell-runtime-image": _omnishellContext}
// The pages release installs its pinned tools first.
_pagesCode: pronto.#App & {
	for k, v in _code if k != "meta" {(k): v}
	meta: {
		for k, v in _code.meta if k != "targets" {(k): v}
		targets: ["pages"]
	}
}
_pagesInstalled: (pronto.#emit & {
	code:     _pagesCode
	cluster:  _installedCluster
	terminal: _installedTerm
	loop:     _loop
	build:    _installedBuild
}).files[".github/workflows/cd.yml"].text
installedPagesSetup: _pagesInstalled & =~"\n      - run: sayt setup\n      - run: sayt release@pages"
