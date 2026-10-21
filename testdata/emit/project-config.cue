package emit

import bayt "github.com/bonisoft3/bayt/core:bayt"

configSeats: {
	generate: _loop.surface.sayYaml.say.generate.rulemap.pronto.cmds[0].do
	build:    _loop.surface.sayYaml.say.build.do
	terminal: _terminal.surface.verbs.omnishell.cmds[0]
	generateDockerfile: (#ConfigTargetDockerfile & {name: "generate"}).out
	buildDockerfile: (#ConfigTargetDockerfile & {name: "build"}).out
	checkDockerfile: (bayt.#render & {
		project: {
			name: "source-check"
			dir:  "apps/emit"
			targets: check: {
				deps: []
				srcs: globs: ["tests/**"]
				dockerfile: {
					from: name: "alpine"
					preamble: _besideTargets["check-plain"].dockerfile.preamble
					copy:     _besideTargets["check-plain"].dockerfile.copy
				}
				compose: build: additional_contexts: _besideTargets["check-plain"].compose.build.additional_contexts
			}
		}
		depManifests: {}
	}).docker.dockerfiles.check
}

#ConfigTargetDockerfile: C={
	name!:   "generate" | "build"
	_target: _besideTargets[C.name]
	out: (bayt.#render & {
		project: {
			name: "source-\(C.name)"
			dir:  "apps/emit"
			targets: (C.name): {
				deps: []
				activate: C._target.activate
				cmd:      C._target.cmd
				dockerfile: from: name: "alpine"
			}
		}
		depManifests: {}
	}).docker.dockerfiles[C.name]
}
