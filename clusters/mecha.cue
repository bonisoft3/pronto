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
	airlock:  "bonitao/mecha-airlock:0.13.0@sha256:de3d7a155e6f4f9a7f4eb894322ebc4a180eff49f5ab51afaf05b2472b4e0b1e"
	auth:     "bonitao/mecha-auth:0.13.0@sha256:7ae9835a10b62b1e6409957adb7679c23f33cf0edc8483e010b868e5a1c10d9b"
	clock:    "bonitao/mecha-clock:0.13.0@sha256:7420c2c8dd00c82a6e06bd2cb81e050ba4f7517a9e0824534c5d96f40f8d8d8e"
	compute:  "bonitao/mecha-compute:0.13.0@sha256:124c14fa79a053ebe02a2701f13ab533c406e9fc56e83d1b87a88287c07cb901"
	conduit:  "bonitao/mecha-conduit:0.13.0@sha256:f1d92126b1f92056a0ed67b57d74cbf99738c98ca578d1fa89d1c353374d0f49"
	database: "bonitao/mecha-database:0.13.0@sha256:aa58a3c10e99df501d796d49c446a41562c05febc81e83944fac65691d6684c3"
	mesh:     "bonitao/mecha-mesh:0.13.0@sha256:04ad88869e10f421813db7af7f32102ec233095205f37ae5f2103587e669aeb3"
	ticker:   "bonitao/mecha-ticker:0.13.0@sha256:8c89aef862bd1fc6e7acdfdad2c751f4f571e4a2cdd56acb411a5dbdc3efff12"
}
