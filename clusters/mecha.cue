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
published: impl.#Published & {
	airlock:  "bonitao/mecha-airlock:0.11.0@sha256:0283c10b46a2cd4fa5b57e6cdd8315402b056c78d992c5baed6fc41b68c4a718"
	auth:     "bonitao/mecha-auth:0.11.0@sha256:301d656e3f61f87c537b431bf2459114c6b3bec706accfd15b7b17b5d9782416"
	clock:    "bonitao/mecha-clock:0.11.0@sha256:7420c2c8dd00c82a6e06bd2cb81e050ba4f7517a9e0824534c5d96f40f8d8d8e"
	compute:  "bonitao/mecha-compute:0.11.0@sha256:24df3362b85c3654b16429c6cffffd5101e732f19a7277fa64394235b64d7199"
	conduit:  "bonitao/mecha-conduit:0.11.0@sha256:15f6d65f0dad3841339acdb20a33da5c77fd9affb16c2d67b6ab665cb7e239d7"
	database: "bonitao/mecha-database:0.11.0@sha256:5f79ccb12f43ad4e9881fcfb0d376d57ae81c62394d66e24a636e80e00ef3b4c"
	mesh:     "bonitao/mecha-mesh:0.11.0@sha256:04ad88869e10f421813db7af7f32102ec233095205f37ae5f2103587e669aeb3"
	ticker:   "bonitao/mecha-ticker:0.11.0@sha256:238ebac9d89ab96ef6e85d51aedabbcb91073637c6b9c246665744f781f51e98"
}
