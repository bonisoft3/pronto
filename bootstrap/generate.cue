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
	say: file.Create & {$after: G._after, filename: ".say.yaml", contents: yaml.Marshal(G.project.say)}
	mise: file.Create & {$after: G._after, filename: ".mise.toml", contents: toml.Marshal(G.project.mise)}
}
