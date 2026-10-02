// A program with a computation, pinned where lint loads its module: the
// service loads every computation at startup and dies on one SES's
// Compartment refuses, so lint loads each the same way first.
package emit

import "strings"
import pronto "github.com/bonisoft3/pronto"

_computed: _code & {
	state: {
		entities: Chance: {
			table:      "chance"
			durability: "live"
			fields: [{name: "id", type: "uuid", pk: true}, {name: "odds", type: "int"}]
		}
		computations: chances: to: ["Chance"]
	}
}

_computedLoop: (pronto.#DefaultLoop & {
	code:     _computed
	terminal: (pronto.#DefaultTerminal & {code: _computed}).out
	cluster: (pronto.#DefaultCluster & {code: _computed, statics: []}).out
}).out
_admit: _computedLoop.surface.checks.admit

admitLints:       _admit.verb & "lint"
admitLoadsModule: strings.HasSuffix(_admit.cmds[0], #"admit.ts) "computations/chances.js""#) & true
admitUnderPins:   strings.Contains(_admit.cmds[0], "services compute deno.json") & true
