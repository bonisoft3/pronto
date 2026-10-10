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

#Cluster: impl.#Cluster & {
	meta: door: *"${CADDY_TLS_HOST_PORT:-0}:8443" | string
}
#Runtime: impl.#Runtime
#Static:  impl.#Static
#ConduitSlot: impl.#ConduitSlot

// The mecha images an app takes by name, as pronto pins them: the consumer
// pins what it builds on, so a pronto release names a mecha release's images
// and an app pinning pronto gets them through it. One per service of
// impl.#Images, from the pin lines a mecha release prints.
published: impl.#Published & {
	auth:     "bonitao/mecha-auth:0.8.0@sha256:3fad007c2863cfae4ff19ecda019714c640c4171563fa5ba3b0bd029d31d3108"
	clock:    "bonitao/mecha-clock:0.8.0@sha256:d599af04d0a53295dbd8c7a9516a4ad099f01debca77a92a872c173e48af44f1"
	compute:  "bonitao/mecha-compute:0.8.0@sha256:79588fbc372089c4f2386f4da2f880309b9c1927d81d4d5d989327458a30aeae"
	conduit:  "bonitao/mecha-conduit:0.8.0@sha256:5b37a9074a35a9e8a3f95aa70b8c09f226927a7d9053cfa4ffc91ee07a5c302b"
	database: "bonitao/mecha-database:0.8.0@sha256:ccb59fdc18217eb679456c62b0f5aa05d79138bcc8c431087984a6ff1e2b552b"
	mesh:     "bonitao/mecha-mesh:0.8.0@sha256:b8d8c6dab3a33fedf09a0ef8f3d79b71de6408f70e1c2e04194a5f47d391da8f"
	ticker:   "bonitao/mecha-ticker:0.8.0@sha256:1fd214af5af6a6601ec1046fa5f0a1946df1ec8c0c072914e705dcd9e6d9e071"
}
