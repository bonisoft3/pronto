// The app's own migrations are listed in .pronto/cluster.json for a release to
// replay on a database it already built (gcp's schema job), in the order the
// app declared them; 016_mecha_actors is the job's own and is not repeated.
package emit

import pronto "github.com/bonisoft3/pronto"

_replayed: _code & {
	state: rawMigrations: [{name: "016_mecha_actors.sql", src: "x.sql"}, {name: "020_mine.sql", src: "y.sql"}, {name: "021_more.sql", src: "z.sql"}]
}

_replayedCluster: (pronto.#DefaultCluster & {code: _replayed, statics: []}).out
_replayedTerminal: (pronto.#DefaultTerminal & {code: _replayed}).out
_replayedLoop: (pronto.#DefaultLoop & {code: _replayed, terminal: _replayedTerminal, cluster: _replayedCluster}).out
_replayedFiles: (pronto.#emit & {
	code:     _replayed
	cluster:  _replayedCluster
	terminal: _replayedTerminal
	loop:     _replayedLoop
	build: (pronto.#DefaultBuild & {code: _replayed, loop: _replayedLoop, cluster: _replayedCluster, terminal: _replayedTerminal}).out
}).files
replaysListed: _replayedFiles[".pronto/cluster.json"].data.replays & ["020_mine.sql", "021_more.sql"]
replaysNoneByDefault: _drainedFiles[".pronto/cluster.json"].data.replays & []
