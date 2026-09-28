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

// Compared as JSON so a migration the program did not declare is a conflict.
migrationsGiven: json.Marshal(_migratingCluster.state.pgroll) & json.Marshal({"01_profile_nick": _migration})
migrateTarget: _migratingCluster.surface.schema.pgroll.target & "migrate"
crudWaits:     _migratingCluster.surface.targets.crud.compose.depends_on.migrate.condition & "service_completed_successfully"
noRunner:      (_cluster.surface.targets.migrate == _|_) & true
