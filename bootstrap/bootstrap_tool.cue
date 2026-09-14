package bootstrap

import (
	"list"
	"tool/file"

	"github.com/bonisoft3/pronto/distribution"
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
		seed: file.Create & {
			$after:   B.directory
			filename: "pronto/config.cue"
			contents: """
				package prontoproject

				import "github.com/bonisoft3/pronto/distribution"

				pronto: distribution.#Project
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
		config: #Generate & {_after: B._after, project: distribution.#Project}
	}
}
