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
	airlock:  "bonitao/mecha-airlock:0.19.1@sha256:840c9ccaaf4716c4eb0899f8a8be346c53dfa706f9f452670263787687457df1"
	auth:     "bonitao/mecha-auth:0.19.1@sha256:92e796be2e47481f9e5163dba469833501b4b4695eb335253845c145fa6c7252"
	clock:    "bonitao/mecha-clock:0.19.1@sha256:9d8cdaca612d880a4de4ab3176f80a1e7acdb38b10295f9aa5990217dcb3317f"
	compute:  "bonitao/mecha-compute:0.19.1@sha256:a37671c38bd5e77f496512974fef1ec878328e7a07ccd00e42bb4406194ac829"
	conduit:  "bonitao/mecha-conduit:0.19.1@sha256:da40c0acf0897cf86da293135f6daad3f02609710b91cb6efc28dc5e6d93841a"
	database: "bonitao/mecha-database:0.19.1@sha256:38ab2c098b58f2224fe1a54cb6e27638f039987666a8e97701d8fbf3800b53ad"
	mesh:     "bonitao/mecha-mesh:0.19.1@sha256:04ad88869e10f421813db7af7f32102ec233095205f37ae5f2103587e669aeb3"
	ticker:   "bonitao/mecha-ticker:0.19.1@sha256:f3410acc27b70754be64a7b0bce1d7a7067c1ef7412482ff05e5bf48b073b4e0"
}
