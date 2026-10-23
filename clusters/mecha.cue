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
	airlock:  "bonitao/mecha-airlock:0.16.0@sha256:e6575bfd8debb9d660d4d830349d989816d4eba1d01858210b1441f131a1d56d"
	auth:     "bonitao/mecha-auth:0.16.0@sha256:cd4a375911ef949b9822652acf1eb95a0be6cbc3ff0d2d5ab4aaef8fa823fd34"
	clock:    "bonitao/mecha-clock:0.16.0@sha256:9d8cdaca612d880a4de4ab3176f80a1e7acdb38b10295f9aa5990217dcb3317f"
	compute:  "bonitao/mecha-compute:0.16.0@sha256:480344fb6ea308c3974a2e5b4c1db65300cee31bd0320c65a82a0673e080d318"
	conduit:  "bonitao/mecha-conduit:0.16.0@sha256:3c99e386a2f45bbc1685c37dbd2db3888fc4ae7dcc9eaab2ba591963068cae8f"
	database: "bonitao/mecha-database:0.16.0@sha256:65ab11cf4a01a09613eebc2abcc484ac57f531acf35105a00f6880e4642791a7"
	mesh:     "bonitao/mecha-mesh:0.16.0@sha256:04ad88869e10f421813db7af7f32102ec233095205f37ae5f2103587e669aeb3"
	ticker:   "bonitao/mecha-ticker:0.16.0@sha256:0817851020a217bf39f08793de50261702b8bf2bca7367ef35517e0593e4a943"
}
