// A program with one external effect, and the cluster it feeds: the airlock
// placed where the emitted manifest, binding and handler sit, Graphile's
// schema and the ledger among the database's steps, the networks around the
// airlock declared in a file every closure and the root include, and its
// daprd allowed the bindings API alone.
package emit

import (
	"list"
	"strings"
	pronto "github.com/bonisoft3/pronto"
)

_effecting: _code & {
	state: {
		entities: Payment: {
			table:      "payment"
			durability: "server"
			fields: [
				{name: "id", type: "uuid", pk: true},
				{name: "status", type: "text"},
				{name: "total", type: "int"},
			]
		}
		machines: PaymentMachine: {
			name:    "PaymentMachine"
			entity:  "Payment"
			field:   "status"
			initial: "pending"
			states: {
				pending: on: pay: "charging"
				charging: invoke: {src: "charge", onDone: "settled", onError: "failed"}
				settled: type: "final"
				failed: type:  "final"
			}
		}
		effects: charge: {
			input: {amount: "NEW.total"}
			sink: {origin: "https://api.acquirer.example", idempotent: true}
		}
	}
}

_effectingTerminal: (pronto.#DefaultTerminal & {code: _effecting}).out
_effectingCluster: (pronto.#DefaultCluster & {code: _effecting, statics: []}).out
_effectingLoop: (pronto.#DefaultLoop & {code: _effecting, terminal: _effectingTerminal, cluster: _effectingCluster}).out
_effectingBuild: (pronto.#DefaultBuild & {code: _effecting, loop: _effectingLoop, cluster: _effectingCluster}).out
_effectingFiles: (pronto.#emit & {
	code:     _effecting
	cluster:  _effectingCluster
	terminal: _effectingTerminal
	loop:     _effectingLoop
	build:    _effectingBuild
}).files
_effectingTargets: _effectingBuild.project.targets

// Nothing pokes the airlock: its worker hears a guard's enqueue at the commit.
effectPlaced: [for n in ["airlock", "airlock-mesh", "airlock-clock"] if _effectingTargets[n] != _|_ {n}] & ["airlock", "airlock-mesh"]
// An effect is woken by the ticker: the clock and ticker are placed, the
// schedule table rides inside the airlock's step (below), and the wake
// reaches the airlock alone, there being no change feed to wake.
effectWakes:    [for n in ["ticker", "clock"] if _effectingTargets[n] != _|_ {n}] & ["ticker", "clock"]
effectWakeUrls: _effectingTargets.ticker.compose.environment.WAKE_URLS & "http://airlock:9997/healthz"
// The cluster reads what the emitter writes, where the emitter writes it.
effectManifest: _effectingTargets.airlock.dockerfile.copy[0] & {srcs: ["services/airlock/effects.json"], dst: "/airlock/effects.json"}
effectManifestEmitted: (_effectingFiles["services/airlock/effects.json"].data.effects.charge.handler) & "effects/charge.js"
effectHandler: _effectingTargets.airlock.dockerfile.copy[1] & {srcs: ["effects/charge.js"], dst: "/airlock/effects/charge.js"}
effectBinding: _effectingTargets["airlock-mesh"].dockerfile.copy[1] & {srcs: ["services/airlock/dapr/charge.yaml"], dst: "/dapr/airlock/charge.yaml"}
effectBindingEmitted: _effectingFiles["services/airlock/dapr/charge.yaml"].data.spec.metadata[0] & {name: "url", value: "https://api.acquirer.example"}
effectAllowlist: _effectingTargets["airlock-mesh"].dockerfile.copy[0] & {srcs: ["/app/airlock/dapr.yaml"], dst: "/dapr/config.yaml"}
effectImage: _effectingTargets.airlock.dockerfile.from.ref & "libraries_mecha:airlock-image"
effectSteps: [for c in _effectingTargets.database.dockerfile.copy if c.from.name != _|_ {c.dst}] & ["/docker-entrypoint-initdb.d/011_graphile_worker.sql", "/docker-entrypoint-initdb.d/012_airlock.sql"]
// Neither the airlock nor its daprd stands on the default network, where
// every other service is; the daprd goes out on a network of its own.
effectAirlockWalled: (_effectingTargets.airlock.compose.networks.default == _|_) & true
effectMeshWalled:    (_effectingTargets["airlock-mesh"].compose.networks.default == _|_) & true
effectMeshOut:       (_effectingTargets["airlock-mesh"].compose.networks["airlock-egress"] != _|_) & true
effectNetworks: _effectingFiles["compose.networks.yaml"].data.networks & {airlock: internal: true, "airlock-out": internal: true, "airlock-wake": internal: true, "airlock-egress": {}}
effectIncluded: _effectingBuild.project.compose.includes & ["compose.networks.yaml"]
effectRootIncludes: list.Contains(_effectingFiles["compose.yaml"].data.include, {path: "compose.networks.yaml"}) & true
// lint admits each handler as the airlock does, against the manifest above.
_admitEffects: _effectingLoop.surface.checks.admitEffects
admitEffectsLints: _admitEffects.verb & "lint"
admitEffectsManifest: strings.HasSuffix(_admitEffects.cmds[0], "admit.ts) services/airlock/effects.json .") & true
admitEffectsUnderPins: strings.Contains(_admitEffects.cmds[0], "services airlock deno.json") & true
