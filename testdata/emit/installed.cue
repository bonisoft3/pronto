// An installed app takes mecha's images by name and resolves each through one
// switch: the pinned release unless MONOREPO_COMPOSE_MODE builds it from
// mecha's sources. No emitted path names the monorepo.
package emit

import (
	"list"
	pronto "github.com/bonisoft3/pronto"
	mecha "github.com/bonisoft3/pronto/clusters:mecha"
)

_installedCluster: (pronto.#DefaultCluster & {code: _code, statics: [], local: false}).out
_installedBuild: (pronto.#DefaultBuild & {code: _code, loop: _external, cluster: _installedCluster}).out
_installedProject: _installedBuild.project
_installedFiles: (pronto.#emit & {
	code:     _code
	cluster:  _installedCluster
	terminal: _terminal
	loop:     _external
	build:    _installedBuild
}).files

installedImageName: _installedCluster.meta.images.database & {name: "libraries_mecha-database-image"}
installedFrom:      _installedProject.targets.database.dockerfile.from.name & "libraries_mecha-database-image"
installedContext:   _installedProject.targets.database.compose.build.additional_contexts["libraries_mecha-database-image"] & "${MONOREPO_COMPOSE_MODE:-docker-image://\(mecha.published.database)}${MONOREPO_COMPOSE_MODE:+:libraries_mecha-database-image}"
installedIncludes: _installedProject.compose.includes & ["mecha/${MONOREPO_COMPOSE_MODE:-docker-image}.yaml"]
installedService: list.Contains(_installedFiles["mecha/service.yaml"].data.include, "../${MONOREPO_MECHA_PATH}/.bayt/compose.database-image.yaml") & true
installedServiceCount: len(_installedFiles["mecha/service.yaml"].data.include) & 7
installedRoot:   _installedProject.targets.caddy.compose.build.additional_contexts.root & ".."
installedRootCompose: _installedFiles["compose.yaml"].data.include & [{path: "./.bayt/compose.yaml"}, {path: "mecha/${MONOREPO_COMPOSE_MODE:-docker-image}.yaml"}]
// A check's tests import omnishell's materialized tree, so its image carries it.
_installedChecked: (pronto.#DefaultBuild & {code: _code, loop: _external, cluster: _installedCluster} & {out: checks: probe: {cmds: ["true"], note: "probe"}}).out.project
installedCheckOmnishell: list.Contains(_installedChecked.targets["check-probe"].srcs.globs, ".omnishell/**") & true
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
installedBuildWrapper: list.Contains(_installedProject.targets.build.srcs.globs, "saytw") & true

// An installed app prerenders with the terminal materialized beside it, and
// type-checks pronto's own modules, not its tests, which import its siblings.
_prerendered: _code & {surface: screens: board: prerender: true}
_prerenderedLoop: (pronto.#DefaultLoop & {code: _prerendered, terminal: (pronto.#DefaultTerminal & {code: _prerendered}).out, cluster: (pronto.#DefaultCluster & {code: _prerendered, statics: []}).out}).out & {surface: sources: pronto: ""}
installedPrerender: _prerenderedLoop.surface.checks.prerender.cmds[0] & =~"prerender\\.ts\\) \\. \\$out https://localhost:8443 \\.omnishell;"
installedTypes:     _external.surface.checks.types.cmds[0] & =~"--exclude \\[\\*_test\\.ts \\*\\.test\\.ts\\]"
