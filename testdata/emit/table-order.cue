// 005 creates a table after every table its fields reference, whatever order
// the program declares them in: a visit declared before the guest it
// references, and the guest before its zone, as ume-rental's request was
// declared before its app_user. A declared order that is already valid is
// kept as it is, and a cycle across tables is refused.
package emit

import (
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
cycleRefused: ((_tablesOf & {in: [
	_entity & {#t: "egg", #refs: ["hen"]},
	_entity & {#t: "hen", #refs: ["egg"]},
]}).out == _|_) & true
