package emit

import (
	pronto "github.com/bonisoft3/pronto"
	bayt "github.com/bonisoft3/bayt/core:bayt"
)

configSeats: {
	mirroredImportRoot: mirroredCheckImportRoot
	sources: (pronto.#emit & {code: _code, cluster: _cluster, terminal: _terminal, loop: _loop, build: _besideBuild}).loop.surface.sources
	build: _loop.surface.buildCmd
	terminal: (pronto.#DefaultTerminal & {code: _code, out: surface: runtime: "../../plugins/omnishell/runtime"}).out.surface.verbs.omnishell.cmds[0]
	installed: _external.surface.sayYaml
	buildDockerfile: (bayt.#render & {
		project: {
			name: "source-writer"
			dir: "apps/emit"
			targets: build: {
				deps: []
				activate: _besideTargets.build.activate
				cmd: _besideTargets.build.cmd
				dockerfile: from: name: "alpine"
			}
		}
		depManifests: {}
	}).docker.dockerfiles.build
	checkDockerfile: (bayt.#render & {
		project: {
			name: "source-check"
			dir: "apps/emit"
			targets: check: {
				deps: []
				srcs: globs: ["tests/**"]
				dockerfile: {
					from: name: "alpine"
					preamble: _besideTargets["check-plain"].dockerfile.preamble
					copy: _besideTargets["check-plain"].dockerfile.copy
				}
				compose: build: additional_contexts: _besideTargets["check-plain"].compose.build.additional_contexts
			}
		}
		depManifests: {}
	}).docker.dockerfiles.check
}
