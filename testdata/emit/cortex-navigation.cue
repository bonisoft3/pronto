package emit

import pronto "github.com/bonisoft3/pronto"

_navigationCode: _code & {
	state: cortex: navigation: {
		config: {
			id: "navigation"
			meta: host: "omnishell"
			initial: "idle"
			on: "route:board": {target: ".board", reenter: true}
			states: {
				idle: {}
				board: {
					initial: "loading"
					states: {
						loading: invoke: {src: "activate", onDone: "ready", onError: "failed"}
						ready: {}
						failed: {}
					}
				}
			}
		}
		setup: actors: activate: via: "navigation"
	}
}
_navigationShell: (pronto.#shellConfig & {code: _navigationCode, migrations: [], server: true, native: false}).out
navigationConfig: _navigationShell.cortex.config & _navigationCode.state.cortex.navigation.config
navigationActor:  _navigationShell.cortex.actors.activate.via & "navigation"

navigationRejectsUnknownHost: ((pronto.#CortexMachine & {
	config: {id: "invalid_host", initial: "idle", states: idle: {}, meta: host: "mech"}
}).config.meta.host == _|_) & true

navigationRejectsTerminalQuery: ((pronto.#CortexMachine & {
	config: {id: "query_on_terminal", initial: "idle", states: idle: {}, meta: host: "omnishell"}
	setup: actors: query: {via: "query", event: "facts", select: "SELECT 1"}
}).config.meta.host == _|_) & true
