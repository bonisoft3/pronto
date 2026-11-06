package emit

import (
	pronto "github.com/bonisoft3/pronto"
	k8s "github.com/bonisoft3/pronto/k8s/schema"
	"github.com/bonisoft3/pronto/k8s/envs"
	gcp "github.com/bonisoft3/pronto/gcp/schema"
)

_updateAccess: _code & {
	state: entities: Profile: access: {scope: "public"}
	state: entities: Cursor: {
		table: "cursor"
		durability: "offline"
		access: {scope: "public", write: "update"}
		fields: [{name: "id", type: "string", pk: true}, {name: "range", type: "string"}]
	}
}

updateAccessCluster: (pronto.#DefaultCluster & {code: _updateAccess, statics: []}).out
updateAccessMigrations: updateAccessCluster.state.migrations

_accessK8s: (k8s.#BuildManifests & {
	release: {name: "access", migrate: env: {}}
	env: envs.Kind
}).objects
_accessGcp: gcp.#Build & {release: {
	name: "access"
	project: "access-test"
	database: tokenRoles: ["app_user", "service"]
	migrate: env: {}
}}
accessReleaseJobs: {
	k8s: {
		initdb: [for o in _accessK8s if o.kind == "Job" if o.metadata.name == "access-initdb" {o.spec.template.spec.containers[0]}][0]
		migrate: [for o in _accessK8s if o.kind == "Job" if o.metadata.name == "access-migrate" {o.spec.template.spec.containers[0]}][0]
	}
	gcp: {
		initdb: _accessGcp.job.spec.template.spec.template.spec.containers[0]
		migrate: _accessGcp.job.spec.template.spec.template.spec.containers[0]
	}
}

_readOnlyAccessCluster: (pronto.#DefaultCluster & {code: _code & {state: entities: Profile: access: {scope: "public"}}, statics: []}).out
readOnlyAccessNoRunner: (_readOnlyAccessCluster.surface.targets.migrate == _|_) & true

_accessMigratingCode: _code & {
	capabilities: auth: {}
	state: migrations: "01_fixture": operations: [{sql: {up: "SELECT 1;", onComplete: true}}]
}
_accessMigratingCluster: (pronto.#DefaultCluster & {code: _accessMigratingCode, statics: []}).out
_accessMigratingTerminal: (pronto.#DefaultTerminal & {code: _accessMigratingCode}).out
_accessMigratingLoop: (pronto.#DefaultLoop & {code: _accessMigratingCode, cluster: _accessMigratingCluster, terminal: _accessMigratingTerminal}).out
_accessMigratingBuild: (pronto.#DefaultBuild & {code: _accessMigratingCode, cluster: _accessMigratingCluster, terminal: _accessMigratingTerminal, loop: _accessMigratingLoop}).out
_accessMigratingEmit: pronto.#emit & {
	code: _accessMigratingCode
	cluster: _accessMigratingCluster
	terminal: _accessMigratingTerminal
	loop: _accessMigratingLoop
	build: _accessMigratingBuild
}
accessMigrationSchema: _accessMigratingEmit.build.cluster.surface.schema.pgroll
