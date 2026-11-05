package emit

import pronto "github.com/bonisoft3/pronto"

#CompositionCase: pronto.#CortexComposition & {
	entities: Progress: {table: "progress"}
	root: {
		config: {
			id: "composition"
			meta: host: "omnishell"
			initial: "idle"
			states: idle: {}
		}
		setup: actors: {
			ProgressMachine: {
				via:      "mecha"
				lifetime: "row"
				machine: {
					config: {
						id:      "progress"
						initial: "running"
						meta: {host: "mecha", entity: "Progress", field: "status"}
						states: {running: on: settle: "done", done: {type: "final"}}
					}
					setup: actors: self: {via: "observe", machine: "ProgressMachine", match: {id: "id"}, event: "progress."}
				}
			}
			progress: {via: "observe", lifetime: "attachment", machine: "ProgressMachine", match: {id: "set_id", run: "run"}, event: "progress."}
			deleted: {via: "observe", table: "decks", match: {id: "set_id"}, missing: "removed"}
			rows: {
				via:      "rows"
				lifetime: "attachment"
				screen:   "board"
				charts: {
					form: {field: "status", initial: "idle", states: idle: {}}
					print: [
						{field: "paper", initial: "a4", states: a4: {}},
						{field: "orientation", initial: "portrait", states: portrait: {}},
					]
				}
			}
		}
	}
}

_composition: #CompositionCase
compositionProjectionKeys: [for name, _ in _composition.out {name}] & ["composition", "ProgressMachine"]
compositionBackendIdentity: (_composition.out.ProgressMachine == _composition.out.composition.setup.actors.ProgressMachine.machine) & true
compositionBackendConfig:   _composition.out.ProgressMachine.config & _composition.root.setup.actors.ProgressMachine.machine.config
compositionResolvedSource: _composition.out.composition.setup.actors.progress & {
	table:   "progress"
	field:   "status"
	machine: "ProgressMachine"
	match: {id: "set_id", run: "run"}
	...
}
compositionNestedSource: _composition.out.ProgressMachine.setup.actors.self & {table: "progress", field: "status", ...}
compositionDirectObservation:            (_composition.out.composition.setup.actors.deleted == _composition.root.setup.actors.deleted) & true
compositionRowLifetime:                  _composition.out.composition.setup.actors.rows.lifetime & "attachment"
compositionObservationLifetime:          _composition.out.composition.setup.actors.progress.lifetime & "attachment"
compositionObservationNoDefaultLifetime: (_composition.out.composition.setup.actors.deleted.lifetime == _|_) & true
compositionMultipleRowCharts:            len(_composition.out.composition.setup.actors.rows.charts.print) & 2

compositionRejectsUnknownMachine: ((#CompositionCase & {root: setup: actors: bad: {
	via: "observe", machine: "missing", match: {id: "id"}, event: "bad."
}}).out.composition.setup.actors.bad.table == _|_) & true
compositionRejectsNonMechaMachine: ((#CompositionCase & {root: setup: actors: bad: {
	via: "observe", machine: "rows", match: {id: "id"}, event: "bad."
}}).out.composition.setup.actors.bad.table == _|_) & true
compositionRejectsDuplicateKey: ((#CompositionCase & {
	root: setup: actors: composition: #CompositionCase.root.setup.actors.ProgressMachine
}).out == _|_) & true
compositionRejectsWrongLifetime: ((#CompositionCase & {
	root: setup: actors: ProgressMachine: lifetime: "attachment"
}).out == _|_) & true
compositionRejectsWrongHost: ((#CompositionCase & {
	root: setup: actors: ProgressMachine: machine: config: meta: host: "omnishell"
}).out == _|_) & true
compositionRejectsConflictingObservation: ((#CompositionCase & {
	root: setup: actors: progress: table: "wrong_table"
}).out.composition.setup.actors.progress.table == _|_) & true
