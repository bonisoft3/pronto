// A chart's column, pinned: its initial is the column's DEFAULT and its states
// the column's CHECK, in the table and in the bundle's schema, whether the
// chart names its entity by name or by table. Each column looks its chart up
// in the program's one map (#App._machineColumns), never walking the machines
// itself: that walk handed every column a copy of every machine.
package emit

import (
	"strings"
	pronto "github.com/bonisoft3/pronto"
)

_charted: _code & {
	state: {
		entities: {
			Parcel: {
				table:      "parcel"
				durability: "live"
				fields: [
					{name: "id", type: "uuid", pk: true},
					{name: "stage", type: "text"},
					{name: "note", type: "text"},
				]
			}
			Courier: {
				table:      "courier"
				durability: "live"
				fields: [
					{name: "id", type: "uuid", pk: true},
					{name: "shift", type: "text"},
				]
			}
		}
		machines: {
			parcel: {
				entity:  "Parcel"
				field:   "stage"
				initial: "packed"
				states: {
					packed: on: ship: "shipped"
					shipped: on: deliver: "delivered"
					delivered: type: "final"
				}
			}
			courier: {
				entity:  "courier"
				field:   "shift"
				initial: "off"
				states: {
					off: on: start: "on"
					on: on: stop: "off"
				}
			}
		}
	}
	surface: screens: depot: {
		title:  "Depot"
		route:  "/depot"
		markup: "<main></main>"
		reads: [
			{table: "parcel", kind: "live", nested: false, lists: [], route: "whole", clauses: [], embeds: [], orders: []},
			{table: "courier", kind: "live", nested: false, lists: [], route: "whole", clauses: [], embeds: [], orders: []},
		]
		forms: []
		states: []
	}
}

_chartedTerminal: (pronto.#DefaultTerminal & {code: _charted}).out
_chartedCluster: (pronto.#DefaultCluster & {code: _charted, statics: []}).out
_chartedLoop: (pronto.#DefaultLoop & {code: _charted, terminal: _chartedTerminal, cluster: _chartedCluster}).out
_chartedBuild: (pronto.#DefaultBuild & {code: _charted, loop: _chartedLoop, cluster: _chartedCluster, terminal: _chartedTerminal}).out
_chartedFiles: (pronto.#emit & {
	code:     _charted
	cluster:  _chartedCluster
	terminal: _chartedTerminal
	loop:     _chartedLoop
	build:    _chartedBuild
}).files
_chartedTables: _chartedFiles["services/database/migrations/005_create_tables.sql"].text
_chartedSchema: _chartedFiles["shell/shell.json"].data.schema

chartByName: strings.Contains(_chartedTables, "\"stage\" TEXT DEFAULT 'packed' NOT NULL CHECK (\"stage\" IN ('packed', 'shipped', 'delivered'))") & true
chartByTable: strings.Contains(_chartedTables, "\"shift\" TEXT DEFAULT 'off' NOT NULL CHECK (\"shift\" IN ('off', 'on'))") & true
// A column no chart owns keeps no DEFAULT and no CHECK.
unchartedColumn: strings.Contains(_chartedTables, "\"note\" TEXT NOT NULL,") & true
chartSchemaByName: [for f in _chartedSchema.parcel.fields if f.name == "stage" {f}][0] & {defaulted: true, default: "packed", enum: ["packed", "shipped", "delivered"], ...}
chartSchemaByTable: [for f in _chartedSchema.courier.fields if f.name == "shift" {f}][0] & {defaulted: true, default: "off", enum: ["off", "on"], ...}
