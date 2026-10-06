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
	auth:     "bonitao/mecha-auth:0.6.0@sha256:1e09e8901e07c66e4da78a2cd06422ed6ad00940263922238a32c98c9ab6e802"
	clock:    "bonitao/mecha-clock:0.6.0@sha256:43fe194ea1a1956f25ddcc3cd2a69801fc31049e3c1f2596938da104f0d95bd8"
	compute:  "bonitao/mecha-compute:0.6.0@sha256:f22297bedf3d99ef96c6987d0da964fce3e0da9d6bb01642e9747905ce215ff4"
	conduit:  "bonitao/mecha-conduit:0.6.0@sha256:5b37a9074a35a9e8a3f95aa70b8c09f226927a7d9053cfa4ffc91ee07a5c302b"
	database: "bonitao/mecha-database:0.6.0@sha256:2f8b1b3d3551eab1c922aed149c27346f3904e885b6515ab7534bd1e8da1ff44"
	mesh:     "bonitao/mecha-mesh:0.6.0@sha256:b8d8c6dab3a33fedf09a0ef8f3d79b71de6408f70e1c2e04194a5f47d391da8f"
	ticker:   "bonitao/mecha-ticker:0.6.0@sha256:4f47cf210a82a842e42bb4d32d51abac1c43ae49708dd477b06230a1ad98aa06"
}
