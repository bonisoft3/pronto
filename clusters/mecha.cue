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

// The mecha images an app takes by name, as pronto pins them: the consumer
// pins what it builds on, so a pronto release names a mecha release's images
// and an app pinning pronto gets them through it. One per service of
// impl.#Images, from the pin lines a mecha release prints.
// Those whose targets copy mecha's sources, which a build from a checkout
// carries as each one's srcs view.
#Sourced: impl.#Sourced

published: impl.#Published & {
	airlock:  "bonitao/mecha-airlock:0.12.1@sha256:e8d4f8853ec49672e2515fda2f6429322680da6443b36dce9e41f375af58122f"
	auth:     "bonitao/mecha-auth:0.12.1@sha256:4d7fc684af603f3c79459ec76fe578ed1c87c7bfa9b2abb8106d6af4d7ba2fd6"
	clock:    "bonitao/mecha-clock:0.12.1@sha256:7420c2c8dd00c82a6e06bd2cb81e050ba4f7517a9e0824534c5d96f40f8d8d8e"
	compute:  "bonitao/mecha-compute:0.12.1@sha256:7c7d4e34a91f19ea87c429ec00401c19c1d11067a619d5c5001b7716294953c4"
	conduit:  "bonitao/mecha-conduit:0.12.1@sha256:15f6d65f0dad3841339acdb20a33da5c77fd9affb16c2d67b6ab665cb7e239d7"
	database: "bonitao/mecha-database:0.12.1@sha256:8478d56bb4aa2545cad656db0ff059f4c5d8f4ba227ef4cb7fd9edfae861bc09"
	mesh:     "bonitao/mecha-mesh:0.12.1@sha256:04ad88869e10f421813db7af7f32102ec233095205f37ae5f2103587e669aeb3"
	ticker:   "bonitao/mecha-ticker:0.12.1@sha256:f1136ad98ab5a86b9723d75c4a6fbda0236a486f9cb22cde8c479fc8578e8bc1"
}
