// A program with a schedule and auth, pinned where its objects come from: the
// `schedule` table and auth_uid() are mecha's database image's, so the emitter
// seeds the one after the step the cluster places and restates neither.
package emit

import (
	"encoding/json"
	"list"
	"strings"
	pronto "github.com/bonisoft3/pronto"
)

_scheduled: _code & {
	state: {
		entities: {
			Tick: {
				table:      "tick"
				durability: "server"
				fields: list.Concat([pronto.#tickFields, [{name: "status", type: "text"}]])
			}
			TickDone: {table: "tick_done", durability: "live", fields: [{name: "id", type: "uuid", pk: true}]}
		}
		schedules: nightly: {
			cron: "0 3 * * *"
			emits: {entity: "Tick", values: status: "requested"}
			done: {entity: "TickDone", filter: "id=eq.{id}"}
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
	build: (pronto.#DefaultBuild & {code: _scheduled, loop: _scheduledLoop, cluster: _scheduledCluster, terminal: _scheduledTerminal}).out
}).files
_migrations: "services/database/migrations"

scheduleTableNotEmitted: (_scheduledFiles["\(_migrations)/800_schedule.sql"] == _|_) & true
scheduleSeedOnly:        strings.Contains(_scheduledFiles["\(_migrations)/801_schedule_seed.sql"].text, "CREATE TABLE") & false
scheduleSeeded:          strings.Contains(_scheduledFiles["\(_migrations)/801_schedule_seed.sql"].text, "INSERT INTO schedule") & true
authUidNotEmitted:       strings.Contains(_scheduledFiles["\(_migrations)/000_extensions.sql"].text, "auth_uid") & false
// The cluster the program feeds places the table's step in its database, and
// the seed among the migrations after it.
scheduleSeedMigrated: list.Contains(_scheduledCluster.state.migrations, "\(_migrations)/801_schedule_seed.sql") & true
schedulePlaced: len([for c in _scheduledCluster.surface.targets.database.dockerfile.copy if c.dst == "/docker-entrypoint-initdb.d/800_schedule.sql" {c}]) & 1
// A schedule brings the ticker and nothing of the airlock's.
scheduleNoAirlock: (_scheduledCluster.surface.targets.airlock == _|_) & true
scheduleNoNetworks: (_scheduledFiles["compose.networks.yaml"] == _|_) & true

_scheduledCDC: strings.Split(_scheduledFiles["\(_migrations)/008_publication.sql"].text, "-- Electric")[0]
scheduleServiceInputCaptured: strings.Contains(_scheduledCDC, "tick") & true
scheduleOutcomeCaptured: strings.Contains(_scheduledCDC, "tick_done") & true
scheduleCDCSourceTables: json.Marshal(list.SortStrings(strings.Split(
	_scheduledFiles["docker/conduit-pipeline.yaml"].data.pipelines[0].connectors[0].settings.tables, ","))) & json.Marshal(["profile", "tick", "tick_done"])

// Released to pages, a schedule asks the target for no clock: the page runs
// its own while it is open, over the seed it takes whole, with the table the
// bundler places before it.
_scheduledPaged: pronto.#App & {
	for k, v in _scheduled if k != "meta" {(k): v}
	meta: {
		for k, v in _scheduled.meta if k != "targets" {(k): v}
		targets: ["pages"]
	}
}
_scheduledPagedCluster: (pronto.#DefaultCluster & {code: _scheduledPaged, statics: []}).out
_scheduledPagedTerminal: (pronto.#DefaultTerminal & {code: _scheduledPaged}).out
_scheduledPagedLoop: (pronto.#DefaultLoop & {code: _scheduledPaged, terminal: _scheduledPagedTerminal, cluster: _scheduledPagedCluster}).out
_scheduledPagedFiles: (pronto.#emit & {
	code:     _scheduledPaged
	cluster:  _scheduledPagedCluster
	terminal: _scheduledPagedTerminal
	loop:     _scheduledPagedLoop
	build: (pronto.#DefaultBuild & {code: _scheduledPaged, loop: _scheduledPagedLoop, cluster: _scheduledPagedCluster, terminal: _scheduledPagedTerminal}).out
}).files
_pagedSeed: _scheduledPagedFiles["\(_migrations)/801_schedule_seed.sql"].text
pagedSeedWhole: strings.Contains(_pagedSeed, "-- tier:") & false

// The framework's steps hold 800-899, so an app step there is refused rather
// than left to collide with whichever one a later declaration places.
appStepInFrameworkRange: ((pronto.#App & {state: rawMigrations: [{name: "801_mine.sql", src: "x.sql"}]}).state == _|_) & true
appStepBelowFrameworkRange: ((pronto.#App & {state: rawMigrations: [{name: "799_mine.sql", src: "x.sql"}]}).state.rawMigrations[0].name) & "799_mine.sql"

// A step over a single value is refused at vet, as croner 10 and the ticker
// refuse it at run time, where a schedule that never ticks says nothing.
cronSingleStepRefused: ((pronto.#Schedule & {name: "s", cron: "5/10 2 * * *", emits: {entity: "Tick", values: {}}}).cron == _|_) & true
cronRangeStep: (pronto.#Schedule & {name: "s", cron: "5-59/10 2 * * *", emits: {entity: "Tick", values: {}}}).cron & "5-59/10 2 * * *"
