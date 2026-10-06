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

// Released to pages, the page runs no computation, so the release settles the
// cluster and ships its live tables before it bundles; with no stream the
// derive names none, and the bundle reads what it wrote.
_paged: pronto.#App & {
	for k, v in _computed if k != "meta" {(k): v}
	meta: {
		for k, v in _computed.meta if k != "targets" {(k): v}
		targets: ["pages"]
	}
}
_pages: (pronto.#DefaultLoop & {
	code:     _paged
	terminal: (pronto.#DefaultTerminal & {code: _paged}).out
	cluster: (pronto.#DefaultCluster & {code: _paged, statics: []}).out
}).out.surface.verbs.pages
pagesDerivesFirst:  strings.Contains(_pages.cmds[0], "derived.ts) . --tables chance --out dist/derived.sql") & true
pagesBundlesRows:   strings.HasSuffix(_pages.cmds[1], " --derived dist/derived.sql") & true
pagesDerivesAlone:  (len(_pages.cmds) == 2) & true
_unpaged:           _computedLoop.surface.verbs
unpagedHasNoTarget: (_unpaged.pages == _|_) & true

// Making an authoritative input live must not remove it from the statistics
// lake. A computation output with a default writer must still stay out.
_freshInputs: _computed & {
	state: entities: {
		Goal: {table: "goal", durability: "live", fields: [{name: "id", type: "uuid", pk: true}]}
		Retained: {table: "retained", durability: "offline", fields: [{name: "id", type: "uuid", pk: true}]}
	}
}
_freshCluster: (pronto.#DefaultCluster & {code: _freshInputs, statics: []}).out
_freshTerminal: (pronto.#DefaultTerminal & {code: _freshInputs}).out
_freshLoop: (pronto.#DefaultLoop & {code: _freshInputs, cluster: _freshCluster, terminal: _freshTerminal}).out
_freshFiles: (pronto.#emit & {
	code: _freshInputs
	cluster: _freshCluster
	terminal: _freshTerminal
	loop: _freshLoop
	build: (pronto.#DefaultBuild & {code: _freshInputs, loop: _freshLoop, cluster: _freshCluster}).out
}).files
_freshCDC: strings.Split(_freshFiles["services/database/migrations/008_publication.sql"].text, "-- Electric")[0]
liveInputStillCaptured: strings.Contains(_freshCDC, "goal") & true
offlineInputStillCaptured: strings.Contains(_freshCDC, "retained") & true
computedOutputNotRecaptured: strings.Contains(_freshCDC, "chance") & false
