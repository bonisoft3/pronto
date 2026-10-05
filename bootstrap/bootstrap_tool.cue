package bootstrap

import (
	"list"
	"tool/file"

	"github.com/bonisoft3/pronto/distribution"
	terminal "github.com/bonisoft3/pronto/terminals:omnishell"
	"github.com/bonisoft3/pronto/clusters:mecha"
	"github.com/bonisoft3/pronto/builders:bayt"
)

command: bootstrap: B={
	existing: {
		for name in ["pronto", ".say.yaml", ".mise.toml"] {
			(name): file.Glob & {glob: name}
		}
	}
	_matches: list.Concat([for _, scan in B.existing {scan.files}])
	_after: [B.existing.pronto, B.existing[".say.yaml"], B.existing[".mise.toml"]]
	if len(_matches) > 0 {
		occupied: "bootstrap requires absent seed and configuration files" & false
	}
	if len(_matches) == 0 {
		directory: file.Mkdir & {$after: B._after, path: "pronto"}
		// The default roster in one file: Pronto itself plus the seats a
		// brief's harness names when it names none (terminal omnishell,
		// cluster mecha, build bayt; the loop is sayt itself), so the
		// first lock, install, and generate already see the whole
		// toolchain. One file, stated once, in the same order as the
		// `config` below: the same value either way (CUE orders the
		// unified keys by composition, so the first regeneration may only
		// reorder — semantically identical, stable thereafter). To take
		// another implementation, replace its line here — or split the
		// seats into files, which unifies the same way.
		seed: file.Create & {
			$after:   B.directory
			filename: "pronto/config.cue"
			contents: """
				package prontoproject

				import (
					"github.com/bonisoft3/pronto/distribution"
					terminal "github.com/bonisoft3/pronto/terminals:omnishell"
					"github.com/bonisoft3/pronto/clusters:mecha"
					"github.com/bonisoft3/pronto/builders:bayt"
				)

				pronto: distribution.#Project & terminal.#Project & mecha.#Project & bayt.#Toolchain
				"""
		}
		tool: file.Create & {
			$after:   B.directory
			filename: "pronto/generate_tool.cue"
			contents: """
				package prontoproject

				import "github.com/bonisoft3/pronto/bootstrap"

				command: generate: bootstrap.#Generate & {project: pronto}
				"""
		}
		config: #Generate & {_after: B._after, project: distribution.#Project & terminal.#Project & mecha.#Project & bayt.#Toolchain}
	}
}
