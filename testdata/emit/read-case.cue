// #readCase and #view, kept apart from read.cue's concrete assertions so
// file-mode `cue export` callers do not evaluate every assertion in read.cue.
package emit

import pronto "github.com/bonisoft3/pronto"

_readFields: [
	{name: "id", type: "uuid", pk: true},
	{name: "game_id", type: "uuid"},
	{name: "player_id", type: "uuid", ref: "player"},
	{name: "name", type: "string"},
	{name: "done", type: "bool"},
	{name: "at", type: "timestamp"},
	{name: "n", type: "int64"},
	{name: "on", type: "date"},
]

// Inputs a case leaves out are none, chosen by a guard rather than a default:
// a disjunction here is one the evaluator carries into every entity.
#readCase: {
	reads: [...pronto.#Read]
	writes?: [...pronto.#Write]
	goal?: {...}
	more?: {...}
	pipelines?: {...}
	rowMachines?: {...}
	route: *"/jogo/:id" | string
	app: pronto.#App & {
		state: {
			entities: {
				Goal: [if goal != _|_ {goal}, {table: "goal", durability: "live"}][0] & {fields: _readFields}
				Player: {table: "player", durability: "live", fields: _readFields}
				Note: {table: "note", durability: "live", access: {scope: "private", owner: "player_id"}, fields: _readFields}
				Draft: {table: "draft", durability: "tab", fields: [{name: "id", type: "uuid", pk: true}]}
				[if more != _|_ {more}, {}][0]
			}
			"mecha": rows: [if rowMachines != _|_ {rowMachines}, {}][0]
			"pipelines": [if pipelines != _|_ {pipelines}, {}][0]
		}
		capabilities: {hatches: {}, vendored: {}}
		surface: {
			screens: jogo: {
				title:   "Jogo"
				"route": route
				"reads": reads
				"writes": [if writes != _|_ {writes}, []][0]
				charts: []
				forms: []
				states: []
			}
			handlers: {}
			design: {}
			flows: {}
		}
		meta: {
			name:        "read"
			description: "the read rule"
			ir: sha256: ""
			targets: []
			clocks: []
			decisions: {}
			tests: {}
		}
	}
	out: app.#read.Goal
}

#view: pronto.#Read & {
	table:  *"goal" | string
	kind:   *"live" | _
	nested: *false | _
	lists: *[] | _
	route: *"view" | _
	clauses: *[{col: "game_id", op: "eq"}] | _
	embeds: *[] | _
	orders: *[] | _
}
_view: #view
