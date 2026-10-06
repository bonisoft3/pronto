// A program with a computation, pinned where lint loads its module: the
// service loads every computation at startup and dies on one SES's
// Compartment refuses, so lint loads each the same way first.
package emit

import (
	"strings"
	"encoding/json"
	"list"
)
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

_withHook: _computed & {state: computations: chances: onComplete: "capture_team_odds_history"}
_hookCluster: (pronto.#DefaultCluster & {code: _withHook, statics: []}).out
_hookConfig: json.Unmarshal(_hookCluster.surface.targets.compute.compose.environment.COMPUTATIONS)
completionRPCReachesRuntime: _hookConfig[0].onComplete & "capture_team_odds_history"
_plainCluster: (pronto.#DefaultCluster & {code: _computed, statics: []}).out
_plainConfig: json.Unmarshal(_plainCluster.surface.targets.compute.compose.environment.COMPUTATIONS)
undeclaredCompletionRPCAbsent: (_plainConfig[0].onComplete == _|_) & true
invalidCompletionRPCsRefused: [for rpc in ["", "Capture", "rpc/capture", "capture-name", strings.Repeat("a", 64)] {
	((pronto.#Computation & {name: "chances", to: ["Chance"], onComplete: rpc}) == _|_) & true
}]

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
	state: {
		entities: {
			Goal: {table: "goal", durability: "live", fields: [{name: "id", type: "uuid", pk: true}]}
			Retained: {table: "retained", durability: "offline", fields: [{name: "id", type: "uuid", pk: true}]}
			RequestProjection: {table: "request_projection", durability: "server", writers: "pipeline", fields: [{name: "id", type: "uuid", pk: true}]}
			ServerPipeline: {table: "server_pipeline", durability: "server", fields: [{name: "id", type: "uuid", pk: true}]}
		}
		pipelines: server_pipeline: {raw: true, from: "Goal", to: "ServerPipeline", group: "server-pipeline"}
	}
}
_freshCluster: (pronto.#DefaultCluster & {code: _freshInputs, statics: []}).out
_freshTerminal: (pronto.#DefaultTerminal & {code: _freshInputs}).out
_freshLoop: (pronto.#DefaultLoop & {code: _freshInputs, cluster: _freshCluster, terminal: _freshTerminal}).out
_freshFiles: (pronto.#emit & {
	code:     _freshInputs
	cluster:  _freshCluster
	terminal: _freshTerminal
	loop:     _freshLoop
	build: (pronto.#DefaultBuild & {code: _freshInputs, loop: _freshLoop, cluster: _freshCluster}).out
}).files
_freshCDC:                         strings.Split(_freshFiles["services/database/migrations/008_publication.sql"].text, "-- Electric")[0]
serverInputStillCaptured:          strings.Contains(_freshCDC, "profile") & true
liveInputStillCaptured:            strings.Contains(_freshCDC, "goal") & true
offlineInputStillCaptured:         strings.Contains(_freshCDC, "retained") & true
computedOutputNotRecaptured:       strings.Contains(_freshCDC, "chance") & false
requestProjectionNotCaptured:      strings.Contains(_freshCDC, "request_projection") & false
serverPipelineOutputNotRecaptured: strings.Contains(_freshCDC, "server_pipeline") & false
cdcSourceTables: json.Marshal(list.SortStrings(strings.Split(
	_freshFiles["docker/conduit-pipeline.yaml"].data.pipelines[0].connectors[0].settings.tables, ","))) & json.Marshal(["goal", "profile", "retained"])
