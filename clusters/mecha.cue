// Pronto's cluster roster, by indirection: each file here re-exports one
// virtual-cluster implementation from its product home. Pronto owns the
// list; the implementations own themselves (mecha's lives in
// bonisoft3/mecha). Consumers import github.com/bonisoft3/pronto/clusters:<name>.
//
// The seam pronto relies on: #Cluster is the compose topology with every
// service an addressable field — escape hatches unify services in, and the
// emitter derives the data plane from the program against it: migrations in
// mecha's canonical order (seeding pipeline-written singletons, since
// pipelines only fire on CDC), CDC for all server-side entities, and one
// idempotent stream transform per program pipeline. Schema evolution
// (pgroll) is mecha's reserved surface.
package mecha

import (
	impl "github.com/bonisoft3/mecha:cluster"
	toolchain "github.com/bonisoft3/mecha/toolchain"
)

#Project: {tools: toolchain.#Tools, ...}

#Cluster: impl.#Cluster
#Runtime: impl.#Runtime
#Static:  impl.#Static

// What a sink's origin may be: the airlock's daprd dials it.
#Origin: impl.#Origin

// What a computation's or an effect's module may be endowed with.
#CageEndowment: impl.#CageEndowment

// A bridge (state.bridges) and the port its daprd reaches it on.
#Bridge:     impl.#Bridge
#BridgePort: impl.#BridgePort

#ConduitSlot:      impl.#ConduitSlot
#MachineTimersSql: impl.#MachineTimersSql

// A machine Mecha runs: XState's configuration and the setup beside it.
#Machine: impl.#Machine
#XState:  impl.#XState
#Shape:   impl.#Shape

// The mecha images an app takes by name, as pronto pins them: the consumer
// pins what it builds on, so a pronto release names a mecha release's images
// and an app pinning pronto gets them through it. One per service of
// impl.#Images, from the pin lines a mecha release prints.
// Those whose targets copy mecha's sources, which a build from a checkout
// carries as each one's srcs view.
#Sourced: impl.#Sourced

published: impl.#Published & {
	airlock:  "bonitao/mecha-airlock:0.18.0@sha256:f5a2785c77738d46efd51da42839e443ddf98a598dc01e4a4f27a62ee16714d2"
	auth:     "ghcr.io/bsoneca/mecha-auth:0.18.1-host.3@sha256:168f6e577c113ac60620094219b20dc08ebcdee98228b4136e1bdf877412fe4f"
	clock:    "bonitao/mecha-clock:0.18.0@sha256:9d8cdaca612d880a4de4ab3176f80a1e7acdb38b10295f9aa5990217dcb3317f"
	compute:  "bonitao/mecha-compute:0.18.0@sha256:a3826e7388929beeb220a8bf46075e5bbe4e355bb0118b59b4ad0ec9d630e2a5"
	conduit:  "bonitao/mecha-conduit:0.18.0@sha256:a9e01015f31e369b10268025d097ab39ad02493e9b256640b92321f2cd2c20c3"
	database: "bonitao/mecha-database:0.18.0@sha256:b44f283f271dfefd5c6453874f81b8626ac2e9dac755123e21e3e9eeb8eca18a"
	mesh:     "bonitao/mecha-mesh:0.18.0@sha256:04ad88869e10f421813db7af7f32102ec233095205f37ae5f2103587e669aeb3"
	ticker:   "bonitao/mecha-ticker:0.18.0@sha256:1d6a5b250ca28669f7a840685ccfc26bfedd411dab2ae347f18416ebbfe1519c"
}
