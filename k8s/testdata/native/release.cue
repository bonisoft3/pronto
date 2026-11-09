package fixture

import (
	"github.com/bonisoft3/pronto/k8s/schema"
	"github.com/bonisoft3/pronto/k8s/envs"
)

App: schema.#ReleaseSpec & {name: "native"}
GKE: schema.#GKE & {context: "test-cluster", environment: {registry: "us-central1-docker.pkg.dev/test-project/pronto", domainSuffix: "example.test"}}
kindManifests: (schema.#BuildManifests & {release: App, env: envs.Kind}).manifests
gkeManifests: (schema.#BuildManifests & {release: App, env: GKE.environment}).manifests
