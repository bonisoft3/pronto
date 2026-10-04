// Pronto's cluster roster, by indirection: each file here re-exports one
// virtual-cluster implementation from its product home. Pronto owns the
// list; the implementations own themselves (mecha's lives in
// bonisoft3/mecha). Consumers import github.com/bonisoft3/pronto/clusters:<name>.
//
// The seam pronto relies on: #Cluster is the compose topology with every
// service an addressable field — escape hatches unify services in, and the
// emitter derives the data plane from the program against it: migrations in
// mecha's canonical order (seeding pipeline-written singletons, since
// pipelines only fire on CDC), CDC for crud-path tables only (derived
// tables get none — that is what prevents pipeline loops), and one
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

// The mecha images an app takes by name, as pronto pins them: the consumer
// pins what it builds on, so a pronto release names a mecha release's images
// and an app pinning pronto gets them through it. One per service of
// impl.#Images, from the pin lines a mecha release prints.
published: impl.#Published & {
	auth:     "bonitao/mecha-auth:0.4.0@sha256:9daff300f4ddd0b4e026cd25ba10df29edaee6bb3edf34312768a8dca8a12249"
	clock:    "bonitao/mecha-clock:0.4.0@sha256:43fe194ea1a1956f25ddcc3cd2a69801fc31049e3c1f2596938da104f0d95bd8"
	compute:  "bonitao/mecha-compute:0.4.0@sha256:0d11c059847b28c57077f8460f3fc17f316b40fa236616c43edb8ba519cfdeec"
	conduit:  "bonitao/mecha-conduit:0.4.0@sha256:5b37a9074a35a9e8a3f95aa70b8c09f226927a7d9053cfa4ffc91ee07a5c302b"
	database: "bonitao/mecha-database:0.4.0@sha256:e838451bfba0b0c65a91e94e22e6f0d759a095ecff4f3f485386efd7547ba4c8"
	mesh:     "bonitao/mecha-mesh:0.4.0@sha256:b8d8c6dab3a33fedf09a0ef8f3d79b71de6408f70e1c2e04194a5f47d391da8f"
	ticker:   "bonitao/mecha-ticker:0.4.0@sha256:bc00e6b51b273f77f9d16b44f73dc281cc2df117de8eef2a0efb1bcd2816f31e"
}
