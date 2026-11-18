package emit

import (
	"encoding/json"
	pronto "github.com/bonisoft3/pronto"
)

_snapshotStream: {
	name:       "metrics"
	backend:    "compute"
	src:        "computations/metrics.js"
	risingwave: "computations/metrics.risingwave.json"
	sources: {
		traffic: {entities: ["Profile"], read: "snapshot"}
		repeated: {entities: ["Profile"], read: "snapshot"}
	}
	sinks: {
		counts: {entity: "Metric", write: "replace", version: "latest", transaction: "metrics"}
	}
}
_streamed: _code & {
	state: {
		entities: Metric: {
			table:      "metric"
			durability: "offline"
			fields: [{name: "id", type: "string", pk: true}, {name: "count", type: "int64"}]
		}
		duckstreams: metrics: _snapshotStream
	}
}
_streamCluster: (pronto.#DefaultCluster & {code: _streamed, statics: []}).out
_streamConfig:         json.Unmarshal(_streamCluster.surface.targets.compute.compose.environment.COMPUTATIONS)
streamHasOneRuntime:   len(_streamConfig) & 1
streamUsesNativeStage: _streamConfig[0].file & "/app/computations/emit-metrics.js"
streamCapturesDistinctTables: _streamConfig[0].declaredReads & ["profile"]
streamPublishesNamedEntity: _streamConfig[0].to & ["metric"]
streamCarriesReplace: _streamConfig[0].sinkWrites.metric & "replace"
streamTypesOwnedRows: _streamConfig[0].sinkTypes.metric & [{name: "id", type: "string", required: true}, {name: "count", type: "int64", required: true}]
streamUsesExistingWriter: _streamed.state.entities.Metric.writers & [{by: "metrics", kind: "computation", ops: ["upsert"]}]
streamRejectsChanges: ((pronto.#DuckStreamPipeline & {
	for k, v in _snapshotStream if k != "sources" {(k): v}
	sources: traffic: {entities: ["Profile"], read: "changes"}
}) == _|_) & true
streamRejectsAppend: ((pronto.#DuckStreamPipeline & {
	for k, v in _snapshotStream if k != "sinks" {(k): v}
	sinks: counts: {entity: "Metric", write: "append", version: "latest", transaction: "metrics"}
}) == _|_) & true
streamRejectsOrdered: ((pronto.#DuckStreamPipeline & {
	for k, v in _snapshotStream if k != "sinks" {(k): v}
	sinks: counts: {entity: "Metric", write: "replace", version: "ordered", transaction: "metrics"}
}) == _|_) & true
streamRejectsSplitTransaction: ((_streamed & {state: duckstreams: metrics: sinks: other: {entity: "Profile", write: "replace", version: "latest", transaction: "separate"}}) == _|_) & true

streamCarriesRisingwave:    _streamConfig[0].risingwave & "/app/computations/emit-metrics.risingwave.json"
streamDefaultsToRisingwave: _streamCluster.surface.targets.compute.compose.environment.DUCKSTREAM_ENGINE & "${DUCKSTREAM_ENGINE:-risingwave}"
streamMountsNoVolumes:      (_streamCluster.surface.targets.compute.compose.volumes == _|_) & true
_snapshotCluster:           _streamCluster & {state: duckstreamEngine: "duckdb-snapshot"}
streamSelectsSnapshot:      _snapshotCluster.surface.targets.compute.compose.environment.DUCKSTREAM_ENGINE & "${DUCKSTREAM_ENGINE:-duckdb-snapshot}"

_upserted: _code & {
	state: entities: Metric: _streamed.state.entities.Metric
	state: duckstreams: metrics: {
		for k, v in _snapshotStream if k != "sinks" {(k): v}
		sinks: counts: {entity: "Metric", write: "upsert", version: "latest", transaction: "metrics"}
	}
}
_upsertCluster: (pronto.#DefaultCluster & {code: _upserted, statics: []}).out
_upsertConfig: json.Unmarshal(_upsertCluster.surface.targets.compute.compose.environment.COMPUTATIONS)
streamCarriesUpsert: _upsertConfig[0].sinkWrites.metric & "upsert"
