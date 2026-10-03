// A mirror holds the app at its root and the runtime under .runtime/, which
// program_pronto.cue states. Every path the emission names follows from that
// statement, so a build in the mirror regenerates what the sync wrote.
package emit

import (
	"list"
	pronto "github.com/bonisoft3/pronto"
)

_mirroredLoop: _loop & {surface: sources: pronto: ".runtime/plugins/pronto"}
_mirroredBuild: (pronto.#DefaultBuild & {code: _code, loop: _mirroredLoop, cluster: _cluster}).out & {meta: dir: ""}
_mirroredFiles: (pronto.#emit & {
	code:     _code
	cluster:  _cluster
	terminal: _terminal
	loop:     _mirroredLoop
	build:    _mirroredBuild
}).files

mirroredSiblings:   _mirroredLoop.surface.sources.mecha & ".runtime/libraries/mecha"
mirroredDirectory:  _mirroredBuild.project.dir & ""
mirroredContext:    _mirroredBuild.project.targets.integrate.compose.build.additional_contexts.root & ".."
mirroredVisualCopy: list.Contains(_mirroredBuild.project.targets.integrate.dockerfile.preamble, "COPY --from=root .runtime/plugins/omnishell /omnishell") & true
mirroredProtos:     _mirroredFiles["buf.yaml"].data.modules[0].excludes & [".runtime"]
// The sync rewrites the imports the facts hash, so only the monorepo holds them.
mirroredFacts: (_mirroredLoop.surface.checks.facts == _|_) & true
monorepoContext: (pronto.#DefaultBuild & {code: _code, loop: _loop, cluster: _cluster}).out.project.targets.integrate.compose.build.additional_contexts.root & "../../.."
_mirroredCluster: (pronto.#DefaultCluster & {code: _code, statics: [{file: ".runtime/plugins/omnishell/interpreter/shell.js", target: "/omnishell/interpreter/shell.js"}]}).out & {meta: {root: "", runtime: ".runtime/"}}
_mirroredCaddy: _mirroredCluster.surface.targets.caddy
mirroredCaddyContext: _mirroredCaddy.compose.build.additional_contexts.root & ".."
mirroredRuntimeStatic: list.Contains(_mirroredCaddy.dockerfile.copy, {from: name: "root", srcs: [".runtime/plugins/omnishell/interpreter/shell.js"], dst: "/omnishell/interpreter/shell.js"}) & true
monorepoCaddyContext: _cluster.surface.targets.caddy.compose.build.additional_contexts.root & "../../.."
mirroredName:      _mirroredBuild.project.name & "apps_\(_code.meta.name)"
