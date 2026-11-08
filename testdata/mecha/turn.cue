package proof

import "github.com/bonisoft3/pronto"

#Card: {type: "integer", min: 0, max: 39}
#Seat: {type: "string", maxLength: 1, values: ["a", "b"]}
#Cards: {type: "array", maxItems: 3, items: #Card}
#Play: {type: "object", fields: {seat: #Seat, card: #Card}}
#Plays: {type: "array", maxItems: 6, items: #Play}
#Phase: {type: "string", maxLength: 8, values: ["playing", "finished"]}

M=machine: pronto.#Machine & {
	config: {
		id:      "proof_turn"
		initial: "playing"
		states: {
			playing: on: {
				play: {guard: "mayPlay", actions: "play"}
				timeout: {guard: "isDue", actions: "timeout"}
				finish: {guard: "isComplete", target: "finished", actions: "finish"}
			}
			finished: type: "final"
		}
	}
	setup: {
		version: 1
		guards: {
			mayPlay: reads: ["now", "actor", "payload.card"]
			isDue: reads: ["now"]
			isComplete: reads: []
		}
		actions: {
			play: {reads: ["now", "payload.card"], writes: ["a", "b", "plays", "turn", "deadline"]}
			timeout: {reads: ["now"], writes: ["a", "b", "plays", "turn", "deadline"]}
			finish: {reads: [], writes: []}
		}
		types: {
			context: {
				type: "object"
				fields: {
					turn: #Seat
					a: #Cards
					b: #Cards
					plays: #Plays
					deadline: {type: "integer", min: 0, max: 9007199254740991}
				}
			}
			view: {
				type: "object"
				fields: {
					phase: #Phase
					turn: #Seat
					hand: #Cards
					opponent_count: {type: "integer", min: 0, max: 3}
					plays: #Plays
					deadline: {type: "integer", min: 0, max: 9007199254740991}
				}
			}
			events: {
				play: {tier: "omnishell", payload: {type: "object", fields: card: #Card}}
				timeout: {tier: "mecha", payload: {type: "object", fields: {}}}
				finish: {tier: "mecha", payload: {type: "object", fields: {}}}
			}
		}
	}
}

// What the compilers read.
reducer: (pronto.#Reducer & {machine: M}).out
