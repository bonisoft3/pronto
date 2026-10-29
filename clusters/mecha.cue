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
	airlock:  "bonitao/mecha-airlock:0.20.2@sha256:744ae7601c26ea247fe19dff10da7e65c9752f68a8fe05e297f0b7a25a732062"
	auth:     "bonitao/mecha-auth:0.20.2@sha256:d58a74b1f726c815f9a39a99ca8c198d16157ff7053c486a4602a1b49644ddff"
	clock:    "bonitao/mecha-clock:0.20.2@sha256:9d8cdaca612d880a4de4ab3176f80a1e7acdb38b10295f9aa5990217dcb3317f"
	compute:  "bonitao/mecha-compute:0.20.2@sha256:441ed5f0165f36f57b1191d0dc671f70d9c3ab0ed713807e01af0c7ed4b99ce8"
	conduit:  "bonitao/mecha-conduit:0.20.2@sha256:a946dec4b1ae777c86e6fbd16243458c52398352b011bddf0203058d1f0ae775"
	database: "bonitao/mecha-database:0.20.2@sha256:3abbb618a351692cd38272f1b2b0e61da4d40440c861ec85c99f20d0f98d2e10"
	mesh:     "bonitao/mecha-mesh:0.20.2@sha256:04ad88869e10f421813db7af7f32102ec233095205f37ae5f2103587e669aeb3"
	ticker:   "bonitao/mecha-ticker:0.20.2@sha256:a8908b444c97aa73c6012412c7851eeda19b0bf72609176dbb2cfbc764da1068"
}
