// Four screens, each the smallest working instance of the idioms a pure pronto
// app is made of. Every entity is `tab`, `device` or below: the whole app runs
// in one browser tab, and the same rows, clicks, seed and clock replay the same
// screens. See AGENTS.md at pronto's root for the rules these instantiate.
@extern(embed)

package idioms

import (
	"list"

	pronto "github.com/bonisoft3/pronto"
)

_designMd:   _ @embed(file="DESIGN.md", type=text)
_catalogues: _ @embed(glob="messages/*.json")

code: pronto.#App & {
	state: entities: {
		// A seeded singleton. The id is minted once and never changes; ordinals,
		// not names, are what a field is keyed on, so a rename is a new field.
		Counter: {
			id: "0xcaba350e763103ab"
			table:      "counter"
			durability: "tab"
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true, cel: "this == 'counter'"},
				{ordinal: 2, name: "n", type: "int32", cel: "this >= -99 && this <= 99"},
			]
			seed: [{id: "counter", n: 0}]
		}
		// `device` survives a reload in this browser. Promoting it to `server`
		// is this one word; the tables, policies and sync derive from it.
		Todo: {
			id: "0xe2cd3e83dbf7849b"
			table:      "todo"
			durability: "device"
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true},
				{ordinal: 2, name: "title", type: "string", cel: "this.size() >= 1 && this.size() <= 80"},
				{ordinal: 3, name: "done", type: "string", cel: "this in ['no', 'yes']"},
				{ordinal: 4, name: "created", type: "timestamp"},
			]
		}
		// The row id is the datum: a click on "r2c3" says which light, because a
		// click carries nothing but the row's id and the element's.
		Light: {
			id: "0xba1a0e0de5f050ad"
			table:      "light"
			durability: "tab"
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true, cel: "this.matches('^r[0-4]c[0-4]$')"},
				{ordinal: 2, name: "on", type: "string", cel: "this in ['no', 'yes']"},
			]
			// CUE computes the seed: a plus sign lit on a dark 5×5 board.
			seed: list.FlattenN([for r in list.Range(0, 5, 1) {
				[for c in list.Range(0, 5, 1) {
					id: "r\(r)c\(c)"
					on: [if r == 2 || c == 2 {"yes"}, "no"][0]
				}]
			}], 1)
		}
		Board: {
			id: "0xfbbda7d72c8e787f"
			table:      "board"
			durability: "tab"
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true, cel: "this == 'board'"},
				{ordinal: 2, name: "moves", type: "int32", cel: "this >= 0"},
				{ordinal: 3, name: "lit", type: "int32", cel: "this >= 0 && this <= 25"},
			]
			seed: [{id: "board", moves: 0, lit: 9}]
		}
		// One machine owns `run`; nothing else writes it.
		Clock: {
			id: "0xc1fbce4f0e610a76"
			table:      "clock"
			durability: "tab"
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true, cel: "this == 'clock'"},
				{ordinal: 2, name: "n", type: "int32", cel: "this >= 0"},
				{ordinal: 3, name: "run", type: "string", cel: "this in ['paused', 'running']"},
				{ordinal: 4, name: "face", type: "int32", cel: "this >= 1 && this <= 6"},
			]
			seed: [{id: "clock", n: 0, run: "paused", face: 1}]
		}
	}

	capabilities: {
		blobs: false
		hatches: {}
		vendored: {}
	}

	surface: {
		screens: {
			counter: {title: "Counter", route: "/", label: "nav_counter", states: ["populated"], paths: {count: {states: ["populated", "populated"], accepts: ["accept-count"]}}}
			todo: {title: "Todo", route: "/todo", label: "nav_todo", states: ["empty", "populated"], paths: {add: {states: ["empty", "populated"], accepts: ["accept-todo"]}}}
			grid: {title: "Lights out", route: "/grid", label: "nav_grid", states: ["populated"], paths: {press: {states: ["populated", "populated"], accepts: ["accept-grid"]}}}
			timer: {title: "Timer", route: "/timer", label: "nav_timer", states: ["populated"], paths: {run: {states: ["populated", "populated"], accepts: ["accept-timer"]}}}
		}
		// Handlers and flows are derived from the markup that names them; declaring one
		// here is a promise ir.html must keep with an element of its own.
		handlers: {}
		design: (pronto.#DesignMd & {text: _designMd}).design
		flows: {}
	}

	meta: {
		name:        "idioms"
		description: "The smallest working instance of each idiom a pure pronto app is made of."
		ir: {sha256: "d70a431fc874c361dfb39ad593e67a31688a785b3f588af86b4e582f1e2ec31b"}
		targets: ["pages"]
		i18n: {
			default: "en"
			locales: {
				"en": path:    "en"
				"pt-BR": path: "pt-br"
			}
			catalogues: _catalogues
		}
		decisions: {"decision-escape-hatches": {}}
		tests: {}
	}
}

cluster:  (pronto.#DefaultCluster & {"code": code, statics: terminal.surface.statics}).out
terminal: (pronto.#DefaultTerminal & {"code": code}).out
loop:     (pronto.#DefaultLoop & {"code": code, "cluster": cluster, "terminal": terminal}).out

loop: surface: checks: "unit": {
	verb: "test"
	cmds: ["deno test --allow-read tests/handlers.test.ts"]
	note: "each handler file is a value: evaluated, called with rows and an event, and its updates compared"
}

build: (pronto.#DefaultBuild & {"code": code, "loop": loop, "cluster": cluster, "terminal": terminal}).out
out:   pronto.#emit & {"code": code, "cluster": cluster, "terminal": terminal, "loop": loop, "build": build}
