// #App.#writers, one entry per declaration that writes an entity: a form, the
// markup past it, a chart (named once however many screens carry it, and its
// effects never counted as the screen's), a pipeline's sink and a fold's
// pair, a computation, a mecha machine's own field and its effects. Two kinds
// on one entity unify into one list; nothing refuses them.
package emit

import pronto "github.com/bonisoft3/pronto"

_writersIdOnly: [{name: "id", type: "uuid", pk: true}]

_writersChart: {table: "game", field: "phase", writes: [{table: "goal", op: "update"}]}

_writersApp: pronto.#App & {
	state: {
		entities: {
			Game: {table: "game", durability: "live", fields: [{name: "id", type: "uuid", pk: true}, {name: "phase", type: "text"}]}
			Goal: {table: "goal", durability: "live", fields: [{name: "id", type: "uuid", pk: true}, {name: "game_id", type: "uuid"}, {name: "n", type: "int"}, {name: "w", type: "int64"}, {name: "gone", type: "bool"}]}
			Tally: {table: "tally", durability: "live", fields: _writersIdOnly}
			Pair: {table: "pair", durability: "live", access: {scope: "private", owner: "id"}, fields: _writersIdOnly}
			Count: {table: "count", durability: "server", fields: _writersIdOnly}
			Chance: {table: "chance", durability: "live", fields: _writersIdOnly}
			Payment: {table: "payment", durability: "server", fields: [{name: "id", type: "uuid", pk: true}, {name: "status", type: "text"}]}
		}
		pipelines: {
			tally: {from: "Goal", to: "Tally", key: "game_id", fold: {projects: "n", watermark: "w", dedupe: ["id"], retracted: "gone", pair: {table: "pair", counted: "counted", total: "total", asOf: "as_of"}}}
			count: {raw: true, note: "the authored pipeline owns the sink writes", from: "Goal", to: "Count", group: "count"}
		}
		computations: stats: {to: ["Chance"]}
		machines: PaymentMachine: {
			entity:  "Payment"
			field:   "status"
			initial: "pending"
			states: {
				pending: on: pay: {target: "paid", actions: {effect: {op: "create", table: "count", values: {id: "NEW.id"}}}}
				paid: type: "final"
			}
		}
	}
	capabilities: {hatches: {}, vendored: {}}
	surface: {
		screens: {
			// The form's create, a reduce no form said, and the chart's effect.
			board: {
				title: "Board"
				route: "/"
				reads: []
				writes: [{table: "goal", op: "create"}, {table: "goal", op: "reduce"}, {table: "goal", op: "update"}]
				charts: [_writersChart]
				forms: [{id: "new-goal", entity: "Goal", action: "create", fields: []}]
				states: []
			}
			// The same chart again: one `chart` entry, and no `screen` one.
			sheet: {
				title: "Sheet"
				route: "/sheet"
				reads: []
				writes: [{table: "goal", op: "update"}]
				charts: [_writersChart]
				forms: []
				states: []
			}
		}
		handlers: {}
		design: {}
		flows: {}
	}
	meta: {
		name:        "writers"
		description: "the writers rule"
		ir: sha256: ""
		targets: []
		clocks: []
		decisions: {}
		tests: {}
	}
}

_writers: _writersApp.state.entities

writersForm:        _writers.Goal.writers & [{by: "board", kind: "form", ops: ["create"]}, {by: "board", kind: "screen", ops: ["reduce"]}, {by: "Game-phase", kind: "chart", ops: ["update"]}]
writersChartOwnRow: _writers.Game.writers & [{by: "Game-phase", kind: "chart", ops: ["update"]}]
writersSink:        _writers.Tally.writers & [{by: "tally", kind: "pipeline", ops: ["upsert"]}]
writersPair:        _writers.Pair.writers & [{by: "tally", kind: "pipeline", ops: ["upsert"]}]
writersTwoKinds:    _writers.Count.writers & [{by: "count", kind: "hatch", ops: []}, {by: "PaymentMachine", kind: "machine", ops: ["create"]}]
writersComputation: _writers.Chance.writers & [{by: "stats", kind: "computation", ops: ["upsert"]}]
writersMachineRow:  _writers.Payment.writers & [{by: "PaymentMachine", kind: "machine", ops: ["update"]}]
