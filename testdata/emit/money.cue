// shell.yaml's schema carries a money field's currency, pinned: the column's
// own (an ISO 4217 code and its minor units) or each row's (the sibling field
// holding `{ISO 4217}_{decimals}`), so the terminal's money format and
// check-markup read it where they read every other column fact.
package emit

import (
	"encoding/json"

	pronto "github.com/bonisoft3/pronto"
)

_money: pronto.#App & {
	state: {
		entities: {
			Offer: {
				table:      "offer"
				durability: "server"
				fields: [
					{name: "id", type: "uuid", pk: true},
					{name: "rent", type: "int64", money: {currencyField: "rent_currency"}},
					{name: "rent_currency", type: "string"},
					{name: "deposit", type: "int32", money: {currency: "JPY", minorUnits: 0}},
				]
			}
		}
		pipelines: {}
	}
	capabilities: {hatches: {}, vendored: {}}
	surface: {
		screens: offers: {
			title:  "Offers"
			route:  "/"
			markup: "<main></main>"
			reads: [{table: "offer", kind: "live", nested: false, lists: [], route: "whole", clauses: [], embeds: [], orders: []}]
			forms: []
			states: []
		}
		handlers: {}
		design: {}
		flows: {}
	}
	meta: {
		name:        "emit"
		description: "the money fields"
		ir: sha256: ""
		targets: []
		clocks: []
		decisions: {}
		tests: {}
	}
}

moneyFields: [for f in (pronto.#shellConfig & {code: _money, migrations: []}).out.schema.offer.fields if f.money != _|_ {name: f.name, money: f.money}]

// Compared as JSON so a lost or widened declaration is a conflict.
moneyPinned: json.Marshal(moneyFields) & json.Marshal([
	{name: "rent", money: {currencyField: "rent_currency"}},
	{name: "deposit", money: {currency: "JPY", minorUnits: 0}},
])
