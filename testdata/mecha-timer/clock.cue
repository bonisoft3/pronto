package clock

import "github.com/bonisoft3/pronto"

#Count:   {type: "integer", min: 0, max: 1000}
#Instant: {type: "integer", min: 0, max: 9007199254740991}
#Clock: {
	count:      #Count
	turn_ms:    {type: "integer", min: 0, max: 600000}
	expired_at: #Instant
}

// A turn clock as XState writes one: entering `running` starts its `turn`
// timer, read off the context; leaving it cancels the timer, and only
// re-entering it starts the timer again.
machine~(M): pronto.#Machine & {
	config: {
		id:      "proof_clock"
		initial: "running"
		states: {
			running: {
				on: {
					nudge:   {actions: "count"}
					stay:    {target: "running", actions: "count"}
					restart: {target: "running", reenter: true, actions: "count"}
					stop:    {target: "idle"}
				}
				after: turn: [{guard: "never", target: "idle"}, {target: "expired", actions: "expire"}]
			}
			idle: on: start: {target: "running", actions: "count"}
			expired: type: "final"
		}
	}
	setup: {
		version:    1
		initialize: "initial"
		delays: turn: "turn_ms"
		guards: never: reads: []
		actions: {
			count: {reads: [], writes: ["count"]}
			expire: {reads: ["_time"], writes: ["expired_at"]}
		}
		types: {
			input: {type: "object", fields: turn_ms: #Clock.turn_ms}
			context: {type: "object", fields: #Clock}
			view: {type: "object", fields: {#Clock..., phase: {type: "string", maxLength: 8, values: ["running", "idle", "expired"]}}}
			events: {for event in ["nudge", "stay", "restart", "stop", "start"] {(event): {tier: "omnishell", payload: {type: "object", fields: {}}}}}
		}
	}
}

// What the compilers read.
reducer: (pronto.#Reducer & {machine: M}).out
