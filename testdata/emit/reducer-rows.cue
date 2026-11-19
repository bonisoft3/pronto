// A bounded reducer beside a row machine, in a cluster that declares a target
// of its own: the build's stack sources, which read every cluster target,
// resolve, and the reducer's shapes with them.
package emit

import (
	"list"
	pronto "github.com/bonisoft3/pronto"
)

_reducing: _code & {
	state: {
		entities: Parcel: {
			table:      "parcel"
			durability: "server"
			fields: [
				{name: "id", type: "uuid", pk: true},
				{name: "stage", type: "text"},
			]
		}
		mecha: rows: parcel: {
			entity:  "Parcel"
			field:   "stage"
			initial: "packed"
			states: {
				packed: on: ship: "shipped"
				shipped: type: "final"
			}
		}
		mecha: reducers: tally: {rules: "machines/tally.js", machine: {
			config: {id: "tally", initial: "open", states: {open: on: close: {target: "closed"}, closed: type: "final"}}
			setup: {version: 1, types: {
				context: {type: "object", fields: {n: {type: "integer", min: 0, max: 9}}}
				view:    {type: "object", fields: {n: {type: "integer", min: 0, max: 9}}}
				events: close: {tier: "mecha", payload: {type: "object", fields: {}}}
			}}
		}}
	}
}

_reducingTerminal: (pronto.#DefaultTerminal & {code: _reducing}).out
_reducingCluster:  (pronto.#DefaultCluster & {code: _reducing, statics: []}).out
_reducingCluster: surface: targets: simulator: {
	cmd: "builtin": null
	activate: ""
	srcs: globs: ["simulator.json"]
	dockerfile: {
		from: name: "node:22"
		copy: [{srcs: ["simulator.json"], dst: "/data/simulator.json"}]
		cmd:  ["node"]
	}
	compose: restart: "on-failure"
}
_reducingLoop:  (pronto.#DefaultLoop & {code: _reducing, terminal: _reducingTerminal, cluster: _reducingCluster}).out
_reducingBuild: (pronto.#DefaultBuild & {code: _reducing, loop: _reducingLoop, cluster: _reducingCluster, terminal: _reducingTerminal}).out

reducerBesideRows: list.Contains(_reducingBuild.project.targets["ci-visual"].deps, ":simulator:srcs") & true
