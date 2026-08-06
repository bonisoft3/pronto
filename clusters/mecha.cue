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
// (Atlas) is mecha's reserved surface.
package mecha

import impl "github.com/bonisoft3/mecha:cluster"

#Cluster: impl.#Cluster
#Static:  impl.#Static
