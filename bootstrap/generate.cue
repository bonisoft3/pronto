package bootstrap

import (
	"encoding/yaml"
	"encoding/toml"
	"tool/file"

	"github.com/bonisoft3/pronto/distribution"
)

#Generate: G={
	_after: *[] | [...]
	project: distribution.#Project
	// Once a program exists write.ts owns .say.yaml: it unifies these rules
	// with the program's and the layout's sources. Written here too, the file
	// would hold the installed layout's rules until write.ts ran, and a write
	// failing in between left an app in the monorepo running them — which
	// declare the installed pronto in program_pronto.cue, a declaration every
	// later write keeps.
	program: file.Glob & {$after: G._after, glob: "program.cue"}
	if len(G.program.files) == 0 {
		say: file.Create & {$after: G.program, filename: ".say.yaml", contents: yaml.Marshal(G.project.say)}
	}
	mise: file.Create & {$after: G._after, filename: ".mise.toml", contents: toml.Marshal(G.project.mise)}
}
