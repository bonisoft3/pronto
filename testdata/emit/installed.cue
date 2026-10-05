// An installed app takes mecha's images by name and resolves each through one
// switch: the pinned release unless MONOREPO_COMPOSE_MODE builds it from
// mecha's sources. No emitted path names the monorepo.
package emit

import (
	"list"
	pronto "github.com/bonisoft3/pronto"
	mecha "github.com/bonisoft3/pronto/clusters:mecha"
	omnishellTerminal "github.com/bonisoft3/pronto/terminals:omnishell"
)

// An installed terminal names its files from omnishell's root (omnishell mode).
_installedSurface: {runtime: "", interpreterRoot: "interpreter", componentsRoot: "components", markupReader: "read-markup.ts", documentRenderer: "render-documents.ts", documentConfig: "server/deno.json", machineSchema: "machine.cue"}
_installedTerm: (pronto.#DefaultTerminal & {code: _code}).out & {surface: _installedSurface}
_installedCluster: (pronto.#DefaultCluster & {code: _code, statics: _installedTerm.surface.statics, local: false}).out
_installedBuild: (pronto.#DefaultBuild & {code: _code, loop: _external, cluster: _installedCluster, terminal: _installedTerm}).out
_installedProject: _installedBuild.project
_installedFiles: (pronto.#emit & {
	code:     _code
	cluster:  _installedCluster
	terminal: _installedTerm
	loop:     _external
	build:    _installedBuild
}).files

installedImageName: _installedCluster.meta.images.database & {name: "libraries_mecha-database-image"}
installedFrom:      _installedProject.targets.database.dockerfile.from.name & "libraries_mecha-database-image"
installedContext:   _installedProject.targets.database.compose.build.additional_contexts["libraries_mecha-database-image"] & "${MONOREPO_COMPOSE_MODE:-docker-image://\(mecha.published.database)}${MONOREPO_COMPOSE_MODE:+:libraries_mecha-database-image}"
installedIncludes: _installedProject.compose.includes & ["mecha/${MONOREPO_COMPOSE_MODE:-docker-image}.yaml", "omnishell/${MONOREPO_COMPOSE_MODE:-docker-image}.yaml"]
installedService: list.Contains(_installedFiles["mecha/service.yaml"].data.include, "../${MONOREPO_MECHA_PATH}/.bayt/compose.database-image.yaml") & true
installedServiceCount: len(_installedFiles["mecha/service.yaml"].data.include) & 7
installedRoot:   _installedProject.targets.caddy.compose.build.additional_contexts.root & ".."
installedRootCompose: _installedFiles["compose.yaml"].data.include & [{path: "./.bayt/compose.yaml"}, {path: "mecha/${MONOREPO_COMPOSE_MODE:-docker-image}.yaml"}, {path: "omnishell/${MONOREPO_COMPOSE_MODE:-docker-image}.yaml"}]

// omnishell reaches the images as one image of its runtime tree, switched as
// mecha's are: caddy serves the terminal's statics from it, the visual check
// and every check's tests read it at /omnishell; nothing is copied into the app.
_omnishellContext: "${MONOREPO_COMPOSE_MODE:-docker-image://\(omnishellTerminal.published.runtime)}${MONOREPO_COMPOSE_MODE:+:plugins_omnishell-runtime-image}"
installedCaddyStatics: [for c in _installedProject.targets.caddy.dockerfile.copy if c.dst =~ "^/omnishell/" {c}] & []
installedCaddyShell: _installedProject.targets.caddy.dockerfile.defaultCopy["/omnishell/interpreter/shell.js"] & {from: name: "plugins_omnishell-runtime-image", srcs: ["interpreter/shell.js"]}
installedCaddyContext: _installedProject.targets.caddy.compose.build.additional_contexts["plugins_omnishell-runtime-image"] & _omnishellContext
installedVisual: list.Contains(_installedProject.targets.integrate.dockerfile.preamble, "COPY --from=plugins_omnishell-runtime-image / /omnishell") & true
installedVisualContext: _installedProject.targets.integrate.compose.build.additional_contexts & {"plugins_omnishell-runtime-image": _omnishellContext}
_installedChecked: (pronto.#DefaultBuild & {code: _code, loop: _external, cluster: _installedCluster, terminal: _installedTerm} & {out: checks: probe: {cmds: ["true"], note: "probe"}}).out.project
installedCheckOmnishell: _installedChecked.targets["check-probe"].dockerfile.copy & [{from: name: "plugins_omnishell-runtime-image", srcs: ["/"], dst: "/omnishell"}]
installedCheckContext: _installedChecked.targets["check-probe"].compose.build.additional_contexts["plugins_omnishell-runtime-image"] & _omnishellContext
installedNoCopy: [for k, t in _installedProject.targets if t != null && t.srcs != _|_ for g in t.srcs.globs if g =~ "omnishell" {k}] & []
installedOmnishellService: _installedFiles["omnishell/service.yaml"].data.include & ["../${MONOREPO_OMNISHELL_PATH}/.bayt/compose.runtime-image.yaml"]
installedOmnishellPulled: _installedFiles["omnishell/docker-image.yaml"].data & {}
installedPulled: _installedFiles["mecha/docker-image.yaml"].data & {}

// A local app keeps its cross-project refs and emits neither mode file.
localImageRef: _cluster.meta.images.database & {ref: "libraries_mecha:database-image"}
localNoIncludes: (pronto.#DefaultBuild & {code: _code, loop: _loop, cluster: _cluster}).out.project.compose.includes & []

// The replay image evaluates the program, whose module and runtime an
// installed app in the monorepo does not carry into images: off for now.
installedNoReplayTarget: (_installedProject.targets.replay == _|_) & true
installedNoReplayRule:   (_external.surface.checks.replay == _|_) & true
// Commands reach sayt through the wrapper the app commits, at its pin.
installedBuildCmd: _external.surface.buildCmd & "./saytw build"
localReplayTarget: ((pronto.#DefaultBuild & {code: _code, loop: _loop, cluster: _cluster}).out.project.targets.replay != _|_) & true
// The wrapper reaches the build image on the app's whole tree.
installedBuildWrapper: _installedProject.targets.build.srcs.defaultGlobs["pronto-tree"].glob & "**"

// An installed app type-checks pronto's own modules, not its tests, which
// import their siblings.
installedTypes:     _external.surface.checks.types.cmds[0] & =~"--exclude \\[\\*_test\\.ts \\*\\.test\\.ts\\]"
// An installed terminal's checks reach omnishell through the app's mise, not
// PATH: mise makes no shim for a `path:` version.
_installedTerminal: (pronto.#DefaultTerminal & {code: _code}).out.surface & {runtime: ""}
installedHandlers: _installedTerminal.checks.handlers.cmds[0] & "use tools.nu [run-mise]; run-mise exec -- omnishell check handlers ."

// An installed app's route rendered on request is served by omnishell's
// renderer, copied from the runtime image whose root is omnishell's, as the
// workspace's tree holds it; nothing of it is read from the app's directory.
_ssrApp: (#syncCase & {reads: [_view]}).app & {surface: screens: jogo: {ssr: "ssr", files: {handlers: [], adapters: []}}} & {capabilities: auth: {required: false, service: "/auth"}}
_ssrTerm: (pronto.#DefaultTerminal & {code: _ssrApp}).out & {surface: _installedSurface}
_ssrCluster: (pronto.#DefaultCluster & {code: _ssrApp, statics: _ssrTerm.surface.statics, local: false}).out
_ssrLoop: (pronto.#DefaultLoop & {code: _ssrApp, terminal: _ssrTerm, cluster: _ssrCluster}).out & {surface: sources: pronto: ""}
_ssrRender: (pronto.#DefaultBuild & {code: _ssrApp, loop: _ssrLoop, cluster: _ssrCluster, terminal: _ssrTerm}).out.project.targets.render
installedRenderCopy: [for c in _ssrRender.dockerfile.copy if c.from.name != _|_ if c.from.name == "plugins_omnishell-runtime-image" {"\(c.srcs[0]) \(c.dst)"}] & ["/interpreter /render/plugins/omnishell/interpreter", "/server /render/plugins/omnishell/server"]
installedRenderContext: _ssrRender.compose.build.additional_contexts & {"plugins_omnishell-runtime-image": _omnishellContext}
// An installed app's pages release installs its pinned tools first.
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
	loop:     _external
	build:    _installedBuild
}).files[".github/workflows/cd.yml"].text
installedPagesSetup: _pagesInstalled & =~"\n      - run: sayt setup\n      - run: sayt release@pages"
