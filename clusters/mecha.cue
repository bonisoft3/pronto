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

// Mecha's AI gateway (services/airlock/bifrost.ts) and the tiered AI model schema.
#BifrostPort:     impl.#BifrostPort
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
	airlock:  "bonitao/mecha-airlock:0.20.0@sha256:b487e99c8dd0577e00154764dc8ade7b840ecb4197e86d94922561e29a091dc4"
	auth:     "bonitao/mecha-auth:0.20.0@sha256:046e718f9449e844ab90b918031f1c06ec7e567fb0c57d6f80f4d11075d5a954"
	clock:    "bonitao/mecha-clock:0.20.0@sha256:9d8cdaca612d880a4de4ab3176f80a1e7acdb38b10295f9aa5990217dcb3317f"
	compute:  "bonitao/mecha-compute:0.20.0@sha256:6fee03b27acb718b605df0bea893541b24e7e5565106d0892562238d1feb0ede"
	conduit:  "bonitao/mecha-conduit:0.20.0@sha256:04f6134767668a1843cbd3a0844278db9eb0c88997988a0a9a25c4a9bd0cfcd5"
	database: "bonitao/mecha-database:0.20.0@sha256:ff037e4f3a68f3ae4a1bf7e8df8d0f441c165529c9596e38667cde001e70a69f"
	mesh:     "bonitao/mecha-mesh:0.20.0@sha256:04ad88869e10f421813db7af7f32102ec233095205f37ae5f2103587e669aeb3"
	ticker:   "bonitao/mecha-ticker:0.20.0@sha256:fd2f0a45faca3234f74e33ccda29bb3fd8a74c954b96bb1c0c14f087d0b22f8c"
}
