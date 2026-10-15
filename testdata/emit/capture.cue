// The change feed follows what a program gives its cluster: one with neither a
// pipeline nor a schedule runs none and is emitted no conduit pipeline, and a
// schedule brings both.
package emit

import (
	"list"
	"strings"

	pronto "github.com/bonisoft3/pronto"
)

_quietFiles: (pronto.#emit & {
	code:     _code
	cluster:  _cluster
	terminal: _terminal
	loop:     _loop
	build: (pronto.#DefaultBuild & {code: _code, loop: _loop, cluster: _cluster}).out
}).files
_pipeline: "docker/conduit-pipeline.yaml"

quietRunsNoFeed:        list.Contains([for t, _ in _cluster.surface.targets {t}], "conduit") & false
quietEmitsNoPipeline:   list.Contains([for f, _ in _quietFiles {f}], _pipeline) & false
scheduledRunsFeed:      list.Contains([for t, _ in _scheduledCluster.surface.targets {t}], "conduit") & true
scheduledEmitsPipeline: list.Contains([for f, _ in _scheduledFiles {f}], _pipeline) & true

// A consumer names the request behind a row by the marker preceding it; a
// table left unmarked would read as part of the transaction before it.
_quietPub:     _quietFiles["services/database/migrations/008_publication.sql"].text
_scheduledPub: strings.Split(_scheduledFiles["services/database/migrations/008_publication.sql"].text, "-- Electric")
quietMarksNothing:        (strings.Contains(_quietPub, "txn_trace") || strings.Contains(_quietPub, "mark_txn")) & false
scheduledMarkerPublished: strings.Contains(_scheduledPub[0], "ALTER PUBLICATION emit_cdc ADD TABLE mecha.txn_trace;") & true
scheduledMarkerNotSynced: strings.Contains(_scheduledPub[1], "txn_trace") & false
scheduledMarksEveryTable: [for t in ["profile", "tick", "tick_done"] {
	strings.Contains(_scheduledPub[0], "CREATE OR REPLACE TRIGGER mark_txn BEFORE INSERT OR UPDATE OR DELETE ON \(t)\n  FOR EACH STATEMENT EXECUTE FUNCTION mecha.mark_txn();")
}] & [true, true, true]
