// A drain is a stream like a pipeline: its file is emitted, the transform runs
// it, the change feed turns on for it, and the lint lists it.
package emit

import (
	"list"

	pronto "github.com/bonisoft3/pronto"
)

_drained: _code & {
	state: drains: "profile-refresh": {on: ["profile", "profile_dirty"], call: "refresh_profiles"}
}

_drainedCluster: (pronto.#DefaultCluster & {code: _drained, statics: []}).out
_drainedTerminal: (pronto.#DefaultTerminal & {code: _drained}).out
_drainedLoop: (pronto.#DefaultLoop & {code: _drained, terminal: _drainedTerminal, cluster: _drainedCluster}).out
_drainedFiles: (pronto.#emit & {
	code:     _drained
	cluster:  _drainedCluster
	terminal: _drainedTerminal
	loop:     _drainedLoop
	build: (pronto.#DefaultBuild & {code: _drained, loop: _drainedLoop, cluster: _drainedCluster, terminal: _drainedTerminal}).out
}).files
_drainFile: "docker/emit-profile-refresh.yaml"

drainEmitted: _drainedFiles[_drainFile].data.output.http_client.url & "${CRUD_URL}/rpc/refresh_profiles"
drainRun: list.Contains([for p in _drainedCluster.state.pipelines {p.file}], _drainFile) & true
drainRunsFeed: list.Contains([for t, _ in _drainedCluster.surface.targets {t}], "conduit") & true
drainLinted: list.Contains(_drainedLoop.surface.pipelineFiles, _drainFile) & true
