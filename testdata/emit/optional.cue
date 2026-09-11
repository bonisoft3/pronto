// shell.yaml's optional-column list, pinned: each local table names its
// `required: false` columns with their types, in declaration order, and a
// local table with none and a server table with some are both left out.
package emit

import (
	"encoding/json"

	pronto "github.com/bonisoft3/pronto"
)

_code: pronto.#App & {
	state: {
		entities: {
			Game: {
				table:      "game"
				durability: "device"
				fields: [
					{name: "id", type: "text", pk: true},
					{name: "status", type: "text"},
					{name: "result", type: "text", required: false},
					{name: "opening", type: "text", required: false},
					{name: "rung", type: "int", required: false},
				]
			}
			Square: {
				table:      "square"
				durability: "tab"
				fields: [
					{name: "id", type: "text", pk: true},
					{name: "piece", type: "text"},
				]
			}
			Profile: {
				table:      "profile"
				durability: "server"
				fields: [
					{name: "id", type: "uuid", pk: true},
					{name: "bio", type: "text", required: false},
				]
			}
		}
		pipelines: {}
	}
	capabilities: {hatches: {}, vendored: {}}
	surface: {
		screens: board: {
			title:  "Board"
			route:  "/"
			markup: "<main></main>"
			reads: [{entity: "Game"}, {entity: "Square"}, {entity: "Profile"}]
			forms: []
			states: []
		}
		handlers: {}
		design: {}
		flows: {}
	}
	meta: {
		name:        "emit"
		description: "the optional-column list"
		ir: sha256: ""
		tiers: []
		clocks: []
		decisions: {}
		tests: {}
	}
}

optional: (pronto.#shellConfig & {code: _code, migrations: []}).out.optional

// Compared as JSON so an extra table or column is a conflict, not a widening.
pinned: json.Marshal(optional) & json.Marshal({game: [
	{name: "result", type: "text"},
	{name: "opening", type: "text"},
	{name: "rung", type: "int"},
]})
