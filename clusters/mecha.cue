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

// A bridge role and the reusable SMTP container implementation.
#Bridge:     impl.#Bridge
#MailContainer: impl.#MailContainer

// Mecha's AI gateway (services/airlock/tsbifrost.ts) and the tiered AI model schema.
#TsBifrostPort:   impl.#TsBifrostPort
#AiModality:      impl.#AiModality
#AiTier:          impl.#AiTier
#AiBackendTier:   impl.#AiBackendTier
#AiTarget:        impl.#AiTarget
#AiProvider:      impl.#AiProvider
#AiModelSpec:     impl.#AiModelSpec
#AiTierOverrides: impl.#AiTierOverrides
#AiCapability:    impl.#AiCapability

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
	airlock:  "bonitao/mecha-airlock:0.20.4@sha256:80553c1549b6d7589688063695b9ab1bb4d953ac98daf0f099fbbc1f9206a856"
	auth:     "bonitao/mecha-auth:0.20.4@sha256:32e103e1f4ad8e5de935c6a6a9f4565eefa2e22669fc6436110dfd1b9891c531"
	clock:    "bonitao/mecha-clock:0.20.4@sha256:9d8cdaca612d880a4de4ab3176f80a1e7acdb38b10295f9aa5990217dcb3317f"
	compute:  "bonitao/mecha-compute:0.20.4@sha256:c9ce130f7eca5c0d3789274923ceaad251874031088c1e1b3fafbfefd66fd78f"
	conduit:  "bonitao/mecha-conduit:0.20.4@sha256:528bd29347ebb9d92266bcaf53504800e9870455a70d35c23a74642d7ff2d48d"
	database: "bonitao/mecha-database:0.20.4@sha256:81b321f1d8f87d267bc74a61ce1e9df4c5ed25ffff8e408fcdd2dce0b31b247d"
	mesh:     "bonitao/mecha-mesh:0.20.4@sha256:04ad88869e10f421813db7af7f32102ec233095205f37ae5f2103587e669aeb3"
	ticker:   "bonitao/mecha-ticker:0.20.4@sha256:f51eac977710b90046bab6836b659a07b94af29956f950b98e644eeb4da81553"
}
