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
	airlock:  "bonitao/mecha-airlock:0.20.6@sha256:b999fe8ff8e7e349f5fc5ed827584567c1c98f16c774884839a854b98ee28b50"
	auth:     "ghcr.io/bsoneca/mecha-auth:0.18.1-host.12@sha256:1d65ff2308704128a8975d02bf67530bcc157b3afaf1ccbb5118d8e6cd5424cc"
	clock:    "bonitao/mecha-clock:0.20.6@sha256:9d8cdaca612d880a4de4ab3176f80a1e7acdb38b10295f9aa5990217dcb3317f"
	compute:  "bonitao/mecha-compute:0.20.6@sha256:ead90c13996630d80ab26ae42f5c36d88d8481753848b31899cf63faab91af28"
	conduit:  "bonitao/mecha-conduit:0.20.6@sha256:c18a81780ff1c066c2dc2f7ed1115ac0333b28b2f6c9fe4c9390708c8f7810a1"
	database: "bonitao/mecha-database:0.20.6@sha256:d3eb729237d5bcdead34c500e4f482b86f4cfce00994b98a7c5a27745880b624"
	mesh:     "bonitao/mecha-mesh:0.20.6@sha256:04ad88869e10f421813db7af7f32102ec233095205f37ae5f2103587e669aeb3"
	ticker:   "bonitao/mecha-ticker:0.20.6@sha256:ddb62e40bb03ac5b77a797c597ca8c088d72edc60154ac4f3ac57e0c8ebc7ce3"
}
