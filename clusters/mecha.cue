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
	airlock:  "bonitao/mecha-airlock:0.14.0@sha256:bfa39ef21accc0d5f65cba81e62061abc7d5a8ac4e7d84313b4fc0cadbacc783"
	auth:     "bonitao/mecha-auth:0.14.0@sha256:c6d99ed3fa0fbf9140a374fdee746b14ee066c877dd96bb5d00838fb823785cb"
	clock:    "bonitao/mecha-clock:0.14.0@sha256:7420c2c8dd00c82a6e06bd2cb81e050ba4f7517a9e0824534c5d96f40f8d8d8e"
	compute:  "bonitao/mecha-compute:0.14.0@sha256:34a61cb0cb71deb8bf1c943d26ac4d56bdd8b28df6c27d24446ce2669d45e9ec"
	conduit:  "bonitao/mecha-conduit:0.14.0@sha256:686b942126aa5b867352c439d5988e02e7c5dc0eb1ffe15ed69c9357208845bc"
	database: "bonitao/mecha-database:0.14.0@sha256:e20f4190063ed50966dc3cb5ef022cc70de6cf7999b4e9c6abff13d7761696e5"
	mesh:     "bonitao/mecha-mesh:0.14.0@sha256:04ad88869e10f421813db7af7f32102ec233095205f37ae5f2103587e669aeb3"
	ticker:   "bonitao/mecha-ticker:0.14.0@sha256:3f020f4d233531de81a2ab3ba31f734149b2ecadf95fca655e48020016ae9140"
}
