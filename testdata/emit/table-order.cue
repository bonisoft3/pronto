// 005 creates a table after every table its fields reference, whatever order
// the program declares them in: a visit declared before the guest it
// references, and the guest before its zone, as ume-rental's request was
// declared before its app_user. A declared order that is already valid is
// kept as it is. What must be refused cannot sit in the package `cue vet`
// holds, so table-order.test.ts asks cue for the cases at the end: a cycle through
// the emitted 005, and the 128-table bound both ways.
package emit

import (
	"list"
	"strings"
	pronto "github.com/bonisoft3/pronto"
)

_ordered: _code & {
	state: entities: {
		Visit: {
			table:      "visit"
			durability: "live"
			fields: [
				{name: "id", type: "uuid", pk: true},
				{name: "guest_id", type: "uuid", ref: "guest"},
			]
		}
		Guest: {
			table:      "guest"
			durability: "live"
			fields: [
				{name: "id", type: "uuid", pk: true},
				{name: "zone_id", type: "uuid", ref: "zone"},
			]
		}
		// A reference to its own table asks nothing of the order.
		Note: {
			table:      "note"
			durability: "live"
			fields: [
				{name: "id", type: "uuid", pk: true},
				{name: "reply_to", type: "uuid", ref: "note", required: false},
			]
		}
		Zone: {
			table:      "zone"
			durability: "live"
			fields: [{name: "id", type: "uuid", pk: true}]
		}
	}
}

_orderedTerminal: (pronto.#DefaultTerminal & {code: _ordered}).out
_orderedCluster: (pronto.#DefaultCluster & {code: _ordered, statics: []}).out
_orderedLoop: (pronto.#DefaultLoop & {code: _ordered, terminal: _orderedTerminal, cluster: _orderedCluster}).out
_orderedBuild: (pronto.#DefaultBuild & {code: _ordered, loop: _orderedLoop, cluster: _orderedCluster, terminal: _orderedTerminal}).out
_orderedTables: (pronto.#emit & {
	code:     _ordered
	cluster:  _orderedCluster
	terminal: _orderedTerminal
	loop:     _orderedLoop
	build:    _orderedBuild
}).files["services/database/migrations/005_create_tables.sql"].text
_created: {for t in ["visit", "guest", "note", "zone"] {(t): strings.Index(_orderedTables, "CREATE TABLE IF NOT EXISTS \(t) (")}}

createdAfterReferenced: [_created.zone < _created.guest, _created.guest < _created.visit] & [true, true]

_entity: {
	#t: string
	#refs: [...string]
	table: #t
	fields: [{name: "id", type: "uuid", pk: true}, for r in #refs {name: "\(r)_id", type: "uuid", ref: r}]
}
_tablesOf: {in: [...], out: [for e in (pronto.#tableOrder & {entities: in}).out {e.table}]}

orderedByReference: (_tablesOf & {in: [
	_entity & {#t: "visit", #refs: ["guest"]},
	_entity & {#t: "guest", #refs: ["zone"]},
	_entity & {#t: "note", #refs: ["note"]},
	_entity & {#t: "zone"},
]}).out & ["note", "zone", "guest", "visit"]
orderKeptWhereValid: (_tablesOf & {in: [
	_entity & {#t: "zone"},
	_entity & {#t: "note"},
	_entity & {#t: "guest", #refs: ["zone"]},
	_entity & {#t: "visit", #refs: ["guest", "zone"]},
]}).out & ["zone", "note", "guest", "visit"]
// A cycle, through the emitter as 005 reads the order, once the test tags
// the hen as referencing the egg: untagged, `cue vet` sees no refusal.
_back: *"none" | string @tag(back)
_cyclic: _code & {state: entities: {
	Egg: {table: "egg", durability: "live", fields: [{name: "id", type: "uuid", pk: true}, {name: "hen_id", type: "uuid", ref: "hen"}]}
	Hen: {table: "hen", durability: "live", fields: [{name: "id", type: "uuid", pk: true}, {name: "egg_id", type: "uuid", ref: _back}]}
}}
_cyclicTerminal: (pronto.#DefaultTerminal & {code: _cyclic}).out
_cyclicCluster: (pronto.#DefaultCluster & {code: _cyclic, statics: []}).out
_cyclicLoop: (pronto.#DefaultLoop & {code: _cyclic, terminal: _cyclicTerminal, cluster: _cyclicCluster}).out
_cyclicBuild: (pronto.#DefaultBuild & {code: _cyclic, loop: _cyclicLoop, cluster: _cyclicCluster, terminal: _cyclicTerminal}).out
_cyclicTables: (pronto.#emit & {
	code:     _cyclic
	cluster:  _cyclicCluster
	terminal: _cyclicTerminal
	loop:     _cyclicLoop
	build:    _cyclicBuild
}).files["services/database/migrations/005_create_tables.sql"].text
// n tables, each referencing the next; the last references the first in a
// ring, and nothing in a chain.
#linked: {
	n:    int
	ring: bool
	out: (_tablesOf & {in: [for i in list.Range(0, n, 1) {
		_entity & {#t: "t\(i)", #refs: [if ring || i < n-1 {"t\(mod(i+1, n))"}]}
	}]}).out
}
