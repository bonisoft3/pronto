package race

import "github.com/bonisoft3/pronto"

#Count: {type: "integer", min: 0, max: 1000}

// A race as XState nests one: `racing` holds its own clock while its
// children, `open` and then `closing`, hold theirs, so the earlier of the
// two decides.
machine~(M): pronto.#Machine & {
	config: {
		id:      "proof_race"
		initial: "waiting"
		states: {
			waiting: on: start: "racing"
			racing: {
				initial: "open"
				on: lift: {actions: "lift"}
				after: "150000": {target: "abandoned", actions: "timeout"}
				states: {
					open: always: {guard: "finishing", target: "closing"}
					closing: after: "15000": {target: "#proof_race.abandoned", actions: "timeout"}
				}
			}
			abandoned: type: "final"
		}
	}
	setup: {
		version: 1
		guards: finishing: reads: []
		actions: {
			lift: {reads: [], writes: ["lifts"]}
			timeout: {reads: [], writes: ["timeouts"]}
		}
		types: {
			context: {type: "object", fields: {lifts: #Count, timeouts: #Count}}
			view: {type: "object", fields: {lifts: #Count, timeouts: #Count}}
			events: {
				start: {tier: "omnishell", payload: {type: "object", fields: {}}}
				lift: {tier: "omnishell", payload: {type: "object", fields: {}}}
			}
		}
	}
}

// What the compilers read.
reducer: (pronto.#Reducer & {machine: M}).out
