// The change feed follows what a program gives its cluster: one with neither a
// pipeline nor a schedule runs none and is emitted no conduit pipeline, and a
// schedule brings both.
package emit

import (
	"list"

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
