// A program's pgroll migrations reach mecha's cluster, pinned: the cluster is
// given them as declared and runs a migrate target its readers wait on, and a
// program that declares none gets no runner.
package emit

import (
	"encoding/json"

	pronto "github.com/bonisoft3/pronto"
)

_migration: operations: [{add_column: {table: "profile", column: {name: "nick", type: "text", nullable: true}}}]
_migrating: _code & {state: migrations: "01_profile_nick": _migration}
_migratingCluster: (pronto.#DefaultCluster & {code: _migrating, statics: []}).out
_migratingBuild: (pronto.#DefaultBuild & {code: _migrating, cluster: _migratingCluster, terminal: _terminal, loop: _loop}).out
_migratingFiles: (pronto.#emit & {code: _migrating, cluster: _migratingCluster, terminal: _terminal, loop: _loop, build: _migratingBuild}).files

// Compared as JSON so a migration the program did not declare is a conflict.
migrationsGiven: json.Marshal(_migratingCluster.state.pgroll) & json.Marshal({"01_profile_nick": _migration})
migrateTarget: _migratingCluster.surface.schema.pgroll.target & "migrate"
crudWaits:     _migratingCluster.surface.targets.crud.compose.depends_on.migrate.condition & "service_completed_successfully"
noRunner:      (_cluster.surface.targets.migrate == _|_) & true

// Engine payloads in Dockerfile heredocs exceeded BuildKit's request limit.
// The copied file and its build input must be the same vetted migration.
_migrationFile: "services/database/pgroll/01_profile_nick.json"
migrationFileFormat: _migratingFiles[_migrationFile].format & "json"
migrationFileValue: json.Marshal(_migratingFiles[_migrationFile].data) & json.Marshal(_migration)
migrationCopy: _migratingCluster.surface.targets.migrate.dockerfile.copy & [{srcs: [_migrationFile], dst: "/pgroll/01_profile_nick.json"}]
migrationInputs: _migratingBuild.project.targets.migrate.srcs.globs & [_migrationFile]
migrationNoHeredoc: _migratingCluster.surface.targets.migrate.dockerfile.epilogue & []
