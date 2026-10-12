package emit

import pronto "github.com/bonisoft3/pronto"

configSeats: {
	sources: (pronto.#emit & {code: _code, cluster: _cluster, terminal: _terminal, loop: _loop, build: _besideBuild}).loop.surface.sources
	build: _loop.surface.buildCmd
	terminal: (pronto.#DefaultTerminal & {code: _code, out: surface: runtime: "../../plugins/omnishell/runtime"}).out.surface.verbs.omnishell.cmds[0]
	installed: _external.surface.sayYaml
}
