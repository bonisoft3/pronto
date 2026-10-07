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
	auth:     "bonitao/mecha-auth:0.6.3@sha256:93c0b936e90694e745290e219410cc30d09f077d7d7c15051cfc98ef42efe79a"
	clock:    "bonitao/mecha-clock:0.6.3@sha256:43fe194ea1a1956f25ddcc3cd2a69801fc31049e3c1f2596938da104f0d95bd8"
	compute:  "bonitao/mecha-compute:0.6.3@sha256:2d73bd4000cc0cf2be29c1ba168ab78964a9e7e63f274efe6f9b939630e61ef4"
	conduit:  "bonitao/mecha-conduit:0.6.3@sha256:5b37a9074a35a9e8a3f95aa70b8c09f226927a7d9053cfa4ffc91ee07a5c302b"
	database: "bonitao/mecha-database:0.6.3@sha256:54f5bc93c38c2c742988d8a112863bfc6841ba364cfefc4f5bf5ae000c55347f"
	mesh:     "bonitao/mecha-mesh:0.6.3@sha256:b8d8c6dab3a33fedf09a0ef8f3d79b71de6408f70e1c2e04194a5f47d391da8f"
	ticker:   "bonitao/mecha-ticker:0.6.3@sha256:f4a200da2ce5689fcfb39c553c099d69c6f00174eee8820ed54ce15340b2145e"
}
