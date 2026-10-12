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
	airlock:  "bonitao/mecha-airlock:0.9.0@sha256:b441fb977960b857146cabc8c0aa1ebb79c59f0cee88a846c28955684544390b"
	auth:     "bonitao/mecha-auth:0.9.0@sha256:2b350c032df7afd3bfda54aa9f62baacd715257a749a4dfa271d2ef8af04bf9b"
	clock:    "bonitao/mecha-clock:0.9.0@sha256:185d23538507ff041799c6408846643205080c80a0f56c7e2d7637278876dd1b"
	compute:  "bonitao/mecha-compute:0.9.0@sha256:580054fee3cdcd82db36b313c51cbda977ef342844fdd49341484de535563a27"
	conduit:  "bonitao/mecha-conduit:0.9.0@sha256:5b37a9074a35a9e8a3f95aa70b8c09f226927a7d9053cfa4ffc91ee07a5c302b"
	database: "bonitao/mecha-database:0.9.0@sha256:eadcd8a668af9bf9f71f375f96b08965ebd49469d0c7a45d99e70b04316bcc2e"
	mesh:     "bonitao/mecha-mesh:0.9.0@sha256:b8d8c6dab3a33fedf09a0ef8f3d79b71de6408f70e1c2e04194a5f47d391da8f"
	ticker:   "bonitao/mecha-ticker:0.9.0@sha256:6143c63265738c34055546fbb2eb6ace9c14f03c6bc769eb362b155354f061ea"
}
