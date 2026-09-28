// A program with a schedule and auth, pinned where its objects come from: the
// `schedule` table and auth_uid() are mecha's database image's, so the emitter
// seeds the one after the step the cluster places and restates neither.
package emit

import (
	"list"
	"strings"
	pronto "github.com/bonisoft3/pronto"
)

_scheduled: _code & {
	state: {
		entities: Tick: {
			table:      "tick"
			durability: "server"
			fields: list.Concat([pronto.#tickFields, [{name: "status", type: "text"}]])
		}
		schedules: nightly: {
			cron: "0 3 * * *"
			emits: {entity: "Tick", values: status: "requested"}
		}
	}
	capabilities: auth: {required: false, service: "/auth"}
}

_scheduledTerminal: (pronto.#DefaultTerminal & {code: _scheduled}).out
_scheduledCluster: (pronto.#DefaultCluster & {code: _scheduled, statics: []}).out
_scheduledLoop: (pronto.#DefaultLoop & {code: _scheduled, terminal: _scheduledTerminal, cluster: _scheduledCluster}).out
_scheduledFiles: (pronto.#emit & {
	code:     _scheduled
	cluster:  _scheduledCluster
	terminal: _scheduledTerminal
	loop:     _scheduledLoop
	build: (pronto.#DefaultBuild & {code: _scheduled, loop: _scheduledLoop, cluster: _scheduledCluster}).out
}).files
_migrations: "services/database/migrations"

scheduleTableNotEmitted: (_scheduledFiles["\(_migrations)/020_schedule.sql"] == _|_) & true
scheduleSeedOnly:        strings.Contains(_scheduledFiles["\(_migrations)/021_schedule_seed.sql"].text, "CREATE TABLE") & false
scheduleSeeded:          strings.Contains(_scheduledFiles["\(_migrations)/021_schedule_seed.sql"].text, "INSERT INTO schedule") & true
authUidNotEmitted:       strings.Contains(_scheduledFiles["\(_migrations)/000_extensions.sql"].text, "auth_uid") & false
// The cluster the program feeds places the table's step in its database, and
// the seed among the migrations after it.
scheduleSeedMigrated: list.Contains(_scheduledCluster.state.migrations, "\(_migrations)/021_schedule_seed.sql") & true
schedulePlaced: len([for c in _scheduledCluster.surface.targets.database.dockerfile.copy if c.dst == "/docker-entrypoint-initdb.d/020_schedule.sql" {c}]) & 1
